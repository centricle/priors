// The data layer: data/trials.csv joined with each run's trials.jsonl, typed,
// and read once per process.
//
// The CSV is the tally (one row per counted trial). What it does not carry is
// joined in from runs/<run>/trials.jsonl by run and step: the model's final
// message and the token counts. The output file of a trial is not preloaded;
// `trial.output` and outputOf() read it from runs/<run>/NNN/ on demand, so
// 2,640 rows do not hold every version of every page in memory.
//
// Plain TypeScript, Node built-ins only, and nothing that Node's type stripping
// cannot erase, so scripts/print-stats.mjs can import it without a build step.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMNS } from './columns.ts';

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

export const TASKS = ['circle', 'html', 'svg', 'replica', 'sentence', 'number', 'digit', 'word'] as const;
export type Task = (typeof TASKS)[number];
export const MODES = ['sample', 'chain', 'pilot'] as const;
export type Mode = (typeof MODES)[number];
export type Profile = 'room' | 'harness';

// Tasks whose output is a file the model rewrites, and so has features and a render.
export const ARTIFACT_TASKS: readonly Task[] = ['circle', 'html', 'svg', 'replica'];
export const TEXT_TASKS: readonly Task[] = ['number', 'digit', 'word'];

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
  unchanged: boolean;
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
  task: Task;
  mode: Mode;
  profile: Profile;
  models: Model[];
  isRelay: boolean;
  n: number;
  trials: Trial[];
  label: string;
}

// An attempt that did not count: retried after the harness halted on it.
export interface Attempt {
  run: string;
  step: number;
  attempt: number;
  model: Model;
  halt: string | null;
  cost_usd: number | null;
  wall_s: number | null;
  result: string;
}

export interface Loaded {
  trials: Trial[];
  runs: Run[];
  runByName: Map<string, Run>;
  uncounted: Attempt[];
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

// Two decimals, three below ten cents: per-trial costs are fractions of a cent.
export function fmtUsd(n: number): string {
  const digits = Math.abs(n) < 0.1 ? 3 : 2;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const fmtPct = (share: number): string => `${Math.round(share * 100)}%`;

export function fmtSec(n: number): string {
  if (n < 60) return `${n.toFixed(1)}s`;
  const m = Math.floor(n / 60);
  return `${m}m ${String(Math.round(n - m * 60)).padStart(2, '0')}s`;
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

function labelOf(r: Omit<Run, 'label'>): string {
  const who = r.isRelay ? 'relay' : r.models.map((m) => MODEL_LABEL[m]).join(' + ');
  const parts: string[] = [r.task, r.mode, who];
  if (r.profile !== 'room') parts.push(r.profile);
  return parts.join(' · ');
}

let cache: Loaded | null = null;

/** Parse and join everything once per process; every later call is a lookup. */
export function loadAll(): Loaded {
  if (cache) return cache;
  const root = repoRoot();

  const table = parseCsv(readFileSync(join(root, 'data', 'trials.csv'), 'utf8')).filter((r) => !(r.length === 1 && r[0] === ''));
  const header = table[0];
  const expected = COLUMNS.map((c) => c.name);
  if (header.length !== expected.length || header.some((h, i) => h !== expected[i])) {
    throw new Error('data: trials.csv header differs from src/lib/columns.ts; update the glossary and the Trial type');
  }

  // Runs in campaign order, then whatever else the CSV holds (the pilot).
  const planned = new Map<string, number>();
  for (const line of readFileSync(join(root, 'campaign.tsv'), 'utf8').split('\n').slice(1).filter(Boolean)) {
    const [name, , , , n] = line.split('\t');
    planned.set(name, Number(n));
  }

  const jsonl = new Map<string, JsonlLine>();
  const uncounted: Attempt[] = [];
  const renders = new Map<string, Set<string>>();
  const seenRuns = new Set<string>();
  for (const cells of table.slice(1)) seenRuns.add(cells[0]);
  for (const run of seenRuns) {
    for (const l of readJsonl(run)) {
      if (l.counted) jsonl.set(`${run}|${l.step}`, l);
      else {
        uncounted.push({
          run, step: l.step, attempt: l.attempt, model: modelOf(l.model_returned?.[0] ?? l.model_asked),
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
      run: r.run, task, mode: oneOf(MODES, r.mode, 'mode'), profile: oneOf(['room', 'harness'] as const, r.profile, 'profile'),
      step, model: modelOf(r.model), modelId: r.model, model_asked: r.model_asked, effort: r.effort,
      cli_version: r.cli_version, session_id: r.session_id, started_utc: r.started_utc,
      wall_s: num(r.wall_s), cost_usd: num(r.cost_usd), turns: num(r.turns), output_tokens: num(r.output_tokens),
      thinking_blocks: num(r.thinking_blocks), denials: num(r.denials), tool_calls: num(r.tool_calls),
      bash_calls: num(r.bash_calls), edit_calls: num(r.edit_calls),
      input_sha256: r.input_sha256, output_sha256: r.output_sha256, from_seed: flag(r.from_seed), unchanged: r.unchanged === 'true',
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
      spell_c_uk: num(r.spell_c_uk), spell_c_us: num(r.spell_c_us),
      result: j?.result ?? '', tokens: j?.tokens ?? null,
      isRelay: r.run.includes('relay'), hasRender,
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
  for (const name of names) {
    const rows = byRun.get(name);
    if (!rows) throw new Error(`data: campaign.tsv lists ${name} but trials.csv has no rows for it`);
    if (planned.has(name) && planned.get(name) !== rows.length) {
      throw new Error(`data: ${name} has ${rows.length} rows, campaign.tsv says ${planned.get(name)}`);
    }
    rows.sort((a, b) => a.step - b.step);
    const head = rows[0];
    const parts = { name, task: head.task, mode: head.mode, profile: head.profile, isRelay: head.isRelay, n: rows.length, trials: rows,
      models: MODELS.filter((m) => rows.some((t) => t.model === m)) };
    runs.push({ ...parts, label: labelOf(parts) });
  }

  cache = { trials, runs, runByName: new Map(runs.map((r) => [r.name, r])), uncounted };
  return cache;
}

// ------------------------------------------------------------- predicates

export const isArtifact = (t: Trial): boolean => ARTIFACT_TASKS.includes(t.task);
/** The pilot ran before the campaign and is not part of its 2,608 trials. */
export const isCampaign = (t: Trial): boolean => t.mode !== 'pilot';
