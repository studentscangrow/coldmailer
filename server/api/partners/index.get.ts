import { prisma } from '~/server/utils/prisma'
import { requireAuth } from '~/server/utils/requireAuth'
import { getActiveScope } from '~/server/utils/activeProject'
import { getInteractionAccess } from '~/server/utils/projectPermissions'
import { parseTodoLines, todoUrgency } from '~/utils/checklist'

export default defineEventHandler(async (event) => {
  const user = await requireAuth(event)
  const query = getQuery(event)
  const search = query.search as string | undefined
  const scope = await getActiveScope(event)
  const projectId = scope.project?.id

  const access = projectId ? await getInteractionAccess(user.id, projectId) : null
  const canManageAll = access ? access.isAdmin || access.canEditAll : false

  const negotiationWhere = projectId ? { projectId, removedAt: null } : { removedAt: null }

  const records = await prisma.globalRecord.findMany({
    where: {
      type: 'PARTNER',
      ...(search && { canonicalName: { contains: search, mode: 'insensitive' } }),
      negotiations: {
        some: {
          ...negotiationWhere,
          negotiationStatus: { notIn: ['PRED_OSLOVENIM'] },
        },
      },
    },
    include: {
      contacts: { orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] },
      negotiations: {
        where: negotiationWhere,
        select: {
          negotiationStatus: true,
          dealConfidence: true,
          todoList: true,
          emails: { select: { sentAt: true, isRead: true }, orderBy: { sentAt: 'desc' } },
          notes: { select: { updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
          _count: { select: { emails: true } },
        },
      },
      negotiationAssignees: {
        where: projectId ? { projectId } : undefined,
        select: { user: { select: { id: true, name: true, image: true } } },
      },
    },
    orderBy: { canonicalName: 'asc' },
  })

  const partners = records.map((r) => {
    const negotiation = r.negotiations[0] ?? null
    const lastEmailAt = negotiation?.emails[0]?.sentAt ?? null
    const lastNoteAt = negotiation?.notes[0]?.updatedAt ?? null
    const lastInteractionAt = lastEmailAt && lastNoteAt
      ? (lastEmailAt > lastNoteAt ? lastEmailAt : lastNoteAt)
      : (lastEmailAt ?? lastNoteAt ?? null)

    // To-Do agregace: nesplněné úkoly + nejnaléhavější (nejdřívější termín = nejvíc po termínu / nejbližší).
    const openTodos = negotiation?.todoList
      ? parseTodoLines(negotiation.todoList).filter(l => !l.checked)
      : []
    const datedOpen = openTodos
      .filter(l => l.dueDate)
      .sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime())
    const nearest = datedOpen[0] ?? null

    return {
      id: r.id,
      type: r.type,
      canonicalName: r.canonicalName,
      normalizedName: r.normalizedName,
      payload: r.payload,
      contacts: r.contacts,
      assignees: r.negotiationAssignees.map(a => a.user),
      lastInteractionAt,
      interactionCount: negotiation?._count.emails ?? 0,
      unreadEmailCount: negotiation?.emails.filter(e => !e.isRead).length ?? 0,
      openTasks: openTodos.length,
      nearestDueDate: nearest?.dueDate ?? null,
      nearestTaskText: nearest?.label ?? null,
      taskOverdue: nearest ? (todoUrgency(nearest.dueDate) === 'overdue' || todoUrgency(nearest.dueDate) === 'today') : false,
      negotiationStatus: negotiation?.negotiationStatus ?? null,
      dealConfidence: negotiation?.dealConfidence ?? null,
      inProject: !!negotiation,
    }
  })

  return { partners, canManageAll }
})
