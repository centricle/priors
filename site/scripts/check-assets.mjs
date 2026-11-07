#!/usr/bin/env node
/**
 * After the build: never ship HTML that points at a file the Worker lacks.
 *
 * Scans dist/ for every URL on the asset origin (src and srcset alike), reads
 * the Worker's manifest.json once, and fails listing every referenced path
 * the manifest does not hold. The same rule as the OG-card guard in
 * prebuild.mjs, applied to the images that left this host. It also fails on
 * a render or thumb path still on the site's own host, which is a call site
 * that bypassed `asset()`, and on a download button whose GitHub release
 * asset is not there.
 *
 * Runs last in `npm run build`, so a failure on the build box fails the
 * deploy and production stays on the previous one. A transient failure is
 * recovered with Netlify's "retry deploy" (rig/runbooks/NETLIFY_DEPLOY.md).
 *
 *   --manifest <url or file>   read the manifest from here instead of the
 *                              origin; a local file tests the failure path
 *   --dist <dir>               the built site (default: ../dist)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import astroConfig from '../astro.config.mjs';
import { origin, prefixes } from '../cdn/config.mjs';
import { fetchRetry } from './lib/http.mjs';

const here = fileURLToPath(import.meta.url);
const site = join(dirname(here), '..');
const argv = process.argv.slice(2);
const opt = (flag, fallback) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback);
// An ignored flag turns a test of the failure path into a quiet pass:
// `--origin https://example.invalid` once printed "ok" against the live manifest.
for (const a of argv.filter((a) => a.startsWith('--'))) {
  if (!['--manifest', '--dist'].includes(a)) {
    console.error(`check-assets: unknown option ${a} (takes --manifest, --dist)`);
    process.exit(2);
  }
}
const dist = opt('--dist', join(site, 'dist'));
const manifestFrom = opt('--manifest', `${origin}/manifest.json`);

const problems = [];
const fail = (msg) => problems.push(msg);
const log = (msg) => console.log(`check-assets: ${msg}`);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

if (!existsSync(dist)) {
  console.error(`check-assets: ${dist} does not exist; run astro build first`);
  process.exit(1);
}

// ------------------------------------------------------------------- scan

// A URL ends at whitespace, a quote, a comma (srcset), or markup. The paths
// here hold none of those.
const onOrigin = new RegExp(`${escape(origin)}(/[^\\s"'<>&\\\\,)]+)`, 'g');
const base = (astroConfig.base ?? '').replace(/\/+$/, '');
const local = new RegExp(`(?<=["'\\s,(])${escape(base)}(${prefixes.map(escape).join('|')})[^\\s"'<>&\\\\,)]*`, 'g');
const release = /https:\/\/github\.com\/[^\s"'<>&\\]+?\/releases\/download\/[^\s"'<>&\\]+/g;

const refs = new Map(); // path -> first file that references it
const leftovers = new Map();
const releases = new Set();
let pages = 0;
for (const entry of readdirSync(dist, { withFileTypes: true, recursive: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
  const file = join(entry.parentPath, entry.name);
  const html = readFileSync(file, 'utf8');
  const rel = relative(dist, file);
  pages++;
  for (const m of html.matchAll(onOrigin)) if (!refs.has(m[1])) refs.set(m[1], rel);
  for (const m of html.matchAll(local)) if (!leftovers.has(m[0])) leftovers.set(m[0], rel);
  for (const m of html.matchAll(release)) releases.add(m[0]);
}
log(`${pages} pages, ${refs.size} distinct paths on ${origin}, ${releases.size} release downloads`);

if (refs.size === 0) fail(`no page references ${origin}; is asset() wired in, and is this a production build?`);
for (const [path, file] of leftovers) fail(`${file} still points at ${path} on this host; use asset() from src/lib/href.mjs`);

// netlify.toml carries the origin a second time, in the redirects for the
// old image URLs. TOML cannot import config.mjs, so this is the check.
const toml = join(site, '..', 'netlify.toml');
if (existsSync(toml)) {
  for (const line of readFileSync(toml, 'utf8').split('\n')) {
    const m = /^\s*to\s*=\s*"(https?:\/\/[^"]+)"/.exec(line);
    if (m && prefixes.some((p) => m[1].includes(`${p}:splat`)) && !m[1].startsWith(`${origin}/`)) {
      fail(`netlify.toml redirects to ${m[1]}, not ${origin}; the two have to agree`);
    }
  }
}

// --------------------------------------------------------------- manifest

let manifest;
try {
  if (/^https?:\/\//.test(manifestFrom)) {
    const res = await fetchRetry(manifestFrom, { log, cache: 'no-store' });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } else {
    manifest = JSON.parse(readFileSync(manifestFrom, 'utf8'));
  }
} catch (err) {
  fail(`could not read the manifest from ${manifestFrom}: ${err.message}; none of the ${refs.size} paths could be checked`);
}
if (manifest) {
  const files = manifest.files ?? {};
  const missing = [...refs.keys()].filter((p) => !(p in files)).sort();
  if (missing.length) {
    fail(`${missing.length} of ${refs.size} referenced paths are not on ${origin}; run npm run cdn from the renders that built this site, then build again:`);
    for (const p of missing) fail(`  ${p}  (first in ${refs.get(p)})`);
  } else {
    log(`every path is in the manifest (${Object.keys(files).length} files live)`);
  }
}

// --------------------------------------------------------------- releases

// GitHub answers a HEAD on a release asset with a redirect to its storage,
// and a 404 when the asset is not on the release. Nothing is downloaded.
for (const url of [...releases].sort()) {
  try {
    const res = await fetchRetry(url, { method: 'HEAD', redirect: 'manual', log });
    if (res.status >= 200 && res.status < 400) log(`${url}: ${res.status}`);
    else fail(`${url}: HTTP ${res.status}; run bin/release-data.sh`);
  } catch (err) {
    fail(`${url}: ${err.message}`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`check-assets: ${p}`);
  process.exit(1);
}
log('ok');
