/**
 * An MCP server as a Jev app. Give it a connected MCP client (the official SDK's Client, or
 * anything with listTools/callTool) and it turns the server into Jev-legal form:
 *
 * - every tool is a candidate of the primary choice, described by what it does;
 * - enum and boolean parameters are choices, asked in the same request for every tool
 *   (only the chosen tool's answers are used, like per-operation target heads);
 * - string and number parameters come through the text callback and are type-checked;
 * - tools with a required parameter Jev cannot express (objects, arrays) are left out, with
 *   the reason recorded, rather than guessed at;
 * - tool results are bounded text in the state, and the last result is the fingerprint.
 */
import { App, Chosen, Decision, Outcome } from './loop.js';
import { TextProvider } from './text.js';
import { Candidate, JevChoiceAnswer } from './types.js';

// ---- MCP shapes (structurally compatible with @modelcontextprotocol/sdk) ------------------

export interface McpTool {
  name: string;
  description?: string;
  /** JSON Schema of the arguments, as the SDK types it (loosely). Read through `JsonSchema`. */
  inputSchema?: object;
}

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  items?: JsonSchema;
  [key: string]: unknown;
}

export interface McpToolResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

/** The two methods used, with the SDK Client's signatures. */
export interface McpClientLike {
  listTools(): Promise<{ tools: McpTool[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpToolResult | unknown>;
}

// ---- Parameters ---------------------------------------------------------------------------

export type ParamKind = 'enum' | 'boolean' | 'string' | 'number' | 'integer' | 'unsupported';

export interface ParamPlan {
  name: string;
  kind: ParamKind;
  required: boolean;
  description?: string;
  enum?: string[];
  default?: unknown;
}

const schemaType = (s: JsonSchema): string | undefined => (Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type);

/** How each parameter of a tool gets its value: a choice, the text callback, or not at all. */
export function planParameters(tool: McpTool): ParamPlan[] {
  const schema = (tool.inputSchema || {}) as JsonSchema;
  const required = new Set(schema.required || []);
  return Object.entries(schema.properties || {}).map(([name, s]) => {
    const base = { name, required: required.has(name), description: s.description, default: s.default };
    if (Array.isArray(s.enum) && s.enum.length > 0) return { ...base, kind: 'enum' as const, enum: s.enum.map(String) };
    const t = schemaType(s);
    if (t === 'boolean') return { ...base, kind: 'boolean' as const, enum: ['true', 'false'] };
    if (t === 'string') return { ...base, kind: 'string' as const };
    if (t === 'integer') return { ...base, kind: 'integer' as const };
    if (t === 'number') return { ...base, kind: 'number' as const };
    return { ...base, kind: 'unsupported' as const };
  });
}

/** Why a tool cannot be offered, or null when it can. */
export function unsupportedReason(tool: McpTool): string | null {
  const bad = planParameters(tool).filter((p) => p.kind === 'unsupported' && p.required);
  return bad.length ? `required parameter(s) Jev cannot fill: ${bad.map((p) => p.name).join(', ')}` : null;
}

/** The sentence Jev reads for a tool: what it does, and what it needs. */
export function describeTool(tool: McpTool): string {
  const params = planParameters(tool);
  const needs = params.map((p) => `${p.name}${p.required ? '' : '?'}${p.kind === 'enum' || p.kind === 'boolean' ? ` (${p.enum!.join('|')})` : `: ${p.kind}`}`);
  const what = (tool.description || tool.name).trim().replace(/\s+/g, ' ');
  return needs.length ? `${what} Takes ${needs.join(', ')}.` : what;
}

export const paramDecisionName = (tool: string, param: string) => `${tool}__${param}`;

/** Tool candidates plus one optional choice decision per enum/boolean parameter of every offered tool. */
export function mcpDecisions<S>(tools: McpTool[], opts: { rules?: string; describe?: (t: McpTool) => string } = {}): {
  decisions: Record<string, Decision<S>>;
  offered: McpTool[];
  excluded: Array<{ tool: string; reason: string }>;
} {
  const offered: McpTool[] = [];
  const excluded: Array<{ tool: string; reason: string }> = [];
  for (const t of tools) {
    const reason = unsupportedReason(t);
    if (reason) excluded.push({ tool: t.name, reason });
    else offered.push(t);
  }
  const describe = opts.describe || describeTool;
  const decisions: Record<string, Decision<S>> = {
    action: {
      kind: 'choice',
      fixed: offered.map((t): Candidate => ({ id: t.name, description: describe(t) })),
      rules: opts.rules || 'Choose the one tool call that best advances the task from the current state. Prefer tools whose result the task still needs; do not repeat a call whose result is already in the state.',
    },
  };
  for (const t of offered) {
    for (const p of planParameters(t)) {
      if (p.kind !== 'enum' && p.kind !== 'boolean') continue;
      decisions[paramDecisionName(t.name, p.name)] = {
        kind: 'choice',
        optional: true,
        fixed: p.enum!.map((v): Candidate => ({ id: v, description: v })),
        rules: `If the tool "${t.name}" is called, which value should its parameter "${p.name}"${p.description ? ` (${p.description})` : ''} take, given the task and the state?`,
      };
    }
  }
  return { decisions, offered, excluded };
}

/**
 * Builds the argument object for a chosen tool from the step's answers (enums, booleans) and
 * the text callback (strings, numbers). Throws when a required value is missing or malformed,
 * so the loop records an action error instead of calling the tool with a guess.
 */
export async function resolveArguments(
  tool: McpTool,
  chosen: Chosen,
  text: TextProvider | undefined,
  ctx: { goal: string; state?: Record<string, unknown> }
): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = {};
  for (const p of planParameters(tool)) {
    if (p.kind === 'unsupported') continue; // optional and inexpressible: leave to the default
    let value: unknown;
    if (p.kind === 'enum' || p.kind === 'boolean') {
      const a = chosen.answers[paramDecisionName(tool.name, p.name)] as JevChoiceAnswer | undefined;
      if (a) value = p.kind === 'boolean' ? a.choice === 'true' : a.choice;
    } else {
      if (!text) {
        if (p.required) throw new Error(`"${tool.name}" needs "${p.name}" but no text provider is configured.`);
        continue;
      }
      let raw: string;
      try {
        raw = await text({ goal: ctx.goal, field: { tool: tool.name, parameter: p.name, type: p.kind, description: p.description, required: p.required }, context: ctx.state });
      } catch (err: any) {
        if (p.required) throw new Error(`"${tool.name}" needs "${p.name}": ${err?.message || String(err)}`);
        continue;
      }
      if (p.kind === 'string') value = raw;
      else {
        const n = p.kind === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
        if (!Number.isFinite(n) || (p.kind === 'integer' && String(n) !== raw.trim())) throw new Error(`"${p.name}" must be a${p.kind === 'integer' ? 'n integer' : ' number'}, got "${raw}".`);
        value = n;
      }
    }
    if (value === undefined) {
      if (p.default !== undefined) value = p.default;
      else if (p.required) throw new Error(`"${tool.name}" needs "${p.name}" and no value was chosen.`);
      else continue;
    }
    args[p.name] = value;
  }
  return args;
}

// ---- Results ------------------------------------------------------------------------------

/** A tool result as bounded text for the state. */
export function describeResult(result: unknown, maxChars = 800): string {
  const r = result as McpToolResult | null;
  let text: string;
  if (r && typeof r === 'object' && Array.isArray(r.content)) {
    text = r.content.map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : `[${c.type}]`)).join('\n');
    if (!text && r.structuredContent !== undefined) text = JSON.stringify(r.structuredContent);
  } else text = typeof result === 'string' ? result : JSON.stringify(result);
  text = (text || '').trim();
  const prefix = r && typeof r === 'object' && r.isError ? 'ERROR: ' : '';
  return prefix + (text.length > maxChars ? `${text.slice(0, maxChars)}… (${text.length - maxChars} more chars)` : text);
}

