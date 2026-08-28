import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '~/server/utils/prisma'
import { generateApiToken } from '~/server/utils/apiToken'
import { resolveMcpAuthToken } from '~/server/utils/requireMcpAuth'

// Integration test against the local dev DB (DATABASE_URL from .env) — this project has no
// Prisma mocking setup, so these tests use throwaway rows cleaned up in afterAll, same
// approach used for manual verification during development.
describe('resolveMcpAuthToken', () => {
  const testEmail = 'vitest-requireMcpAuth@scg.cz'
  let userId: string
  let validToken: string
  let revokedToken: string

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: testEmail, googleId: 'vitest-requireMcpAuth', name: 'Vitest requireMcpAuth' },
    })
    userId = user.id

    const valid = generateApiToken()
    validToken = valid.token
    await prisma.apiToken.create({ data: { userId, name: 'valid', tokenHash: valid.tokenHash } })

    const revoked = generateApiToken()
    revokedToken = revoked.token
    await prisma.apiToken.create({ data: { userId, name: 'revoked', tokenHash: revoked.tokenHash, revokedAt: new Date() } })
  })

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } }) // cascades to its ApiToken rows
  })

  it('resolves the owning user for a valid token', async () => {
    const user = await resolveMcpAuthToken(validToken)
    expect(user.id).toBe(userId)
    expect(user.email).toBe(testEmail)
  })

  it('rejects an unknown token', async () => {
    await expect(resolveMcpAuthToken('cml_this-token-does-not-exist')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects a revoked token', async () => {
    await expect(resolveMcpAuthToken(revokedToken)).rejects.toMatchObject({ statusCode: 401 })
  })
})
