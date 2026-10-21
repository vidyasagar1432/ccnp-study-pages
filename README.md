# CCNP Enterprise (ENCOR 350-401) — Study Pages

Single-page, docs-style study pages for the **CCNP Enterprise** path, one HTML file per
level. Built with **Vue 3** and **Tailwind CSS**. No build step, no server, no
dependencies — open a page in a browser and it works, including offline.

```
index.html                    the level hub (all 31 levels, links to the published ones)
pages/00-networking-basics.html
pages/01-physical-layer.html
pages/02-network-topologies.html
pages/03-osi-tcpip.html
pages/04-ethernet-switching.html
pages/05-ipv4.html
pages/06-ipv6.html
pages/07-vlan-technologies.html
pages/08-stp.html
pages/09-routing-fundamentals.html
pages/10-ospf.html
pages/11-eigrp.html
pages/12-bgp.html
pages/13-route-redistribution.html
vendor/vue.global.prod.js     Vue 3.5.42 — offline fallback copy
vendor/tailwindcss.js         Tailwind Play CDN 3.4.17 — offline fallback copy
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
| 03 | [OSI & TCP/IP](pages/03-osi-tcpip.html) | 6 | 20 questions |
| 04 | [Ethernet & Switching](pages/04-ethernet-switching.html) | 13 | 32 questions |
| 05 | [IPv4](pages/05-ipv4.html) | 16 | 33 questions |
| 06 | [IPv6](pages/06-ipv6.html) | 13 | 36 questions |
| 07 | [VLAN Technologies](pages/07-vlan-technologies.html) | 11 | 39 questions |
| 08 | [Spanning Tree Protocol](pages/08-stp.html) | 16 | 42 questions |
| 09 | [Routing Fundamentals](pages/09-routing-fundamentals.html) | 12 | 47 questions |
| 10 | [OSPF](pages/10-ospf.html) | 15 | 54 questions |
| 11 | [EIGRP](pages/11-eigrp.html) | 11 | 46 questions |
| 12 | [BGP](pages/12-bgp.html) | 14 | 56 questions |
| 13 | [Route Redistribution](pages/13-route-redistribution.html) | 8 | 24 questions |

The remaining levels (14–30) are listed on the hub as *planned*. Each one is ported
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
(`nb.*` for Level 00, `pl.*` for Level 01, `nt.*` for Level 02, `osi.*` for Level 03,
`sw.*` for Level 04, `ip4.*` for Level 05, `v6.*` for Level 06, `vl.*` for Level 07, `stp.*` for Level 08, `rf.*` for Level 09, `os.*` for Level 10, `ei.*` for Level 11, `bg.*` for Level 12, `rd.*` for Level 13) so
levels never overwrite each other.

## Loading Vue and Tailwind

Both libraries load from a CDN with a fallback chain, and every source gets a 6 second
timeout so a slow host can never stall the page:

**Vue 3**

1. `cdn.jsdelivr.net`
2. `unpkg.com` (mirror)
3. `../vendor/vue.global.prod.js` (the copy in this repo, so it works offline)

**Tailwind CSS** (the Play CDN)

1. `cdn.tailwindcss.com`
2. `../vendor/tailwindcss.js` (the copy in this repo)

If Vue cannot be loaded at all, the page shows a plain-HTML message instead of a blank
screen. With the network off, a page still renders **fully styled** — the vendored
copies of both libraries are used, and the browser check verifies this by blocking every
CDN and asserting that the page is still styled. `index.html` has no dependencies at all
— it is plain CSS and works offline.

Tailwind's config (`darkMode: 'class'`, the font stack) is set *before* the loader
runs, so it applies to whichever copy of Tailwind ends up loading.

## Validating

Two independent checkers, both included, and both driven by one config file so a new
level needs no code change:

```sh
# 1. Static + headless render checks (structure, mustache/tag balance,
#    no same-element v-if+v-for, template compiles, script parses, renders,
#    and the expected state bindings are present)
python3 tools/check_html_vue.py

# 2. Real-browser end-to-end checks (index links, mount, search, quiz, theme,
#    progress, expand-all, no console errors, phone-sized layout, deep links,
#    keyboard shortcuts, and the offline fallback path)
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
   `const heroIntro`, `const topics`, `const GROUPS`, `const glossary` and `const quiz`
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

Each topic in `topics[]` looks like this — the field names are fixed by the shared
template:

```js
{
  id: 't01', num: '01', group: 'models', title: 'OSI Model',
  blurb: 'Seven layers, their functions, PDUs and devices',
  overview: '…',            // rendered with md()
  keyIdea: '…',             // rendered with md()
  sections: [ … ],          // { h, kind: 'list' | 'para' | 'table' | 'code', … }
  commands: [ { label, code } ],
  traps: [ '…' ],
  table: { cols, rows },    // the quick review table
  related: [ { t, d } ],
  glossary: [ 'OSI Model' ] // must exist in the page glossary
}
```

`md()` supports `**bold**`, ``%%inline code%%`` and `[[Term]]` / `[[Term|label]]`
wiki-link chips (the chips are decorative; only a topic's `glossary:` array is
clickable and it must match the page glossary exactly). Keep chip labels short — long
ones force the chip to wrap on a phone.

The `code` section kind renders a plain monospace block and is used for the ASCII
diagrams in the notes. A `code` block is a bare `<pre>`, not a `<pre><code>`, so it is
never counted as a CLI command block by the checker.

Two authoring rules the checker enforces indirectly:

- Do not use backticks in prose. `md()` only understands `**bold**`, `%%code%%` and
  `[[wiki links]]`; a backtick is rendered literally. Inside a `code:` block backticks
  are fine.
- Give every section an `h` (a short heading). A section without one still renders, but
  it leaves an empty heading above it.

The `codeMarker` in `tools/pages.config.json` must appear in the **first** `pre code`
block on the page, which is the first command block of the first topic.

## Source

Content is ported from the CCNP Enterprise study notes in the `CCNP` Obsidian vault
(`Level 00 - Networking Basics`, `Level 01 - Physical Layer`, …). This repository is a
standalone read-only copy of that content; edits to the vault notes are not reflected
here.

## License

The page content follows the study notes. Vue is MIT licensed (see the header of
`vendor/vue.global.prod.js`) and the Tailwind Play CDN is MIT licensed (see the header
of `vendor/tailwindcss.js`).
