// Stackify OS storefront proxy (Netlify Edge Function)
//
// The storefront must call Stackify OS to list products, place orders and
// track them. Those calls need the per-site credential, which is a secret: if
// it shipped in the page bundle anyone could read it from view-source and
// impersonate the site.
//
// This function runs at the edge, holds the credential, and forwards a small
// allow-list of actions to Stackify OS. The browser only ever talks to
// /api/shop/*.
//
// Security properties:
//   * Only the actions below are proxied; anything else is 404.
//   * website_id and site_secret are taken from the environment. Any values
//     sent by the browser are discarded, so a caller cannot target another site.
//   * The request body is size-capped and must be JSON or form-encoded.
//   * Upstream errors are surfaced as a generic message; no secrets or internal
//     details are echoed back.

import type { Config, Context } from "@netlify/edge-functions";

interface Route {
	method: "GET" | "POST";
	/** Frappe dotted method path, appended to the API base. */
	method_path: string;
}

const ROUTES: Record<string, Route> = {
	catalogue: { method: "GET", method_path: "stackify_os.api.shop.catalogue" },
	checkout: { method: "POST", method_path: "stackify_os.api.shop.checkout" },
	"order-status": { method: "GET", method_path: "stackify_os.api.shop.order_status" },
};

const MAX_BODY_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

export default async function handler(request: Request, context: Context): Promise<Response> {
	const url = new URL(request.url);
	const action = url.pathname.replace(/^\/api\/shop\/?/, "").replace(/\/+$/, "");
	const route = ROUTES[action];

	if (!route) return json({ error: "not_found" }, 404);
	if (request.method !== route.method) {
		return json({ error: "method_not_allowed" }, 405, { allow: route.method });
	}

	const websiteId = Netlify.env.get("STACKIFY_WEBSITE_ID");
	const secret = Netlify.env.get("STACKIFY_SITE_SECRET");
	const base = resolveBase();

	if (!websiteId || !secret || !base) {
		console.error("[stackify] shop proxy not configured");
		return json({ error: "not_configured" }, 503);
	}

	// Collect the caller's fields, then overwrite the credential fields. Order
	// matters: the environment values always win.
	let fields: Record<string, string> = {};
	try {
		fields = await readFields(request, url);
	} catch (error) {
		const message = error instanceof Error ? error.message : "bad_request";
		return json({ error: message }, 400);
	}

	const payload = new URLSearchParams({
		...fields,
		website_id: websiteId,
		site_secret: secret,
	});

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
	let upstream: Response;
	try {
		upstream = await fetch(`${base}/${route.method_path}`, {			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				accept: "application/json",
			},
			body: payload.toString(),
			signal: controller.signal,
		});
	} catch (error) {
		console.error(`[stackify] shop upstream failed: ${String(error)}`);
		return json({ error: "upstream_unavailable" }, 503);
	} finally {
		clearTimeout(timer);
	}

	return await relay(upstream, action);
}

/**
 * Frappe wraps whitelisted responses in { message: ... }. Unwrap it so the
 * storefront sees the payload directly, and keep error shapes predictable.
 */
async function relay(upstream: Response, action: string): Promise<Response> {
	const text = await upstream.text();

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		console.error(`[stackify] shop/${action} returned non-JSON (${upstream.status})`);
		return json({ error: "bad_upstream_response" }, 502);
	}

	if (upstream.ok) {
		const body = unwrap(parsed);
		return json(body, 200);
	}

	// Surface the server's own validation message (e.g. "Your cart is empty"),
	// but never internal detail for 5xx.
	const detail = unwrap(parsed) as { message?: string; error?: string; exc?: string } | null;
	const safeMessage =
		upstream.status < 500
			? firstLine(detail?.message ?? detail?.error ?? "request_rejected")
			: "upstream_error";

	if (upstream.status >= 500) {
		console.error(`[stackify] shop/${action} upstream ${upstream.status}: ${firstLine(text)}`);
	}

	return json({ error: safeMessage }, upstream.status);
}

function unwrap(payload: unknown): unknown {
	if (payload && typeof payload === "object" && "message" in (payload as Record<string, unknown>)) {
		return (payload as Record<string, unknown>).message;
	}
	return payload;
}

/** Frappe's message may carry a traceback or markup; keep only the first line. */
function firstLine(value: unknown): string {
	const text = String(value ?? "").split("\n")[0].trim();
	return text.slice(0, 300) || "request_rejected";
}

async function readFields(request: Request, url: URL): Promise<Record<string, string>> {
	const fields: Record<string, string> = {};

	// Query string (used by catalogue and order-status).
	for (const [key, value] of url.searchParams) {
		if (key === "website_id" || key === "site_secret") continue;
		fields[key] = value;
	}

	if (request.method !== "POST") return fields;

	const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim();
	const raw = await request.text();

	if (raw.length > MAX_BODY_BYTES) throw new Error("payload_too_large");
	if (!raw) return fields;

	if (contentType === "application/json") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error("invalid_json");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("invalid_json");
		}
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (key === "website_id" || key === "site_secret") continue;
			// Arrays and objects (the cart) are passed through as JSON strings,
			// which is what the Frappe endpoint parses.
			fields[key] =
				typeof value === "string" ? value : JSON.stringify(value ?? null);
		}
		return fields;
	}

	if (contentType === "application/x-www-form-urlencoded") {
		for (const [key, value] of new URLSearchParams(raw)) {
			if (key === "website_id" || key === "site_secret") continue;
			fields[key] = value;
		}
		return fields;
	}

	throw new Error("unsupported_content_type");
}

/**
 * The API base is the content endpoint with the method segment removed. A
 * dedicated variable wins when set, so the two can point at different hosts.
 * The returned base never has a trailing slash; callers join with "/".
 */
function resolveBase(): string | null {
	const explicit = Netlify.env.get("STACKIFY_SHOP_ENDPOINT");
	if (explicit) return explicit.replace(/\/+$/, "");

	const content = Netlify.env.get("STACKIFY_CONTENT_ENDPOINT");
	if (!content) return null;

	const marker = "/api/method/";
	const index = content.indexOf(marker);
	if (index === -1) return null;

	return (content.slice(0, index) + marker).replace(/\/+$/, "");
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			...extraHeaders,
		},
	});
}

export const config: Config = {
	path: "/api/shop/*",
	cache: "manual",
};
