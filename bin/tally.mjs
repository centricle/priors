// tally.mjs [--campaign FILE] [--summary] [--check]: every counted trial of one
// campaign as one row of a CSV.
//
// A tally covers the runs its manifest lists. campaign.tsv is the default and
// writes data/trials.csv, the published dataset the site builds from; it also
// takes runs/pilot-import, which no manifest lists. Any other manifest writes
// data/<its name>.csv, so a later campaign never changes the first one's file:
// the site refuses a task it does not know, and its counts are of 2,608 trials.
//
// runs/*/trials.jsonl is the source of truth; this file is generated from it
// plus each trial's room (runs/<run>/NNN/) and transcript (NNN.jsonl), so it
// can always be rebuilt and never needs hand edits. Uncounted attempts stay in
// trials.jsonl only. same_picture also reads renders/<run>/NNN.webp, so run
// bin/render.sh before the tally for new trials; a trial without a render gets
// an empty cell.
//
// The column set is frozen: COLUMNS below is the whole contract. Add a column
// at the end if one is needed; never rename, reorder or repurpose one, since
// the site and any downstream reader address columns by name.
//
// Features are regexes over the trial's output file, chosen so that the pilot
// reproduces the counts first taken by hand (glow or shadow 30, @keyframes 25,
// radial gradient 23, "pulse" 21, #667eea gradient 18, unchanged 2, mentions a
// server 14, all of 32). --check asserts exactly that and exits 1 otherwise.
//
//   --campaign FILE  the manifest whose runs to tally (default campaign.tsv)
//   --summary        print the comparison tables after writing the CSV
//   --check          only verify the seed hashes and the input renders, and for
//                    campaign.tsv the pilot acceptance counts
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, lstatSync, readlinkSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { FAMILIES, stripCode, count as spellCount, transcript } from './spelling.mjs';
import { countLines } from './lines.mjs';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const RUNS = join(REPO, 'runs');
const RENDERS = join(REPO, 'renders');
const FIRST = join(REPO, 'campaign.tsv');
const outOf = (manifest) => join(REPO, 'data', manifest === FIRST ? 'trials.csv' : `${basename(manifest, '.tsv')}.csv`);

export const COLUMNS = [
  // identity
  'run', 'task', 'mode', 'profile', 'step', 'model', 'model_asked', 'effort', 'cli_version',
  'session_id', 'started_utc',
  // cost and behavior
  'wall_s', 'cost_usd', 'turns', 'output_tokens', 'thinking_blocks', 'denials',
  'tool_calls', 'bash_calls', 'edit_calls',
  // lineage
  'input_sha256', 'output_sha256', 'from_seed', 'unchanged',
  // the output file (html, svg, circle, replica, sentence)
  'file', 'bytes', 'lines', 'extra_files',
  'glow_or_shadow', 'glow', 'keyframes', 'radial_gradient', 'linear_gradient', 'pulse',
  'gradient_667eea', 'script', 'nondeterministic', 'svg_filter', 'hex_count', 'hex_colors',
  // answers: number, digit, word, sentence, and the second campaign's color tasks
  'answer_raw', 'answer_value', 'answer_form', 'answer_ok', 'words', 'added', 'removed',
  // the self-report (stdout)
  'result_chars', 'mentions_server',
  // spelling: prose counts per family, then code totals (null without a transcript)
  ...Object.keys(FAMILIES).flatMap((f) => [`${f}_p_uk`, `${f}_p_us`]), 'spell_c_uk', 'spell_c_us',
  // appended 2026-09-30: the render against its input's render
  'same_picture',
  // appended 2026-10-09: the result's thinking token count, from
  // usage.output_tokens_details. The third campaign varies effort, and this
  // is the only evidence a level took: the CLI records the level nowhere.
  'thinking_tokens',
];

// ------------------------------------------------------------------ features

const RE = {
  glow_or_shadow: /box-shadow|drop-shadow|text-shadow|feGaussianBlur|feDropShadow|glow/i,
  glow: /glow/i,
  keyframes: /@keyframes/i,
  radial_gradient: /radial-gradient|radialGradient/i,
  linear_gradient: /linear-gradient|linearGradient/i,
  pulse: /pulse/i,
  script: /<script\b/i,
  // Output that calls Math.random or the clock. That alone says nothing about
  // whether the render varies: many of these only read the year.
  nondeterministic: /Math\.random|Date\.now|new Date\b|performance\.now|getRandomValues/,
  svg_filter: /<filter\b/i,
};
// The self-report mentions a server. The pilot's hand count (14/32) was "asks to
// start a server or asks permission", but the word server alone reproduces it,
// and "permission" also catches reports of a denied command, which Fable writes
// often. Whole word only: a bare /server/ also matched IntersectionObserver.
const MENTIONS_SERVER = /\bserver\b/i;
// 3, 4, 6 or 8 hex digits, not an HTML entity; alpha is dropped, shorthand expanded.
const HEX = /(?<![&\w])#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z_-])/gi;

