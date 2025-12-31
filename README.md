# MCP Server

A custom [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that provides Claude Code and other MCP clients with secure access to filesystem, system information, Obsidian vault, SQLite database, and UniFi network controller tools.

## Features

- **Filesystem Tools** - Read, write, list, and search files within allowed paths
- **System Tools** - Get system info, run whitelisted commands, view processes and disk usage
- **Obsidian Tools** - List notes, read content, search text, and find backlinks in your vault
- **Database Tools** - Query SQLite databases with read-only access
- **UniFi Tools** - Query and manage UniFi Dream Machine networks, including Threat Management (CyberSecure)

## Security

- HTTPS with TLS certificates (Let's Encrypt supported)
- Bearer token authentication for all MCP requests
- Path restrictions for filesystem operations
- Command whitelist for system operations
- Read-only database access with query filtering
- API key authentication for UniFi integration

## Requirements

- Node.js 18+ (for native fetch support)
- npm or yarn
- TLS certificates (self-signed for development, Let's Encrypt for production)
- Optional: UniFi Dream Machine with API key

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Shawn-Falconbury/mcp-server.git
   cd mcp-server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment:
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

4. Generate TLS certificates (for development):
   ```bash
   mkdir -p certs
   openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt -days 365 -nodes -subj "/CN=localhost"
   ```

5. Build and run:
   ```bash
   npm run build
   npm start
   ```

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_TOKEN` | Yes | Authentication token for MCP clients |
| `MCP_PORT` | No | Server port (default: 8443) |
| `USE_HTTPS` | No | Use HTTPS (default: true) |
| `SSL_CERT_PATH` | No | Path to SSL certificate |
| `SSL_KEY_PATH` | No | Path to SSL private key |
| `ALLOWED_PATHS` | No | Comma-separated paths for filesystem access |
| `OBSIDIAN_VAULT_PATH` | No | Path to Obsidian vault |
| `DB_PATH` | No | Path to SQLite database |
| `UNIFI_HOST` | No | UniFi controller IP/hostname |
| `UNIFI_API_KEY` | No | UniFi API key |
| `UNIFI_SITE` | No | UniFi site name (default: "default") |

## Usage

### Development

```bash
npm run dev    # Run with tsx (hot reload)
```

### Production

```bash
npm run build  # Compile TypeScript
npm start      # Run compiled server
```

### Systemd Service

Create `/etc/systemd/system/mcp-server.service`:

```ini
[Unit]
Description=MCP Server
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/mcp-server
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable mcp-server
sudo systemctl start mcp-server
```

## Connecting Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "my-mcp-server": {
      "type": "http",
      "url": "https://your-server:8443/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_TOKEN"
      }
    }
  }
}
```

## Available Tools

See [docs/tools-reference.md](docs/tools-reference.md) for complete tool documentation.

### Tool Categories

| Category | Tools | Description |
|----------|-------|-------------|
| Filesystem | 4 | File read/write/list/search |
| System | 4 | System info and commands |
| Obsidian | 4 | Vault notes and search |
| Database | 3 | SQLite queries |
| UniFi | 17 | Network management and security |

## Project Structure

```
mcp-server/
├── src/
│   ├── index.ts          # Entry point
│   ├── server.ts         # Express + MCP setup
│   ├── auth.ts           # Token authentication
│   └── tools/
│       ├── index.ts      # Tool registry
│       ├── filesystem.ts # File operations
│       ├── system.ts     # System commands
│       ├── obsidian.ts   # Obsidian vault
│       ├── database.ts   # SQLite queries
│       └── unifi.ts      # UniFi controller
├── docs/                 # Documentation
├── certs/                # TLS certificates (not in repo)
├── dist/                 # Compiled output (not in repo)
├── .env                  # Configuration (not in repo)
└── .env.example          # Example configuration
```

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/mcp` | POST | Yes | MCP protocol endpoint |

## License

ISC

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.
