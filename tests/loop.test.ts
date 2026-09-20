import { describe, expect, it, vi } from 'vitest';
import { App, Candidate, JevClient, JevResponse, keywordClient, runBatch, runLoop, shufflingClient, validateChoiceAnswer } from '../src/index';

interface World { screen: string; items: string[]; done: boolean }

const answer = (choice: string, extra: Record<string, unknown> = {}, cross: { goal?: number; stuck?: number } = {}): JevResponse => ({
  model: 'test',
  answers: {
    action: { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } },
    goal_done: { probability: cross.goal ?? 0.1 },
    stuck: { probability: cross.stuck ?? 0.1 },
    ...extra,
  },
});

function world(): { app: App<World>; acted: string[]; w: World } {
  const w: World = { screen: 'home', items: ['Search', 'Login'], done: false };
  const acted: string[] = [];
  const app: App<World> = {
    observe: async () => ({ ...w, items: [...w.items] }),
    encode: (s) => ({ task: 'Search for shoes', screen: s.screen }),
    decisions: {
      action: {
        kind: 'choice',
        options: (s) => s.items.map((label, i): Candidate => ({ id: `e${i + 1}`, description: `Click ${label}` })),
        rules: 'Advance the task.',
      },
    },
    act: async (chosen) => {
      acted.push(chosen.id);
      if (chosen.id === 'e1') {
        w.screen = 'results';
        w.items = ['Shoe A', 'Shoe B'];
      }
      return {};
    },
    fingerprint: (s) => s.screen + s.items.join(','),
  };
  return { app, acted, w };
}

describe('runLoop', () => {
  it('asks every decision plus goal_done and stuck, acts on the choice, and records the outcome', async () => {
    const { app, acted } = world();
    const jev = vi.fn<JevClient>().mockResolvedValueOnce(answer('e1')).mockResolvedValueOnce(answer('DONE', {}, { goal: 0.9 }));
    const r = await runLoop(app, { jev, model: 'm', maxSteps: 5 });

    expect(r.status).toBe('done');
    expect(acted).toEqual(['e1']);
    const first = jev.mock.calls[0][0];
    expect(Object.keys(first.questions)).toEqual(['action', 'goal_done', 'stuck']);
    expect(Object.keys((first.questions.action as any).criteria)).toEqual(['e1', 'e2', 'DONE', 'BLOCKED']);
    const second = jev.mock.calls[1][0];
    expect((second.state as any).recent_actions[0]).toMatchObject({ step: 1, outcome: 'state changed' });
    expect(r.history[0]).toMatchObject({ id: 'e1', changed: true });
  });

  it('withholds a DONE the goal check does not support, then accepts a confirmed one', async () => {
    const { app } = world();
    const jev = vi.fn<JevClient>().mockResolvedValueOnce(answer('DONE', {}, { goal: 0.1 })).mockResolvedValueOnce(answer('DONE', {}, { goal: 0.1 }));
    const r = await runLoop(app, { jev, model: 'm', maxSteps: 5 });
    expect(r.status).toBe('done');
    expect(String((jev.mock.calls[1][0].questions.action as any).instructions.notice)).toMatch(/DONE was withheld/);
    expect(r.trace[0].note).toMatch(/vetoed/);
  });

  it('stops as blocked after three actions that change nothing', async () => {
    const { app } = world();
    const jev = vi.fn<JevClient>().mockResolvedValue(answer('e2')); // Login never changes the world
    const r = await runLoop(app, { jev, model: 'm', maxSteps: 10 });
    expect(r.status).toBe('blocked');
    expect(r.reason).toMatch(/3 consecutive actions produced no change/);
    expect(r.steps).toBe(3);
  });

  it('warns when a choice repeats, then ends the run as blocked even though each click changes the page', async () => {
    const { app, w } = world();
    app.act = async (chosen) => { if (chosen.id === 'e2') w.screen = w.screen === 'home' ? 'menu' : 'home'; return {}; };
    const jev = vi.fn<JevClient>().mockResolvedValue(answer('e2'));
    const r = await runLoop(app, { jev, model: 'm', maxSteps: 10 });
    expect(r.status).toBe('blocked');
    expect(r.reason).toMatch(/"e2" was chosen 4 times within 6 steps/);
    const notices = jev.mock.calls.map((c) => (c[0].questions.action as any).instructions.notice).filter(Boolean);
    expect(notices.some((n) => /already been chosen 2 times/.test(String(n)))).toBe(true);
  });

  it('rejects an invalid answer once, then uses the fallback or stops', async () => {
    const { app, acted } = world();
    const bad: JevResponse = { model: 'test', answers: { action: { choice: 'e9', confidence: 1, probabilities: { e9: 1 } } } };
    const jev = vi.fn<JevClient>().mockResolvedValue(bad);
    const stopped = await runLoop(app, { jev, model: 'm', maxSteps: 5 });
    expect(stopped.status).toBe('error');
    expect(jev).toHaveBeenCalledTimes(2);
    expect(String((jev.mock.calls[1][0].questions.action as any).instructions.notice)).toMatch(/invalid/);

    const withFallback = await runLoop(app, { jev, model: 'm', maxSteps: 1, fallback: ({ candidates }) => candidates[0].id });
    expect(acted).toEqual(['e1']);
    expect(withFallback.trace.at(-1)?.via).toBe('fallback');
  });

  it('lets a routine handle a step without asking Jev, and honours act() reporting done', async () => {
    const { app, acted } = world();
    let banner = true;
    app.routine = () => { if (banner) { banner = false; return true; } return false; };
    app.act = async (chosen) => { acted.push(chosen.id); return { done: true, note: 'results shown' }; };
    const jev = vi.fn<JevClient>().mockResolvedValue(answer('e1'));
    const r = await runLoop(app, { jev, model: 'm', maxSteps: 5 });
    expect(r.history[0].id).toBe('routine');
    expect(jev).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('done');
    expect(r.history[1].outcome).toBe('results shown');
  });

  it('feeds action errors back and stops after three in a row', async () => {
    const { app } = world();
    app.act = async () => { throw new Error('element vanished'); };
    const jev = vi.fn<JevClient>().mockResolvedValue(answer('e1'));
    const r = await runLoop(app, { jev, model: 'm', maxSteps: 10 });
    expect(r.status).toBe('error');
    expect(r.reason).toMatch(/3 consecutive actions failed/);
    expect(String((jev.mock.calls[1][0].questions.action as any).instructions.notice)).toMatch(/element vanished/);
  });
});

