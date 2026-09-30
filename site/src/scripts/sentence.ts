/**
 * The sentence scrubber.
 *
 * Every [data-sentence] on the page is one run of the sentence task. The
 * component renders every step's sentence, stacked, with the current one
 * visible; this script reveals the controls and moves the visible step.
 */

interface Step {
  step: number;
  added: string[];
  removed: string[];
  ok: boolean;
  model: string;
}

const pad3 = (n: number) => String(n).padStart(3, '0');

document.querySelectorAll<HTMLElement>('[data-sentence]').forEach(init);

function init(el: HTMLElement) {
  const dataEl = el.querySelector<HTMLScriptElement>('script[type="application/json"]');
  if (!dataEl) return;
  const steps: Step[] = JSON.parse(dataEl.textContent || '[]');
  if (steps.length === 0) return;
  const last = steps.length - 1;

  const q = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel);
  const lines = [...el.querySelectorAll<HTMLElement>('.line')];
  const noEl = q('[data-no]')!;
  const modelEl = q('[data-model]');
  const removed = q('[data-removed]')!;
  const removedWords = q('[data-removed-words]')!;
  const rule = q('[data-rule]')!;
  const out = q('[data-out]')!;
  const controls = q('[data-controls]')!;
  const prev = q<HTMLButtonElement>('[data-prev]')!;
  const next = q<HTMLButtonElement>('[data-next]')!;
  const range = q<HTMLInputElement>('[data-range]')!;

  let i = Math.min(Math.max((Number(el.dataset.start) || steps.length) - 1, 0), last);

  function paint() {
    const s = steps[i];
    lines.forEach((l, k) => l.classList.toggle('is-on', k === i));
    range.value = String(i + 1);
    range.setAttribute('aria-valuetext', `step ${s.step} of ${steps[last].step}: ${lines[i].textContent}`);
    noEl.textContent = pad3(s.step);
    out.textContent = `step ${pad3(s.step)}`;
    if (modelEl) modelEl.textContent = s.model;

    if (s.removed.length) {
      removedWords.textContent = s.removed.join(' ');
      removed.removeAttribute('data-empty');
    } else {
      removed.setAttribute('data-empty', '');
    }

    rule.textContent = s.ok
      ? 'one word added, none removed'
      : s.added.length === 0 && s.removed.length === 0
        ? 'rule broken: nothing added'
        : `rule broken: +${s.added.length} / -${s.removed.length}`;
    rule.classList.toggle('is-broken', !s.ok);

    prev.disabled = i === 0;
    next.disabled = i === last;
  }

  function go(to: number) {
    to = Math.min(Math.max(to, 0), last);
    if (to === i) return;
    i = to;
    paint();
  }

  prev.addEventListener('click', () => go(i - 1));
  next.addEventListener('click', () => go(i + 1));
  range.addEventListener('input', () => go(Number(range.value) - 1));

  controls.hidden = false;
  paint();
}
