import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolve } from 'node:path'

// No private key is passed, so only discovery tools are registered.
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp-server/dist/index.js')], env: {} })
const client = new Client({ name: 'actually-audit', version: '1.0' })
try {
  await client.connect(transport)
  console.log(JSON.stringify({ server: client.getServerVersion(), tools: (await client.listTools()).tools.map(t => t.name) }, null, 2))
} finally { await client.close() }
