# jev-dev-kit

A small framework for building agents on TypeSafe Jev. Community project, not affiliated with TypeSafe. It fixes one rule that every working Jev project ends up following: **Jev only ever chooses.** Everything an agent does is expressed as a choice among candidates the program supplies; anything that has to be produced rather than chosen goes through an explicit callback.

Two callbacks, both pluggable, both allowed to be code or a language model:

- **`options(context)`**: supplies the candidates for a decision when they are not fixed in advance (the interactive elements on a page, the legal moves in a game, the files in a folder).
- **`text(context)`**: supplies a value that must be written rather than picked (a search query, a form field, a commit message).

The framework owns the loop around the model: building the state, fanning out the questions, validating answers, cross-checking DONE and stuck, detecting repeats, falling back visibly when Jev is unsure, tracing every step, and running the control experiments that show whether Jev is actually doing the work.

## Install

```bash
npm install github:chy4pro/jev-dev-kit#v0.1.0
```

Node 20+, TypeScript types included. Not on npm yet.

## Example

```ts
import { openrouter, runLoop, chatText, type App } from 'jev-dev-kit';

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
  jev: openrouter({ apiKey: process.env.OPENROUTER_API_KEY!, referer: 'https://example.com', title: 'My agent' }),
  model: 'typesafe/jev-1.13',
  text: chatText({ baseUrl: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY!, model: 'deepseek-chat' }),
  maxSteps: 20,
});
console.log(result.status, result.reason, result.trace);
```

What the runtime does on every step: observe, let `routine` handle code-owned steps, collect candidates, send one request with every decision plus the standing `goal_done` and `stuck` checks, validate the answers strictly (an unknown candidate or a self-contradicting distribution is asked once more, then falls back visibly), withhold a DONE or BLOCKED the cross-check does not support, act, record the worded outcome into the history the next request sees, and stop on a terminal choice, a verified completion, a budget, three no-change actions, a repeated choice, or three failed actions in a row.

Also included: `runBatch` for fan-out judgments without a loop, `shufflingClient` and `keywordClient` as the two controls that show whether Jev is doing the work, and providers for OpenRouter, TypeSafe and Cloudflare Workers AI.

## Status

0.1.0. The first consumer is [jev-for-chrome](https://github.com/chy4pro/jev-for-chrome), whose shared code this package grew out of; jev-in-mcp is the second. See [DESIGN.md](DESIGN.md) for the contract and the reasoning behind it.

## License

MIT
