import * as bundledNyanAgentCore from "@nyan/agent-core";
import * as bundledNyanAiCompat from "@nyan/ai/compat";
import * as bundledNyanAiOauth from "@nyan/ai/oauth";
import * as bundledNyanAiProviders from "@nyan/ai/providers/all";
import * as bundledNyanTui from "@nyan/tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @nyan/coding-agent.
import * as bundledNyanCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@nyan/agent-core": bundledNyanAgentCore,
	"@nyan/tui": bundledNyanTui,
	// Extensions resolve the nyan-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@nyan/ai": bundledNyanAiCompat,
	"@nyan/ai/compat": bundledNyanAiCompat,
	"@nyan/ai/oauth": bundledNyanAiOauth,
	"@nyan/ai/providers/all": bundledNyanAiProviders,
	"@nyan/coding-agent": bundledNyanCodingAgent,
};
