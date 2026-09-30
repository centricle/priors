// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Served through a path-preserving proxy at centricle.com/curios/priors/.
// `base` prefixes every URL Astro emits; scripts/stage-base.mjs moves the
// build under the same prefix so the CDN finds the files where the HTML
// asks for them. Internal links go through src/lib/href.mjs.
export default defineConfig({
  output: 'static',
  compressHTML: true,
  site: 'https://centricle.com',
  base: '/curios/priors',
  trailingSlash: 'always',
  // One lastmod for every URL: the corpus is frozen, so a page changes only when
  // the site is rebuilt, and the build date is the honest answer.
  integrations: [sitemap({ lastmod: new Date() })],
  server: { port: 7064, allowedHosts: true },
  devToolbar: { enabled: false },
});
