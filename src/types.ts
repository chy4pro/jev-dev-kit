// ---- Jev question and answer primitives ---------------------------------------------------

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string | Record<string, unknown>;
  criteria: Record<string, unknown>;
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string | Record<string, unknown>;
  criteria?: Record<string, string>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string | Record<string, unknown>;
  min?: number;
  max?: number;
  criteria?: string[] | Record<string, string>;
}

export type JevQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

/** The state is whatever the app encodes; `task` is the one field the runtime relies on. */
export interface JevState {
  task: string;
  [key: string]: unknown;
}

export interface JevRequest {
  model: string;
  state: JevState;
  questions: JevQuestions;
}

export interface JevChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevNoulAnswer {
  type?: 'noul';
  probability: number;
  noul?: number;
}

export interface JevScoreAnswer {
  type?: 'score';
  score: number;
  confidence?: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer | any>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Anything that answers a Jev request: a provider, a cache, a recorded fixture. */
export type JevClient = (request: JevRequest) => Promise<JevResponse>;

// ---- Candidates and history --------------------------------------------------------------

/**
 * One thing Jev can pick. The description is what Jev reads: a consequence-first sentence or a
 * small object of facts. It must make candidates distinguishable from each other.
 */
export interface Candidate {
  id: string;
  description: string | Record<string, unknown>;
}

export interface HistoryEntry {
  step: number;
  /** Candidate id of the primary decision, or 'routine' when code handled the step. */
  id: string;
  /** Short human label for the trace and for Jev (`recent_actions`). */
  label: string;
  /** Free text the app attached (e.g. what was typed). */
  text?: string;
  /** What visibly happened afterwards, in words. Filled in when the next state is seen. */
  outcome?: string;
  changed?: boolean;
}
