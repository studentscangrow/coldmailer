import type { H3Event } from 'h3'
import { prisma } from '~/server/utils/prisma'
import { requireAuth } from '~/server/utils/requireAuth'

export const DEFAULT_PROJECT_ROLES = [
  {
    name: 'Vedení obchodu',
    permissions: ['project.pipeline.manage', 'project.interactions.view_all', 'project.interactions.edit_all'] as string[],
    isSystem: true,
  },
  {
    name: 'Obchodní tým',
    permissions: ['project.interactions.view_all'] as string[],
    isSystem: true,
  },
]

export async function ensureDefaultProjectRoles(projectId: string) {
  for (const role of DEFAULT_PROJECT_ROLES) {
    await prisma.projectRole.upsert({
      where: { projectId_name: { projectId, name: role.name } },
      create: { projectId, name: role.name, permissions: role.permissions, isSystem: role.isSystem },
      update: { permissions: role.permissions },
    })
  }
}

export async function getProjectPermissions(userId: string, projectId: string): Promise<string[]> {
  const assignments = await prisma.userProjectRole.findMany({
    where: { userId, projectRole: { projectId } },
    include: { projectRole: { select: { permissions: true } } },
  })
  return [...new Set(assignments.flatMap(a => a.projectRole.permissions))]
}

// True for admins and users with the "Vedení obchodu" role (project.pipeline.manage) in this
// project — gates the /overview (Přehled) page and its data endpoint.
export async function canManagePipeline(userId: string, projectId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } })
  if (user?.isAdmin) return true
  const perms = await getProjectPermissions(userId, projectId)
  return perms.includes('project.pipeline.manage')
}

export async function getInteractionAccess(userId: string, projectId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true },
  })

  if (user?.isAdmin) {
    return { canViewAll: true, canEditAll: true, isAdmin: true }
  }

  const perms = await getProjectPermissions(userId, projectId)
  return {
    canViewAll: perms.includes('project.interactions.view_all'),
    canEditAll: perms.includes('project.interactions.edit_all'),
    isAdmin: false,
  }
}

// Returns true if the user is personally the OutreachAssignment holder (oslovení), a
// NegotiationAssignee (jednání), or a FulfillmentAssignee (plnitel) for this partner —
// independent of admin/role-based permissions.
export async function isAssignedToNegotiation(userId: string, projectId: string, globalRecordId: string): Promise<boolean> {
  const [outreachAssignment, negotiationAssignee, fulfillmentAssignee] = await Promise.all([
    prisma.outreachAssignment.findFirst({
      where: { projectId, globalRecordId, assigneeId: userId },
      select: { id: true },
    }),
    prisma.negotiationAssignee.findFirst({
      where: { projectId, globalRecordId, userId },
      select: { id: true },
    }),
    // FulfillmentAssignee je klíčovaný negotiationId, takže join přes Negotiation (projectId + globalRecordId).
    prisma.fulfillmentAssignee.findFirst({
      where: { userId, negotiation: { projectId, globalRecordId } },
      select: { negotiationId: true },
    }),
  ])
  return !!outreachAssignment || !!negotiationAssignee || !!fulfillmentAssignee
}

// Returns true if user can create/edit interactions and update status for this partner.
// Allowed for: Admin, Vedení obchodu (canEditAll), the OutreachAssignment holder (oslovení),
// or a NegotiationAssignee (jednání) for this partner.
export async function canEditNegotiation(userId: string, projectId: string, globalRecordId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } })
  if (user?.isAdmin) return true
  const perms = await getProjectPermissions(userId, projectId)
  if (perms.includes('project.interactions.edit_all')) return true
  return isAssignedToNegotiation(userId, projectId, globalRecordId)
}

// userId-based equivalent of resolveInteractionAccess's 'edit' mode, for callers (MCP tools)
// that already have a userId and no H3Event to run requireAuth against. Mirrors it exactly:
// baseline canViewAll/isAdmin gate, then isAdmin/canEditAll/creator/assignee.
export async function canEditInteractionRecord(userId: string, projectId: string, globalRecordId: string, createdBy: string): Promise<boolean> {
  const access = await getInteractionAccess(userId, projectId)
  if (!access.isAdmin && !access.canViewAll) return false
  if (access.isAdmin || access.canEditAll || createdBy === userId) return true
  return isAssignedToNegotiation(userId, projectId, globalRecordId)
}

async function resolveInteractionAccess(
  event: H3Event,
  record: { projectId: string; globalRecordId: string; createdBy: string; assignees: { userId: string }[] } | null,
  notFoundMessage: string,
  mode: 'view' | 'edit',
) {
  const session = await requireAuth(event)

  if (!record) {
    throw createError({ statusCode: 404, message: notFoundMessage })
  }

  const access = await getInteractionAccess(session.id, record.projectId)

  if (!access.isAdmin && !access.canViewAll) {
    throw createError({ statusCode: 403, message: 'K tomuto projektu nemáte přístup.' })
  }

  const isCreator = record.createdBy === session.id

  if (mode === 'edit' && !access.isAdmin && !access.canEditAll && !isCreator) {
    const canEdit = await canEditNegotiation(session.id, record.projectId, record.globalRecordId)
    if (!canEdit) {
      throw createError({ statusCode: 403, message: 'Nemáte oprávnění editovat toto jednání. Nejste přiřazeni k tomuto partnerovi.' })
    }
  }

  const isAssignee = record.assignees.some(a => a.userId === session.id)

  return { session, access, isAssignee, isCreator }
}

export async function requireEmailAccess(
  event: H3Event,
  emailId: string,
  mode: 'view' | 'edit',
) {
  const email = await prisma.email.findUnique({
    where: { id: emailId },
    include: {
      assignees: { select: { userId: true } },
      negotiation: { select: { projectId: true, globalRecordId: true } },
    },
  })
  const flat = email ? { ...email, projectId: email.negotiation.projectId, globalRecordId: email.negotiation.globalRecordId } : null

  const result = await resolveInteractionAccess(event, flat, 'E-mail nebyl nalezen.', mode)
  return { ...result, email: flat! }
}

export async function requireNoteAccess(
  event: H3Event,
  noteId: string,
  mode: 'view' | 'edit',
) {
  const note = await prisma.note.findUnique({
    where: { id: noteId },
    include: {
      assignees: { select: { userId: true } },
      negotiation: { select: { projectId: true, globalRecordId: true } },
    },
  })
  const flat = note ? { ...note, projectId: note.negotiation.projectId, globalRecordId: note.negotiation.globalRecordId } : null

  const result = await resolveInteractionAccess(event, flat, 'Poznámka nebyla nalezena.', mode)
  return { ...result, note: flat! }
}

