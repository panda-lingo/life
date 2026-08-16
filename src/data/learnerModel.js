// Learner model: offline-updatable mastery estimates from scored events.
// Simple, explainable heuristics (EMA + recency weighting) — no server needed.
//
// Dimensions tracked:
//   language: fluency, range (vocab/grammar stretch), accuracy, interaction
//   skills:   conflict, time, collaboration  (0..1 mastery each)
//   cefr:     rolling estimate B1..C1 from rubric scores

const EMA_ALPHA = 0.25;            // how fast new evidence moves the estimate
const CEFR_STEPS = ['B1', 'B1+', 'B2', 'B2+', 'C1'];

export function createLearnerModel() {
  return {
    language: { fluency: null, range: null, accuracy: null, interaction: null },
    skills: { conflict: null, time: null, collaboration: null },
    cefrIndex: 1,                  // start mid-B1+
    utterances: 0,
    errorPatterns: {},             // pattern -> count (fossilization watchlist)
  };
}

const ema = (prev, next) => (prev == null ? next : prev + EMA_ALPHA * (next - prev));

// rubric: { fluency, range, accuracy, interaction } each 0..5 (CEFR-anchored)
export function updateLanguage(model, rubric, errors = []) {
  for (const k of Object.keys(model.language)) {
    if (typeof rubric[k] === 'number') model.language[k] = ema(model.language[k], rubric[k]);
  }
  model.utterances++;
  for (const e of errors) model.errorPatterns[e] = (model.errorPatterns[e] || 0) + 1;
  // CEFR estimate: mean of dimensions mapped onto the step ladder
  const vals = Object.values(model.language).filter((v) => v != null);
  if (vals.length) {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;   // 0..5
    model.cefrIndex = Math.max(0, Math.min(CEFR_STEPS.length - 1, Math.round(mean) - 1));
  }
  return model;
}

// skillScores: { conflict?, time?, collaboration? } each 0..1 from scenario debrief
export function updateSkills(model, skillScores) {
  for (const [k, v] of Object.entries(skillScores)) {
    if (typeof v === 'number') model.skills[k] = ema(model.skills[k], v);
  }
  return model;
}

export function cefrEstimate(model) {
  return CEFR_STEPS[model.cefrIndex];
}

// Persistent error patterns = what the AI director should target next.
export function fossilizedErrors(model, threshold = 3) {
  return Object.entries(model.errorPatterns)
    .filter(([, n]) => n >= threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([pattern]) => pattern);
}
