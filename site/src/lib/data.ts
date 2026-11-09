// The data layer: a campaign's CSV joined with each run's trials.jsonl, typed,
// and read once per process.
//
// A campaign is one manifest and the CSV its tally writes (CAMPAIGNS below),
// and loadAll() loads one campaign at a time, the first by default. Nothing is
// pooled across campaigns unless a page asks for both: the first campaign's
// story counts its own 2,608 trials and stays that way when a later one lands.
//
// The CSV is the tally (one row per counted trial). What it does not carry is
// joined in from runs/<run>/trials.jsonl by run and step: the model's final
// message and the token counts. The output file of a trial is not preloaded;
// `trial.output` and outputOf() read it from runs/<run>/NNN/ on demand, so
// 2,640 rows do not hold every version of every page in memory.
//
// Plain TypeScript, Node built-ins only (plus the tally's plain-JavaScript line
// counter), and nothing that Node's type stripping cannot erase, so
// scripts/print-stats.mjs can import it without a build step.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMNS } from './columns.ts';

// The tally's line count, so a number the site computes from a file (the
// seed's) agrees with the `lines` column for the same bytes.
export { countLines } from '../../../bin/lines.mjs';

// ------------------------------------------------------------------ models

export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export type Model = (typeof MODELS)[number];

export const MODEL_LABEL: Record<Model, string> = {
  fable: 'Fable 5.1',
  opus: 'Opus 5.5',
  sonnet: 'Sonnet 5',
  haiku: 'Haiku 4.5',
};

export const MODEL_ID: Record<Model, string> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};

// Full ids and the bare aliases the pilot used ("haiku") both resolve.
export function modelOf(id: string): Model {
  for (const m of MODELS) if (id.includes(m)) return m;
  throw new Error(`data: unknown model ${JSON.stringify(id)}`);
}

// ------------------------------------------------------------------- types

// The second campaign's tasks ask for a color in chat, except colorize, which
// hands over the circle's seed and is an artifact task like the first four.
export const COLOR_TASKS = ['hex', 'hex2', 'rgb', 'gradient', 'button', 'background', 'color', 'favorite', 'best'] as const;
export const TASKS = ['circle', 'html', 'svg', 'replica', 'sentence', 'number', 'digit', 'word', ...COLOR_TASKS, 'colorize'] as const;
export type Task = (typeof TASKS)[number];
export const MODES = ['sample', 'chain', 'pilot'] as const;
export type Mode = (typeof MODES)[number];
export type Profile = 'room' | 'harness';

// Tasks whose output is a file the model rewrites, and so has features and a render.
export const ARTIFACT_TASKS: readonly Task[] = ['circle', 'html', 'svg', 'replica', 'colorize'];
export const TEXT_TASKS: readonly Task[] = ['number', 'digit', 'word'];

// Each campaign's manifest at the repo root and its tally under data/. The
// second campaign also reruns the first's svg and html samples for Opus, under
// run names ending in -2: the same task names, a different campaign. The third
// runs four tasks at three effort levels; its low cells end in -3, since the
// first two campaigns already hold the -low names.
//
// `held` names a manifest run that ended short of its n, with the reason. Its
// count comes from the CSV instead of the manifest, which stays the runner's
// record of what was planned; a held run with no counted trials has no Run.
// Every other shortfall still throws.
export const CAMPAIGNS = [
  { id: 1, manifest: 'campaign.tsv', csv: 'trials.csv' },
  { id: 2, manifest: 'campaign-2.tsv', csv: 'campaign-2.csv' },
  {
    id: 3, manifest: 'campaign-3.tsv', csv: 'campaign-3.csv',
    held: {
      'circle-sample-claude-fable-5-1-max': 'A safety classifier moved every attempt to another model, so none counted.',
      'circle-sample-claude-fable-5-1-high': 'Given up once diverted attempts outnumbered counted ones.',
      'circle-sample-claude-opus-5-5-max': 'Stopped by hand after its second diverted attempt.',
    },
  },
] as const;
export type Campaign = (typeof CAMPAIGNS)[number]['id'];

