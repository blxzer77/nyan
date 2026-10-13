import { fingerprintPactileContractV1 } from "../../shared/validation.js";
import { Agent, type AgentState } from "../pi/index.js";
import type {
  AfterToolCallContext,
  AgentEvent,
  AgentMessage,
  AgentRequestUpdate,
  BeforeToolCallContext,
  PrepareRequestContext,
} from "../pi/types.js";
import { pactileProviderModelsMatch } from "../loop/provider-port.js";
import {
  createPactileEffectIntentV1,
  isPactileKnownToolFailureV1,
  summarizePactileToolResultV1,
  type PactileEffectIntentV1,
} from "../effects/contract.js";
import { contextSnapshotHashV1 } from "../context/compaction.js";
import type { ContextPipelineResultV1, PactileContextPipelinePortV1 } from "../context-pipeline.js";
import {
  appendPiRunCheckpoint,
  readPiSessionSnapshot,
} from "../session/checkpoint.js";
import type { PactileAgentSessionBindingV1, PactileAgentSessionPort } from "../session/contracts.js";
import type { PactileEffectReceiptPort } from "../effects/contract.js";
import type { PactileNativeAgentOptions } from "./contract.js";

export class PactileNativeAgentConfigurationError extends TypeError {
  constructor(message = "PACTILE_NATIVE_AGENT_PROVIDER_CONFIGURATION_CONFLICT") {
    super(message);
    this.name = "PactileNativeAgentConfigurationError";
  }
}

function safeToolReceiptFailure(): {
  readonly isError: true;
  readonly content: [{ readonly type: "text"; readonly text: string }];
  readonly details: { readonly code: string };
} {
  return {
    isError: true,
    content: [{ type: "text", text: "Tool effect receipt was not durably recorded; automatic replay is blocked." }],
    details: { code: "effect_receipt_failed" },
  };
}

/**
 * Pactile's product-facing wrapper around the vendored Pi Agent loop.
 *
 * The loop remains directly modifiable under ./pi. Pactile owns the seam that
 * attaches Session/Checkpoint, Context/Memory/Compaction and effect receipts;
 * no external `pi` process is involved.
 */
export class PactileNativeAgent {
  readonly #agent: Agent;
  readonly #contextPipeline: PactileContextPipelinePortV1 | undefined;
  readonly #session: PactileAgentSessionPort | undefined;
  readonly #effectReceipts: PactileEffectReceiptPort | undefined;
  readonly #unsubscribe: (() => void) | null;
  #pendingContextRollback: readonly AgentMessage[] | null = null;

