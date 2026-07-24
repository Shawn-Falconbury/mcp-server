import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerTool } from './index.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// Ansible Tools — Execute Ansible commands on RHEL 10 VM via SSH
// ============================================================================

const SSH_HOST = 'ansible-rhel10';  // Defined in ~/.ssh/config
const ANSIBLE_DIR = '/opt/ansible-network';
const SSH_TIMEOUT = 120000;  // 2 minutes for playbook runs
const SSH_TIMEOUT_SHORT = 30000;  // 30 seconds for quick commands

// Allowed playbook paths (relative to ANSIBLE_DIR)
const ALLOWED_PLAYBOOKS = new Set([
  // Cisco playbooks
  'playbooks/test_connectivity.yml',
  'playbooks/show_commands.yml',
  'playbooks/backup_configs.yml',
  'playbooks/deploy_config.yml',
  'playbooks/deploy_baseline.yml',
  'playbooks/compliance_check.yml',
  'playbooks/detect_changes.yml',
  'playbooks/rollback_config.yml',
  // Linux playbooks
  'playbooks/linux/system_update.yml',
  'playbooks/linux/service_health.yml',
  'playbooks/linux/config_backup.yml',
  'playbooks/linux/docker_management.yml',
  'playbooks/linux/firewall_audit.yml',
  'playbooks/linux/system_report.yml',
]);

// Allowed ad-hoc modules
const ALLOWED_MODULES = new Set([
  'ping',
  'setup',
  'command',
  'shell',
  'ios_facts',
  'ios_command',
  'ios_ping',
]);

// ============================================================================
// Quoting and validation
//
// Design note (2026-07-23): this file previously used a character-stripping
// sanitize() that silently deleted ( ) + * | > & \ and others from user input.
// That corrupted commands without warning — a psql query was rewritten into a
// different, still-valid query that returned wrong results. It also did NOT
// close the hole it was aimed at: it allowed ' through, which broke out of the
// inner -a '...' quoting on the control node, and it interpolated `target`
// unquoted, permitting arbitrary ansible flag injection (--become, -e, -m).
//
// The replacement rule is: QUOTE user substrings, REJECT malformed identifiers,
// never rewrite silently. Server-authored shell syntax (&&, ||, 2>/dev/null,
// globs) stays outside the quotes where it is still live.
// ============================================================================

/**
 * POSIX single-quote escaping. Safe for every byte except NUL.
 * Closes the quote, emits a literal quote, reopens.
 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

class ValidationError extends Error {}

// Ansible host patterns legitimately use : ! & * [ ] for set operations and
// ranges (webservers:!staging, all:&linux, web[01:05]). The old sanitize()
// stripped ! & * — so those patterns were quietly broken too.
const RE_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.:!&*[\]-]*$/;
const RE_MODULE = /^[a-z0-9_.]+$/;
const RE_PLAYBOOK = /^[A-Za-z0-9_./-]+$/;
const RE_TAGS = /^[A-Za-z0-9_,.-]+$/;

function must(value: string, re: RegExp, field: string, hint: string): string {
  if (!re.test(value)) {
    throw new ValidationError(
      `Invalid ${field}: ${JSON.stringify(value)}\n${hint}\n` +
      'Nothing was executed. This input is rejected, not rewritten.'
    );
  }
  return value;
}

/** Coerce a numeric option to a bounded integer. */
function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Shared error shaping so ValidationError surfaces cleanly, not as a stack. */
function toErrorResult(error: unknown, prefix: string) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{
      type: 'text' as const,
      text: error instanceof ValidationError ? message : `${prefix}: ${message}`,
    }],
    isError: true,
  };
}

/**
 * Execute a command on the RHEL 10 VM via SSH.
 *
 * `remoteCommand` must already be safe: server-authored shell syntax plus
 * shq()-quoted user substrings. Passing argv (execFile, not exec) means the
 * Pi's local /bin/sh never parses any of this — one whole parser layer gone.
 */
