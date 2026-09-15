# Stackify Presence Template

A standardized, configurable website for **Stackify Presence** (GH₵199/mo) clients.
Content and branding live in `site.config.json`; the build produces a static site
in `public/`. Stackify OS entitlement enforcement is included via a Netlify Edge
Function, so a suspended subscription takes the site offline automatically.

## Why a template

A GH₵199/month client cannot justify weeks of bespoke design. This template is
fast to onboard, cheap to host and maintain, and still looks professional.

## Configure

Edit `site.config.json`:

| Key | Purpose |
|---|---|
| `business_name`, `tagline`, `description` | Brand and copy |
| `brand_color`, `accent_color` | Theme |
| `phone`, `whatsapp`, `email`, `address` | Contact details |
| `services[]` | Service cards |
| `social` | Social links (empty values are hidden) |

## Build

```bash
node scripts/build.mjs        # -> public/
node scripts/sync-entitlement.mjs   # copies the shared edge function
```

## Deploy

Netlify builds automatically via `netlify.toml`. Set the environment variables
from `.env.example` on each site:

- `STACKIFY_WEBSITE_ID`
- `STACKIFY_ENTITLEMENT_ENDPOINT`
- `STACKIFY_SITE_SECRET`
- `STACKIFY_ENVIRONMENT`

## Entitlement behaviour

The edge function is **cache-first** and only gates document requests. If
Stackify OS is unreachable it fails open (bounded) rather than taking the site
down, and it only suspends when Stackify explicitly says so. See
`../stackify-netlify-entitlement`.

## Layout

```
site.config.json              business configuration
src/index.html                template with {{placeholders}}
src/styles.css                styles
src/main.js                   tiny client script
scripts/build.mjs             static build
scripts/sync-entitlement.mjs  pull the shared edge function
netlify.toml                  build + edge function config
```
