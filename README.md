# jev-dev-kit

A small framework for building agents on TypeSafe Jev. Community project, not affiliated with TypeSafe. It fixes one rule that every working Jev project ends up following: **Jev only ever chooses.** Everything an agent does is expressed as a choice among candidates the program supplies; anything that has to be produced rather than chosen goes through an explicit callback.

Two callbacks, both pluggable, both allowed to be code or a language model:

- **`options(context)`**: supplies the candidates for a decision when they are not fixed in advance (the interactive elements on a page, the legal moves in a game, the files in a folder).
- **`text(context)`**: supplies a value that must be written rather than picked (a search query, a form field, a commit message).

The framework owns the loop around the model: building the state, fanning out the questions, validating answers, cross-checking DONE and stuck, detecting repeats, falling back visibly when Jev is unsure, tracing every step, and running the control experiments that show whether Jev is actually doing the work.

It contains no network code. You hand it a `JevClient`, which is any `(request) => Promise<response>` function: TypeSafe's SDK, one fetch to OpenRouter's Decisions API, a cache, a recorded fixture.

## Install

```bash
npm install github:chy4pro/jev-dev-kit#v0.3.0
```

Node 20+, TypeScript types included. Not on npm yet.

## Example

```ts
import { runLoop, parseFieldText, type App, type JevClient } from 'jev-dev-kit';

// Any function that answers a Jev request. Here: OpenRouter's Decisions API in one fetch.
const jev: JevClient = async (request) => {
  const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  return res.json();
};

interface Page { url: string; elements: Array<{ id: string; label: string }> }

const app: App<Page> = {
  observe: () => browser.snapshot(),
  encode: (page) => ({ task: 'Find one-way flights from Zurich to London', url: page.url }),
  decisions: {
    action: {
      kind: 'choice',
      options: (page) => page.elements.map((e) => ({ id: e.id, description: `Click ${e.label}` })),
      rules: 'Advance the task from the current page with one click.',
    },
  },
  act: (chosen) => browser.click(chosen.id),
  fingerprint: (page) => page.url + page.elements.map((e) => e.label).join('|'),
};

const result = await runLoop(app, {
  jev,
  model: 'typesafe/jev-1.13',
  // Values that must be written, not chosen: your code or a small chat model. parseFieldText
  // enforces the {"text": ...} reply format so nothing the model did not return is written.
  text: async (ctx) => parseFieldText(await askSmallModel(ctx)),
  maxSteps: 20,
});
console.log(result.status, result.reason, result.trace);
```

What the runtime does on every step: observe, let `routine` handle code-owned steps, collect candidates, send one request with every decision plus the standing `goal_done` and `stuck` checks, validate the answers strictly (an unknown candidate or a self-contradicting distribution is asked once more, then falls back visibly), withhold a DONE or BLOCKED the cross-check does not support, act, record the worded outcome into the history the next request sees, and stop on a terminal choice, a verified completion, a budget, three no-change actions, a repeated choice, or three failed actions in a row.

Also included: `runBatch` for fan-out judgments without a loop, and `shufflingClient` and `keywordClient` as the two controls that show whether Jev is doing the work.

## An MCP server as a Jev app

Give `mcpApp` a connected MCP client (the official SDK's `Client`, or anything with `listTools` and `callTool`) and the whole server becomes Jev-legal:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mcpApp, runLoop } from 'jev-dev-kit';

const client = new Client({ name: 'jev-agent', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: 'python', args: ['my_server.py'] }));

const { app, offered, excluded } = await mcpApp({ goal: 'Play Blinding Lights on the speaker and set repeat to one', client });
console.log(offered.map((t) => t.name), excluded); // tools Jev can drive, and why the others were left out

const result = await runLoop(app, { jev, model: 'typesafe/jev-1.13', text, maxSteps: 10 });
```

What the conversion does:

- every tool is a candidate of the primary choice, described as what it does and what it takes (`Play a song. Takes title: string, artist?: string, device? (speaker|headphones)`);
- enum and boolean parameters become choices, asked in the same request for every offered tool; only the chosen tool's answers are used, and an unusable answer for an unchosen tool never stalls the step;
- string, number and integer parameters come through your `text` callback and are type-checked; a bad number or a missing required value is an action error the loop feeds back, never a guess;
- a tool with a required parameter Jev cannot express (an object, an array) is not offered, and `excluded` says why;
- results become bounded text in the state (`resultChars`, default 800) and the last result is the change fingerprint.

The pieces are exported separately (`mcpDecisions`, `planParameters`, `describeTool`, `resolveArguments`, `describeResult`) for apps that want to compose them differently, for example to add hand-written consequence sentences for a server's tools.

## Status

0.3.0. The first consumer is [jev-for-chrome](https://github.com/chy4pro/jev-for-chrome), whose shared code this package grew out of; jev-in-mcp is the second. See [DESIGN.md](DESIGN.md) for the contract and the reasoning behind it.

## License

MIT
