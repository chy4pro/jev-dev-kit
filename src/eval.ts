import { Candidate, JevClient } from './types.js';

/**
 * Controls that say whether Jev is doing the work (from the jev-tetris findings):
 * - shuffled candidate order should collapse a real ranking to chance;
 * - a keyword picker over the same descriptions is the floor Jev has to beat.
 */

/** Deterministic shuffle so a control run is reproducible. */
export function shuffled<T>(list: T[], seed = 1): T[] {
  const out = [...list];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Wraps a client so every choice question's criteria arrive in a different order. */
export function shufflingClient(jev: JevClient, seed = 1): JevClient {
  return (request) => {
    const questions = Object.fromEntries(
      Object.entries(request.questions).map(([name, q]) => {
        if (q.type !== 'choice') return [name, q];
        const entries = shuffled(Object.entries(q.criteria), seed);
        return [name, { ...q, criteria: Object.fromEntries(entries) }];
      })
    );
    return jev({ ...request, questions });
  };
}

const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 2);

/** Picks the candidate whose description shares the most words with the goal. The baseline. */
export function keywordPick(goal: string, candidates: Candidate[]): { choice: string; probabilities: Record<string, number> } {
  const g = new Set(words(goal));
  const scores = candidates.map((c) => {
    const text = typeof c.description === 'string' ? c.description : JSON.stringify(c.description);
    return words(text).filter((w) => g.has(w)).length;
  });
  const total = scores.reduce((a, b) => a + b, 0) || 1;
  const probabilities = Object.fromEntries(candidates.map((c, i) => [c.id, scores[i] / total]));
  const best = scores.indexOf(Math.max(...scores));
  return { choice: candidates[best]?.id ?? '', probabilities };
}

/** A client that answers every choice with the keyword baseline and every noul with 0.5. */
export function keywordClient(): JevClient {
  return async (request) => {
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(request.questions)) {
      if (q.type === 'choice') {
        const cands = Object.entries(q.criteria).map(([id, description]) => ({ id, description: description as string }));
        const pick = keywordPick(String(request.state.task), cands);
        answers[name] = { choice: pick.choice, confidence: pick.probabilities[pick.choice] ?? 0, probabilities: pick.probabilities };
      } else if (q.type === 'noul') answers[name] = { probability: 0.5 };
      else answers[name] = { score: 0 };
    }
    return { model: 'keyword-baseline', answers };
  };
}
