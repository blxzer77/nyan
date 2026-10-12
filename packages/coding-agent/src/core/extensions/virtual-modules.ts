import * as bundledNyanAgentCore from "@ny4n/agent-core";
import * as bundledNyanAiCompat from "@ny4n/ai/compat";
import * as bundledNyanAiOauth from "@ny4n/ai/oauth";
import * as bundledNyanAiProviders from "@ny4n/ai/providers/all";
import * as bundledNyanTui from "@ny4n/tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @ny4n/coding-agent.
import * as bundledNyanCodingAgent from "../../index.ts";

/** Modules available to extensions in source and bundled runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@ny4n/agent-core": bundledNyanAgentCore,
	"@ny4n/tui": bundledNyanTui,
	// Extensions resolve the nyan-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@ny4n/ai": bundledNyanAiCompat,
	"@ny4n/ai/compat": bundledNyanAiCompat,
	"@ny4n/ai/oauth": bundledNyanAiOauth,
	"@ny4n/ai/providers/all": bundledNyanAiProviders,
	"@ny4n/coding-agent": bundledNyanCodingAgent,
};
