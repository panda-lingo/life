// Explore-mode integration test: drive startExplore with a fake DOM,
// pick a mock place, complete the real-place dialogue beat, and assert the
// full event chain (search → select → beat → debrief).
//
// Runs in plain Node: the maps boundary resolves to deterministic mock mode
// without a browser, and browser globals (document/window/indexedDB/IDB)
// are shimmed below. The same flow runs in a real browser via the e2e specs
// (tests/desktop.spec.js, tests/mobile.spec.js).

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- minimal DOM shim ----------------------------------------------
function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    style: {},
    children: [],
    parentElement: null,
    hidden: false,
    textContent: '',
    id: '',
    className: '',
    dataset: {},
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() { this.parentElement?.removeChild(this); },
    querySelector(sel) {
      const id = sel.replace(/^#/, '');
      return this.children.find((c) => c.id === id) || null;
    },
    setAttribute() {},
    addEventListener() {},
    focus() {},
    click() {},
    getContext() { return null; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set(_v) { el.children.length = 0; },
  });
  return el;
}

globalThis.document = {
  body: makeEl('body'),
  createElement: (tag) => makeEl(tag),
  getElementById: () => null,
};
globalThis.window = globalThis;
// Deterministic AI provider (no network): answers each director task with
// the minimal JSON the dialogue pipeline needs.
globalThis.window.LIFESPEAK_AI = {
  async complete({ prompt }) {
    const raw = String(prompt);
    const task = raw.match(/TASK: ([^\n]+)/)?.[1] || '';
    if (task.includes('Choose one candidate')) {
      const id = String(prompt).match(/"id":\s*"([^"]+)"/)?.[1];
      return JSON.stringify({ beatId: id, rationale: 'test', framing: 'test' });
    }
    if (task.includes('Reply in character')) return JSON.stringify({ text: 'NPC stub reply', mood: 'neutral' });
    if (task.includes('Score this utterance')) {
      return JSON.stringify({ fluency: 3, range: 3, accuracy: 3, interaction: 3, errors: [], correction: '', betterVersion: '' });
    }
    if (task.includes('Produce the debrief')) return JSON.stringify({ scores: { interaction: 0.7 }, evidence: [], nextTime: '' });
    if (task.includes('Return the scene composition')) return JSON.stringify({ kit: 'urban-cafe', layout: 'default', props: {} });
    return '{}';
  },
};
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.screen = { width: 1920, height: 1080 };
globalThis.devicePixelRatio = 1;
// Node 24 already exposes globalThis.crypto + globalThis.navigator — both
// getter-only here, and neither needs replacing. navigator.geolocation is
// absent in Node, so currentPosition() short-circuits to the mock center.
globalThis.URL.createObjectURL = globalThis.URL.createObjectURL || (() => 'blob:stub');
globalThis.URL.revokeObjectURL = globalThis.URL.revokeObjectURL || (() => {});

// ---------- in-memory IndexedDB shim (enough for eventlog.emit/query) -----
const idbData = [];
globalThis.IDBKeyRange = { lowerBound: (v) => ({ __lower: v }) };
globalThis.indexedDB = {
  open() {
    const req = {};
    setTimeout(() => {
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({ createIndex: () => {} }),
        transaction() {
          const tx = {
            objectStore: () => ({
              put: (ev) => { idbData.push(ev); },
              index: () => ({
                openCursor: () => {
                  const r = {};
                  setTimeout(() => {
                    let i = 0;
                    const step = () => {
                      if (i >= idbData.length) {
                        r.onsuccess?.({ target: { result: null } });
                        return;
                      }
                      const value = idbData[i++];
                      r.onsuccess?.({ target: { result: { value, continue: step } } });
                    };
                    step();
                  }, 0);
                  return r;
                },
              }),
            }),
          };
          setTimeout(() => tx.oncomplete?.(), 0);
          return tx;
        },
      };
      req.result = db;
      req.onupgradeneeded?.({ target: req });
      req.onsuccess?.();
    }, 0);
    return req;
  },
};

// ---------- helpers -------------------------------------------------------
function findInHud(pred) {
  const hudEl = globalThis.document.body.children.find((c) => c.id === 'hud');
  if (!hudEl) return null;
  let found = null;
  const walk = (el) => {
    for (const c of el.children || []) {
      if (found) return;
      if (pred(c)) { found = c; return; }
      walk(c);
    }
  };
  walk(hudEl);
  return found;
}

