import { prisma } from '~/server/utils/prisma'
import { getInteractionAccess, canEditNegotiation } from '~/server/utils/projectPermissions'

// Shared by the REST endpoints (which resolve projectId from the browser's active-project
// cookie via getActiveScope) and the MCP tools (which take projectId as an explicit tool
// argument, since a bearer-token request has no "active project" cookie).

const PERSON_SELECT = { id: true, name: true, image: true } as const

const EMAIL_SELECT = {
  id: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  creator: { select: PERSON_SELECT },
  assignees: { select: { userId: true, user: { select: PERSON_SELECT } } },
  direction: true,
  subject: true,
  sentAt: true,
  fromAddress: true,
  toAddress: true,
  ccAddress: true,
  bccAddress: true,
  gmailId: true,
  threadId: true,
  content: true,
  isUnknownContact: true,
  unknownContactAddress: true,
  isRead: true,
  isCalendarBooking: true,
} as const

const NOTE_SELECT = {
  id: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  creator: { select: PERSON_SELECT },
  assignees: { select: { userId: true, user: { select: PERSON_SELECT } } },
  content: true,
} as const

export async function getPartnerHeader(globalRecordId: string, projectId: string | undefined | null) {
  const record = await prisma.globalRecord.findUnique({
    where: { id: globalRecordId },
    include: {
      contacts: { orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] },
      negotiationAssignees: {
        where: projectId ? { projectId } : undefined,
        include: { user: { select: { id: true, name: true, image: true } } },
      },
      outreachAssignments: {
        where: projectId ? { projectId } : undefined,
        include: { assignee: { select: { id: true, name: true, image: true } } },
      },
      negotiations: {
        where: projectId ? { projectId } : undefined,
        select: { negotiationStatus: true, discordThreadUrl: true },
      },
    },
  })

  if (!record) return null

  const negotiation = record.negotiations[0] ?? null
  const assignees = record.negotiationAssignees.map(a => a.user)
  const outreachAssignment = record.outreachAssignments[0]?.assignee ?? null
  const { negotiations: _, negotiationAssignees: __, outreachAssignments: ___, ...rest } = record

  return {
    ...rest,
    negotiationStatus: negotiation?.negotiationStatus ?? null,
    discordThreadUrl: negotiation?.discordThreadUrl ?? null,
    assignees,
    outreachAssignment,
  }
}

