import { prisma } from '~/server/utils/prisma'
import { requireAuth } from '~/server/utils/requireAuth'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const id = getRouterParam(event, 'id')!

  const token = await prisma.apiToken.findUnique({ where: { id }, select: { userId: true } })
  if (!token || token.userId !== session.id) {
    throw createError({ statusCode: 404, message: 'Token nenalezen.' })
  }

  await prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } })
  return { success: true }
})
