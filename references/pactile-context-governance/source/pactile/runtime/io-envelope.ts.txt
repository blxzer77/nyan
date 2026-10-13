/**
 * Runtime stdout intake for Pactile IO Envelope v1.
 *
 * Pi (and any other Agent host) writes JSONL envelopes to stdout; stderr is
 * diagnostics only and is never parsed for envelopes. This module owns the
 * transport boundary: it frames only complete stdout lines, parses each line
 * with the protocol contract's v1 decoder and refuses everything else with a structured,
 * secret-safe error that is never forwarded to the Kernel.
 *
 * Framing notes:
 * - a line is complete only when its `\n` terminator has been observed; a
 *   trailing unterminated remainder is reported as `truncated` and dropped;
 * - empty/whitespace-only lines are ignored;
 * - a line whose JSON is malformed while carrying an explicit truncation
 *   marker (`[truncated]`, `<truncated>`, `(truncated)`) or a trailing `…` is
 *   reported as `truncated`, not as `invalid-json`;
 * - a line above 256 KiB UTF-8 is reported as `line-too-large` before any
 *   JSON work happens.
 *
 * Error messages never echo the rejected line: the Kernel sees a stable code
 * plus bounded issue codes/paths, so credentials, absolute paths and raw
 * model output cannot cross this boundary through diagnostics.
 */

import {
  PACTILE_IO_ENVELOPE_MAX_LINE_BYTES_V1,
  pactileIoEnvelopeDiagnosticPathV1,
  pactileIoEnvelopeUtf8ByteLengthV1,
  parsePactileIoEnvelopeV1,
  type PactileIoEnvelopeV1,
} from "../protocol/contracts/io-envelope.js";
import type { PactileContractIssueCodeV1 } from "../shared/validation.js";

export const PACTILE_IO_STDOUT_ERROR_CODES_V1 = [
  "invalid-json",
  "not-envelope",
  "truncated",
  "line-too-large",
] as const;
export type PactileIoEnvelopeStdoutErrorCodeV1 =
  (typeof PACTILE_IO_STDOUT_ERROR_CODES_V1)[number];

/** Explicit host truncation markers; never emitted by a complete envelope. */
export const PACTILE_IO_ENVELOPE_TRUNCATION_MARKERS_V1 = [
  "[truncated]",
  "<truncated>",
  "(truncated)",
] as const;

const TRUNCATION_MARKER_PATTERN_V1 =
  /\[truncated\]|<truncated>|\(truncated\)/iu;
const TRAILING_ELLIPSIS_PATTERN_V1 = /…$/u;
const MAX_REPORTED_ISSUES_V1 = 8;

export interface PactileIoEnvelopeStdoutIssueV1 {
  readonly code: PactileContractIssueCodeV1;
  readonly path: string;
}

export interface PactileIoEnvelopeStdoutErrorV1 {
  readonly code: PactileIoEnvelopeStdoutErrorCodeV1;
  readonly retryable: boolean;
  readonly message: string;
  readonly lineBytes: number;
  readonly issues: readonly PactileIoEnvelopeStdoutIssueV1[];
}

export interface PactileIoEnvelopeStdoutForwardV1 {
  readonly outcome: "forward";
  readonly envelope: PactileIoEnvelopeV1;
  readonly fingerprint: string;
  readonly lineBytes: number;
}

export interface PactileIoEnvelopeStdoutIgnoredV1 {
  readonly outcome: "ignore";
  readonly reason: "empty-line";
}

export interface PactileIoEnvelopeStdoutDroppedV1 {
  readonly outcome: "drop";
  readonly error: PactileIoEnvelopeStdoutErrorV1;
}

export type PactileIoEnvelopeStdoutLineResultV1 =
  | PactileIoEnvelopeStdoutForwardV1
  | PactileIoEnvelopeStdoutIgnoredV1
  | PactileIoEnvelopeStdoutDroppedV1;

