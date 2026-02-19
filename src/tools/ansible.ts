import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { registerTool } from './index.js';

const execAsync = promisify(exec);

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

/**
 * Execute a command on the RHEL 10 VM via SSH
 */
async function sshExec(command: string, timeout: number = SSH_TIMEOUT): Promise<{ stdout: string; stderr: string }> {
  // Escape the command for SSH
  const sshCommand = `ssh -o ConnectTimeout=10 -o BatchMode=yes ${SSH_HOST} 'cd ${ANSIBLE_DIR} && ${command.replace(/'/g, "'\\''")}'`;

  try {
    const { stdout, stderr } = await execAsync(sshCommand, {
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

/**
 * Sanitize user input to prevent command injection
 */
function sanitize(input: string): string {
  // Allow alphanumeric, hyphens, underscores, dots, slashes, colons, commas, equals, spaces
  return input.replace(/[^a-zA-Z0-9\-_./: ,=@[\]{}'"]/g, '');
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
    const playbook = sanitize(args.playbook as string);

    if (!ALLOWED_PLAYBOOKS.has(playbook)) {
      return {
        content: [{
          type: 'text',
          text: `Playbook not allowed: ${playbook}\n\nAllowed playbooks:\n${Array.from(ALLOWED_PLAYBOOKS).join('\n')}`,
        }],
        isError: true,
      };
    }

    let cmd = `ansible-playbook ${playbook}`;

    if (args.limit) {
      cmd += ` --limit '${sanitize(args.limit as string)}'`;
    }
    if (args.tags) {
      cmd += ` --tags '${sanitize(args.tags as string)}'`;
    }
    if (args.extra_vars) {
      cmd += ` -e '${sanitize(args.extra_vars as string)}'`;
    }
    if (args.check_mode) {
      cmd += ' --check --diff';
    }

    try {
      const { stdout, stderr } = await sshExec(cmd, SSH_TIMEOUT);
      const output = stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : '');
      return {
        content: [{ type: 'text', text: output || '(no output)' }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Playbook execution failed: ${message}` }],
        isError: true,
      };
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
    const target = sanitize(args.target as string);
    const cmd = `ansible ${target} -m ping`;

    try {
      const { stdout, stderr } = await sshExec(cmd, SSH_TIMEOUT_SHORT);
      const output = stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : '');
      return {
        content: [{ type: 'text', text: output || '(no output)' }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Ping failed: ${message}` }],
        isError: true,
      };
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
    const target = sanitize((args.target as string) || 'all');
    const graphFlag = args.show_vars ? '--list' : '--graph';

    const cmd = `ansible-inventory ${graphFlag} ${target !== 'all' ? `--host ${target} 2>/dev/null || ansible-inventory --graph ${target}` : ''}`;

    try {
      const { stdout, stderr } = await sshExec(cmd, SSH_TIMEOUT_SHORT);
      const output = stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : '');
      return {
        content: [{ type: 'text', text: output || '(no output)' }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Inventory query failed: ${message}` }],
        isError: true,
      };
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
    const logType = (args.log_type as string) || 'ansible';
    const lines = (args.lines as number) || 50;

    // Map log types to file patterns
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

    try {
      const { stdout } = await sshExec(cmd, SSH_TIMEOUT_SHORT);
      return {
        content: [{ type: 'text', text: stdout || '(empty log)' }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Log read failed: ${message}` }],
        isError: true,
      };
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
    const count = (args.count as number) || 20;
    const filePath = args.path ? sanitize(args.path as string) : '';
    const showDiff = args.diff || false;

    let cmd: string;
    if (showDiff) {
      cmd = `git log -1 --format='commit %h - %s (%cr)' ${filePath} && echo '---' && git diff HEAD~1 ${filePath}`;
    } else {
      cmd = `git log --oneline -n ${count} ${filePath}`;
    }

    try {
      const { stdout } = await sshExec(cmd, SSH_TIMEOUT_SHORT);
      return {
        content: [{ type: 'text', text: stdout || '(no commits found)' }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Git log failed: ${message}` }],
        isError: true,
      };
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
    const device = args.device ? sanitize(args.device as string) : '';

    let cmd: string;
    if (device) {
      // Get the latest report for a specific device
      cmd = `ls -t compliance_reports/${device}_*.txt 2>/dev/null | head -1 | xargs cat 2>/dev/null || echo "No compliance report found for ${device}"`;
    } else {
      // List all reports with timestamps
      cmd = `ls -lt compliance_reports/*.txt 2>/dev/null | head -20 || echo "No compliance reports found"`;
    }

    try {
      const { stdout } = await sshExec(cmd, SSH_TIMEOUT_SHORT);
      return {
        content: [{ type: 'text', text: stdout || '(no reports found)' }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Report read failed: ${message}` }],
        isError: true,
      };
    }
  },
});

// ── ansible_run_adhoc ──
registerTool({
  tool: {
    name: 'ansible_run_adhoc',
    description: 'Run an ad-hoc Ansible command against hosts. Supports ping, setup (facts), command, shell, and Cisco IOS modules.',
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
      },
      required: ['target', 'module'],
    },
  },
  handler: async (args) => {
    const target = sanitize(args.target as string);
    const module = sanitize(args.module as string);
    const moduleArgs = args.args ? sanitize(args.args as string) : '';

    if (!ALLOWED_MODULES.has(module)) {
      return {
        content: [{
          type: 'text',
          text: `Module not allowed: ${module}\n\nAllowed modules: ${Array.from(ALLOWED_MODULES).join(', ')}`,
        }],
        isError: true,
      };
    }

    let cmd = `ansible ${target} -m ${module}`;
    if (moduleArgs) {
      cmd += ` -a '${moduleArgs}'`;
    }

    try {
      const { stdout, stderr } = await sshExec(cmd, SSH_TIMEOUT);
      const output = stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : '');
      return {
        content: [{ type: 'text', text: output || '(no output)' }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Ad-hoc command failed: ${message}` }],
        isError: true,
      };
    }
  },
});

console.log('[TOOLS] Ansible tools loaded (RHEL 10 via SSH)');
