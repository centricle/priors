#!/usr/bin/env node
/**
 * Stage the files the site serves but does not own, before `astro dev` and
 * `astro build`. Everything here is generated from the repo root and safe to
 * delete: a rerun rebuilds it. All of it is gitignored under site/public/
 * except the two cards, for the reason given at the bottom.
 *
 *   ../renders/<run>/NNN.webp  ->  public/r/<run>/NNN.webp   copied as is (800x800)
 *                              ->  public/t/<run>/NNN.webp   200x200 thumbnail
 *   ../data/trials.csv         ->  public/trials.csv         the download on /data/
 *   ../data/campaign-2.csv     ->  public/campaign-2.csv     the second campaign's
 *   (drawn here)               ->  public/og.png             1200x630 social card
 *   (drawn here)               ->  public/og-color.png       the same, for /color/
 *
 * Idempotent: a file is skipped when its output exists and is at least as new
 * as its source, so a second run does no image work.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const started = performance.now();
const here = fileURLToPath(import.meta.url);
const site = join(dirname(here), '..');
const repo = join(site, '..');
const pub = join(site, 'public');

const THUMB = { size: 200, quality: 72 };
const CONCURRENCY = 8;

// Up to date: the output exists and is not older than the newest input.
const fresh = (out, ...inputs) => existsSync(out) && inputs.every((i) => statSync(out).mtimeMs >= statSync(i).mtimeMs);

async function pool(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ------------------------------------------------------------------ renders

const rendersDir = join(repo, 'renders');
if (!existsSync(rendersDir)) {
  console.error('prebuild: ../renders does not exist; nothing to serve');
  process.exit(1);
}

const jobs = [];
for (const run of readdirSync(rendersDir, { withFileTypes: true })) {
  if (!run.isDirectory()) continue;
  for (const file of readdirSync(join(rendersDir, run.name))) {
    if (!file.endsWith('.webp')) continue;
    jobs.push({
      src: join(rendersDir, run.name, file),
      full: join(pub, 'r', run.name, file),
      thumb: join(pub, 't', run.name, file),
    });
  }
}

let copied = 0;
let thumbs = 0;
let skipped = 0;

await pool(jobs, CONCURRENCY, async (job) => {
  if (fresh(job.full, job.src)) skipped++;
  else {
    mkdirSync(dirname(job.full), { recursive: true });
    copyFileSync(job.src, job.full);
    copied++;
  }
  if (fresh(job.thumb, job.src)) skipped++;
  else {
    mkdirSync(dirname(job.thumb), { recursive: true });
    await sharp(job.src).resize(THUMB.size, THUMB.size).webp({ quality: THUMB.quality }).toFile(job.thumb);
    thumbs++;
  }
});

// ---------------------------------------------------------------------- csv

// One file per campaign, each its own download on /data/.
let csv = 'kept';
for (const name of ['trials.csv', 'campaign-2.csv']) {
  const csvSrc = join(repo, 'data', name);
  const csvOut = join(pub, name);
  if (!fresh(csvOut, csvSrc)) {
    mkdirSync(pub, { recursive: true });
    copyFileSync(csvSrc, csvOut);
    csv = 'copied';
  }
}

// ---------------------------------------------------------------- og images

// One card per campaign: og.png for the story, og-color.png for /color/. The
// trial count on each is the sum of its manifest's planned runs, so it follows
// the TSV instead of being typed here. A card is drawn again when this script
// or its manifest is newer than the image. Unlike the renders and CSVs, the
// cards are tracked: they are drawn with this machine's fonts, which the
// deploy's build box does not have.
//
// So the build box never draws one. A fresh clone gives every file the
// checkout's mtime, which makes "is the card older than the script" a race
// there, and the loser is redrawn in DejaVu Sans: that is how production
// served the two cards in two typefaces on 2026-10-09. Netlify sets
// NETLIFY=true; a card missing there is a commit error, not a reason to draw.
const CARDS = [
  { manifest: 'campaign.tsv', out: 'og.png', lines: ['Give a model a black circle.', 'Say improve. {n} times.'] },
  { manifest: 'campaign-2.tsv', out: 'og-color.png', lines: ['Ask a model for a color.', 'Do it {n} times.'] },
];

const plannedTrials = (manifest) =>
  readFileSync(manifest, 'utf8')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .reduce((sum, line) => sum + Number(line.split('\t')[4]), 0);

const buildBox = Boolean(process.env.NETLIFY);
let og = buildBox ? 'kept (build box)' : 'kept';
for (const card of CARDS) {
  const manifest = join(repo, card.manifest);
  const out = join(pub, card.out);
  if (buildBox) {
    if (!existsSync(out)) throw new Error(`prebuild: ${card.out} is not committed; draw it locally and commit it`);
    continue;
  }
  if (fresh(out, here, manifest)) continue;
  const n = plannedTrials(manifest).toLocaleString('en-US');
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
console.log(`prebuild: copied ${copied}, thumbs ${thumbs}, skipped ${skipped}, csv ${csv}, og ${og}, ${secs}s`);
