/** Runtime foundation only; lifecycle/host adapters must opt in explicitly. */
export {
  RuntimeError,
  nodeRuntimeFileSystem,
  resolveCanonicalPaths,
  inferCanonicalProjectRoot,
  discoverRuntimeRoots,
  assertCanonicalWriteTarget,
  normalizeRuntimeRelativePath,
  caseFoldComponent,
} from "./paths.js";
export type {
  RuntimeErrorCode,
  RuntimeFileSystem,
  RuntimeDiscovery,
} from "./paths.js";
export { GenerationStore, InstallStateStore } from "./stores.js";
export * from "./store-port.js";
export * from "./contracts/index.js";
export * from "./canonical-paths.js";
export * from "./pi-executor-contract.js";
export type {
  GenerationFile,
  GenerationSeal,
  InstallStateSnapshot,
  RuntimeRecovery,
} from "./stores.js";
export { handleRuntimePathRequest } from "./json-api.js";
export type { RuntimePathResult } from "./json-api.js";

export {
  PRODUCT_KERNEL_SQLITE_BUSY_TIMEOUT_MS,
  PRODUCT_KERNEL_SQLITE_FILE_NAME,
  PRODUCT_KERNEL_SQLITE_SCHEMA_VERSION,
  SqliteProductKernelStore,
  SqliteProductKernelStoreError,
  openSqliteProductKernelStore,
} from "./sqlite-product-kernel-store.js";
export type {
  SqliteProductKernelStoreDiagnostics,
  SqliteProductKernelStoreErrorCode,
  SqliteProductKernelStoreOptions,
} from "./sqlite-product-kernel-store.js";

export {
  PactilePiRpcHost,
  PiRpcHostError,
  buildPiModelRouteArgs,
  resolvePiModelLaunchSelection,
  spawnPactilePiRpcHost,
} from "./pi-rpc-host.js";
export type {
  PactilePiRpcHostOptions,
  PiRpcChildProcess,
  PiRpcCommand,
  PiRpcDiagnostics,
  PiRpcExtensionUiResponse,
  PiRpcRecord,
  PiRpcResponse,
  PiRpcRunReceipt,
  PiRpcRunStatus,
  PiRpcSessionState,
  PiRpcSpawn,
  PiModelLaunchSelection,
  PiModelRouteReceipt,
  PiModelRouteSource,
  PiModelVariantAdapter,
} from "./pi-rpc-host.js";

export {
  PactilePiAgentRunner,
  PactilePiAgentRunnerError,
  createPactilePiAgentRunner,
} from "./pi-agent-runner.js";
export type {
  PactilePiAgentExecuteRequest,
  PactilePiAgentExecutionResult,
  PactilePiAgentExecutionStatus,
  PactilePiAgentHostFactory,
  PactilePiAgentHostLike,
} from "./pi-agent-runner.js";

export {
  PACTILE_IO_STDOUT_ERROR_CODES_V1,
  PACTILE_IO_ENVELOPE_TRUNCATION_MARKERS_V1,
  parsePactileIoEnvelopeStdoutLineV1,
  framePactileIoEnvelopeStdoutChunkV1,
  parsePactileIoEnvelopeStdoutV1,
} from "./io-envelope.js";
export type {
  PactileIoEnvelopeStdoutDroppedV1,
  PactileIoEnvelopeStdoutErrorCodeV1,
  PactileIoEnvelopeStdoutErrorV1,
  PactileIoEnvelopeStdoutForwardV1,
  PactileIoEnvelopeStdoutFrameV1,
  PactileIoEnvelopeStdoutFailureV1,
  PactileIoEnvelopeStdoutIgnoredV1,
  PactileIoEnvelopeStdoutIssueV1,
  PactileIoEnvelopeStdoutLineResultV1,
  PactileIoEnvelopeStdoutParseInputV1,
  PactileIoEnvelopeStdoutParseV1,
} from "./io-envelope.js";

export {
  PI_EXECUTOR_HOST_MODES_V1,
  PiExecutorError,
  createPiExecutorV1,
  nativeHostFromStatusV1,
  piExecutorTerminalFactV1,
} from "./pi-executor.js";
export type {
  PiExecutorEnvoyV1,
  PiExecutorHostModeV1,
  PiExecutorNativeHostFactoryV1,
  PiExecutorNativeHostV1,
  PiExecutorOptionsV1,
  PiExecutorRequestV1,
  PiExecutorRunIdentityV1,
  PiExecutorRunReceiptV1,
  PiExecutorWorkspaceBindingV1,
} from "./pi-executor.js";

export {
  admitRepositoryWorkspace,
  rejectMissingWorkspaceBinding,
} from "./workspace-admission.js";
export type {
  RepositoryWorkspaceAdmissionAdmitted,
  RepositoryWorkspaceAdmissionRejected,
  RepositoryWorkspaceAdmissionRejectionReason,
  RepositoryWorkspaceAdmissionRequest,
  RepositoryWorkspaceAdmissionResult,
  RepositoryWorkspaceCandidateBinding,
} from "./workspace-admission.js";
export * from "./sqlite-runtime-store.js";
export * from "./file-artifact-store.js";
export { openPactileRuntimeHost } from "./runtime-host.js";
export type {
  PactileRuntimeHost,
  PactileRuntimeHostOptions,
} from "./runtime-host.js";
export * from "./pi-session-manager.js";
export * from "./session-registry.js";
export * from "./effect-receipts.js";
export * from "./run-ledger-effect-receipts.js";
export * from "./context-governance-receipts.js";
export * from "./context-governance-producer.js";
export * from "./context-governance-pipeline-producer.js";
export * from "./governed-context-pipeline.js";
export * from "./governed-run-session.js";
export * from "./run-ledger.js";
export * from "./settlement-outbox-projector.js";
export * from "./persistent-pi-agent-runner.js";
