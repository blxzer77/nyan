import { type createPrivateKey, type createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";

/**
 * A throwaway CA and a server certificate it signed, built in memory with `node:crypto` (which can sign but has no
 * certificate builder), so the tests commit no key and need no `openssl`. The CA is not a root of any store: a client
 * trusts it only when a test hands it over, for example through `NODE_EXTRA_CA_CERTS`.
 */

const OID = {
	ecdsaWithSha256: "1.2.840.10045.4.3.2",
	commonName: "2.5.4.3",
	basicConstraints: "2.5.29.19",
	keyUsage: "2.5.29.15",
	extKeyUsage: "2.5.29.37",
	subjectAltName: "2.5.29.17",
	serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

function der(tag: number, ...parts: Buffer[]): Buffer {
	const body = Buffer.concat(parts);
	if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
	const length = body.length < 0x100 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff];
	return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const set = (...parts: Buffer[]) => der(0x31, ...parts);
const octetString = (value: Buffer) => der(0x04, value);
const utf8String = (value: string) => der(0x0c, Buffer.from(value));
const boolean = (value: boolean) => der(0x01, Buffer.from([value ? 0xff : 0x00]));
const bitString = (value: Buffer, unusedBits = 0) => der(0x03, Buffer.from([unusedBits]), value);
/** A positive INTEGER from big-endian bytes. */
const integer = (bytes: Buffer) => der(0x02, bytes[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);

function oid(dotted: string): Buffer {
	const arcs = dotted.split(".").map(Number);
	const bytes = [arcs[0] * 40 + arcs[1]];
	for (const arc of arcs.slice(2)) {
		const chunk = [arc & 0x7f];
		for (let rest = arc >> 7; rest > 0; rest >>= 7) chunk.unshift((rest & 0x7f) | 0x80);
		bytes.push(...chunk);
	}
	return der(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
	const text = date.toISOString().replace(/[-:T]/g, "").slice(2, 14);
	return der(0x17, Buffer.from(`${text}Z`));
}

const name = (commonName: string) => sequence(set(sequence(oid(OID.commonName), utf8String(commonName))));
const extension = (id: string, critical: boolean, value: Buffer) =>
	sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));

interface Certificate {
	subject: string;
	issuer: string;
	publicKey: Buffer;
	signingKey: ReturnType<typeof createPrivateKey>;
	extensions: Buffer[];
}

function certificate({ subject, issuer, publicKey, signingKey, extensions }: Certificate): Buffer {
	const signatureAlgorithm = sequence(oid(OID.ecdsaWithSha256));
	const now = Date.now();
	const tbs = sequence(
		der(0xa0, integer(Buffer.from([2]))),
		integer(Buffer.concat([Buffer.from([0x01]), randomBytes(7)])),
		signatureAlgorithm,
		name(issuer),
		sequence(utcTime(new Date(now - 24 * 3600_000)), utcTime(new Date(now + 24 * 3600_000))),
		name(subject),
		publicKey,
		der(0xa3, sequence(...extensions)),
	);
	const signature = sign("sha256", tbs, { key: signingKey, dsaEncoding: "der" });
	return sequence(tbs, signatureAlgorithm, bitString(signature));
}

function pem(label: string, bytes: Buffer): string {
	const lines = bytes.toString("base64").match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export interface TestCertificates {
	/** The CA certificate: what a client has to trust. */
	caPem: string;
	/** The server's key and certificate for `localhost` and `127.0.0.1`, signed by that CA. */
	serverKeyPem: string;
	serverCertPem: string;
}

export function createTestCertificates(): TestCertificates {
	const ca = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const server = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const spki = (key: ReturnType<typeof createPublicKey>) => key.export({ type: "spki", format: "der" });

	const caCertificate = certificate({
		subject: "nyan-test-ca",
		issuer: "nyan-test-ca",
		publicKey: spki(ca.publicKey),
		signingKey: ca.privateKey,
		extensions: [
			extension(OID.basicConstraints, true, sequence(boolean(true))),
			// keyCertSign and cRLSign: bits 5 and 6, one unused bit.
			extension(OID.keyUsage, true, bitString(Buffer.from([0x06]), 1)),
		],
	});
	const serverCertificate = certificate({
		subject: "localhost",
		issuer: "nyan-test-ca",
		publicKey: spki(server.publicKey),
		signingKey: ca.privateKey,
		extensions: [
			extension(OID.basicConstraints, true, sequence()),
			// digitalSignature: bit 0, seven unused bits.
			extension(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)),
			extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
			extension(
				OID.subjectAltName,
				false,
				sequence(der(0x82, Buffer.from("localhost")), der(0x87, Buffer.from([127, 0, 0, 1]))),
			),
		],
	});

	return {
		caPem: pem("CERTIFICATE", caCertificate),
		serverKeyPem: server.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		serverCertPem: pem("CERTIFICATE", serverCertificate),
	};
}
