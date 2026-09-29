// tally.mjs [--summary] [--check]: every counted trial as one row of data/trials.csv.
//
// runs/*/trials.jsonl is the source of truth; this file is generated from it
// plus each trial's room (runs/<run>/NNN/) and transcript (NNN.jsonl), so it
// can always be rebuilt and never needs hand edits. Uncounted attempts stay in
// trials.jsonl only.
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
//   --summary  print the comparison tables after writing the CSV
//   --check    only verify the pilot acceptance counts and the seed hashes
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, lstatSync, readlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { FAMILIES, stripCode, count as spellCount, transcript } from './spelling.mjs';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const RUNS = join(REPO, 'runs');
const OUT = join(REPO, 'data', 'trials.csv');

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
  // text answers (number, digit, word, sentence)
  'answer_raw', 'answer_value', 'answer_form', 'answer_ok', 'words', 'added', 'removed',
  // the self-report (stdout)
  'result_chars', 'mentions_server',
  // spelling: prose counts per family, then code totals (null without a transcript)
  ...Object.keys(FAMILIES).flatMap((f) => [`${f}_p_uk`, `${f}_p_us`]), 'spell_c_uk', 'spell_c_us',
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
  // Output that renders differently on every load: renders of it are not reproducible.
  nondeterministic: /Math\.random|Date\.now|new Date\b|performance\.now|getRandomValues/,
  svg_filter: /<filter\b/i,
};
// The self-report mentions a server. The pilot's hand count (14/32) was "asks to
// start a server or asks permission", but /server/ alone reproduces it, and
// "permission" also catches reports of a denied command, which Fable writes often.
const MENTIONS_SERVER = /server/i;
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

function parseNumber(raw, digitOnly) {
  const t = unmark(raw);
  const m = t.match(/-?\d[\d,]*(\.\d+)?/);
  if (!m) return { value: '', form: 'none', ok: false };
  const value = m[0].replace(/,/g, '');
  const bare = t.replace(/[.!]$/, '') === m[0];
  const ok = digitOnly ? /^-?\d$/.test(value) : true;
  return { value, form: bare ? 'bare' : 'framed', ok };
}

