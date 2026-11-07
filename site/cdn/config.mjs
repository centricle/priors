/**
 * The one project-specific block of the asset offload. Everything else under
 * site/cdn/ and site/scripts/{cdn,check-assets}.mjs is fleet-shaped: the next
 * project copies the directory, edits this file and its wrangler.toml, and
 * keeps the scripts as they are.
 *
 * The renders (`/r/`) and thumbs (`/t/`) are served from a Cloudflare Worker
 * that holds nothing but static assets, because asset requests there are
 * free and unmetered while every byte Netlify sends counts against a team
 * cap shared with centricle.com and every curio on it. The origin is baked
 * into the built HTML through `asset()` in src/lib/href.mjs, so this file is
 * imported at build time and by the deploy and check scripts; there is no
 * environment variable to export and no build-box setting to forget.
 *
 * `origin` has to match what wrangler deploys: `<name>.<account subdomain>
 * .workers.dev`. The account's subdomain is `centricle` (rig/usernames.json,
 * `workers-dev`); scripts/cdn.mjs refuses to call a deploy done until the
 * manifest it just uploaded reads back from this exact origin, so a wrong
 * value here fails loudly instead of shipping HTML that points nowhere.
 *
 * Renames: Cloudflare may rename workers.dev subdomains with about a week's
 * notice (Developer Platform terms). The fix is one edit here and a push.
 */
export const name = 'priors-assets';
export const origin = 'https://priors-assets.centricle.workers.dev';

// Site paths served from the Worker. `asset()` sends these to `origin` in a
// production build and leaves everything else on the site's own host.
export const prefixes = ['/r/', '/t/'];

// Headers the Worker puts on every asset. Seven days, revalidated by ETag
// afterward: not `immutable`, because a render can be redrawn at the same
// path (bin/render.sh --force, a THUMB change in scripts/lib/renders.mjs) and
// bytes from the Worker cost nothing, so a long browser cache buys nothing.
// nosniff and Referrer-Policy are what the images lose by leaving Netlify's
// `/*` rule; Cross-Origin-Resource-Policy is defensive, for the day
// centricle.com sets COEP.
export const headers = {
  'Cache-Control': 'public, max-age=604800',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

// Checked at import, so a bad value fails the build, the deploy and the
// check alike instead of reaching HTML: https, a host, no path, no slash.
if (!/^https:\/\/[^/]+$/.test(origin)) throw new Error(`cdn/config.mjs: origin must be https://<host> with no path or trailing slash, got "${origin}"`);
for (const p of prefixes) if (!/^\/.+\/$/.test(p)) throw new Error(`cdn/config.mjs: prefix "${p}" must start and end with /`);
