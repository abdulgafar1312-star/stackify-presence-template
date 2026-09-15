// Stackify OS entitlement enforcement (Netlify Edge Function)
//
// Runs at the edge on every document request. It asks Stackify OS whether the
// website is entitled to be served, and returns a discreet suspension page when
// the subscription is suspended.
//
// Safety properties:
//   * Only document navigations are gated - assets, APIs and edge functions pass through.
//   * Responses are cached at the edge; Stackify is not queried per request.
//   * Fail-open, bounded: if Stackify is unreachable, the last verified status is
//     honoured for a limited window. Beyond that window a neutral maintenance
//     page is served - never an accusation of non-payment.
//   * A website is only suspended when Stackify explicitly says so.
//   * Entitlement responses are signed with the site secret and verified here.

import type { Config, Context } from "@netlify/edge-functions";

import { canonicalize, timingSafeEqual, verifySignature } from "./lib/signing.js";

interface Entitlement {
	website_id: string;
	status: "active" | "grace" | "suspended" | "inactive";
	plan: string;
	valid_until: string | null;
	features: string[];
	issued_at: string;
	expires_at: string;
	signature?: string;
}

interface CacheEntry {
	entitlement: Entitlement;
	fetched_at: number;
}

const DEFAULT_TTL_SECONDS = 900; // 15 minutes
const DEFAULT_FAIL_OPEN_SECONDS = 3600; // 1 hour
const FETCH_TIMEOUT_MS = 3000;

export default async function handler(request: Request, context: Context): Promise<Response> {
	// Only gate navigations that want HTML. Everything else passes untouched.
	if (request.method !== "GET" && request.method !== "HEAD") return context.next();
	if (!wantsHtml(request)) return context.next();

	const websiteId = Netlify.env.get("STACKIFY_WEBSITE_ID");
	const endpoint = Netlify.env.get("STACKIFY_ENTITLEMENT_ENDPOINT");
	const secret = Netlify.env.get("STACKIFY_SITE_SECRET");

	// Misconfiguration must not take a site down.
	if (!websiteId || !endpoint || !secret) {
		console.error("[stackify] entitlement not configured; failing open");
		return context.next();
	}

	const cacheKey = `https://stackify.internal/entitlement/${websiteId}`;
	const cached = await readCache(context, cacheKey);
	const now = Date.now();
	const ttlMs = DEFAULT_TTL_SECONDS * 1000;
	const failOpenMs = DEFAULT_FAIL_OPEN_SECONDS * 1000;

	// Use a fresh cached entitlement without contacting Stackify.
	if (cached && now - cached.fetched_at < ttlMs && (await verify(cached.entitlement, secret))) {
		return decide(cached.entitlement, context);
	}

	// Try a fresh fetch.
	try {
		const entitlement = await fetchEntitlement(endpoint, websiteId, secret);
		if (entitlement && (await verify(entitlement, secret))) {
			await writeCache(context, cacheKey, { entitlement, fetched_at: now });
			return decide(entitlement, context);
		}
		console.warn("[stackify] entitlement signature invalid; using cache if available");
	} catch (error) {
		console.warn(`[stackify] entitlement fetch failed: ${String(error)}`);
	}

	// Fetch failed: honour the last verified status within the fail-open window.
	if (cached && now - cached.fetched_at < failOpenMs && (await verify(cached.entitlement, secret))) {
		console.warn("[stackify] serving from stale entitlement (fail-open window)");
		return decide(cached.entitlement, context);
	}

	// No usable entitlement at all: allow the first render rather than block a
	// site we cannot verify. Alerting is handled server-side.
	if (!cached) {
		console.error("[stackify] no entitlement available; failing open (unverified)");
		return context.next();
	}

	// Stale beyond the fail-open window: neutral maintenance page, no accusation.
	console.error("[stackify] entitlement stale beyond fail-open window; serving maintenance page");
	return maintenanceResponse();
}

