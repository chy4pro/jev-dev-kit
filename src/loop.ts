import { Candidate, HistoryEntry, JevClient, JevQuestions, JevRequest, JevState } from './types.js';
import { TextContext, TextProvider } from './text.js';
import { readNoul, validateChoiceAnswer } from './validate.js';

// ---- The contract an app implements -------------------------------------------------------

export interface Decision<S> {
  kind: 'choice' | 'noul' | 'score';
  /** Candidates known in advance (a controller's buttons, a fixed menu). */
  fixed?: Candidate[];
  /** Candidates read from the state (elements on a page, legal moves). Code or a language model. */
  options?: (state: S) => Promise<Candidate[]> | Candidate[];
  /** What Jev should weigh for this decision. */
  rules: string | Record<string, unknown>;
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
  /** The action could not be executed. Fed back to Jev; three in a row stop the run. */
  error?: string;
}

export interface RunState {
  step: number;
  history: HistoryEntry[];
  /** Notices for the model about the last step (a withheld DONE, a target that could not be used). */
  notice?: string;
}

export interface App<S> {
  /** Reads the world. Called at the start of every step. */
  observe(): Promise<S>;
  /** Encodes the world for Jev: small, structured, facts rather than raw numbers. Must include `task`. */
  encode(state: S, run: RunState): JevState;
  /** The decisions asked every step. `primary` names the one whose candidate is acted on. */
  decisions: Record<string, Decision<S>>;
  primary?: string; // default 'action'
  /** Runs the chosen candidate. */
  act(chosen: Chosen, state: S, text?: TextProvider): Promise<Outcome | void>;
  /** Code-owned steps that need no decision (walk a route, dismiss a banner). Return true when handled. */
  routine?(state: S): Promise<boolean> | boolean;
  /** Identity of what the model sees; when it does not change after an action, the action did nothing. */
  fingerprint?(state: S): string;
}

// ---- Runtime options ---------------------------------------------------------------------

