/**
 * The improve button.
 *
 * The hero starts as the seed: a black circle on white, the file the models
 * were handed. Each press swaps in one real output from the selected model's
 * circle samples, chosen at random without repeating until the run is used
 * up. Nothing is simulated; every frame is a render of a counted trial, and
 * the caption links to it.
 */

interface Pick {
  run: string;
  step: number;
  n: number;
  lines: number;
  cost: number;
  features: string[];
  unchanged: boolean;
  render: string;
  url: string;
}

type Model = 'haiku' | 'sonnet' | 'opus' | 'fable';

interface Data {
  labels: Record<Model, string>;
  picks: Record<Model, Pick[]>;
  seedLines: number;
}

const root = document.querySelector<HTMLElement>('[data-improve]');
if (root) init(root);

function init(el: HTMLElement) {
  const dataEl = el.querySelector<HTMLScriptElement>('script[type="application/json"]');
  if (!dataEl) return;
  const data: Data = JSON.parse(dataEl.textContent || '{}');

  const frame = el.querySelector<HTMLElement>('[data-frame]')!;
  const seed = el.querySelector<HTMLElement>('[data-seed]')!;
  const layers = [
    el.querySelector<HTMLImageElement>('[data-layer="a"]')!,
    el.querySelector<HTMLImageElement>('[data-layer="b"]')!,
  ];
  const caption = el.querySelector<HTMLElement>('[data-caption]')!;
  const button = el.querySelector<HTMLButtonElement>('[data-go]')!;
  const reset = el.querySelector<HTMLButtonElement>('[data-reset]')!;
  const seg = el.querySelectorAll<HTMLButtonElement>('[data-model]');
  const count = el.querySelector<HTMLElement>('[data-count]');

  let model: Model = 'haiku';
  let front = 0;
  let presses = 0;
  const bags: Partial<Record<Model, Pick[]>> = {};
  const preloaded = new Set<string>();

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function shuffle<T>(a: T[]): T[] {
    const b = a.slice();
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  }

  function draw(): Pick {
    let bag = bags[model];
    if (!bag || bag.length === 0) bag = bags[model] = shuffle(data.picks[model]);
    return bag.pop()!;
  }

  function preload(m: Model) {
    for (const p of data.picks[m]) {
      if (preloaded.has(p.render)) continue;
      preloaded.add(p.render);
      const img = new Image();
      img.decoding = 'async';
      img.src = p.render;
    }
  }

  function describe(p: Pick): string {
    const label = data.labels[model];
    const bits = [`trial ${String(p.step).padStart(3, '0')} of ${p.n}`, label, `${p.lines} lines`, `$${p.cost.toFixed(3)}`];
    if (p.unchanged) bits.push('unchanged');
    else if (p.features.length) bits.push(...p.features);
    else bits.push('tidied; still a black circle');
    return bits.join(' · ');
  }

  // Each press gets a ticket. A cached image can fire `onload` after the
  // synchronous path already swapped, and a slow one can land after a newer
  // press; both are ignored, so the front layer only ever changes once per press.
  let ticket = 0;

  function show(p: Pick) {
    const back = 1 - front;
    const img = layers[back];
    const mine = ++ticket;
    let done = false;
    const swap = () => {
      if (done || mine !== ticket) return;
      done = true;
      layers[back].classList.add('is-front');
      layers[front].classList.remove('is-front');
      seed.classList.add('is-hidden');
      front = back;
      caption.innerHTML = '';
      const a = document.createElement('a');
      a.href = p.url;
      a.textContent = describe(p);
      caption.appendChild(a);
      frame.classList.toggle('is-still', p.unchanged);
    };
    img.onload = swap;
    if (!img.src.endsWith(p.render)) img.src = p.render;
    if (img.complete && img.naturalWidth) swap();
  }

  function press() {
    presses++;
    if (count) count.textContent = String(presses);
    button.classList.add('is-pressed');
    setTimeout(() => button.classList.remove('is-pressed'), reduce ? 0 : 160);
    show(draw());
    reset.hidden = false;
  }

  function setModel(m: Model) {
    model = m;
    seg.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.model === m)));
    preload(m);
  }

  function toSeed() {
    layers.forEach((l) => l.classList.remove('is-front'));
    seed.classList.remove('is-hidden');
    frame.classList.remove('is-still');
    caption.textContent = `seed · 0.html · ${data.seedLines} lines · a black circle`;
    reset.hidden = true;
  }

  button.addEventListener('click', press);
  reset.addEventListener('click', toSeed);
  seg.forEach((b) => b.addEventListener('click', () => setModel(b.dataset.model as Model)));
  button.addEventListener('pointerenter', () => preload(model), { once: true });
  button.addEventListener('focus', () => preload(model), { once: true });

  setModel(model);
  button.disabled = false;
}
