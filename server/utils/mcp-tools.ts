import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '~/server/utils/prisma'
import { getUserScopeAccess } from '~/server/utils/permissions'
import { getPartnerHeader, getNegotiationTimeline } from '~/server/utils/negotiation-detail'
import { canEditNegotiation, canEditInteractionRecord } from '~/server/utils/projectPermissions'
import { logEvent } from '~/server/utils/record-events'
import { normalizeChecklist, normalizeTodo } from '~/utils/checklist'
import { EDITABLE_NEGOTIATION_STATUSES } from '~/utils/negotiationStatus'

// Deliberately NOT exposed to MCP agents, even though the user holds edit rights: sending
// email (Gmail send is a real, hard-to-undo external action), deleting anything, blacklist
// management, and GlobalRecord merge/duplicate resolution. Keep those as human-only actions
// in the app UI — don't add tools for them without revisiting that decision explicitly.

export interface McpToolContext {
  userId: string
  isAdmin: boolean
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

// Every tool that takes a projectId argument must check the caller actually has access to
// that project — an MCP token has no "active project" cookie to lean on, and unlike the
// browser session it can be pointed at an arbitrary projectId by whoever holds the token.
async function assertProjectAccess(ctx: McpToolContext, projectId: string) {
  if (ctx.isAdmin) return
  const access = await getUserScopeAccess(ctx.userId)
  if (!access.projectIds.includes(projectId)) {
    throw new Error('K tomuto projektu nemáte přístup.')
  }
}

export function registerReadTools(server: McpServer, ctx: McpToolContext) {
  server.registerTool(
    'list_projects',
    {
      title: 'Seznam projektů',
      description: 'Vrátí skupiny a projekty, ke kterým má přihlášený uživatel přístup.',
      inputSchema: {},
    },
    async () => {
      const access = await getUserScopeAccess(ctx.userId)
      const groups = await prisma.group.findMany({
        where: access.isAdmin ? undefined : { id: { in: access.groupIds } },
        include: {
          projects: {
            where: access.isAdmin ? undefined : { id: { in: access.projectIds } },
            orderBy: { name: 'asc' },
            select: { id: true, name: true, slug: true },
          },
        },
        orderBy: { name: 'asc' },
      })
      return textResult(groups.map(g => ({ id: g.id, name: g.name, projects: g.projects })))
    },
  )

  server.registerTool(
    'search_partners',
    {
      title: 'Vyhledat partnery',
      description: 'Vyhledá partnery (GlobalRecord typu PARTNER) podle jména/obsahu. Volitelně omezí na jeden projekt a přidá stav jednání a jistotu domluvy (dealConfidence) v něm.',
      inputSchema: {
        query: z.string().optional().describe('Hledaný text (jméno nebo obsah profilu). Prázdné = prvních `limit` partnerů abecedně.'),
        projectId: z.string().optional().describe('Pokud je zadán, u výsledků se přidá negotiationStatus a hasNegotiation v tomto projektu.'),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    async ({ query, projectId, limit }) => {
      if (projectId) await assertProjectAccess(ctx, projectId)

      let ids: string[] | undefined
      if (query?.trim()) {
        const rawIds = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "GlobalRecord"
          WHERE type = 'PARTNER'
          AND ("canonicalName" ILIKE ${'%' + query.trim() + '%'} OR payload::text ILIKE ${'%' + query.trim() + '%'})
          ORDER BY "canonicalName" ASC
          LIMIT ${limit}
        `
        ids = rawIds.map(r => r.id)
      }

      const records = await prisma.globalRecord.findMany({
        where: { type: 'PARTNER', ...(ids && { id: { in: ids } }) },
        select: {
          id: true,
          canonicalName: true,
          payload: true,
          negotiations: projectId ? { where: { projectId }, select: { negotiationStatus: true, dealConfidence: true } } : false,
        },
        orderBy: { canonicalName: 'asc' },
        take: limit,
      })

      return textResult(records.map((r) => {
        const payload = r.payload as Record<string, unknown> | null
        const negotiation = (r as any).negotiations?.[0] ?? null
        return {
          id: r.id,
          canonicalName: r.canonicalName,
          website: payload?.website ?? payload?.url ?? null,
          ...(projectId && {
            hasNegotiation: !!negotiation,
            negotiationStatus: negotiation?.negotiationStatus ?? null,
            dealConfidence: negotiation?.dealConfidence ?? null,
          }),
        }
      }))
    },
  )

  server.registerTool(
    'get_negotiation',
    {
      title: 'Detail jednání',
      description: 'Kompletní detail jednoho partnera v rámci projektu: kontakty, stav, jistota domluvy (dealConfidence), odkazy na Discord vlákno a Google Doc s návrhem plnění, obsah plnění, to-do, celá časová osa e-mailů a poznámek, a role uživatelů (oslovovatel, vyjednavači, plnitelé).',
      inputSchema: {
        globalRecordId: z.string(),
        projectId: z.string(),
      },
    },
    async ({ globalRecordId, projectId }) => {
      await assertProjectAccess(ctx, projectId)

      const header = await getPartnerHeader(globalRecordId, projectId)
      if (!header) return errorResult('Partner nenalezen.')

      const timeline = await getNegotiationTimeline(globalRecordId, projectId, ctx.userId)

      const fulfillmentAssignees = await prisma.fulfillmentAssignee.findMany({
        where: { negotiation: { projectId, globalRecordId } },
        select: { user: { select: { id: true, name: true } } },
      })

      const lastActivityAt = timeline.items.reduce<string | null>((latest, item) => {
        const d = item.type === 'EMAIL' ? (item.sentAt ?? item.createdAt) : item.updatedAt
        const iso = new Date(d).toISOString()
        return !latest || iso > latest ? iso : latest
      }, null)

      return textResult({
        id: header.id,
        canonicalName: header.canonicalName,
        payload: header.payload,
        contacts: header.contacts,
        negotiationStatus: header.negotiationStatus,
        dealConfidence: header.dealConfidence,
        discordThreadUrl: header.discordThreadUrl,
        fulfillment: timeline.fulfillment,
        fulfillmentDocUrl: timeline.fulfillmentDocUrl,
        todoList: timeline.todoList,
        lastActivityAt,
        roles: {
          outreachAssignee: header.outreachAssignment,
          negotiationAssignees: header.assignees,
          fulfillmentAssignees: fulfillmentAssignees.map(f => f.user),
        },
        timeline: timeline.items,
        crossProjectSummary: timeline.crossProjectSummary,
        access: timeline.access,
      })
    },
  )

  server.registerTool(
    'get_pipeline_overview',
    {
      title: 'Přehled pipeline',
      description: 'Souhrnná čísla za projekt: počet partnerů/jednání, rozpad podle stavu jednání (syrový, bez interpretace "nadějnosti"), rozpad podle jistoty domluvy (dealConfidence — Domluveno/Možná/bez hodnoty), počet odeslaných e-mailů a nových poznámek od zadaného data.',
      inputSchema: {
        projectId: z.string(),
        since: z.string().datetime().optional().describe('ISO datum — pokud zadáno, počty e-mailů/poznámek se počítají jen od tohoto data.'),
      },
    },
    async ({ projectId, since }) => {
      await assertProjectAccess(ctx, projectId)
      const sinceDate = since ? new Date(since) : undefined

      const [totalNegotiations, statusBreakdown, dealConfidenceBreakdown, emailsSent, newNotes] = await Promise.all([
        prisma.negotiation.count({ where: { projectId, removedAt: null } }),
        prisma.negotiation.groupBy({
          by: ['negotiationStatus'],
          where: { projectId, removedAt: null },
          _count: true,
        }),
        prisma.negotiation.groupBy({
          by: ['dealConfidence'],
          where: { projectId, removedAt: null },
          _count: true,
        }),
        prisma.email.count({
          where: { negotiation: { projectId }, direction: 'SENT', ...(sinceDate && { sentAt: { gte: sinceDate } }) },
        }),
        prisma.note.count({
          where: { negotiation: { projectId }, ...(sinceDate && { createdAt: { gte: sinceDate } }) },
        }),
      ])

      return textResult({
        totalPartnersInProject: totalNegotiations,
        statusBreakdown: statusBreakdown.map(s => ({ status: s.negotiationStatus, count: s._count })),
        dealConfidenceBreakdown: dealConfidenceBreakdown.map(d => ({ dealConfidence: d.dealConfidence, count: d._count })),
        emailsSent,
        newNotes,
        since: since ?? null,
      })
    },
  )

  server.registerTool(
    'get_activity_feed',
    {
      title: 'Aktivita v projektu',
      description: 'Chronologický přehled e-mailů a poznámek napříč VŠEMI partnery v projektu od zadaného data — pro detail jednoho konkrétního partnera použij get_negotiation, ten už vrací celou jeho historii.',
      inputSchema: {
        projectId: z.string(),
        since: z.string().datetime(),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ projectId, since, limit }) => {
      await assertProjectAccess(ctx, projectId)
      const sinceDate = new Date(since)

      const [emails, notes] = await Promise.all([
        prisma.email.findMany({
          where: { negotiation: { projectId }, OR: [{ sentAt: { gte: sinceDate } }, { sentAt: null, createdAt: { gte: sinceDate } }] },
          select: {
            id: true, direction: true, subject: true, sentAt: true, createdAt: true,
            negotiation: { select: { globalRecordId: true, globalRecord: { select: { canonicalName: true } } } },
          },
        }),
        prisma.note.findMany({
          where: { negotiation: { projectId }, createdAt: { gte: sinceDate } },
          select: {
            id: true, content: true, createdAt: true, creator: { select: { name: true } },
            negotiation: { select: { globalRecordId: true, globalRecord: { select: { canonicalName: true } } } },
          },
        }),
      ])

      const items = [
        ...emails.map(e => ({
          type: 'EMAIL' as const,
          date: (e.sentAt ?? e.createdAt).toISOString(),
          globalRecordId: e.negotiation.globalRecordId,
          partnerName: e.negotiation.globalRecord.canonicalName,
          direction: e.direction,
          subject: e.subject,
        })),
        ...notes.map(n => ({
          type: 'NOTE' as const,
          date: n.createdAt.toISOString(),
          globalRecordId: n.negotiation.globalRecordId,
          partnerName: n.negotiation.globalRecord.canonicalName,
          author: n.creator.name,
          content: n.content,
        })),
      ].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit)

      return textResult(items)
    },
  )
}

// Write tools all gate on the exact same permission functions the corresponding REST
// endpoints use (canEditNegotiation / canEditInteractionRecord) — an MCP token never gets
// more write access than the user it belongs to already has in the browser UI. Each mutation
// also calls logEvent() with source: 'mcp' so agent-made changes are visible in the partner's
// audit history (RecordEvent), distinguishable from human edits.
export function registerWriteTools(server: McpServer, ctx: McpToolContext) {
  server.registerTool(
    'add_note',
    {
      title: 'Přidat poznámku',
      description: 'Přidá novou poznámku k jednání s partnerem v daném projektu.',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
        content: z.string(),
      },
    },
    async ({ projectId, globalRecordId, content }) => {
      if (!content.trim()) return errorResult('Obsah poznámky je povinný.')

      const canEdit = await canEditNegotiation(ctx.userId, projectId, globalRecordId)
      if (!canEdit) return errorResult('Nemáte oprávnění vytvořit záznam jednání. Nejste přiřazeni k tomuto partnerovi.')

      const negotiation = await prisma.negotiation.upsert({
        where: { projectId_globalRecordId: { projectId, globalRecordId } },
        create: { projectId, globalRecordId },
        update: {},
      })

      const note = await prisma.note.create({
        data: { negotiationId: negotiation.id, content: content.trim(), createdBy: ctx.userId },
        select: { id: true, content: true, createdAt: true },
      })

      await logEvent({ globalRecordId, userId: ctx.userId, eventType: 'MCP_NOTE_ADDED', metadata: { noteId: note.id, projectId, source: 'mcp' } })
      return textResult(note)
    },
  )

  server.registerTool(
    'update_note',
    {
      title: 'Upravit poznámku',
      description: 'Upraví obsah existující poznámky.',
      inputSchema: {
        noteId: z.string(),
        content: z.string(),
      },
    },
    async ({ noteId, content }) => {
      if (!content.trim()) return errorResult('Obsah poznámky je povinný.')

      const note = await prisma.note.findUnique({
        where: { id: noteId },
        include: { assignees: { select: { userId: true } }, negotiation: { select: { projectId: true, globalRecordId: true } } },
      })
      if (!note) return errorResult('Poznámka nebyla nalezena.')

      const { projectId, globalRecordId } = note.negotiation
      const canEdit = await canEditInteractionRecord(ctx.userId, projectId, globalRecordId, note.createdBy)
      if (!canEdit) return errorResult('Nemáte oprávnění upravit tuto poznámku.')

      // If someone other than the creator edits, add them as a co-author (NoteAssignee) — same as the REST endpoint.
      const isCreator = note.createdBy === ctx.userId
      const isAlreadyAssignee = note.assignees.some(a => a.userId === ctx.userId)
      const data: Record<string, any> = { content: content.trim() }
      if (!isCreator && !isAlreadyAssignee) data.assignees = { create: { userId: ctx.userId } }

      const updated = await prisma.note.update({ where: { id: noteId }, data, select: { id: true, content: true, updatedAt: true } })
      await logEvent({ globalRecordId, userId: ctx.userId, eventType: 'MCP_NOTE_UPDATED', metadata: { noteId, projectId, source: 'mcp' } })
      return textResult(updated)
    },
  )

  server.registerTool(
    'update_fulfillment',
    {
      title: 'Upravit obsah plnění',
      description: 'Upraví checklist "My jim" (myToThem) a/nebo "Oni nám" (themToUs) pro dané jednání. Prázdný text = smazat obsah dané strany.',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
        myToThem: z.string().optional(),
        themToUs: z.string().optional(),
      },
    },
    async ({ projectId, globalRecordId, myToThem, themToUs }) => {
      const canEdit = await canEditNegotiation(ctx.userId, projectId, globalRecordId)
      if (!canEdit) return errorResult('Nemáte oprávnění editovat toto jednání. Nejste přiřazeni k tomuto partnerovi.')

      const data: Record<string, any> = {}
      if (myToThem !== undefined) data.myToThem = myToThem.trim() ? normalizeChecklist(myToThem) : null
      if (themToUs !== undefined) data.themToUs = themToUs.trim() ? normalizeChecklist(themToUs) : null

      const negotiation = await prisma.negotiation.upsert({
        where: { projectId_globalRecordId: { projectId, globalRecordId } },
        create: { projectId, globalRecordId, ...data },
        update: data,
      })

      // Track co-authorship, same as the REST endpoint (fulfillment.patch.ts / toggle-check).
      const isAlreadyAssignee = await prisma.fulfillmentAssignee.findUnique({
        where: { negotiationId_userId: { negotiationId: negotiation.id, userId: ctx.userId } },
      })
      if (!isAlreadyAssignee) {
        await prisma.fulfillmentAssignee.create({ data: { negotiationId: negotiation.id, userId: ctx.userId } }).catch(() => {})
      }

      await logEvent({ globalRecordId, userId: ctx.userId, eventType: 'MCP_FULFILLMENT_UPDATED', metadata: { projectId, source: 'mcp' } })
      return textResult({ myToThem: negotiation.myToThem, themToUs: negotiation.themToUs })
    },
  )

  server.registerTool(
    'update_todo',
    {
      title: 'Upravit To-Do',
      description: 'Nahradí To-Do checklist jednání. Pošli null pro smazání celého seznamu.',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
        todoList: z.string().nullable(),
      },
    },
    async ({ projectId, globalRecordId, todoList }) => {
      const canEdit = await canEditNegotiation(ctx.userId, projectId, globalRecordId)
      if (!canEdit) return errorResult('Nemáte oprávnění editovat toto jednání. Nejste přiřazeni k tomuto partnerovi.')

      const normalized = todoList?.trim() ? normalizeTodo(todoList) : null
      const negotiation = await prisma.negotiation.upsert({
        where: { projectId_globalRecordId: { projectId, globalRecordId } },
        create: { projectId, globalRecordId, todoList: normalized },
        update: { todoList: normalized },
      })

      await logEvent({ globalRecordId, userId: ctx.userId, eventType: 'MCP_TODO_UPDATED', metadata: { projectId, source: 'mcp' } })
      return textResult({ todoList: negotiation.todoList })
    },
  )

  server.registerTool(
    'update_negotiation_status',
    {
      title: 'Změnit stav jednání',
      description: 'Nastaví stav jednání s partnerem v projektu.',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
        negotiationStatus: z.enum(EDITABLE_NEGOTIATION_STATUSES as [string, ...string[]]),
      },
    },
    async ({ projectId, globalRecordId, negotiationStatus }) => {
      const canEdit = await canEditNegotiation(ctx.userId, projectId, globalRecordId)
      if (!canEdit) return errorResult('Nemáte oprávnění editovat stav tohoto partnera. Nejste přiřazeni k tomuto partnerovi.')

      await prisma.negotiation.upsert({
        where: { projectId_globalRecordId: { projectId, globalRecordId } },
        create: { projectId, globalRecordId, negotiationStatus: negotiationStatus as any },
        update: { negotiationStatus: negotiationStatus as any },
      })

      await logEvent({ globalRecordId, userId: ctx.userId, eventType: 'MCP_STATUS_UPDATED', metadata: { projectId, negotiationStatus, source: 'mcp' } })
      return textResult({ negotiationStatus })
    },
  )
}
