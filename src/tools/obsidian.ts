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

// Create note tool
registerTool({
  tool: {
    name: 'create_note',
    description: 'Create a new note in the Obsidian vault',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path for the new note relative to vault root (without .md extension)',
        },
        content: {
          type: 'string',
          description: 'Markdown content for the note',
        },
        frontmatter: {
          type: 'object',
          description: 'Optional key-value pairs for YAML frontmatter',
        },
        overwrite: {
          type: 'boolean',
          description: 'If true, overwrite existing note (default: false)',
        },
      },
      required: ['path', 'content'],
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

    let notePath = args.path as string;
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

    const overwrite = args.overwrite as boolean || false;
    const frontmatter = args.frontmatter as Record<string, unknown> | undefined;
    const content = args.content as string;

    try {
      // Check if note already exists
      try {
        await fs.access(fullPath);
        if (!overwrite) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, path: notePath, message: 'Note already exists. Set overwrite: true to replace it.' }, null, 2) }],
            isError: true,
          };
        }
      } catch {
        // File doesn't exist, which is expected
      }

      // Create parent directories if they don't exist
      const parentDir = path.dirname(fullPath);
      await fs.mkdir(parentDir, { recursive: true });

      // Build the file content
      let fileContent = '';

      if (frontmatter && Object.keys(frontmatter).length > 0) {
        const yamlLines: string[] = ['---'];
        for (const [key, value] of Object.entries(frontmatter)) {
          if (Array.isArray(value)) {
            yamlLines.push(`${key}:`);
            for (const item of value) {
              yamlLines.push(`  - ${item}`);
            }
          } else {
            yamlLines.push(`${key}: ${value}`);
          }
        }
        yamlLines.push('---');
        fileContent = yamlLines.join('\n') + '\n' + content;
      } else {
        fileContent = content;
      }

      await fs.writeFile(fullPath, fileContent, 'utf-8');

      console.log(`[OBSIDIAN] Created note: ${notePath}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, path: notePath, message: 'Note created successfully' }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to create note: ${message}` }],
        isError: true,
      };
    }
  },
});

// Update note tool
registerTool({
  tool: {
    name: 'update_note',
    description: 'Replace the entire content of an existing note',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the note relative to vault root',
        },
        content: {
          type: 'string',
          description: 'New markdown content',
        },
        preserveFrontmatter: {
          type: 'boolean',
          description: 'If true, keep existing frontmatter (default: false)',
        },
      },
      required: ['path', 'content'],
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

    let notePath = args.path as string;
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

    const preserveFrontmatter = args.preserveFrontmatter as boolean || false;
    const newContent = args.content as string;

    try {
      // Check if note exists
      try {
        await fs.access(fullPath);
      } catch {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, path: notePath, message: 'Note does not exist' }, null, 2) }],
          isError: true,
        };
      }

      let fileContent = newContent;

      if (preserveFrontmatter) {
        const existingContent = await fs.readFile(fullPath, 'utf-8');
        const { frontmatter } = parseFrontmatter(existingContent);

        if (Object.keys(frontmatter).length > 0) {
          const yamlLines: string[] = ['---'];
          for (const [key, value] of Object.entries(frontmatter)) {
            if (Array.isArray(value)) {
              yamlLines.push(`${key}:`);
              for (const item of value) {
                yamlLines.push(`  - ${item}`);
              }
            } else {
              yamlLines.push(`${key}: ${value}`);
            }
          }
          yamlLines.push('---');
          fileContent = yamlLines.join('\n') + '\n' + newContent;
        }
      }

      await fs.writeFile(fullPath, fileContent, 'utf-8');

      console.log(`[OBSIDIAN] Updated note: ${notePath}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, path: notePath, message: 'Note updated successfully' }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to update note: ${message}` }],
        isError: true,
      };
    }
  },
});

// Append to note tool
registerTool({
  tool: {
    name: 'append_to_note',
    description: 'Add content to the end of an existing note',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the note relative to vault root',
        },
        content: {
          type: 'string',
          description: 'Content to append',
        },
        separator: {
          type: 'string',
          description: 'String to insert before appended content (default: "\\n\\n")',
        },
      },
      required: ['path', 'content'],
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

    let notePath = args.path as string;
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

    const contentToAppend = args.content as string;
    const separator = (args.separator as string) ?? '\n\n';

    try {
      // Check if note exists
      let existingContent: string;
      try {
        existingContent = await fs.readFile(fullPath, 'utf-8');
      } catch {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, path: notePath, message: 'Note does not exist' }, null, 2) }],
          isError: true,
        };
      }

      const newContent = existingContent + separator + contentToAppend;
      await fs.writeFile(fullPath, newContent, 'utf-8');

      console.log(`[OBSIDIAN] Appended to note: ${notePath}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, path: notePath, message: 'Content appended successfully' }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to append to note: ${message}` }],
        isError: true,
      };
    }
  },
});

// Delete note tool
registerTool({
  tool: {
    name: 'delete_note',
    description: 'Delete a note (moves to .trash folder)',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the note relative to vault root',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to proceed with deletion',
        },
      },
      required: ['path', 'confirm'],
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

    const confirm = args.confirm as boolean;
    if (!confirm) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Deletion not confirmed. Set confirm: true to proceed.' }, null, 2) }],
        isError: true,
      };
    }

    let notePath = args.path as string;
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
      // Check if note exists
      try {
        await fs.access(fullPath);
      } catch {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, path: notePath, message: 'Note does not exist' }, null, 2) }],
          isError: true,
        };
      }

      // Try to move to .trash folder
      const trashPath = path.join(vaultPath, '.trash');
      const trashedNotePath = path.join(trashPath, path.basename(notePath));

      let movedToTrash = false;
      try {
        await fs.mkdir(trashPath, { recursive: true });
        await fs.rename(fullPath, trashedNotePath);
        movedToTrash = true;
      } catch {
        // If moving to trash fails, delete permanently
        await fs.unlink(fullPath);
      }

      console.log(`[OBSIDIAN] Deleted note: ${notePath} (trash: ${movedToTrash})`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            path: notePath,
            message: movedToTrash ? 'Note moved to trash' : 'Note deleted permanently (trash unavailable)',
          }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to delete note: ${message}` }],
        isError: true,
      };
    }
  },
});

console.log('[TOOLS] Obsidian tools loaded');
