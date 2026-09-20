import { postJson } from './providers/http';
import { openRouterHeaders } from './providers/index';

/**
 * Where a value that must be written (not chosen) comes from. Implementations: a small chat
 * model, a table, a regex over the goal. The runtime never guesses text itself.
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

export interface ChatTextOptions {
  baseUrl: string; // OpenAI-compatible root, e.g. https://api.deepseek.com/v1
  apiKey: string;
  model: string;
  referer?: string;
  title?: string;
  systemPrompt?: string;
}

/** A small OpenAI-compatible chat model as the text provider (DeepSeek, OpenRouter, OpenAI, ...). */
export function chatText(opts: ChatTextOptions): TextProvider {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const isOpenRouter = baseUrl.includes('openrouter.ai');
  const isDeepSeek = baseUrl.includes('api.deepseek.com');
  return async (context) => {
    if (!(opts.apiKey || '').trim()) throw new Error('Text provider has no API key; nothing written.');
    const payload: Record<string, unknown> = {
      model: opts.model,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: opts.systemPrompt || TEXT_VALUE_PROMPT },
        { role: 'user', content: JSON.stringify(context) },
      ],
      ...(isDeepSeek ? { thinking: { type: 'disabled' } } : {}),
    };
    const json = await postJson(
      `${baseUrl}/chat/completions`,
      { Authorization: `Bearer ${opts.apiKey.trim()}`, ...(isOpenRouter ? openRouterHeaders(opts) : {}) },
      payload,
      { label: 'Text provider' }
    );
    const raw = json?.choices?.[0]?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('Text provider returned an empty message; nothing written.');
    return parseFieldText(raw);
  };
}
