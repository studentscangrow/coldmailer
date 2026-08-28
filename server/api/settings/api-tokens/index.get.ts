import { prisma } from '~/server/utils/prisma'
import { requireAuth } from '~/server/utils/requireAuth'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)

  return prisma.apiToken.findMany({
    where: { userId: session.id },
    select: { id: true, name: true, createdAt: true, lastUsedAt: true, revokedAt: true },
    orderBy: { createdAt: 'desc' },
  })
})
