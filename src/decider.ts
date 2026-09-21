/**
 * One Jev decision with everything around it, independent of how decisions are scheduled:
 * building the request (candidates, rules, the standing goal_done and stuck checks, notices),
 * accepting the answer (strict validation, one retry, veto of an unsupported DONE/BLOCKED,
 * confirmation of a hesitant terminal, repetition limit, declared fallback), and the memory
 * that spans decisions (history with worded outcomes, no-change and error counters, trace).
 *
 * Runtimes compose it: `runLoop` asks, waits and acts in lockstep; a real-time runtime asks on
 * its own tick while an inner loop keeps applying the held action. Neither re-implements the
 * machinery above.
 */
import { TextContext } from './text.js';
import { Candidate, HistoryEntry, JevQuestions, JevRequest, JevResponse, JevState } from './types.js';
import { readNoul, validateChoiceAnswer } from './validate.js';

export interface Decision<S> {
  kind: 'choice' | 'noul' | 'score';
  /** Candidates known in advance (a controller's buttons, a fixed menu). */
  fixed?: Candidate[];
  /** Candidates read from the state (elements on a page, legal moves). Code or a language model. */
  options?: (state: S) => Promise<Candidate[]> | Candidate[];
  /** What Jev should weigh for this decision. */
  rules: string | Record<string, unknown>;
  /**
   * An answer that fails validation is dropped (undefined) instead of rejecting the step. For
   * decisions that only matter when a particular primary candidate is chosen (a tool's
   * parameter, a per-operation target), so a bad answer for an unchosen branch never stalls.
   */
  optional?: boolean;
  /** Leave this decision out of the request this step (no candidates, not applicable). */
  when?: (state: S) => boolean;
}

export interface Chosen {
  /** Id of the chosen candidate of the primary decision. */
  id: string;
  candidate: Candidate;
  confidence: number;
  probabilities: Record<string, number>;
  /** Every validated answer of this step, by question name (choice answers, noul probabilities, scores). */
  answers: Record<string, unknown>;
}

export interface Outcome {
  /** What visibly happened, in words, if the app knows better than the fingerprint diff. */
  note?: string;
  /** Free text the app attached (what was typed). */
  text?: string;
  /** The app has verified the task is complete (a code assertion), independent of Jev's DONE. */
  done?: boolean;
  /** The action could not be executed. Fed back to Jev; a run of them stops the loop. */
  error?: string;
}

export interface RunState {
  step: number;
  history: HistoryEntry[];
  /** Notices for the model about the last step (a withheld DONE, a target that could not be used). */
  notice?: string;
}

export interface StepTrace {
  step: number;
  request: JevRequest;
  answers?: Record<string, unknown>;
  chosen?: string;
  confidence?: number;
  goalDone?: number;
  stuck?: number;
  latencyMs: number;
  via: 'jev' | 'routine' | 'fallback';
  outcome?: string;
  note?: string;
}

/**
 * Thrown by a text provider (or by an act function) when the value has to come from outside:
 * the calling model in an MCP relay, a person at a prompt. A runtime that supports it suspends
 * and resumes the same step with the value.
 */
export class NeedsInput extends Error {
  constructor(public readonly request: TextContext) {
    super('Input needed from outside the loop');
    this.name = 'NeedsInput';
  }
}

export const GOAL_DONE_RULES =
  'Is the task already fully achieved in the current state? Judge only from the state, not from what the next action might do.';
export const STUCK_RULES =
  'Are the recent actions failing to make progress toward the task: the same candidate repeated, or actions with no visible effect?';

const DEFAULT_TERMINAL = {
  DONE: 'Every requirement of the task is visibly satisfied.',
  BLOCKED: 'No offered candidate can make progress.',
};

/** The parts of an app a decision needs; runtimes add observe/act/scheduling on top. */
export interface DecisionApp<S> {
  encode(state: S, run: RunState): JevState;
  decisions: Record<string, Decision<S>>;
  primary?: string; // default 'action'
  /** Identity of what the model sees; unchanged after an action means the action did nothing. */
  fingerprint?(state: S): string;
  /** Identity of an action for repetition and history when the primary id is a group (server) and a secondary picks the item (tool). */
  actionKey?(chosen: Chosen): string;
}

