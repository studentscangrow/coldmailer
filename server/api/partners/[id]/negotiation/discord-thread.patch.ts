import { prisma } from '~/server/utils/prisma'
import { requireAuth } from '~/server/utils/requireAuth'
import { getActiveScope } from '~/server/utils/activeProject'
import { canEditNegotiation } from '~/server/utils/projectPermissions'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const globalRecordId = getRouterParam(event, 'id')!
  const scope = await getActiveScope(event)
  const projectId = scope.project?.id

  if (!projectId) {
    throw createError({ statusCode: 400, message: 'Není vybrán žádný projekt.' })
  }

  const canEdit = await canEditNegotiation(session.id, projectId, globalRecordId)
  if (!canEdit) {
    throw createError({ statusCode: 403, message: 'Nemáte oprávnění editovat toto jednání. Nejste přiřazeni k tomuto partnerovi.' })
  }

  const body = await readBody<{ discordThreadUrl?: string | null }>(event)
  const discordThreadUrl = body.discordThreadUrl?.trim() || null

  const negotiation = await prisma.negotiation.upsert({
    where: { projectId_globalRecordId: { projectId, globalRecordId } },
    create: { projectId, globalRecordId, discordThreadUrl },
    update: { discordThreadUrl },
  })

  return { id: negotiation.id, discordThreadUrl: negotiation.discordThreadUrl }
})
