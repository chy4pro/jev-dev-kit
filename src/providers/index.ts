import { JevClient, JevRequest, JevResponse } from '../types';
import { postJson } from './http';

export { postJson } from './http';

export const DEFAULT_OPENROUTER_MODEL = 'typesafe/jev-1.13';
export const DEFAULT_TYPESAFE_MODEL = 'jev-latest';
export const DEFAULT_CLOUDFLARE_MODEL = 'typesafe/jev';

/** Model ids that older installs stored and OpenRouter no longer serves. */
export const OBSOLETE_OPENROUTER_JEV_MODELS: Record<string, string> = {
  'typesafe/jev-latest': DEFAULT_OPENROUTER_MODEL,
  'typesafe/jev': DEFAULT_OPENROUTER_MODEL,
  'typesafe/jev-1.13-20260917': DEFAULT_OPENROUTER_MODEL,
};

export function normalizeOpenRouterModel(rawModel?: string): string {
  const m = (rawModel || '').trim();
  if (!m) return DEFAULT_OPENROUTER_MODEL;
  return OBSOLETE_OPENROUTER_JEV_MODELS[m] || m;
}

export interface OpenRouterOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  /** Sent as HTTP-Referer and X-Title so OpenRouter can attribute usage to your app. */
  referer?: string;
  title?: string;
}

export function openRouterHeaders(opts: { referer?: string; title?: string }): Record<string, string> {
  const h: Record<string, string> = {};
  if (opts.referer) h['HTTP-Referer'] = opts.referer;
  if (opts.title) h['X-Title'] = opts.title;
  return h;
}

/** OpenRouter's Decisions API. */
export function openrouter(opts: OpenRouterOptions): JevClient {
  const apiKey = (opts.apiKey || '').trim();
  const endpoint = opts.endpoint || 'https://openrouter.ai/api/alpha/decisions';
  const model = normalizeOpenRouterModel(opts.model);
  return async (request: JevRequest): Promise<JevResponse> => {
    if (!apiKey) throw new Error('OpenRouter API key is not configured.');
    try {
      return (await postJson(
        endpoint,
        { Authorization: `Bearer ${apiKey}`, ...openRouterHeaders(opts) },
        { model: request.model || model, state: request.state, questions: request.questions },
        { label: 'OpenRouter Decisions API' }
      )) as JevResponse;
    } catch (err: any) {
      const message = err?.message || String(err);
      if (/does not exist|not found|invalid model/i.test(message)) {
        throw new Error(`${message} — the OpenRouter model id "${request.model || model}" is not available; "${DEFAULT_OPENROUTER_MODEL}" is.`);
      }
      throw err;
    }
  };
}

export interface TypeSafeOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
}

/** TypeSafe's own API. */
export function typesafe(opts: TypeSafeOptions): JevClient {
  const apiKey = (opts.apiKey || '').trim();
  const endpoint = opts.endpoint || 'https://api.typesafe.ai/v1/systemone';
  const model = (opts.model || '').trim() || DEFAULT_TYPESAFE_MODEL;
  return async (request) => {
    if (!apiKey) throw new Error('TypeSafe API key is not configured.');
    return (await postJson(
      endpoint,
      { Authorization: `Bearer ${apiKey}` },
      { model: request.model || model, state: request.state, questions: request.questions },
      { label: 'TypeSafe API' }
    )) as JevResponse;
  };
}

export interface CloudflareOptions {
  accountId: string;
  apiToken: string;
  model?: string;
  endpoint?: string;
}

/** Cloudflare Workers AI; unwraps its `{ success, result }` envelope. */
export function cloudflare(opts: CloudflareOptions): JevClient {
  const accountId = (opts.accountId || '').trim();
  const apiToken = (opts.apiToken || '').trim();
  const endpoint = opts.endpoint || `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
  const model = (opts.model || '').trim() || DEFAULT_CLOUDFLARE_MODEL;
  return async (request) => {
    if (!accountId || !apiToken) throw new Error('Cloudflare account id and API token are not configured.');
    const json = await postJson(
      endpoint,
      { Authorization: `Bearer ${apiToken}` },
      { model: request.model || model, input: { state: request.state, questions: request.questions } },
      { label: 'Cloudflare AI' }
    );
    if (json && typeof json === 'object' && 'result' in json && json.result) {
      const result = json.result;
      return { model: result.model || model, answers: result.answers || result, usage: result.usage };
    }
    return json as JevResponse;
  };
}
