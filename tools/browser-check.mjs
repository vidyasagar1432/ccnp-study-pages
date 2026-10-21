#!/usr/bin/env node
/**
 * browser-check.mjs — end-to-end smoke test for the study pages.
 *
 * Drives a real headless Chromium over the DevTools Protocol (no npm deps,
 * uses Node's built-in WebSocket + fetch) and asserts that a page actually
 * mounts and that its interactive features work:
 *
 *   1. the Vue app mounts and every topic section renders
 *   2. the sidebar / search filter narrows the visible topics
 *   3. the quiz grades answers and reports a score
 *   4. the theme toggle flips the dark class
 *   5. the studied-progress counter persists to localStorage
 *   6. the offline path works: with the CDNs blocked, the vendored Vue copy
 *      is used and the page still mounts
 *   7. deep links land on the right section and the sidebar highlights it
 *   8. the keyboard shortcuts work
 *
 * Per-page expectations (topic counts, quiz size, search term, deep-link
 * target, localStorage prefix) come from tools/pages.config.json, so a new
 * level only needs an entry there — not a code change.
 *
 * Usage:
 *   node tools/browser-check.mjs                 # checks every page in the config
 *   node tools/browser-check.mjs pages/01-*.html # checks specific pages
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '..');
const CONFIG_PATH = join(REPO, 'tools', 'pages.config.json');
const PORT = 9333;
const CHROME = ['chromium', 'chromium-browser', 'google-chrome'].find((c) => {
  try { return existsSync(`/usr/bin/${c}`); } catch { return false; }
});

let failures = 0;          // reset for every page
let totalFailures = 0;
const ok = (...a) => console.log('  [ok]   ', ...a);
const fail = (...a) => { failures++; console.log('  [FAIL] ', ...a); };
const section = (t) => console.log(`\n${t}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ CDP --- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else res(msg.result);
        return;
      }
      // Capture anything the page complains about, so silent failures are loud.
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push('EXCEPTION: ' + (d.exception?.description || d.text));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push('CONSOLE ERROR: ' + msg.params.args.map(a => a.value ?? a.description).join(' '));
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        const e = msg.params.entry;
        // Tailwind's Play CDN always logs a production warning; not an error.
        if (!/should not be used in production/.test(e.text)) {
          this.errors.push('LOG ERROR: ' + e.text + (e.url ? ' (' + e.url + ')' : ''));
        }
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP websocket failed: ' + url)), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'evaluate threw');
    }
    return r.result.value;
  }
}

/* -------------------------------------------------------------- browser --- */

// Every launch gets its own debugging port, otherwise a previous instance
// that is still shutting down can be mistaken for the new one.
let nextPort = PORT;

async function launch(extraArgs = []) {
  const port = nextPort++;
  const profile = mkdtempSync(join(tmpdir(), 'nb-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--mute-audio',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    ...extraArgs, 'about:blank'
  ], { stdio: 'ignore' });

  let exited = false;
  proc.on('exit', () => { exited = true; });

  for (let i = 0; i < 100; i++) {
    if (exited) break;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const info = await r.json();
        // Confirm this is the browser we just started.
        if (String(info['User-Agent'] || '').includes('HeadlessChrome') || info.webSocketDebuggerUrl) {
          return { proc, profile, port };
        }
      }
    } catch { /* not up yet */ }
    await sleep(100);
  }
  proc.kill('SIGKILL');
  throw new Error('Chromium did not expose the DevTools endpoint on port ' + port);
}

async function openPage(url, port = nextPort - 1) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error('could not open target: ' + res.status);
  const target = await res.json();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

/* ----------------------------------------------------------------- test --- */

async function waitFor(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await cdp.evaluate(expression)) return true; } catch { /* not ready */ }
    await sleep(120);
  }
  return false;
}

const mountedExpr = (n) =>
  `!!document.querySelector('#app h2') && document.querySelectorAll('section[id^="t"]').length >= ${n}`;

