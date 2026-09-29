// spelling.mjs [--rows]: British vs American spelling in trial transcripts, by model.
// Prose = assistant text blocks with code spans and fences stripped.
// Code = tool_use inputs (file contents, edits, commands).
//
// Also a module: tally.mjs imports FAMILIES, stripCode, count and transcript,
// so the CSV and this report cannot disagree about what counts.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FAMILIES = {
  color:  { uk: /\bcolour(s|ed|ing|ful|less|ise[ds]?|ize[ds]?)?\b/gi, us: /\bcolor(s|ed|ing|ful|less|ize[ds]?)?\b/gi },
  center: { uk: /\bcentr(e|es|ed|ing)\b/gi, us: /\bcenter(s|ed|ing)?\b/gi },
  gray:   { uk: /\bgrey(s|ed|ish)?\b/gi, us: /\bgray(s|ed|ish)?\b/gi },
  // -ise/-ize on common verbs a design self-report reaches for
  ize:    { uk: /\b(optimi|emphasi|organi|visuali|harmoni|minimi|maximi|customi|finali|reali|recogni)s(e|es|ed|ing|ation)\b/gi,
            us: /\b(optimi|emphasi|organi|visuali|harmoni|minimi|maximi|customi|finali|reali|recogni)z(e|es|ed|ing|ation)\b/gi },
};
const n = (s, re) => (s.match(re) || []).length;
export const stripCode = (s) => s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

// Per-family counts. code === null means no transcript: code columns are null.
export function count(prose, code) {
  const r = {};
  for (const [f, { uk, us }] of Object.entries(FAMILIES)) {
    r[`${f}.p.uk`] = n(prose, uk); r[`${f}.p.us`] = n(prose, us);
    r[`${f}.c.uk`] = code === null ? null : n(code, uk);
    r[`${f}.c.us`] = code === null ? null : n(code, us);
  }
  return r;
}

// A stream-json transcript as { model, prose, code }, or null if the trial
// never reached a result event.
export function transcript(path) {
  const events = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!events.some((e) => e.type === 'result')) return null;
  let model = null, prose = '', code = '';
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    model ??= e.message?.model;
    for (const b of e.message?.content || []) {
      if (b.type === 'text') prose += '\n' + stripCode(b.text);
      if (b.type === 'tool_use') code += '\n' + Object.values(b.input || {}).filter((v) => typeof v === 'string').join('\n');
    }
  }
  return { model, prose, code };
}

function main() {
  const RUNS = new URL('../runs', import.meta.url).pathname;
  const rows = [];   // one per trial
  const add = (model, task, prose, code, src) => rows.push({ model, task, src, ...count(prose, code) });

  for (const run of readdirSync(RUNS)) {
    const dir = join(RUNS, run);
    if (run === 'pilot' || !existsSync(join(dir, 'trials.jsonl'))) continue;
    const task = run.split('-')[0];
    for (const f of readdirSync(dir).filter((x) => /^\d{3}\.jsonl$/.test(x))) {
      const t = transcript(join(dir, f));
      if (t?.model) add(t.model, task, t.prose, t.code, `${run}/${f}`);
    }
  }

  // The pilot has no transcripts in the repo; its result is the model's stdout (prose only).
  const pilot = join(RUNS, 'pilot-import', 'trials.jsonl');
  if (existsSync(pilot)) {
    for (const r of readFileSync(pilot, 'utf8').split('\n').filter(Boolean).map(JSON.parse)) {
      add('haiku-4-5 (pilot)', 'circle', stripCode(r.result), '', `pilot-import/${r.step}`);
    }
  }

  // Report: per model, trials; per family, trials using UK / US / both in prose, and raw counts.
  const models = [...new Set(rows.map((r) => r.model))].sort();
  const out = [];
  for (const m of models) {
    const rs = rows.filter((r) => r.model === m);
    const tasks = [...new Set(rs.map((r) => r.task))].join(',');
    out.push(`\n${m}  (${rs.length} trials: ${tasks})`);
    for (const f of Object.keys(FAMILIES)) {
      const ukT = rs.filter((r) => r[`${f}.p.uk`] > 0).length;
      const usT = rs.filter((r) => r[`${f}.p.us`] > 0).length;
      const bothT = rs.filter((r) => r[`${f}.p.uk`] > 0 && r[`${f}.p.us`] > 0).length;
      const sum = (k) => rs.reduce((a, r) => a + r[k], 0);
      out.push(`  ${f.padEnd(7)} prose trials UK ${String(ukT).padStart(3)}  US ${String(usT).padStart(3)}  both ${String(bothT).padStart(2)} | prose words UK ${String(sum(`${f}.p.uk`)).padStart(4)} US ${String(sum(`${f}.p.us`)).padStart(4)} | code UK ${String(sum(`${f}.c.uk`)).padStart(4)} US ${String(sum(`${f}.c.us`)).padStart(5)}`);
    }
  }
  console.log(out.join('\n'));
  if (process.argv.includes('--rows')) console.log(JSON.stringify(rows));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