describe('validateChoiceAnswer', () => {
  it('rejects bad sums, unknown keys and argmax disagreement, tolerates two-decimal rounding', () => {
    const allowed = ['A', 'B', 'C'];
    expect(() => validateChoiceAnswer({ choice: 'A', probabilities: { A: 0.5, B: 0.1 } }, allowed)).toThrow(/sum/);
    expect(() => validateChoiceAnswer({ choice: 'A', probabilities: { A: 0.5, Z: 0.5 } }, allowed)).toThrow(/unknown/);
    expect(() => validateChoiceAnswer({ choice: 'A', probabilities: { A: 0.2, B: 0.8 } }, allowed)).toThrow(/higher probability/);
    expect(validateChoiceAnswer({ choice: 'A', probabilities: { A: 0.49, B: 0.5, C: 0.01 } }, allowed).choice).toBe('A');
    expect(validateChoiceAnswer({ choice: 'B', confidence: 0.7, probabilities: { B: 0.7, A: 0.3 } }, allowed)).toEqual({ choice: 'B', confidence: 0.7, probabilities: { B: 0.7, A: 0.3 } });
  });
});

describe('batch and controls', () => {
  it('runs items concurrently and keeps errors per item', async () => {
    let calls = 0;
    const jev: JevClient = async (req) => { calls++; if (req.state.task === 'bad') throw new Error('boom'); return { model: 'm', answers: { q: { probability: 0.7 } } }; };
    const out = await runBatch(jev, 'm', [
      { state: { task: 'a' }, questions: { q: { type: 'noul', instructions: 'x' } } },
      { state: { task: 'bad' }, questions: { q: { type: 'noul', instructions: 'x' } } },
    ]);
    expect(calls).toBe(2);
    expect(out[0].response?.answers.q).toEqual({ probability: 0.7 });
    expect(out[1].error).toBe('boom');
  });

  it('shuffles criteria order for the control run and offers a keyword baseline', async () => {
    const seen: string[][] = [];
    const inner: JevClient = async (req) => { seen.push(Object.keys((req.questions.action as any).criteria)); return answer('a'); };
    await shufflingClient(inner, 7)({ model: 'm', state: { task: 't' }, questions: { action: { type: 'choice', criteria: { a: 1, b: 2, c: 3, d: 4 }, instructions: '' } } });
    expect(seen[0]).not.toEqual(['a', 'b', 'c', 'd']);
    expect([...seen[0]].sort()).toEqual(['a', 'b', 'c', 'd']);

    const base = await keywordClient()({ model: 'm', state: { task: 'open the pricing page' }, questions: { action: { type: 'choice', criteria: { e1: 'Click Docs', e2: 'Click Pricing' }, instructions: '' } } });
    expect(validateChoiceAnswer(base.answers.action, ['e1', 'e2']).choice).toBe('e2');
  });
});
