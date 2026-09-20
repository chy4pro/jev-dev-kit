import { JevChoiceAnswer } from './types.js';

/** Providers round probabilities to two decimals; the chosen candidate may trail the maximum by that much. */
export const ROUNDING_TOLERANCE = 0.015;

const unit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * Strictly validates a choice answer. An invalid answer is rejected rather than "repaired":
 * the choice must be an offered candidate and must agree with its own distribution.
 */
export function validateChoiceAnswer(answer: any, candidates: Record<string, unknown> | string[]): JevChoiceAnswer {
  if (!answer || typeof answer !== 'object') throw new Error('Missing answer object in the Jev response.');
  const allowed = Array.isArray(candidates) ? candidates : Object.keys(candidates);
  const choice = answer.choice;
  if (typeof choice !== 'string' || !allowed.includes(choice)) {
    throw new Error(`Jev returned choice "${String(choice)}", but expected one of: [${allowed.join(', ')}]`);
  }
  const probabilities = answer.probabilities;
  if (!probabilities || typeof probabilities !== 'object') throw new Error('Jev response is missing probabilities.');
  const entries = Object.entries(probabilities) as Array<[string, unknown]>;
  if (entries.length === 0 || !entries.every(([k, v]) => allowed.includes(k) && unit(v))) {
    throw new Error('Jev probabilities contain unknown candidates or invalid values.');
  }
  const max = Math.max(...entries.map(([, v]) => v as number));
  const own = (probabilities as Record<string, number>)[choice] ?? 0;
  if (own + ROUNDING_TOLERANCE < max) {
    throw new Error(`Jev chose "${choice}" (${own}) although another candidate has a higher probability (${max}).`);
  }
  const confidence = unit(answer.confidence) ? answer.confidence : own;
  return { choice, confidence, probabilities: probabilities as Record<string, number> };
}

/** The probability of a noul answer, or undefined when the answer is unusable. */
export function readNoul(answer: any): number | undefined {
  if (!answer || typeof answer !== 'object') return undefined;
  const p = typeof answer.probability === 'number' ? answer.probability : answer.noul;
  return unit(p) ? p : undefined;
}

/** The score of a score answer, or undefined when unusable. */
export function readScore(answer: any): number | undefined {
  if (!answer || typeof answer !== 'object') return undefined;
  return typeof answer.score === 'number' && Number.isFinite(answer.score) ? answer.score : undefined;
}
