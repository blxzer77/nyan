#!/usr/bin/env node

/**
 * Model metadata generation script for nyan (provider redesign PR 2).
 *
 * Imports and normalizes model metadata derived from Pi Agent (packages/ai)
 * and models.dev experimental v2 catalog into nyan's checked-in metadata snapshot.
 *
 * Run manually or via weekly scheduled CI:
 *   node scripts/update-model-metadata.mjs
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const DEFAULT_OUTPUT = resolve(ROOT_DIR, "src/utils/model/model_metadata.json");
const DEFAULT_URL = "https://models.dev/experimental/v2.0/api.json";
const DEFAULT_PI_COMMIT = "1f8604f8";
const DEFAULT_MODELS_DEV_VERSION = "9dfbad27";
const SCHEMA_VERSION = 1;

// Provider catalog sources aligned with Pi Agent packages/ai/catalog/providers
const PI_PROVIDERS = [
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure",
  "baseten",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google-vertex",
  "google",
  "groq",
  "huggingface",
  "kimi-coding",
  "meta",
  "minimax-cn",
  "minimax",
  "mistral",
  "moonshotai-cn",
  "moonshotai",
  "nvidia",
  "openai-codex",
  "openai",
  "opencode-go",
  "opencode",
  "openrouter",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "qwen-token-plan",
  "radius",
  "together",
  "typesafe",
  "vercel-ai-gateway",
  "xai",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "xiaomi",
  "zai-coding-cn",
  "zai",
];

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    output: DEFAULT_OUTPUT,
    source: DEFAULT_URL,
    piCommit: DEFAULT_PI_COMMIT,
    modelsDevVersion: DEFAULT_MODELS_DEV_VERSION,
    generatedAt: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--output" && i + 1 < args.length) {
      options.output = resolve(args[++i]);
    } else if (arg === "--source" && i + 1 < args.length) {
      options.source = args[++i];
    } else if (arg === "--pi-commit" && i + 1 < args.length) {
      options.piCommit = args[++i];
    } else if (arg === "--models-dev-version" && i + 1 < args.length) {
      options.modelsDevVersion = args[++i];
    } else if (arg === "--generated-at" && i + 1 < args.length) {
      options.generatedAt = args[++i];
    }
  }

  return options;
}

async function loadSourceData(source) {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${source}`);
    }
    return await res.json();
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

function normalizeCost(cost) {
  const input = cost?.text?.input;
  const output = cost?.text?.output;
  if (!input && !output) return null;

  let cacheWrite = null;
  const writeVal = input?.cache?.write;
  if (typeof writeVal === "number") {
    cacheWrite = writeVal;
  } else if (typeof writeVal === "object" && writeVal !== null) {
    const values = Object.values(writeVal);
    if (values.length > 0 && typeof values[0] === "number") {
      cacheWrite = values[0];
    }
  }

  return {
    input: input?.price ?? 0,
    output: output?.price ?? 0,
    cacheRead: input?.cache?.read ?? null,
    cacheWrite: cacheWrite ?? null,
  };
}

export function transformCatalog(catalog, options = {}) {
  const result = {};

  for (const provider of PI_PROVIDERS) {
    const providerData = catalog[provider];
    if (!providerData || !providerData.models) continue;

    for (const [modelId, model] of Object.entries(providerData.models)) {
      // Must be chat model
      if (model.type !== "chat") continue;

      // Filter: must have contextWindow, maxTokens, input, reasoning, api
      const contextWindow = model.limit?.context;
      const maxOutputTokens = model.limit?.output;
      const input = model.modalities?.input;
      const reasoningSupported = model.capabilities?.reasoning !== undefined;
      const hasApi = model.api && Object.keys(model.api).length > 0;

      if (!contextWindow || !maxOutputTokens || !input || !reasoningSupported || !hasApi) {
        continue;
      }

      const hasImage = input.some((x) => x === "image" || x.startsWith("image/"));
      const isReasoning = model.capabilities?.reasoning?.supported === true;
      const toolsSupported = model.capabilities?.tools?.supported === true;
      const structuredOutput = model.capabilities?.structured_output === true;
      const hasCache = !!model.capabilities?.cache;

      const entry = {
        provider,
        model: modelId,
        displayName: model.name || modelId,
        contextWindow,
        maxOutputTokens,
        capabilities: {
          contextWindow,
          maxOutputTokens,
          tools: toolsSupported ? "native" : "none",
          thinking: isReasoning ? "adaptive" : "none",
          images: hasImage ? "input" : "none",
          structuredOutput,
          streaming: true,
          promptCache: hasCache ? "native" : "none",
        },
        cost: normalizeCost(model.cost),
        input: [...input],
      };

      result[`${provider}/${modelId}`] = entry;

      // Also add alias for gemini if provider is google
      if (provider === "google") {
        result[`gemini/${modelId}`] = {
          ...entry,
          provider: "gemini",
        };
      }
    }
  }

  // Sort keys alphabetically for deterministic output
  const sortedKeys = Object.keys(result).sort();
  const sortedModels = {};
  for (const key of sortedKeys) {
    sortedModels[key] = result[key];
  }

  // Hash is SHA-256 of the JSON serialization of sorted models
  const modelsJson = JSON.stringify(sortedModels);
  const hash = createHash("sha256").update(modelsJson, "utf8").digest("hex");

  const generatedAt = options.generatedAt || new Date().toISOString();

  return {
    schemaVersion: SCHEMA_VERSION,
    piCommit: options.piCommit || DEFAULT_PI_COMMIT,
    modelsDevVersion: options.modelsDevVersion || DEFAULT_MODELS_DEV_VERSION,
    generatedAt,
    hash,
    models: sortedModels,
  };
}

async function main() {
  const options = parseArgs();
  console.log(`Loading model catalog from ${options.source}...`);
  const rawCatalog = await loadSourceData(options.source);

  console.log("Transforming models...");
  const snapshot = transformCatalog(rawCatalog, options);

  const modelCount = Object.keys(snapshot.models).length;
  console.log(`Generated metadata for ${modelCount} models with hash ${snapshot.hash}`);

  writeFileSync(options.output, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  console.log(`Written snapshot to ${options.output}`);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Failed to generate model metadata:", err);
    process.exit(1);
  });
}
