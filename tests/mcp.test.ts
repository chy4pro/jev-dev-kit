import { describe, expect, it, vi } from 'vitest';
import { JevClient, JevResponse, describeResult, describeTool, mcpApp, mcpDecisions, planParameters, resolveArguments, runLoop, unsupportedReason } from '../src/index';
import type { McpTool } from '../src/index';

const tools: McpTool[] = [
  { name: 'play', description: 'Start playback.' },
  { name: 'set_volume', description: 'Set the volume.', inputSchema: { type: 'object', properties: { volume: { type: 'integer', description: '0 to 100' } }, required: ['volume'] } },
  { name: 'set_repeat_mode', description: 'Set repeat.', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['off', 'one', 'all'] } }, required: ['mode'] } },
  { name: 'play_song', description: 'Play a song.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, artist: { type: 'string' }, device: { type: 'string', enum: ['speaker', 'headphones'], default: 'speaker' }, shuffle: { type: 'boolean' } }, required: ['title'] } },
  { name: 'import_playlist', description: 'Import.', inputSchema: { type: 'object', properties: { tracks: { type: 'array', items: { type: 'string' } } }, required: ['tracks'] } },
];

describe('MCP tools as Jev candidates', () => {
  it('plans parameters by kind and excludes tools with required inexpressible parameters', () => {
    expect(planParameters(tools[3]).map((p) => `${p.name}:${p.kind}${p.required ? '!' : ''}`)).toEqual(['title:string!', 'artist:string', 'device:enum', 'shuffle:boolean']);
    expect(unsupportedReason(tools[4])).toMatch(/tracks/);
    expect(unsupportedReason(tools[1])).toBeNull();
  });

  it('describes each tool with what it takes and builds optional per-parameter choices', () => {
    expect(describeTool(tools[3])).toBe('Play a song. Takes title: string, artist?: string, device? (speaker|headphones), shuffle? (true|false).');
    const { decisions, offered, excluded } = mcpDecisions(tools);
    expect(offered.map((t) => t.name)).toEqual(['play', 'set_volume', 'set_repeat_mode', 'play_song']);
    expect(excluded).toEqual([{ tool: 'import_playlist', reason: 'required parameter(s) Jev cannot fill: tracks' }]);
    expect(Object.keys(decisions)).toEqual(['action', 'set_repeat_mode__mode', 'play_song__device', 'play_song__shuffle']);
    expect(decisions.play_song__device).toMatchObject({ kind: 'choice', optional: true });
    expect(decisions.play_song__device.fixed!.map((c) => c.id)).toEqual(['speaker', 'headphones']);
  });

  it('resolves arguments from answers, the text callback and defaults, and refuses bad numbers', async () => {
    const text = vi.fn(async (ctx: any) => (ctx.field.parameter === 'title' ? 'Blinding Lights' : ctx.field.parameter === 'volume' ? '67' : 'x'));
    const chosen = (id: string, answers: Record<string, unknown> = {}) => ({ id, candidate: { id, description: '' }, confidence: 1, probabilities: { [id]: 1 }, answers });
    const song = await resolveArguments(tools[3], chosen('play_song', { play_song__shuffle: { choice: 'true', confidence: 1, probabilities: { true: 1 } } }), text, { goal: 'g' });
    expect(song).toEqual({ title: 'Blinding Lights', artist: 'x', device: 'speaker', shuffle: true });
    expect(await resolveArguments(tools[1], chosen('set_volume'), text, { goal: 'g' })).toEqual({ volume: 67 });
    await expect(resolveArguments(tools[1], chosen('set_volume'), async () => 'loud', { goal: 'g' })).rejects.toThrow(/must be an integer/);
    await expect(resolveArguments(tools[2], chosen('set_repeat_mode'), text, { goal: 'g' })).rejects.toThrow(/needs "mode"/);
    await expect(resolveArguments(tools[1], chosen('set_volume'), undefined, { goal: 'g' })).rejects.toThrow(/no text provider/);
  });

  it('turns results into bounded text', () => {
    expect(describeResult({ content: [{ type: 'text', text: 'ok' }, { type: 'image' }] })).toBe('ok\n[image]');
    expect(describeResult({ content: [{ type: 'text', text: 'x'.repeat(20) }], isError: true }, 10)).toBe('ERROR: xxxxxxxxxx… (10 more chars)');
    expect(describeResult({ content: [], structuredContent: { a: 1 } })).toBe('{"a":1}');
  });

  it('drives a server through runLoop: the chosen tool is called with resolved arguments and its result enters the state', async () => {
    const calls: any[] = [];
    const client = {
      listTools: async () => ({ tools }),
      callTool: async (p: any) => { calls.push(p); return { content: [{ type: 'text', text: `${p.name} done` }] }; },
    };
    const { app, excluded } = await mcpApp({ goal: 'Repeat the current song forever', client });
    expect(excluded).toHaveLength(1);
    const answer = (choice: string, extra: Record<string, unknown> = {}, goal = 0.1): JevResponse => ({
      model: 'm',
      answers: { action: { choice, confidence: 0.9, probabilities: { [choice]: 0.9, BLOCKED: 0.1 } }, goal_done: { probability: goal }, stuck: { probability: 0.1 }, ...extra },
    });
    const jev = vi.fn<JevClient>()
      .mockResolvedValueOnce(answer('set_repeat_mode', { set_repeat_mode__mode: { choice: 'one', confidence: 0.8, probabilities: { one: 0.8, all: 0.2 } }, play_song__device: { choice: 'nonsense', probabilities: { nonsense: 1 } } }))
      .mockResolvedValueOnce(answer('DONE', {}, 0.95));
    const r = await runLoop(app, { jev, model: 'm', maxSteps: 5 });

    expect(r.status).toBe('done');
    expect(calls).toEqual([{ name: 'set_repeat_mode', arguments: { mode: 'one' } }]);
    const first = jev.mock.calls[0][0];
    expect(Object.keys(first.questions)).toEqual(['action', 'set_repeat_mode__mode', 'play_song__device', 'play_song__shuffle', 'goal_done', 'stuck']);
    const second = jev.mock.calls[1][0];
    expect((second.state as any).calls).toEqual([{ step: 1, tool: 'set_repeat_mode', args: { mode: 'one' }, result: 'set_repeat_mode done' }]);
    expect(r.history[0].outcome).toMatch(/set_repeat_mode\(\{"mode":"one"\}\) → set_repeat_mode done/);
  });
});
