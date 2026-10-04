# renders

One WebP per artifact trial, `renders/<run>/NNN.webp`, made by
`bin/render.sh` with `bin/shot.sh`: headless Chrome, offline, an 800x800
viewport, prefers-color-scheme pinned to light, 2000 ms of virtual time, then
`cwebp -q 80`.

- Chrome: Google Chrome 154.0.8037.58
- Rendered: 2026-09-29, 2026-10-04

Renders only reproduce on the same Chrome build and fonts. Static pages render
byte-identically. Animated pages can differ from one render to the next
(animation phase). Pages flagged `nondeterministic` in a tally (`data/*.csv`)
call Math.random or the clock; a render may vary.

`pilot-import/` holds fresh renders of the pilot's outputs, runs 23-26
included. They are not the pilot's original window captures, which were grabs of
a real desktop and are not published.