  constructor(options: PactileNativeAgentOptions) {
    const {
      contextPipeline,
      prepareRequest: callerPrepareRequest,
      onEvent,
      providerRuntime,
      streamFn,
      initialState,
      session,
      effectReceipts,
      runId,
      operationEpoch,
      beforeToolCall: callerBeforeToolCall,
      afterToolCall: callerAfterToolCall,
      ...agentOptions
    } = options;
    const suppliedPrepareRequest = callerPrepareRequest;
    if (providerRuntime !== undefined && streamFn !== undefined) {
      throw new PactileNativeAgentConfigurationError();
    }
    const effectiveStreamFn = providerRuntime?.streamFn ?? streamFn;
    if (effectiveStreamFn === undefined) {
      throw new PactileNativeAgentConfigurationError();
    }
    const configuredModel = initialState?.model;
    if (
      providerRuntime?.model !== null &&
      providerRuntime?.model !== undefined &&
      configuredModel !== undefined &&
      !pactileProviderModelsMatch(providerRuntime.model, configuredModel)
    ) {
      throw new PactileNativeAgentConfigurationError();
    }

    const binding = session?.readBinding() ?? null;
    if (session !== undefined && binding === null) {
      throw new PactileNativeAgentConfigurationError(
        "PACTILE_NATIVE_AGENT_SESSION_BINDING_REQUIRED",
      );
    }
    const effectiveRunId = runId ?? binding?.runId;
    const effectiveOperationEpoch = operationEpoch ?? binding?.operationEpoch;
    if (effectReceipts !== undefined && (effectiveRunId === undefined || effectiveOperationEpoch === undefined)) {
      throw new PactileNativeAgentConfigurationError(
        "PACTILE_NATIVE_AGENT_EFFECT_RUN_BINDING_REQUIRED",
      );
    }

    const effectiveInitialState =
      providerRuntime?.model !== null &&
      providerRuntime?.model !== undefined &&
      configuredModel === undefined
        ? { ...(initialState ?? {}), model: providerRuntime.model }
        : initialState;
    const restoredMessages =
      effectiveInitialState?.messages === undefined && session !== undefined
        ? session.readTranscriptMessages()
        : undefined;
    this.#contextPipeline = contextPipeline;
    this.#session = session;
    this.#effectReceipts = effectReceipts;

    const prepareRequest =
      contextPipeline === undefined && suppliedPrepareRequest === undefined
        ? undefined
        : async (
            request: PrepareRequestContext,
            signal?: AbortSignal,
          ): Promise<AgentRequestUpdate | undefined> => {
            const pipelineUpdate = await contextPipeline?.prepareRequest(
              request,
              signal,
            );
            this.#pendingContextRollback =
              pipelineUpdate?.context === undefined
                ? null
                : Object.freeze([...request.context.messages]);
            const preparedRequest =
              pipelineUpdate?.context === undefined
                ? request
                : { ...request, context: pipelineUpdate.context };
            const callerUpdate = await suppliedPrepareRequest?.(
              preparedRequest,
              signal,
            );
            if (pipelineUpdate === undefined && callerUpdate === undefined)
              return undefined;
            return {
              ...(pipelineUpdate ?? {}),
              ...(callerUpdate ?? {}),
            };
          };

    const effectIntents = new Map<string, PactileEffectIntentV1>();
    const beforeToolCall = this.#effectReceipts === undefined
      ? callerBeforeToolCall
      : async (context: BeforeToolCallContext, signal?: AbortSignal) => {
          const callerResult = await callerBeforeToolCall?.(context, signal);
          if (callerResult?.block === true || signal?.aborted === true) return callerResult;
          const intent = createPactileEffectIntentV1({
            runId: effectiveRunId as string,
            toolCallId: context.toolCall.id,
            toolName: context.toolCall.name,
            args: context.args,
            operationEpoch: effectiveOperationEpoch as number,
          });
          const admission = await this.#effectReceipts?.begin(intent);
          if (!admission?.ok) {
            return {
              block: true,
              terminate: true,
              reason: admission?.message ?? "Tool effect admission failed; automatic replay is blocked.",
            };
          }
          effectIntents.set(context.toolCall.id, intent);
          return callerResult;
        };

    const afterToolCall = this.#effectReceipts === undefined
      ? callerAfterToolCall
      : async (context: AfterToolCallContext, signal?: AbortSignal) => {
          const intent = effectIntents.get(context.toolCall.id);
          if (intent !== undefined) {
            const knownFailure =
              context.isError && isPactileKnownToolFailureV1(context.result);
            const status = !context.isError
              ? "succeeded"
              : knownFailure
                ? "failed"
                : "unknown";
            const completion = await this.#effectReceipts?.complete({
              intent,
              status,
              result: summarizePactileToolResultV1(
                context.result,
                context.isError,
                undefined,
                (value) => fingerprintPactileContractV1({
                  domain: "pactile-agent-effect-result-part-v1",
                  value,
                }),
              ),
              ...(context.isError
                ? {
                    errorCode: knownFailure
                      ? "tool_failure_known"
                      : "tool_execution_unknown",
                  }
                : {}),
            });
            effectIntents.delete(context.toolCall.id);
            if (!completion?.ok) return safeToolReceiptFailure();
          }
          return callerAfterToolCall?.(context, signal);
        };

    this.#agent = new Agent({
      ...agentOptions,
      initialState: {
        ...(effectiveInitialState ?? {}),
        ...(restoredMessages === undefined ? {} : { messages: [...restoredMessages] }),
      },
      streamFn: effectiveStreamFn,
      ...(prepareRequest === undefined ? {} : { prepareRequest }),
      ...(beforeToolCall === undefined ? {} : { beforeToolCall }),
      ...(afterToolCall === undefined ? {} : { afterToolCall }),
      ...(binding?.sessionId === undefined ? {} : { sessionId: binding.sessionId }),
    });

    const listener = async (event: AgentEvent, _signal: AbortSignal): Promise<void> => {
      if (event.type === "message_end") {
        if (event.message.role === "assistant") {
          const stopReason = (event.message as { readonly stopReason?: unknown }).stopReason;
          if (stopReason === "error" || stopReason === "aborted") {
            const rollback = this.#pendingContextRollback;
            if (rollback !== null) {
              // The pipeline update is a staged request context. A provider
              // error/abort must not make that staged context the live Agent
              // context. Keep the failed response for diagnostics/history,
              // while restoring the exact pre-compaction messages.
              this.#agent.state.messages = [...rollback, event.message];
            }
          }
          this.#pendingContextRollback = null;
        }
        if (this.#session !== undefined) {
          this.#session.appendTranscriptMessage(event.message);
        }
      }
      if (this.#session !== undefined && event.type === "agent_end") {
        this.#recordSessionCheckpoint(binding as PactileAgentSessionBindingV1);
      }
      await onEvent?.(event);
    };
    this.#unsubscribe =
      session === undefined &&
      onEvent === undefined &&
      contextPipeline === undefined &&
      effectReceipts === undefined
        ? null
        : this.#agent.subscribe(listener);
  }

  get state(): AgentState {
    return this.#agent.state;
  }

  get lastContextPipelineResult(): ContextPipelineResultV1 | null {
    return this.#contextPipeline?.lastResult ?? null;
  }

  get effectsKnown(): boolean {
    return this.#effectReceipts?.effectsKnown() ?? true;
  }

  get sessionBinding(): PactileAgentSessionBindingV1 | null {
    return this.#session?.readBinding() ?? null;
  }

  async prompt(
    input: Parameters<Agent["prompt"]>[0],
    images?: Parameters<Agent["prompt"]>[1],
  ): Promise<void> {
    await this.#agent.prompt(input as never, images);
  }

  async continue(): Promise<void> {
    await this.#agent.continue();
  }

  steer(message: Parameters<Agent["steer"]>[0]): void {
    this.#agent.steer(message);
  }

  followUp(message: Parameters<Agent["followUp"]>[0]): void {
    this.#agent.followUp(message);
  }

  abort(): void {
    this.#agent.abort();
  }

  async waitForIdle(): Promise<void> {
    await this.#agent.waitForIdle();
  }

  dispose(): void {
    this.#unsubscribe?.();
  }

  #recordSessionCheckpoint(binding: PactileAgentSessionBindingV1): void {
    const snapshotHash = contextSnapshotHashV1(this.#agent.state.messages);
    const checkpointId = `agent_checkpoint_v1_${snapshotHash.slice("sha256:".length, "sha256:".length + 32)}`;
    const current = readPiSessionSnapshot(this.#session as PactileAgentSessionPort, binding.runId);
    if (current.checkpoint?.checkpointId !== checkpointId) {
      appendPiRunCheckpoint(this.#session as PactileAgentSessionPort, {
        runId: binding.runId,
        checkpointId,
        semanticFingerprint: binding.semanticFingerprint,
        effectsKnown: this.effectsKnown,
        nextActionFingerprint: snapshotHash,
        operationEpoch: binding.operationEpoch,
        contextSnapshotHash: snapshotHash,
      });
    }
    this.#session?.recordSnapshot({
      runId: binding.runId,
      operationEpoch: binding.operationEpoch,
      snapshotHash,
      checkpointId,
    });
  }
}
