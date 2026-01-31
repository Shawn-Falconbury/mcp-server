import { Agent } from 'undici';
import { registerTool } from './index.js';

// Jupyter/JupyterHub API configuration
interface JupyterConfig {
  baseUrl: string;
  token: string;
  username?: string; // For JupyterHub user-specific operations
}

function getJupyterConfig(): JupyterConfig | null {
  const baseUrl = process.env.JUPYTER_URL;
  const token = process.env.JUPYTER_TOKEN;
  const username = process.env.JUPYTER_USERNAME;

  if (!baseUrl || !token) {
    return null;
  }

  return { baseUrl: baseUrl.replace(/\/$/, ''), token, username };
}

// Custom undici agent for self-signed certificates (common in local setups)
const jupyterAgent = new Agent({
  connect: {
    rejectUnauthorized: process.env.JUPYTER_VERIFY_SSL !== 'false',
  },
});

// Jupyter API response types
interface JupyterContent {
  name: string;
  path: string;
  type: 'notebook' | 'file' | 'directory';
  writable: boolean;
  created: string;
  last_modified: string;
  mimetype?: string;
  content?: JupyterNotebook | JupyterContent[] | string;
  format?: 'json' | 'text' | 'base64';
}

interface JupyterNotebook {
  cells: JupyterCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

interface JupyterCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string | string[];
  metadata: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: JupyterOutput[];
}

interface JupyterOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
  text?: string | string[];
  data?: Record<string, unknown>;
  name?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface JupyterKernel {
  id: string;
  name: string;
  last_activity: string;
  execution_state: 'idle' | 'busy' | 'starting';
  connections: number;
}

interface JupyterKernelSpec {
  name: string;
  spec: {
    display_name: string;
    language: string;
  };
  resources: Record<string, string>;
}

