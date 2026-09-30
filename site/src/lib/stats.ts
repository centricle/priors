// Every number the site quotes, computed from the trial rows.
//
// Pure functions over Trial[]: nothing here is typed in by hand, so a figure in
// the copy can only drift from the data if the copy stops calling these. Shares
// are 0..1; format them with fmtPct at the point of use.
import { MODELS, isArtifact, isCampaign, loadAll, outputOf, seedOf } from './data.ts';
import type { Model, Run, Trial } from './data.ts';

// ------------------------------------------------------------------ helpers

export interface Share {
  count: number;
  n: number;
  share: number;
}
const shareOf = (count: number, n: number): Share => ({ count, n, share: n ? count / n : 0 });

/**
 * Lower median, the same rule bin/tally.mjs uses: with an even count it takes
 * the lower of the two middle values, so integer columns stay integers.
 */
export function median(xs: readonly (number | null | undefined)[]): number | null {
  const s = xs.filter((x): x is number => x !== null && x !== undefined).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
}

export const sum = (xs: readonly (number | null | undefined)[]): number => xs.reduce<number>((a, x) => a + (x ?? 0), 0);

export function byModel(trials: Trial[]): Record<Model, Trial[]> {
  const out = { fable: [], opus: [], sonnet: [], haiku: [] } as Record<Model, Trial[]>;
  for (const t of trials) out[t.model].push(t);
  return out;
}

/** Worst-case 95% margin of error for a share measured on n trials. */
export const marginOfError = (n: number): number => 1.96 * Math.sqrt(0.25 / n);

// ----------------------------------------------------------------- features

export const FEATURES = [
  'glow_or_shadow', 'keyframes', 'radial_gradient', 'pulse', 'gradient_667eea',
  'script', 'nondeterministic', 'unchanged', 'mentions_server',
] as const;
export type Feature = (typeof FEATURES)[number];

export interface FeatureShares {
  n: number;
  shares: Record<Feature, Share>;
  medianLines: number | null;
  medianCost: number | null;
}

export function featureShares(trials: Trial[]): FeatureShares {
  const shares = {} as Record<Feature, Share>;
  for (const k of FEATURES) {
    const known = trials.filter((t) => t[k] !== null);
    shares[k] = shareOf(known.filter((t) => t[k] === true).length, known.length);
  }
  return {
    n: trials.length,
    shares,
    medianLines: median(trials.map((t) => t.lines)),
    medianCost: median(trials.map((t) => t.cost_usd)),
  };
}

export interface RunSummary {
  name: string;
  label: string;
  n: number;
  features: FeatureShares;
  totalCost: number;
  totalWall: number;
}

export function runSummary(run: Run): RunSummary {
  return {
    name: run.name,
    label: run.label,
    n: run.trials.length,
    features: featureShares(run.trials),
    totalCost: sum(run.trials.map((t) => t.cost_usd)),
    totalWall: sum(run.trials.map((t) => t.wall_s)),
  };
}

// ------------------------------------------------------------------- chains

export const CHAIN_MARKS = [1, 8, 16, 32, 64] as const;

export interface ChainPoint {
  step: number;
  lines: number | null;
  cost: number | null;
  unchanged: boolean;
}

export interface ChainCurve {
  points: ChainPoint[];
  /** Lines of the output at steps 1, 8, 16, 32 and 64. */
  at: Record<number, number | null>;
  first: number | null;
  last: number | null;
  unchangedShare: Share;
}

export function chainCurve(run: Run): ChainCurve {
  const points = run.trials.map((t) => ({ step: t.step, lines: t.lines, cost: t.cost_usd, unchanged: t.unchanged }));
  const at: Record<number, number | null> = {};
  for (const s of CHAIN_MARKS) at[s] = points.find((p) => p.step === s)?.lines ?? null;
  return {
    points,
    at,
    first: points[0]?.lines ?? null,
    last: points[points.length - 1]?.lines ?? null,
    unchangedShare: shareOf(points.filter((p) => p.unchanged).length, points.length),
  };
}

