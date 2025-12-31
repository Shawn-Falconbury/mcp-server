import https from 'node:https';
import { registerTool } from './index.js';

// UniFi API configuration
interface UniFiConfig {
  host: string;
  apiKey: string;
  site: string;
}

function getUniFiConfig(): UniFiConfig | null {
  const host = process.env.UNIFI_HOST;
  const apiKey = process.env.UNIFI_API_KEY;
  const site = process.env.UNIFI_SITE || 'default';

  if (!host || !apiKey) {
    return null;
  }

  return { host, apiKey, site };
}

// Custom HTTPS agent to handle self-signed certificates
const httpsAgent = new https.Agent({
  rejectUnauthorized: false, // UDM often uses self-signed certs
});

// Type for UniFi API responses
interface UniFiApiResponse {
  data: Record<string, unknown>[];
  meta?: { rc: string };
}

// Generic UniFi API request function
async function unifiRequest(
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: Record<string, unknown>
): Promise<UniFiApiResponse> {
  const config = getUniFiConfig();
  if (!config) {
    throw new Error('UniFi not configured. Set UNIFI_HOST and UNIFI_API_KEY environment variables.');
  }

  const url = `https://${config.host}${endpoint}`;

  const options: RequestInit = {
    method,
    headers: {
      'X-API-KEY': config.apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    // @ts-expect-error - Node.js fetch accepts agent option
    agent: httpsAgent,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`UniFi API error (${response.status}): ${text}`);
  }

  return response.json() as Promise<UniFiApiResponse>;
}

// Helper to build network API endpoint
function networkApi(path: string): string {
  const config = getUniFiConfig();
  const site = config?.site || 'default';
  return `/proxy/network/api/s/${site}/${path}`;
}

// ============================================================================
// READ-ONLY TOOLS
// ============================================================================