// Where the downloads on /data/ point: one fixed GitHub release, tag `data`,
// re-cut by bin/release-data.sh with every file CAMPAIGNS names. A release
// has no bandwidth cap; a CSV served by Netlify counts against the team's.
// The path never moves, so a link shared today keeps working.
export const DATA_RELEASE = 'https://github.com/centricle/priors/releases/download/data';

export interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  thinking: number;
}

// One CSV row, columns under their own names, plus what the site joins on.
// Empty cells are null: a feature flag on a text task, `turns` on a pilot row.
export interface Trial {
  // identity
  /** Which campaign's CSV the row came from. Not a CSV column. */
  campaign: Campaign;
  run: string;
  task: Task;
  mode: Mode;
  profile: Profile;
  step: number;
  /** The model that answered, resolved from the `model` column. */
  model: Model;
  /** The `model` column verbatim: the full model id. */
  modelId: string;
  model_asked: string;
  effort: string;
  cli_version: string;
  session_id: string;
  started_utc: string;
  // cost and behavior
  wall_s: number | null;
  cost_usd: number | null;
  turns: number | null;
  output_tokens: number | null;
  thinking_blocks: number | null;
  denials: number | null;
  tool_calls: number | null;
  bash_calls: number | null;
  edit_calls: number | null;
  // lineage
  input_sha256: string;
  output_sha256: string;
  from_seed: boolean | null;
  /** Null for the text tasks, which have no file (the same as from_seed). */
  unchanged: boolean | null;
  // the output file
  file: string | null;
  bytes: number | null;
  lines: number | null;
  extra_files: number | null;
  glow_or_shadow: boolean | null;
  glow: boolean | null;
  keyframes: boolean | null;
  radial_gradient: boolean | null;
  linear_gradient: boolean | null;
  pulse: boolean | null;
  gradient_667eea: boolean | null;
  script: boolean | null;
  nondeterministic: boolean | null;
  svg_filter: boolean | null;
  hex_count: number | null;
  /** Distinct hex colors, #rrggbb. Empty for text tasks and for artifacts with none. */
  hex_colors: string[];
  // text answers
  answer_raw: string | null;
  answer_value: string | null;
  answer_form: 'bare' | 'framed' | 'none' | null;
  answer_ok: boolean | null;
  words: number | null;
  /** Sentence task only: words added since the previous step. */
  added: string[] | null;
  removed: string[] | null;
  // the self-report
  result_chars: number;
  mentions_server: boolean;
  // spelling
  color_p_uk: number | null;
  color_p_us: number | null;
  center_p_uk: number | null;
  center_p_us: number | null;
  gray_p_uk: number | null;
  gray_p_us: number | null;
  ize_p_uk: number | null;
  ize_p_us: number | null;
  spell_c_uk: number | null;
  spell_c_us: number | null;
  /** The render is pixel-identical to its input's render (the seed, or the previous chain step). Null without a render. */
  same_picture: boolean | null;
  /** Thinking tokens as the CLI's result reported them, part of output_tokens. Null for the pilot. */
  thinking_tokens: number | null;

  // joined from runs/<run>/trials.jsonl
  /** The model's final message (markdown). Empty when the attempt line is missing. */
  result: string;
  tokens: Tokens | null;
  // derived
  isRelay: boolean;
  hasRender: boolean;
  /** Site-relative, e.g. /r/<run>/001.webp. Wrap with href() before use. */
  renderPath: string | null;
  /** Same file name as `file`; null for tasks that answer in chat. */
  outputFile: string | null;
  /** The output file's text, read on access. Not enumerable, so it never lands in a dump. */
  readonly output: string | null;
}

