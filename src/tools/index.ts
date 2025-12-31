import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
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

export async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const handler = getToolHandler(name);

  if (!handler) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    return await handler(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[TOOLS] Error in ${name}:`, message);
    return {
      content: [{ type: 'text', text: `Tool error: ${message}` }],
      isError: true,
    };
  }
}