// Get all connected clients
registerTool({
  tool: {
    name: 'unifi_get_clients',
    description: 'Get all connected clients/devices on the UniFi network',
    inputSchema: {
      type: 'object',
      properties: {
        include_history: {
          type: 'boolean',
          description: 'Include recently disconnected clients (default: false)',
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const includeHistory = args.include_history as boolean;

    try {
      const endpoint = includeHistory ? 'stat/alluser' : 'stat/sta';
      const data = await unifiRequest(networkApi(endpoint));

      const clients = data.data.map((client) => ({
        mac: client.mac,
        name: client.name || client.hostname || 'Unknown',
        ip: client.ip,
        connected: client.is_wired ? 'Wired' : 'Wireless',
        network: client.network || client.essid || 'Unknown',
        uptime: client.uptime ? `${Math.floor((client.uptime as number) / 3600)}h ${Math.floor(((client.uptime as number) % 3600) / 60)}m` : 'N/A',
        tx_bytes: client.tx_bytes,
        rx_bytes: client.rx_bytes,
        signal: client.signal || 'N/A',
        blocked: client.blocked || false,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ count: clients.length, clients }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get clients: ${message}` }],
        isError: true,
      };
    }
  },
});

// Get UniFi network devices (APs, switches, gateways)
registerTool({
  tool: {
    name: 'unifi_get_devices',
    description: 'Get all UniFi network devices (access points, switches, gateways)',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    try {
      const data = await unifiRequest(networkApi('stat/device'));

      const devices = data.data.map((device) => ({
        name: device.name || 'Unnamed',
        mac: device.mac,
        model: device.model,
        type: device.type,
        ip: device.ip,
        version: device.version,
        state: device.state === 1 ? 'Connected' : 'Disconnected',
        uptime: device.uptime ? `${Math.floor((device.uptime as number) / 86400)}d ${Math.floor(((device.uptime as number) % 86400) / 3600)}h` : 'N/A',
        cpu: device['system-stats'] ? `${(device['system-stats'] as Record<string, unknown>).cpu}%` : 'N/A',
        mem: device['system-stats'] ? `${(device['system-stats'] as Record<string, unknown>).mem}%` : 'N/A',
        clients: device.num_sta || 0,
        upgradable: device.upgradable || false,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ count: devices.length, devices }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get devices: ${message}` }],
        isError: true,
      };
    }
  },
});

// Get network health
registerTool({
  tool: {
    name: 'unifi_get_network_health',
    description: 'Get overall network health and status',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    try {
      const data = await unifiRequest(networkApi('stat/health'));

      const health = data.data.map((subsystem) => ({
        subsystem: subsystem.subsystem,
        status: subsystem.status,
        num_user: subsystem.num_user,
        num_guest: subsystem.num_guest,
        num_adopted: subsystem.num_adopted,
        wan_ip: subsystem.wan_ip,
        isp_name: subsystem.isp_name,
        latency: subsystem.latency,
        uptime: subsystem.uptime,
        drops: subsystem.drops,
        xput_up: subsystem.xput_up,
        xput_down: subsystem.xput_down,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ health }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get network health: ${message}` }],
        isError: true,
      };
    }
  },
});

// Get alerts/notifications
registerTool({
  tool: {
    name: 'unifi_get_alerts',
    description: 'Get recent alerts and notifications from the UniFi controller',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of alerts to return (default: 50)',
        },
        archived: {
          type: 'boolean',
          description: 'Include archived alerts (default: false)',
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const limit = (args.limit as number) || 50;
    const archived = args.archived as boolean;

    try {
      const endpoint = archived ? 'stat/alarm' : 'stat/alarm';
      const data = await unifiRequest(networkApi(endpoint));

      const alerts = data.data
        .slice(0, limit)
        .map((alert) => ({
          id: alert._id,
          type: alert.key,
          message: alert.msg,
          time: alert.time ? new Date((alert.time as number) * 1000).toISOString() : 'Unknown',
          archived: alert.archived || false,
          handled_admin: alert.handled_admin_id,
        }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ count: alerts.length, alerts }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get alerts: ${message}` }],
        isError: true,
      };
    }
  },
});

// Get traffic statistics
registerTool({
  tool: {
    name: 'unifi_get_traffic_stats',
    description: 'Get bandwidth and traffic statistics',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['hourly', 'daily', 'monthly'],
          description: 'Time period for stats (default: hourly)',
        },
        limit: {
          type: 'number',
          description: 'Number of data points to return (default: 24)',
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const type = (args.type as string) || 'hourly';
    const limit = (args.limit as number) || 24;

    try {
      const attrs = ['bytes', 'wan-tx_bytes', 'wan-rx_bytes', 'num_sta'];
      const body = { attrs, n: limit };
      const data = await unifiRequest(
        networkApi(`stat/report/${type}.site`),
        'POST',
        body
      );

      const stats = data.data.map((point) => ({
        time: point.time ? new Date((point.time as number)).toISOString() : 'Unknown',
        wan_tx_gb: point['wan-tx_bytes'] ? ((point['wan-tx_bytes'] as number) / 1073741824).toFixed(2) : '0',
        wan_rx_gb: point['wan-rx_bytes'] ? ((point['wan-rx_bytes'] as number) / 1073741824).toFixed(2) : '0',
        num_clients: point.num_sta || 0,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ type, count: stats.length, stats }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get traffic stats: ${message}` }],
        isError: true,
      };
    }
  },
});

// Get detailed info for a specific client
registerTool({
  tool: {
    name: 'unifi_get_client_details',
    description: 'Get detailed information for a specific client by MAC address',
    inputSchema: {
      type: 'object',
      properties: {
        mac: {
          type: 'string',
          description: 'MAC address of the client (format: aa:bb:cc:dd:ee:ff)',
        },
      },
      required: ['mac'],
    },
  },
  handler: async (args) => {
    const mac = (args.mac as string).toLowerCase();

    try {
      const data = await unifiRequest(
        networkApi('stat/user/' + mac)
      );

      if (!data.data || data.data.length === 0) {
        return {
          content: [{ type: 'text', text: `Client not found: ${mac}` }],
          isError: true,
        };
      }

      const client = data.data[0] as Record<string, unknown>;
      const details = {
        mac: client.mac,
        name: client.name || client.hostname || 'Unknown',
        hostname: client.hostname,
        ip: client.ip,
        oui: client.oui,
        is_wired: client.is_wired,
        network: client.network || client.essid,
        vlan: client.vlan,
        first_seen: client.first_seen ? new Date((client.first_seen as number) * 1000).toISOString() : 'Unknown',
        last_seen: client.last_seen ? new Date((client.last_seen as number) * 1000).toISOString() : 'Unknown',
        uptime: client.uptime ? `${Math.floor((client.uptime as number) / 3600)}h ${Math.floor(((client.uptime as number) % 3600) / 60)}m` : 'N/A',
        tx_bytes: client.tx_bytes,
        rx_bytes: client.rx_bytes,
        tx_packets: client.tx_packets,
        rx_packets: client.rx_packets,
        signal: client.signal,
        noise: client.noise,
        channel: client.channel,
        radio: client.radio,
        blocked: client.blocked || false,
        noted: client.noted || false,
        note: client.note,
        fingerprint: client.fingerprint_override || client.dev_id_override,
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(details, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get client details: ${message}` }],
        isError: true,
      };
    }
  },
});

