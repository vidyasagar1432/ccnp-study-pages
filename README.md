# CCNP Enterprise (ENCOR 350-401) — Study Pages

Single-page, docs-style study pages for the **CCNP Enterprise** path, one HTML file per
level. Built with **Vue 3** and **Tailwind CSS**. No build step, no server, no
dependencies — open a page in a browser and it works, including offline.

```
index.html                    the level hub (all 31 levels, links to the published ones)
pages/00-networking-basics.html
pages/01-physical-layer.html
vendor/vue.global.prod.js     Vue 3.5.42 — offline fallback copy
tools/                        validation scripts + per-page config
```

## Open it

```sh
xdg-open index.html            # the level hub
xdg-open "pages/01-physical-layer.html"
```

Everything is client-side, so `file://` works. It also works over HTTP
(`python3 -m http.server`) if you prefer.

## Published levels

| Level | Page | Topics | Quiz |
|-------|------|--------|------|
| 00 | [Networking Basics](pages/00-networking-basics.html) | 7 | 18 questions |
| 01 | [Physical Layer](pages/01-physical-layer.html) | 12 | 21 questions |
| 02 | [Network Topologies](pages/02-network-topologies.html) | 9 | 20 questions |

The remaining levels (03–30) are listed on the hub as *planned*. Each one is ported
from the matching note set in the CCNP Obsidian vault, keeping the note structure:

> Overview → Core Concepts → Commands → Exam Traps → Quick Review Table → Related Notes → Glossary

## What every page gives you

- **Sticky sidebar** with the topics, grouped by theme, and a scroll-spy that follows
  the section you are reading
- **Live search** across topic titles, body text, and glossary terms, with a dropdown
  of matches that jumps to the topic
- **Collapsible blocks** — commands, exam traps, and review tables — plus an
  expand/collapse-all control in the header
- **Copy button** on every code block (Cisco CLI snippets)
- **Self-check quiz** with instant grading, per-question explanations, and a persisted
  best score; every question comes from the notes' exam traps
- **Studied-progress checklist** per topic with a percentage in the header
- **Dark / light theme** toggle, persisted, following the OS preference on first visit
- **Wiki-link chips** — `[[UTP]]` and `[[Radio Frequency|RF]]` from the notes are
  rendered as inline term chips that match the page glossary
- **Deep links** — `#t05` opens a topic and the URL updates as you scroll
- **Keyboard shortcuts** — `/` search, `t` theme, `e` expand/collapse all, `Esc` clear

Progress, theme, and best score are stored in `localStorage` under a per-page prefix
(`nb.*` for Level 00, `pl.*` for Level 01, `nt.*` for Level 02) so levels never
overwrite each other.

## Loading Vue

Vue 3 is loaded from a CDN with a fallback chain:

1. `cdn.jsdelivr.net`
2. `unpkg.com` (mirror)
3. `../vendor/vue.global.prod.js` (the copy in this repo, so it works offline)

If all three fail, the page shows a plain-HTML message instead of a blank screen.
Tailwind comes from `cdn.tailwindcss.com` (the Play CDN), so the first load needs a
network connection; it is cached by the browser afterwards. `index.html` has no
dependencies at all — it is plain CSS and works offline.

## Validating

Two independent checkers, both included, and both driven by one config file so a new
level needs no code change:

```sh
# 1. Static + headless render checks (structure, mustache/tag balance,
#    no same-element v-if+v-for, template compiles, script parses, renders,
#    and the expected state bindings are present)
python3 tools/check_html_vue.py

# 2. Real-browser end-to-end checks (index links, mount, search, quiz, theme,
#    progress, expand-all, no console errors, deep links, keyboard shortcuts,
#    and the offline fallback path)
node tools/browser-check.mjs
```

Both accept explicit pages too:

```sh
python3 tools/check_html_vue.py pages/01-physical-layer.html
node tools/browser-check.mjs pages/01-physical-layer.html
```

`tools/browser-check.mjs` drives headless Chromium over the DevTools Protocol using
only Node built-ins — no npm packages required.

`tools/pages.config.json` holds the per-page expectations (topic count, quiz size,
glossary size, search term, deep-link target, `localStorage` prefix, expected state
bindings) and the total level count.

## Adding a level

1. Copy the closest existing page in `pages/` and replace its content block — the
   `const heroIntro`, `const topics`, `const groups`, `const glossary` and `const quiz`
   definitions inside `setup()`. Everything else (layout, search, quiz, progress,
   theme, deep links) is shared.
2. Give the page a `localStorage` prefix of your own (e.g. `pl2.*`) so it does not
   clash with the other levels.
3. Add an entry to `tools/pages.config.json` and to the `LEVELS` array in `index.html`.
4. Run both checkers.

The `KEYS` constant near the top of `setup()` is where the storage prefix lives:

```js
const KEYS = { theme: 'pl.theme', done: 'pl.done', best: 'pl.quizbest' };
```

## Source

Content is ported from the CCNP Enterprise study notes in the `CCNP` Obsidian vault
(`Level 00 - Networking Basics`, `Level 01 - Physical Layer`, …). This repository is a
standalone read-only copy of that content; edits to the vault notes are not reflected
here.

## License

The page content follows the study notes. Vue is MIT licensed (see the header of
`vendor/vue.global.prod.js`).
