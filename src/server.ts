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
import { getAllTools, callTool } from './tools/index.js';

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