// ============================================================================
// MANAGEMENT TOOLS
// ============================================================================

// Block a client
registerTool({
  tool: {
    name: 'unifi_block_client',
    description: 'Block a client from accessing the network',
    inputSchema: {
      type: 'object',
      properties: {
        mac: {
          type: 'string',
          description: 'MAC address of the client to block (format: aa:bb:cc:dd:ee:ff)',
        },
      },
      required: ['mac'],
    },
  },
  handler: async (args) => {
    const mac = (args.mac as string).toLowerCase();

    try {
      await unifiRequest(
        networkApi('cmd/stamgr'),
        'POST',
        { cmd: 'block-sta', mac }
      );

      console.log(`[UNIFI] Blocked client: ${mac}`);
      return {
        content: [{
          type: 'text',
          text: `Successfully blocked client: ${mac}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to block client: ${message}` }],
        isError: true,
      };
    }
  },
});

// Unblock a client
registerTool({
  tool: {
    name: 'unifi_unblock_client',
    description: 'Unblock a previously blocked client',
    inputSchema: {
      type: 'object',
      properties: {
        mac: {
          type: 'string',
          description: 'MAC address of the client to unblock (format: aa:bb:cc:dd:ee:ff)',
        },
      },
      required: ['mac'],
    },
  },
  handler: async (args) => {
    const mac = (args.mac as string).toLowerCase();

    try {
      await unifiRequest(
        networkApi('cmd/stamgr'),
        'POST',
        { cmd: 'unblock-sta', mac }
      );

      console.log(`[UNIFI] Unblocked client: ${mac}`);
      return {
        content: [{
          type: 'text',
          text: `Successfully unblocked client: ${mac}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to unblock client: ${message}` }],
        isError: true,
      };
    }
  },
});

// Reconnect a client (force disconnect and reconnect)
registerTool({
  tool: {
    name: 'unifi_reconnect_client',
    description: 'Force a client to disconnect and reconnect to the network',
    inputSchema: {
      type: 'object',
      properties: {
        mac: {
          type: 'string',
          description: 'MAC address of the client to reconnect (format: aa:bb:cc:dd:ee:ff)',
        },
      },
      required: ['mac'],
    },
  },
  handler: async (args) => {
    const mac = (args.mac as string).toLowerCase();

    try {
      await unifiRequest(
        networkApi('cmd/stamgr'),
        'POST',
        { cmd: 'kick-sta', mac }
      );

      console.log(`[UNIFI] Reconnected client: ${mac}`);
      return {
        content: [{
          type: 'text',
          text: `Successfully forced reconnection for client: ${mac}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to reconnect client: ${message}` }],
        isError: true,
      };
    }
  },
});

// Restart a UniFi device
registerTool({
  tool: {
    name: 'unifi_restart_device',
    description: 'Restart a UniFi device (access point, switch, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        mac: {
          type: 'string',
          description: 'MAC address of the device to restart (format: aa:bb:cc:dd:ee:ff)',
        },
      },
      required: ['mac'],
    },
  },
  handler: async (args) => {
    const mac = (args.mac as string).toLowerCase();

    try {
      await unifiRequest(
        networkApi('cmd/devmgr'),
        'POST',
        { cmd: 'restart', mac }
      );

      console.log(`[UNIFI] Restarted device: ${mac}`);
      return {
        content: [{
          type: 'text',
          text: `Successfully initiated restart for device: ${mac}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to restart device: ${message}` }],
        isError: true,
      };
    }
  },
});