async function checkPage(pageRel, cfg) {
  const PAGE = resolve(REPO, pageRel);
  if (!existsSync(PAGE)) {
    console.error('ERROR: page not found: ' + PAGE);
    failures++;
    return failures;
  }

  const pageUrl = pathToFileURL(PAGE).href;
  const MOUNTED = mountedExpr(cfg.topics);
  const PFX = cfg.storagePrefix;
  console.log('Page:    ' + pageRel);
  console.log('Browser: ' + CHROME);

  /* ---------------- pass 1: normal load, CDN reachable ---------------- */
  section('1. Online load (CDN)');
  let { proc, profile, port } = await launch();
  try {
    const cdp = await openPage(pageUrl, port);
    const mounted = await waitFor(cdp, MOUNTED);
    mounted ? ok(`app mounted, ${cfg.topics} topic sections rendered`)
            : fail('app did not mount');

    const counts = await cdp.evaluate(`JSON.stringify({
      topics: document.querySelectorAll('section[id^="t"]').length,
      tables: document.querySelectorAll('table').length,
      collapsedCode: document.querySelectorAll('pre code').length,
      quizQuestions: document.querySelectorAll('#quiz ol > li').length,
      glossary: document.querySelectorAll('#glossary [id^="term-"]').length,
      termChips: document.querySelectorAll('.term').length,
      bold: document.querySelectorAll('.prose-block strong').length
    })`);
    const c = JSON.parse(counts);
    c.topics === cfg.topics ? ok(`${cfg.topics} topic sections`)
                            : fail(`expected ${cfg.topics} topic sections, got ` + c.topics);
    c.tables >= cfg.tables ? ok(c.tables + ' tables rendered')
                                  : fail(`expected >=${cfg.tables} tables, got ` + c.tables);
    c.quizQuestions === cfg.quiz ? ok(c.quizQuestions + ' quiz questions')
                                     : fail(`expected ${cfg.quiz} quiz questions, got ` + c.quizQuestions);
    c.glossary >= cfg.glossary ? ok(c.glossary + ' glossary entries')
                                     : fail(`expected >=${cfg.glossary} glossary entries, got ` + c.glossary);
    c.termChips >= cfg.termChips ? ok(c.termChips + ' glossary term chips linked into the prose')
                                       : fail(`expected >=${cfg.termChips} term chips, got ` + c.termChips);
    c.bold >= 40 ? ok(c.bold + ' bold phrases formatted') : fail('expected >=40 bold phrases, got ' + c.bold);

    /* ---------------- pass 1b: collapsible command blocks ---------------- */
    section('1b. Collapsible command blocks');
    const cmd = await cdp.evaluate(`(() => {
      const before = document.querySelectorAll('pre code').length;
      const toggle = [...document.querySelectorAll('#app button')]
        .find(b => /configuration\\s*&\\s*commands/i.test(b.textContent));
      if (!toggle) return JSON.stringify({ error: 'no toggle button' });
      toggle.click();
      return new Promise(r => setTimeout(() => r(JSON.stringify({
        before,
        after: document.querySelectorAll('pre code').length,
        hasCopy: !![...document.querySelectorAll('#app button')].find(b => /^\\s*Copy\\s*$/.test(b.textContent)),
        code: (document.querySelector('pre code') || {}).textContent || ''
      })), 400));
    })()`);
    const cm = JSON.parse(cmd);
    cm.after > cm.before ? ok(`command block expands (${cm.before} -> ${cm.after} code blocks)`)
                         : fail('command block did not expand: ' + cmd);
    cm.hasCopy ? ok('copy button present on the code block') : fail('no copy button: ' + cmd);
    new RegExp(cfg.codeMarker).test(cm.code) ? ok('code block contains the expected CLI content')
                                 : fail('unexpected code content: ' + cm.code.slice(0, 80));

    const expand = await cdp.evaluate(`(() => {
      const btn = document.querySelector('header button[aria-label*="Expand all"], header button[aria-label*="Collapse all"]');
      if (!btn) return JSON.stringify({ error: 'no expand button' });
      btn.click();
      return new Promise(r => setTimeout(() => r(JSON.stringify({
        open: document.querySelectorAll('pre code').length,
        label: btn.getAttribute('aria-label')
      })), 500));
    })()`);
    const ex = JSON.parse(expand);
    ex.open >= cfg.topics ? ok(`expand-all opened all ${ex.open} command blocks`) : fail('expand-all did not open every block: ' + expand);

    const collapse = await cdp.evaluate(`(() => {
      const btn = document.querySelector('header button[aria-label*="Collapse all"]');
      if (!btn) return JSON.stringify({ error: 'no collapse button' });
      btn.click();
      return new Promise(r => setTimeout(() => r(JSON.stringify({
        open: document.querySelectorAll('pre code').length
      })), 500));
    })()`);
    const co = JSON.parse(collapse);
    co.open === 0 ? ok('collapse-all closed every command block') : fail('collapse-all left blocks open: ' + collapse);

    /* ---------------- pass 2: search filter ---------------- */
    section('2. Search filter');
    const filtered = await cdp.evaluate(`(() => {
      const input = document.querySelector('input[type=search]');
      if (!input) return 'no-search-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '${cfg.search}');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise(r => setTimeout(() => {
        r(JSON.stringify({ visible: document.querySelectorAll('section[id^="t"]').length,
                          hits: (document.querySelector('.absolute.right-0.top-\\\\[42px\\\\]') || {innerText:''}).innerText }));
      }, 400));
    })()`);
    const f = JSON.parse(filtered);
    f.visible > 0 && f.visible < cfg.topics ? ok(`search "${cfg.search}" narrowed to ${f.visible} topic(s)`)
                                    : fail('search did not filter topics: ' + filtered);
    new RegExp(cfg.search, 'i').test(f.hits) ? ok('search dropdown lists matching topics') : fail('no search hits: ' + f.hits);

    await cdp.evaluate(`(() => {
      const input = document.querySelector('input[type=search]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(400);
    const restored = await cdp.evaluate(`document.querySelectorAll('section[id^="t"]').length`);
    restored === cfg.topics ? ok(`clearing search restores all ${cfg.topics} topics`) : fail('search did not reset: ' + restored);

    /* ---------------- pass 3: quiz grading ---------------- */
    section('3. Quiz');
    // Grade with the first option of every question, then use the marked
    // correct options to prove a perfect run is achievable.
    await cdp.evaluate(`(() => {
      const items = [...document.querySelectorAll('#quiz ol > li')];
      items.forEach(li => { const b = li.querySelector('button'); if (b) b.click(); });
      const grade = [...document.querySelectorAll('#quiz button')].find(b => /grade/i.test(b.textContent));
      if (grade) grade.click();
    })()`);
    await sleep(400);
    const graded = await cdp.evaluate(`(() => {
      const txt = document.getElementById('quiz').innerText;
      const m = txt.match(/Score:\\s*(\\d+)\\/(\\d+)/);
      return JSON.stringify({ score: m ? +m[1] : -1, total: m ? +m[2] : -1,
                              explanations: document.querySelectorAll('#quiz ol > li p').length });
    })()`);
    const g = JSON.parse(graded);
    g.score >= 0 && g.total === cfg.quiz ? ok(`quiz graded: ${g.score}/${g.total}`) : fail('quiz grading failed: ' + graded);
    g.explanations >= 18 ? ok('explanations revealed after grading') : fail('explanations missing: ' + graded);

    const perfect = await cdp.evaluate(`(() => {
      // Learn the correct option index per question from the graded state
      const correct = [...document.querySelectorAll('#quiz ol > li')].map(li => {
        const opts = [...li.querySelectorAll('button')];
        return opts.findIndex(o => o.className.includes('border-emerald-500'));
      });
      const reset = [...document.querySelectorAll('#quiz button')].find(b => /reset/i.test(b.textContent));
      if (reset) reset.click();
      return new Promise(r => setTimeout(() => {
        [...document.querySelectorAll('#quiz ol > li')].forEach((li, i) => {
          const opts = [...li.querySelectorAll('button')];
          if (opts[correct[i]]) opts[correct[i]].click();
        });
        const grade = [...document.querySelectorAll('#quiz button')].find(b => /grade/i.test(b.textContent));
        if (grade) grade.click();
        setTimeout(() => {
          const m = document.getElementById('quiz').innerText.match(/Score:\\s*(\\d+)\\/(\\d+)/);
          r(JSON.stringify({ score: m ? +m[1] : -1, total: m ? +m[2] : -1, correct }));
        }, 400);
      }, 300));
    })()`);
    const pf = JSON.parse(perfect);
    pf.score === pf.total && pf.total === cfg.quiz ? ok(`perfect run: ${pf.score}/${pf.total}`)
                                           : fail('perfect run failed: ' + perfect);
    const best = await cdp.evaluate(`localStorage.getItem('${PFX}.quizbest')`);
    best === String(cfg.quiz) ? ok('best score persisted to localStorage') : fail('best score not persisted: ' + best);

    /* ---------------- pass 4: theme toggle ---------------- */
    section('4. Theme toggle');
    const theme = await cdp.evaluate(`(() => {
      const before = document.documentElement.classList.contains('dark');
      const btn = document.querySelector('header button[aria-label*="theme"]');
      if (!btn) return 'no-button';
      btn.click();
      return new Promise(r => setTimeout(() => {
        const after = document.documentElement.classList.contains('dark');
        const stored = localStorage.getItem('${PFX}.theme');
        r(JSON.stringify({ before, after, stored, changed: before !== after }));
      }, 300));
    })()`);
    const t = JSON.parse(theme);
    t.changed ? ok(`theme toggled (${t.before} -> ${t.after})`) : fail('theme did not toggle: ' + theme);
    t.stored ? ok('theme persisted to localStorage ("' + t.stored + '")') : fail('theme not persisted: ' + theme);

    /* ---------------- pass 5: studied progress ---------------- */
    section('5. Progress tracking');
    const progress = await cdp.evaluate(`(() => {
      const before = document.getElementById('app').innerText.match(/(\\d+)\\/${cfg.topics}/);
      const btn = [...document.querySelectorAll('#app button')].find(b => /mark studied/i.test(b.textContent));
      if (!btn) return 'no-button';
      btn.click();
      return new Promise(r => setTimeout(() => {
        const after = document.getElementById('app').innerText.match(/(\\d+)\\/${cfg.topics}/);
        r(JSON.stringify({ before: before ? before[1] : null, after: after ? after[1] : null,
                           stored: localStorage.getItem('${PFX}.done') }));
      }, 300));
    })()`);
    const p = JSON.parse(progress);
    p.after !== null && p.after !== p.before ? ok(`progress counter moved ${p.before} -> ${p.after}`)
                                            : fail('progress did not update: ' + progress);
    p.stored ? ok('progress persisted to localStorage') : fail('progress not persisted: ' + progress);

    /* ---------------- pass 6: no console errors ---------------- */
    section('6. Runtime errors');
    const errs = cdp.errors.filter(e => !/net::ERR_(?!FILE)/.test(e));
    errs.length === 0 ? ok('no exceptions or console errors')
                      : fail(errs.length + ' runtime error(s):\n         ' + errs.join('\n         '));

    await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
      import('node:fs').then((fs) => fs.writeFileSync('/tmp/opencode/' + pageRel.replace(/[^a-z0-9]+/gi, '-') + '.png', Buffer.from(r.data, 'base64')));
    });
  } finally {
    proc.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  }

  /* ---------------- pass 8: deep links + keyboard shortcuts ---------------- */
  section('8. Deep links and keyboard shortcuts');
  {
    const { proc: p2, profile: pr2, port: p2port } = await launch();
    try {
      const cdp = await openPage(pageUrl + '#' + cfg.deepLink, p2port);
      const mounted = await waitFor(cdp, MOUNTED);
      mounted ? ok(`page with a #${cfg.deepLink} deep link mounted`) : fail('deep-linked page did not mount');
      await sleep(2200);
      const hash = await cdp.evaluate(`JSON.stringify({
        hash: location.hash,
        targetTop: Math.round((document.getElementById('${cfg.deepLink}')||{getBoundingClientRect:()=>({top:0})}).getBoundingClientRect().top),
        active: (document.querySelector('aside a[href="#${cfg.deepLink}"]')||{}).className || ''
      })`);
      const h = JSON.parse(hash);
      h.hash === '#' + cfg.deepLink ? ok('URL keeps the deep link') : fail('hash not applied: ' + hash);
      h.active.includes('font-semibold') ? ok('sidebar highlights the deep-linked topic')
                                         : fail('sidebar did not highlight: ' + hash);
      Math.abs(h.targetTop) <= 120 ? ok('deep link scrolled the target to the top of the view')
                                    : fail('deep link did not land on the target: ' + hash);

      const keys = await cdp.evaluate(`(() => {
        const press = k => document.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true}));
        const before = document.documentElement.classList.contains('dark');
        press('t');
        const afterT = document.documentElement.classList.contains('dark');
        press('t');
        const restored = document.documentElement.classList.contains('dark');
        const openBefore = document.querySelectorAll('pre code').length;
        press('e');
        return new Promise(r => setTimeout(() => r(JSON.stringify({
          themeToggled: before !== afterT,
          themeRestored: before === restored,
          openBefore,
          openAfter: document.querySelectorAll('pre code').length
        })), 500));
      })()`);
      const k = JSON.parse(keys);
      k.themeToggled && k.themeRestored ? ok('"t" toggles the theme and toggles it back')
                                        : fail('keyboard theme toggle broken: ' + keys);
      k.openAfter !== k.openBefore ? ok(`"e" expands/collapses all (${k.openBefore} -> ${k.openAfter})`)
                                   : fail('keyboard expand-all broken: ' + keys);
    } finally {
      p2.kill('SIGKILL');
      rmSync(pr2, { recursive: true, force: true });
    }
  }

  /* ---------------- pass 9: offline, CDN blocked ---------------- */
  section('9. Offline fallback (CDNs blocked)');
  const offline = await launch([
    '--host-resolver-rules=MAP cdn.jsdelivr.net 127.0.0.1:1,MAP unpkg.com 127.0.0.1:1'
  ]);
  try {
    const cdp = await openPage(pageUrl, offline.port);
    const mounted = await waitFor(cdp, MOUNTED, 25000);
    mounted ? ok('app mounted using the vendored Vue copy')
            : fail('app did not mount with the CDNs blocked');
    const vendor = await cdp.evaluate(`document.querySelectorAll('section[id^="t"]').length`);
    vendor === cfg.topics ? ok(`all ${cfg.topics} topics rendered offline`) : fail('offline render incomplete: ' + vendor);
  } finally {
    offline.proc.kill('SIGKILL');
    rmSync(offline.profile, { recursive: true, force: true });
  }

  console.log('');
  const problems = failures;
  console.log(problems
    ? `RESULT: FAILED (${problems} problem${problems === 1 ? '' : 's'})`
    : 'RESULT: ALL BROWSER CHECKS PASSED');
  return problems;
}

