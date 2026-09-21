/**
 * The lockstep runtime: observe → (routine?) → ask → act → record, one step at a time, each
 * step waiting for Jev. Built on `Decider`, which owns everything about a decision; this file
 * owns only the schedule and the suspension when an action needs a value from outside.
 */
import { Accepted, Chosen, DecisionApp, Decider, DeciderOptions, NeedsInput, Outcome, StepTrace } from './decider.js';
import { TextContext, TextProvider } from './text.js';
import { HistoryEntry, JevClient } from './types.js';

export interface App<S> extends DecisionApp<S> {
  /** Reads the world. Called at the start of every step. */
  observe(): Promise<S>;
  /** Runs the chosen candidate. */
  act(chosen: Chosen, state: S, text?: TextProvider): Promise<Outcome | void>;
  /** Code-owned steps that need no decision (walk a route, dismiss a banner). Return true when handled. */
  routine?(state: S): Promise<boolean> | boolean;
}

export interface LoopOptions extends DeciderOptions {
  jev: JevClient;
  text?: TextProvider;
  maxSteps?: number; // default 30
  onStep?: (trace: StepTrace) => void;
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

export async function runLoop<S>(app: App<S>, opts: LoopOptions): Promise<LoopResult> {
  const decider = new Decider(app, opts);
  const maxSteps = opts.maxSteps ?? 30;
  const finish = (status: LoopResult['status'], reason: string): LoopResult => ({ status, reason, steps: decider.run.step, history: decider.run.history, trace: decider.trace });
  /** A step whose act() asked for outside input; continued by resume() with the values supplied so far. */
  let suspended: { state: S; chosen: Chosen; step: StepTrace; inputs: string[] } | null = null;

  const continueLoop = async (): Promise<LoopResult> => {
    while (decider.run.step < maxSteps) {
      let state: S;
      let chosen: Chosen;
      let step: StepTrace;
      let text: TextProvider | undefined = opts.text;
      let held: typeof suspended = null;

      if (suspended) {
        // act() re-runs from the start: the values supplied so far answer its text requests in
        // order, and the next request nobody has answered yet suspends again.
        held = suspended;
        suspended = null;
        ({ state, chosen, step } = held);
        const supplied = held.inputs;
        let i = 0;
        const inner = opts.text;
        text = async (ctx) => {
          if (i < supplied.length) return supplied[i++];
          if (!inner) throw new NeedsInput(ctx);
          return inner(ctx);
        };
      } else {
        state = await app.observe();
        const stall = decider.observe(state);
        if (stall) return finish(stall.status, stall.reason);
        if (app.routine && (await app.routine(state))) {
          decider.recordRoutine();
          continue;
        }
        const prepared = await decider.prepare(state);
        const started = Date.now();
        let response;
        try {
          response = await opts.jev(prepared.request);
        } catch (err: any) {
          return finish('error', `Jev request failed: ${err?.message || String(err)}`);
        }
        const accepted: Accepted = decider.accept(response, prepared, Date.now() - started);
        if (accepted.kind === 'retry' || accepted.kind === 'again') {
          opts.onStep?.(accepted.step);
          continue;
        }
        if (accepted.kind === 'stop') {
          opts.onStep?.(accepted.step);
          return finish(accepted.stop.status, accepted.stop.reason);
        }
        ({ chosen, step } = accepted);
      }

      let outcome: Outcome = {};
      try {
        outcome = (await app.act(chosen, state, text ?? (async (ctx) => { throw new NeedsInput(ctx); }))) || {};
      } catch (err: any) {
        if (err instanceof NeedsInput) {
          const record = { state, chosen, step, inputs: held ? held.inputs : [] };
          step.note = `waiting for input: ${JSON.stringify(err.request.field)}`;
          if (!decider.trace.includes(step)) decider.trace.push(step);
          return {
            ...finish('suspended', 'A value is needed from outside the loop.'),
            needsInput: err.request,
            resume: (value: string) => { suspended = { ...record, inputs: [...record.inputs, value] }; return continueLoop(); },
          };
        }
        outcome = { error: err?.message || String(err) };
      }
      const stop = decider.record(chosen, outcome, step);
      opts.onStep?.(step);
      if (stop) return finish(stop.status, stop.reason);
    }
    return finish('blocked', `Reached the ${maxSteps}-step budget.`);
  };
  return continueLoop();
}
