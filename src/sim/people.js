// LifeSpeak people graph — family, friends, colleagues, strangers.
// Pure functions, no I/O. See docs/simulation.md.
//
// Each Person: { id, name, role, relation, affection, trust, personality, mood }
//   relation: 'family' | 'friend' | 'colleague' | 'stranger'
//   affection: -100..100  (negative = hostile, positive = warm)
//   trust:      0..100     (0 = none, 100 = absolute)
// Relationships are directed (player -> NPC). NPC mood is surfaced to the AI
// director's npcTurn prompt; affection gates beats.

const AFF_MIN = -100;
const AFF_MAX = 100;
const TRUST_MIN = 0;
const TRUST_MAX = 100;

const clampAff = (v) => Math.max(AFF_MIN, Math.min(AFF_MAX, v));
const clampTrust = (v) => Math.max(TRUST_MIN, Math.min(TRUST_MAX, v));

// Family beats swing affection harder; strangers swing less. This multiplier
// scales how much a single beat's delta actually moves the needle.
const RELATION_WEIGHT = {
  family: 1.5,
  friend: 1.2,
  colleague: 1.0,
  stranger: 0.7,
};

/**
 * Seed the initial cast. The player starts with a family, a best friend, a
 * colleague, and a barista they vaguely know — enough to exercise family,
 * friendship, work, and commerce beats from day one.
 */
export function createPeople() {
  return {
    'mother': {
      id: 'mother', name: 'Elena', role: 'Mother', relation: 'family',
      affection: 60, trust: 70, personality: 'caring, worries easily', mood: 'warm',
    },
    'father': {
      id: 'father', name: 'Marco', role: 'Father', relation: 'family',
      affection: 45, trust: 60, personality: 'quiet, practical', mood: 'neutral',
    },
    'sibling': {
      id: 'sibling', name: 'Luca', role: 'Sibling', relation: 'family',
      affection: 30, trust: 55, personality: 'teasing, loyal', mood: 'neutral',
    },
    'best-friend': {
      id: 'best-friend', name: 'Sam', role: 'Best Friend', relation: 'friend',
      affection: 55, trust: 65, personality: 'easygoing, supportive', mood: 'warm',
    },
    'colleague': {
      id: 'colleague', name: 'Daniel', role: 'Coworker', relation: 'colleague',
      affection: 10, trust: 40, personality: 'analytical, proud', mood: 'neutral',
    },
    'barista': {
      id: 'barista', name: 'Mia', role: 'Barista', relation: 'stranger',
      affection: 5, trust: 20, personality: 'friendly, busy', mood: 'neutral',
    },
  };
}

/** Get a person by id (read-only view; do not mutate the returned object). */
export function person(world, id) {
  return world.people?.[id] || null;
}

export function affection(world, id) {
  return person(world, id)?.affection ?? 0;
}

export function trust(world, id) {
  return person(world, id)?.trust ?? 0;
}

/**
 * Apply an affection/trust delta to one NPC, scaling by the relation weight.
 * Returns a new world (does not mutate). `evidence` is optional text the
 * loop emits in the relationship.delta event.
 */
export function applyRelationshipDelta(world, npcId, delta = {}) {
  if (!npcId || !world.people?.[npcId]) {
    return { ...world }; // unknown NPC — no-op (loop logs world.invalid)
  }
  const w = clone(world);
  const p = w.people[npcId];
  const weight = RELATION_WEIGHT[p.relation] ?? 1;
  if (typeof delta.affection === 'number') {
    p.affection = clampAff(p.affection + Math.round(delta.affection * weight));
  }
  if (typeof delta.trust === 'number') {
    p.trust = clampTrust(p.trust + Math.round(delta.trust * weight));
  }
  // Mood follows affection bands so the AI director's prompt reflects state.
  p.mood = moodFromAffection(p.affection);
  return w;
}

/** Map an affection value to a mood label for the npcTurn prompt. */
export function moodFromAffection(aff) {
  if (aff >= 60) return 'warm';
  if (aff >= 20) return 'friendly';
  if (aff >= -20) return 'neutral';
  if (aff >= -60) return 'cool';
  return 'hostile';
}

/** Does this NPC meet an affection threshold for a beat prereq? */
export function meetsAffection(world, id, threshold) {
  return affection(world, id) >= threshold;
}

/** All people as a list (for the HUD / director candidate context). */
export function peopleList(world) {
  return Object.values(world.people || {});
}

function clone(world) {
  if (typeof structuredClone === 'function') return structuredClone(world);
  return JSON.parse(JSON.stringify(world));
}

export const __test__ = { AFF_MIN, AFF_MAX, TRUST_MIN, TRUST_MAX, RELATION_WEIGHT };