// Set client name/alias
registerTool({
  tool: {
    name: 'unifi_set_client_name',
    description: 'Set or update the name/alias for a client',
    inputSchema: {
      type: 'object',
      properties: {
        mac: {
          type: 'string',
          description: 'MAC address of the client (format: aa:bb:cc:dd:ee:ff)',
        },
        name: {
          type: 'string',
          description: 'New name/alias for the client',
        },
      },
      required: ['mac', 'name'],
    },
  },
  handler: async (args) => {
    const mac = (args.mac as string).toLowerCase();
    const name = args.name as string;

    try {
      // First get the client's user_id
      const userData = await unifiRequest(
        networkApi('stat/user/' + mac)
      );

      if (!userData.data || userData.data.length === 0) {
        return {
          content: [{ type: 'text', text: `Client not found: ${mac}` }],
          isError: true,
        };
      }

      const userId = userData.data[0]._id as string;

      // Update the client name
      await unifiRequest(
        networkApi('rest/user/' + userId),
        'PUT',
        { name }
      );

      console.log(`[UNIFI] Set client name: ${mac} -> ${name}`);
      return {
        content: [{
          type: 'text',
          text: `Successfully set name for ${mac} to "${name}"`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to set client name: ${message}` }],
        isError: true,
      };
    }
  },
});

// ============================================================================
// CYBERSECURE / THREAT MANAGEMENT TOOLS
// ============================================================================

// Get Threat Management (IPS/IDS) status
registerTool({
  tool: {
    name: 'unifi_get_threat_management',
    description: 'Get Threat Management (IPS/IDS) status and configuration',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    try {
      const data = await unifiRequest(networkApi('rest/setting/ips'));

      const settings = data.data[0];
      const result = {
        enabled: settings.ips_mode !== 'disabled',
        mode: settings.ips_mode, // 'disabled', 'ids', 'ips'
        ad_blocking: settings.ad_blocking_enabled,
        dns_filtering: settings.dns_filtering_enabled,
        dns_filter_mode: settings.dns_filtering_mode,
        honeypot_enabled: settings.honeypot_enabled,
        suppression: settings.suppression,
        enabled_categories: settings.enabled_categories,
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get threat management settings: ${message}` }],
        isError: true,
      };
    }
  },
});

