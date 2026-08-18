// Deterministic offline mock implementing the provider contract
// (text+image in -> text out, JSON payloads). Lets the entire game run
// and be tested with no API key. Heuristics are intentionally simple but
// behaviorally plausible: NPCs react to keywords, scoring uses surface
// features of the transcript, the director rotates through candidates.

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const CONFLICT_WORDS = ['understand', 'perspective', 'fair', 'compromise', 'both', 'agree', 'sorry', 'concern', 'together', 'option'];
const TIME_WORDS = ['first', 'priority', 'deadline', 'urgent', 'important', 'plan', 'schedule', 'by tomorrow', 'focus'];
const COLLAB_WORDS = ['we', 'us', 'your idea', 'what do you think', 'help', 'share', 'thanks', 'good point'];

function countHits(text, words) {
  const t = text.toLowerCase();
  return words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
}

function scoreTranscript(transcript) {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  const n = words.length;
  const longWords = words.filter((w) => w.length >= 7).length;
  const fluency = clamp(Math.round(n / 6), 1, 5);                       // proxy: utterance length
  const range = clamp(1 + Math.round(longWords / 2) + (n > 20 ? 1 : 0), 1, 5);
  const errors = [];
  if (/\bi is\b|\bhe don't\b|\bshe go\b/i.test(transcript)) errors.push('subject-verb-agreement');
  if (/\byesterday\b.*\bgo\b/i.test(transcript)) errors.push('past-tense');
  if (!/could|would|might|perhaps|maybe/i.test(transcript) && n > 0) errors.push('hedging-absent');
  const accuracy = clamp(5 - errors.length, 1, 5);
  const interaction = clamp(2 + countHits(transcript, ['could you', 'what do you think', 'i understand', 'let me']), 1, 5);
  return { fluency, range, accuracy, interaction, errors };
}

function parseTask(prompt) {
  const m = prompt.match(/TASK: (.+)/);
  return m ? m[1] : '';
}

function contextOf(prompt) {
  const m = prompt.match(/CONTEXT \(JSON\):\n([\s\S]*?)\n\nTASK:/);
  try { return JSON.parse(m[1]); } catch { return {}; }
}

export const mockProvider = {
  async complete({ prompt }) {
    const task = parseTask(prompt);
    const ctx = contextOf(prompt);

    if (task.startsWith('Choose one candidate beat')) {
      const c = ctx.candidates || [];
      const chosen = c[0] || { id: 'unknown' };
      return JSON.stringify({
        beatId: chosen.id,
        rationale: 'mock: first eligible candidate (targets unpracticed skills)',
        framing: chosen.framing || 'The day continues...',
      });
    }

    if (task.startsWith('Return the scene composition')) {
      const kit = (ctx.availableKits || [])[0] || {};
      const layout = (kit.layouts || [])[0];
      const props = {};
      for (const slot of layout?.slots || []) props[slot.name] = pick(slot.options || []);
      return JSON.stringify({
        kit: kit.id, layout: layout?.id, props,
        lighting: pick(['day', 'evening']),
        npcs: (ctx.beat?.npcs || []).map((n) => n.id),
      });
    }

    if (task.startsWith('Reply in character')) {
      const utt = (ctx.learnerUtterance || '').toLowerCase();
      const npc = ctx.beat?.npcs?.[0] || { name: 'NPC' };
      let text, mood = 'neutral', beatAdvance = 'stay';
      if (countHits(utt, CONFLICT_WORDS) >= 2) {
        text = pick([
          "Alright, that's fair. Let's find something that works for both of us.",
          "I hear you. Maybe we've been talking past each other — what do you propose?",
        ]);
        mood = 'warming'; beatAdvance = 'advance';
      } else if (/never|stupid|your fault|shut up/i.test(utt)) {
        text = "Wow. Okay. If that's how you want to play it, this conversation is over.";
        mood = 'hostile'; beatAdvance = 'fail';
      } else if (countHits(utt, TIME_WORDS) >= 2) {
        text = "A clear plan helps. So what exactly will you finish first, and by when?";
        mood = 'neutral';
      } else {
        text = pick([
          "I see. Can you say a bit more about what you mean?",
          "Hmm, I'm not sure that solves my problem. What else have you got?",
          "Okay, but why should I agree to that?",
        ]);
      }
      return JSON.stringify({ text, mood, effects: { flags: {}, stats: mood === 'warming' ? { trust: 1 } : mood === 'hostile' ? { trust: -1 } : {} }, beatAdvance });
    }

    if (task.startsWith('Score this utterance')) {
      const s = scoreTranscript(ctx.transcript || '');
      return JSON.stringify({
        ...s,
        correction: s.errors.includes('hedging-absent')
          ? 'Soften requests with "Could we...?" or "Would it be possible to...?"'
          : 'Good turn — try adding one linking phrase ("because", "so that") to stretch your range.',
        betterVersion: `Could we maybe look at it this way: ${(ctx.transcript || '').replace(/[.!?]$/, '')}?`,
      });
    }

    if (task.startsWith('Produce the debrief')) {
      const log = (ctx.transcriptLog || []).map((t) => t.text || t).join(' ');
      const scores = {
        conflict: clamp(countHits(log, CONFLICT_WORDS) / 4, 0, 1),
        time: clamp(countHits(log, TIME_WORDS) / 3, 0, 1),
        collaboration: clamp(countHits(log, COLLAB_WORDS) / 3, 0, 1),
      };
      return JSON.stringify({
        scores,
        evidence: ['mock evidence: keyword scan of transcript'],
        nextTime: 'Name the other person\'s interest before stating your own proposal.',
      });
    }

    if (task.startsWith('Advise on this trade')) {
      const good = (ctx.world?.market || {})[ctx.goodId];
      const money = ctx.world?.player?.money ?? 0;
      if (ctx.action === 'buy' && good) {
        const ratio = good.demand / good.supply;
        const recommend = ratio < 1 ? 'proceed' : 'hold';
        return JSON.stringify({
          advice: `mock: ${ctx.goodId} demand/supply ${ratio.toFixed(2)}, you have ${money}.`,
          recommendation: recommend,
          reason: 'mock: buy when supply exceeds demand',
        });
      }
      return JSON.stringify({
        advice: 'mock: sell to rebalance supply.',
        recommendation: 'proceed',
        reason: 'mock: selling raises liquidity',
      });
    }

    if (task.startsWith('Score the relationship delta')) {
      const npc = ctx.npc || {};
      const text = (ctx.transcript || []).join(' ').toLowerCase();
      let affection = 0;
      let trust = 0;
      if (countHits(text, ['sorry', 'thank', 'appreciate', 'love', 'care']) >= 1) affection += 5;
      if (countHits(text, ['promise', 'will', 'tomorrow', 'commit', 'sure']) >= 1) trust += 4;
      if (/liar|hate|stupid|shut up/i.test(text)) { affection -= 8; trust -= 6; }
      if (countHits(text, CONFLICT_WORDS) >= 2) affection += 3;
      return JSON.stringify({
        affection: clamp(affection, -20, 20),
        trust: clamp(trust, -15, 15),
        evidence: `mock: keyword scan of transcript with ${npc.name || 'NPC'}`,
      });
    }

    return JSON.stringify({ error: 'mock: unknown task', task });
  },
};
