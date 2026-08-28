import type { H3Event } from 'h3'
import { prisma } from '~/server/utils/prisma'
import { hashApiToken } from '~/server/utils/apiToken'
import { checkMcpRateLimit } from '~/server/utils/mcpRateLimit'

// Throttle window for "last used" updates so every MCP call doesn't hit the DB.
const LAST_USED_THROTTLE_MS = 5 * 60_000

// Split from requireMcpAuth so the token-checking logic (hash lookup, revocation, rate limit)
// is testable without constructing a real H3Event — requireMcpAuth is just the thin header
// extraction on top of this.
export async function resolveMcpAuthToken(token: string) {
  const tokenHash = hashApiToken(token)
  const apiToken = await prisma.apiToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, email: true, name: true, image: true, isAdmin: true } } },
  })

  if (!apiToken || apiToken.revokedAt) {
    throw createError({ statusCode: 401, message: 'Invalid or revoked token' })
  }

  if (!checkMcpRateLimit(apiToken.id)) {
    throw createError({ statusCode: 429, message: 'Too many requests — zpomalte.' })
  }

  if (!apiToken.lastUsedAt || Date.now() - apiToken.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    prisma.apiToken.update({ where: { id: apiToken.id }, data: { lastUsedAt: new Date() } }).catch(() => {})
  }

  return apiToken.user
}

// Authenticates an MCP request via "Authorization: Bearer <token>" and returns the
// owning user in the same shape requireAuth() returns, so existing permission
// helpers (canEditNegotiation, getProjectPermissions, ...) work unchanged.
export async function requireMcpAuth(event: H3Event) {
  const header = getHeader(event, 'authorization')
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) {
    throw createError({ statusCode: 401, message: 'Missing bearer token' })
  }
  return resolveMcpAuthToken(token)
}