async function sshExec(
  remoteCommand: string,
  timeout: number = SSH_TIMEOUT,
): Promise<{ stdout: string; stderr: string }> {
  const remote = `cd ${ANSIBLE_DIR} && ${remoteCommand}`;
  const argv = [
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    SSH_HOST,
    remote,
  ];

  if (process.env.MCP_DEBUG_ANSIBLE) {
    console.error('[ansible] remote:', remote);
  }

  try {
    const { stdout, stderr } = await execFileAsync('ssh', argv, {
      timeout,
      maxBuffer: 1024 * 1024 * 5,  // 5MB buffer for large outputs
    });
    return { stdout, stderr };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (execError.killed) {
      throw new Error(`Command timed out after ${timeout / 1000}s`);
    }
    // Return partial output if available
    if (execError.stdout || execError.stderr) {
      return {
        stdout: execError.stdout || '',
        stderr: execError.stderr || execError.message || 'Command failed',
      };
    }
    throw new Error(execError.message || 'SSH command failed');
  }
}

// ── ansible_run_playbook ──
registerTool({
  tool: {
    name: 'ansible_run_playbook',
    description: 'Run an Ansible playbook on the RHEL 10 control node. Supports --limit, --tags, --check, --diff, and extra vars.',
    inputSchema: {
      type: 'object',
      properties: {
        playbook: {
          type: 'string',
          description: 'Playbook path relative to /opt/ansible-network (e.g., "playbooks/backup_configs.yml", "playbooks/linux/service_health.yml")',
        },
        limit: {
          type: 'string',
          description: 'Limit execution to specific hosts or groups (e.g., "OFFICE-ISO-R1", "all_linux", "pi1")',
        },
        tags: {
          type: 'string',
          description: 'Run only tasks tagged with these tags (e.g., "ntp,snmp", "banner")',
        },
        extra_vars: {
          type: 'string',
          description: 'Extra variables as key=value or JSON (e.g., "target_hosts=pi1", "docker_update=true")',
        },
        check_mode: {
          type: 'boolean',
          description: 'Dry run — show what would change without making changes (--check --diff)',
        },
      },
      required: ['playbook'],
    },
  },
  handler: async (args) => {
    try {
      const playbook = must(
        String(args.playbook ?? ''), RE_PLAYBOOK, 'playbook',
        'Expected a path relative to /opt/ansible-network.',
      );

      if (!ALLOWED_PLAYBOOKS.has(playbook)) {
        return {
          content: [{
            type: 'text',
            text: `Playbook not allowed: ${playbook}\n\nAllowed playbooks:\n${Array.from(ALLOWED_PLAYBOOKS).join('\n')}`,
          }],
          isError: true,
        };
      }

      let cmd = `ansible-playbook ${shq(playbook)}`;

      if (args.limit) {
        const limit = must(
          String(args.limit), RE_TARGET, 'limit',
          'Expected an Ansible host pattern (letters, digits, . _ - : ! & * [ ]).',
        );
        cmd += ` --limit ${shq(limit)}`;
      }
      if (args.tags) {
        const tags = must(
          String(args.tags), RE_TAGS, 'tags',
          'Expected comma-separated tag names.',
        );
        cmd += ` --tags ${shq(tags)}`;
      }
      if (args.extra_vars) {
        // shq() is sufficient here: JSON braces, quotes and spaces must survive.
        cmd += ` -e ${shq(String(args.extra_vars))}`;
      }
      if (args.check_mode) {
        cmd += ' --check --diff';
      }

      const { stdout, stderr } = await sshExec(cmd, SSH_TIMEOUT);
      const output = stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : '');
      return {
        content: [{ type: 'text', text: output || '(no output)' }],
      };
    } catch (error) {
      return toErrorResult(error, 'Playbook execution failed');
    }
  },
});

// ── ansible_ping ──
registerTool({
  tool: {
    name: 'ansible_ping',
    description: 'Test Ansible connectivity to hosts or groups using the ping module.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Host, group, or pattern to ping (e.g., "all", "all_linux", "OFFICE-ISO-R1", "pi1")',
        },
      },
      required: ['target'],
    },
  },
  handler: async (args) => {
    try {
      const target = must(
        String(args.target ?? ''), RE_TARGET, 'target',
        'Expected an Ansible host pattern (letters, digits, . _ - : ! & * [ ]).',
      );
      const cmd = `ansible ${shq(target)} -m ping`;

      const { stdout, stderr } = await sshExec(cmd, SSH_TIMEOUT_SHORT);
      const output = stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : '');
      return {
        content: [{ type: 'text', text: output || '(no output)' }],
      };
    } catch (error) {
      return toErrorResult(error, 'Ping failed');
    }
  },
});

