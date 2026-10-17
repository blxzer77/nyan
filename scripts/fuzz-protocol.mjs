import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { CborError, decodeCbor, encodeCbor } from "../packages/protocol/src/cbor/index.ts";
import { encodeFrame, FrameDecoder, FrameError } from "../packages/protocol/src/framing.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CORPUS_PATH = resolve(ROOT, ".ci/fuzz-corpus/protocol.json");
const FAILURE_PATH = resolve(ROOT, ".artifacts/fuzz/protocol-failure.json");
const DEFAULT_SEED = 20261017;
const DEFAULT_RUNS = process.env.GITHUB_ACTIONS ? 5_000 : 1_000;

function integer(name, fallback) {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function seed() {
	const value = Number.parseInt(process.env.FUZZ_SEED ?? "", 10);
	return Number.isSafeInteger(value) ? value : DEFAULT_SEED;
}

function isWellFormedUnicode(value) {
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				index++;
				continue;
			}
			return false;
		}
		if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
	}
	return true;
}

const stringArbitrary = fc.string({ maxLength: 80 }).filter(isWellFormedUnicode);
const numberArbitrary = fc
	.oneof(
		fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
		fc.double({ min: -1e100, max: 1e100, noNaN: true, noDefaultInfinity: true }),
	)
	.filter((value) => !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value)));

const jsonLikeArbitrary = fc.letrec((tie) => ({
	value: fc.oneof(
		{ weight: 5, arbitrary: fc.constant(null) },
		{ weight: 5, arbitrary: fc.boolean() },
		{ weight: 8, arbitrary: numberArbitrary },
		{ weight: 8, arbitrary: stringArbitrary },
		{ weight: 2, arbitrary: fc.array(tie("value"), { maxLength: 5 }) },
		{
			weight: 2,
			arbitrary: fc.dictionary(stringArbitrary, tie("value"), { maxKeys: 5 }).map((value) => ({ ...value })),
		},
	),
})).value;

function assertError(error, context) {
	assert.ok(error instanceof CborError, `${context}: unexpected error ${String(error)}`);
}

function assertFrameError(error, context) {
	assert.ok(error instanceof FrameError, `${context}: unexpected error ${String(error)}`);
}

async function loadCorpus() {
	const raw = await readFile(CORPUS_PATH, "utf8");
	const corpus = JSON.parse(raw);
	assert.equal(corpus.schemaVersion, 1, "unsupported fuzz corpus schema");
	assert.ok(Array.isArray(corpus.cases), "fuzz corpus cases must be an array");
	return corpus.cases;
}

async function persistFailure(kind, error) {
	await mkdir(dirname(FAILURE_PATH), { recursive: true });
	const failure = {
		kind,
		seed: error?.seed ?? null,
		path: error?.path ?? null,
		counterexample: error?.counterexample ?? null,
		message: error instanceof Error ? error.message : String(error),
	};
	await writeFile(FAILURE_PATH, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
}

function runProperty(name, arbitrary, property, options) {
	try {
		fc.assert(fc.property(arbitrary, property), options);
	} catch (error) {
		return persistFailure(name, error).then(() => {
			throw error;
		});
	}
	return Promise.resolve();
}

const runCount = integer("FUZZ_RUNS", DEFAULT_RUNS);
const fuzzSeed = seed();
const options = {
	endOnFailure: true,
	interruptAfterTimeLimit: integer("FUZZ_TIME_LIMIT_MS", 0) || undefined,
	numRuns: runCount,
	seed: fuzzSeed,
};

for (const corpusCase of await loadCorpus()) {
	assert.match(corpusCase.name, /\S/, "fuzz corpus case needs a name");
	assert.match(corpusCase.bytesHex, /^(?:[0-9a-f]{2})*$/i, `${corpusCase.name}: invalid hex`);
	const bytes = Uint8Array.from(Buffer.from(corpusCase.bytesHex, "hex"));
	try {
		decodeCbor(bytes);
		assert.equal(corpusCase.expected, "accept", `${corpusCase.name}: expected decoder rejection`);
	} catch (error) {
		if (corpusCase.expected === "accept") throw error;
		assertError(error, corpusCase.name);
	}
}

await runProperty(
	"cbor-round-trip",
	jsonLikeArbitrary,
	(value) => {
		const encoded = encodeCbor(value);
		const decoded = decodeCbor(encoded);
		assert.deepStrictEqual(decoded, value);
	},
	options,
);

await runProperty(
	"cbor-malformed-input",
	fc.uint8Array({ maxLength: 512 }),
	(bytes) => {
		try {
			decodeCbor(bytes);
		} catch (error) {
			assertError(error, "random decoder input");
		}
	},
	options,
);

await runProperty(
	"frame-round-trip",
	fc.array(fc.uint8Array({ maxLength: 256 }), { maxLength: 8 }),
	(payloads) => {
		const streamLength = payloads.reduce((total, payload) => total + 4 + payload.byteLength, 0);
		const stream = new Uint8Array(streamLength);
		let offset = 0;
		for (const payload of payloads) {
			const frame = encodeFrame(payload);
			stream.set(frame, offset);
			offset += frame.byteLength;
		}

		const decoder = new FrameDecoder({ maxFrameLength: 1_024 });
		const decoded = [];
		for (const byte of stream) decoded.push(...decoder.push(Uint8Array.of(byte)));
		decoder.end();
		assert.deepStrictEqual(decoded, payloads);
	},
	options,
);

await runProperty(
	"frame-malformed-input",
	fc.uint8Array({ maxLength: 512 }),
	(bytes) => {
		const decoder = new FrameDecoder({ maxFrameLength: 1_024 });
		try {
			decoder.push(bytes);
		} catch (error) {
			assertFrameError(error, "random frame input");
			return;
		}
		try {
			decoder.end();
		} catch (error) {
			assertFrameError(error, "random frame end");
		}
	},
	options,
);

console.log(`protocol fuzz passed: ${runCount} CBOR round-trips + ${runCount} malformed CBOR inputs + ${runCount} frame streams (seed ${fuzzSeed})`);
