# jev-dev-kit

A small framework for building agents on TypeSafe Jev. Community project, not affiliated with TypeSafe. It fixes one rule that every working Jev project ends up following: **Jev only ever chooses.** Everything an agent does is expressed as a choice among candidates the program supplies; anything that has to be produced rather than chosen goes through an explicit callback.

Two callbacks, both pluggable, both allowed to be code or a language model:

- **`options(context)`**: supplies the candidates for a decision when they are not fixed in advance (the interactive elements on a page, the legal moves in a game, the files in a folder).
- **`text(context)`**: supplies a value that must be written rather than picked (a search query, a form field, a commit message).

The framework owns the loop around the model: building the state, fanning out the questions, validating answers, cross-checking DONE and stuck, detecting repeats, falling back visibly when Jev is unsure, tracing every step, and running the control experiments that show whether Jev is actually doing the work.

## Status

Design stage. The first consumer is [jev-for-chrome](../jev-for-chrome/), whose `src/shared` (action space, rules, validation, text helper) is the seed of this package; [jev-in-mcp](../jev-in-mcp/) is the second. See [DESIGN.md](DESIGN.md).

## License

MIT
