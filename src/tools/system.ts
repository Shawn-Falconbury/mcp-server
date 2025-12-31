import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import fs from 'node:fs/promises';
import { registerTool } from './index.js';

const execAsync = promisify(exec);

// Whitelist of allowed commands for security
const ALLOWED_COMMANDS = new Set([
  'uptime',
  'hostname',
  'df',
  'free',
  'top',
  'ps',
  'who',
  'date',
  'uname',
  'lsblk',
  'lscpu',
  'lsmem',
  'vcgencmd',  // Raspberry Pi specific
  'cat /proc/cpuinfo',
  'cat /proc/meminfo',
  'cat /sys/class/thermal/thermal_zone0/temp',
]);

// Check if command is in whitelist
function isCommandAllowed(cmd: string): boolean {
  const trimmed = cmd.trim();
  // Check exact match or if it starts with an allowed command
  return ALLOWED_COMMANDS.has(trimmed) ||
    Array.from(ALLOWED_COMMANDS).some(allowed => trimmed.startsWith(allowed + ' '));
}

// Get system info tool
registerTool({
  tool: {
    name: 'get_system_info',
    description: 'Get comprehensive system information about the Raspberry Pi',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    const info: Record<string, unknown> = {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      uptime: `${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`,
      memory: {
        total: `${Math.round(os.totalmem() / 1024 / 1024)} MB`,
        free: `${Math.round(os.freemem() / 1024 / 1024)} MB`,
        used: `${Math.round((os.totalmem() - os.freemem()) / 1024 / 1024)} MB`,
      },
      cpus: os.cpus().length,
      loadAvg: os.loadavg(),
    };

    // Try to get Pi-specific info
    try {
      const tempFile = '/sys/class/thermal/thermal_zone0/temp';
      const temp = await fs.readFile(tempFile, 'utf-8');
      info.cpuTemp = `${(parseInt(temp) / 1000).toFixed(1)}°C`;
    } catch {
      // Not available
    }

    try {
      const { stdout } = await execAsync('vcgencmd measure_volts core', { timeout: 5000 });
      info.coreVoltage = stdout.trim();
    } catch {
      // Not available (vcgencmd not present)
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
    };
  },
});

// Run whitelisted command tool
registerTool({
  tool: {
    name: 'run_command',
    description: 'Run a whitelisted system command. Allowed commands: uptime, hostname, df, free, top -bn1, ps, who, date, uname, lsblk, lscpu, vcgencmd',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to run (must be in whitelist)',
        },
      },
      required: ['command'],
    },
  },
  handler: async (args) => {
    const command = args.command as string;

    if (!isCommandAllowed(command)) {
      return {
        content: [{
          type: 'text',
          text: `Command not allowed: ${command}\n\nAllowed commands: ${Array.from(ALLOWED_COMMANDS).join(', ')}`,
        }],
        isError: true,
      };
    }

    try {
      const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
      const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
      return {
        content: [{ type: 'text', text: output || '(no output)' }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Command failed: ${message}` }],
        isError: true,
      };
    }
  },
});

// Get processes tool
registerTool({
  tool: {
    name: 'get_processes',
    description: 'Get a list of running processes with resource usage',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of processes to return (default: 20)',
        },
        sortBy: {
          type: 'string',
          enum: ['cpu', 'memory'],
          description: 'Sort by CPU or memory usage (default: cpu)',
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const limit = (args.limit as number) || 20;
    const sortBy = (args.sortBy as string) || 'cpu';

    const sortFlag = sortBy === 'memory' ? '--sort=-%mem' : '--sort=-%cpu';

    try {
      const { stdout } = await execAsync(
        `ps aux ${sortFlag} | head -n ${limit + 1}`,
        { timeout: 10000 }
      );
      return {
        content: [{ type: 'text', text: stdout }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get processes: ${message}` }],
        isError: true,
      };
    }
  },
});

// Get disk usage tool
registerTool({
  tool: {
    name: 'get_disk_usage',
    description: 'Get disk usage information for all mounted filesystems',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    try {
      const { stdout } = await execAsync('df -h', { timeout: 10000 });
      return {
        content: [{ type: 'text', text: stdout }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get disk usage: ${message}` }],
        isError: true,
      };
    }
  },
});

console.log('[TOOLS] System tools loaded');