test('explore mode: full flow from startExplore to debrief (mock maps)', async () => {
  const { startExplore } = await import('./loop.js');

  const container = makeEl('div');
  const promise = startExplore(container);

  // The place picker renders one button per place under #hud-place-picker.
  // Poll until the mock places render, then click the first (The Central
  // Perk Café — deterministic mock data).
  let picked = false;
  for (let i = 0; i < 500 && !picked; i++) {
    const btn = findInHud((c) => c.dataset?.placeId === 'mock-cafe-central');
    if (btn) { btn.onclick?.(); picked = true; break; }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(picked, 'place picker never rendered the mock café');

  // The dialogue loop alternates awaiting player input (HUD text field —
  // STT is unavailable in Node) and awaiting a choice-button click under
  // #hud-choice. Drive both, mirroring what real users do and what the e2e
  // specs click in a browser. The café beat: npc-dialogue (1 reply), choice
  // (click any option), npc-dialogue-2 (1 reply), end → 2 replies + 1 click.
  const deadline = Date.now() + 20_000;
  let settled = false;
  promise.then(() => { settled = true; }, (e) => { settled = true; settleError = e; });
  let settleError = null;
  let replies = 0;
  while (!settled && Date.now() < deadline) {
    const choiceBtn = findInHud((c) => c.parentElement?.id === 'hud-choice' && c.tagName === 'BUTTON');
    if (choiceBtn) {
      choiceBtn.onclick?.();
    } else {
      const input = findInHud((c) => c.tagName === 'INPUT');
      const send = findInHud((c) => c.tagName === 'BUTTON' && c.textContent === 'Send');
      if (input && send) {
        input.value = `Typed test reply ${++replies}`;
        send.onclick?.();
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!settled) {
    const { queryEvents } = await import('../data/eventlog.js');
    console.log('events so far:', (await queryEvents()).map((e) => e.type).join(','));
    console.log('settleError:', settleError?.stack || settleError?.message || 'none');
  }
  assert.ifError(settleError);
  assert.ok(settled, `startExplore did not settle within 20s (fed ${replies} replies)`);
  assert.ok(replies >= 2, `expected ≥2 dialogue turns, fed ${replies}`);
  await promise.catch(() => {});

  // Assert the explore session produced the expected event sequence.
  const { queryEvents } = await import('../data/eventlog.js');
  const events = await queryEvents();
  const types = events.map((e) => e.type);

  assert.ok(types.includes('session.start'), `missing session.start in ${types}`);
  assert.ok(types.includes('explore.start'), 'missing explore.start');
  assert.ok(types.includes('places.searched'), 'missing places.searched');
  assert.ok(types.includes('place.selected'), 'missing place.selected');
  assert.ok(types.includes('beat.start'), 'missing beat.start');
  assert.ok(types.includes('beat.end'), 'missing beat.end');
  assert.ok(types.includes('scenario.debrief'), 'missing scenario.debrief');

  const started = events.find((e) => e.type === 'explore.start');
  assert.equal(started.mode, 'mock', 'CI must run explore in mock maps mode');

  const searched = events.find((e) => e.type === 'places.searched');
  assert.ok(searched.count >= 3, 'mock search returns the 3 canned places');

  const selected = events.find((e) => e.type === 'place.selected');
  assert.equal(selected.placeId, 'mock-cafe-central');
  assert.equal(selected.name, 'The Central Perk Café');

  // The bridged beat went through the dialogue pipeline: utterances scored,
  // a choice was offered and clicked, NPC spoke.
  assert.ok(types.includes('utterance.scored'), 'missing utterance.scored');
  assert.ok(types.includes('choice.made'), 'missing choice.made');
  assert.ok(types.includes('npc.said'), 'missing npc.said');
});

test('explore mode: zero-results search reports and exits without hanging (no dead-end picker)', async () => {
  const { startExplore } = await import('./loop.js');

  // explorerFactory resolves a stub that returns [] — the live-mode outcome
  // for ZERO_RESULTS or any non-OK status. The picker must never render;
  // startExplore must resolve instead of awaiting a click that can't happen.
  const stubExplorer = {
    mock: false,
    map: null,
    searchNearby: async () => [],
    getDetails: async () => null,
    dispose() {},
  };
  const result = await Promise.race([
    startExplore(makeEl('div'), { explorerFactory: async () => stubExplorer }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('startExplore hung on zero-results')), 10_000)),
  ]);
  assert.equal(result, false, 'zero-results path returns false (no beat ran)');

  const { queryEvents } = await import('../data/eventlog.js');
  const all = await queryEvents();
  const empty = all.find((e) => e.type === 'explore.empty');
  assert.ok(empty, 'explore.empty emitted on zero-results');
  // Nothing after the empty marker: no place selection, no beat start.
  const after = all.slice(all.indexOf(empty)).map((e) => e.type);
  assert.ok(!after.includes('place.selected'), 'no place.selected on zero-results');
  assert.ok(!after.includes('beat.start'), 'no beat.start on zero-results');
});
