import { prisma } from '~/server/utils/prisma'
import { requireAuth } from '~/server/utils/requireAuth'
import { getActiveScope } from '~/server/utils/activeProject'
import { canEditNegotiation } from '~/server/utils/projectPermissions'
import { upsertNegotiationAssignees } from '~/server/utils/negotiation-assignment'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const globalRecordId = getRouterParam(event, 'id')!
  const scope = await getActiveScope(event)
  const projectId = scope.project?.id

  if (!projectId) {
    throw createError({ statusCode: 400, message: 'No active project context' })
  }

  const body = await readBody(event)
  const { negotiationStatus, dealConfidence, addAssigneeId, removeAssigneeId } = body
  const CLOSED_STATUSES = ['NOT_INTERESTED', 'NOT_THIS_TIME']

  if (negotiationStatus !== undefined) {
    if (negotiationStatus === 'PRED_OSLOVENIM') {
      throw createError({ statusCode: 400, message: 'Stav "Před oslovením" nelze nastavit ručně.' })
    }
    const canEdit = await canEditNegotiation(session.id, projectId, globalRecordId)
    if (!canEdit) {
      throw createError({ statusCode: 403, message: 'Nemáte oprávnění editovat stav tohoto partnera. Nejste přiřazeni k tomuto partnerovi.' })
    }
    // Nezájem / Tentokrát nezájem vždy vynuluje dealConfidence — nedává smysl mít "Domluveno"/"Možná" u uzavřeného jednání.
    const closesDeal = CLOSED_STATUSES.includes(negotiationStatus)
    await prisma.negotiation.upsert({
      where: { projectId_globalRecordId: { projectId, globalRecordId } },
      create: { projectId, globalRecordId, negotiationStatus, ...(closesDeal && { dealConfidence: null }) },
      update: { negotiationStatus, ...(closesDeal && { dealConfidence: null }) },
    })
  }

  if (dealConfidence !== undefined) {
    if (dealConfidence !== null && dealConfidence !== 'MOZNA' && dealConfidence !== 'DOMLUVENO') {
      throw createError({ statusCode: 400, message: 'Neplatná hodnota jistoty domluvy.' })
    }
    const canEdit = await canEditNegotiation(session.id, projectId, globalRecordId)
    if (!canEdit) {
      throw createError({ statusCode: 403, message: 'Nemáte oprávnění editovat toto jednání. Nejste přiřazeni k tomuto partnerovi.' })
    }
    // Server-side pojistka nad rámec disabled selectu v UI: nedovolit nastavit dealConfidence,
    // pokud je (nebo právě bude) stav Nezájem / Tentokrát nezájem.
    const current = await prisma.negotiation.findUnique({
      where: { projectId_globalRecordId: { projectId, globalRecordId } },
      select: { negotiationStatus: true },
    })
    const effectiveStatus = negotiationStatus !== undefined ? negotiationStatus : current?.negotiationStatus
    if (dealConfidence !== null && effectiveStatus && CLOSED_STATUSES.includes(effectiveStatus)) {
      throw createError({ statusCode: 400, message: 'U stavu Nezájem / Tentokrát nezájem nelze nastavit jistotu domluvy.' })
    }
    await prisma.negotiation.upsert({
      where: { projectId_globalRecordId: { projectId, globalRecordId } },
      create: { projectId, globalRecordId, dealConfidence },
      update: { dealConfidence },
    })
  }

  if (addAssigneeId !== undefined || (removeAssigneeId !== undefined && removeAssigneeId !== session.id)) {
    const canEdit = await canEditNegotiation(session.id, projectId, globalRecordId)
    if (!canEdit) {
      throw createError({ statusCode: 403, message: 'Přiřazovat lidi k jednání může kdokoli k němu přiřazený nebo vedení obchodu.' })
    }
  }

  if (addAssigneeId) {
    const assigneeExists = await prisma.user.findUnique({ where: { id: addAssigneeId }, select: { id: true } })
    if (!assigneeExists) throw createError({ statusCode: 400, message: 'Uživatel nenalezen.' })

    await upsertNegotiationAssignees(projectId, globalRecordId, [addAssigneeId], session.id)
  }

  if (removeAssigneeId) {
    await prisma.negotiationAssignee.deleteMany({
      where: { projectId, globalRecordId, userId: removeAssigneeId },
    })
  }

  return { success: true }
})
