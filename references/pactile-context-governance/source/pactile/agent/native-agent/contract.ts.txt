import type { AgentEvent, AgentOptions, StreamFn } from "../pi/index.js";
import type { PactileProviderRuntime } from "../loop/provider-port.js";
import type { PactileContextPipelinePortV1 } from "../context-pipeline.js";
import type { PactileEffectReceiptPort } from "../effects/contract.js";
import type { PactileAgentSessionPort } from "../session/contracts.js";

export interface PactileNativeAgentOptions extends Omit<
  AgentOptions,
  "streamFn"
> {
  /** Explicit test/custom-host seam; mutually exclusive with providerRuntime. */
  readonly streamFn?: StreamFn;
  /** Native Provider port used by the product composition path. */
  readonly providerRuntime?: PactileProviderRuntime;
  /** Native Context / Memory / Compaction pipeline; no external Agent is used. */
  readonly contextPipeline?: PactileContextPipelinePortV1;
  /** Agent-owned durable Session/Transcript/Checkpoint seam. */
  readonly session?: PactileAgentSessionPort;
  /** Durable tool/effect intent and receipt seam. */
  readonly effectReceipts?: PactileEffectReceiptPort;
  /** Required with effectReceipts when no bound Session supplies these values. */
  readonly runId?: string;
  readonly operationEpoch?: number;
  readonly onEvent?: (event: AgentEvent) => Promise<void> | void;
}
