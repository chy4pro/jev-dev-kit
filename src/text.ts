/**
 * Where a value that must be written (not chosen) comes from. Implementations live in the app:
 * a small chat model, a table, a regex over the goal. The runtime never guesses text itself.
 * `parseFieldText` is the format contract for a model-backed implementation: the model must
 * answer {"text": "<value>"} or {"text": null}; anything else is rejected, never written.
 */
export type TextProvider = (context: TextContext) => Promise<string>;

export interface TextContext {
  goal: string;
  /** What the value is for: the field, the parameter, the slot. */
  field: Record<string, unknown>;
  /** Anything else the writer should see (page text, prior results), already bounded. */
  context?: Record<string, unknown>;
}

export const TEXT_VALUE_PROMPT = `Return a JSON object with exactly one key, text: the exact string to enter in the selected field so that the goal advances. Use only information in the goal and the context. If the goal gives no value for this field, return {"text": null}. No explanations.`;

const MAX_TEXT_LENGTH = 2000;

/** Parses the writer's reply. Anything but {"text": "<non-empty string>"} is an error, never typed. */
export function parseFieldText(rawContent: string): string {
  const cleaned = rawContent.replace(/```(?:json)?/gi, '').trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Text provider did not return a JSON object; nothing written.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('text' in parsed)) {
    throw new Error('Text provider JSON is missing the "text" key; nothing written.');
  }
  const value = parsed.text;
  if (value === null) throw new Error('Text provider found no value for this field in the goal; nothing written.');
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT_LENGTH) {
    throw new Error('Text provider returned an invalid value; nothing written.');
  }
  return value;
}
