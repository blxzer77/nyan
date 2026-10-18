// The HTTP client setup lives in `./http/`; this path stays the import point for its callers.
export {
	applyHttpProxySettings,
	configureHttpDispatcher,
	DEFAULT_HTTP_IDLE_TIMEOUT_MS,
	formatHttpIdleTimeoutMs,
	HTTP_IDLE_TIMEOUT_CHOICES,
	parseHttpIdleTimeoutMs,
} from "./http/index.ts";