// ---- The app ------------------------------------------------------------------------------

export interface McpCall {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
}

export interface McpState {
  goal: string;
  calls: McpCall[];
}

export interface McpAppOptions {
  goal: string;
  client: McpClientLike;
  /** Offer only these tools (names). Default: every tool the server lists that Jev can express. */
  tools?: string[];
  rules?: string;
  describe?: (t: McpTool) => string;
  /** Characters of each result kept in the state. */
  resultChars?: number;
  /** How many past calls the state carries. */
  keepCalls?: number;
}

/**
 * Lists the server's tools once and returns an App for `runLoop`, plus what was offered and
 * what was excluded. The text callback given to runLoop fills string and number parameters.
 */
export async function mcpApp(opts: McpAppOptions): Promise<{ app: App<McpState>; offered: McpTool[]; excluded: Array<{ tool: string; reason: string }> }> {
  const { tools } = await opts.client.listTools();
  const wanted = opts.tools ? tools.filter((t) => opts.tools!.includes(t.name)) : tools;
  const { decisions, offered, excluded } = mcpDecisions<McpState>(wanted, { rules: opts.rules, describe: opts.describe });
  const byName = new Map(offered.map((t) => [t.name, t]));
  const state: McpState = { goal: opts.goal, calls: [] };
  const keep = opts.keepCalls ?? 5;

  const app: App<McpState> = {
    observe: async () => ({ goal: state.goal, calls: state.calls.slice(-keep) }),
    encode: (s) => ({
      task: s.goal,
      tools: offered.map((t) => t.name),
      calls: s.calls.map((c) => ({ step: c.step, tool: c.tool, args: c.args, result: c.result })),
    }),
    decisions,
    act: async (chosen: Chosen, _s, text): Promise<Outcome> => {
      const tool = byName.get(chosen.id);
      if (!tool) return { error: `Unknown tool "${chosen.id}"` };
      const args = await resolveArguments(tool, chosen, text, { goal: state.goal, state: { calls: state.calls.slice(-2) } });
      const raw = await opts.client.callTool({ name: tool.name, arguments: args });
      const result = describeResult(raw, opts.resultChars);
      const isError = !!(raw && typeof raw === 'object' && (raw as McpToolResult).isError);
      state.calls.push({ step: state.calls.length + 1, tool: tool.name, args, result, isError });
      return { note: `${tool.name}(${JSON.stringify(args)}) → ${result.slice(0, 160)}`, text: JSON.stringify(args), ...(isError ? { error: result } : {}) };
    },
    fingerprint: (s) => String(s.calls.length) + ':' + (s.calls[s.calls.length - 1]?.result ?? ''),
  };
  return { app, offered, excluded };
}
