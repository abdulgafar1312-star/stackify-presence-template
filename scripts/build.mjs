#!/usr/bin/env node
/**
 * Stackify Presence template build.
 *
 * Reads site.config.json and src/, and writes a static site into public/.
 * No framework, no runtime dependencies.
 *
 *   node scripts/build.mjs
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");
const OUT = join(ROOT, "public");

const localConfig = JSON.parse(readFileSync(join(ROOT, "site.config.json"), "utf8"));

// When Stackify OS is connected, the site build pulls the client's published
// content. Otherwise the checked-in site.config.json is used.
async function loadConfig() {
	const endpoint = process.env.STACKIFY_CONTENT_ENDPOINT;
	const websiteId = process.env.STACKIFY_WEBSITE_ID;
	const secret = process.env.STACKIFY_SITE_SECRET;

	if (!endpoint || !websiteId || !secret) {
		console.log("Using local site.config.json (Stackify content not configured).");
		return localConfig;
	}

	try {
		const body = new URLSearchParams({ website_id: websiteId, site_secret: secret });
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const payload = await response.json();
		const content = payload.message || payload;
		if (!content || !content.business_name) throw new Error("no content returned");
		console.log(`Using Stackify content for ${websiteId} (revision ${content.revision}).`);
		return {
			...localConfig,
			...content,
			services: content.services && content.services.length ? content.services : localConfig.services,
			social: {
				facebook: content.social_facebook || "",
				instagram: content.social_instagram || "",
				x: content.social_x || "",
			},
		};
	} catch (error) {
		console.warn(`Could not fetch Stackify content (${error.message}); falling back to site.config.json.`);
		return localConfig;
	}
}

const config = await loadConfig();

const escapeHtml = (value) =>
	String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

const telHref = String(config.phone ?? "").replace(/[^\d+]/g, "").replace(/^\+/, "+");
const waNumber = String(config.whatsapp ?? "").replace(/[^\d]/g, "");

const whatsappUrl = waNumber ? `https://wa.me/${waNumber}` : "";

const serviceCards = (config.services ?? [])
	.map(
		(s) => `        <article class="card">
          <h3>${escapeHtml(s.title)}</h3>
          <p>${escapeHtml(s.body)}</p>
        </article>`,
	)
	.join("\n");

const socials = Object.entries(config.social ?? {}).filter(([, url]) => url);
const socialLinks = socials
	.map(([name, url]) => `          <a href="${escapeHtml(url)}" rel="noopener">${escapeHtml(name)}</a>`)
	.join("\n");

const replacements = {
	"{{business_name}}": escapeHtml(config.business_name),
	"{{tagline}}": escapeHtml(config.tagline),
	"{{description}}": escapeHtml(config.description),
	"{{brand_color}}": escapeHtml(config.brand_color),
	"{{accent_color}}": escapeHtml(config.accent_color),
	"{{phone}}": escapeHtml(config.phone),
	"{{phone_raw}}": escapeHtml(telHref),
	"{{email}}": escapeHtml(config.email),
	"{{address}}": escapeHtml(config.address),
	"{{service_cards}}": serviceCards,
	"{{social_links}}": socialLinks,
	"{{whatsapp_nav}}": whatsappUrl
		? `<a href="${escapeHtml(whatsappUrl)}" rel="noopener">WhatsApp</a>`
		: "",
	"{{whatsapp_button}}": whatsappUrl
		? `<a class="btn btn-ghost" href="${escapeHtml(whatsappUrl)}" rel="noopener">Chat on WhatsApp</a>`
		: "",
};

let html = readFileSync(join(SRC, "index.html"), "utf8");
for (const [token, value] of Object.entries(replacements)) {
	html = html.split(token).join(value);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "index.html"), html, "utf8");
cpSync(join(SRC, "styles.css"), join(OUT, "styles.css"));
cpSync(join(SRC, "main.js"), join(OUT, "main.js"));

console.log(`Built ${config.business_name} -> public/`);
