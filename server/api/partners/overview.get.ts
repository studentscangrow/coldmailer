import { prisma } from '~/server/utils/prisma'
import { requireAuth } from '~/server/utils/requireAuth'
import { getActiveScope } from '~/server/utils/activeProject'
import { canManagePipeline } from '~/server/utils/projectPermissions'
import { parseTodoLines } from '~/utils/checklist'

// Data for /overview (Přehled): partners in the active project whose dealConfidence is
// DOMLUVENO (or DOMLUVENO+MOZNA when includeUncertain=true) — the "who do we actually have
// lined up" view for Vedení obchodu/admin, independent of the day-to-day negotiationStatus.
export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const scope = await getActiveScope(event)
  const projectId = scope.project?.id

  if (!projectId) return { partners: [] }

  const allowed = await canManagePipeline(session.id, projectId)
  if (!allowed) {
    throw createError({ statusCode: 403, message: 'Přehled je dostupný jen pro vedení obchodu a administrátory.' })
  }

  const includeUncertain = getQuery(event).includeUncertain === 'true'
  const confidenceFilter: 'DOMLUVENO' | { in: ('DOMLUVENO' | 'MOZNA')[] } =
    includeUncertain ? { in: ['DOMLUVENO', 'MOZNA'] } : 'DOMLUVENO'

  const negotiations = await prisma.negotiation.findMany({
    where: { projectId, removedAt: null, dealConfidence: confidenceFilter },
    select: {
      dealConfidence: true,
      negotiationStatus: true,
      discordThreadUrl: true,
      fulfillmentDocUrl: true,
      myToThem: true,
      themToUs: true,
      todoList: true,
      globalRecord: { select: { id: true, canonicalName: true } },
      notes: {
        select: { id: true, content: true, createdAt: true, creator: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      },
      emails: { select: { sentAt: true, createdAt: true }, orderBy: { sentAt: 'desc' }, take: 1 },
    },
  })

  // Assignees are per (projectId, globalRecordId), not per Negotiation row directly — fetch separately.
  const globalRecordIds = negotiations.map(n => n.globalRecord.id)
  const assigneeRows = await prisma.negotiationAssignee.findMany({
    where: { projectId, globalRecordId: { in: globalRecordIds } },
    select: { globalRecordId: true, user: { select: { id: true, name: true, image: true } } },
  })
  const assigneesByRecord = new Map<string, { id: string; name: string; image: string | null }[]>()
  for (const a of assigneeRows) {
    const list = assigneesByRecord.get(a.globalRecordId) ?? []
    list.push(a.user)
    assigneesByRecord.set(a.globalRecordId, list)
  }

  const partners = negotiations
    .map((n) => {
      const openTasks = n.todoList ? parseTodoLines(n.todoList).filter(l => !l.checked).length : 0
      const lastNoteAt = n.notes[0]?.createdAt ?? null
      const lastEmailAt = n.emails[0]?.sentAt ?? n.emails[0]?.createdAt ?? null
      const lastActivityAt = lastNoteAt && lastEmailAt
        ? (lastNoteAt > lastEmailAt ? lastNoteAt : lastEmailAt)
        : (lastNoteAt ?? lastEmailAt ?? null)

      return {
        id: n.globalRecord.id,
        canonicalName: n.globalRecord.canonicalName,
        dealConfidence: n.dealConfidence!,
        negotiationStatus: n.negotiationStatus,
        discordThreadUrl: n.discordThreadUrl,
        fulfillmentDocUrl: n.fulfillmentDocUrl,
        fulfillment: { myToThem: n.myToThem, themToUs: n.themToUs },
        todoList: n.todoList,
        openTasks,
        notes: n.notes.map(note => ({ id: note.id, content: note.content, createdAt: note.createdAt, creatorName: note.creator.name })),
        assignees: assigneesByRecord.get(n.globalRecord.id) ?? [],
        lastActivityAt,
      }
    })
    .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName, 'cs'))

  return { partners }
})
