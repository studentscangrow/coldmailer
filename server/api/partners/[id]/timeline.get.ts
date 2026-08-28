import { requireAuth } from '~/server/utils/requireAuth'
import { getActiveScope } from '~/server/utils/activeProject'
import { getNegotiationTimeline } from '~/server/utils/negotiation-detail'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const globalRecordId = getRouterParam(event, 'id')!
  const scope = await getActiveScope(event)

  return getNegotiationTimeline(globalRecordId, scope.project?.id, session.id)
})