export async function getNegotiationTimeline(globalRecordId: string, projectId: string | undefined | null, userId: string) {
  if (!projectId) {
    return {
      items: [] as any[],
      fulfillment: { myToThem: null, themToUs: null },
      fulfillmentDocUrl: null as string | null,
      todoList: null as string | null,
      crossProjectSummary: [] as any[],
      access: { canViewAll: false, canEditAll: false, canEdit: false, canManageAssignees: false },
    }
  }

  const access = await getInteractionAccess(userId, projectId)
  const effectiveCanEdit = access.canEditAll || access.isAdmin || await canEditNegotiation(userId, projectId, globalRecordId)
  const canViewFull = access.canViewAll || access.isAdmin || effectiveCanEdit

  const negotiation = await prisma.negotiation.findUnique({
    where: { projectId_globalRecordId: { projectId, globalRecordId } },
    select: {
      myToThem: true,
      themToUs: true,
      fulfillmentDocUrl: true,
      todoList: true,
      emails: { select: EMAIL_SELECT },
      notes: { select: NOTE_SELECT },
    },
  })

  const emailItems = (negotiation?.emails ?? []).map(e => ({
    ...e,
    type: 'EMAIL' as const,
    effectiveDate: e.sentAt ?? e.createdAt,
  }))
  const noteItems = (negotiation?.notes ?? []).map(n => ({
    ...n,
    type: 'NOTE' as const,
    effectiveDate: n.createdAt,
  }))

  let items: any[] = [...emailItems, ...noteItems].sort(
    (a, b) => b.effectiveDate.getTime() - a.effectiveDate.getTime(),
  )

  if (!canViewFull) {
    items = items.map((i) => {
      if (i.type === 'EMAIL') {
        return { ...i, content: null, fromAddress: null, toAddress: null, ccAddress: null, bccAddress: null, gmailId: null }
      }
      return { ...i, content: null }
    })
  }
  items = items.map(i => ({ ...i, canEdit: canViewFull ? effectiveCanEdit : false }))

  const fulfillment = canViewFull
    ? { myToThem: negotiation?.myToThem ?? null, themToUs: negotiation?.themToUs ?? null }
    : { myToThem: null, themToUs: null }
  const fulfillmentDocUrl = canViewFull ? (negotiation?.fulfillmentDocUrl ?? null) : null

  const todoList = canViewFull ? (negotiation?.todoList ?? null) : null

  // Cross-visibility: metadata from other projects where user is assignee on
  // at least one email/note/fulfillment for this same partner.
  const [otherEmails, otherNotes, otherFulfillments] = await Promise.all([
    prisma.email.findMany({
      where: { negotiation: { globalRecordId, projectId: { not: projectId } }, assignees: { some: {} } },
      select: {
        updatedAt: true,
        assignees: { select: { userId: true, user: { select: { name: true } } } },
        negotiation: { select: { projectId: true, project: { select: { id: true, name: true } } } },
      },
    }),
    prisma.note.findMany({
      where: { negotiation: { globalRecordId, projectId: { not: projectId } }, assignees: { some: {} } },
      select: {
        updatedAt: true,
        assignees: { select: { userId: true, user: { select: { name: true } } } },
        negotiation: { select: { projectId: true, project: { select: { id: true, name: true } } } },
      },
    }),
    prisma.negotiation.findMany({
      where: { globalRecordId, projectId: { not: projectId }, fulfillmentAssignees: { some: {} } },
      select: {
        projectId: true,
        project: { select: { id: true, name: true } },
        fulfillmentAssignees: { select: { userId: true, user: { select: { name: true } } } },
      },
    }),
  ])

  const userIsAssigneeAnywhere =
    (await prisma.emailAssignee.count({ where: { userId, email: { negotiation: { globalRecordId } } } })) +
    (await prisma.noteAssignee.count({ where: { userId, note: { negotiation: { globalRecordId } } } })) +
    (await prisma.fulfillmentAssignee.count({ where: { userId, negotiation: { globalRecordId } } }))

  let crossProjectSummary: any[] = []
  if (access.isAdmin || userIsAssigneeAnywhere > 0) {
    const byProject = new Map<string, {
      projectId: string
      projectName: string
      interactionCount: number
      lastActivityAt: Date | null
      assigneeNames: Set<string>
    }>()

    const touch = (
      pId: string,
      pName: string,
      updatedAt: Date | null,
      assignees: { user: { name: string } }[],
    ) => {
      let entry = byProject.get(pId)
      if (!entry) {
        entry = { projectId: pId, projectName: pName, interactionCount: 0, lastActivityAt: null, assigneeNames: new Set() }
        byProject.set(pId, entry)
      }
      entry.interactionCount++
      if (updatedAt && (!entry.lastActivityAt || updatedAt > entry.lastActivityAt)) entry.lastActivityAt = updatedAt
      for (const a of assignees) entry.assigneeNames.add(a.user.name)
    }

    for (const e of otherEmails) touch(e.negotiation.projectId, e.negotiation.project.name, e.updatedAt, e.assignees)
    for (const n of otherNotes) touch(n.negotiation.projectId, n.negotiation.project.name, n.updatedAt, n.assignees)
    for (const f of otherFulfillments) touch(f.projectId, f.project.name, null, f.fulfillmentAssignees)

    crossProjectSummary = [...byProject.values()].map(e => ({ ...e, assigneeNames: [...e.assigneeNames] }))
  }

  return {
    items,
    fulfillment,
    fulfillmentDocUrl,
    todoList,
    crossProjectSummary,
    access: {
      canViewAll: access.canViewAll || access.isAdmin,
      canEditAll: access.canEditAll || access.isAdmin,
      canEdit: effectiveCanEdit,
      canManageAssignees: effectiveCanEdit,
    },
  }
}
