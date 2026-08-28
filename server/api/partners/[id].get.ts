import { requireAuth } from '~/server/utils/requireAuth'
import { getActiveScope } from '~/server/utils/activeProject'
import { getPartnerHeader } from '~/server/utils/negotiation-detail'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  const scope = await getActiveScope(event)

  const header = await getPartnerHeader(id, scope.project?.id)
  if (!header) throw createError({ statusCode: 404, message: 'Not found' })

  return header
})