export interface DeciderOptions {
  model: string;
  /** Primary candidates that mean "stop", each with its description. Default: DONE and BLOCKED. */
  terminal?: Record<string, string>;
  /** Primary candidate ids that never count as progress or repetition (WAIT). */
  passive?: string[];
  thresholds?: { goalDone?: number; stuck?: number; terminalConfirm?: number };
  limits?: { noChangeRun?: number; repeatLimit?: number; repeatWindow?: number; consecutiveErrors?: number };
  /** Called when an answer is unusable after one retry; a candidate id to act on, or null to stop. */
  fallback?: (ctx: { candidates: Candidate[]; reason: string }) => string | null;
  /** How many recent actions the request carries. */
  historyWindow?: number;
}

export interface Prepared {
  request: JevRequest;
  candidates: Record<string, Candidate[]>;
}

export type Stop = { status: 'done' | 'blocked' | 'error'; reason: string };

export type Accepted =
  | { kind: 'chosen'; chosen: Chosen; step: StepTrace }
  /** The answer was unusable; a notice is set, ask again with a fresh request. */
  | { kind: 'retry'; step: StepTrace }
  /** A terminal was withheld or needs confirmation; ask again. */
  | { kind: 'again'; step: StepTrace }
  | { kind: 'stop'; stop: Stop; step: StepTrace };

export class Decider<S> {
  readonly run: RunState = { step: 0, history: [] };
  readonly trace: StepTrace[] = [];
  private readonly primaryKey: string;
  private readonly terminal: Record<string, string>;
  private readonly passive: Set<string>;
  private readonly th: { goalDone: number; stuck: number; terminalConfirm: number };
  private readonly lim: { noChangeRun: number; repeatLimit: number; repeatWindow: number; consecutiveErrors: number };
  private lastFingerprint: string | null = null;
  private pendingTerminal: string | null = null;
  private vetoed: string | null = null;
  private retried = false;
  private errors = 0;

  constructor(private readonly app: DecisionApp<S>, private readonly opts: DeciderOptions) {
    this.primaryKey = app.primary ?? 'action';
    const primary = app.decisions[this.primaryKey];
    if (!primary || primary.kind !== 'choice') throw new Error(`decisions.${this.primaryKey} must be a choice`);
    this.terminal = opts.terminal ?? DEFAULT_TERMINAL;
    this.passive = new Set(opts.passive ?? ['WAIT']);
    this.th = { goalDone: 0.5, stuck: 0.5, terminalConfirm: 0.5, ...(opts.thresholds || {}) };
    this.lim = { noChangeRun: 3, repeatLimit: 3, repeatWindow: 6, consecutiveErrors: 3, ...(opts.limits || {}) };
  }

  /**
   * Called with every fresh observation. Settles the outcome of the previous action from the
   * fingerprint (unless the app already said what happened) and reports a deadlock: N
   * consecutive non-passive actions with no change.
   */
  observe(state: S): Stop | null {
    const fp = this.app.fingerprint ? this.app.fingerprint(state) : JSON.stringify(this.app.encode(state, this.run));
    const last = this.run.history[this.run.history.length - 1];
    if (last && last.changed === undefined) {
      last.changed = this.lastFingerprint !== null && fp !== this.lastFingerprint;
      if (!last.outcome) last.outcome = last.changed ? 'state changed' : 'no visible change';
    }
    this.lastFingerprint = fp;
    const recent = this.run.history.slice(-this.lim.noChangeRun);
    if (recent.length === this.lim.noChangeRun && recent.every((h) => h.changed === false && !this.passive.has(h.id) && h.id !== 'routine')) {
      return { status: 'blocked', reason: `${this.lim.noChangeRun} consecutive actions produced no change.` };
    }
    return null;
  }

