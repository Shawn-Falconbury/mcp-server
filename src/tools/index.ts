import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

// ============================================================================
// Input-schema enforcement
//
// Design note (2026-07-24): inputSchema was previously published by
// GET /api/tools but enforced by nothing. POST /api/tools/:name passed req.body
// straight to the handler, and the MCP transport validates only the request
// envelope, not per-tool argument types. Every handler that trusted its declared
// types — e.g. `args.limit as number` interpolated into a shell string — was
// relying on a guarantee no layer provided, making POST /api/tools/get_processes
// with {"limit":"1; <cmd>"} a full bypass of the run_command allowlist.
//
// callTool() is the single chokepoint for both transports, so validating here
// covers every tool at once. The rule is REJECT, never coerce: coercing bad
// input to a default would run the tool on something the caller did not ask for.
//
// This is a minimal structural validator for the JSON Schema subset these tools
// actually use (type / enum / properties / required). It is deliberately not a
// full JSON Schema implementation — no new dependency.
// ============================================================================

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
};

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array':   return Array.isArray(value);
    case 'object':  return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:        return true;  // unconstrained type keyword — accept
  }
}

/** Returns a human-readable problem string, or null when args satisfy the schema. */
function validateArgs(schema: JsonSchema | undefined, args: Record<string, unknown>): string | null {
  if (!schema || schema.type !== 'object') return null;

  for (const key of schema.required ?? []) {
    if (args[key] === undefined) return `missing required parameter "${key}"`;
  }

  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const value = args[key];
    if (value === undefined) continue;  // absent optional — fine
    if (prop.type && !matchesType(value, prop.type)) {
      return `parameter "${key}" must be ${prop.type}, got ${describeType(value)}`;
    }
    if (prop.enum && !prop.enum.includes(value)) {
      return `parameter "${key}" must be one of: ${prop.enum.join(', ')}`;
    }
  }

  return null;
}

// Tool registry - add new tools by importing and registering them here
const toolRegistry: Map<string, ToolDefinition> = new Map();

export function registerTool(definition: ToolDefinition): void {
  toolRegistry.set(definition.tool.name, definition);
  console.log(`[TOOLS] Registered tool: ${definition.tool.name}`);
}

export function getAllTools(): Tool[] {
  return Array.from(toolRegistry.values()).map(def => def.tool);
}

export function getToolHandler(name: string): ToolDefinition['handler'] | undefined {
  return toolRegistry.get(name)?.handler;
}

export function getTool(name: string): Tool | undefined {
  return toolRegistry.get(name)?.tool;
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const definition = toolRegistry.get(name);

  if (!definition) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  // Reject, never coerce. This is the enforcement point the REST and MCP
  // transports both depend on — see the design note above.
  const problem = validateArgs(definition.tool.inputSchema as JsonSchema, args);
  if (problem) {
    return {
      content: [{ type: 'text', text: `Invalid arguments for ${name}: ${problem}` }],
      isError: true,
    };
  }

  try {
    return await definition.handler(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[TOOLS] Error in ${name}:`, message);
    return {
      content: [{ type: 'text', text: `Tool error: ${message}` }],
      isError: true,
    };
  }
}