// Generic Jupyter API request function
async function jupyterRequest<T>(
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
  body?: Record<string, unknown>
): Promise<T> {
  const config = getJupyterConfig();
  if (!config) {
    throw new Error('Jupyter not configured. Set JUPYTER_URL and JUPYTER_TOKEN environment variables.');
  }

  // Build URL - handle JupyterHub user routing if username is set
  let url = config.baseUrl;
  if (config.username) {
    url = `${url}/user/${config.username}`;
  }
  url = `${url}${endpoint}`;

  const options: RequestInit & { dispatcher?: Agent } = {
    method,
    headers: {
      'Authorization': `token ${config.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    dispatcher: jupyterAgent,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jupyter API error (${response.status}): ${text}`);
  }

  // Handle empty responses (e.g., DELETE)
  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

// ============================================================================
// NOTEBOOK TOOLS
// ============================================================================

// List notebooks in a directory
registerTool({
  tool: {
    name: 'jupyter_list_notebooks',
    description: 'List notebooks and files in a Jupyter directory',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path (default: root directory)',
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    try {
      const dirPath = (args.path as string) || '';
      const content = await jupyterRequest<JupyterContent>(`/api/contents/${dirPath}`);

      if (content.type !== 'directory') {
        return {
          content: [{ type: 'text', text: 'Path is not a directory' }],
          isError: true,
        };
      }

      const items = (content.content as JupyterContent[]) || [];
      const result = items.map(item => ({
        name: item.name,
        path: item.path,
        type: item.type,
        last_modified: item.last_modified,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to list notebooks: ${message}` }],
        isError: true,
      };
    }
  },
});

// Read notebook contents
registerTool({
  tool: {
    name: 'jupyter_read_notebook',
    description: 'Read the contents of a Jupyter notebook',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the notebook file (e.g., "folder/notebook.ipynb")',
        },
        include_outputs: {
          type: 'boolean',
          description: 'Include cell outputs in the response (default: true)',
        },
      },
      required: ['path'],
    },
  },
  handler: async (args) => {
    try {
      const notebookPath = args.path as string;
      const includeOutputs = args.include_outputs !== false;

      const content = await jupyterRequest<JupyterContent>(`/api/contents/${notebookPath}`);

      if (content.type !== 'notebook') {
        return {
          content: [{ type: 'text', text: 'Path is not a notebook' }],
          isError: true,
        };
      }

      const notebook = content.content as JupyterNotebook;
      const cells = notebook.cells.map((cell, index) => {
        const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
        const result: Record<string, unknown> = {
          index,
          cell_type: cell.cell_type,
          source,
        };

        if (cell.cell_type === 'code') {
          result.execution_count = cell.execution_count;
          if (includeOutputs && cell.outputs) {
            result.outputs = cell.outputs.map(output => {
              if (output.output_type === 'stream') {
                return {
                  type: output.name,
                  text: Array.isArray(output.text) ? output.text.join('') : output.text,
                };
              } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
                return {
                  type: output.output_type,
                  data: output.data,
                };
              } else if (output.output_type === 'error') {
                return {
                  type: 'error',
                  ename: output.ename,
                  evalue: output.evalue,
                };
              }
              return output;
            });
          }
        }

        return result;
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            path: content.path,
            name: content.name,
            last_modified: content.last_modified,
            metadata: notebook.metadata,
            cells,
          }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to read notebook: ${message}` }],
        isError: true,
      };
    }
  },
});

// Create a new notebook
registerTool({
  tool: {
    name: 'jupyter_create_notebook',
    description: 'Create a new Jupyter notebook',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path where to create the notebook (e.g., "folder/new_notebook.ipynb")',
        },
        kernel: {
          type: 'string',
          description: 'Kernel name to use (default: python3)',
        },
      },
      required: ['path'],
    },
  },
  handler: async (args) => {
    try {
      const notebookPath = args.path as string;
      const kernelName = (args.kernel as string) || 'python3';

      // Create empty notebook structure
      const notebook: JupyterNotebook = {
        cells: [],
        metadata: {
          kernelspec: {
            display_name: kernelName === 'python3' ? 'Python 3' : kernelName,
            language: 'python',
            name: kernelName,
          },
        },
        nbformat: 4,
        nbformat_minor: 5,
      };

      const result = await jupyterRequest<JupyterContent>(`/api/contents/${notebookPath}`, 'PUT', {
        type: 'notebook',
        content: notebook,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            created: true,
            path: result.path,
            name: result.name,
          }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to create notebook: ${message}` }],
        isError: true,
      };
    }
  },
});

// Add cell to notebook
registerTool({
  tool: {
    name: 'jupyter_add_cell',
    description: 'Add a new cell to a Jupyter notebook',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the notebook file',
        },
        cell_type: {
          type: 'string',
          enum: ['code', 'markdown'],
          description: 'Type of cell to add (default: code)',
        },
        source: {
          type: 'string',
          description: 'Cell content/source code',
        },
        position: {
          type: 'number',
          description: 'Position to insert cell (default: end of notebook)',
        },
      },
      required: ['path', 'source'],
    },
  },
  handler: async (args) => {
    try {
      const notebookPath = args.path as string;
      const cellType = (args.cell_type as 'code' | 'markdown') || 'code';
      const source = args.source as string;
      const position = args.position as number | undefined;

      // Fetch current notebook
      const content = await jupyterRequest<JupyterContent>(`/api/contents/${notebookPath}`);
      const notebook = content.content as JupyterNotebook;

      // Create new cell
      const newCell: JupyterCell = {
        cell_type: cellType,
        source: source,
        metadata: {},
      };

      if (cellType === 'code') {
        newCell.outputs = [];
        newCell.execution_count = null;
      }

      // Insert at position or append
      if (position !== undefined && position >= 0 && position < notebook.cells.length) {
        notebook.cells.splice(position, 0, newCell);
      } else {
        notebook.cells.push(newCell);
      }

      // Save updated notebook
      await jupyterRequest<JupyterContent>(`/api/contents/${notebookPath}`, 'PUT', {
        type: 'notebook',
        content: notebook,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            cell_index: position ?? notebook.cells.length - 1,
            total_cells: notebook.cells.length,
          }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to add cell: ${message}` }],
        isError: true,
      };
    }
  },
});

// Update cell in notebook
registerTool({
  tool: {
    name: 'jupyter_update_cell',
    description: 'Update an existing cell in a Jupyter notebook',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the notebook file',
        },
        cell_index: {
          type: 'number',
          description: 'Index of the cell to update (0-based)',
        },
        source: {
          type: 'string',
          description: 'New cell content/source code',
        },
        cell_type: {
          type: 'string',
          enum: ['code', 'markdown'],
          description: 'Change cell type (optional)',
        },
      },
      required: ['path', 'cell_index', 'source'],
    },
  },
  handler: async (args) => {
    try {
      const notebookPath = args.path as string;
      const cellIndex = args.cell_index as number;
      const source = args.source as string;
      const cellType = args.cell_type as 'code' | 'markdown' | undefined;

      // Fetch current notebook
      const content = await jupyterRequest<JupyterContent>(`/api/contents/${notebookPath}`);
      const notebook = content.content as JupyterNotebook;

      if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
        return {
          content: [{ type: 'text', text: `Cell index ${cellIndex} out of range (0-${notebook.cells.length - 1})` }],
          isError: true,
        };
      }

      // Update cell
      notebook.cells[cellIndex].source = source;
      if (cellType) {
        notebook.cells[cellIndex].cell_type = cellType;
        if (cellType === 'code') {
          notebook.cells[cellIndex].outputs = [];
          notebook.cells[cellIndex].execution_count = null;
        } else {
          delete notebook.cells[cellIndex].outputs;
          delete notebook.cells[cellIndex].execution_count;
        }
      }

      // Save updated notebook
      await jupyterRequest<JupyterContent>(`/api/contents/${notebookPath}`, 'PUT', {
        type: 'notebook',
        content: notebook,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            cell_index: cellIndex,
            cell_type: notebook.cells[cellIndex].cell_type,
          }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to update cell: ${message}` }],
        isError: true,
      };
    }
  },
});

// Delete notebook
registerTool({
  tool: {
    name: 'jupyter_delete_notebook',
    description: 'Delete a Jupyter notebook or file',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the notebook or file to delete',
        },
      },
      required: ['path'],
    },
  },
  handler: async (args) => {
    try {
      const filePath = args.path as string;

      await jupyterRequest<void>(`/api/contents/${filePath}`, 'DELETE');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ deleted: true, path: filePath }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to delete: ${message}` }],
        isError: true,
      };
    }
  },
});