  /** A step handled by code without a decision. */
  recordRoutine(): void {
    this.run.step++;
    this.run.history.push({ step: this.run.step, id: 'routine', label: 'routine' });
    this.trace.push({ step: this.run.step, request: { model: this.opts.model, state: { task: '' }, questions: {} }, latencyMs: 0, via: 'routine' });
  }

  /** The request for this state: every applicable decision plus goal_done and stuck. */
  async prepare(state: S): Promise<Prepared> {
    const candidates: Record<string, Candidate[]> = {};
    const questions: JevQuestions = {};
    for (const [name, d] of Object.entries(this.app.decisions)) {
      if (name !== this.primaryKey && d.when && !d.when(state)) continue;
      const list = [...(d.fixed || []), ...(d.options ? await d.options(state) : [])];
      if (name === this.primaryKey) for (const [id, description] of Object.entries(this.terminal)) list.push({ id, description });
      candidates[name] = list;
      const rules: Record<string, unknown> = typeof d.rules === 'string' ? { rules: d.rules } : { ...d.rules };
      if (name === this.primaryKey && this.run.notice) rules.notice = this.run.notice;
      if (d.kind === 'choice') {
        questions[name] = { type: 'choice', criteria: Object.fromEntries(list.map((c) => [c.id, c.description])), instructions: rules };
      } else {
        questions[name] = { type: d.kind, instructions: rules } as JevQuestions[string];
      }
    }
    questions.goal_done = { type: 'noul', instructions: GOAL_DONE_RULES };
    questions.stuck = { type: 'noul', instructions: STUCK_RULES };
    const window = this.opts.historyWindow ?? 10;
    const request: JevRequest = {
      model: this.opts.model,
      state: {
        ...this.app.encode(state, this.run),
        recent_actions: this.run.history.slice(-window).map((h) => ({ step: h.step, action: h.label, text: h.text, outcome: h.outcome ?? 'pending' })),
      },
      questions,
    };
    return { request, candidates };
  }