function decide(entitlement: Entitlement, context: Context): Response {
	switch (entitlement.status) {
		case "active":
		case "grace":
			return context.next();
		case "suspended":
		case "inactive":
		default:
			return suspensionResponse();
	}
}

function wantsHtml(request: Request): boolean {
	const accept = request.headers.get("accept") ?? "";
	if (accept.includes("text/html")) return true;
	const dest = request.headers.get("sec-fetch-dest");
	if (dest === "document") return true;
	const url = new URL(request.url);
	return url.pathname === "/" || url.pathname.endsWith("/") || !url.pathname.includes(".");
}

async function fetchEntitlement(
	endpoint: string,
	websiteId: string,
	secret: string,
): Promise<Entitlement | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const body = new URLSearchParams({ website_id: websiteId, site_secret: secret });
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: body.toString(),
			signal: controller.signal,
		});
		if (!response.ok) return null;
		const payload = (await response.json()) as Partial<Entitlement> & { error?: string };
		if (payload.error || !payload.status) return null;
		return payload as Entitlement;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Signature verification (HMAC-SHA256, canonical JSON matching the server)
// ---------------------------------------------------------------------------
async function verify(entitlement: Entitlement, secret: string): Promise<boolean> {
	if (!entitlement.signature) return false;
	return verifySignature(
		entitlement as unknown as Record<string, unknown>,
		entitlement.signature,
		secret,
	);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
async function readCache(context: Context, key: string): Promise<CacheEntry | null> {
	try {
		const cached = await context.cache.match(key);
		if (!cached) return null;
		return (await cached.json()) as CacheEntry;
	} catch {
		return null;
	}
}

async function writeCache(context: Context, key: string, entry: CacheEntry): Promise<void> {
	try {
		await context.cache.set(
			key,
			new Response(JSON.stringify(entry), {
				headers: {
					"content-type": "application/json",
					// Cache for the full fail-open window; freshness is tracked in the body.
					"cache-control": `public, max-age=${DEFAULT_FAIL_OPEN_SECONDS}`,
				},
			}),
		);
	} catch (error) {
		console.warn(`[stackify] cache write failed: ${String(error)}`);
	}
}

// ---------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------
function suspensionResponse(): Response {
	return new Response(suspensionHtml(), {
		status: 503,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"retry-after": "3600",
		},
	});
}

function maintenanceResponse(): Response {
	return new Response(maintenanceHtml(), {
		status: 503,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"retry-after": "300",
		},
	});
}

function page(title: string, message: string, ownerLink: boolean): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         background: #0f1115; color: #e8eaed; padding: 24px; }
  .card { max-width: 460px; width: 100%; text-align: center;
          background: #171a21; border: 1px solid #262b36; border-radius: 16px;
          padding: 40px 32px; }
  .mark { font-weight: 700; letter-spacing: .12em; font-size: 13px;
          text-transform: uppercase; color: #8b93a7; margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0 0 10px; font-weight: 600; }
  p { color: #a8b0c0; line-height: 1.55; margin: 0 0 8px; font-size: 15px; }
  a { color: #7aa2ff; text-decoration: none; font-size: 14px; }
  a:hover { text-decoration: underline; }
  .owner { margin-top: 26px; padding-top: 20px; border-top: 1px solid #262b36; }
</style>
</head>
<body>
  <main class="card">
    <div class="mark">Stackify</div>
    <h1>${title}</h1>
    <p>${message}</p>
    ${
			ownerLink
				? `<div class="owner"><a href="https://app.stackify.com" rel="noopener">Business owner? Sign in to manage your service</a></div>`
				: ""
		}
  </main>
</body>
</html>`;
}

function suspensionHtml(): string {
	return page(
		"This website is temporarily unavailable",
		"Please check back shortly.",
		true,
	);
}

function maintenanceHtml(): string {
	return page(
		"This website is temporarily unavailable",
		"We are performing maintenance. Please check back shortly.",
		false,
	);
}

export const config: Config = {
	path: "/*",
	cache: "manual",
};