export interface LoopOptions {
  jev: JevClient;
  model: string;
  text?: TextProvider;
  maxSteps?: number; // default 30
  /** Ids of primary candidates that mean "stop": DONE and BLOCKED by default, each with its description. */
  terminal?: Record<string, string>;
  /** Primary candidate ids that never count as progress or repetition (WAIT). */
  passive?: string[];
  thresholds?: { goalDone?: number; stuck?: number; terminalConfirm?: number };
  limits?: { noChangeRun?: number; repeatLimit?: number; repeatWindow?: number; consecutiveErrors?: number };
  onStep?: (trace: StepTrace) => void;
  /** Called when Jev's answer cannot be used after one retry. Return a candidate id to act on instead, or null to stop. */
  fallback?: (ctx: { candidates: Candidate[]; reason: string }) => string | null;
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
 * Thrown by a text provider (or by `act`) when the value has to come from outside the loop:
 * the calling model in an MCP relay, a person at a prompt. The loop suspends and returns
 * `status: 'suspended'` with the request and a `resume(value)` that continues the same step.
 */
export class NeedsInput extends Error {
  constructor(public readonly request: TextContext) {
    super('Input needed from outside the loop');
    this.name = 'NeedsInput';
  }
}

export interface LoopResult {
  status: 'done' | 'blocked' | 'error' | 'stopped' | 'suspended';
  reason: string;
  steps: number;
  history: HistoryEntry[];
  trace: StepTrace[];
  /** Present when suspended: what is being asked for, and how to continue. */
  needsInput?: TextContext;
  resume?: (value: string) => Promise<LoopResult>;
}

const DEFAULT_TERMINAL = {
  DONE: 'Every requirement of the task is visibly satisfied.',
  BLOCKED: 'No offered candidate can make progress.',
};

export const GOAL_DONE_RULES =
  'Is the task already fully achieved in the current state? Judge only from the state, not from what the next action might do.';
export const STUCK_RULES =
  'Are the recent actions failing to make progress toward the task: the same candidate repeated, or actions with no visible effect?';

/**
 * Runs one decision loop: observe → routine? → candidates → one Jev request (every decision plus
 * goal_done and stuck) → validate → veto → act → record the outcome → repeat. Stops on a terminal
 * candidate, a verified completion, a budget, a deadlock, a repetition, or an unusable answer.
 */
export async function runLoop<S>(app: App<S>, opts: LoopOptions): Promise<LoopResult> {
  const primaryKey = app.primary ?? 'action';
  const primary = app.decisions[primaryKey];
  if (!primary || primary.kind !== 'choice') throw new Error(`decisions.${primaryKey} must be a choice`);
  const terminal = opts.terminal ?? DEFAULT_TERMINAL;
  const passive = new Set(opts.passive ?? ['WAIT']);
  const th = { goalDone: 0.5, stuck: 0.5, terminalConfirm: 0.5, ...(opts.thresholds || {}) };
  const lim = { noChangeRun: 3, repeatLimit: 3, repeatWindow: 6, consecutiveErrors: 3, ...(opts.limits || {}) };
  const maxSteps = opts.maxSteps ?? 30;

  const run: RunState = { step: 0, history: [] };
  const trace: StepTrace[] = [];
  let lastFingerprint: string | null = null;
  let pendingTerminal: string | null = null;
  let vetoed: string | null = null;
  let retried = false;
  let errors = 0;
  const finish = (status: LoopResult['status'], reason: string): LoopResult => ({ status, reason, steps: run.step, history: run.history, trace });
  /** A step whose act() asked for outside input; continued by resume(). */
  let suspended: { state: S; chosen: Chosen; candidate: Candidate; step: StepTrace; input?: string } | null = null;

  const continueLoop = async (): Promise<LoopResult> => {
  while (run.step < maxSteps) {
    let state: S;
    let chosen: Chosen;
    let candidate: Candidate;
    let step: StepTrace;
    let textForStep: TextProvider | undefined = opts.text;
    if (suspended) {
      ({ state, chosen, candidate, step } = suspended);
      // The value supplied from outside answers the first text request of the re-run act().
      let pending: string | undefined = suspended.input;
      const inner = opts.text;
      textForStep = async (ctx) => {
        if (pending !== undefined) { const v = pending; pending = undefined; return v; }
        if (!inner) throw new NeedsInput(ctx);
        return inner(ctx);
      };
      suspended = null;
    } else {
    state = await app.observe();

    // 1. Outcome of the previous action, from the fingerprint unless the app said more.
    const fp = app.fingerprint ? app.fingerprint(state) : JSON.stringify(app.encode(state, run));
    const last = run.history[run.history.length - 1];
    if (last && last.changed === undefined) {
      last.changed = lastFingerprint !== null && fp !== lastFingerprint;
      if (!last.outcome) last.outcome = last.changed ? 'state changed' : 'no visible change';
    }
    lastFingerprint = fp;

    // 2. Deadlock: N consecutive non-passive actions with no change.
    const recent = run.history.slice(-lim.noChangeRun);
    if (recent.length === lim.noChangeRun && recent.every((h) => h.changed === false && !passive.has(h.id) && h.id !== 'routine')) {
      return finish('blocked', `${lim.noChangeRun} consecutive actions produced no change.`);
    }

    // 3. Code-owned step.
    if (app.routine && (await app.routine(state))) {
      run.step++;
      run.history.push({ step: run.step, id: 'routine', label: 'routine' });
      trace.push({ step: run.step, request: { model: opts.model, state: { task: '' }, questions: {} }, latencyMs: 0, via: 'routine' });
      continue;
    }

    // 4. Candidates and questions.
    const candidatesByDecision: Record<string, Candidate[]> = {};
    const questions: JevQuestions = {};
    for (const [name, d] of Object.entries(app.decisions)) {
      const list = [...(d.fixed || []), ...(d.options ? await d.options(state) : [])];
      if (name === primaryKey) for (const [id, description] of Object.entries(terminal)) list.push({ id, description });
      candidatesByDecision[name] = list;
      const rules: Record<string, unknown> = typeof d.rules === 'string' ? { rules: d.rules } : { ...d.rules };
      if (name === primaryKey && run.notice) rules.notice = run.notice;
      if (d.kind === 'choice') {
        questions[name] = { type: 'choice', criteria: Object.fromEntries(list.map((c) => [c.id, c.description])), instructions: rules };
      } else {
        questions[name] = { type: d.kind, instructions: rules } as JevQuestions[string];
      }
    }
    questions.goal_done = { type: 'noul', instructions: GOAL_DONE_RULES };
    questions.stuck = { type: 'noul', instructions: STUCK_RULES };

    const encoded = app.encode(state, run);
    const request: JevRequest = {
      model: opts.model,
      state: {
        ...encoded,
        recent_actions: run.history.slice(-10).map((h) => ({ step: h.step, action: h.label, text: h.text, outcome: h.outcome ?? 'pending' })),
      },
      questions,
    };

    // 5. Ask.
    const started = Date.now();
    let response;
    try {
      response = await opts.jev(request);
    } catch (err: any) {
      return finish('error', `Jev request failed: ${err?.message || String(err)}`);
    }
    const latencyMs = Date.now() - started;
    const answers: Record<string, unknown> = {};
    let primaryAnswer;
    try {
      primaryAnswer = validateChoiceAnswer(response.answers?.[primaryKey], candidatesByDecision[primaryKey].map((c) => c.id));
      answers[primaryKey] = primaryAnswer;
      for (const [name, d] of Object.entries(app.decisions)) {
        if (name === primaryKey) continue;
        if (d.kind === 'choice') answers[name] = validateChoiceAnswer(response.answers?.[name], candidatesByDecision[name].map((c) => c.id));
        else if (d.kind === 'noul') answers[name] = readNoul(response.answers?.[name]);
        else answers[name] = response.answers?.[name]?.score;
      }
    } catch (err: any) {
      const reason = err?.message || String(err);
      if (!retried) {
        retried = true;
        run.notice = `The previous answer was invalid (${reason}). Answer with one of the offered candidates.`;
        trace.push({ step: run.step, request, latencyMs, via: 'jev', note: `rejected: ${reason}` });
        continue;
      }
      const fb = opts.fallback?.({ candidates: candidatesByDecision[primaryKey], reason }) ?? null;
      if (fb === null) return finish('error', `Unusable answer twice: ${reason}`);
      primaryAnswer = { choice: fb, confidence: 0, probabilities: { [fb]: 1 } };
      answers[primaryKey] = primaryAnswer;
      answers.via = 'fallback';
    }
    retried = false;
    run.notice = undefined;
    const goalDone = readNoul(response.answers?.goal_done);
    const stuck = readNoul(response.answers?.stuck);
    const choice = primaryAnswer.choice;
    const stepTrace: StepTrace = { step: run.step + 1, request, answers, chosen: choice, confidence: primaryAnswer.confidence, goalDone, stuck, latencyMs, via: answers.via === 'fallback' ? 'fallback' : 'jev' };

    // 6. Terminal candidates: vetoed once by the cross-check, confirmed once when hesitant.
    if (choice in terminal) {
      const isDone = choice === 'DONE';
      const cross = isDone ? goalDone : stuck;
      const min = isDone ? th.goalDone : th.stuck;
      if (cross !== undefined && cross < min && vetoed !== choice) {
        vetoed = choice;
        run.notice = isDone
          ? `DONE was withheld: the goal check rates the task as not achieved (${Math.round(cross * 100)}%). Continue, or choose DONE again only if the state truly satisfies every requirement.`
          : `BLOCKED was withheld: the stuck check does not agree (${Math.round(cross * 100)}%). Try another candidate.`;
        stepTrace.note = `${choice} vetoed by cross-check (${cross})`;
        trace.push(stepTrace);
        opts.onStep?.(stepTrace);
        continue;
      }
      if (primaryAnswer.confidence < th.terminalConfirm && pendingTerminal !== choice) {
        pendingTerminal = choice;
        run.notice = `${choice} was chosen with low confidence (${Math.round(primaryAnswer.confidence * 100)}%). Confirm it, or continue with another candidate.`;
        stepTrace.note = `${choice} needs confirmation`;
        trace.push(stepTrace);
        opts.onStep?.(stepTrace);
        continue;
      }
      trace.push(stepTrace);
      opts.onStep?.(stepTrace);
      return finish(isDone ? 'done' : 'blocked', isDone ? 'Jev reported the task complete.' : 'Jev reported no way forward.');
    }
    pendingTerminal = null;
    vetoed = null;

    // 7. Repetition: same candidate too often within the window; warn first, then stop.
    const repeats = run.history.slice(-lim.repeatWindow).filter((h) => h.id === choice && !passive.has(h.id)).length;
    if (repeats >= lim.repeatLimit) {
      trace.push(stepTrace);
      opts.onStep?.(stepTrace);
      return finish('blocked', `"${choice}" was chosen ${repeats + 1} times within ${lim.repeatWindow} steps without reaching the goal.`);
    }
    if (repeats === lim.repeatLimit - 1) {
      run.notice = `"${choice}" has already been chosen ${repeats} times recently without finishing the task. Prefer a different candidate unless it is clearly the only way.`;
    }

    candidate = candidatesByDecision[primaryKey].find((c) => c.id === choice)!;
    chosen = { id: choice, candidate, confidence: primaryAnswer.confidence, probabilities: primaryAnswer.probabilities, answers };
    step = stepTrace;
    if (!textForStep) textForStep = undefined;
    } // end of the observe/ask branch

    // 8. Act.
    let outcome: Outcome = {};
    try {
      outcome = (await app.act(chosen, state, textForStep ?? (async (ctx) => { throw new NeedsInput(ctx); }))) || {};
    } catch (err: any) {
      if (err instanceof NeedsInput) {
        suspended = { state, chosen, candidate, step };
        const held = suspended;
        step.note = `waiting for input: ${JSON.stringify(err.request.field)}`;
        if (!trace.includes(step)) trace.push(step);
        return {
          ...finish('suspended', 'A value is needed from outside the loop.'),
          needsInput: err.request,
          resume: (value: string) => { held.input = value; suspended = held; return continueLoop(); },
        };
      }
      outcome = { error: err?.message || String(err) };
    }
    run.step++;
    const entry: HistoryEntry = { step: run.step, id: chosen.id, label: typeof candidate.description === 'string' ? `${chosen.id}: ${candidate.description}`.slice(0, 120) : chosen.id, text: outcome.text };
    if (outcome.error) {
      errors++;
      entry.outcome = `error: ${outcome.error}`;
      entry.changed = false;
      run.notice = `The last action failed: ${outcome.error}`;
      if (errors >= lim.consecutiveErrors) {
        run.history.push(entry);
        step.outcome = entry.outcome;
        if (!trace.includes(step)) trace.push(step);
        opts.onStep?.(step);
        return finish('error', `${errors} consecutive actions failed; last: ${outcome.error}`);
      }
    } else {
      errors = 0;
      if (outcome.note) entry.outcome = outcome.note;
    }
    run.history.push(entry);
    step.outcome = entry.outcome;
    if (!trace.includes(step)) trace.push(step);
    opts.onStep?.(step);
    if (outcome.done) return finish('done', 'The app verified the task is complete.');
  }
  return finish('blocked', `Reached the ${maxSteps}-step budget.`);
  };
  return continueLoop();
}
