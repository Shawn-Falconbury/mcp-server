import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import fs from 'node:fs/promises';
import { registerTool } from './index.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

type Rule =
  | { binary: string; kind: 'any' }
  | {
      binary: string;
      kind: 'sub1';
      allowed: Set<string>;
      // Rejected anywhere after the binary; prefix-matched so --output=FILE is caught.
      deniedFlags?: string[];
      // Subcommands that are read-only ONLY in bare/flag form. Given operands they
      // mutate, so these are flag-allowlisted and reject positional arguments.
      restricted?: Map<string, Set<string>>;
    }
  | {
      binary: string;
      kind: 'sub2';
      allowed: Map<string, Set<string>>;
      deniedFlags?: string[];
    };

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
    // `git diff --output=FILE` is an arbitrary file write as the service user —
    // enough to overwrite ~/.bashrc and get execution on next login.
    // `--ext-diff` runs diff.external if a repo config defines it.
    deniedFlags: ['--output', '-o', '--ext-diff'],
    // Read-only only in bare/flag form. With operands they mutate:
    //   git branch -D x / -m a b / newname  → delete / rename / create
    //   git reflog expire / delete          → destroy recovery history
    restricted: new Map([
      ['branch', new Set([
        '-a', '--all', '-r', '--remotes', '-v', '-vv', '--list',
        '--show-current', '--merged', '--no-merged',
      ])],
      ['reflog', new Set(['--all'])],
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
    // `gh auth status --show-token` prints the OAuth token in cleartext.
    deniedFlags: ['--show-token', '-t'],
  },
];

const EXACT_COMMANDS = new Set([
  'cat /proc/cpuinfo',
  'cat /proc/meminfo',
  'cat /sys/class/thermal/thermal_zone0/temp',
]);

// Reject anything that could enable shell chaining or substitution.
// With execFile this is now defence-in-depth rather than the sole control,
// but it still blocks obviously-malformed input early with a clear message.
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

  // Denied flags apply to every token after the binary, so they cannot be
  // smuggled in after an otherwise-allowed subcommand.
  if (rule.deniedFlags) {
    for (const tok of tokens.slice(1)) {
      const hit = rule.deniedFlags.find(f => tok === f || tok.startsWith(`${f}=`));
      if (hit) {
        return { ok: false, reason: `${binary}: flag not allowed: ${hit}` };
      }
    }
  }

  if (rule.kind === 'sub1') {
    const sub = tokens[1];
    if (!sub || !rule.allowed.has(sub)) {
      return {
        ok: false,
        reason: `${binary} subcommand not allowed: ${sub ?? '(missing)'}. Allowed: ${[...rule.allowed].sort().join(', ')}`,
      };
    }

    // Subcommands that only stay read-only without operands.
    const safeFlags = rule.restricted?.get(sub);
    if (safeFlags) {
      for (const tok of tokens.slice(2)) {
        if (!tok.startsWith('-')) {
          return {
            ok: false,
            reason:
              `${binary} ${sub}: operands are not allowed (got "${tok}"). ` +
              `This subcommand mutates the repository when given one.`,
          };
        }
        if (!safeFlags.has(tok)) {
          return {
            ok: false,
            reason: `${binary} ${sub}: flag not allowed: ${tok}. Allowed: ${[...safeFlags].sort().join(', ')}`,
          };
        }
      }
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
      const { stdout } = await execFileAsync('vcgencmd', ['measure_volts', 'core'], { timeout: 5000 });
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
    description: 'Run a whitelisted system command. Free-form: uptime, hostname, df, free, top, ps, who, date, uname, lsblk, lscpu, lsmem, vcgencmd. Restricted to read-only subcommands: git (status/log/diff/show/rev-parse/describe/ls-files/ls-tree/blame/shortlog/reflog/branch), gh (pr/issue/run/repo/release/workflow/auth — read-only actions only). Shell metacharacters (;, &, |, <, >, `, $) are rejected, and the command is executed without a shell.',
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
      // execFile, not exec: the command is already token-split for validation,
      // so run those tokens as argv and never involve /bin/sh. This closes the
      // parse differential between the whitespace split above and a shell's own
      // re-parsing (globbing, quotes), and makes SHELL_METACHARS defence-in-depth.
      const tokens = command.trim().split(/\s+/);
      const { stdout, stderr } = await execFileAsync(tokens[0], tokens.slice(1), { timeout: 30000 });
      const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
      return {
        content: [{ type: 'text', text: output || '(no output)' }],
      };
    } catch (error) {
      // Non-zero exit is often meaningful (git diff --exit-code, grep no-match),
      // so surface any partial output rather than only the error string.
      const e = error as { stdout?: string; stderr?: string; message?: string };
      if (e.stdout || e.stderr) {
        return {
          content: [{ type: 'text', text: (e.stdout || '') + (e.stderr ? `\nSTDERR:\n${e.stderr}` : '') }],
        };
      }
      return {
        content: [{ type: 'text', text: `Command failed: ${e.message ?? String(error)}` }],
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
    // callTool() has already schema-checked these, but bound defensively anyway:
    // `limit` reaches an argv slot and must be a clean integer regardless of caller.
    const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 20;
    const limit = Math.min(500, Math.max(1, Math.trunc(rawLimit)));
    const sortBy = args.sortBy === 'memory' ? 'memory' : 'cpu';
    const sortFlag = sortBy === 'memory' ? '--sort=-%mem' : '--sort=-%cpu';

    try {
      // No shell: run ps directly, slice the output in JS instead of `| head`.
      const { stdout } = await execFileAsync('ps', ['aux', sortFlag], { timeout: 10000 });
      const lines = stdout.split('\n');
      const clipped = lines.slice(0, limit + 1).join('\n');  // +1 keeps the header row
      return {
        content: [{ type: 'text', text: clipped }],
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
      const { stdout } = await execFileAsync('df', ['-h'], { timeout: 10000 });
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
