# Research Synthesis — LifeSpeak Design Foundation

Seven parallel researchers (CEFR pedagogy, AI language apps, life-sim narrative design, soft-skills games, web 3D tech, speech tech, learning analytics) were queried via Tavily. This document distills their findings into concrete decisions for the current implementation.

## 1. Pedagogy core

**Rubric dimensions** — IELTS and Cambridge converge on four analytic dimensions:
Fluency & Coherence, Lexical Resource, Grammatical Range & Accuracy, and
Interaction (we use the CEFR-framed label rather than Pronunciation since
pronunciation is a separate speech-to-text concern). Our rubric in
`src/ai/director.js` (`scoreUtterance`) uses these four 0–5 scales.

**B1 → C1 distinctions**:
- **B1**: keeps going on familiar topics, but with noticeable hesitation while searching for patterns; simple tenses dominate; repair is visible and effortful.
- **B2**: spontaneous, generally accurate under pressure; hesitation is mostly lexical planning, not formulation.
- **C1**: near-effortless; only conceptually difficult subjects hinder flow; repair is almost invisible.

This maps onto the learner model's `fluency` dimension: we measure not raw word count but *hesitation + self-correction smoothness* (when real audio/STT confidence data is available, we'll fold pause-detection in).

**Feedback timing** — Research is mixed but leans toward *immediate recasts for errors that block communication*, *delayed debrief for routine accuracy*. Our implementation matches: the mock provider returns a `betterVersion` immediately, but full corrective feedback and pattern tagging happen in the `scenario.debrief` event.

**Fossilized error watchlist** (from longitudinal corpora): article omissions, preposition misuse, pluralization, subject-verb agreement, tense consistency, conditionals, modal verbs. Our mock provider and analytics module both emit and detect these patterns.

## 2. Product positioning

Gap the market leaves open:
- **Speak** / **Duolingo Max Roleplay**: short, scripted, no persistent world.
- **Praktika** / **TalkPal**: avatar chat without goal-driven tasks.
- **ELSA**: phoneme-level pronunciation but not conversation agency.

LifeSpeak's differentiator is the **persistent life-sim world** where decisions
have consequences (flags/stats) and NPCs remember prior interactions. Combined
with a CEFR-aligned, per-dimension rubric and offline-first data, this is the
gap the current build occupies.

Anti-patterns to avoid (from user reviews): shallow "remembering" (we inject
world state into every prompt), unclear trials/paywalls (we're offline-first,
data export is always free), and feedback without context (we emit the full
scenario state alongside each score).

## 3. Narrative & consequence architecture

The researchers converged on a **Reigns-style filtered-card model** as the most
practical architecture for a small team:
1. Author beats as data (`scenarios/scenarios.js`), each with a `prereq(worldState)` gate.
2. At each decision point, filter eligible beats, hand them to the AI director with world-state + learner-model context.
3. Let the AI pick the next beat (narrative + pedagogical fit) and optionally suggest a framing line.
4. Apply hard-coded effects on choice; flags/stats persist across sessions via the event log.

This keeps exponential branching under control while preserving the feeling of
meaningful choice. The AI director is the *director* (L4D-style pacing), not
the *writer* — it selects and frames, but does not hallucinate scenario logic.

## 4. Soft-skill scoring lenses

Each skill has a concrete behavioral model the debrief prompt cites:

| Skill | Lens | Observable evidence |
|---|---|---|
| Conflict management | Thomas–Kilmann (collaborating / compromising) | "I see your point", "both of us", "what if we…", proposing integrative options |
| Time management | Eisenhower urgency/importance | "first I'll…", "this is urgent but not important", "let me block time for…" |
| Collaboration | Psychological safety + role clarity | "what do you think?", "builds on…", "you handle X, I'll handle Y", inviting input |

Scenario archetypes proven effective in serious-game research: workplace dispute,
landlord negotiation, group project deadline, performance feedback. The current
`scenarios.js` implements three of these; the manifest now supports adding a
`landlord-dispute` beat once art assets exist.

## 5. Technical budgets

- **3D mobile budget**: target ≤60 draw calls per scene, ≤50k triangles, capped
  DPR ≤2, no shadow maps on mobile. Procedural low-poly primitives are the
  default until AI-generated GLB kits are validated for poly/texture budget.
- **Asset pipeline**: manifest-driven. The AI composer picks kit/layout/props
  by ID only; geometry factories live in `src/engine/props.js`. To add a new
  kit: add a row to `assets/kits/manifest.json`, map prop ids in `props.js`.
- **STT/TTS**: Web Speech API is the only viable no-install path on mobile
  browsers. We degrade gracefully: text input where SpeechRecognition is
  missing, subtitle-only pacing where TTS is missing. WASM Whisper is a
  follow-up optimization for offline accuracy, not an MVP requirement.
- **Latency budget**: utterance → scored rubric < 1.5s on desktop, < 3s on
  mobile. We meet this by emitting events immediately and scoring asynchronously.

## 6. Data & offline analytics

The xAPI-flavored event model (`docs/data-model.md`) is the contract. Key
decisions:
- **Append-only** IndexedDB log with monotonic `seq` per session; JSONL export
  is the canonical artifact.
- **No foreign keys** — every scoring event embeds the full transcript +
  rubric + errors, so offline analysis needs no DB join.
- **EMA learner model** (α=0.25) is deterministic and explainable; the same
  algorithm is implemented in both `src/data/learnerModel.js` (live) and
  `src/data/analytics.js` (offline replay), so numbers match.
- **Fossilization threshold** = 3 occurrences of the same error label; this
  feeds back into the AI director's targeting hints.

## 7. MVP scope cutline

The first playable build must prove:
1. A user can push-to-talk, be understood, and get a CEFR-aligned score.
2. A choice in one beat visibly changes the world state (flags/stats) and unlocks/hides later beats.
3. A session export (JSONL) is sufficient to reproduce the learner's CEFR trajectory offline.
4. The whole loop runs on a mid-range phone browser without native installs.

That is the current state of `/home/ubuntu/life`. Remaining gaps are content
volume (more beats/kits) and richer NPC memory, not architecture.
