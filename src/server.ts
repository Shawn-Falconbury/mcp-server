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

// Send a keepalive ping every 25s so idle connections survive the ~15min
// upstream idle timeout. A successful ping proves the client is alive.
const HEARTBEAT_INTERVAL_MS = 25_000;
// Reap sessions with no request AND no successful ping for this long.
// onclose never fires for silently-dropped connections, so this sweep is
// what actually prevents the session map from growing forever.
const SESSION_IDLE_TIMEOUT_MS = 15 * 60_000;
const REAPER_INTERVAL_MS = 60_000;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastSeen: number;
  heartbeat?: NodeJS.Timeout;
}

export function setupMCPRoutes(app: Express): void {
  // Active sessions by session ID. Each session gets its OWN Server instance:
  // the SDK routes responses through the most recently connected transport, so
  // sharing one Server across sessions misdelivers responses after reconnects.
  const sessions = new Map<string, SessionEntry>();

  // Periodic sweep for sessions whose connection died without a clean close
  setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of sessions) {
      const idleMs = now - entry.lastSeen;
      if (idleMs > SESSION_IDLE_TIMEOUT_MS) {
        console.log(`[MCP] Reaping stale session: ${sid} (idle ${Math.round(idleMs / 1000)}s)`);
        // close() fires onclose, which removes the entry and clears the heartbeat
        entry.transport.close().catch((err) => {
          console.error(`[MCP] Error closing stale session ${sid}:`, err);
          sessions.delete(sid);
        });
      }
    }
  }, REAPER_INTERVAL_MS).unref();

  // MCP endpoint - handles all MCP protocol messages.
  // DELETE (session termination) is also handled here: transport.handleRequest()
  // implements it and fires onclose for cleanup.
  app.all('/mcp', authMiddleware, async (req: Request, res: Response) => {
    // Check for existing session
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && sessions.has(sessionId)) {
      // Reuse existing transport
      const entry = sessions.get(sessionId)!;
      entry.lastSeen = Date.now();
      transport = entry.transport;
    } else if (req.method === 'POST' && !sessionId) {
      // New session - create a dedicated transport + server pair
      const server = createMCPServer();

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (newSessionId) => {
          const entry: SessionEntry = { transport, server, lastSeen: Date.now() };
          // Heartbeat doubles as a liveness probe: only a client response
          // refreshes lastSeen, so dead peers age out via the reaper.
          entry.heartbeat = setInterval(() => {
            server
              .ping()
              .then(() => {
                entry.lastSeen = Date.now();
              })
              .catch(() => {
                // No SSE stream open or client unresponsive - reaper decides
              });
          }, HEARTBEAT_INTERVAL_MS);
          sessions.set(newSessionId, entry);
          console.log(`[MCP] New session: ${newSessionId} (${sessions.size} active)`);
        },
      });

      // Clean up on close. Must be set BEFORE server.connect() so the SDK
      // chains it (connect wraps any existing onclose/onerror handlers).
      const cleanup = (reason: string) => {
        const sid = transport.sessionId;
        if (!sid) return;
        const entry = sessions.get(sid);
        if (entry) {
          clearInterval(entry.heartbeat);
          sessions.delete(sid);
          console.log(`[MCP] Session closed: ${sid} - ${reason} (${sessions.size} active)`);
        }
      };
      transport.onclose = () => cleanup('closed');
      transport.onerror = (error) => {
        console.error(`[MCP] Transport error on session ${transport.sessionId}:`, error);
        // Ensure cleanup fires on error paths too; close() triggers onclose
        transport.close().catch(() => cleanup('error'));
      };

      // Connect transport to its dedicated server
      await server.connect(transport);
    } else if (sessionId && !sessions.has(sessionId)) {
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
