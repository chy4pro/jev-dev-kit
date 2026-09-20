import { JevClient, JevQuestions, JevResponse, JevState } from './types';

export interface BatchItem {
  state: JevState;
  questions: JevQuestions;
}

/**
 * Fan-out without a loop: many independent judgments (which of these items belong, where does
 * each one go), sent concurrently. Returns each item's raw response or its error; validate with
 * `validateChoiceAnswer` / `readNoul` as needed.
 */
export async function runBatch(
  jev: JevClient,
  model: string,
  items: BatchItem[],
  opts: { concurrency?: number } = {}
): Promise<Array<{ response?: JevResponse; error?: string }>> {
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const results: Array<{ response?: JevResponse; error?: string }> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { response: await jev({ model, state: items[i].state, questions: items[i].questions }) };
      } catch (err: any) {
        results[i] = { error: err?.message || String(err) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
