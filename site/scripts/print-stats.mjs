#!/usr/bin/env node
/**
 * Print the headline numbers and the tables behind them, in the layout of
 * `node ../bin/tally.mjs --summary`, so the two can be compared side by side.
 *
 * The data layer is TypeScript that uses only erasable syntax, so Node runs it
 * directly:
 *
 *   node --experimental-strip-types scripts/print-stats.mjs
 *
 * (Node 22.18 and later strip types by default; the flag is harmless there.)
 */
const data = await import('../src/lib/data.ts');
const stats = await import('../src/lib/stats.ts');
const { loadAll, MODELS, MODEL_LABEL, fmtUsd, fmtPct, isArtifact } = data;

const { trials, runs, runByName, uncounted } = loadAll();
const pct = (s) => String(Math.round(100 * s)).padStart(3);
const pad = (v, n) => String(v ?? '').padEnd(n);
const H = (s) => console.log(`\n## ${s}\n`);
const short = (m) => m;

H('Headline');
console.log(JSON.stringify(stats.headline(trials), (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v), 2));
console.log(`\nuncounted attempts: ${uncounted.map((a) => `${a.run} #${a.step} (${a.halt ? 'halted' : 'no halt'})`).join('; ') || 'none'}`);
console.log(`money: ${fmtUsd(stats.headline(trials).costCampaign)} campaign, ${fmtPct(stats.headline(trials).fableCostShare)} of it Fable`);

H('Artifact runs: % of trials with each feature');
const F = stats.FEATURES;
console.log(`${pad('', 46)}${pad('n', 5)}${F.map((k) => pad(k.slice(0, 4), 5)).join('')}lines  $med`);
for (const run of runs.filter((r) => isArtifact(r.trials[0]))) {
  const s = stats.runSummary(run);
  console.log(`${pad(run.label, 46)}${pad(s.n, 5)}${F.map((k) => pad(pct(s.features.shares[k].share), 5)).join('')}${pad(s.features.medianLines, 7)}${s.features.medianCost.toFixed(3)}`);
}

H('Chain drift: lines at steps 1 / 8 / 16 / 32 / 64');
for (const run of runs.filter((r) => r.mode === 'chain' && ['circle', 'html'].includes(r.task))) {
  const c = stats.chainCurve(run);
  console.log(`${pad(run.label, 32)} ${stats.CHAIN_MARKS.map((s) => c.at[s]).join(' / ')}   noop ${pct(c.unchangedShare.share)}%`);
}

H('Replica');
for (const r of stats.replicaTable(trials)) {
  const f = r.features;
  console.log(`${pad(r.label, 26)}${pad(r.n, 5)}${F.map((k) => pad(pct(f.shares[k].share), 5)).join('')}${pad(f.medianLines, 7)}${f.medianCost.toFixed(3)}  bash ${pad(r.medianBash, 4)}denials ${r.medianDenials ?? '-'}`);
}

H('Text answers: top values (count), share bare, share valid');
for (const task of ['number', 'digit', 'word']) {
  for (const m of MODELS) {
    const d = stats.answerDistribution(trials.filter((t) => t.task === task && t.model === m));
    const vals = d.values.slice(0, 6).map((v) => `${(v.parsed ? v.value : '(unparsed)')} ${v.count}`).join(', ');
    console.log(`${pad(`${task} ${short(m)}`, 18)} n=${pad(d.n, 4)} bare ${pct(d.bareShare)}%  ok ${pct(d.okShare)}%  | ${vals}`);
  }
}

H('Sentence chains: rule kept, final length, first words added');
for (const run of runs.filter((r) => r.task === 'sentence')) {
  const s = stats.sentenceChain(run);
  console.log(`${pad(run.label, 34)} ok ${s.kept}/${s.total}  words ${s.final.split(/\s+/).length}  first: ${s.steps.slice(0, 8).map((x) => x.added.join(' ') || '(none)').join(' | ')}`);
}
const fable = stats.sentenceChain(runByName.get('sentence-chain-claude-fable-5-1-low'));
console.log(`\nfable final: ${fable.final.slice(0, 160)}...`);

H('Hex colors: share of artifact trials, top 15 overall, top 5 per model');
const hex = stats.hexShares(trials);
console.log(`n=${hex.n}  ` + hex.overall.map((h) => `${h.hex} ${pct(h.share).trim()}%`).join('  '));
for (const m of MODELS) console.log(`${pad(m, 8)} n=${pad(hex.byModel[m].n, 4)}` + hex.byModel[m].top.map((h) => `${h.hex} ${pct(h.share).trim()}%`).join('  '));

H('Spelling in prose (trials with a transcript): uk / us / both, and only-uk / only-us');
for (const [name, opts] of [['transcripts only', {}], ['all rows, as the tally counts them', { transcriptOnly: false }]]) {
  console.log(`-- ${name}`);
  const sp = stats.spellingByModel(trials, opts);
  for (const m of MODELS) {
    const f = (k) => { const c = sp[m].families[k]; return pad(`${k} ${c.uk}/${c.us}/${c.both} (${c.ukOnly}/${c.usOnly})`, 26); };
    console.log(`${pad(m, 8)} n=${pad(sp[m].n, 5)}${stats.SPELLING_FAMILIES.map(f).join('')} code UK ${sp[m].codeUk} US ${sp[m].codeUs}`);
  }
}

H('Cost and behavior by model');
const cost = stats.costByModel(trials);
for (const [name, table] of [['campaign', cost.campaign], ['with pilot', cost.all]]) {
  console.log(`-- ${name}`);
  for (const m of MODELS) {
    const c = table[m];
    console.log(`${pad(m, 8)} n=${pad(c.n, 5)} $${c.totalCost.toFixed(2).padStart(7)}  wall med ${pad(c.medianWall?.toFixed(1), 6)} turns med ${pad(c.medianTurns, 4)} thinking med ${pad(c.medianThinking, 4)} denials ${c.denials}`);
  }
}
console.log(`total campaign ${cost.totalCampaign.toFixed(4)}, with pilot ${cost.totalAll.toFixed(4)}; labels: ${MODELS.map((m) => MODEL_LABEL[m]).join(', ')}`);
