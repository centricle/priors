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
import { origin, prefixes } from '../../cdn/config.mjs';

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

/**
 * The URL of a file the site serves but does not host. Renders and thumbs
 * (`/r/`, `/t/`) come from the Worker in cdn/config.mjs in a production
 * build, because every byte Netlify sends counts against a team cap and
 * asset requests on the Worker are free. In dev they stay local, from the
 * copies prebuild.mjs --dev puts under public/. Anything under no served
 * prefix is an ordinary href(), so this is safe to call on any file path.
 *
 *   asset('/t/run/001.webp')  -> https://priors-assets.<sub>.workers.dev/t/run/001.webp   (build)
 *                             -> /curios/priors/t/run/001.webp                            (dev)
 *   asset('/og.png')          -> /curios/priors/og.png                                    (always)
 *
 * scripts/check-assets.mjs fails the build on a render path that did not
 * come through here.
 */
const ORIGIN = origin.replace(/\/+$/, '');

export function asset(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (import.meta.env.DEV || !prefixes.some((prefix) => p.startsWith(prefix))) return href(p);
  return `${ORIGIN}${p}`;
}
