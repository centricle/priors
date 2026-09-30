/**
 * Build an internal link that respects the site's base path.
 *
 * Astro's `base` prefixes the routes it generates, but it does NOT rewrite
 * string literals in your markup: a hardcoded `href="/runs"` keeps pointing at
 * the domain root and 404s. Every internal link and asset reference on this site
 * goes through here so the prefix lives in exactly one place, and moving the
 * site is a config change rather than a sweep.
 *
 * Page paths get a trailing slash (the site builds with `trailingSlash:
 * 'always'`); paths with a file extension, a query or a hash are left alone.
 *
 *   href('/')                 -> /curios/priors/
 *   href('/runs')             -> /curios/priors/runs/
 *   href('/runs/x/001')       -> /curios/priors/runs/x/001/
 *   href('/t/run/001.webp')   -> /curios/priors/t/run/001.webp
 *   href('/method#room')      -> /curios/priors/method/#room
 */
export function href(path = '/') {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  let rest = path.startsWith('/') ? path : `/${path}`;
  const m = rest.match(/^([^?#]*)(.*)$/);
  let p = m[1];
  const tail = m[2];
  const last = p.split('/').pop();
  if (!p.endsWith('/') && !last.includes('.')) p += '/';
  rest = p + tail;
  return `${base}${rest}`;
}
