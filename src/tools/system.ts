import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import fs from 'node:fs/promises';
import { registerTool } from './index.js';

const execAsync = promisify(exec);

type Rule =
  | { binary: string; kind: 'any' }
  | { binary: string; kind: 'sub1'; allowed: Set<string> }
  | { binary: string; kind: 'sub2'; allowed: Map<string, Set<string>> };

const RULES: Rule[] = [
  { binary: 'uptime', kind: 'any' },
  { binary: 'hostname', kind: 'any' },
  { binary: 'df', kind: 'any' },
  { binary: 'free', kind: 'any' },
  { binary: 'top', kind: 'any' },
  { binary: 'ps', kind: 'any' },
  { binary: 'who', kind: 'any' },
  { binary: 'date', kind: 'any' },
  { binary: 'uname', kind: 'any' },
  { binary: 'lsblk', kind: 'any' },
  { binary: 'lscpu', kind: 'any' },
  { binary: 'lsmem', kind: 'any' },
  { binary: 'vcgencmd', kind: 'any' },
  {
    binary: 'git',
    kind: 'sub1',
    allowed: new Set([
      'status', 'log', 'diff', 'show', 'rev-parse', 'describe',
      'ls-files', 'ls-tree', 'blame', 'shortlog', 'reflog', 'branch',
    ]),
  },
  {
    binary: 'gh',
    kind: 'sub2',
    allowed: new Map([
      ['pr', new Set(['list', 'view', 'checks', 'status', 'diff'])],
      ['issue', new Set(['list', 'view'])],
      ['run', new Set(['list', 'view', 'watch'])],
      ['repo', new Set(['view', 'list'])],
      ['release', new Set(['list', 'view'])],
      ['workflow', new Set(['list', 'view'])],
      ['auth', new Set(['status'])],
    ]),
  },
];

const EXACT_COMMANDS = new Set([
  'cat /proc/cpuinfo',
  'cat /proc/meminfo',
  'cat /sys/class/thermal/thermal_zone0/temp',
]);

// Reject anything that could enable shell chaining or substitution
const SHELL_METACHARS = /[;&|<>`$\n]/;

type AllowResult = { ok: true } | { ok: false; reason: string };

function isCommandAllowed(cmd: string): AllowResult {
  const trimmed = cmd.trim();

  if (SHELL_METACHARS.test(trimmed)) {
    return { ok: false, reason: 'Command contains shell metacharacters (;, &, |, <, >, `, $, newline)' };
  }

  if (EXACT_COMMANDS.has(trimmed)) {
    return { ok: true };
  }

  const tokens = trimmed.split(/\s+/);
  const binary = tokens[0];
  const rule = RULES.find(r => r.binary === binary);
  if (!rule) {
    return { ok: false, reason: `Binary not in whitelist: ${binary}` };
  }

  if (rule.kind === 'any') {
    return { ok: true };
  }

  if (rule.kind === 'sub1') {
    const sub = tokens[1];
    if (!sub || !rule.allowed.has(sub)) {
      return {
        ok: false,
        reason: `${binary} subcommand not allowed: ${sub ?? '(missing)'}. Allowed: ${[...rule.allowed].sort().join(', ')}`,
      };
    }
    return { ok: true };
  }

  const group = tokens[1];
  const action = tokens[2];
  const groupAllowed = group ? rule.allowed.get(group) : undefined;
  if (!groupAllowed) {
    return {
      ok: false,
      reason: `${binary} group not allowed: ${group ?? '(missing)'}. Allowed groups: ${[...rule.allowed.keys()].sort().join(', ')}`,
    };
  }
  if (!action || !groupAllowed.has(action)) {
    return {
      ok: false,
      reason: `${binary} ${group} action not allowed: ${action ?? '(missing)'}. Allowed: ${[...groupAllowed].sort().join(', ')}`,
    };
  }
  return { ok: true };
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
    description: 'Run a whitelisted system command. Free-form: uptime, hostname, df, free, top, ps, who, date, uname, lsblk, lscpu, lsmem, vcgencmd. Restricted to read-only subcommands: git (status/log/diff/show/rev-parse/describe/ls-files/ls-tree/blame/shortlog/reflog/branch), gh (pr/issue/run/repo/release/workflow/auth — read-only actions only). Shell metacharacters (;, &, |, <, >, `, $) are rejected.',
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

    const check = isCommandAllowed(command);
    if (!check.ok) {
      return {
        content: [{ type: 'text', text: `Command not allowed: ${command}\n${check.reason}` }],
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
