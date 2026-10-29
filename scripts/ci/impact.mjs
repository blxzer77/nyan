#!/usr/bin/env node
// Impact analysis for the `policy` job (docs/nyan/cicd.md §4.1).
//
// Emits three outputs to $GITHUB_OUTPUT, or to stdout when the variable is
// unset (so the script can be exercised locally):
//
//   docs_only        "true" when every changed path is documentation
//   windows_required "true" when a Windows-relevant change is in the diff
//   test_matrix      [{"name":"shard-1","partition":"hash:1/4"}, ...]
//
// Everything is fail-closed: an unknown event, a missing or all-zero SHA, an
// empty file list or a failing git command produces docs_only=false and
// windows_required=true, never a skip.
//
// Usage (CI):   node scripts/ci/impact.mjs
// Usage (local): node scripts/ci/impact.mjs --base HEAD~1 --head HEAD
//
// The base/head pair is a three-dot diff (`base...head`): changes on the
// base branch since the fork point do not count as part of the PR.

import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const policy = JSON.parse(readFileSync(resolve(root, ".github/quality/policy.json"), "utf8"));

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

// The event's diff endpoints. `pull_request.base.sha` is the merge base for a
// three-dot diff; for push, `before` is the tip of the previous branch state;
// for merge_group, the queue base. An all-zero SHA (new branch) means there is
// no base to compare against.
function endpoints() {
  const event = process.env.GITHUB_EVENT_NAME ?? "";
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const payload = eventPath ? JSON.parse(readFileSync(eventPath, "utf8")) : {};

  const fromArgs = { base: arg("base"), head: arg("head") };
  if (fromArgs.base && fromArgs.head) return fromArgs;

  switch (event) {
    case "pull_request":
      return {
        base: payload.pull_request?.base?.sha,
        head: payload.pull_request?.head?.sha,
      };
    case "push":
      return { base: payload.before, head: payload.after };
    case "merge_group":
      return { base: payload.merge_group?.base_sha, head: payload.merge_group?.head_sha };
    default:
      // workflow_dispatch and anything unrecognized: no reliable base.
      return {};
  }
}

const zero = /^0+$/;

function changedFiles() {
  const { base, head } = endpoints();
  if (!base || !head || zero.test(base) || zero.test(head)) {
    // Fail closed: no base means "treat everything as code".
    return null;
  }
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACDMRTUXB", `${base}...${head}`], {
      cwd: root,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch (error) {
    console.error(`impact: git diff failed: ${error.message}`);
    return null;
  }
}

// Same failure mode as changedFiles: a missing diff means "assume Windows".
function changedLines() {
  const { base, head } = endpoints();
  if (!base || !head || zero.test(base) || zero.test(head)) return null;
  try {
    return execFileSync("git", ["diff", "--unified=0", `${base}...${head}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: Number(process.env.IMPACT_MAX_BUFFER ?? 64 * 1024 * 1024),
    });
  } catch (error) {
    console.error(`impact: git diff (lines) failed: ${error.message}`);
    return null;
  }
}

// A glob from policy.docsOnly.paths. Two forms appear: a directory subtree
// (`docs/**`, `assets/**`) and a bare file pattern (`LICENSE`, `README*`).
function docsPath(path) {
  const globs = policy.docsOnly?.paths ?? [];
  return globs.some((pattern) => {
    if (pattern.endsWith("/**")) {
      return path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2));
    }
    if (pattern.includes("*")) {
      const regex = new RegExp(
        "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
      );
      return regex.test(path);
    }
    return path === pattern;
  });
}

function windowsFiles(files) {
  if (files === null) return true;
  return files.some((path) => (policy.windows?.paths ?? []).includes(path));
}

function windowsLines(diff) {
  if (diff === null) return true;
  // Only added/removed lines matter (`^[+-]`), and the +++/--- headers are
  // excluded. Any hit means cfg-gated Windows code changed shape.
  const patterns = (policy.windows?.diffPatterns ?? []).map((p) => new RegExp(p));
  return diff
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---"))
    .some((line) => patterns.some((pattern) => pattern.test(line)));
}

function main() {
  // Fail closed before any git call: a local run with no --base/--head and no
  // event payload takes the null path and reports code.
  const files = changedFiles();
  const diff = changedLines();

  const docsOnly = files !== null && files.length > 0 && files.every(docsPath);
  // A docs-only diff cannot change what compiles, and the docs themselves
  // quote the patterns below (this design doc does), so the line scan would
  // otherwise fire on documentation. windows-check is also skipped by
  // docs_only in the workflow; reporting false keeps the two consistent.
  const windowsRequired = !docsOnly && (windowsFiles(files) || windowsLines(diff));

  const response = {
    docs_only: docsOnly ? "true" : "false",
    windows_required: windowsRequired ? "true" : "false",
    test_matrix: JSON.stringify(testMatrix()),
  };

  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    for (const [key, value] of Object.entries(response)) {
      appendFileSync(output, `${key}=${value}\n`);
    }
  } else {
    console.log(JSON.stringify(response, null, 2));
  }
}

function testMatrix() {
  const shards = policy.pullRequest?.testShards ?? 4;
  // `name` cannot contain `/` (artifact names), so it is separate from the
  // partition spec.
  return Array.from({ length: shards }, (_, index) => ({
    name: `shard-${index + 1}`,
    partition: `hash:${index + 1}/${shards}`,
  }));
}

main();