export interface Run {
  name: string;
  campaign: Campaign;
  task: Task;
  mode: Mode;
  profile: Profile;
  models: Model[];
  isRelay: boolean;
  /** The earlier campaign's run this one repeats (the same name without its -N), else null. */
  rerunOf: string | null;
  /** The reasoning effort every trial of the run was given: low, high or max. */
  effort: string;
  n: number;
  trials: Trial[];
  label: string;
}

/** Claude Code finished the session on another model after a safeguard refusal. */
export interface Fallback {
  original_model: string;
  fallback_model: string;
  /** The classifier's category ("cyber"), when the stream recorded one. */
  category: string | null;
}

// An attempt that did not count: retried after the harness halted on it, or
// after a fallback put another model's work in the room.
export interface Attempt {
  run: string;
  step: number;
  attempt: number;
  /** The model asked, never a fallback's substitute (claude-opus-4-8 is not Opus 5.5). */
  model: Model;
  /** The runner's classification of the attempt ("ok", "fallback"), when it recorded one. */
  class: string | null;
  category: string | null;
  fallback: Fallback | null;
  halt: string | null;
  cost_usd: number | null;
  wall_s: number | null;
  result: string;
}

/** A manifest run that ended short of its n; see `held` in CAMPAIGNS. */
export interface Held {
  name: string;
  task: Task;
  model: Model;
  effort: string;
  planned: number;
  counted: number;
  reason: string;
}

export interface Loaded {
  trials: Trial[];
  runs: Run[];
  runByName: Map<string, Run>;
  uncounted: Attempt[];
  held: Held[];
}

// --------------------------------------------------------------------- csv

// RFC 4180: comma-separated, fields may be quoted, a quoted field may hold
// commas, CR, LF and doubled quotes. Line ends are LF or CRLF.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// --------------------------------------------------------------- formatting

export const pad3 = (n: number): string => String(n).padStart(3, '0');

