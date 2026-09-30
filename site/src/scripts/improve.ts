/**
 * The improve button.
 *
 * The hero starts as the seed: a black circle on white, the file the models
 * were handed. Each press swaps in one real output from the selected model's
 * circle samples, chosen at random without repeating until the run is used
 * up. Nothing is simulated; every frame is a render of a counted trial, and
 * the caption links to it.
 *
 * The page builds every string a caption says (labels, line count, cost), so
 * this script only joins them. The one number it computes is the running line
 * under the caption, from the same picks.
 */

interface Pick {
  run: string;
  step: number;
  n: number;
  /** "37 lines", already counted and pluralized. */
  lines: string;
  /** "$0.021", already rounded. */
  cost: string;
  /** What changed, from changeLabels() in stats.ts. */
  labels: string[];
  /** The render is pixel-identical to the seed's, whether or not the file changed. */
  samePicture: boolean;
  render: string;
  url: string;
}

type Model = 'haiku' | 'sonnet' | 'opus' | 'fable';

interface Data {
  labels: Record<Model, string>;
  picks: Record<Model, Pick[]>;
  seedCaption: string;
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
  // A frame from a press is on screen, so the model buttons would disagree with it.
  let shown = false;
  const bags: Partial<Record<Model, Pick[]>> = {};
  const last: Partial<Record<Model, Pick>> = {};
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

  // Draw from the end of the bag. When the bag refills, the first draw must not
  // be the one just shown, or a press would repeat the last frame: swap it
  // with the bottom of the bag, which is drawn last.
  function draw(): Pick {
    let bag = bags[model];
    if (!bag || bag.length === 0) {
      bag = bags[model] = shuffle(data.picks[model]);
      const top = bag.length - 1;
      if (top > 0 && bag[top] === last[model]) [bag[top], bag[0]] = [bag[0], bag[top]];
    }
    return (last[model] = bag.pop()!);
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
    const bits = [`trial ${String(p.step).padStart(3, '0')} of ${p.n}`, data.labels[model], p.lines, p.cost, ...p.labels];
    return bits.join(' · ');
  }

  // "same picture in 32 of 32 Fable trials": how often this model's output
  // renders exactly as the seed did, counted over all of its picks.
  function tally(): string {
    const picks = data.picks[model];
    const same = picks.filter((p) => p.samePicture).length;
    return `same picture in ${same} of ${picks.length} ${data.labels[model].split(' ')[0]} trials`;
  }

  // Both nodes go in together so a screen reader announces one update per press.
  function setCaption(first: string | Node, second = '') {
    const line = document.createElement('span');
    line.className = 'tally';
    line.textContent = second;
    caption.replaceChildren(first, line);
  }

  // Each press gets a ticket. A cached image can fire `onload` after the
  // synchronous path already swapped, and a slow one can land after a newer
  // press; both are ignored, so the front layer only ever changes once per press.
  // Returning to the seed takes a ticket too, so a slow image cannot land on it.
  let ticket = 0;

  function show(p: Pick) {
    const back = 1 - front;
    const img = layers[back];
    const mine = ++ticket;
    let done = false;
    const swap = () => {
      if (done || mine !== ticket) return;
      done = true;
      const text = describe(p);
      // The front layer speaks for the frame; the one behind it stays silent.
      layers[back].alt = text;
      layers[front].alt = '';
      layers[back].classList.add('is-front');
      layers[front].classList.remove('is-front');
      seed.classList.add('is-hidden');
      front = back;
      const a = document.createElement('a');
      a.href = p.url;
      a.textContent = text;
      setCaption(a, tally());
      if (p.samePicture) frame.dataset.mark = 'same picture';
      else delete frame.dataset.mark;
      shown = true;
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
    const switched = m !== model;
    model = m;
    seg.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.model === m)));
    preload(m);
    // The frame and caption belong to the model that made them.
    if (switched && shown) toSeed();
  }

  function toSeed() {
    ticket++;
    shown = false;
    layers.forEach((l) => {
      l.classList.remove('is-front');
      l.alt = '';
    });
    seed.classList.remove('is-hidden');
    delete frame.dataset.mark;
    setCaption(data.seedCaption);
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
