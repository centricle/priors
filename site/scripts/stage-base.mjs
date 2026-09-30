#!/usr/bin/env node
/**
 * Move the build under its base path.
 *
 * Astro's `base` prefixes every URL it emits, but it still writes a flat
 * `dist/`, so the HTML asks the CDN for `/curios/priors/_astro/app.css`
 * while the file sits at `/_astro/app.css`, and every asset 404s. Nothing warns
 * you; the page loads completely unstyled.
 *
 * The prefix has to exist in the directory layout because the CDN matches on
 * request path, and the proxy in front of this site preserves the path.
 *
 * Idempotent: re-running on an already-staged dist is a no-op.
 */
import { readdirSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../astro.config.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, '..', 'dist');

// One source of truth: the same value Astro built against.
const base = (config.base ?? '').replace(/^\/+|\/+$/g, '');
if (!base) {
  console.log('stage-base: no base configured, nothing to do');
  process.exit(0);
}

const target = join(dist, base);
const first = base.split('/')[0];

if (!existsSync(dist)) {
  console.error('stage-base: dist/ does not exist; run astro build first');
  process.exit(1);
}

const entries = readdirSync(dist).filter((e) => e !== first);
if (entries.length === 0) {
  console.log(`stage-base: already staged under ${base}/`);
  process.exit(0);
}

mkdirSync(target, { recursive: true });
for (const entry of entries) {
  renameSync(join(dist, entry), join(target, entry));
}

console.log(`stage-base: moved ${entries.length} entries into dist/${base}/`);
