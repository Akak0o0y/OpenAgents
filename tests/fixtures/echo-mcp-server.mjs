/**
 * A real MCP server over stdio, used by the MCP tests.
 *
 * Deliberately a genuine server rather than a mock: the point of these tests is
 * that the client speaks the actual protocol, including handshake and tool
 * discovery. A hand-rolled stub would pass while the real wire format failed.
 *
 * It also reports whether it inherited a provider credential, which is how the
 * "servers do not see your API keys" claim is proven rather than asserted.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '0.0.1' });

server.registerTool(
  'reverse',
  {
    description: 'Reverse a string.',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: [...text].reverse().join('') }],
  })
);

server.registerTool(
  'leak_check',
  {
    description: 'Report which provider credentials this server process can see.',
    inputSchema: {},
  },
  async () => {
    const leaked = ['OPENROUTER_API_KEY', 'OPENCODE_API_KEY', 'ANTHROPIC_API_KEY'].filter(
      (k) => typeof process.env[k] === 'string' && process.env[k].length > 0
    );
    return { content: [{ type: 'text', text: leaked.length ? `LEAKED:${leaked.join(',')}` : 'NO_CREDENTIALS' }] };
  }
);

server.registerTool(
  'boom',
  { description: 'Always fails, to exercise the error path.', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'deliberate failure' }], isError: true })
);

await server.connect(new StdioServerTransport());
