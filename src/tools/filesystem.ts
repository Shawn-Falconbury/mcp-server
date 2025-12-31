import fs from 'node:fs/promises';
import path from 'node:path';
import { registerTool } from './index.js';

// Get allowed paths from environment
function getAllowedPaths(): string[] {
  const paths = process.env.ALLOWED_PATHS || '';
  return paths.split(',').map(p => p.trim()).filter(Boolean);
}

// Check if a path is within allowed directories
function isPathAllowed(targetPath: string): boolean {
  const allowed = getAllowedPaths();
  if (allowed.length === 0) {
    console.warn('[FILESYSTEM] No ALLOWED_PATHS configured - denying all access');
    return false;
  }

  const resolved = path.resolve(targetPath);
  return allowed.some(allowedPath => {
    const resolvedAllowed = path.resolve(allowedPath);
    return resolved.startsWith(resolvedAllowed);
  });
}

// Read file tool
registerTool({
  tool: {
    name: 'read_file',
    description: 'Read the contents of a file. Only works within allowed paths.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read',
        },
      },
      required: ['path'],
    },
  },
  handler: async (args) => {
    const filePath = args.path as string;

    if (!isPathAllowed(filePath)) {
      return {
        content: [{ type: 'text', text: `Access denied: ${filePath} is not in allowed paths` }],
        isError: true,
      };
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return {
        content: [{ type: 'text', text: content }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to read file: ${message}` }],
        isError: true,
      };
    }
  },
});

// Write file tool
registerTool({
  tool: {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it doesn\'t exist. Only works within allowed paths.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to write',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  },
  handler: async (args) => {
    const filePath = args.path as string;
    const content = args.content as string;

    if (!isPathAllowed(filePath)) {
      return {
        content: [{ type: 'text', text: `Access denied: ${filePath} is not in allowed paths` }],
        isError: true,
      };
    }

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
      return {
        content: [{ type: 'text', text: `Successfully wrote to ${filePath}` }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to write file: ${message}` }],
        isError: true,
      };
    }
  },
});

// List directory tool
registerTool({
  tool: {
    name: 'list_directory',
    description: 'List files and directories in a path. Only works within allowed paths.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the directory to list',
        },
      },
      required: ['path'],
    },
  },
  handler: async (args) => {
    const dirPath = args.path as string;

    if (!isPathAllowed(dirPath)) {
      return {
        content: [{ type: 'text', text: `Access denied: ${dirPath} is not in allowed paths` }],
        isError: true,
      };
    }

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const items = entries.map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to list directory: ${message}` }],
        isError: true,
      };
    }
  },
});

// Search files tool
registerTool({
  tool: {
    name: 'search_files',
    description: 'Search for files matching a pattern within allowed paths.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory to search in',
        },
        pattern: {
          type: 'string',
          description: 'Filename pattern to match (supports * and ? wildcards)',
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum depth to search (default: 5)',
        },
      },
      required: ['path', 'pattern'],
    },
  },
  handler: async (args) => {
    const searchPath = args.path as string;
    const pattern = args.pattern as string;
    const maxDepth = (args.maxDepth as number) || 5;

    if (!isPathAllowed(searchPath)) {
      return {
        content: [{ type: 'text', text: `Access denied: ${searchPath} is not in allowed paths` }],
        isError: true,
      };
    }

    const matches: string[] = [];

    async function search(dir: string, depth: number): Promise<void> {
      if (depth > maxDepth) return;

      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            await search(fullPath, depth + 1);
          } else if (matchesPattern(entry.name, pattern)) {
            matches.push(fullPath);
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }

    function matchesPattern(name: string, pat: string): boolean {
      const regex = pat
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      return new RegExp(`^${regex}$`, 'i').test(name);
    }

    await search(searchPath, 0);

    return {
      content: [{ type: 'text', text: JSON.stringify(matches, null, 2) }],
    };
  },
});

console.log('[TOOLS] Filesystem tools loaded');
