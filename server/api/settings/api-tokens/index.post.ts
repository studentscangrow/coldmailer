import { prisma } from '~/server/utils/prisma'
import { requireAuth } from '~/server/utils/requireAuth'
import { generateApiToken } from '~/server/utils/apiToken'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const body = await readBody<{ name?: string }>(event)
  const name = body.name?.trim()
  if (!name) throw createError({ statusCode: 400, message: 'Název tokenu je povinný.' })

  const { token, tokenHash } = generateApiToken()

  const created = await prisma.apiToken.create({
    data: { userId: session.id, name, tokenHash },
    select: { id: true, name: true, createdAt: true },
  })

  // Plaintext token is only ever returned here, right after creation — the DB stores just its hash.
  return { ...created, token }
})