// Get threat/IPS events
registerTool({
  tool: {
    name: 'unifi_get_threat_events',
    description: 'Get recent threat detection events (IPS/IDS alerts)',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of events to return (default: 50)',
        },
        start_time: {
          type: 'number',
          description: 'Start time (Unix timestamp in seconds) for filtering events',
        },
        end_time: {
          type: 'number',
          description: 'End time (Unix timestamp in seconds) for filtering events',
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const limit = (args.limit as number) || 50;
    const startTime = args.start_time as number | undefined;
    const endTime = args.end_time as number | undefined;

    try {
      const body: Record<string, unknown> = { _limit: limit };
      if (startTime) body.start = startTime * 1000;
      if (endTime) body.end = endTime * 1000;

      const data = await unifiRequest(
        networkApi('stat/ips/event'),
        'POST',
        body
      );

      const events = data.data.map((event) => ({
        id: event._id,
        timestamp: event.timestamp ? new Date(event.timestamp as number).toISOString() : 'Unknown',
        signature: event.signature,
        category: event.catname,
        severity: event.severity,
        action: event.action,
        source_ip: event.src_ip,
        source_port: event.src_port,
        dest_ip: event.dest_ip,
        dest_port: event.dest_port,
        protocol: event.proto,
        app: event.app,
        client_mac: event.src_mac,
        interface: event.in_iface,
        blocked: event.blocked,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ count: events.length, events }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get threat events: ${message}` }],
        isError: true,
      };
    }
  },
});

// Get blocked threats summary
registerTool({
  tool: {
    name: 'unifi_get_blocked_threats',
    description: 'Get summary of blocked threats and attack statistics',
    inputSchema: {
      type: 'object',
      properties: {
        hours: {
          type: 'number',
          description: 'Number of hours to look back (default: 24)',
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const hours = (args.hours as number) || 24;
    const startTime = Math.floor(Date.now() / 1000) - (hours * 3600);

    try {
      const data = await unifiRequest(
        networkApi('stat/ips/event'),
        'POST',
        { _limit: 1000, start: startTime * 1000 }
      );

      const events = data.data;

      // Aggregate statistics
      const stats = {
        total_events: events.length,
        blocked: events.filter((e) => e.blocked).length,
        by_category: {} as Record<string, number>,
        by_severity: {} as Record<string, number>,
        top_sources: {} as Record<string, number>,
        top_destinations: {} as Record<string, number>,
      };

      for (const event of events) {
        const category = (event.catname as string) || 'Unknown';
        const severity = String(event.severity || 'Unknown');
        const srcIp = (event.src_ip as string) || 'Unknown';
        const dstIp = (event.dest_ip as string) || 'Unknown';

        stats.by_category[category] = (stats.by_category[category] || 0) + 1;
        stats.by_severity[severity] = (stats.by_severity[severity] || 0) + 1;
        stats.top_sources[srcIp] = (stats.top_sources[srcIp] || 0) + 1;
        stats.top_destinations[dstIp] = (stats.top_destinations[dstIp] || 0) + 1;
      }

      // Sort and limit top sources/destinations
      const sortByValue = (obj: Record<string, number>, limit = 10) =>
        Object.fromEntries(
          Object.entries(obj)
            .sort(([, a], [, b]) => b - a)
            .slice(0, limit)
        );

      stats.top_sources = sortByValue(stats.top_sources);
      stats.top_destinations = sortByValue(stats.top_destinations);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ hours, stats }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get blocked threats: ${message}` }],
        isError: true,
      };
    }
  },
});

// Set Threat Management mode
registerTool({
  tool: {
    name: 'unifi_set_threat_management_mode',
    description: 'Enable or disable Threat Management (IPS/IDS)',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['disabled', 'ids', 'ips'],
          description: 'Mode: disabled (off), ids (detect only), ips (detect and block)',
        },
      },
      required: ['mode'],
    },
  },
  handler: async (args) => {
    const mode = args.mode as string;

    try {
      // First get current settings to get the _id
      const current = await unifiRequest(
        networkApi('rest/setting/ips')
      );

      if (!current.data || current.data.length === 0) {
        return {
          content: [{ type: 'text', text: 'Could not find IPS settings' }],
          isError: true,
        };
      }

      const settingsId = current.data[0]._id as string;

      await unifiRequest(
        networkApi('rest/setting/ips/' + settingsId),
        'PUT',
        { ips_mode: mode }
      );

      console.log(`[UNIFI] Set Threat Management mode: ${mode}`);
      return {
        content: [{
          type: 'text',
          text: `Successfully set Threat Management mode to: ${mode}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to set threat management mode: ${message}` }],
        isError: true,
      };
    }
  },
});

