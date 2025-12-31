# MCP Tools Reference

Complete reference for all tools available on the MCP server.

## Table of Contents

- [Filesystem Tools](#filesystem-tools)
- [System Tools](#system-tools)
- [Obsidian Tools](#obsidian-tools)
- [Database Tools](#database-tools)
- [UniFi Tools](#unifi-tools)
- [UniFi Threat Management Tools](#unifi-threat-management-tools)

---

## Filesystem Tools

### read_file

Read the contents of a file within allowed paths.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Absolute path to the file |

**Example:**
```json
{
  "name": "read_file",
  "arguments": {
    "path": "/home/user/projects/example.txt"
  }
}
```

---

### write_file

Write content to a file. Creates the file if it doesn't exist.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Absolute path to the file |
| `content` | string | Yes | Content to write |

---

### list_directory

List files and directories in a path.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Absolute path to directory |

**Returns:** Array of `{name, type}` objects where type is "file", "directory", or "other".

---

### search_files

Search for files matching a pattern.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Directory to search in |
| `pattern` | string | Yes | Filename pattern (* and ? wildcards) |
| `maxDepth` | number | No | Max depth (default: 5) |

---

## System Tools

### get_system_info

Get comprehensive system information.

**Parameters:** None

**Returns:**
```json
{
  "hostname": "server",
  "platform": "linux",
  "arch": "arm64",
  "uptime": "5h 23m",
  "memory": { "total": "8192 MB", "free": "4096 MB" },
  "cpus": 4,
  "loadAvg": [0.5, 0.3, 0.2],
  "cpuTemp": "45.2°C"
}
```

---

### run_command

Execute a whitelisted system command.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `command` | string | Yes | Command to run (must be whitelisted) |

**Allowed commands:**
- `uptime`, `hostname`, `df`, `free`, `top`, `ps`, `who`, `date`
- `uname`, `lsblk`, `lscpu`, `lsmem`, `vcgencmd`
- `cat /proc/cpuinfo`, `cat /proc/meminfo`

---

### get_processes

Get running processes with resource usage.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `limit` | number | No | Max processes (default: 20) |
| `sortBy` | string | No | "cpu" or "memory" (default: cpu) |

---

### get_disk_usage

Get disk usage for all mounted filesystems.

**Parameters:** None

---

## Obsidian Tools

### list_notes

List notes in the Obsidian vault.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `folder` | string | No | Subfolder to list (relative to vault root) |
| `includeMetadata` | boolean | No | Include frontmatter (default: false) |

---

### read_note

Read an Obsidian note by name or path.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `note` | string | Yes | Note name (without .md) or relative path |

**Returns:**
```json
{
  "path": "folder/note.md",
  "frontmatter": { "tags": ["example"] },
  "content": "# Note Title\n...",
  "wikilinks": ["Other Note", "Another Note"]
}
```

---

### search_notes

Search for notes containing specific text.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Text to search for |
| `caseSensitive` | boolean | No | Case sensitive (default: false) |
| `limit` | number | No | Max results (default: 20) |

---

### get_backlinks

Find all notes that link to a specific note.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `note` | string | Yes | Note name to find backlinks for |

---

## Database Tools

### list_tables

List all tables in the configured SQLite database.

**Parameters:** None

**Returns:** Array of tables with column information.

---

### query_sqlite

Execute a read-only SQL query.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | SQL SELECT query |
| `limit` | number | No | Max rows (default: 100, max: 1000) |

**Security:** Only SELECT queries allowed. INSERT, UPDATE, DELETE, DROP are blocked.

---

### get_table_schema

Get detailed schema for a specific table.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `table` | string | Yes | Table name |

**Returns:** Columns, indexes, foreign keys, and row count.

---

## UniFi Tools

Tools for querying and managing a UniFi Dream Machine network controller.

### unifi_get_clients

Get all connected clients/devices on the UniFi network.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `include_history` | boolean | No | Include recently disconnected clients (default: false) |

**Returns:** List of clients with MAC, name, IP, connection type, network, uptime, and traffic stats.

**Example Response:**
```json
{
  "count": 25,
  "clients": [
    {
      "mac": "aa:bb:cc:dd:ee:ff",
      "name": "iPhone",
      "ip": "192.168.1.100",
      "connected": "Wireless",
      "network": "Home WiFi",
      "uptime": "2h 30m",
      "tx_bytes": 1234567,
      "rx_bytes": 7654321,
      "signal": -45,
      "blocked": false
    }
  ]
}
```

---

### unifi_get_devices

Get all UniFi network devices (access points, switches, gateways).

**Parameters:** None

**Returns:** List of devices with name, MAC, model, IP, version, state, uptime, CPU/memory usage, and client count.

---

### unifi_get_network_health

Get overall network health and status.

**Parameters:** None

**Returns:** Health status for each subsystem (WAN, WLAN, etc.) including WAN IP, ISP, latency, and throughput.

---

### unifi_get_alerts

Get recent alerts and notifications from the UniFi controller.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `limit` | number | No | Max alerts to return (default: 50) |
| `archived` | boolean | No | Include archived alerts (default: false) |

---

### unifi_get_traffic_stats

Get bandwidth and traffic statistics.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | string | No | "hourly", "daily", or "monthly" (default: hourly) |
| `limit` | number | No | Number of data points (default: 24) |

---

### unifi_get_client_details

Get detailed information for a specific client by MAC address.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `mac` | string | Yes | MAC address (format: aa:bb:cc:dd:ee:ff) |

**Returns:** Comprehensive client info including first/last seen, traffic, signal strength, and more.

---

### unifi_block_client

Block a client from accessing the network.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `mac` | string | Yes | MAC address to block |

---

### unifi_unblock_client

Unblock a previously blocked client.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `mac` | string | Yes | MAC address to unblock |

---

### unifi_reconnect_client

Force a client to disconnect and reconnect.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `mac` | string | Yes | MAC address to reconnect |

---

### unifi_restart_device

Restart a UniFi device (access point, switch, etc.).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `mac` | string | Yes | MAC address of device to restart |

---

### unifi_set_client_name

Set or update the name/alias for a client.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `mac` | string | Yes | MAC address of client |
| `name` | string | Yes | New name/alias |

---

## UniFi Threat Management Tools

Tools for managing UniFi Threat Management (CyberSecure) features including IPS/IDS, ad blocking, and DNS filtering.

### unifi_get_threat_management

Get Threat Management (IPS/IDS) status and configuration.

**Parameters:** None

**Returns:**
```json
{
  "enabled": true,
  "mode": "ips",
  "ad_blocking": true,
  "dns_filtering": true,
  "dns_filter_mode": "family",
  "honeypot_enabled": false,
  "suppression": {},
  "enabled_categories": []
}
```

---

### unifi_get_threat_events

Get recent threat detection events (IPS/IDS alerts).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `limit` | number | No | Max events (default: 50) |
| `start_time` | number | No | Start time (Unix timestamp in seconds) |
| `end_time` | number | No | End time (Unix timestamp in seconds) |

**Returns:** List of threat events with signature, category, severity, source/dest IPs, and action taken.

---

### unifi_get_blocked_threats

Get summary of blocked threats and attack statistics.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `hours` | number | No | Hours to look back (default: 24) |

**Returns:**
```json
{
  "hours": 24,
  "stats": {
    "total_events": 150,
    "blocked": 145,
    "by_category": {
      "Malware": 50,
      "Scan": 30,
      "DoS": 20
    },
    "by_severity": {
      "1": 10,
      "2": 50,
      "3": 90
    },
    "top_sources": {
      "1.2.3.4": 25,
      "5.6.7.8": 15
    },
    "top_destinations": {
      "192.168.1.100": 30
    }
  }
}
```

---

### unifi_set_threat_management_mode

Enable or disable Threat Management (IPS/IDS).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `mode` | string | Yes | "disabled", "ids" (detect only), or "ips" (detect and block) |

---

### unifi_set_ad_blocking

Enable or disable ad blocking.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `enabled` | boolean | Yes | Whether to enable ad blocking |

---

### unifi_set_dns_filtering

Configure DNS content filtering.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `enabled` | boolean | Yes | Whether to enable DNS filtering |
| `mode` | string | No | "none", "work" (no adult content), or "family" (safe for kids) |

---

### unifi_get_geoip_filtering

Get country/GeoIP blocking configuration.

**Parameters:** None

**Returns:**
```json
{
  "enabled": true,
  "blocked_countries": ["CN", "RU", "KP"]
}
```

---

### unifi_get_security_score

Get the Internet Security Score and recommendations.

**Parameters:** None

**Returns:**
```json
{
  "score": 75,
  "features": {
    "threat_management": {
      "enabled": true,
      "mode": "ips"
    },
    "ad_blocking": true,
    "dns_filtering": {
      "enabled": true,
      "mode": "family"
    },
    "honeypot": false,
    "firewall_rules_count": 5
  },
  "recommendations": [
    "Enable honeypot to detect internal network scanning"
  ]
}
```