function hexColors(s) {
  const seen = [];
  for (const [, h] of s.matchAll(HEX)) {
    let x = h.toLowerCase();
    if (x.length <= 4) x = [...x.slice(0, 3)].map((c) => c + c).join('');
    else x = x.slice(0, 6);
    if (!seen.includes(`#${x}`)) seen.push(`#${x}`);
  }
  return seen;
}

// Same algorithm as tree_sha in bin/lib.sh: sorted "f|d|l path ..." entries.
function treeSha(root) {
  const e = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name), r = relative(root, p), st = lstatSync(p);
      if (st.isSymbolicLink()) e.push(`l ${r} ${readlinkSync(p)}`);
      else if (st.isFile()) e.push(`f ${r} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
      else if (st.isDirectory()) { e.push(`d ${r}`); walk(p); }
    }
  };
  walk(root);
  return createHash('sha256').update(e.sort().join('\n')).digest('hex');
}

// --------------------------------------------------------------- text answers

const unmark = (s) => s.replace(/[*_`]/g, '').trim();
const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

// A reply that asks a question and puts no answer in **bold** is a decline,
// even when it names a value in passing: "A specific range (like 1-100, or
// 1-10)?" is not the number 1, and "I'll choose one!" is not the word one. A
// reply that asks and then commits in bold (number/haiku/018, "I'll go with
// **42**") keeps its answer. On the campaign this flags exactly three replies,
// all Haiku's: number 007 and 055, word 051.
const DECLINE = Object.freeze({ value: '', form: 'none', ok: false });
export const declines = (raw) => raw.includes('?') && !/\*\*[^*]+\*\*/.test(raw);

export function parseNumber(raw, digitOnly) {
  if (declines(raw)) return DECLINE;
  const t = unmark(raw);
  const m = t.match(/-?\d[\d,]*(\.\d+)?/);
  if (!m) return DECLINE;
  const value = m[0].replace(/,/g, '');
  const bare = t.replace(/[.!]$/, '') === m[0];
  const ok = digitOnly ? /^-?\d$/.test(value) : true;
  return { value, form: bare ? 'bare' : 'framed', ok };
}

