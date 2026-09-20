# Design

## Why a framework

The Jev projects that work (typesafe-mario, jev-plays-pokemon-red, jev-tetris, jev-doom-agent, the 3D room builder, jev-for-chrome) all rebuilt the same machinery: structured small state, code-enumerated candidates, fan-out of Choice/Noul/Score in one request, strict answer validation, a visible fallback, a stall counter fed back as a fact, and a trace. The primitives are trivial to call; the machinery around them is where the effort and the bugs are. jev-dev-kit packages the machinery so a new app only writes its domain part.

## The contract an app implements

```ts
interface App<S> {
  // The world as Jev should see it: small, structured, facts not raw numbers.
  observe(): Promise<S>;
  encode(state: S, run: RunState): JevState;            // task, page/world facts, recent actions, counters

  // Decisions. Each is a question; candidates come from `fixed` or from `options`.
  decisions: Record<string, {
    kind: 'choice' | 'noul' | 'score';
    fixed?: Candidate[];                                  // e.g. the 7 Mario macros
    options?: (state: S) => Promise<Candidate[]>;         // e.g. elements on the page, legal moves
    rules: string | Record<string, string>;
  }>;

  // Effects. Runs the chosen candidate; may ask for text through the provider.
  act(choice: Chosen, state: S, text: TextProvider): Promise<Outcome>;

  // Optional. Code-owned steps that need no decision (walk a route, dismiss a dialog).
  routine?(state: S): Promise<'handled' | 'ask'>;
}
```

`Candidate = { id, description, ...facts }`. Descriptions are consequence-first sentences, not names (Tetris finding: one contradictory description halved the score; richer structured objects made options indistinguishable).

`TextProvider = (ctx: { goal, field, state }) => Promise<string>`; implementations: a small chat model (DeepSeek, any OpenAI-compatible), a regex/word-highlighting extractor, or a fixed table.

`OptionsProvider` implementations: a function (most apps), or a language model asked once per new environment to enumerate and describe candidates, cached.

## What the runtime does every step

1. `routine` first. If code can handle the step, Jev is not asked (Pokémon: no questions between the bedroom and the lab).
2. `observe` → `options` for each decision → `encode` → one request with every question in it, plus two standing cross-checks: `goal_done` and `stuck` (Noul), answered without seeing the main choice.
3. Validate: chosen id must be an offered candidate and must agree with its own distribution (two-decimal rounding tolerance). Invalid → ask once more → then fallback.
4. Veto: DONE below the goal_done threshold or BLOCKED below the stuck threshold is withheld once, with a notice in the next state.
5. `act`, then record the worded outcome (`page changed`, `no visible change`, `navigated to …`, `error: …`) into the history that the next `encode` sees. Jev has no memory; the history is the memory.
6. Loop control: consecutive no-change limit, same-choice-N-times-in-M-steps limit, decision budget, model-call budget. Every stop reason is a code, every fallback is labelled `via: 'fallback'` in the trace, never disguised as a decision.

## Batch mode

Many tasks are not loops but one fan-out: "which of these 200 items belong", "where does each of these go". `runBatch(items, decisions)` sends all questions in as few requests as the provider allows and returns the distributions. No history, no loop control, just validation and tracing. The 3D room builder is this mode.

## Evaluation

`jev-dev-kit eval` runs a task set and, for each, two controls: shuffled candidate order (should collapse to chance if Jev is doing the work) and a keyword-only picker over the same descriptions (Jev must beat it). Latency, cost and per-step traces are recorded in the same JSON the extension's Copy trace produces.

## No providers

The kit never talks to the network. `JevClient` is a function type; the app supplies it (TypeSafe's SDK, OpenRouter, Cloudflare, a cache, a fixture). The same holds for the text callback: the kit defines `TextProvider` and the reply format (`parseFieldText`), the app decides which model or code answers. This keeps the kit's job to one thing: making inputs and outputs valid for Jev.

## Consumers

- jev-for-chrome: `observe` = content-script snapshot; `options` = element table; `act` = trusted input; `text` = text helper. Its `src/shared` moves here.
- Anything else: a game, a triage queue, a scene builder.

## Non-goals

Free-form generation, planning across many steps, memory beyond the encoded history. If a task needs those, put a language model above jev-dev-kit, not inside it.