// Toggle ad blocking
registerTool({
  tool: {
    name: 'unifi_set_ad_blocking',
    description: 'Enable or disable ad blocking',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          description: 'Whether to enable ad blocking',
        },
      },
      required: ['enabled'],
    },
  },
  handler: async (args) => {
    const enabled = args.enabled as boolean;

    try {
      const current = await unifiRequest(
        networkApi('rest/setting/ips')
      );

      if (!current.data || current.data.length === 0) {
        return {
          content: [{ type: 'text', text: 'Could not find IPS settings' }],
          isError: true,
        };
      }

      const settingsId = current.data[0]._id as string;

      await unifiRequest(
        networkApi('rest/setting/ips/' + settingsId),
        'PUT',
        { ad_blocking_enabled: enabled }
      );

      console.log(`[UNIFI] Set ad blocking: ${enabled}`);
      return {
        content: [{
          type: 'text',
          text: `Successfully ${enabled ? 'enabled' : 'disabled'} ad blocking`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to set ad blocking: ${message}` }],
        isError: true,
      };
    }
  },
});

// Set DNS filtering
registerTool({
  tool: {
    name: 'unifi_set_dns_filtering',
    description: 'Configure DNS content filtering',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          description: 'Whether to enable DNS filtering',
        },
        mode: {
          type: 'string',
          enum: ['none', 'work', 'family'],
          description: 'Filter mode: none, work (no adult content), family (safe for kids)',
        },
      },
      required: ['enabled'],
    },
  },
  handler: async (args) => {
    const enabled = args.enabled as boolean;
    const mode = args.mode as string | undefined;

    try {
      const current = await unifiRequest(
        networkApi('rest/setting/ips')
      );

      if (!current.data || current.data.length === 0) {
        return {
          content: [{ type: 'text', text: 'Could not find IPS settings' }],
          isError: true,
        };
      }

      const settingsId = current.data[0]._id as string;

      const update: Record<string, unknown> = { dns_filtering_enabled: enabled };
      if (mode) {
        update.dns_filtering_mode = mode;
      }

      await unifiRequest(
        networkApi('rest/setting/ips/' + settingsId),
        'PUT',
        update
      );

      console.log(`[UNIFI] Set DNS filtering: ${enabled}, mode: ${mode || 'unchanged'}`);
      return {
        content: [{
          type: 'text',
          text: `Successfully ${enabled ? 'enabled' : 'disabled'} DNS filtering${mode ? ` with mode: ${mode}` : ''}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to set DNS filtering: ${message}` }],
        isError: true,
      };
    }
  },
});

// Get country/GeoIP blocking status
registerTool({
  tool: {
    name: 'unifi_get_geoip_filtering',
    description: 'Get country/GeoIP blocking configuration',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    try {
      const data = await unifiRequest(
        networkApi('rest/setting/country_block')
      );

      const settings = data.data[0];
      const result = {
        enabled: settings.enabled,
        blocked_countries: settings.blocked_countries || [],
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get GeoIP filtering: ${message}` }],
        isError: true,
      };
    }
  },
});

// Get Internet Security Score (CyberSecure)
registerTool({
  tool: {
    name: 'unifi_get_security_score',
    description: 'Get the Internet Security Score and recommendations',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    try {
      // Get IPS settings for security features status
      const ipsData = await unifiRequest(networkApi('rest/setting/ips'));
      const ips = ipsData.data[0];

      // Get firewall rules count
      let firewallRules = 0;
      try {
        const fwData = await unifiRequest(networkApi('rest/firewallrule'));
        firewallRules = fwData.data.length;
      } catch {
        // Firewall rules endpoint may not be available
      }

      const securityFeatures = {
        threat_management: {
          enabled: ips.ips_mode !== 'disabled',
          mode: ips.ips_mode,
        },
        ad_blocking: ips.ad_blocking_enabled || false,
        dns_filtering: {
          enabled: ips.dns_filtering_enabled || false,
          mode: ips.dns_filtering_mode,
        },
        honeypot: ips.honeypot_enabled || false,
        firewall_rules_count: firewallRules,
      };

      // Calculate a simple security score
      let score = 0;
      if (ips.ips_mode === 'ips') score += 30;
      else if (ips.ips_mode === 'ids') score += 15;
      if (ips.ad_blocking_enabled) score += 15;
      if (ips.dns_filtering_enabled) score += 20;
      if (ips.honeypot_enabled) score += 10;
      if (firewallRules > 0) score += Math.min(25, firewallRules * 5);

      const recommendations = [];
      if (ips.ips_mode === 'disabled') {
        recommendations.push('Enable Threat Management (IPS) for active threat blocking');
      } else if (ips.ips_mode === 'ids') {
        recommendations.push('Consider upgrading from IDS to IPS for active threat blocking');
      }
      if (!ips.ad_blocking_enabled) {
        recommendations.push('Enable ad blocking to reduce malicious ad exposure');
      }
      if (!ips.dns_filtering_enabled) {
        recommendations.push('Enable DNS filtering for content-level protection');
      }
      if (!ips.honeypot_enabled) {
        recommendations.push('Enable honeypot to detect internal network scanning');
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            score: Math.min(100, score),
            features: securityFeatures,
            recommendations,
          }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get security score: ${message}` }],
        isError: true,
      };
    }
  },
});

console.log('[TOOLS] UniFi tools loaded');
