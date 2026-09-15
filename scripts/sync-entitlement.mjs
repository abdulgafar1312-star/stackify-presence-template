#!/usr/bin/env node
/**
 * Copies the shared Stackify entitlement edge function into this template.
 *
 * The entitlement repo is the single source of truth:
 *   ../stackify-netlify-entitlement
 *
 *   node scripts/sync-entitlement.mjs
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "..", "stackify-netlify-entitlement", "netlify", "edge-functions");
const DEST = join(ROOT, "netlify", "edge-functions");

if (!existsSync(SRC)) {
	console.error(`Entitlement source not found: ${SRC}`);
	process.exit(1);
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true });

console.log(`Synced entitlement edge function -> ${DEST}`);