function parseWord(raw) {
  const t = raw.trim();
  const plain = unmark(t).replace(/[.!"“”]+$/g, '').replace(/^["“]+/, '');
  if (/^[\p{L}'-]+$/u.test(plain)) return { value: plain.toLowerCase(), form: 'bare', ok: true };
  // Framed: prefer the first bold span, else the last quoted or trailing word.
  const bold = t.match(/\*\*([^*]+)\*\*/);
  const pick = bold ? bold[1] : (t.match(/["“]([^"”]+)["”]/)?.[1] ?? t.split(/\s+/).pop());
  const v = unmark(pick).replace(/[.!,:;"“”]+$/g, '');
  return { value: v.toLowerCase(), form: 'framed', ok: /^[\p{L}'-]+$/u.test(v) };
}

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
  const s = existsSync(dir)
    ? { dir, file: readdirSync(dir)[0], sha: treeSha(dir) }
    : { dir: null, file: null, sha: null };
  return (seedCache[task] = s);
}

function modelOf(r) {
  const ret = [...new Set(r.model_returned || [])];
  return ret.length ? ret.join('+') : r.model_asked;
}

function tally() {
  const rows = [];
  for (const run of readdirSync(RUNS).sort()) {
    const dir = join(RUNS, run), tj = join(dir, 'trials.jsonl');
    if (run === 'pilot' || !existsSync(tj)) continue;
    const trials = readFileSync(tj, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      .filter((r) => r.counted === true);
    for (const t of trials) rows.push(row(t, dir));
  }
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
    tool_calls: tc ? Object.values(tc).reduce((a, b) => a + b, 0) : null,
    bash_calls: tc ? (tc.Bash ?? 0) : null,
    edit_calls: tc ? (tc.Edit ?? 0) + (tc.Write ?? 0) : null,
    input_sha256: t.input_sha256, output_sha256: t.output_sha256,
    from_seed: seed.sha ? t.input_sha256 === seed.sha : null,
    unchanged: t.input_sha256 === t.output_sha256,
    result_chars: (t.result ?? '').length,
    mentions_server: MENTIONS_SERVER.test(t.result ?? ''),
  };

  // The output file, and what the trial started from.
  if (seed.file && existsSync(room)) {
    const files = readdirSync(room);
    const path = join(room, seed.file);
    const body = existsSync(path) ? readFileSync(path, 'utf8') : '';
    Object.assign(o, {
      file: seed.file, bytes: Buffer.byteLength(body), lines: body ? body.split('\n').length : 0,
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
    }
  } else if (['number', 'digit', 'word'].includes(t.task)) {
    const raw = (t.result ?? '').trim();
    const p = t.task === 'word' ? parseWord(raw) : parseNumber(raw, t.task === 'digit');
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

function check(rows) {
  const problems = [];
  const pilot = rows.filter((r) => r.mode === 'pilot');
  if (pilot.length !== 32) problems.push(`pilot rows: ${pilot.length}, expected 32`);
  for (const [k, want] of Object.entries(PILOT_EXPECTED)) {
    const got = pilot.filter((r) => r[k] === true).length;
    if (got !== want) problems.push(`pilot ${k}: ${got}, expected ${want}`);
  }
  // Every sample, and every chain's first step, must have started from its task's seed.
  for (const r of rows) {
    const firstOfChain = r.mode === 'chain' && r.step === 1;
    if ((r.mode === 'sample' || firstOfChain) && r.from_seed === false) problems.push(`${r.run} ${r.step}: input is not the seed`);
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
  const label = (r) => (r.run.includes('relay') ? 'relay' : short(r.model));

  H('Pilot acceptance (expected 30 25 23 21 18 - - 2 14)');
  out.push(artHeader);
  const pilot = rows.filter((r) => r.mode === 'pilot');
  out.push(`${pad('pilot, counts of 32', 34)}${pad(pilot.length, 5)}${art.map((k) => pad(pilot.filter((r) => r[k] === true).length, 5)).join('')}`);

  H('Artifact tasks: % of trials with each feature (samples; chains in full)');
  out.push(artHeader);
  for (const task of ['circle', 'html', 'svg', 'replica']) {
    for (const mode of ['sample', 'chain', 'pilot']) {
      const g = group(rows.filter((r) => r.task === task && r.mode === mode), (r) => `${r.profile === 'harness' ? 'harness ' : ''}${label(r)}`);
      for (const k of Object.keys(g).sort()) out.push(artLine(`${task} ${mode} ${k}`, g[k]));
    }
  }

  H('Chain drift: lines of the output at steps 1 / 8 / 16 / 32 / 64, and feature % early (1-16) vs late (49-64)');
  for (const task of ['circle', 'html']) {
    for (const [run, rs] of Object.entries(group(rows.filter((r) => r.task === task && r.mode === 'chain'), (r) => r.run))) {
      const at = (s) => rs.find((r) => r.step === s)?.lines ?? '-';
      const early = rs.filter((r) => r.step <= 16), late = rs.filter((r) => r.step >= 49);
      const f = (k) => `${k.slice(0, 4)} ${pct(early.filter((r) => r[k]).length, early.length).trim()}→${pct(late.filter((r) => r[k]).length, late.length).trim()}`;
      out.push(`${pad(`${task} ${label(rs[0])}`, 16)} lines ${[1, 8, 16, 32, 64].map(at).join(' / ').padEnd(26)} ${['glow_or_shadow', 'keyframes', 'script', 'nondeterministic'].map(f).join('  ')}`);
    }
  }

  H('Replica: the pilot vs the same prompt in the clean room and in the harness');
  out.push(`${pad('', 34)}${pad('n', 5)}${art.map((k) => pad(abbr[k], 5)).join('')}lines  $med   bash(med) denials(med)`);
  for (const [k, rs] of Object.entries(group(rows.filter((r) => r.task === 'replica'), (r) => `${r.mode} ${r.profile}`))) {
    out.push(`${artLine(k, rs)}   ${pad(median(rs.map((r) => r.bash_calls)), 10)}${median(rs.map((r) => r.denials)) ?? '-'}`);
  }

  H('Text answers: top values (count), share bare, share valid');
  for (const task of ['number', 'digit', 'word']) {
    for (const [m, rs] of Object.entries(group(rows.filter((r) => r.task === task), (r) => short(r.model)))) {
      const vals = Object.entries(group(rs, (r) => r.answer_value)).sort((a, b) => b[1].length - a[1].length).slice(0, 6).map(([v, g]) => `${v || '∅'} ${g.length}`).join(', ');
      out.push(`${pad(`${task} ${m}`, 18)} n=${pad(rs.length, 4)} bare ${pct(rs.filter((r) => r.answer_form === 'bare').length, rs.length)}%  ok ${pct(rs.filter((r) => r.answer_ok).length, rs.length)}%  | ${vals}`);
    }
  }

  H('Sentence chains: rule kept (exactly one word added, none removed), final length, first words added');
  for (const [run, rs] of Object.entries(group(rows.filter((r) => r.task === 'sentence'), (r) => r.run))) {
    const last = rs.reduce((a, r) => (r.step > a.step ? r : a));
    out.push(`${pad(label(rs[0]), 8)} ok ${rs.filter((r) => r.answer_ok).length}/${rs.length}  words ${pad(last.words, 4)} first: ${rs.slice(0, 8).map((r) => r.added || '∅').join(' · ')}`);
  }

  H('Hex colors: share of artifact trials using each, top 15 overall, then top 5 per model');
  const artRows = rows.filter((r) => r.hex_colors !== undefined);
  const rank = (rs, n) => { const c = {}; for (const r of rs) for (const h of (r.hex_colors || '').split(' ').filter(Boolean)) c[h] = (c[h] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n); };
  out.push(rank(artRows, 15).map(([h, n]) => `${h} ${pct(n, artRows.length).trim()}%`).join('  '));
  for (const [m, rs] of Object.entries(group(artRows, (r) => short(r.model)))) out.push(`${pad(m, 10)} ${rank(rs, 5).map(([h, n]) => `${h} ${pct(n, rs.length).trim()}%`).join('  ')}`);

  H('Spelling in prose: trials using British / American / both forms, by model');
  for (const [m, rs] of Object.entries(group(rows, (r) => short(r.model)))) {
    const fam = (f) => { const uk = rs.filter((r) => r[`${f}_p_uk`] > 0).length, us = rs.filter((r) => r[`${f}_p_us`] > 0).length, both = rs.filter((r) => r[`${f}_p_uk`] > 0 && r[`${f}_p_us`] > 0).length; return `${f} ${uk}/${us}/${both}`; };
    const cuk = rs.reduce((a, r) => a + (r.spell_c_uk ?? 0), 0), cus = rs.reduce((a, r) => a + (r.spell_c_us ?? 0), 0);
    out.push(`${pad(m, 10)} n=${pad(rs.length, 5)} ${Object.keys(FAMILIES).map(fam).map((s) => pad(s, 18)).join('')} code words UK ${cuk} US ${cus}`);
  }

  H('Cost and behavior by model (all tasks)');
  for (const [m, rs] of Object.entries(group(rows.filter((r) => r.mode !== 'pilot'), (r) => short(r.model)))) {
    const sum = rs.reduce((a, r) => a + (r.cost_usd ?? 0), 0);
    out.push(`${pad(m, 10)} n=${pad(rs.length, 5)} $${sum.toFixed(2).padStart(7)}  wall med ${pad(median(rs.map((r) => r.wall_s))?.toFixed(1), 6)} turns med ${pad(median(rs.map((r) => r.turns)), 4)} thinking med ${pad(median(rs.map((r) => r.thinking_blocks)), 4)} denials ${rs.reduce((a, r) => a + (r.denials ?? 0), 0)}`);
  }
  return out.join('\n');
}

// --------------------------------------------------------------------- main

const rows = tally();
const problems = check(rows);
if (process.argv.includes('--check')) {
  console.log(problems.length ? problems.join('\n') : `ok: ${rows.length} rows, pilot acceptance counts reproduce`);
  process.exit(problems.length ? 1 : 0);
}
if (problems.length) { console.error(`tally: refusing to write:\n  ${problems.join('\n  ')}`); process.exit(1); }
mkdirSync(join(REPO, 'data'), { recursive: true });
writeFileSync(OUT, toCsv(rows));
console.log(`wrote ${relative(REPO, OUT)}: ${rows.length} rows, ${COLUMNS.length} columns`);
if (process.argv.includes('--summary')) console.log(summary(rows));
