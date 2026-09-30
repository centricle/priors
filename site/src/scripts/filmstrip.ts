/**
 * The filmstrip.
 *
 * Every [data-filmstrip] on the page is one chain run. The component renders
 * the starting step and the whole strip of thumbnails as plain markup; this
 * script reveals the controls and keeps one number, the current index, in sync
 * with the frame, the readout, the sparkline, the slider and the strip.
 *
 * Playback runs at six steps a second (two under reduced motion) and stops at
 * the last step. It also stops when the filmstrip scrolls out of view or the
 * tab is hidden, and whenever the reader takes the controls.
 */

interface Step {
  step: number;
  render: string;
  thumb: string;
  lines: number | null;
  /** Lines with separators ("1,092"), and as a phrase ("1 line"), built by the page. */
  linesText: string | null;
  linesLabel: string;
  cost: string | null;
  model: string;
  flags: string[];
  url: string;
}

const pad3 = (n: number) => String(n).padStart(3, '0');

document.querySelectorAll<HTMLElement>('[data-filmstrip]').forEach(init);

function init(el: HTMLElement) {
  const dataEl = el.querySelector<HTMLScriptElement>('script[type="application/json"]');
  if (!dataEl) return;
  const steps: Step[] = JSON.parse(dataEl.textContent || '[]');
  if (steps.length === 0) return;
  const last = steps.length - 1;

  const q = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel);
  const frame = q('[data-frame]')!;
  const layers = [q<HTMLImageElement>('[data-layer="a"]')!, q<HTMLImageElement>('[data-layer="b"]')!];
  const noEl = q('[data-no]')!;
  const modelEl = q('[data-model]')!;
  const linesEl = q('[data-lines]')!;
  const costEl = q('[data-cost]')!;
  const flagEls = [...el.querySelectorAll<HTMLElement>('[data-flag]')];
  const openEl = q<HTMLAnchorElement>('[data-open]')!;
  const plot = q('[data-plot]');
  const cursor = q('[data-cursor]');
  const dot = q('[data-dot]');
  const controls = q('[data-controls]')!;
  const prev = q<HTMLButtonElement>('[data-prev]')!;
  const next = q<HTMLButtonElement>('[data-next]')!;
  const play = q<HTMLButtonElement>('[data-play]')!;
  const range = q<HTMLInputElement>('[data-range]')!;
  const strip = q('[data-strip]')!;
  const cells = [...strip.querySelectorAll<HTMLAnchorElement>('[data-cell]')];

  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const lines = steps.map((s) => s.lines ?? 0);
  const max = Math.max(...lines, 1);

  let i = Math.min(Math.max((Number(el.dataset.start) || 1) - 1, 0), last);
  let dir = 1;
  let front = 0;
  let token = 0;
  let timer = 0;
  const loaded = new Map<string, HTMLImageElement>();

  // ---- frame

  function swap(s: Step) {
    const mine = ++token;
    if (!s.render) {
      layers.forEach((l) => l.classList.remove('is-front'));
      return;
    }
    const back = layers[1 - front];
    const commit = () => {
      if (mine !== token) return;
      back.classList.add('is-front');
      layers[front].classList.remove('is-front');
      front = 1 - front;
    };
    const shown = layers[front];
    if (shown.classList.contains('is-front') && shown.getAttribute('src') === s.render) return;
    if (back.getAttribute('src') !== s.render) back.src = s.render;
    // decode() settles once the bitmap is ready to paint, so the old frame
    // stays up until the new one can replace it with no blank in between.
    back.decode().then(commit, commit);
  }

  function preload(from: number, ahead: number) {
    for (let k = 1; k <= ahead; k++) {
      const s = steps[from + dir * k];
      if (!s || !s.render || loaded.has(s.render)) continue;
      const img = new Image();
      img.decoding = 'async';
      img.src = s.render;
      loaded.set(s.render, img);
    }
  }

  // ---- strip

  function reveal(cell: HTMLElement) {
    const view = strip.clientWidth;
    const left = cell.offsetLeft;
    const w = cell.offsetWidth;
    const from = strip.scrollLeft;
    if (left >= from + w && left + w <= from + view - w) return;
    strip.scrollTo({ left: Math.max(0, left - (view - w) / 2), behavior: 'auto' });
  }

  // ---- paint

  function paint() {
    const s = steps[i];
    const n = pad3(s.step);
    range.value = String(i + 1);
    range.setAttribute('aria-valuetext', `step ${s.step} of ${steps[last].step}, ${s.model}, ${s.linesLabel}`);
    noEl.textContent = n;
    modelEl.textContent = s.model;
    linesEl.textContent = s.linesText ?? 'none';
    costEl.textContent = s.cost ?? 'none';
    for (const f of flagEls) f.hidden = !s.flags.includes(f.dataset.flag!);
    openEl.href = s.url;
    frame.setAttribute('aria-label', `step ${s.step} render, ${s.model}, ${s.linesLabel}`);

    if (cursor && dot) {
      const x = last ? (i / last) * 100 : 0;
      (cursor as HTMLElement).style.left = `${x}%`;
      (dot as HTMLElement).style.left = `${x}%`;
      (dot as HTMLElement).style.top = `${((max - lines[i]) / max) * 100}%`;
    }

    cells.forEach((c, k) => (k === i ? c.setAttribute('aria-current', 'step') : c.removeAttribute('aria-current')));
    reveal(cells[i]);

    prev.disabled = i === 0;
    next.disabled = i === last;
    swap(s);
    preload(i, timer ? 8 : 3);
  }

  function go(to: number) {
    to = Math.min(Math.max(to, 0), last);
    if (to === i) return;
    dir = to > i ? 1 : -1;
    i = to;
    paint();
  }

  // ---- play

  function tick() {
    go(i + 1);
    if (i >= last) pause();
  }
  function start() {
    if (i >= last) go(0);
    dir = 1;
    el.setAttribute('data-playing', '');
    play.textContent = 'pause';
    timer = window.setInterval(tick, reduce.matches ? 500 : 1000 / 6);
    preload(i, 8);
  }
  function pause() {
    if (timer) clearInterval(timer);
    timer = 0;
    el.removeAttribute('data-playing');
    play.textContent = 'play';
  }
  const toggle = () => (timer ? pause() : start());

  // ---- events

  play.addEventListener('click', toggle);
  prev.addEventListener('click', () => (pause(), go(i - 1)));
  next.addEventListener('click', () => (pause(), go(i + 1)));
  range.addEventListener('input', () => (pause(), go(Number(range.value) - 1)));

  strip.addEventListener('click', (e) => {
    const me = e as MouseEvent;
    if (me.button !== 0 || me.metaKey || me.ctrlKey || me.shiftKey || me.altKey) return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]');
    if (!cell) return;
    e.preventDefault();
    pause();
    go(Number(cell.dataset.i));
  });
  strip.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft') go(i - 1);
    else if (k === 'ArrowRight') go(i + 1);
    else if (k === 'Home') go(0);
    else if (k === 'End') go(last);
    else if (k === ' ') toggle();
    else return;
    if (k !== ' ') pause();
    e.preventDefault();
  });

  if (plot) {
    let dragging = false;
    const scrub = (e: PointerEvent) => {
      const r = plot.getBoundingClientRect();
      const f = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
      go(Math.round(f * last));
    };
    plot.addEventListener('pointerdown', (e) => {
      dragging = true;
      plot.setPointerCapture(e.pointerId);
      pause();
      scrub(e);
    });
    plot.addEventListener('pointermove', (e) => dragging && scrub(e));
    const end = () => (dragging = false);
    plot.addEventListener('pointerup', end);
    plot.addEventListener('pointercancel', end);
  }

  // Do not keep flipping frames nobody can see.
  new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) pause();
  }).observe(el);
  document.addEventListener('visibilitychange', () => document.hidden && pause());

  // ---- go live

  strip.tabIndex = 0;
  strip.setAttribute('role', 'group');
  cells.forEach((c) => c.setAttribute('tabindex', '-1'));
  controls.hidden = false;
  paint();
}
