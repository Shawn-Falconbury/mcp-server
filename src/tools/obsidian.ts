import fs from 'node:fs/promises';
import path from 'node:path';
import { registerTool } from './index.js';

// Get vault path from environment
function getVaultPath(): string | null {
  return process.env.OBSIDIAN_VAULT_PATH || null;
}

// Check if vault is available
async function isVaultAvailable(): Promise<boolean> {
  const vaultPath = getVaultPath();
  if (!vaultPath) return false;

  try {
    await fs.access(vaultPath);
    return true;
  } catch {
    return false;
  }
}

// Parse YAML frontmatter from markdown
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlStr = match[1];
  const body = match[2];

  // Simple YAML parsing for key: value pairs
  const frontmatter: Record<string, unknown> = {};
  for (const line of yamlStr.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      let value: string | string[] = line.slice(colonIndex + 1).trim();

      // Handle arrays (lines starting with -)
      if (value === '') {
        // Could be start of array, but for simplicity keep as empty string
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array
        value = value.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^["']|["']$/g, ''));
      }

      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

// Extract wikilinks from content
function extractWikilinks(content: string): string[] {
  const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const links: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1]);
  }
  return [...new Set(links)];
}

// List notes tool
registerTool({
  tool: {
    name: 'list_notes',
    description: 'List all notes in the Obsidian vault, optionally filtered by folder',
    inputSchema: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: 'Subfolder to list (relative to vault root). Leave empty for root.',
        },
        includeMetadata: {
          type: 'boolean',
          description: 'Include frontmatter metadata in results (default: false)',
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const vaultPathOrNull = getVaultPath();
    if (!vaultPathOrNull || !(await isVaultAvailable())) {
      return {
        content: [{ type: 'text', text: 'Obsidian vault not configured or not available' }],
        isError: true,
      };
    }
    const vaultPath = vaultPathOrNull; // Now guaranteed non-null

    const folder = (args.folder as string) || '';
    const includeMetadata = args.includeMetadata as boolean || false;
    const searchPath = path.join(vaultPath, folder);

    const notes: Array<{
      name: string;
      path: string;
      metadata?: Record<string, unknown>;
    }> = [];

    async function scanDir(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          // Skip .obsidian folder
          if (entry.name.startsWith('.')) continue;

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            await scanDir(fullPath);
          } else if (entry.name.endsWith('.md')) {
            const relativePath = path.relative(vaultPath, fullPath);
            const note: { name: string; path: string; metadata?: Record<string, unknown> } = {
              name: entry.name.replace('.md', ''),
              path: relativePath,
            };

            if (includeMetadata) {
              try {
                const content = await fs.readFile(fullPath, 'utf-8');
                const { frontmatter } = parseFrontmatter(content);
                note.metadata = frontmatter;
              } catch {
                // Skip metadata on error
              }
            }

            notes.push(note);
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    await scanDir(searchPath);

    return {
      content: [{ type: 'text', text: JSON.stringify(notes, null, 2) }],
    };
  },
});

// Read note tool
registerTool({
  tool: {
    name: 'read_note',
    description: 'Read the contents of an Obsidian note by name or path',
    inputSchema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'Note name (without .md) or relative path',
        },
      },
      required: ['note'],
    },
  },
  handler: async (args) => {
    const vaultPath = getVaultPath();
    if (!vaultPath || !(await isVaultAvailable())) {
      return {
        content: [{ type: 'text', text: 'Obsidian vault not configured or not available' }],
        isError: true,
      };
    }

    let notePath = args.note as string;
    if (!notePath.endsWith('.md')) {
      notePath += '.md';
    }

    const fullPath = path.join(vaultPath, notePath);

    // Security check - ensure path is within vault
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(vaultPath))) {
      return {
        content: [{ type: 'text', text: 'Access denied: path outside vault' }],
        isError: true,
      };
    }

    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);
      const wikilinks = extractWikilinks(content);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            path: notePath,
            frontmatter,
            content: body,
            wikilinks,
          }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to read note: ${message}` }],
        isError: true,
      };
    }
  },
});

// Search notes tool
registerTool({
  tool: {
    name: 'search_notes',
    description: 'Search for notes containing specific text or matching a pattern',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to search for in note content',
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Case sensitive search (default: false)',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 20)',
        },
      },
      required: ['query'],
    },
  },
  handler: async (args) => {
    const vaultPathOrNull = getVaultPath();
    if (!vaultPathOrNull || !(await isVaultAvailable())) {
      return {
        content: [{ type: 'text', text: 'Obsidian vault not configured or not available' }],
        isError: true,
      };
    }
    const vaultPath = vaultPathOrNull; // Now guaranteed non-null

    const query = args.query as string;
    const caseSensitive = args.caseSensitive as boolean || false;
    const limit = (args.limit as number) || 20;

    const results: Array<{
      path: string;
      matches: Array<{ line: number; text: string }>;
    }> = [];

    const searchPattern = caseSensitive ? query : query.toLowerCase();

    async function searchDir(dir: string): Promise<void> {
      if (results.length >= limit) return;

      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (results.length >= limit) break;
          if (entry.name.startsWith('.')) continue;

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            await searchDir(fullPath);
          } else if (entry.name.endsWith('.md')) {
            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              const searchContent = caseSensitive ? content : content.toLowerCase();

              if (searchContent.includes(searchPattern)) {
                const lines = content.split('\n');
                const matches: Array<{ line: number; text: string }> = [];

                for (let i = 0; i < lines.length; i++) {
                  const lineToSearch = caseSensitive ? lines[i] : lines[i].toLowerCase();
                  if (lineToSearch.includes(searchPattern)) {
                    matches.push({
                      line: i + 1,
                      text: lines[i].slice(0, 200), // Truncate long lines
                    });
                  }
                }

                results.push({
                  path: path.relative(vaultPath, fullPath),
                  matches: matches.slice(0, 5), // Max 5 matches per file
                });
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    await searchDir(vaultPath);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          query,
          resultCount: results.length,
          results,
        }, null, 2),
      }],
    };
  },
});

// Get backlinks tool
registerTool({
  tool: {
    name: 'get_backlinks',
    description: 'Find all notes that link to a specific note',
    inputSchema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'Note name to find backlinks for (without .md)',
        },
      },
      required: ['note'],
    },
  },
  handler: async (args) => {
    const vaultPathOrNull = getVaultPath();
    if (!vaultPathOrNull || !(await isVaultAvailable())) {
      return {
        content: [{ type: 'text', text: 'Obsidian vault not configured or not available' }],
        isError: true,
      };
    }
    const vaultPath = vaultPathOrNull; // Now guaranteed non-null

    const targetNote = args.note as string;
    const backlinks: Array<{ path: string; context: string }> = [];

    async function searchDir(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            await searchDir(fullPath);
          } else if (entry.name.endsWith('.md')) {
            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              const wikilinks = extractWikilinks(content);

              if (wikilinks.some(link =>
                link.toLowerCase() === targetNote.toLowerCase() ||
                link.toLowerCase().endsWith('/' + targetNote.toLowerCase())
              )) {
                // Find context around the link
                const lines = content.split('\n');
                for (const line of lines) {
                  if (line.toLowerCase().includes(`[[${targetNote.toLowerCase()}`)) {
                    backlinks.push({
                      path: path.relative(vaultPath, fullPath),
                      context: line.slice(0, 200),
                    });
                    break;
                  }
                }
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    await searchDir(vaultPath);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          note: targetNote,
          backlinkCount: backlinks.length,
          backlinks,
        }, null, 2),
      }],
    };
  },
});

console.log('[TOOLS] Obsidian tools loaded');