export function parseWord(raw) {
  const t = raw.trim();
  const plain = unmark(t).replace(/[.!"“”]+$/g, '').replace(/^["“]+/, '');
  if (/^[\p{L}'-]+$/u.test(plain)) return { value: plain.toLowerCase(), form: 'bare', ok: true };
  if (declines(t)) return DECLINE;
  // Framed: prefer the first bold span, else the last quoted or trailing word.
  const bold = t.match(/\*\*([^*]+)\*\*/);
  const pick = bold ? bold[1] : (t.match(/["“]([^"”]+)["”]/)?.[1] ?? t.split(/\s+/).pop());
  const v = unmark(pick).replace(/[.!,:;"“”]+$/g, '');
  return { value: v.toLowerCase(), form: 'framed', ok: /^[\p{L}'-]+$/u.test(v) };
}

// -------------------------------------------------------------- color answers

// The second campaign's tasks, written against its replies like the parsers
// above. A color is recorded as #rrggbb whatever notation it arrived in, so the
// hex, rgb and gradient tasks compare with each other and with hex_colors.

/** hex, button, background (want 1) and hex2 (want 2): the first hex colors named. */
export function parseHex(raw, want = 1) {
  const found = hexColors(raw);
  if (!found.length) return DECLINE;
  const words = unmark(raw).replace(/[.!]$/, '').split(/[\s,]+|\band\b/).filter(Boolean);
  const bare = words.every((w) => /^#[0-9a-f]{3,8}$/i.test(w));
  return { value: found.slice(0, want).join(' '), form: bare ? 'bare' : 'framed', ok: found.length >= want };
}

const hexByte = (n) => Number(n).toString(16).padStart(2, '0');

/** rgb: the first r, g, b triple. */
export function parseRgb(raw) {
  const m = raw.match(/(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  if (!m) return DECLINE;
  const rgb = m.slice(1, 4).map(Number);
  const bare = /^(rgb)?\s*\(?\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)?$/i.test(unmark(raw).replace(/[.!]$/, ''));
  return { value: `#${rgb.map(hexByte).join('')}`, form: bare ? 'bare' : 'framed', ok: rgb.every((v) => v <= 255) };
}

// The arguments of the first gradient function in a reply, split at its own commas.
function gradientArgs(raw) {
  const m = /\b(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.exec(raw);
  if (!m) return null;
  const args = [];
  let depth = 1, cur = '';
  for (let i = m.index + m[0].length; i < raw.length; i++) {
    const c = raw[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return [...args, cur.trim()];
    if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; } else cur += c;
  }
  return null;
}
// A first argument that is a direction, an angle or a shape, not a color stop.
const NOT_A_STOP = /^(?:to\s|from\s|at\s|in\s|circle|ellipse|closest|farthest|-?[\d.]+(?:deg|turn|rad|grad)\b)/i;

/**
 * gradient: the color stops of the first gradient written, in order. Haiku
 * often follows it with variations; whether #667eea and #764ba2 appear anywhere
 * in a reply is a question for answer_raw, and the summary asks it.
 */
export function parseGradient(raw) {
  const args = gradientArgs(raw);
  if (!args) return DECLINE;
  const stops = args.filter((a, i) => !(i === 0 && NOT_A_STOP.test(a))).map((a) => {
    const rgb = a.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i);
    return rgb ? `#${rgb.slice(1, 4).map(hexByte).join('')}` : (hexColors(a)[0] ?? a.split(/\s+/)[0].toLowerCase());
  });
  // Bare: nothing but one code block, or one line of CSS.
  const prose = raw.replace(/```[\s\S]*?```/g, '').trim();
  const bare = prose === '' || !raw.trim().includes('\n') && /^[\w-]*:?\s*[\w-]*gradient\(.*\);?$/i.test(raw.trim());
  return { value: stops.join(' '), form: bare ? 'bare' : 'framed', ok: stops.length >= 2 };
}

// color, favorite, best: a color named in words. The value is the hue alone
// ("deep blue" and "slate blue" are blue; teal is its own word), so that 100
// replies make one distribution.
const HUES = 'blue-green|red|orange|yellow|green|blue|purple|violet|indigo|pink|brown|black|white|gray|grey|teal|cyan|turquoise|magenta|maroon|navy|gold|coral|crimson|lavender|cerulean|azure|emerald|amber|aqua|cobalt|fuchsia|lilac|lime|mauve|mint|olive|peach|periwinkle|plum|rose|salmon|sapphire|scarlet|silver|ultramarine';
const SHADES = 'deep|dark|light|bright|soft|pale|royal|sky|ocean|slate|steel|navy|midnight|forest|electric|cobalt|warm|cool|rich|vivid|muted|dusty|calm|nice|terminal';
const COLOR = `(?:a |an )?(?:(?:${SHADES})[ -])*(${HUES})`;
const COLOR_LEADS = new RegExp(`^(?:probably |definitely |honestly,? )?${COLOR}\\b`, 'i');
const COLOR_ONLY = new RegExp(`^${COLOR}$`, 'i');
const COLOR_PICKED = new RegExp(`\\b(?:I(?:'d| would|'ll| will)? (?:say|pick|choose|go with|have to say|lean toward)|had to (?:pick|choose)(?: one)?[:,]?|I(?:'ll say I)? like|partial to|drawn to|going with|(?:it|that)(?:'d| would) be|my (?:pick|choice|answer|vote) (?:is|would be))\\s+${COLOR}\\b`, 'i');
const hue = (m) => (m[1].toLowerCase() === 'grey' ? 'gray' : m[1].toLowerCase());

/**
 * A reply commits to a color in one of two ways: it opens with it ("Teal.",
 * "Blue, probably: ...", "Probably a deep blue-green, like teal"), or it says
 * it picks one ("if I had to pick, I'd say deep blue", "I'll go with **teal**").
 * A color mentioned any other way is not an answer: "blue is the most commonly
 * preferred color across surveys" reports a fact, and a list of what each color
 * is good for chooses none, bold or not.
 */
export function parseColorName(raw) {
  const t = unmark(raw);
  const lead = COLOR_LEADS.exec(t);
  if (lead) return { value: hue(lead), form: COLOR_ONLY.test(t.replace(/[.!]$/, '')) ? 'bare' : 'framed', ok: true };
  const picked = COLOR_PICKED.exec(t);
  return picked ? { value: hue(picked), form: 'framed', ok: true } : DECLINE;
}

/** colorize: the circle's fill, a hex normalized and anything else as written. */
export function circleFill(body) {
  const f = body.match(/<circle\b[^>]*\sfill\s*=\s*["']([^"']+)["']/i)?.[1]
    ?? body.match(/\bcircle\b[^{}]*\{[^}]*?\bfill\s*:\s*([^;}]+)/i)?.[1]
    ?? body.match(/\bfill\s*:\s*([^;}]+)/i)?.[1]
    ?? body.match(/\sfill\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!f) return '';
  const v = f.trim().toLowerCase();
  return hexColors(v)[0] ?? v;
}

const TEXT_PARSERS = {
  number: (raw) => parseNumber(raw, false), digit: (raw) => parseNumber(raw, true), word: parseWord,
  hex: (raw) => parseHex(raw, 1), button: (raw) => parseHex(raw, 1), background: (raw) => parseHex(raw, 1),
  hex2: (raw) => parseHex(raw, 2), rgb: parseRgb, gradient: parseGradient,
  color: parseColorName, favorite: parseColorName, best: parseColorName,
};

// Word-level LCS between two sentences, on normalized tokens.
function wordDiff(a, b) {
  const x = a.split(/\s+/).filter(Boolean), y = b.split(/\s+/).filter(Boolean);
  const nx = x.map(norm), ny = y.map(norm);
  const L = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      L[i][j] = nx[i] === ny[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const added = [], removed = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (nx[i] === ny[j]) { i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) removed.push(x[i++]);
    else added.push(y[j++]);
  }
  while (i < x.length) removed.push(x[i++]);
  while (j < y.length) added.push(y[j++]);
  return { added, removed, words: y.length };
}

// --------------------------------------------------------------------- rows

const nnn = (s) => String(s).padStart(3, '0');
const seedCache = {};
function seedOf(task) {
  if (seedCache[task]) return seedCache[task];
  const dir = join(REPO, 'tasks', task, 'seed');
  const file = existsSync(dir) ? readdirSync(dir)[0] : null;
  const s = file
    ? { dir, file, sha: treeSha(dir), text: readFileSync(join(dir, file), 'utf8') }
    : { dir: null, file: null, sha: null, text: null };
  return (seedCache[task] = s);
}

// ------------------------------------------------------------------ renders

// same_picture is `unchanged` for the picture: did the trial leave the picture
// as it found it? Its input is the seed for a sample (and whenever from_seed is
// true), else the previous step's output, matched by room hash (input_sha256
// against that step's output_sha256).
//
// An output file byte-identical to its input's is the same picture by
// definition. The renders are not compared then, because an animated or random
// page can render differently from one load to the next: 43 chain steps that
// changed nothing have a render that differs from the step before's, every one
// of them a page with @keyframes or a Math.random or clock call. Otherwise the
// render files are compared, so a changed file whose page animates can read
// false on render variance alone.
//
// Render files, not decoded pixels, are compared. That is exact for this set:
// cwebp is deterministic, so equal screenshots give equal bytes, and no two
// distinct files among the 1,120 renders decode to the same pixels (checked
// 2026-09-30 with sharp).
//
// The seed's render is the render of any trial whose output file is still the
// seed, byte for byte: the same bytes through the same renderer. check()
// refuses a set where they disagree, which would mean renders from different
// Chrome builds or a seed that is not static. A fresh render of each seed with
// bin/shot.sh matched them on 2026-09-30.
//
// Seed renders are keyed by the seed file's hash, not by task, because tasks
// share seeds: circle, replica and colorize all start from the same bytes. A
// manifest's own trials come first. Where none of them left a seed alone (every
// colorize trial changes it, and so did every html trial of the Opus control),
// the render is borrowed from any other run on disk that did. A tally looks
// outside its manifest only for a seed it has no render of, so the first
// campaign's rows never depend on a later one's renders.
const renderMeta = new WeakMap(); // row -> { sha, file, isSeed }; off the row, since every row key is a column
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const seedFile = (task) => sha256(seedOf(task).text);

function renderSha(run, step) {
  const p = join(RENDERS, run, `${nnn(step)}.webp`);
  return existsSync(p) ? sha256(readFileSync(p)) : null;
}

/** One run's counted trials whose output file is still its seed and has a render: [seed file hash, render hash]. */
const seedTrialsCache = new Map();
function seedTrials(run) {
  if (seedTrialsCache.has(run)) return seedTrialsCache.get(run);
  const out = [], tj = join(RUNS, run, 'trials.jsonl');
  for (const t of existsSync(tj) ? readFileSync(tj, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []) {
    const seed = seedOf(t.task);
    if (t.counted !== true || !seed.file || t.task === 'sentence') continue;
    const path = join(RUNS, run, nnn(t.step), seed.file);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== seed.text) continue;
    const sha = renderSha(run, t.step);
    if (sha) out.push([seedFile(t.task), sha]);
  }
  seedTrialsCache.set(run, out);
  return out;
}

/** Per seed file hash, the distinct render hashes of trials whose output is that seed. */
function seedRenders(rows) {
  const by = {}, needed = new Set();
  for (const r of rows) {
    const m = renderMeta.get(r);
    if (!m?.sha) continue;
    needed.add(seedFile(r.task));
    if (m.isSeed) (by[m.file] ||= new Set()).add(m.sha);
  }
  const missing = [...needed].filter((file) => !by[file]);
  if (!missing.length) return by;
  const mine = new Set(rows.map((r) => r.run));
  for (const run of readdirSync(RUNS).sort()) {
    if (mine.has(run)) continue;
    for (const [file, sha] of seedTrials(run)) if (missing.includes(file)) (by[file] ||= new Set()).add(sha);
  }
  return by;
}

/**
 * For every row that has a render, its input's render hash and output-file
 * hash, or null when the input's render cannot be resolved (check() reports
 * those). Rows without a render (text tasks, the sentence chain, an artifact
 * trial not yet rendered) are absent.
 */
function inputRenders(rows) {
  const seeds = seedRenders(rows);
  const at = new Map(rows.map((r) => [`${r.run}|${r.step}`, r]));
  const out = new Map();
  for (const r of rows) {
    if (!renderMeta.get(r)?.sha) continue;
    let input = null;
    if (r.from_seed) {
      const file = seedFile(r.task);
      if (seeds[file]?.size === 1) input = { sha: [...seeds[file]][0], file };
    } else {
      const prev = at.get(`${r.run}|${r.step - 1}`);
      const m = prev && prev.output_sha256 === r.input_sha256 ? renderMeta.get(prev) : null;
      if (m?.sha) input = { sha: m.sha, file: m.file };
    }
    out.set(r, input);
  }
  return out;
}

function samePicture(rows) {
  for (const [r, input] of inputRenders(rows)) {
    const m = renderMeta.get(r);
    r.same_picture = input ? m.file === input.file || m.sha === input.sha : null;
  }
}

function modelOf(r) {
  const ret = [...new Set(r.model_returned || [])];
  return ret.length ? ret.join('+') : r.model_asked;
}

/** The runs a manifest lists. */
const manifestRuns = (file) => readFileSync(file, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => l.split('\t')[0]);

export function tally(manifest = FIRST) {
  const mine = new Set(manifestRuns(manifest));
  if (manifest === FIRST) mine.add('pilot-import');
  const rows = [];
  for (const run of readdirSync(RUNS).sort()) {
    const dir = join(RUNS, run), tj = join(dir, 'trials.jsonl');
    if (!mine.has(run) || !existsSync(tj)) continue;
    const trials = readFileSync(tj, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      .filter((r) => r.counted === true);
    for (const t of trials) rows.push(row(t, dir));
  }
  samePicture(rows);
  return rows;
}

function row(t, dir) {
  const seed = seedOf(t.task);
  const room = join(dir, nnn(t.step));
  const tc = t.tool_calls || null;
  const o = {
    run: t.run, task: t.task, mode: t.mode, profile: t.profile, step: t.step,
    model: modelOf(t), model_asked: t.model_asked, effort: t.effort, cli_version: t.cli_version,
    session_id: t.session_id, started_utc: t.started_utc,
    wall_s: t.wall_s, cost_usd: t.cost_usd, turns: t.turns,
    output_tokens: t.tokens?.output ?? null, thinking_blocks: t.thinking_blocks, denials: t.denials,
    thinking_tokens: t.tokens?.thinking ?? null,
    tool_calls: tc ? Object.values(tc).reduce((a, b) => a + b, 0) : null,
    bash_calls: tc ? (tc.Bash ?? 0) : null,
    edit_calls: tc ? (tc.Edit ?? 0) + (tc.Write ?? 0) : null,
    input_sha256: t.input_sha256, output_sha256: t.output_sha256,
    // Both empty for the text tasks. They have no seed file, so their room is
    // empty before and after, and the two hashes would match trivially.
    from_seed: seed.sha ? t.input_sha256 === seed.sha : null,
    unchanged: seed.file ? t.input_sha256 === t.output_sha256 : null,
    result_chars: (t.result ?? '').length,
    mentions_server: MENTIONS_SERVER.test(t.result ?? ''),
  };

  // The output file, and what the trial started from.
  if (seed.file && existsSync(room)) {
    const files = readdirSync(room);
    const path = join(room, seed.file);
    const body = existsSync(path) ? readFileSync(path, 'utf8') : '';
    Object.assign(o, {
      file: seed.file, bytes: Buffer.byteLength(body), lines: countLines(body),
      extra_files: files.filter((f) => f !== seed.file).length,
    });
    if (t.task === 'sentence') {
      const prev = t.mode === 'chain' && t.step > 1 ? join(dir, nnn(t.step - 1), seed.file) : join(seed.dir, seed.file);
      const d = wordDiff(readFileSync(prev, 'utf8').trim(), body.trim());
      Object.assign(o, {
        answer_raw: body.trim(), answer_value: body.trim(), answer_form: null,
        answer_ok: d.added.length === 1 && d.removed.length === 0,
        words: d.words, added: d.added.join(' '), removed: d.removed.join(' '),
      });
    } else {
      for (const [k, re] of Object.entries(RE)) o[k] = re.test(body);
      o.gradient_667eea = /#667eea/i.test(body) && /#764ba2/i.test(body);
      const hex = hexColors(body);
      o.hex_count = hex.length;
      o.hex_colors = hex.join(' ');
      if (t.task === 'colorize') { o.answer_value = circleFill(body); o.answer_ok = o.answer_value !== ''; }
      renderMeta.set(o, { sha: renderSha(relative(RUNS, dir), t.step), file: sha256(body), isSeed: body === seed.text });
    }
  } else if (TEXT_PARSERS[t.task]) {
    const raw = (t.result ?? '').trim();
    const p = TEXT_PARSERS[t.task](raw);
    Object.assign(o, { answer_raw: raw, answer_value: p.value, answer_form: p.form, answer_ok: p.ok });
  }

  // Spelling: the transcript when the repo has one, else the stdout alone.
  const tp = join(dir, `${nnn(t.step)}.jsonl`);
  const tr = existsSync(tp) ? transcript(tp) : null;
  const sp = tr ? spellCount(tr.prose, tr.code) : spellCount(stripCode(t.result ?? ''), null);
  for (const f of Object.keys(FAMILIES)) { o[`${f}_p_uk`] = sp[`${f}.p.uk`]; o[`${f}_p_us`] = sp[`${f}.p.us`]; }
  const csum = (side) => tr ? Object.keys(FAMILIES).reduce((a, f) => a + sp[`${f}.c.${side}`], 0) : null;
  o.spell_c_uk = csum('uk'); o.spell_c_us = csum('us');
  return o;
}

// ---------------------------------------------------------------------- csv

// RFC 4180 quoting. Booleans as true/false, null and undefined as empty.
const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(','))].join('\n') + '\n';

// ------------------------------------------------------------------- checks

const PILOT_EXPECTED = { glow_or_shadow: 30, keyframes: 25, radial_gradient: 23, pulse: 21, gradient_667eea: 18, unchanged: 2, mentions_server: 14 };

function check(rows, first) {
  const problems = [];
  if (first) {
    const pilot = rows.filter((r) => r.mode === 'pilot');
    if (pilot.length !== 32) problems.push(`pilot rows: ${pilot.length}, expected 32`);
    for (const [k, want] of Object.entries(PILOT_EXPECTED)) {
      const got = pilot.filter((r) => r[k] === true).length;
      if (got !== want) problems.push(`pilot ${k}: ${got}, expected ${want}`);
    }
  }
  // Every sample, and every chain's first step, must have started from its task's seed.
  for (const r of rows) {
    const firstOfChain = r.mode === 'chain' && r.step === 1;
    if ((r.mode === 'sample' || firstOfChain) && r.from_seed === false) problems.push(`${r.run} ${r.step}: input is not the seed`);
  }
  // same_picture needs every rendered trial's input render (see "renders" above).
  const seeds = seedRenders(rows);
  for (const task of new Set(rows.filter((r) => renderMeta.get(r)?.sha).map((r) => r.task))) {
    const seed = seeds[seedFile(task)];
    if (!seed) problems.push(`${task}: no trial in any run left the seed as it was, so there is no render of the seed to compare with`);
    else if (seed.size > 1) problems.push(`${task}: outputs identical to the seed have ${seed.size} different renders`);
  }
  for (const [r, input] of inputRenders(rows)) {
    if (!input) problems.push(`${r.run} ${r.step}: no render of its input (the seed's, or the previous step's output)`);
  }
  for (const r of rows) for (const c of Object.keys(r)) if (!COLUMNS.includes(c)) problems.push(`unknown column ${c}`);
  return [...new Set(problems)];
}

// ------------------------------------------------------------------ summary

const short = (m) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-5-1$|-5-5$|-4-5$|-5$/, '');
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}`.padStart(3) : '  -');
const median = (xs) => { const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const group = (rows, key) => rows.reduce((m, r) => { const k = key(r); (m[k] ||= []).push(r); return m; }, {});
const pad = (s, n) => String(s ?? '').padEnd(n);

function summary(rows) {
  const out = [];
  const H = (s) => out.push('', `## ${s}`, '');
  const art = ['glow_or_shadow', 'keyframes', 'radial_gradient', 'pulse', 'gradient_667eea', 'script', 'nondeterministic', 'unchanged', 'mentions_server'];
  const abbr = { glow_or_shadow: 'glow', keyframes: 'keyf', radial_gradient: 'radl', pulse: 'puls', gradient_667eea: '667e', script: 'scrp', nondeterministic: 'rand', unchanged: 'noop', mentions_server: 'srvr' };
  const artHeader = `${pad('', 34)}${pad('n', 5)}${art.map((k) => pad(abbr[k], 5)).join('')}lines  $med`;
  const artLine = (label, rs) => `${pad(label, 34)}${pad(rs.length, 5)}${art.map((k) => pad(pct(rs.filter((r) => r[k] === true).length, rs.length), 5)).join('')}${pad(median(rs.map((r) => r.lines)), 7)}${(median(rs.map((r) => r.cost_usd)) ?? 0).toFixed(3)}`;
  // The third campaign varies effort. Its labels carry the level, so one
  // model's rows at low, high and max stay apart; a campaign run at one level
  // gets no suffix, and its tables read as they always did.
  const levels = new Set(rows.map((r) => r.effort));
  const who = (r) => (levels.size > 1 ? `${short(r.model)} ${r.effort}` : short(r.model));
  const label = (r) => (r.run.includes('relay') ? 'relay' : who(r));

  // A section a campaign has no rows for is left out, heading and all.
  const has = (f) => rows.some(f);

  const pilot = rows.filter((r) => r.mode === 'pilot');
  if (pilot.length) {
    H('Pilot acceptance (expected 30 25 23 21 18 - - 2 14)');
    out.push(artHeader);
    out.push(`${pad('pilot, counts of 32', 34)}${pad(pilot.length, 5)}${art.map((k) => pad(pilot.filter((r) => r[k] === true).length, 5)).join('')}`);
  }

  H('Artifact tasks: % of trials with each feature (samples; chains in full)');
  out.push(artHeader);
  for (const task of ['circle', 'html', 'svg', 'replica', 'colorize']) {
    for (const mode of ['sample', 'chain', 'pilot']) {
      const g = group(rows.filter((r) => r.task === task && r.mode === mode), (r) => `${r.profile === 'harness' ? 'harness ' : ''}${label(r)}`);
      for (const k of Object.keys(g).sort()) out.push(artLine(`${task} ${mode} ${k}`, g[k]));
    }
  }

  if (has((r) => r.mode === 'chain' && r.task !== 'sentence')) H('Chain drift: lines of the output at steps 1 / 8 / 16 / 32 / 64, and feature % early (1-16) vs late (49-64)');
  for (const task of ['circle', 'html']) {
    for (const [run, rs] of Object.entries(group(rows.filter((r) => r.task === task && r.mode === 'chain'), (r) => r.run))) {
      const at = (s) => rs.find((r) => r.step === s)?.lines ?? '-';
      const early = rs.filter((r) => r.step <= 16), late = rs.filter((r) => r.step >= 49);
      const f = (k) => `${k.slice(0, 4)} ${pct(early.filter((r) => r[k]).length, early.length).trim()}→${pct(late.filter((r) => r[k]).length, late.length).trim()}`;
      out.push(`${pad(`${task} ${label(rs[0])}`, 16)} lines ${[1, 8, 16, 32, 64].map(at).join(' / ').padEnd(26)} ${['glow_or_shadow', 'keyframes', 'script', 'nondeterministic'].map(f).join('  ')}`);
    }
  }

  if (has((r) => r.task === 'replica')) {
    H('Replica: the pilot vs the same prompt in the clean room and in the harness');
    out.push(`${pad('', 34)}${pad('n', 5)}${art.map((k) => pad(abbr[k], 5)).join('')}lines  $med   bash(med) denials(med)`);
  }
  for (const [k, rs] of Object.entries(group(rows.filter((r) => r.task === 'replica'), (r) => `${r.mode} ${r.profile}`))) {
    out.push(`${artLine(k, rs)}   ${pad(median(rs.map((r) => r.bash_calls)), 10)}${median(rs.map((r) => r.denials)) ?? '-'}`);
  }

  H('Text answers: top values (count), share bare, share valid');
  for (const task of Object.keys(TEXT_PARSERS)) {
    for (const [m, rs] of Object.entries(group(rows.filter((r) => r.task === task), who))) {
      const vals = Object.entries(group(rs, (r) => r.answer_value)).sort((a, b) => b[1].length - a[1].length).slice(0, 6).map(([v, g]) => `${v || '∅'} ${g.length}`).join(', ');
      out.push(`${pad(`${task} ${m}`, 24)} n=${pad(rs.length, 4)} bare ${pct(rs.filter((r) => r.answer_form === 'bare').length, rs.length)}%  ok ${pct(rs.filter((r) => r.answer_ok).length, rs.length)}%  | ${vals}`);
    }
  }

  if (has((r) => r.task === 'gradient')) {
    H('Gradient: replies with #667eea and #764ba2 anywhere, and replies whose first gradient is exactly that pair');
    for (const [m, rs] of Object.entries(group(rows.filter((r) => r.task === 'gradient'), who))) {
      const anywhere = rs.filter((r) => /#667eea/i.test(r.answer_raw) && /#764ba2/i.test(r.answer_raw)).length;
      out.push(`${pad(m, 12)} n=${pad(rs.length, 4)} anywhere ${pad(anywhere, 4)} first ${rs.filter((r) => r.answer_value === '#667eea #764ba2').length}`);
    }
  }

  if (has((r) => r.task === 'colorize')) {
    H('Colorize: the circle fill, top values (count), and trials whose file has a gradient');
    for (const [m, rs] of Object.entries(group(rows.filter((r) => r.task === 'colorize'), who))) {
      const vals = Object.entries(group(rs, (r) => r.answer_value)).sort((a, b) => b[1].length - a[1].length).slice(0, 6).map(([v, g]) => `${v || '∅'} ${g.length}`).join(', ');
      out.push(`${pad(m, 12)} n=${pad(rs.length, 4)} gradient ${pad(rs.filter((r) => r.linear_gradient || r.radial_gradient).length, 3)} | ${vals}`);
    }
  }

  if (has((r) => r.task === 'sentence')) H('Sentence chains: rule kept (exactly one word added, none removed), final length, first words added');
  for (const [run, rs] of Object.entries(group(rows.filter((r) => r.task === 'sentence'), (r) => r.run))) {
    const last = rs.reduce((a, r) => (r.step > a.step ? r : a));
    out.push(`${pad(label(rs[0]), 8)} ok ${rs.filter((r) => r.answer_ok).length}/${rs.length}  words ${pad(last.words, 4)} first: ${rs.slice(0, 8).map((r) => r.added || '∅').join(' · ')}`);
  }

  H('Hex colors: share of artifact trials using each, top 15 overall, then top 5 per model');
  const artRows = rows.filter((r) => r.hex_colors !== undefined);
  const rank = (rs, n) => { const c = {}; for (const r of rs) for (const h of (r.hex_colors || '').split(' ').filter(Boolean)) c[h] = (c[h] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n); };
  out.push(rank(artRows, 15).map(([h, n]) => `${h} ${pct(n, artRows.length).trim()}%`).join('  '));
  for (const [m, rs] of Object.entries(group(artRows, who))) out.push(`${pad(m, 12)} ${rank(rs, 5).map(([h, n]) => `${h} ${pct(n, rs.length).trim()}%`).join('  ')}`);

  H('Spelling in prose: trials using British / American / both forms, by model');
  for (const [m, rs] of Object.entries(group(rows, who))) {
    const fam = (f) => { const uk = rs.filter((r) => r[`${f}_p_uk`] > 0).length, us = rs.filter((r) => r[`${f}_p_us`] > 0).length, both = rs.filter((r) => r[`${f}_p_uk`] > 0 && r[`${f}_p_us`] > 0).length; return `${f} ${uk}/${us}/${both}`; };
    const cuk = rs.reduce((a, r) => a + (r.spell_c_uk ?? 0), 0), cus = rs.reduce((a, r) => a + (r.spell_c_us ?? 0), 0);
    out.push(`${pad(m, 12)} n=${pad(rs.length, 5)} ${Object.keys(FAMILIES).map(fam).map((s) => pad(s, 18)).join('')} code words UK ${cuk} US ${cus}`);
  }

  // The manipulation check for a campaign that varies effort: a model whose
  // thinking does not move between levels did not receive the level. Per
  // task, because the file tasks think at low and the text tasks do not.
  if (levels.size > 1) {
    H('Effort: thinking tokens med / max, output tokens med, wall s med / max, $ sum, denials; by task, model and level');
    const order = ['low', 'medium', 'high', 'xhigh', 'max'];
    const max = (xs) => { const s = xs.filter((x) => x !== null && x !== undefined); return s.length ? Math.max(...s) : null; };
    for (const task of [...new Set(rows.map((r) => r.task))]) {
      const g = Object.entries(group(rows.filter((r) => r.task === task), who));
      g.sort(([a], [b]) => { const [am, al] = a.split(' '), [bm, bl] = b.split(' '); return am.localeCompare(bm) || order.indexOf(al) - order.indexOf(bl); });
      for (const [k, rs] of g) {
        const th = rs.map((r) => r.thinking_tokens), wall = rs.map((r) => r.wall_s);
        out.push(`${pad(`${task} ${k}`, 24)} n=${pad(rs.length, 4)} think ${pad(median(th), 6)}/ ${pad(max(th), 6)} out ${pad(median(rs.map((r) => r.output_tokens)), 6)} wall ${pad(median(wall)?.toFixed(1), 6)}/ ${pad(max(wall)?.toFixed(1), 6)} $${rs.reduce((a, r) => a + (r.cost_usd ?? 0), 0).toFixed(2).padStart(7)}  denials ${rs.reduce((a, r) => a + (r.denials ?? 0), 0)}`);
      }
    }
  }

  H('Cost and behavior by model (all tasks)');
  for (const [m, rs] of Object.entries(group(rows.filter((r) => r.mode !== 'pilot'), who))) {
    const sum = rs.reduce((a, r) => a + (r.cost_usd ?? 0), 0);
    out.push(`${pad(m, 12)} n=${pad(rs.length, 5)} $${sum.toFixed(2).padStart(7)}  wall med ${pad(median(rs.map((r) => r.wall_s))?.toFixed(1), 6)} turns med ${pad(median(rs.map((r) => r.turns)), 4)} thinking med ${pad(median(rs.map((r) => r.thinking_blocks)), 4)} denials ${rs.reduce((a, r) => a + (r.denials ?? 0), 0)}`);
  }
  return out.join('\n');
}

// --------------------------------------------------------------------- main

// Only when run as a script: test/tally.test.mjs imports the parsers, and an
// import must not rewrite data/trials.csv.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--campaign');
  const manifest = at > -1 ? resolve(process.argv[at + 1] ?? '') : FIRST;
  if (!existsSync(manifest)) { console.error(`tally: no manifest at ${manifest}`); process.exit(2); }
  const first = manifest === FIRST, out = outOf(manifest);
  const rows = tally(manifest);
  const problems = check(rows, first);
  if (process.argv.includes('--check')) {
    console.log(problems.length ? problems.join('\n') : `ok: ${rows.length} rows${first ? ', pilot acceptance counts reproduce' : ''}`);
    process.exit(problems.length ? 1 : 0);
  }
  if (problems.length) { console.error(`tally: refusing to write:\n  ${problems.join('\n  ')}`); process.exit(1); }
  mkdirSync(join(REPO, 'data'), { recursive: true });
  writeFileSync(out, toCsv(rows));
  console.log(`wrote ${relative(REPO, out)}: ${rows.length} rows, ${COLUMNS.length} columns`);
  if (process.argv.includes('--summary')) console.log(summary(rows));
}
