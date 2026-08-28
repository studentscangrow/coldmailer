import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { requireMcpAuth } from '~/server/utils/requireMcpAuth'
import { registerReadTools, registerWriteTools } from '~/server/utils/mcp-tools'

// Requests are authenticated via the personal API token (Fáze 1) before any tool runs.
// Stateless (sessionIdGenerator: undefined): a fresh McpServer/transport is built per request,
// with the authenticated user baked into its tool closures via registerReadTools(server, ctx) —
// tool behavior depends on who's calling (permission checks), so a server instance shared
// across users would risk leaking one caller's access into another's request. Registration
// itself does no I/O, so the per-request cost is negligible.
export default defineEventHandler(async (event) => {
  const user = await requireMcpAuth(event)

  const server = new McpServer({ name: 'coldmailer', version: '0.1.0' })
  registerReadTools(server, { userId: user.id, isAdmin: user.isAdmin })
  registerWriteTools(server, { userId: user.id, isAdmin: user.isAdmin })

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)

  event._handled = true
  await transport.handleRequest(event.node.req, event.node.res)
})
