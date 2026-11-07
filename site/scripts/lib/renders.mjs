/**
 * Mirror ../renders into a directory the site can serve, as two trees:
 *
 *   <renders>/<run>/NNN.webp  ->  <out>/r/<run>/NNN.webp   copied as is (800x800)
 *                             ->  <out>/t/<run>/NNN.webp   200x200 thumbnail
 *
 * Two callers, two outputs. `prebuild.mjs --dev` stages into public/ so the
 * dev server serves the images itself; `cdn.mjs` stages into cdn/assets/ for
 * the Worker that serves them in production. Neither mirrors the other's
 * output, because public/ may be empty or stale and a Worker deploy replaces
 * its whole manifest at once: a partial tree there deletes images production
 * is serving.
 *
 * Idempotent: a file is skipped when its output exists and is at least as new
 * as its source, so a second run does no image work. A faithful mirror: an
 * output whose source is gone is removed, so a run deleted from renders/
 * disappears from the staging tree instead of lingering as a stale copy.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

// Changing either value rewrites every thumb at the same path on the next
// run, which is one reason the Worker's Cache-Control is not `immutable`.
export const THUMB = { size: 200, quality: 72 };
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

/** Every render on disk, as the pair of outputs it should have under `out`. */
export function listRenders(rendersDir, out) {
  const jobs = [];
  for (const run of readdirSync(rendersDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!run.isDirectory()) continue;
    for (const file of readdirSync(join(rendersDir, run.name)).sort()) {
      if (!file.endsWith('.webp')) continue;
      jobs.push({
        rel: `${run.name}/${file}`,
        src: join(rendersDir, run.name, file),
        full: join(out, 'r', run.name, file),
        thumb: join(out, 't', run.name, file),
      });
    }
  }
  return jobs;
}

// Files under <out>/r and <out>/t that no render produces, and the directories
// left empty once they go.
function stale(out, jobs) {
  const wanted = new Set(jobs.flatMap((j) => [j.full, j.thumb]));
  const gone = [];
  for (const tree of ['r', 't']) {
    const dir = join(out, tree);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      if (!wanted.has(path)) gone.push(path);
    }
  }
  return gone;
}

/**
 * Stage every render under `out`. Returns the counts a caller can log.
 * Throws if `rendersDir` does not exist: a site with nothing to serve is an
 * error, not an empty deploy.
 */
export async function stageRenders(rendersDir, out) {
  if (!existsSync(rendersDir)) throw new Error(`renders: ${rendersDir} does not exist; nothing to serve`);
  const jobs = listRenders(rendersDir, out);
  if (jobs.length === 0) throw new Error(`renders: ${rendersDir} holds no .webp; nothing to serve`);

  const n = { copied: 0, thumbs: 0, skipped: 0, removed: 0, files: jobs.length * 2 };
  await pool(jobs, CONCURRENCY, async (job) => {
    if (fresh(job.full, job.src)) n.skipped++;
    else {
      mkdirSync(dirname(job.full), { recursive: true });
      copyFileSync(job.src, job.full);
      n.copied++;
    }
    if (fresh(job.thumb, job.src)) n.skipped++;
    else {
      mkdirSync(dirname(job.thumb), { recursive: true });
      await sharp(job.src).resize(THUMB.size, THUMB.size).webp({ quality: THUMB.quality }).toFile(job.thumb);
      n.thumbs++;
    }
  });

  for (const path of stale(out, jobs)) {
    rmSync(path, { force: true });
    n.removed++;
    const dir = dirname(path);
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  }
  return n;
}
