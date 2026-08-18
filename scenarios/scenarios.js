// Scenario graph: beats are nodes; prerequisites gate access via worldState.
// The AI director picks among candidates whose prerequisites are satisfied.
// Consequences are durable (flags/stats/skillDeltas) and may unlock, hide,
// or alter later beats.
//
// Sim integration: each beat may declare `cost` {energy?, money?, minutes?}
// (the sim gates beats the player cannot afford) and `effects`/`stats`
// (applied to the sim world: money/energy/mood/stress route to vitals).
// NPC ids match the people graph in src/sim/people.js so relationship deltas
// land on the right person.

export const beats = {
  // ---------------- Everyday B1 starting beats ----------------
  'cafe-ordering': {
    id: 'cafe-ordering',
    title: 'At the Café',
    location: 'urban-cafe',
    cefrRange: ['B1', 'B2'],
    skillFocus: ['interaction'],
    prereq: () => true,
    cost: { energy: 5, money: 5, minutes: 30 },
    flags: { hasMetBarista: true },
    stats: { energy: +2, mood: +3 },
    npcs: [{ id: 'barista', name: 'Mia', role: 'Barista', personality: 'friendly, busy', mood: 'neutral' }],
    beats: [
      { kind: 'npc-dialogue', turn: 'open' },
      { kind: 'choice', options: [
        { text: 'Order a simple coffee', next: 'end' },
        { text: 'Ask for a complicated custom order (stretching range)', effects: { flags: { attemptedComplexOrder: true } }, next: 'npc-dialogue-2' },
      ]},
      { kind: 'npc-dialogue-2' },
      { kind: 'end' },
    ],
  },

  // ---------------- Rest: low-energy recovery ----------------
  'rest-at-home': {
    id: 'rest-at-home',
    title: 'Rest at Home',
    location: 'apartment',
    cefrRange: ['B1', 'C1'],
    skillFocus: ['interaction'],
    prereq: () => true,
    rest: true,                       // selectable when exhausted
    cost: { energy: 0, minutes: 120 },
    stats: { energy: +35, stress: -15, mood: +5 },
    npcs: [{ id: 'npc-self', name: 'Yourself', role: 'Narrator', personality: 'calm', mood: 'neutral' }],
    beats: [
      { kind: 'narration', text: 'You take a couple of hours to rest. The world slows down.' },
      { kind: 'end' },
    ],
  },

  // ---------------- Family: morning call with Mom ----------------
  'call-mom': {
    id: 'call-mom',
    title: 'Call Your Mother',
    location: 'apartment',
    cefrRange: ['B1', 'B2'],
    skillFocus: ['interaction'],
    prereq: () => true,
    cost: { energy: 5, minutes: 25 },
    stats: { mood: +4, stress: -2 },
    npcs: [{ id: 'mother', name: 'Elena', role: 'Mother', personality: 'caring, worries easily', mood: 'warm' }],
    beats: [
      { kind: 'npc-dialogue', turn: 'open' },
      { kind: 'npc-dialogue', turn: 'reactive' },
      { kind: 'choice', options: [
        { text: 'Reassure her you are eating well', next: 'end', effects: { stats: { mood: +3 } } },
        { text: 'Ask if she needs anything (offer help)', next: 'npc-dialogue-2', effects: { flags: { offeredHelpMom: true } } },
      ]},
      { kind: 'npc-dialogue-2' },
      { kind: 'end' },
    ],
  },

  // ---------------- Conflict: B2 workplace ----------------
  'colleague-disagreement': {
    id: 'colleague-disagreement',
    title: 'Disagreement with a Coworker',
    location: 'office',
    cefrRange: ['B2', 'C1'],
    skillFocus: ['conflict', 'collaboration'],
    prereq: (ws) => ws.flags?.hasFinishedIntro === true,
    cost: { energy: 10, minutes: 45 },
    flags: { resolvedConflict: true },
    stats: { trust: +1, stress: +3 },
    npcs: [{ id: 'colleague', name: 'Daniel', role: 'Coworker', personality: 'analytical, proud', mood: 'frustrated' }],
    beats: [
      { kind: 'npc-dialogue', turn: 'open' },
      { kind: 'npc-dialogue', turn: 'reactive' },
      { kind: 'choice', options: [
        { text: 'Demand your way', next: 'fail', effects: { stats: { trust: -2, stress: +2 }, flags: { resolvedByCoercion: true } } },
        { text: 'Acknowledge their view, then propose compromise', next: 'npc-dialogue-success', effects: { flags: { usedThomasKilmannCollaborate: true }, stats: { trust: +2, mood: +3 } } },
        { text: 'Avoid — change the subject', next: 'fail', effects: { stats: { stress: +1 }, flags: { resolvedByAvoidance: true } } },
      ]},
      { kind: 'npc-dialogue-success' },
      { kind: 'end' },
    ],
  },

  // ---------------- Time management ----------------
  'deadline-pressure': {
    id: 'deadline-pressure',
    title: 'Three Deadlines, One Day',
    location: 'home-office',
    cefrRange: ['B1+', 'B2'],
    skillFocus: ['time'],
    prereq: (ws) => ws.flags?.hasMetBarista === true,
    cost: { energy: 12, money: 0, minutes: 90 },
    flags: { didEisenhower: true },
    stats: { energy: -2, stress: +5 },
    npcs: [{ id: 'npc-self', name: 'Yourself', role: 'Narrator', personality: 'calm', mood: 'neutral' }],
    beats: [
      { kind: 'narration', text: 'Email: client review (urgent). Slack: colleague stuck (urgent). Calendar: long report (important, not urgent). What do you tackle first?' },
      { kind: 'choice', options: [
        { text: 'Client review — urgent wins', next: 'end', effects: { flags: { ignoredImportance: true } } },
        { text: 'Long report — important but not urgent', next: 'narration-2', effects: { flags: { usedEisenhower: true } } },
        { text: 'Quickly unblock the colleague (builds trust)', next: 'narration-3', effects: { flags: { usedCollab: true }, stats: { trust: +1 } } },
      ]},
      { kind: 'narration-2' },
      { kind: 'narration-3' },
      { kind: 'end' },
    ],
  },

  // ---------------- C1 negotiation ----------------
  'salary-negotiation': {
    id: 'salary-negotiation',
    title: 'Salary Negotiation',
    location: 'office',
    cefrRange: ['B2+', 'C1'],
    skillFocus: ['conflict', 'collaboration'],
    prereq: (ws) => ws.flags?.resolvedConflict === true,
    cost: { energy: 15, minutes: 60 },
    flags: { negotiatedRaise: true },
    stats: { money: +5000, confidence: +1, mood: +10 },
    npcs: [{ id: 'npc-manager', name: 'Priya', role: 'Hiring Manager', personality: 'professional, firm', mood: 'evaluating' }],
    beats: [
      { kind: 'npc-dialogue', turn: 'open' },
      { kind: 'choice', options: [
        { text: 'Anchor high with your number first', next: 'npc-1' },
        { text: 'Ask what range is budgeted', next: 'npc-2' },
        { text: 'Cite market data and your wins, then propose', next: 'npc-3', effects: { flags: { usedInterestBased: true } } },
      ]},
      { kind: 'npc-1' }, { kind: 'npc-2' }, { kind: 'npc-3' },
      { kind: 'end' },
    ],
  },
};

// Find eligible candidates given worldState.
export function eligibleBeats(worldState, all = beats) {
  return Object.values(all).filter((b) => {
    try { return b.prereq(worldState); } catch { return false; }
  });
}

// Apply choice effects (deep merge flags, sum stats).
export function applyEffects(worldState, effects) {
  if (!effects) return worldState;
  const ws = JSON.parse(JSON.stringify(worldState));
  ws.flags = { ...(ws.flags || {}), ...(effects.flags || {}) };
  ws.stats = { ...(ws.stats || {}), ...(effects.stats || {}) };
  return ws;
}