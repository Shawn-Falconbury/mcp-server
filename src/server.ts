import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { authMiddleware } from './auth.js';
import { getAllTools, getTool, callTool } from './tools/index.js';

export function createApp(): Express {
  const app = express();

  // Security middleware
  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  // Health check (no auth required)
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
}

export function createMCPServer(): Server {
  const server = new Server(
    {
      name: 'pi-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = getAllTools();
    console.log(`[MCP] Listing ${tools.length} tools`);
    return { tools };
  });

  // Handle call tool request
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.log(`[MCP] Calling tool: ${name}`);
    return await callTool(name, args ?? {});
  });

  return server;
}

export async function setupMCPRoutes(app: Express, server: Server): Promise<void> {
  // Store active transports by session ID
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // MCP endpoint - handles all MCP protocol messages
  app.all('/mcp', authMiddleware, async (req: Request, res: Response) => {
    // Check for existing session
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      // Reuse existing transport
      transport = transports.get(sessionId)!;
    } else if (req.method === 'POST' && !sessionId) {
      // New session - create transport
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports.set(newSessionId, transport);
          console.log(`[MCP] New session: ${newSessionId}`);
        },
      });

      // Clean up on close
      transport.onclose = () => {
        const sid = (transport as unknown as { sessionId?: string }).sessionId;
        if (sid) {
          transports.delete(sid);
          console.log(`[MCP] Session closed: ${sid}`);
        }
      };

      // Connect transport to server
      await server.connect(transport);
    } else if (sessionId && !transports.has(sessionId)) {
      // Invalid session
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    } else {
      // GET without session - return info
      res.json({
        name: 'pi-mcp-server',
        version: '1.0.0',
        transport: 'streamable-http',
      });
      return;
    }

    // Handle the request
    await transport.handleRequest(req, res, req.body);
  });

  // Session cleanup endpoint
  app.delete('/mcp', authMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.close();
      transports.delete(sessionId);
      res.json({ status: 'closed' });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  });
}

// ============================================================================
// REST API Routes - Simple direct tool access without MCP protocol
// ============================================================================

export function setupRESTRoutes(app: Express): void {
  // GET /api/tools - List all available tools
  app.get('/api/tools', authMiddleware, (_req: Request, res: Response) => {
    const tools = getAllTools();
    console.log(`[API] Listing ${tools.length} tools`);
    res.json({
      count: tools.length,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  });

  // GET /api/tools/:name - Get info for a specific tool
  app.get('/api/tools/:name', authMiddleware, (req: Request, res: Response) => {
    const tool = getTool(req.params.name);
    if (!tool) {
      res.status(404).json({ error: `Tool not found: ${req.params.name}` });
      return;
    }
    res.json({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
  });

  // POST /api/tools/:name - Execute a tool
  app.post('/api/tools/:name', authMiddleware, async (req: Request, res: Response) => {
    const toolName = req.params.name;
    const args = req.body || {};

    console.log(`[API] Calling tool: ${toolName}`);

    try {
      const result = await callTool(toolName, args);

      // Transform MCP result format to cleaner REST response
      const response: Record<string, unknown> = {
        success: !result.isError,
        tool: toolName,
      };

      // Parse JSON content if possible, otherwise return raw text
      if (result.content?.[0]?.type === 'text') {
        const text = result.content[0].text as string;
        try {
          response.data = JSON.parse(text);
        } catch {
          response.data = text;
        }
      }

      if (result.isError) {
        res.status(400).json(response);
      } else {
        res.json(response);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[API] Error in ${toolName}:`, message);
      res.status(500).json({
        success: false,
        tool: toolName,
        error: message,
      });
    }
  });

  console.log('[SERVER] REST API routes registered');
}
