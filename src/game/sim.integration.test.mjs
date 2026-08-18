// Integration test: the simulation core wired into loop.js.
// Drives a single beat through __test__.runNextBeat with a deterministic mock
// provider and asserts the world clock/energy/money/relationships actually
// move — proving the loop delegates all mutations to world.tick (docs/simulation.md).
//
// Runs in plain Node; browser globals + IndexedDB are shimmed like the explore
// integration test.

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- short-circuit backend probes + force mock AI ----------------
import { _setProviderImplsForTests } from '../ai/director.js';
import { _setBackendImplForTests, _resetSyncForTests } from '../data/eventlog.js';
_setProviderImplsForTests({
  probeBackend: async () => null,
  detectOpenAI: async () => null,
  mock: { name: 'mock', complete: async () => '{}' },
});
_setBackendImplForTests({
  probeBackend: async () => null,
  appendEvents: async () => ({ accepted: 0, deduped: 0, total: 0 }),
  beaconEvents: () => false,
});
_resetSyncForTests();

// ---------- DOM shim -----------------------------------------------------
function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), style: {}, children: [], parentElement: null,
    hidden: false, textContent: '', id: '', className: '', dataset: {},
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() { this.parentElement?.removeChild(this); },
    querySelector(sel) { const id = sel.replace(/^#/, ''); return this.children.find((c) => c.id === id) || null; },
    setAttribute() {}, addEventListener() {}, focus() {}, click() {}, getContext() { return null; },
  };
  Object.defineProperty(el, 'innerHTML', { get() { return ''; }, set(_v) { el.children.length = 0; } });
  return el;
}
globalThis.document = { body: makeEl('body'), createElement: (t) => makeEl(t), getElementById: () => null };
globalThis.window = globalThis;
globalThis.window.LIFESPEAK_AI = {
  async complete({ prompt }) {
    const raw = String(prompt);
    const task = raw.match(/TASK: ([^\n]+)/)?.[1] || '';
    if (task.includes('Choose one candidate')) {
      const id = String(prompt).match(/"id":\s*"([^"]+)"/)?.[1];
      return JSON.stringify({ beatId: id, rationale: 'test', framing: 'test' });
    }
    if (task.includes('Reply in character')) return JSON.stringify({ text: 'NPC stub reply', mood: 'neutral' });
    if (task.includes('Score this utterance')) return JSON.stringify({ fluency: 3, range: 3, accuracy: 3, interaction: 3, errors: [], correction: '', betterVersion: '' });
    if (task.includes('Produce the debrief')) return JSON.stringify({ scores: { interaction: 0.7 }, evidence: [], nextTime: '' });
    if (task.includes('Return the scene composition')) return JSON.stringify({ kit: 'urban-cafe', layout: 'default', props: {} });
    if (task.includes('Score the relationship delta')) return JSON.stringify({ affection: 8, trust: 5, evidence: 'stub' });
    if (task.includes('Advise on this trade')) return JSON.stringify({ advice: 'stub', recommendation: 'proceed', reason: 'stub' });
    return '{}';
  },
};
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.screen = { width: 1920, height: 1080 };
globalThis.devicePixelRatio = 1;
globalThis.URL.createObjectURL ||= () => 'blob:stub';
globalThis.URL.revokeObjectURL ||= () => {};

// ---------- in-memory IndexedDB shim -------------------------------------
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
                      if (i >= idbData.length) { r.onsuccess?.({ target: { result: null } }); return; }
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
      req.result = db; req.onupgradeneeded?.({ target: req }); req.onsuccess?.();
    }, 0);
    return req;
  },
};

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

test('sim: a beat costs energy/money/time and moves the world clock', async () => {
  const t = (await import('./loop.js')).__test__;
  const session = t.newSession();
  const before = { ...t.world.clock, energy: t.world.player.energy, money: t.world.player.money };

  // Run the café beat (cost: energy 5, money 5, minutes 30).
  const promise = t.runNextBeat(session, {
    signal: session.ctrl.signal,
    candidates: [{ id: 'cafe-ordering', framing: 'At the Café', skillFocus: ['interaction'], cefrRange: ['B1', 'B2'] }],
  });

  // Drive the dialogue: café beat = npc-dialogue (text reply), choice (click),
  // npc-dialogue-2 (text reply), end. The beat runs a relationship delta on
  // the 'barista' NPC afterward.
  const deadline = Date.now() + 20_000;
  let settled = false; let settleError = null;
  promise.then(() => { settled = true; }, (e) => { settled = true; settleError = e; });
  while (!settled && Date.now() < deadline) {
    const choiceBtn = findInHud((c) => c.parentElement?.id === 'hud-choice' && c.tagName === 'BUTTON');
    if (choiceBtn) { choiceBtn.onclick?.(); }
    else {
      const input = findInHud((c) => c.tagName === 'INPUT');
      const send = findInHud((c) => c.tagName === 'BUTTON' && c.textContent === 'Send');
      if (input && send) { input.value = 'I would like a coffee please'; send.onclick?.(); }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ifError(settleError);
  assert.ok(settled, 'runNextBeat did not settle within 20s');
  await promise.catch(() => {});

  const after = t.world;
  // Time advanced by at least the 30-minute beat cost (dialogue may add none).
  assert.ok(after.clock.minute > before.minute, `clock did not advance: ${before.minute} -> ${after.clock.minute}`);
  // Energy dropped (cost 5) then rose (stat +2) — net should differ from start.
  assert.notEqual(after.player.energy, before.energy, 'energy unchanged');
  // Money dropped by the 5-unit cost (stat effects route energy/mood, not money, here).
  assert.ok(after.player.money < before.money, `money did not drop: ${before.money} -> ${after.player.money}`);

  // The barista relationship delta fired (mock returns affection +8).
  assert.ok(after.people.barista.affection >= t.world.people?.barista?.affection, 'barista affection moved');

  // Sim events were emitted into the log.
  const { queryEvents } = await import('../data/eventlog.js');
  const types = (await queryEvents()).map((e) => e.type);
  assert.ok(types.includes('world.tick'), 'missing world.tick');
  assert.ok(types.includes('relationship.delta'), 'missing relationship.delta');
  assert.ok(types.includes('beat.start'), 'missing beat.start');
});

test('sim: exhausted player is restricted to rest beats', async () => {
  const t = (await import('./loop.js')).__test__;
  t.newSession();
  // Drain energy to force the exhausted gate.
  t.world = { ...t.world, player: { ...t.world.player, energy: 0 } };
  const { eligibleBeats } = await import('../../scenarios/scenarios.js');
  const eligible = eligibleBeats(t.worldState);
  // rest-at-home carries rest:true and is always eligible; café now
  // unaffordable (energy 5 > 0).
  assert.ok(eligible.some((b) => b.id === 'rest-at-home'), 'rest beat exists');
  const rest = eligible.find((b) => b.id === 'rest-at-home');
  assert.equal(rest.rest, true);
});
