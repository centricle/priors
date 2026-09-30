/**
 * "Run it": swap a trial's static render for the live page.
 *
 * Markup contract, on the trial page:
 *
 *   <div data-runit data-kind="html|svg">
 *     <div data-frame> <img ...> </div>
 *     <button data-run hidden>run it</button>
 *   </div>
 *
 * The source is read from the page's own source view (`code[data-code]`,
 * rendered by SourceView.astro), so the file is shipped once per page.
 *
 * The file goes in a sandboxed iframe with no origin (allow-scripts only, no
 * same-origin), so whatever the model wrote can run but cannot reach this
 * page, its storage or its cookies. The iframe is a fixed 800x800, the size
 * the renders were taken at, scaled down with a transform to fit the frame.
 */

const BOX = 800;

for (const root of document.querySelectorAll<HTMLElement>('[data-runit]')) init(root);

function init(root: HTMLElement) {
  const frame = root.querySelector<HTMLElement>('[data-frame]');
  const code = document.querySelector<HTMLElement>('code[data-code]');
  const btn = root.querySelector<HTMLButtonElement>('[data-run]');
  if (!frame || !code || !btn) return;

  const kind = root.dataset.kind ?? 'html';
  let live: HTMLIFrameElement | null = null;
  let watch: ResizeObserver | null = null;

  const fit = () => {
    if (live) live.style.transform = `scale(${frame.clientWidth / BOX})`;
  };

  // An SVG file is a document of its own; inline in a page it needs a body
  // with no margin and no XML prolog (the HTML parser reads that as a comment).
  const wrapSvg = (svg: string) =>
    '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style>' +
    svg.replace(/^\s*<\?xml[^>]*\?>/i, '').replace(/<!doctype[^>]*>/i, '');

  const start = () => {
    const source = code.textContent ?? '';
    live = document.createElement('iframe');
    live.setAttribute('sandbox', 'allow-scripts');
    live.setAttribute('title', 'The output, running live');
    live.width = String(BOX);
    live.height = String(BOX);
    live.style.cssText = `position:absolute;left:0;top:0;width:${BOX}px;height:${BOX}px;border:0;background:#fff;transform-origin:0 0`;
    live.srcdoc = kind === 'svg' ? wrapSvg(source) : source;
    frame.append(live);
    frame.dataset.live = 'true';
    btn.textContent = 'stop';
    fit();
    watch = new ResizeObserver(fit);
    watch.observe(frame);
  };

  const stop = () => {
    watch?.disconnect();
    watch = null;
    live?.remove();
    live = null;
    delete frame.dataset.live;
    btn.textContent = 'run it';
  };

  btn.hidden = false;
  btn.addEventListener('click', () => (live ? stop() : start()));
}