// Four decimals below a cent, three below ten cents, two above: per-trial costs
// are fractions of a cent and a totals column is dollars. The format is chosen
// after rounding, so a cost that rounds up across a boundary prints in the
// coarser format ($0.0999 is "$0.10", never "$0.100").
export function fmtUsd(n: number): string {
  const a = Math.abs(n);
  let digits = a === 0 ? 2 : a < 0.01 ? 4 : a < 0.1 ? 3 : 2;
  if (digits === 4 && Number(a.toFixed(4)) >= 0.01) digits = 3;
  if (digits === 3 && Number(a.toFixed(3)) >= 0.1) digits = 2;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const fmtPct = (share: number): string => `${Math.round(share * 100)}%`;

/** A whole number with thousands separators, the one spelling the site uses for counts. */
export const fmtInt = (n: number): string => n.toLocaleString('en-US');

/** "1 line", "37 lines", "1,092 lines". Pass `many` when the plural is not just an s. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${fmtInt(n)} ${n === 1 ? one : many}`;

// Rounded to tenths before splitting into minutes, so 59.96 is "1m 00s" and not "60.0s" or "0m 60s".
export function fmtSec(n: number): string {
  if (Math.round(n * 10) / 10 < 60) return `${n.toFixed(1)}s`;
  const whole = Math.round(n);
  const m = Math.floor(whole / 60);
  return `${m}m ${String(whole - m * 60).padStart(2, '0')}s`;
}

// -------------------------------------------------------------------- paths

// Walk up to the directory that holds data/trials.csv. This file sits at
// site/src/lib, so that is three levels up when it runs from source, but Astro
// bundles it into a chunk under dist/ for the build, and a fixed ../../.. would
// land somewhere else there. Starting from this file and then the working
// directory covers dev, build and scripts run from site/.
function findRoot(): string {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let dir = start;
    for (;;) {
      if (existsSync(join(dir, 'data', 'trials.csv')) && existsSync(join(dir, 'campaign.tsv'))) return dir;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  throw new Error('data: could not find the repo root (a directory with data/trials.csv)');
}

let rootDir: string | null = null;
export function repoRoot(): string {
  return (rootDir ??= findRoot());
}

// A bare site path, like renderPath; asset() in href.mjs decides the host.
export const thumbPath = (t: Trial): string | null => (t.renderPath ? t.renderPath.replace(/^\/r\//, '/t/') : null);

// ------------------------------------------------------------ files on disk

function readOutput(run: string, step: number, file: string): string | null {
  const path = join(repoRoot(), 'runs', run, pad3(step), file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** The output file of a trial, or null for tasks that answer in chat. */
export function outputOf(t: Trial): string | null {
  return t.outputFile ? readOutput(t.run, t.step, t.outputFile) : null;
}

/** What the trial started from: the previous step's output in a chain, else the task's seed. */
export function prevOutput(t: Trial): string | null {
  if (!t.outputFile) return null;
  if (t.mode === 'chain' && t.step > 1) return readOutput(t.run, t.step - 1, t.outputFile);
  return seedOf(t.task) || null;
}

const seeds = new Map<Task, string>();
/** The task's seed file text; '' for text tasks, which have none. */
export function seedOf(task: Task): string {
  let s = seeds.get(task);
  if (s === undefined) {
    const dir = join(repoRoot(), 'tasks', task, 'seed');
    const file = existsSync(dir) ? readdirSync(dir).sort()[0] : undefined;
    s = file ? readFileSync(join(dir, file), 'utf8') : '';
    seeds.set(task, s);
  }
  return s;
}

/** The prompt the model was given, trimmed. */
export function promptOf(task: Task): string {
  return readFileSync(join(repoRoot(), 'tasks', task, 'prompt.txt'), 'utf8').trim();
}

// ------------------------------------------------------------------ loading

const oneOf = <T extends string>(list: readonly T[], v: string, what: string): T => {
  if (!(list as readonly string[]).includes(v)) throw new Error(`data: unknown ${what} ${JSON.stringify(v)}`);
  return v as T;
};
const str = (s: string): string | null => (s === '' ? null : s);
const num = (s: string): number | null => (s === '' ? null : Number(s));
const flag = (s: string): boolean | null => (s === '' ? null : s === 'true');
const words = (s: string): string[] => (s === '' ? [] : s.split(' '));

interface JsonlLine {
  run: string;
  step: number;
  attempt: number;
  model_asked: string;
  model_returned: string[] | null;
  counted: boolean;
  wall_s: number | null;
  cost_usd: number | null;
  tokens: Tokens | null;
  result: string | null;
  halt: string | null;
  class?: string | null;
  fallback?: { original_model: string; fallback_model: string; category?: string | null } | null;
}

// What the stream recorded as a fallback, or else a returned model that is not
// the one asked: Opus max step 2 halted as "one trial returned several models"
// with Opus 4.8 among them and no fallback event. The pilot's alias "haiku"
// returning claude-haiku-4-5-20251001 is the same model, not a substitute.
function fallbackOf(l: JsonlLine): Fallback | null {
  if (l.fallback) return { original_model: l.fallback.original_model, fallback_model: l.fallback.fallback_model, category: l.fallback.category ?? null };
  const other = (l.model_returned ?? []).find((m) => !m.includes(l.model_asked));
  return other ? { original_model: l.model_asked, fallback_model: other, category: null } : null;
}

function readJsonl(run: string): JsonlLine[] {
  const path = join(repoRoot(), 'runs', run, 'trials.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as JsonlLine);
}

function renderSet(run: string): Set<string> {
  const dir = join(repoRoot(), 'renders', run);
  return new Set(existsSync(dir) ? readdirSync(dir) : []);
}

// In a campaign that varies effort, the label names the level and not the
// rerun: "svg · sample · Opus 5.5 · low" is the third campaign's run of what
// the first campaign called "svg · sample · Opus 5.5", and the second
// campaign's "· rerun" keeps its own label. Labels stay unique across
// campaigns, which allRuns() checks.
function labelOf(r: Omit<Run, 'label'>, showEffort: boolean): string {
  const who = r.isRelay ? 'relay' : r.models.map((m) => MODEL_LABEL[m]).join(' + ');
  const parts: string[] = [r.task, r.mode, who];
  if (r.profile !== 'room') parts.push(r.profile);
  if (showEffort) parts.push(r.effort);
  else if (r.rerunOf) parts.push('rerun');
  return parts.join(' · ');
}

// A later campaign repeats an earlier run under that run's name plus -N.
function rerunOf(name: string, campaign: Campaign): string | null {
  const earlier = /^(.*)-\d+$/.exec(name)?.[1];
  if (!earlier) return null;
  return CAMPAIGNS.some((c) => c.id < campaign && loadAll(c.id).runByName.has(earlier)) ? earlier : null;
}

const cache = new Map<Campaign, Loaded>();

/** Parse and join one campaign once per process; every later call is a lookup. */
export function loadAll(campaign: Campaign = 1): Loaded {
  const hit = cache.get(campaign);
  if (hit) return hit;
  const root = repoRoot();
  const spec = CAMPAIGNS.find((c) => c.id === campaign)!;
  const { manifest, csv } = spec;
  const heldReasons: Record<string, string> = 'held' in spec ? spec.held : {};

  const table = parseCsv(readFileSync(join(root, 'data', csv), 'utf8')).filter((r) => !(r.length === 1 && r[0] === ''));
  const header = table[0];
  const expected = COLUMNS.map((c) => c.name);
  if (header.length !== expected.length || header.some((h, i) => h !== expected[i])) {
    throw new Error(`data: ${csv} header differs from src/lib/columns.ts; update the glossary and the Trial type`);
  }

  // Runs in campaign order, then whatever else the CSV holds (the pilot). The
  // first two manifests have no effort column; every run in them is low.
  const planned = new Map<string, { task: string; models: string; n: number; effort: string }>();
  for (const line of readFileSync(join(root, manifest), 'utf8').split('\n').slice(1).filter(Boolean)) {
    const [name, task, , models, n, , effort] = line.split('\t');
    planned.set(name, { task, models, n: Number(n), effort: effort ?? 'low' });
  }
  for (const name of Object.keys(heldReasons)) {
    if (!planned.has(name)) throw new Error(`data: CAMPAIGNS holds ${name}, which ${manifest} does not list`);
  }
  const showEffort = new Set([...planned.values()].map((p) => p.effort)).size > 1;

  // Every attempt of every run, the manifest's included: a held run can have
  // fallbacks and no counted trial at all.
  const jsonl = new Map<string, JsonlLine>();
  const uncounted: Attempt[] = [];
  const renders = new Map<string, Set<string>>();
  const seenRuns = new Set<string>();
  for (const cells of table.slice(1)) seenRuns.add(cells[0]);
  for (const run of [...seenRuns, ...[...planned.keys()].filter((k) => !seenRuns.has(k))]) {
    for (const l of readJsonl(run)) {
      if (l.counted) jsonl.set(`${run}|${l.step}`, l);
      else {
        const fallback = fallbackOf(l);
        uncounted.push({
          run, step: l.step, attempt: l.attempt, model: modelOf(l.model_asked),
          class: l.class ?? null, category: fallback?.category ?? null, fallback,
          halt: l.halt ?? null, cost_usd: l.cost_usd ?? null, wall_s: l.wall_s ?? null, result: l.result ?? '',
        });
      }
    }
    renders.set(run, renderSet(run));
  }

  const trials: Trial[] = table.slice(1).map((cells) => {
    const r: Record<string, string> = {};
    header.forEach((h, i) => { r[h] = cells[i] ?? ''; });
    const task = oneOf(TASKS, r.task, 'task');
    const step = Number(r.step);
    const j = jsonl.get(`${r.run}|${step}`);
    const isArtifact = ARTIFACT_TASKS.includes(task);
    const hasRender = isArtifact && (renders.get(r.run)?.has(`${pad3(step)}.webp`) ?? false);
    const base: Omit<Trial, 'output'> = {
      campaign, run: r.run, task, mode: oneOf(MODES, r.mode, 'mode'), profile: oneOf(['room', 'harness'] as const, r.profile, 'profile'),
      step, model: modelOf(r.model), modelId: r.model, model_asked: r.model_asked, effort: r.effort,
      cli_version: r.cli_version, session_id: r.session_id, started_utc: r.started_utc,
      wall_s: num(r.wall_s), cost_usd: num(r.cost_usd), turns: num(r.turns), output_tokens: num(r.output_tokens),
      thinking_blocks: num(r.thinking_blocks), denials: num(r.denials), tool_calls: num(r.tool_calls),
      bash_calls: num(r.bash_calls), edit_calls: num(r.edit_calls),
      input_sha256: r.input_sha256, output_sha256: r.output_sha256, from_seed: flag(r.from_seed), unchanged: flag(r.unchanged),
      file: str(r.file), bytes: num(r.bytes), lines: num(r.lines), extra_files: num(r.extra_files),
      glow_or_shadow: flag(r.glow_or_shadow), glow: flag(r.glow), keyframes: flag(r.keyframes),
      radial_gradient: flag(r.radial_gradient), linear_gradient: flag(r.linear_gradient), pulse: flag(r.pulse),
      gradient_667eea: flag(r.gradient_667eea), script: flag(r.script), nondeterministic: flag(r.nondeterministic),
      svg_filter: flag(r.svg_filter), hex_count: num(r.hex_count), hex_colors: words(r.hex_colors),
      answer_raw: str(r.answer_raw), answer_value: str(r.answer_value),
      answer_form: r.answer_form === '' ? null : oneOf(['bare', 'framed', 'none'] as const, r.answer_form, 'answer_form'),
      answer_ok: flag(r.answer_ok), words: num(r.words),
      added: task === 'sentence' ? words(r.added) : null, removed: task === 'sentence' ? words(r.removed) : null,
      result_chars: Number(r.result_chars), mentions_server: r.mentions_server === 'true',
      color_p_uk: num(r.color_p_uk), color_p_us: num(r.color_p_us), center_p_uk: num(r.center_p_uk), center_p_us: num(r.center_p_us),
      gray_p_uk: num(r.gray_p_uk), gray_p_us: num(r.gray_p_us), ize_p_uk: num(r.ize_p_uk), ize_p_us: num(r.ize_p_us),
      spell_c_uk: num(r.spell_c_uk), spell_c_us: num(r.spell_c_us), same_picture: flag(r.same_picture),
      thinking_tokens: num(r.thinking_tokens),
      result: j?.result ?? '', tokens: j?.tokens ?? null,
      isRelay: r.run.includes('relay'), hasRender,
      // A bare site path; asset() in href.mjs decides the host.
      renderPath: hasRender ? `/r/${r.run}/${pad3(step)}.webp` : null,
      outputFile: str(r.file),
    };
    const trial = base as Trial;
    Object.defineProperty(trial, 'output', { get: () => outputOf(trial), enumerable: false });
    return trial;
  });

  const byRun = new Map<string, Trial[]>();
  for (const t of trials) {
    const rows = byRun.get(t.run);
    if (rows) rows.push(t);
    else byRun.set(t.run, [t]);
  }
  const names = [...planned.keys(), ...[...byRun.keys()].filter((k) => !planned.has(k))];
  const runs: Run[] = [];
  const held: Held[] = [];
  for (const name of names) {
    const rows = byRun.get(name) ?? [];
    const plan = planned.get(name);
    if (plan && name in heldReasons) {
      if (rows.length >= plan.n) throw new Error(`data: ${name} is held but has all ${plan.n} rows; drop it from CAMPAIGNS`);
      held.push({ name, task: oneOf(TASKS, plan.task, 'task'), model: modelOf(plan.models), effort: plan.effort,
        planned: plan.n, counted: rows.length, reason: heldReasons[name] });
      if (!rows.length) continue;
    } else {
      if (!rows.length) throw new Error(`data: ${manifest} lists ${name} but ${csv} has no rows for it`);
      if (plan && plan.n !== rows.length) throw new Error(`data: ${name} has ${rows.length} rows, ${manifest} says ${plan.n}`);
    }
    rows.sort((a, b) => a.step - b.step);
    const head = rows[0];
    if (rows.some((t) => t.effort !== head.effort)) throw new Error(`data: ${name} mixes effort levels`);
    const parts = { name, campaign, task: head.task, mode: head.mode, profile: head.profile, isRelay: head.isRelay,
      rerunOf: rerunOf(name, campaign), effort: head.effort, n: rows.length, trials: rows,
      models: MODELS.filter((m) => rows.some((t) => t.model === m)) };
    runs.push({ ...parts, label: labelOf(parts, showEffort) });
  }

  const loaded = { trials, runs, runByName: new Map(runs.map((r) => [r.name, r])), uncounted, held };
  cache.set(campaign, loaded);
  return loaded;
}

// A run's label is its page title and every trial's title is the label plus a
// number, so two runs with one label would give two pages one title.
let labelsChecked = false;

/** Every campaign's runs, in campaign order. Run names and labels are unique across campaigns. */
export function allRuns(): Run[] {
  const runs = CAMPAIGNS.flatMap((c) => loadAll(c.id).runs);
  if (!labelsChecked) {
    const seen = new Map<string, string>();
    for (const r of runs) {
      const other = seen.get(r.label);
      if (other) throw new Error(`data: ${other} and ${r.name} share the label ${JSON.stringify(r.label)}`);
      seen.set(r.label, r.name);
    }
    labelsChecked = true;
  }
  return runs;
}

const ORDINAL: Record<Campaign, string> = { 1: 'first', 2: 'second', 3: 'third' };
export const campaignOrdinal = (c: Campaign): string => ORDINAL[c];

/** How a rerun relates to the run it repeats, from the two runs' first start times. */
export interface RerunGap {
  of: Run;
  /** "a week later", "6 weeks later". */
  later: string;
  /** The second campaign reran two runs as a control; the third's low cells are its baseline. */
  control: boolean;
  /** Both runs used one CLI version. */
  sameCli: boolean;
}

export function rerunGap(run: Run): RerunGap | null {
  if (!run.rerunOf) return null;
  const of = runNamed(run.rerunOf)!;
  const start = (r: Run) => Math.min(...r.trials.map((t) => Date.parse(t.started_utc)));
  const weeks = Math.round((start(run) - start(of)) / (7 * 86_400_000));
  const cli = (r: Run) => [...new Set(r.trials.map((t) => t.cli_version))].join();
  return {
    of, later: weeks <= 1 ? 'a week later' : `${weeks} weeks later`,
    control: run.campaign === 2, sameCli: cli(run) === cli(of),
  };
}

/** A run by name, whichever campaign it belongs to. */
export function runNamed(name: string): Run | undefined {
  for (const c of CAMPAIGNS) {
    const run = loadAll(c.id).runByName.get(name);
    if (run) return run;
  }
  return undefined;
}

// ------------------------------------------------------------- predicates

export const isArtifact = (t: Trial): boolean => ARTIFACT_TASKS.includes(t.task);
/** A task that asks for a color in chat (the second campaign's, colorize aside). */
export const isColorTask = (task: Task): boolean => (COLOR_TASKS as readonly string[]).includes(task);
/** The pilot ran before the first campaign and is not part of its 2,608 trials. */
export const isCampaign = (t: Trial): boolean => t.mode !== 'pilot';