export interface PactileIoEnvelopeStdoutFailureV1 {
  /** 1-based stdout line number; `null` when the line was never terminated. */
  readonly lineNumber: number | null;
  readonly error: PactileIoEnvelopeStdoutErrorV1;
}

export interface PactileIoEnvelopeStdoutParseV1 {
  /** Envelopes that may be forwarded to the Kernel, in stdout order. */
  readonly envelopes: readonly PactileIoEnvelopeStdoutForwardV1[];
  readonly ignoredLineCount: number;
  /** Structured failures; never forwarded and never carrying raw output. */
  readonly errors: readonly PactileIoEnvelopeStdoutFailureV1[];
  /** stderr lines, kept as host-local diagnostics only. */
  readonly diagnostics: readonly string[];
}

export interface PactileIoEnvelopeStdoutFrameV1 {
  /** Unterminated remainder that must be carried to the next chunk. */
  readonly pending: string;
  readonly lines: readonly string[];
  readonly errors: readonly PactileIoEnvelopeStdoutErrorV1[];
}

export interface PactileIoEnvelopeStdoutParseInputV1 {
  readonly stdout: string;
  /** The diagnostic channel; it is never parsed as JSONL envelopes. */
  readonly stderr?: string;
}

function stdoutErrorV1(
  code: PactileIoEnvelopeStdoutErrorCodeV1,
  lineBytes: number,
  issues: readonly PactileIoEnvelopeStdoutIssueV1[] = [],
): PactileIoEnvelopeStdoutErrorV1 {
  switch (code) {
    case "invalid-json":
      return Object.freeze({
        code,
        retryable: false,
        message: "stdout line is not valid JSON",
        lineBytes,
        issues: Object.freeze([]),
      });
    case "not-envelope":
      return Object.freeze({
        code,
        retryable: false,
        message: "stdout line is not a Pactile v1 IO envelope",
        lineBytes,
        issues: Object.freeze([...issues]),
      });
    case "truncated":
      return Object.freeze({
        code,
        retryable: true,
        message: "stdout line was truncated before a complete envelope arrived",
        lineBytes,
        issues: Object.freeze([]),
      });
    case "line-too-large":
      return Object.freeze({
        code,
        retryable: false,
        message: `stdout line exceeds the ${PACTILE_IO_ENVELOPE_MAX_LINE_BYTES_V1} byte envelope limit`,
        lineBytes,
        issues: Object.freeze([]),
      });
  }
}

function boundedIssueV1(
  code: PactileContractIssueCodeV1,
  path: string,
): PactileIoEnvelopeStdoutIssueV1 {
  // An `unknown-field` path ends in the caller-supplied key name, which may be
  // arbitrary model output. Report only the contract position it appeared at.
  const parentPath =
    code === "unknown-field" ? path.replace(/(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[.*\])$/u, "") : path;
  return Object.freeze({
    code,
    path: pactileIoEnvelopeDiagnosticPathV1(parentPath),
  });
}