// ------------------------------------------------------------- text answers

export interface AnswerCount {
  value: string;
  count: number;
  share: number;
  /** False when the tally found no value and `value` is the raw reply (a refusal, say). */
  parsed: boolean;
}

export interface AnswerDistribution {
  n: number;
  values: AnswerCount[];
  bareShare: number;
  okShare: number;
}

/** Number, digit and word trials: how often each answer came back. */
export function answerDistribution(trials: Trial[]): AnswerDistribution {
  const counts = new Map<string, AnswerCount>();
  for (const t of trials) {
    const value = t.answer_value ?? t.answer_raw ?? '';
    const entry = counts.get(value) ?? { value, count: 0, share: 0, parsed: t.answer_value !== null };
    entry.count++;
    counts.set(value, entry);
  }
  const values = [...counts.values()]
    .map((e) => ({ ...e, share: e.count / trials.length }))
    .sort((a, b) => b.count - a.count);
  return {
    n: trials.length,
    values,
    bareShare: shareOf(trials.filter((t) => t.answer_form === 'bare').length, trials.length).share,
    okShare: shareOf(trials.filter((t) => t.answer_ok === true).length, trials.length).share,
  };
}

/** How many of these trials answered exactly `value`, over the trials given. */
export function answerCount(trials: Trial[], value: string): Share {
  return shareOf(trials.filter((t) => (t.answer_value ?? t.answer_raw) === value).length, trials.length);
}

// --------------------------------------------------------------------- hex

export interface HexShare {
  hex: string;
  count: number;
  share: number;
}

export interface HexShares {
  n: number;
  overall: HexShare[];
  byModel: Record<Model, { n: number; top: HexShare[] }>;
}

