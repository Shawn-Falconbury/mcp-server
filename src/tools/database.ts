import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { registerTool } from './index.js';

// Get database path from environment
function getDbPath(): string | null {
  return process.env.DB_PATH || null;
}

// Open database connection
function openDatabase(): Database.Database | null {
  const dbPath = getDbPath();
  if (!dbPath) return null;

  try {
    // Check if file exists
    if (!fs.existsSync(dbPath)) {
      return null;
    }
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

// List tables tool
registerTool({
  tool: {
    name: 'list_tables',
    description: 'List all tables in the configured SQLite database',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    const db = openDatabase();
    if (!db) {
      return {
        content: [{ type: 'text', text: 'Database not configured or not available' }],
        isError: true,
      };
    }

    try {
      const tables = db.prepare(`
        SELECT name, type
        FROM sqlite_master
        WHERE type IN ('table', 'view')
        AND name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `).all() as Array<{ name: string; type: string }>;

      const result = tables.map(t => {
        // Get column info for each table
        const columns = db.prepare(`PRAGMA table_info("${t.name}")`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }>;

        return {
          name: t.name,
          type: t.type,
          columns: columns.map(c => ({
            name: c.name,
            type: c.type,
            nullable: !c.notnull,
            primaryKey: !!c.pk,
          })),
        };
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to list tables: ${message}` }],
        isError: true,
      };
    } finally {
      db.close();
    }
  },
});

// Query SQLite tool
registerTool({
  tool: {
    name: 'query_sqlite',
    description: 'Execute a read-only SQL query on the configured SQLite database. Only SELECT queries are allowed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'SQL SELECT query to execute',
        },
        limit: {
          type: 'number',
          description: 'Maximum rows to return (default: 100, max: 1000)',
        },
      },
      required: ['query'],
    },
  },
  handler: async (args) => {
    const db = openDatabase();
    if (!db) {
      return {
        content: [{ type: 'text', text: 'Database not configured or not available' }],
        isError: true,
      };
    }

    const query = (args.query as string).trim();
    const limit = Math.min((args.limit as number) || 100, 1000);

    // Security: Only allow SELECT queries
    const normalized = query.toLowerCase();
    if (!normalized.startsWith('select')) {
      return {
        content: [{
          type: 'text',
          text: 'Only SELECT queries are allowed. Use list_tables to see available tables.',
        }],
        isError: true,
      };
    }

    // Block dangerous keywords
    const forbidden = ['insert', 'update', 'delete', 'drop', 'alter', 'create', 'attach', 'detach'];
    for (const word of forbidden) {
      if (normalized.includes(word)) {
        return {
          content: [{
            type: 'text',
            text: `Query contains forbidden keyword: ${word}`,
          }],
          isError: true,
        };
      }
    }

    try {
      // Add LIMIT if not present
      let finalQuery = query;
      if (!normalized.includes('limit')) {
        finalQuery = `${query} LIMIT ${limit}`;
      }

      const rows = db.prepare(finalQuery).all();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            rowCount: rows.length,
            rows,
          }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Query failed: ${message}` }],
        isError: true,
      };
    } finally {
      db.close();
    }
  },
});

// Get table schema tool
registerTool({
  tool: {
    name: 'get_table_schema',
    description: 'Get detailed schema information for a specific table',
    inputSchema: {
      type: 'object',
      properties: {
        table: {
          type: 'string',
          description: 'Name of the table to inspect',
        },
      },
      required: ['table'],
    },
  },
  handler: async (args) => {
    const db = openDatabase();
    if (!db) {
      return {
        content: [{ type: 'text', text: 'Database not configured or not available' }],
        isError: true,
      };
    }

    const tableName = args.table as string;

    // Validate table name (prevent SQL injection)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      return {
        content: [{ type: 'text', text: 'Invalid table name' }],
        isError: true,
      };
    }

    try {
      // Get column info
      const columns = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }>;

      if (columns.length === 0) {
        return {
          content: [{ type: 'text', text: `Table not found: ${tableName}` }],
          isError: true,
        };
      }

      // Get index info
      const indexes = db.prepare(`PRAGMA index_list("${tableName}")`).all() as Array<{
        name: string;
        unique: number;
      }>;

      // Get foreign keys
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list("${tableName}")`).all() as Array<{
        table: string;
        from: string;
        to: string;
      }>;

      // Get row count
      const countResult = db.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`).get() as { count: number };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            table: tableName,
            rowCount: countResult.count,
            columns: columns.map(c => ({
              name: c.name,
              type: c.type,
              nullable: !c.notnull,
              defaultValue: c.dflt_value,
              primaryKey: !!c.pk,
            })),
            indexes: indexes.map(i => ({
              name: i.name,
              unique: !!i.unique,
            })),
            foreignKeys: foreignKeys.map(fk => ({
              column: fk.from,
              referencesTable: fk.table,
              referencesColumn: fk.to,
            })),
          }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get schema: ${message}` }],
        isError: true,
      };
    } finally {
      db.close();
    }
  },
});

console.log('[TOOLS] Database tools loaded');
