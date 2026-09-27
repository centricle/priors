// spelling.mjs [--rows]: British vs American spelling in trial transcripts, by model.
// Prose = assistant text blocks with code spans and fences stripped.
// Code = tool_use inputs (file contents, edits, commands).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const RUNS = new URL("../runs", import.meta.url).pathname;
const FAMILIES = {
  color:  { uk: /\bcolour(s|ed|ing|ful|less|ise[ds]?|ize[ds]?)?\b/gi, us: /\bcolor(s|ed|ing|ful|less|ize[ds]?)?\b/gi },
  center: { uk: /\bcentr(e|es|ed|ing)\b/gi, us: /\bcenter(s|ed|ing)?\b/gi },
  gray:   { uk: /\bgrey(s|ed|ish)?\b/gi, us: /\bgray(s|ed|ish)?\b/gi },
  // -ise/-ize on common verbs a design self-report reaches for
  ize:    { uk: /\b(optimi|emphasi|organi|visuali|harmoni|minimi|maximi|customi|finali|reali|recogni)s(e|es|ed|ing|ation)\b/gi,
            us: /\b(optimi|emphasi|organi|visuali|harmoni|minimi|maximi|customi|finali|reali|recogni)z(e|es|ed|ing|ation)\b/gi },
};
const n = (s, re) => (s.match(re) || []).length;
const stripCode = (s) => s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

const rows = [];   // one per trial
const add = (model, task, prose, code, src) => {
  const r = { model, task, src };
  for (const [f, { uk, us }] of Object.entries(FAMILIES)) {
    r[`${f}.p.uk`] = n(prose, uk); r[`${f}.p.us`] = n(prose, us);
    r[`${f}.c.uk`] = n(code, uk);  r[`${f}.c.us`] = n(code, us);
  }
  rows.push(r);
};

for (const run of readdirSync(RUNS)) {
  if (run === 'pilot') continue;
  const dir = join(RUNS, run);
  const task = run.split('-')[0];
  for (const f of readdirSync(dir).filter((x) => /^\d{3}\.jsonl$/.test(x))) {
    const events = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (!events.some((e) => e.type === 'result')) continue;   // trial still in flight
    let model = null, prose = '', code = '';
    for (const e of events) {
      if (e.type !== 'assistant') continue;
      model ??= e.message?.model;
      for (const b of e.message?.content || []) {
        if (b.type === 'text') prose += '\n' + stripCode(b.text);
        if (b.type === 'tool_use') code += '\n' + Object.values(b.input || {}).filter((v) => typeof v === 'string').join('\n');
      }
    }
    if (model) add(model, task, prose, code, `${run}/${f}`);
  }
}

// The pilot: 32 Haiku runs, commit message = the model's stdout (prose only).
const pilot = join(RUNS, 'pilot');
if (existsSync(join(pilot, '.git'))) {
  const log = execFileSync('git', ['-C', pilot, 'log', '--format=%B%x00'], { encoding: 'utf8' });
  for (const msg of log.split('\0').map((s) => s.trim()).filter(Boolean)) {
    if (msg.length < 80) continue;   // skip the seed/reset commits
    add('haiku-4-5 (pilot)', 'circle', stripCode(msg), '', 'pilot');
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