function rankHex(trials: Trial[], top: number): HexShare[] {
  const counts = new Map<string, number>();
  for (const t of trials) for (const h of t.hex_colors) counts.set(h, (counts.get(h) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([hex, count]) => ({ hex, count, share: count / trials.length }));
}

/**
 * Share of artifact trials whose output uses each hex color. Ties keep the
 * order in which the color first appears in the CSV.
 */
export function hexShares(trials: Trial[], top = 15, topPerModel = 5): HexShares {
  const art = trials.filter((t) => isArtifact(t) && t.hex_count !== null);
  const groups = byModel(art);
  const perModel = {} as HexShares['byModel'];
  for (const m of MODELS) perModel[m] = { n: groups[m].length, top: rankHex(groups[m], topPerModel) };
  return { n: art.length, overall: rankHex(art, top), byModel: perModel };
}

// ---------------------------------------------------------------- spelling

export const SPELLING_FAMILIES = ['color', 'center', 'gray', 'ize'] as const;
export type SpellingFamily = (typeof SPELLING_FAMILIES)[number];

export interface SpellingCounts {
  n: number;
  /** Trials using any British form (includes those using both). */
  uk: number;
  /** Trials using any American form (includes those using both). */
  us: number;
  both: number;
  ukOnly: number;
  usOnly: number;
}

export interface ModelSpelling {
  /** Trials counted: those with a transcript unless the caller asked for all. */
  n: number;
  families: Record<SpellingFamily, SpellingCounts>;
  /** Word counts inside tool inputs (file contents, edits, commands), all families. */
  codeUk: number;
  codeUs: number;
}

/**
 * By default only trials with a transcript count, since only they have prose
 * counted from everything the model said. The 64 pilot and harness-replica
 * rows have none; the tally counts them from the final message alone, so pass
 * `{ transcriptOnly: false }` to reproduce the tally's per-model totals.
 */
export function spellingByModel(trials: Trial[], { transcriptOnly = true } = {}): Record<Model, ModelSpelling> {
  const groups = byModel(transcriptOnly ? trials.filter((t) => t.spell_c_uk !== null) : trials);
  const out = {} as Record<Model, ModelSpelling>;
  for (const m of MODELS) {
    const rows = groups[m];
    const families = {} as Record<SpellingFamily, SpellingCounts>;
    for (const f of SPELLING_FAMILIES) {
      const uk = rows.filter((t) => (t[`${f}_p_uk` as const] ?? 0) > 0);
      const us = rows.filter((t) => (t[`${f}_p_us` as const] ?? 0) > 0);
      const both = uk.filter((t) => (t[`${f}_p_us` as const] ?? 0) > 0).length;
      families[f] = { n: rows.length, uk: uk.length, us: us.length, both, ukOnly: uk.length - both, usOnly: us.length - both };
    }
    out[m] = { n: rows.length, families, codeUk: sum(rows.map((t) => t.spell_c_uk)), codeUs: sum(rows.map((t) => t.spell_c_us)) };
  }
  return out;
}

// -------------------------------------------------------------------- cost

export interface ModelCost {
  n: number;
  totalCost: number;
  medianCost: number | null;
  medianWall: number | null;
  medianTurns: number | null;
  medianThinking: number | null;
  denials: number;
}

function modelCost(rows: Trial[]): ModelCost {
  return {
    n: rows.length,
    totalCost: sum(rows.map((t) => t.cost_usd)),
    medianCost: median(rows.map((t) => t.cost_usd)),
    medianWall: median(rows.map((t) => t.wall_s)),
    medianTurns: median(rows.map((t) => t.turns)),
    medianThinking: median(rows.map((t) => t.thinking_blocks)),
    denials: sum(rows.map((t) => t.denials)),
  };
}

export interface CostByModel {
  /** The 2,608 counted campaign trials. */
  campaign: Record<Model, ModelCost>;
  /** The same plus the 32 pilot rows, which are all Haiku. */
  all: Record<Model, ModelCost>;
  totalCampaign: number;
  totalAll: number;
  /** Each model's share of campaign spend. */
  campaignShare: Record<Model, number>;
}

export function costByModel(trials: Trial[]): CostByModel {
  const camp = byModel(trials.filter(isCampaign));
  const all = byModel(trials);
  const campaign = {} as Record<Model, ModelCost>;
  const withPilot = {} as Record<Model, ModelCost>;
  for (const m of MODELS) {
    campaign[m] = modelCost(camp[m]);
    withPilot[m] = modelCost(all[m]);
  }
  const totalCampaign = sum(MODELS.map((m) => campaign[m].totalCost));
  const campaignShare = {} as Record<Model, number>;
  for (const m of MODELS) campaignShare[m] = campaign[m].totalCost / totalCampaign;
  return { campaign, all: withPilot, totalCampaign, totalAll: sum(MODELS.map((m) => withPilot[m].totalCost)), campaignShare };
}

// ----------------------------------------------------------------- replica

export type ReplicaCondition = 'pilot' | 'harness' | 'room';

export interface ReplicaRow {
  condition: ReplicaCondition;
  label: string;
  run: string;
  n: number;
  features: FeatureShares;
  medianBash: number | null;
  medianDenials: number | null;
}

const REPLICA_LABEL: Record<ReplicaCondition, string> = {
  pilot: 'Pilot (harness, hand-run)',
  harness: 'Harness replica',
  room: 'Clean-room replica',
};

/** The same prompt and seed under three conditions: the pilot, the harness replay, the clean room. */
export function replicaTable(trials: Trial[]): ReplicaRow[] {
  const replica = trials.filter((t) => t.task === 'replica');
  const condition = (t: Trial): ReplicaCondition => (t.mode === 'pilot' ? 'pilot' : t.profile === 'harness' ? 'harness' : 'room');
  return (['pilot', 'harness', 'room'] as const).map((c) => {
    const rows = replica.filter((t) => condition(t) === c);
    return {
      condition: c,
      label: REPLICA_LABEL[c],
      run: rows[0]?.run ?? '',
      n: rows.length,
      features: featureShares(rows),
      medianBash: median(rows.map((t) => t.bash_calls)),
      medianDenials: median(rows.map((t) => t.denials)),
    };
  });
}

// --------------------------------------------------------------- sentences

export interface SentenceStep {
  step: number;
  text: string;
  added: string[];
  removed: string[];
  /** Exactly one word added and none removed. */
  ok: boolean;
}

export interface SentenceChain {
  seed: string;
  steps: SentenceStep[];
  final: string;
  kept: number;
  total: number;
}

export function sentenceChain(run: Run): SentenceChain {
  const steps = run.trials.map((t) => ({
    step: t.step,
    text: (outputOf(t) ?? t.answer_raw ?? '').trim(),
    added: t.added ?? [],
    removed: t.removed ?? [],
    ok: t.answer_ok === true,
  }));
  return {
    seed: seedOf('sentence').trim(),
    steps,
    final: steps[steps.length - 1]?.text ?? '',
    kept: steps.filter((s) => s.ok).length,
    total: steps.length,
  };
}

// ---------------------------------------------------------------- headline

export function headline(trials: Trial[] = loadAll().trials) {
  const campaign = trials.filter(isCampaign);
  const of = (m: Model) => trials.filter((t) => t.model === m);
  const sample = (task: string, m: Model) => trials.filter((t) => t.task === task && t.mode === 'sample' && t.model === m);
  const haikuCircle = sample('circle', 'haiku');
  const haikuArtifacts = of('haiku').filter((t) => isArtifact(t) && t.hex_count !== null);
  const uses = (hex: string) => shareOf(haikuArtifacts.filter((t) => t.hex_colors.includes(hex)).length, haikuArtifacts.length);
  const cost = costByModel(trials);

  const perModel = (task: string, value: string) => {
    const out = {} as Record<Model, Share>;
    for (const m of MODELS) out[m] = answerCount(trials.filter((t) => t.task === task && t.model === m), value);
    return out;
  };
  const pooled = (task: string, value: string, models: readonly Model[]) =>
    answerCount(trials.filter((t) => t.task === task && models.includes(t.model)), value);

  const opusSvg = sample('svg', 'opus');
  const sonnetCircle = sample('circle', 'sonnet');

  return {
    trialsCampaign: campaign.length,
    trialsAll: trials.length,
    costCampaign: cost.totalCampaign,
    costAll: cost.totalAll,
    runs: new Set(campaign.map((t) => t.run)).size,
    models: new Set(campaign.map((t) => t.model)).size,
    renders: trials.filter((t) => t.hasRender).length,
    // Haiku on the black circle, 32 independent samples.
    haikuCircleSample: {
      n: haikuCircle.length,
      glow: shareOf(haikuCircle.filter((t) => t.glow_or_shadow === true).length, haikuCircle.length),
      gradient: shareOf(haikuCircle.filter((t) => t.gradient_667eea === true).length, haikuCircle.length),
    },
    // Across every artifact trial Haiku touched: the purple gradient pair by hex.
    haikuArtifacts: { n: haikuArtifacts.length, hex667eea: uses('#667eea'), hex764ba2: uses('#764ba2') },
    digitSeven: { total: pooled('digit', '7', MODELS), byModel: perModel('digit', '7') },
    wordLantern: { fableAndOpus: pooled('word', 'lantern', ['fable', 'opus']), byModel: perModel('word', 'lantern') },
    opusSvgUnchanged: shareOf(opusSvg.filter((t) => t.unchanged).length, opusSvg.length),
    sonnetCircleUnchanged: shareOf(sonnetCircle.filter((t) => t.unchanged).length, sonnetCircle.length),
    fableCostShare: cost.campaignShare.fable,
    marginAt32: marginOfError(32),
  };
}
