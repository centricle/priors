#!/usr/bin/env node
/**
 * Deploy the renders to the Cloudflare Worker that serves them in production.
 * Run by hand, from this Mac, whenever ../renders changes: `npm run cdn`.
 *
 *   ../renders/<run>/NNN.webp  ->  cdn/assets/r/<run>/NNN.webp   copied as is
 *                              ->  cdn/assets/t/<run>/NNN.webp   200x200 thumb
 *   (written here)             ->  cdn/assets/_headers            applied, not served
 *   (written here)             ->  cdn/assets/manifest.json       path -> size, sha256
 *
 * Staged straight from ../renders, never from public/: after a production
 * build public/ is empty, and a Worker deploy replaces the whole file
 * manifest at once, so a partial tree would delete images production is
 * serving. The same guard runs against the live site: the manifest.json the
 * Worker serves now is fetched first, and the deploy refuses if any path it
 * lists would vanish, unless --prune says that is the intent.
 *
 *   --dry-run   stage and validate, let wrangler count the files, upload nothing
 *   --prune     allow paths that are live now to vanish (a run removed from
 *               renders/), and go ahead when the live manifest cannot be read
 *
 * wrangler runs with the terminal attached, because its first deploy on an
 * account may prompt to register the workers.dev subdomain, and in an agent
 * environment it registers one without asking. That subdomain is one per
 * account and only Cloudflare can rename it, so the first run on a new
 * account is a person's, from a plain terminal. Nothing in this file is
 * priors-specific; the project block is cdn/config.mjs.
 *
 * Fleet record: rig/runbooks/IMAGE_HOSTING.md, "Workers static assets".
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headers, name, origin, prefixes } from '../cdn/config.mjs';
import { fetchRetry } from './lib/http.mjs';
import { stageRenders } from './lib/renders.mjs';

const flags = new Set(process.argv.slice(2));
const dryRun = flags.has('--dry-run');
const prune = flags.has('--prune');
for (const f of flags) if (!['--dry-run', '--prune'].includes(f)) die(`unknown flag ${f}\nusage: cdn.mjs [--dry-run] [--prune]`);

const here = fileURLToPath(import.meta.url);
const site = join(dirname(here), '..');
const repo = join(site, '..');
const cdnDir = join(site, 'cdn');
const assets = join(cdnDir, 'assets');
const wrangler = join(cdnDir, 'node_modules', '.bin', 'wrangler');
const MANIFEST = 'manifest.json';

function die(msg) {
  console.error(`cdn: ${msg}`);
  process.exit(1);
}
const log = (msg) => console.log(`cdn: ${msg}`);

// ------------------------------------------------------------------ sanity

if (!existsSync(wrangler)) die(`${relative(repo, wrangler)} is missing; run: npm --prefix site/cdn ci`);
const toml = readFileSync(join(cdnDir, 'wrangler.toml'), 'utf8');
const tomlName = /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
if (tomlName !== name) die(`wrangler.toml names the Worker "${tomlName}" but cdn/config.mjs says "${name}"`);
if (/^\s*\[?cache\b/m.test(toml)) die('wrangler.toml sets a cache key; Workers Caching bills asset requests that are otherwise free');

// ------------------------------------------------------------------- stage

const n = await stageRenders(join(repo, 'renders'), assets);
log(`staged ${n.files} files: copied ${n.copied}, thumbs ${n.thumbs}, skipped ${n.skipped}, removed ${n.removed}`);

// _headers: one rule per served prefix, and the manifest on its own so a
// browser revalidates it every time (the build box reads it on every deploy).
// Rules never overlap, which sidesteps the question of how two matching
// rules combine. The file applies to responses and is not itself served.
const rule = (path, h) => `${path}\n${Object.entries(h).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n`;
const headerRules = [
  ...prefixes.map((p) => rule(`${p}*`, headers)),
  rule(`/${MANIFEST}`, { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }),
];
writeFileSync(join(assets, '_headers'), headerRules.join('\n'));

// manifest.json: every served path with its size and sha256, so the build can
// prove a reference resolves without a request per image, and this script
// can see what a deploy would remove. The staging tree is owned by this
// script: a file it did not put there is an error, except the junk macOS drops.
const files = {};
for (const entry of readdirSync(assets, { withFileTypes: true, recursive: true })) {
  if (!entry.isFile()) continue;
  const abs = join(entry.parentPath, entry.name);
  const path = '/' + relative(assets, abs).split(sep).join('/');
  if (entry.name === '.DS_Store') {
    rmSync(abs, { force: true });
    continue;
  }
  if (path === '/_headers' || path === `/${MANIFEST}`) continue;
  if (!prefixes.some((p) => path.startsWith(p))) die(`${relative(repo, abs)} is not under a served prefix; remove it`);
  const bytes = readFileSync(abs);
  files[path] = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const paths = Object.keys(files).sort();
const manifest = { name, origin, count: paths.length, files: Object.fromEntries(paths.map((p) => [p, files[p]])) };
const manifestText = JSON.stringify(manifest, null, 0);
writeFileSync(join(assets, MANIFEST), manifestText);
log(`manifest: ${paths.length} paths, ${(manifestText.length / 1024).toFixed(0)} KB`);

// ------------------------------------------------------- live vs. staged

let live = null;
try {
  const res = await fetchRetry(`${origin}/${MANIFEST}`, { log });
  if (res.status === 200) live = await res.json();
  else if (res.status === 404) log(`no live manifest at ${origin} (first deploy?)`);
  else throw new Error(`HTTP ${res.status}`);
} catch (err) {
  const msg = `could not read the live manifest from ${origin}/${MANIFEST}: ${err.message}`;
  if (!prune && !dryRun) die(`${msg}\n     retry, or pass --prune if nothing is live there yet`);
  log(msg);
}
if (live?.files) {
  const vanishing = Object.keys(live.files).filter((p) => !(p in files));
  const changed = Object.keys(files).filter((p) => live.files[p] && live.files[p].sha256 !== files[p].sha256);
  const added = Object.keys(files).filter((p) => !live.files[p]);
  log(`against live: ${added.length} added, ${changed.length} changed, ${vanishing.length} would vanish`);
  if (vanishing.length) {
    const list = vanishing.slice(0, 20).join('\n     ') + (vanishing.length > 20 ? `\n     ... and ${vanishing.length - 20} more` : '');
    if (!prune && !dryRun) die(`these live paths would vanish; pass --prune if that is the intent:\n     ${list}`);
    log(`${dryRun ? 'a real run would refuse without --prune' : 'pruning'}:\n     ${list}`);
  }
}

// ------------------------------------------------------------------ deploy

log(`wrangler deploy${dryRun ? ' --dry-run' : ''} from ${relative(repo, cdnDir)}/`);
const run = spawnSync(wrangler, ['deploy', ...(dryRun ? ['--dry-run'] : [])], { cwd: cdnDir, stdio: 'inherit' });
if (run.status !== 0) die(`wrangler exited ${run.status ?? run.signal}`);
if (dryRun) {
  log(`dry run only; ${paths.length} assets plus _headers and ${MANIFEST} staged under ${relative(repo, assets)}/`);
  process.exit(0);
}

// ------------------------------------------------------------------ verify

// Done means the manifest just written reads back from the origin in
// config.mjs, byte for byte. wrangler prints where it deployed above; if
// that is not this origin, nothing here will match and the fix is config.mjs.
let served = null;
for (let attempt = 1; attempt <= 10; attempt++) {
  try {
    const res = await fetch(`${origin}/${MANIFEST}`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (res.status === 200 && (await res.text()) === manifestText) {
      served = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 3000));
}
if (!served) die(`${origin}/${MANIFEST} does not read back what was uploaded; compare wrangler's printed URL with origin in cdn/config.mjs`);

const sample = paths.find((p) => p.startsWith(prefixes[prefixes.length - 1])) ?? paths[0];
const head = await fetch(`${origin}${sample}`, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
const h = (k) => head.headers.get(k) ?? '(none)';
log(`${origin}${sample}: ${head.status} ${h('content-type')}; cache-control ${h('cache-control')}; etag ${head.headers.has('etag') ? 'yes' : 'no'}; cf-cache-status ${h('cf-cache-status')}; cf-ray ${head.headers.has('cf-ray') ? 'yes' : 'no'}`);
if (head.status !== 200) die(`expected 200 on ${sample}`);
log(`${origin} serves ${paths.length} files`);
