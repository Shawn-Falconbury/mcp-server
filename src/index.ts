import 'dotenv/config';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, createMCPServer, setupMCPRoutes } from './server.js';

// Import and register tools
import './tools/filesystem.js';
import './tools/system.js';
import './tools/obsidian.js';
import './tools/database.js';
import './tools/unifi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  const port = parseInt(process.env.MCP_PORT || '8443', 10);
  const useHttps = process.env.USE_HTTPS !== 'false';

  // Validate required env vars
  if (!process.env.MCP_TOKEN) {
    console.error('ERROR: MCP_TOKEN environment variable is required');
    process.exit(1);
  }

  // Create express app and MCP server
  const app = createApp();
  const mcpServer = createMCPServer();

  // Set up MCP routes
  await setupMCPRoutes(app, mcpServer);

  // Start server
  if (useHttps) {
    // Support configurable cert paths (for Let's Encrypt) or fall back to local certs
    const certPath = process.env.SSL_CERT_PATH || path.join(projectRoot, 'certs', 'server.crt');
    const keyPath = process.env.SSL_KEY_PATH || path.join(projectRoot, 'certs', 'server.key');

    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      console.error('ERROR: TLS certificates not found');
      console.error(`  Cert path: ${certPath}`);
      console.error(`  Key path: ${keyPath}`);
      console.error('Set SSL_CERT_PATH and SSL_KEY_PATH env vars or generate local certs');
      process.exit(1);
    }

    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };

    https.createServer(httpsOptions, app).listen(port, '0.0.0.0', () => {
      console.log(`[SERVER] MCP server running on https://0.0.0.0:${port}`);
      console.log(`[SERVER] Health check: https://localhost:${port}/health`);
      console.log(`[SERVER] MCP endpoint: https://localhost:${port}/mcp`);
    });
  } else {
    // HTTP mode for development
    http.createServer(app).listen(port, '0.0.0.0', () => {
      console.log(`[SERVER] MCP server running on http://0.0.0.0:${port}`);
      console.log(`[SERVER] WARNING: Running without TLS - for development only`);
    });
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
