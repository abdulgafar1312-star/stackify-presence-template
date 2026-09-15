// Shared canonicalization + HMAC helpers.
//
// Plain ESM so it can be imported by the Netlify edge runtime (Deno) and by
// Node tests without a build step. The canonical form MUST match
// stackify_os/utils/canonical.py exactly.

/**
 * Deterministic JSON: sorted keys, no whitespace.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalize(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const record = /** @type {Record<string, unknown>} */ (value);
	const keys = Object.keys(record).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(",")}}`;
}

/**
 * @param {string} secret
 * @param {string} message
 * @returns {Promise<string>} lowercase hex HMAC-SHA256
 */
export async function signHex(secret, message) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} signature
 * @param {string} secret
 * @returns {Promise<boolean>}
 */
export async function verifySignature(payload, signature, secret) {
	const { signature: _ignored, ...rest } = /** @type {any} */ (payload);
	const expected = await signHex(secret, canonicalize(rest));
	return timingSafeEqual(expected, signature);
}