function stripCarriageReturnV1(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function hasExplicitTruncationMarkerV1(line: string): boolean {
  return (
    TRUNCATION_MARKER_PATTERN_V1.test(line) ||
    TRAILING_ELLIPSIS_PATTERN_V1.test(line.trimEnd())
  );
}

/**
 * Parse one complete stdout line. The line must not include its `\n`
 * terminator. Nothing in the returned error echoes the input line.
 */
export function parsePactileIoEnvelopeStdoutLineV1(
  line: string,
): PactileIoEnvelopeStdoutLineResultV1 {
  const text = stripCarriageReturnV1(line);
  if (text.trim().length === 0) {
    return Object.freeze({
      outcome: "ignore" as const,
      reason: "empty-line" as const,
    });
  }
  const lineBytes = pactileIoEnvelopeUtf8ByteLengthV1(text);
  if (lineBytes > PACTILE_IO_ENVELOPE_MAX_LINE_BYTES_V1) {
    return Object.freeze({
      outcome: "drop" as const,
      error: stdoutErrorV1("line-too-large", lineBytes),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return Object.freeze({
      outcome: "drop" as const,
      error: stdoutErrorV1(
        hasExplicitTruncationMarkerV1(text) ? "truncated" : "invalid-json",
        lineBytes,
      ),
    });
  }
  const result = parsePactileIoEnvelopeV1(parsed);
  if (!result.success) {
    return Object.freeze({
      outcome: "drop" as const,
      error: stdoutErrorV1(
        "not-envelope",
        lineBytes,
        result.issues
          .slice(0, MAX_REPORTED_ISSUES_V1)
          .map((issue) => boundedIssueV1(issue.code, issue.path)),
      ),
    });
  }
  return Object.freeze({
    outcome: "forward" as const,
    envelope: result.data,
    fingerprint: result.fingerprint,
    lineBytes,
  });
}

/**
 * Pure framing entry: append one stdout chunk and emit only the complete
 * lines. The returned `pending` must be passed to the next call; it is never
 * parsed as an envelope until its `\n` arrives.
 */
export function framePactileIoEnvelopeStdoutChunkV1(
  pending: string,
  chunk: string,
): PactileIoEnvelopeStdoutFrameV1 {
  const combined = pending + chunk;
  const segments = combined.split("\n");
  const remainder = segments.pop() ?? "";
  const lines = segments.map(stripCarriageReturnV1);
  if (
    pactileIoEnvelopeUtf8ByteLengthV1(remainder) >
    PACTILE_IO_ENVELOPE_MAX_LINE_BYTES_V1
  ) {
    return Object.freeze({
      pending: "",
      lines: Object.freeze(lines),
      errors: Object.freeze([
        stdoutErrorV1(
          "line-too-large",
          pactileIoEnvelopeUtf8ByteLengthV1(remainder),
        ),
      ]),
    });
  }
  return Object.freeze({
    pending: remainder,
    lines: Object.freeze(lines),
    errors: Object.freeze([]),
  });
}

/**
 * Parse a captured stdout/stderr pair. Only complete stdout lines can become
 * envelopes; an unterminated trailing line, invalid JSON, a non-envelope JSON
 * value, a truncation marker and an over-limit line all produce a structured
 * error instead. stderr is copied to `diagnostics` and can never produce an
 * envelope.
 */
export function parsePactileIoEnvelopeStdoutV1(
  input: PactileIoEnvelopeStdoutParseInputV1,
): PactileIoEnvelopeStdoutParseV1 {
  const stdout = typeof input.stdout === "string" ? input.stdout : "";
  const envelopes: PactileIoEnvelopeStdoutForwardV1[] = [];
  const errors: PactileIoEnvelopeStdoutFailureV1[] = [];
  let ignoredLineCount = 0;
  // Only segments terminated by `\n` are complete lines. The final segment is
  // whatever remains after the last `\n` (empty when stdout ends with one) and
  // must never be parsed as an envelope.
  const segments = stdout.split("\n");
  const trailing = segments.pop() ?? "";
  segments.forEach((line, index) => {
    const result = parsePactileIoEnvelopeStdoutLineV1(line);
    if (result.outcome === "forward") {
      envelopes.push(result);
    } else if (result.outcome === "ignore") {
      ignoredLineCount += 1;
    } else {
      errors.push(
        Object.freeze({ lineNumber: index + 1, error: result.error }),
      );
    }
  });
  if (trailing.trim().length > 0) {
    errors.push(
      Object.freeze({
        lineNumber: segments.length + 1,
        error: stdoutErrorV1(
          "truncated",
          pactileIoEnvelopeUtf8ByteLengthV1(trailing),
        ),
      }),
    );
  }
  const stderr = typeof input.stderr === "string" ? input.stderr : "";
  const diagnostics =
    stderr.length === 0
      ? []
      : stderr
          .split("\n")
          .map(stripCarriageReturnV1)
          .filter((line) => line.length > 0);
  return Object.freeze({
    envelopes: Object.freeze(envelopes),
    ignoredLineCount,
    errors: Object.freeze(errors),
    diagnostics: Object.freeze(diagnostics),
  });
}