// ============================================================================
// KERNEL TOOLS
// ============================================================================

// List available kernel specs
registerTool({
  tool: {
    name: 'jupyter_list_kernelspecs',
    description: 'List available Jupyter kernel specifications',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    try {
      const result = await jupyterRequest<{ kernelspecs: Record<string, JupyterKernelSpec> }>('/api/kernelspecs');

      const specs = Object.entries(result.kernelspecs).map(([name, spec]) => ({
        name,
        display_name: spec.spec.display_name,
        language: spec.spec.language,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify(specs, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to list kernelspecs: ${message}` }],
        isError: true,
      };
    }
  },
});

// List running kernels
registerTool({
  tool: {
    name: 'jupyter_list_kernels',
    description: 'List all running Jupyter kernels',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    try {
      const kernels = await jupyterRequest<JupyterKernel[]>('/api/kernels');

      const result = kernels.map(k => ({
        id: k.id,
        name: k.name,
        state: k.execution_state,
        last_activity: k.last_activity,
        connections: k.connections,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to list kernels: ${message}` }],
        isError: true,
      };
    }
  },
});

// Start a new kernel
registerTool({
  tool: {
    name: 'jupyter_start_kernel',
    description: 'Start a new Jupyter kernel',
    inputSchema: {
      type: 'object',
      properties: {
        kernel_name: {
          type: 'string',
          description: 'Name of the kernel to start (e.g., "python3")',
        },
      },
      required: ['kernel_name'],
    },
  },
  handler: async (args) => {
    try {
      const kernelName = args.kernel_name as string;

      const kernel = await jupyterRequest<JupyterKernel>('/api/kernels', 'POST', {
        name: kernelName,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            started: true,
            id: kernel.id,
            name: kernel.name,
            state: kernel.execution_state,
          }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to start kernel: ${message}` }],
        isError: true,
      };
    }
  },
});

// Stop/shutdown a kernel
registerTool({
  tool: {
    name: 'jupyter_stop_kernel',
    description: 'Stop/shutdown a running Jupyter kernel',
    inputSchema: {
      type: 'object',
      properties: {
        kernel_id: {
          type: 'string',
          description: 'ID of the kernel to stop',
        },
      },
      required: ['kernel_id'],
    },
  },
  handler: async (args) => {
    try {
      const kernelId = args.kernel_id as string;

      await jupyterRequest<void>(`/api/kernels/${kernelId}`, 'DELETE');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ stopped: true, kernel_id: kernelId }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to stop kernel: ${message}` }],
        isError: true,
      };
    }
  },
});

// Restart a kernel
registerTool({
  tool: {
    name: 'jupyter_restart_kernel',
    description: 'Restart a running Jupyter kernel',
    inputSchema: {
      type: 'object',
      properties: {
        kernel_id: {
          type: 'string',
          description: 'ID of the kernel to restart',
        },
      },
      required: ['kernel_id'],
    },
  },
  handler: async (args) => {
    try {
      const kernelId = args.kernel_id as string;

      await jupyterRequest<void>(`/api/kernels/${kernelId}/restart`, 'POST');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ restarted: true, kernel_id: kernelId }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to restart kernel: ${message}` }],
        isError: true,
      };
    }
  },
});

// Interrupt a kernel
registerTool({
  tool: {
    name: 'jupyter_interrupt_kernel',
    description: 'Interrupt a running Jupyter kernel (stop current execution)',
    inputSchema: {
      type: 'object',
      properties: {
        kernel_id: {
          type: 'string',
          description: 'ID of the kernel to interrupt',
        },
      },
      required: ['kernel_id'],
    },
  },
  handler: async (args) => {
    try {
      const kernelId = args.kernel_id as string;

      await jupyterRequest<void>(`/api/kernels/${kernelId}/interrupt`, 'POST');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ interrupted: true, kernel_id: kernelId }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to interrupt kernel: ${message}` }],
        isError: true,
      };
    }
  },
});

