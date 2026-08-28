import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '~/server/utils/prisma'
import { getUserScopeAccess } from '~/server/utils/permissions'
import { getPartnerHeader, getNegotiationTimeline } from '~/server/utils/negotiation-detail'
import { canEditNegotiation, canEditInteractionRecord, getInteractionAccess, canManagePartnersGlobally } from '~/server/utils/projectPermissions'
import { upsertNegotiationAssignees } from '~/server/utils/negotiation-assignment'
import { normalizeName } from '~/server/utils/deduplication'
import { logEvent } from '~/server/utils/record-events'
import { normalizeChecklist, normalizeTodo } from '~/utils/checklist'
import { EDITABLE_NEGOTIATION_STATUSES } from '~/utils/negotiationStatus'
import { PARTNER_RESEARCH_PROMPT } from '~/utils/researchPrompt'

// Deliberately NOT exposed to MCP agents, even though the user holds edit rights: sending email
// (Gmail send is a real, hard-to-undo external action), blacklist management, and GlobalRecord
// merge/duplicate resolution. Keep those as human-only actions in the app UI — don't add tools
// for them without revisiting that decision explicitly. Partner deletion IS exposed (below),
// gated behind canManagePartnersGlobally — the same restriction now also enforced by the REST
// endpoint itself (server/api/partners/[id].delete.ts), since it used to allow any authenticated
// user to permanently delete any partner across every project.

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

  server.registerTool(
    'get_research_prompt',
    {
      title: 'Deep-research prompt pro nového partnera',
      description: 'Vrátí prompt šablonu pro hloubkový due-diligence průzkum potenciálního partnera (web, LinkedIn, kontakty, doklady o partnerství, ...). Appka už vlastní automatický deep research nemá (bylo to drahé) — pokud umíš dělat skutečné živé vyhledávání na webu, spusť si tento prompt sám na jméno kandidáta a výsledný JSON předej nástroji create_partner. Pokud web search nemáš, vrať prompt uživateli, ať ho spustí v nástroji, který live search má, a vrátí ti výsledek.',
      inputSchema: {},
    },
    async () => textResult({ prompt: PARTNER_RESEARCH_PROMPT }),
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

  server.registerTool(
    'create_partner',
    {
      title: 'Vytvořit partnera',
      description: 'Vytvoří nového partnera (GlobalRecord typu PARTNER). Payload má stejnou strukturu jako výstup get_research_prompt. Volitelně ho rovnou přidá do projektu (Oslovování, stav PRED_OSLOVENIM) — viz projectId/assigneeIds.',
      inputSchema: {
        canonicalName: z.string(),
        payload: z.record(z.string(), z.any()).optional().describe('website, industry, size, summary, contacts: [{firstName,lastName,role,email,type,priority,note}], ...'),
        projectId: z.string().optional().describe('Pokud zadán, partner se rovnou přidá do tohoto projektu.'),
        assigneeIds: z.array(z.string()).optional().describe('Kdo je přiřazen jako plnitel při přidání do projektu (jen s projectId). Bez oprávnění edit_all/admin se volající vždy přidá sám.'),
      },
    },
    async ({ canonicalName, payload, projectId, assigneeIds }) => {
      const name = canonicalName.trim()
      if (!name) return errorResult('Název partnera je povinný.')

      const normalized = normalizeName(name)
      const existing = await prisma.globalRecord.findUnique({ where: { normalizedName_type: { normalizedName: normalized, type: 'PARTNER' } } })
      if (existing) return errorResult(`Partner "${existing.canonicalName}" už existuje (id: ${existing.id}).`)

      if (projectId) await assertProjectAccess(ctx, projectId)

      const record = await prisma.globalRecord.create({
        data: { type: 'PARTNER', canonicalName: name, normalizedName: normalized, payload: (payload ?? {}) as any, createdBy: ctx.userId },
      })
      await logEvent({ globalRecordId: record.id, userId: ctx.userId, eventType: 'MANUAL_CREATE', metadata: { source: 'mcp' } })

      const contacts = Array.isArray((payload as any)?.contacts) ? (payload as any).contacts : []
      for (const c of contacts) {
        const address = c.email?.trim() ? c.email.trim().toLowerCase() : null
        await prisma.partnerContact.create({
          data: {
            globalRecordId: record.id, address,
            label: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
            firstName: c.firstName || null, lastName: c.lastName || null,
            role: c.role || null, contactType: c.type || null,
            priority: c.priority ?? 3, note: c.note || null,
          },
        }).catch((e: any) => { if (e?.code !== 'P2002') throw e })
      }

      let negotiationCreated = false
      if (projectId) {
        const access = await getInteractionAccess(ctx.userId, projectId)
        const finalAssigneeIds = [...(assigneeIds ?? [])]
        if (!access.canEditAll && !access.isAdmin && !finalAssigneeIds.includes(ctx.userId)) finalAssigneeIds.push(ctx.userId)
        const negotiation = await prisma.negotiation.create({ data: { globalRecordId: record.id, projectId, negotiationStatus: 'PRED_OSLOVENIM' } })
        negotiationCreated = true
        if (finalAssigneeIds.length > 0) {
          await prisma.fulfillmentAssignee.createMany({ data: finalAssigneeIds.map(userId => ({ negotiationId: negotiation.id, userId })), skipDuplicates: true })
        }
      }

      return textResult({ id: record.id, canonicalName: record.canonicalName, negotiationCreated })
    },
  )

  server.registerTool(
    'update_partner',
    {
      title: 'Upravit partnera',
      description: 'Upraví název a/nebo profilová data (payload) existujícího partnera. payload se mergne do stávajícího (klíč s hodnotou null se smaže, jinak se přepíše/přidá) — stejně jako editor na /partners. Bez projektového omezení (partner je globální záznam), stejně jako v appce.',
      inputSchema: {
        globalRecordId: z.string(),
        canonicalName: z.string().optional(),
        payload: z.record(z.string(), z.any().nullable()).optional(),
      },
    },
    async ({ globalRecordId, canonicalName, payload }) => {
      const existing = await prisma.globalRecord.findUnique({ where: { id: globalRecordId } })
      if (!existing) return errorResult('Partner nenalezen.')
      if (existing.type !== 'PARTNER') return errorResult('Záznam není typu PARTNER.')

      const nameUpdate: Record<string, string> = {}
      if (canonicalName?.trim()) {
        nameUpdate.canonicalName = canonicalName.trim()
        nameUpdate.normalizedName = normalizeName(nameUpdate.canonicalName)
      }

      let payloadUpdate: { payload?: any } = {}
      if (payload) {
        const merged = { ...(existing.payload as Record<string, unknown>) }
        for (const [key, value] of Object.entries(payload)) {
          if (value === null) delete merged[key]
          else merged[key] = value
        }
        payloadUpdate = { payload: merged }
      }

      const updated = await prisma.globalRecord.update({
        where: { id: globalRecordId },
        data: { ...nameUpdate, ...payloadUpdate },
        select: { id: true, canonicalName: true, payload: true },
      }).catch((e: any) => {
        if (e?.code === 'P2002') throw new Error('Partner s tímto názvem už existuje.')
        throw e
      })

      await logEvent({ globalRecordId, userId: ctx.userId, eventType: 'MANUAL_EDIT', metadata: { source: 'mcp' } })

      if (Array.isArray((payload as any)?.contacts)) {
        const { syncProfileContactsToDb } = await import('~/server/utils/sync-contacts')
        await syncProfileContactsToDb(globalRecordId, (payload as any).contacts)
      }

      return textResult(updated)
    },
  )

  server.registerTool(
    'delete_partner',
    {
      title: 'Smazat partnera',
      description: 'Trvale smaže partnera (GlobalRecord) včetně veškeré historie jednání napříč všemi projekty. Nevratné. Dostupné jen pro admina nebo Vedení obchodu (v libovolném projektu) — přísnější než ostatní partner nástroje.',
      inputSchema: {
        globalRecordId: z.string(),
      },
    },
    async ({ globalRecordId }) => {
      if (!(await canManagePartnersGlobally(ctx.userId))) {
        return errorResult('Smazání partnera je dostupné jen pro vedení obchodu a administrátory.')
      }
      const existing = await prisma.globalRecord.findUnique({ where: { id: globalRecordId }, select: { id: true, type: true, canonicalName: true } })
      if (!existing) return errorResult('Partner nenalezen.')
      if (existing.type !== 'PARTNER') return errorResult('Záznam není typu PARTNER.')

      await prisma.$transaction([
        prisma.recordEvent.deleteMany({ where: { globalRecordId } }),
        prisma.partnerContact.deleteMany({ where: { globalRecordId } }),
        prisma.globalRecord.delete({ where: { id: globalRecordId } }),
      ])

      return textResult({ deleted: true, canonicalName: existing.canonicalName })
    },
  )

  server.registerTool(
    'assign_partner_to_project',
    {
      title: 'Přidat partnera do projektu (Oslovování)',
      description: 'Zajistí, že je partner vidět v Oslovování/Jednání daného projektu (vytvoří Negotiation řádek se stavem PRED_OSLOVENIM, pokud ještě neexistuje). purpose "outreach" (výchozí) nastaví jednoho zodpovědného za oslovení (max 1 assigneeId); "negotiation" přidá vyjednavače (může jich být víc) a posune stav na V_JEDNANI. Dostupné jen pro admina nebo Vedení obchodu v daném projektu.',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
        purpose: z.enum(['outreach', 'negotiation']).default('outreach'),
        assigneeIds: z.array(z.string()).optional(),
      },
    },
    async ({ projectId, globalRecordId, purpose, assigneeIds }) => {
      await assertProjectAccess(ctx, projectId)
      const access = await getInteractionAccess(ctx.userId, projectId)
      if (!access.isAdmin && !access.canEditAll) {
        return errorResult('Nemáte oprávnění přidávat partnery do projektu. Vyžaduje admina nebo Vedení obchodu.')
      }

      const ids = assigneeIds ?? []
      if (purpose === 'outreach' && ids.length > 1) {
        return errorResult('Oslovování podporuje jen jednoho přiřazeného.')
      }

      const negotiation = await prisma.negotiation.upsert({
        where: { projectId_globalRecordId: { projectId, globalRecordId } },
        create: { projectId, globalRecordId, manuallyAddedAt: new Date(), negotiationStatus: 'PRED_OSLOVENIM' },
        update: { removedAt: null, manuallyAddedAt: new Date() },
      })

      if (ids.length > 0) {
        await prisma.fulfillmentAssignee.createMany({ data: ids.map(userId => ({ negotiationId: negotiation.id, userId })), skipDuplicates: true })
      }

      if (purpose === 'negotiation') {
        await upsertNegotiationAssignees(projectId, globalRecordId, ids, ctx.userId)
        if (ids.length === 0) {
          await prisma.negotiation.updateMany({
            where: { projectId, globalRecordId, OR: [{ negotiationStatus: null }, { negotiationStatus: 'PRED_OSLOVENIM' }] },
            data: { negotiationStatus: 'V_JEDNANI' },
          })
        }
      } else if (ids.length === 1) {
        await prisma.outreachAssignment.upsert({
          where: { projectId_globalRecordId_assigneeId: { projectId, globalRecordId, assigneeId: ids[0] } },
          create: { projectId, globalRecordId, assigneeId: ids[0], assignedById: ctx.userId },
          update: {},
        })
      }

      await logEvent({ globalRecordId, userId: ctx.userId, eventType: 'MCP_ASSIGNED_TO_PROJECT', metadata: { projectId, purpose, source: 'mcp' } })
      return textResult({ negotiationId: negotiation.id, negotiationStatus: negotiation.negotiationStatus })
    },
  )

  server.registerTool(
    'claim_outreach',
    {
      title: 'Vzít si oslovení partnera',
      description: 'Přiřadí VOLAJÍCÍHO uživatele jako zodpovědného za oslovení partnera v projektu (Oslovování). Funguje jen pokud partner ještě nemá jiného řešitele. Vyžaduje jen členství v projektu (na rozdíl od assign_outreach, které umí přiřadit kohokoli).',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
      },
    },
    async ({ projectId, globalRecordId }) => {
      await assertProjectAccess(ctx, projectId)

      const existing = await prisma.outreachAssignment.findFirst({ where: { projectId, globalRecordId }, select: { assigneeId: true } })
      if (existing && existing.assigneeId !== ctx.userId) {
        return errorResult('Partner už má přiřazeného jiného řešitele oslovení.')
      }

      await prisma.outreachAssignment.upsert({
        where: { projectId_globalRecordId_assigneeId: { projectId, globalRecordId, assigneeId: ctx.userId } },
        create: { projectId, globalRecordId, assigneeId: ctx.userId, assignedById: ctx.userId },
        update: {},
      })

      return textResult({ claimed: true })
    },
  )

  server.registerTool(
    'unclaim_outreach',
    {
      title: 'Vzdát se oslovení partnera',
      description: 'Odebere VOLAJÍCÍHO uživatele jako zodpovědného za oslovení partnera (musí to být oni sami, kdo je aktuálně přiřazen).',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
      },
    },
    async ({ projectId, globalRecordId }) => {
      await assertProjectAccess(ctx, projectId)

      const assignment = await prisma.outreachAssignment.findFirst({ where: { projectId, globalRecordId, assigneeId: ctx.userId }, select: { id: true } })
      if (!assignment) return errorResult('Nejste přiřazeni k tomuto partnerovi.')

      await prisma.outreachAssignment.deleteMany({ where: { projectId, globalRecordId, assigneeId: ctx.userId } })
      return textResult({ unclaimed: true })
    },
  )

  server.registerTool(
    'assign_outreach',
    {
      title: 'Přiřadit oslovení konkrétnímu uživateli',
      description: 'Přiřadí (nebo odebere, userId: null) zodpovědnost za oslovení partnera libovolnému uživateli — na rozdíl od claim_outreach nejde jen o sebe. Nahrazuje předchozí přiřazení (Oslovování má vždy max. jednoho zodpovědného). Dostupné jen pro admina nebo Vedení obchodu.',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
        userId: z.string().nullable(),
      },
    },
    async ({ projectId, globalRecordId, userId }) => {
      await assertProjectAccess(ctx, projectId)
      const access = await getInteractionAccess(ctx.userId, projectId)
      if (!access.isAdmin && !access.canEditAll) {
        return errorResult('Nemáte oprávnění přiřazovat partnery. Vyžaduje admina nebo Vedení obchodu.')
      }

      if (userId === null) {
        await prisma.outreachAssignment.deleteMany({ where: { projectId, globalRecordId } })
        return textResult({ assignment: null })
      }

      const targetUser = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true } })
      if (!targetUser) return errorResult('Uživatel nebyl nalezen.')

      await prisma.outreachAssignment.deleteMany({ where: { projectId, globalRecordId } })
      await prisma.outreachAssignment.create({
        data: { projectId, globalRecordId, assigneeId: userId, assignedById: ctx.userId },
      })

      return textResult({ assignment: { assigneeId: targetUser.id, assigneeName: targetUser.name } })
    },
  )
}
