#!/usr/bin/env node
/**
 * Stage the files the site serves but does not own, before `astro dev` and
 * `astro build`. Everything here is generated from the repo root and safe to
 * delete: a rerun rebuilds it. All of it is gitignored under site/public/
 * except the two cards, for the reason given at the bottom.
 *
 *   prebuild.mjs --dev     the dev server serves the renders itself:
 *     ../renders/<run>/NNN.webp  ->  public/r/<run>/NNN.webp   copied as is (800x800)
 *                                ->  public/t/<run>/NNN.webp   200x200 thumbnail
 *   prebuild.mjs --build   production serves them from a Cloudflare Worker
 *     (cdn/config.mjs, `npm run cdn`), so public/r, public/t and any CSV
 *     left under public/ are removed before Astro copies public/ into dist.
 *     The HTML points at the Worker through `asset()` in src/lib/href.mjs;
 *     scripts/check-assets.mjs proves after the build that every path it
 *     references is there.
 *   both:
 *     (drawn here)               ->  public/og.png             1200x630 social card
 *     (drawn here)               ->  public/og-color.png       the same, for /color/
 *
 * The mode is the npm hook's to pass (`prebuild` and `predev` in
 * package.json), so every `npm run build` is production-shaped with nothing
 * exported first, and `npm run dev` stays local. Running --build deletes the
 * dev images; the next --dev regenerates them, about a minute of sharp.
 *
 * The CSV downloads on /data/ come from a GitHub release (bin/release-data.sh)
 * and are no longer copied here.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { stageRenders } from './lib/renders.mjs';

const started = performance.now();
const here = fileURLToPath(import.meta.url);
const site = join(dirname(here), '..');
const repo = join(site, '..');
const pub = join(site, 'public');

const mode = process.argv[2];
if (mode !== '--dev' && mode !== '--build') {
  console.error('usage: prebuild.mjs --dev | --build');
  process.exit(2);
}

// Up to date: the output exists and is not older than the newest input.
const fresh = (out, ...inputs) => existsSync(out) && inputs.every((i) => statSync(out).mtimeMs >= statSync(i).mtimeMs);

// ------------------------------------------------------------------ renders

let renders;
if (mode === '--dev') {
  const n = await stageRenders(join(repo, 'renders'), pub);
  renders = `copied ${n.copied}, thumbs ${n.thumbs}, skipped ${n.skipped}${n.removed ? `, removed ${n.removed}` : ''}`;
} else {
  // Astro copies public/ whole into dist, so anything staged for dev would
  // ship as a second copy of what the Worker serves. Nothing here is tracked.
  let removed = 0;
  for (const dir of ['r', 't']) {
    if (!existsSync(join(pub, dir))) continue;
    rmSync(join(pub, dir), { recursive: true, force: true });
    removed++;
  }
  for (const file of existsSync(pub) ? readdirSync(pub) : []) {
    if (!file.endsWith('.csv')) continue;
    rmSync(join(pub, file), { force: true });
    removed++;
  }
  renders = removed ? `removed ${removed} dev entries from public/` : 'public/ already clean';
}

// ---------------------------------------------------------------- og images

// One card per campaign: og.png for the story, og-color.png for /color/,
// og-effort.png for /effort/. The trial count on each is the counted trials of
// its manifest's runs, the CSV's rows less the pilot's, so it follows the data
// instead of being typed here. Not the manifest's n: that is what was planned,
// and three of the third campaign's runs counted fewer. A card is drawn again
// when this script, its manifest or its CSV is newer than the image. Unlike the renders, the cards are
// tracked: they are drawn with this machine's fonts, which the deploy's build
// box does not have.
//
// So the build box never draws one. A fresh clone gives every file the
// checkout's mtime, which makes "is the card older than the script" a race
// there, and the loser is redrawn in DejaVu Sans: that is how production
// served the two cards in two typefaces on 2026-10-09. Netlify sets
// NETLIFY=true; a card missing there is a commit error, not a reason to draw.
const CARDS = [
  { manifest: 'campaign.tsv', csv: 'trials.csv', out: 'og.png', lines: ['Give a model a black circle.', 'Say improve. {n} times.'] },
  { manifest: 'campaign-2.tsv', csv: 'campaign-2.csv', out: 'og-color.png', lines: ['Ask a model for a color.', 'Do it {n} times.'] },
  { manifest: 'campaign-3.tsv', csv: 'campaign-3.csv', out: 'og-effort.png', lines: ['Turn the effort up.', 'Ask again. {n} times.'] },
];

// Imported only when a card is drawn, which never happens on the build box.
const countedTrials = async (manifest, csv) => {
  const { parseCsv } = await import('../src/lib/data.ts');
  const runs = new Set(readFileSync(manifest, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => l.split('\t')[0]));
  return parseCsv(readFileSync(csv, 'utf8')).slice(1).filter((row) => runs.has(row[0])).length;
};

const buildBox = Boolean(process.env.NETLIFY);
let og = buildBox ? 'kept (build box)' : 'kept';
for (const card of CARDS) {
  const manifest = join(repo, card.manifest);
  const csv = join(repo, 'data', card.csv);
  const out = join(pub, card.out);
  if (buildBox) {
    if (!existsSync(out)) throw new Error(`prebuild: ${card.out} is not committed; draw it locally and commit it`);
    continue;
  }
  if (fresh(out, here, manifest, csv)) continue;
  const n = (await countedTrials(manifest, csv)).toLocaleString('en-US');
  const [one, two] = card.lines.map((l) => l.replace('{n}', n));
  const font = 'Helvetica Neue, Helvetica, Arial, sans-serif';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#ffffff"/>
  <circle cx="300" cy="315" r="200" fill="#000000"/>
  <text x="620" y="300" font-family="${font}" font-size="96" font-weight="800" letter-spacing="-3.84" fill="#0a0a0a">priors</text>
  <text font-family="${font}" font-size="30" font-weight="400" fill="#0a0a0a">
    <tspan x="620" y="360">${one}</tspan>
    <tspan x="620" y="400">${two}</tspan>
  </text>
  <rect x="620" y="428" width="120" height="14" fill="#d9ff3a"/>
</svg>`;
  mkdirSync(pub, { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(out);
  og = 'drawn';
}

const secs = ((performance.now() - started) / 1000).toFixed(1);
console.log(`prebuild ${mode.slice(2)}: ${renders}, og ${og}, ${secs}s`);