  /** Validates and judges the answer. Never throws for a bad answer; the result says what to do. */
  accept(response: JevResponse, prepared: Prepared, latencyMs: number): Accepted {
    const { request, candidates } = prepared;
    const pk = this.primaryKey;
    const answers: Record<string, unknown> = {};
    let primary: { choice: string; confidence: number; probabilities: Record<string, number> };
    let via: StepTrace['via'] = 'jev';
    try {
      primary = validateChoiceAnswer(response.answers?.[pk], candidates[pk].map((c) => c.id));
      answers[pk] = primary;
      for (const [name, d] of Object.entries(this.app.decisions)) {
        if (name === pk || !(name in candidates)) continue;
        if (d.kind === 'choice') {
          try {
            answers[name] = validateChoiceAnswer(response.answers?.[name], candidates[name].map((c) => c.id));
          } catch (err) {
            if (!d.optional) throw err;
            answers[name] = undefined;
          }
        } else if (d.kind === 'noul') answers[name] = readNoul(response.answers?.[name]);
        else answers[name] = response.answers?.[name]?.score;
      }
    } catch (err: any) {
      const reason = err?.message || String(err);
      if (!this.retried) {
        this.retried = true;
        this.run.notice = `The previous answer was invalid (${reason}). Answer with one of the offered candidates.`;
        const step: StepTrace = { step: this.run.step, request, latencyMs, via: 'jev', note: `rejected: ${reason}` };
        this.trace.push(step);
        return { kind: 'retry', step };
      }
      const fb = this.opts.fallback?.({ candidates: candidates[pk], reason }) ?? null;
      const step: StepTrace = { step: this.run.step + 1, request, latencyMs, via: 'fallback', note: `unusable twice: ${reason}` };
      if (fb === null) {
        this.trace.push(step);
        return { kind: 'stop', stop: { status: 'error', reason: `Unusable answer twice: ${reason}` }, step };
      }
      primary = { choice: fb, confidence: 0, probabilities: { [fb]: 1 } };
      answers[pk] = primary;
      via = 'fallback';
    }
    this.retried = false;
    this.run.notice = undefined;
    const goalDone = readNoul(response.answers?.goal_done);
    const stuck = readNoul(response.answers?.stuck);
    const choice = primary.choice;
    const step: StepTrace = { step: this.run.step + 1, request, answers, chosen: choice, confidence: primary.confidence, goalDone, stuck, latencyMs, via };

    if (choice in this.terminal) {
      const isDone = choice === 'DONE';
      const cross = isDone ? goalDone : stuck;
      const min = isDone ? this.th.goalDone : this.th.stuck;
      if (cross !== undefined && cross < min && this.vetoed !== choice) {
        this.vetoed = choice;
        this.run.notice = isDone
          ? `DONE was withheld: the goal check rates the task as not achieved (${Math.round(cross * 100)}%). Continue, or choose DONE again only if the state truly satisfies every requirement.`
          : `BLOCKED was withheld: the stuck check does not agree (${Math.round(cross * 100)}%). Try another candidate.`;
        step.note = `${choice} vetoed by cross-check (${cross})`;
        this.trace.push(step);
        return { kind: 'again', step };
      }
      if (primary.confidence < this.th.terminalConfirm && this.pendingTerminal !== choice) {
        this.pendingTerminal = choice;
        this.run.notice = `${choice} was chosen with low confidence (${Math.round(primary.confidence * 100)}%). Confirm it, or continue with another candidate.`;
        step.note = `${choice} needs confirmation`;
        this.trace.push(step);
        return { kind: 'again', step };
      }
      this.trace.push(step);
      return { kind: 'stop', stop: { status: isDone ? 'done' : 'blocked', reason: isDone ? 'Jev reported the task complete.' : 'Jev reported no way forward.' }, step };
    }
    this.pendingTerminal = null;
    this.vetoed = null;

    const candidate = candidates[pk].find((c) => c.id === choice)!;
    const chosen: Chosen = { id: choice, candidate, confidence: primary.confidence, probabilities: primary.probabilities, answers };
    const key = this.actionKey(chosen);
    const repeats = this.run.history.slice(-this.lim.repeatWindow).filter((h) => h.id === key && !this.passive.has(h.id)).length;
    if (repeats >= this.lim.repeatLimit) {
      this.trace.push(step);
      return { kind: 'stop', stop: { status: 'blocked', reason: `"${key}" was chosen ${repeats + 1} times within ${this.lim.repeatWindow} steps without reaching the goal.` }, step };
    }
    if (repeats === this.lim.repeatLimit - 1) {
      this.run.notice = `"${key}" has already been chosen ${repeats} times recently without finishing the task. Prefer a different candidate unless it is clearly the only way.`;
    }
    return { kind: 'chosen', chosen, step };
  }

  actionKey(chosen: Chosen): string {
    return this.app.actionKey ? this.app.actionKey(chosen) : chosen.id;
  }

  /** Records what an action did. Returns a stop when the app verified completion or errors ran out. */
  record(chosen: Chosen, outcome: Outcome, step: StepTrace): Stop | null {
    this.run.step++;
    const key = this.actionKey(chosen);
    const label = typeof chosen.candidate.description === 'string' ? `${key}: ${chosen.candidate.description}`.slice(0, 120) : key;
    const entry: HistoryEntry = { step: this.run.step, id: key, label, text: outcome.text };
    let stop: Stop | null = null;
    if (outcome.error) {
      this.errors++;
      entry.outcome = `error: ${outcome.error}`;
      entry.changed = false;
      this.run.notice = `The last action failed: ${outcome.error}`;
      if (this.errors >= this.lim.consecutiveErrors) stop = { status: 'error', reason: `${this.errors} consecutive actions failed; last: ${outcome.error}` };
    } else {
      this.errors = 0;
      if (outcome.note) entry.outcome = outcome.note;
    }
    this.run.history.push(entry);
    step.step = this.run.step;
    step.outcome = entry.outcome;
    if (!this.trace.includes(step)) this.trace.push(step);
    if (!stop && outcome.done) stop = { status: 'done', reason: 'The app verified the task is complete.' };
    return stop;
  }
}