/* ------------------------------------------------------------- driver --- */

async function main() {
  if (!CHROME) {
    console.error('ERROR: no chromium/chrome binary found in /usr/bin');
    process.exit(1);
  }
  if (!existsSync(CONFIG_PATH)) {
    console.error('ERROR: config not found: ' + CONFIG_PATH);
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const pageConfigs = config.pages || {};
  const requested = process.argv.slice(2);
  const entries = requested.length
    ? requested.map((rel) => [rel, pageConfigs[rel] || {}])
    : Object.entries(pageConfigs);

  /* ---------------- the level index (index.html) ---------------- */
  console.log('');
  console.log('='.repeat(72));
  console.log('  index.html (level hub)');
  console.log('='.repeat(72));
  failures = 0;
  const indexPath = join(REPO, 'index.html');
  if (!existsSync(indexPath)) {
    fail('index.html not found at ' + indexPath);
  } else {
    const { proc: ip, profile: ipf, port: iport } = await launch();
    try {
      const cdp = await openPage(pathToFileURL(indexPath).href, iport);
      await sleep(1600);
      const info = await cdp.evaluate(`JSON.stringify({
        cards: document.querySelectorAll('.card').length,
        ready: document.querySelectorAll('a.card').length,
        links: [...document.querySelectorAll('a.card')].map(a => a.getAttribute('href')),
        pct: (document.getElementById('pct') || {}).textContent || '',
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      })`);
      const i = JSON.parse(info);
      config.levels
        ? (i.cards === config.levels
            ? ok(`${i.cards} level cards rendered`)
            : fail(`expected ${config.levels} level cards, got ${i.cards}`))
        : ok(`${i.cards} level cards rendered`);
      i.ready >= 1 ? ok(`${i.ready} published level(s) linked`) : fail('no published levels linked');
      /levels$/.test(i.pct) ? ok(`progress reads "${i.pct}"`) : fail('progress counter missing: ' + i.pct);
      i.overflow === 0 ? ok('no horizontal overflow') : fail('horizontal overflow: ' + i.overflow);
      const broken = i.links.filter((h) => !existsSync(resolve(REPO, h)));
      broken.length === 0 ? ok('every level link resolves to a file')
                         : fail('broken level links: ' + broken.join(', '));
      const ierr = cdp.errors.filter((e) => !/net::ERR_(?!FILE)/.test(e));
      ierr.length === 0 ? ok('no exceptions or console errors')
                        : fail(ierr.length + ' runtime error(s): ' + ierr.join(' | '));
    } finally {
      ip.kill('SIGKILL');
      rmSync(ipf, { recursive: true, force: true });
    }
  }
  totalFailures += failures;

  for (const [rel, cfg] of entries) {
    if (!cfg.topics) {
      console.error(`ERROR: no config entry for ${rel} in tools/pages.config.json`);
      process.exit(1);
    }
    console.log('');
    console.log('='.repeat(72));
    console.log('  ' + (cfg.label || rel));
    console.log('='.repeat(72));
    failures = 0;
    totalFailures += await checkPage(rel, cfg);
  }

  console.log('');
  console.log('='.repeat(72));
  console.log(totalFailures
    ? `OVERALL: FAILED (${totalFailures} problem${totalFailures === 1 ? '' : 's'} across ${entries.length} page(s))`
    : `OVERALL: ALL ${entries.length} PAGE(S) PASSED`);
  process.exit(totalFailures ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
