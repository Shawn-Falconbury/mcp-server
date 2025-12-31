# UniFi Integration Setup

Guide for setting up the UniFi tools to connect to your UniFi Dream Machine.

## Prerequisites

- UniFi Dream Machine (UDM, UDM Pro, UDM SE, or UDM Pro SE)
- UniFi OS 3.0+ (tested with UniFi OS 5.x)
- Network access from MCP server to UniFi controller

## Generating an API Key

1. Log in to your UniFi Dream Machine web interface
2. Navigate to **Settings** (gear icon)
3. Go to **System** > **Advanced**
4. Scroll down to **API** section
5. Click **Create New API Key**
6. Give it a descriptive name (e.g., "MCP Server")
7. Copy the generated API key - **you won't be able to see it again!**

## Configuration

Add the following to your `.env` file:

```bash
# UniFi Dream Machine configuration
UNIFI_HOST=192.168.1.1        # IP address of your UDM
UNIFI_API_KEY=your_api_key    # API key from step above
UNIFI_SITE=default            # Site name (usually "default")
```

### Finding Your Site Name

Most UniFi installations use the default site named `default`. If you have multiple sites:

1. Go to your UniFi Network application
2. Look at the URL - it will contain the site name
3. Example: `https://192.168.1.1/network/default/dashboard`

## Testing the Connection

After configuration, restart the MCP server and check the logs:

```bash
sudo systemctl restart mcp-server
sudo journalctl -u mcp-server -n 50
```

You should see:
```
[TOOLS] Registered tool: unifi_get_clients
[TOOLS] Registered tool: unifi_get_devices
...
[TOOLS] UniFi tools loaded
```

## Security Considerations

### API Key Permissions

The UniFi API key has full access to your network controller. Keep it secure:

- Never commit the API key to version control
- Use environment variables, not hardcoded values
- Rotate the key periodically
- Revoke immediately if compromised

### Network Access

The MCP server needs HTTPS access to your UniFi controller:

- Default port: 443
- The UniFi controller uses a self-signed certificate by default
- The MCP server is configured to accept self-signed certificates

### Firewall Rules

If your MCP server is on a different network segment:

```bash
# Allow MCP server to reach UniFi controller
# Example: MCP server at 192.168.1.100, UDM at 192.168.1.1
iptables -A OUTPUT -d 192.168.1.1 -p tcp --dport 443 -j ACCEPT
```

## Available Operations

### Read-Only Operations

These tools query data without making changes:

| Tool | Description |
|------|-------------|
| `unifi_get_clients` | List connected clients |
| `unifi_get_devices` | List UniFi devices |
| `unifi_get_network_health` | Network status |
| `unifi_get_alerts` | Recent alerts |
| `unifi_get_traffic_stats` | Bandwidth statistics |
| `unifi_get_client_details` | Detailed client info |
| `unifi_get_threat_management` | IPS/IDS status |
| `unifi_get_threat_events` | Threat events |
| `unifi_get_blocked_threats` | Threat statistics |
| `unifi_get_geoip_filtering` | Country blocking |
| `unifi_get_security_score` | Security assessment |

### Management Operations

These tools make changes to your network:

| Tool | Description | Impact |
|------|-------------|--------|
| `unifi_block_client` | Block a device | Device loses network access |
| `unifi_unblock_client` | Unblock a device | Device regains access |
| `unifi_reconnect_client` | Force reconnection | Brief connection drop |
| `unifi_restart_device` | Restart AP/switch | Service interruption |
| `unifi_set_client_name` | Rename client | Cosmetic only |
| `unifi_set_threat_management_mode` | Change IPS mode | Security policy change |
| `unifi_set_ad_blocking` | Toggle ad blocking | Traffic filtering change |
| `unifi_set_dns_filtering` | Change DNS filtering | Content access change |

## Troubleshooting

### Connection Refused

```
Error: UniFi API error (ECONNREFUSED)
```

**Solution:** Verify the UNIFI_HOST IP is correct and reachable:
```bash
curl -k https://YOUR_UDM_IP/api/system
```

### Authentication Failed

```
Error: UniFi API error (401): Unauthorized
```

**Solution:** Check your API key is correct and hasn't been revoked.

### Certificate Errors

The UniFi tools are configured to accept self-signed certificates. If you still see certificate errors, ensure Node.js isn't enforcing strict certificate validation elsewhere.

### Site Not Found

```
Error: UniFi API error (404)
```

**Solution:** Verify your UNIFI_SITE setting. Try `default` if unsure.

## API Reference

The UniFi tools use these API endpoints:

| Endpoint | Purpose |
|----------|---------|
| `/proxy/network/api/s/{site}/stat/sta` | Client list |
| `/proxy/network/api/s/{site}/stat/device` | Device list |
| `/proxy/network/api/s/{site}/stat/health` | Network health |
| `/proxy/network/api/s/{site}/stat/alarm` | Alerts |
| `/proxy/network/api/s/{site}/cmd/stamgr` | Client management |
| `/proxy/network/api/s/{site}/cmd/devmgr` | Device management |
| `/proxy/network/api/s/{site}/rest/setting/ips` | IPS settings |
| `/proxy/network/api/s/{site}/stat/ips/event` | IPS events |