// ============================================================================
// CODE EXECUTION TOOLS
// ============================================================================

// Execute code via sessions API (notebook-based execution)
registerTool({
  tool: {
    name: 'jupyter_execute_cell',
    description: 'Execute a specific cell in a notebook and return the output. This runs the cell through the Jupyter session.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the notebook file',
        },
        cell_index: {
          type: 'number',
          description: 'Index of the cell to execute (0-based)',
        },
      },
      required: ['path', 'cell_index'],
    },
  },
  handler: async (args) => {
    try {
      const notebookPath = args.path as string;
      const cellIndex = args.cell_index as number;

      // Get or create a session for this notebook
      const sessions = await jupyterRequest<Array<{ id: string; path: string; kernel: JupyterKernel }>>('/api/sessions');
      let session = sessions.find(s => s.path === notebookPath);

      if (!session) {
        // Create a new session for the notebook
        session = await jupyterRequest<{ id: string; path: string; kernel: JupyterKernel }>('/api/sessions', 'POST', {
          path: notebookPath,
          type: 'notebook',
          kernel: { name: 'python3' },
        });
      }

      // Read the notebook to get the cell content
      const content = await jupyterRequest<JupyterContent>(`/api/contents/${notebookPath}`);
      const notebook = content.content as JupyterNotebook;

      if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
        return {
          content: [{ type: 'text', text: `Cell index ${cellIndex} out of range` }],
          isError: true,
        };
      }

      const cell = notebook.cells[cellIndex];
      if (cell.cell_type !== 'code') {
        return {
          content: [{ type: 'text', text: 'Cell is not a code cell' }],
          isError: true,
        };
      }

      const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;

      // Note: True code execution requires WebSocket connection to the kernel
      // For now, we return info about the cell that would be executed
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            note: 'Cell execution requires WebSocket connection. Use jupyter_run_code for HTTP-based execution if available.',
            session_id: session.id,
            kernel_id: session.kernel.id,
            kernel_state: session.kernel.execution_state,
            cell_index: cellIndex,
            code: source,
          }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to execute cell: ${message}` }],
        isError: true,
      };
    }
  },
});

// ============================================================================
// SESSION TOOLS
// ============================================================================

// List active sessions
registerTool({
  tool: {
    name: 'jupyter_list_sessions',
    description: 'List all active Jupyter notebook sessions',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    try {
      const sessions = await jupyterRequest<Array<{
        id: string;
        path: string;
        name: string;
        type: string;
        kernel: JupyterKernel;
      }>>('/api/sessions');

      const result = sessions.map(s => ({
        id: s.id,
        path: s.path,
        name: s.name,
        type: s.type,
        kernel: {
          id: s.kernel.id,
          name: s.kernel.name,
          state: s.kernel.execution_state,
        },
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to list sessions: ${message}` }],
        isError: true,
      };
    }
  },
});

// Create session for a notebook
registerTool({
  tool: {
    name: 'jupyter_create_session',
    description: 'Create a new session for a notebook (starts a kernel attached to the notebook)',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the notebook file',
        },
        kernel_name: {
          type: 'string',
          description: 'Kernel name (default: python3)',
        },
      },
      required: ['path'],
    },
  },
  handler: async (args) => {
    try {
      const notebookPath = args.path as string;
      const kernelName = (args.kernel_name as string) || 'python3';

      const session = await jupyterRequest<{
        id: string;
        path: string;
        kernel: JupyterKernel;
      }>('/api/sessions', 'POST', {
        path: notebookPath,
        type: 'notebook',
        kernel: { name: kernelName },
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            created: true,
            session_id: session.id,
            path: session.path,
            kernel_id: session.kernel.id,
            kernel_name: session.kernel.name,
          }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to create session: ${message}` }],
        isError: true,
      };
    }
  },
});

// Delete session
registerTool({
  tool: {
    name: 'jupyter_delete_session',
    description: 'Delete a notebook session (stops the associated kernel)',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'ID of the session to delete',
        },
      },
      required: ['session_id'],
    },
  },
  handler: async (args) => {
    try {
      const sessionId = args.session_id as string;

      await jupyterRequest<void>(`/api/sessions/${sessionId}`, 'DELETE');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ deleted: true, session_id: sessionId }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to delete session: ${message}` }],
        isError: true,
      };
    }
  },
});

console.log('[TOOLS] Jupyter tools loaded');