// ── ansible_list_inventory ──
registerTool({
  tool: {
    name: 'ansible_list_inventory',
    description: 'List Ansible inventory — hosts, groups, and variables. Optionally filter by group or host.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Group or host to show (default: "all"). Use "all_linux" for Linux hosts, "all_routers" for routers, etc.',
        },
        show_vars: {
          type: 'boolean',
          description: 'Include host variables in output (default: false)',
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    try {
      const target = must(
        String(args.target ?? 'all') || 'all', RE_TARGET, 'target',
        'Expected an Ansible host or group name.',
      );
      const graphFlag = args.show_vars ? '--list' : '--graph';

      // The || and 2>/dev/null below are server-authored and stay live;
      // only the target is quoted.
      const cmd = target !== 'all'
        ? `ansible-inventory ${graphFlag} --host ${shq(target)} 2>/dev/null || ansible-inventory --graph ${shq(target)}`
        : `ansible-inventory ${graphFlag}`;

      const { stdout, stderr } = await sshExec(cmd, SSH_TIMEOUT_SHORT);
      const output = stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : '');
      return {
        content: [{ type: 'text', text: output || '(no output)' }],
      };
    } catch (error) {
      return toErrorResult(error, 'Inventory query failed');
    }
  },
});

// ── ansible_view_log ──
registerTool({
  tool: {
    name: 'ansible_view_log',
    description: 'View recent Ansible log entries or specific log files (backup, compliance, change detection, Linux health).',
    inputSchema: {
      type: 'object',
      properties: {
        log_type: {
          type: 'string',
          enum: ['ansible', 'backup', 'compliance', 'change_detection', 'linux_health', 'linux_backup', 'linux_update'],
          description: 'Which log to view: "ansible" for main log, or specific automation log',
        },
        lines: {
          type: 'number',
          description: 'Number of lines to return (default: 50)',
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    try {
      const logType = String(args.log_type ?? 'ansible');
      const lines = boundedInt(args.lines, 50, 1, 10000);

      // Map log types to file patterns. Keys are the only accepted input, so
      // the resulting path is server-controlled — no user text reaches the shell.
      const logPaths: Record<string, string> = {
        ansible: 'logs/ansible.log',
        backup: 'logs/backup_*.log',
        compliance: 'logs/compliance_*.log',
        change_detection: 'logs/change_detection_*.log',
        linux_health: 'logs/linux_health_*.log',
        linux_backup: 'logs/linux_backup_*.log',
        linux_update: 'logs/linux_update_*.log',
      };

      const logPath = logPaths[logType];
      if (!logPath) {
        return {
          content: [{
            type: 'text',
            text: `Unknown log type: ${logType}\nValid types: ${Object.keys(logPaths).join(', ')}`,
          }],
          isError: true,
        };
      }

      // For wildcard patterns, get the most recent file
      const cmd = logPath.includes('*')
        ? `ls -t ${logPath} 2>/dev/null | head -1 | xargs tail -n ${lines} 2>/dev/null || echo "No ${logType} logs found"`
        : `tail -n ${lines} ${logPath} 2>/dev/null || echo "Log file not found: ${logPath}"`;

      const { stdout } = await sshExec(cmd, SSH_TIMEOUT_SHORT);
      return {
        content: [{ type: 'text', text: stdout || '(empty log)' }],
      };
    } catch (error) {
      return toErrorResult(error, 'Log read failed');
    }
  },
});

// ── ansible_git_log ──
registerTool({
  tool: {
    name: 'ansible_git_log',
    description: 'View Git commit history for the Ansible project — shows configuration change history, backup timestamps, and diffs.',
    inputSchema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of commits to show (default: 20)',
        },
        path: {
          type: 'string',
          description: 'Filter to a specific path (e.g., "configs/routers/OFFICE-ISO-R1/", "configs/linux/pi1/")',
        },
        diff: {
          type: 'boolean',
          description: 'Show the actual diff for the most recent commit (default: false)',
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    try {
      const count = boundedInt(args.count, 20, 1, 1000);
      const filePath = args.path
        ? must(String(args.path), RE_PLAYBOOK, 'path', 'Expected a repository-relative path.')
        : '';
      const pathArg = filePath ? ` -- ${shq(filePath)}` : '';
      const showDiff = args.diff === true;

      const cmd = showDiff
        ? `git log -1 --format='commit %h - %s (%cr)'${pathArg} && echo '---' && git diff HEAD~1${pathArg}`
        : `git log --oneline -n ${count}${pathArg}`;

      const { stdout } = await sshExec(cmd, SSH_TIMEOUT_SHORT);
      return {
        content: [{ type: 'text', text: stdout || '(no commits found)' }],
      };
    } catch (error) {
      return toErrorResult(error, 'Git log failed');
    }
  },
});

// ── ansible_compliance_report ──
registerTool({
  tool: {
    name: 'ansible_compliance_report',
    description: 'Read the latest compliance report for a device, or list all available reports.',
    inputSchema: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Device name to get report for (e.g., "OFFICE-ISO-R1"). Omit to list all reports.',
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    try {
      const device = args.device
        ? must(String(args.device), RE_TARGET, 'device', 'Expected a device name from inventory.')
        : '';

      let cmd: string;
      if (device) {
        // shq() closes before _*.txt so the glob stays live outside the quotes.
        cmd =
          `ls -t compliance_reports/${shq(device)}_*.txt 2>/dev/null | head -1 | xargs cat 2>/dev/null ` +
          `|| echo "No compliance report found for" ${shq(device)}`;
      } else {
        // List all reports with timestamps
        cmd = `ls -lt compliance_reports/*.txt 2>/dev/null | head -20 || echo "No compliance reports found"`;
      }

      const { stdout } = await sshExec(cmd, SSH_TIMEOUT_SHORT);
      return {
        content: [{ type: 'text', text: stdout || '(no reports found)' }],
      };
    } catch (error) {
      return toErrorResult(error, 'Report read failed');
    }
  },
});

// ── ansible_run_adhoc ──
registerTool({
  tool: {
    name: 'ansible_run_adhoc',
    description:
      'Run an ad-hoc Ansible command against hosts. Supports ping, setup (facts), command, shell, and Cisco IOS modules. ' +
      'Shell metacharacters in `args` (| > & ( ) * + \\ etc.) are passed through intact. ' +
      'Malformed `target` or `module` values are rejected with an error rather than rewritten.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Host, group, or pattern (e.g., "all", "OFFICE-ISO-R1", "all_linux", "pi2")',
        },
        module: {
          type: 'string',
          description: 'Ansible module to run (e.g., "ping", "command", "setup", "ios_command")',
        },
        args: {
          type: 'string',
          description: 'Module arguments (e.g., "uptime" for command module, "commands=show version" for ios_command)',
        },
        allow_templating: {
          type: 'boolean',
          description:
            'Let Ansible Jinja-template the args string (default false). When false, args containing ' +
            '{{ }} or {% %} are wrapped in {% raw %} so Docker --format, Go templates and Jinja-like ' +
            'literals pass through intact.',
        },
      },
      required: ['target', 'module'],
    },
  },
  handler: async (args) => {
    try {
      const target = must(
        String(args.target ?? ''), RE_TARGET, 'target',
        'Expected an Ansible host pattern (letters, digits, . _ - : ! & * [ ]).',
      );
      const module = must(
        String(args.module ?? ''), RE_MODULE, 'module',
        'Expected a module name like "shell", "command", "ping".',
      );

      if (!ALLOWED_MODULES.has(module)) {
        return {
          content: [{
            type: 'text',
            text: `Module not allowed: ${module}\n\nAllowed modules: ${Array.from(ALLOWED_MODULES).join(', ')}`,
          }],
          isError: true,
        };
      }

      let moduleArgs = args.args ? String(args.args) : '';

      // A NUL byte cannot survive an argv boundary — reject rather than truncate silently.
      if (moduleArgs.includes('\0')) {
        throw new ValidationError('args contains a NUL byte.');
      }

      // Jinja containment. Ansible templates the -a string before module
      // dispatch, which is what breaks `docker ps --format '{{.Names}}'`.
      if (args.allow_templating !== true && /\{\{|\{%/.test(moduleArgs)) {
        moduleArgs = `{% raw %}${moduleArgs}{% endraw %} `;
      }

      // shq() on target as well: even if RE_TARGET ever lets something through,
      // ansible receives exactly one host pattern and cannot be fed extra flags.
      let cmd = `ansible ${shq(target)} -m ${shq(module)}`;
      if (moduleArgs) {
        cmd += ` -a ${shq(moduleArgs)}`;
      }

      const { stdout, stderr } = await sshExec(cmd, SSH_TIMEOUT);
      const output = stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : '');
      return {
        content: [{ type: 'text', text: output || '(no output)' }],
      };
    } catch (error) {
      return toErrorResult(error, 'Ad-hoc command failed');
    }
  },
});

console.log('[TOOLS] Ansible tools loaded (RHEL 10 via SSH)');
