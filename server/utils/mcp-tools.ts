import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '~/server/utils/prisma'
import { getUserScopeAccess } from '~/server/utils/permissions'
import { getPartnerHeader, getNegotiationTimeline } from '~/server/utils/negotiation-detail'
import { canEditNegotiation, canEditInteractionRecord, getInteractionAccess, getProjectPermissions, canManagePartnersGlobally } from '~/server/utils/projectPermissions'
import { upsertNegotiationAssignees, assignNegotiationOnSend } from '~/server/utils/negotiation-assignment'
import { normalizeName } from '~/server/utils/deduplication'
import { logEvent } from '~/server/utils/record-events'
import { normalizeChecklist, normalizeTodo } from '~/utils/checklist'
import { EDITABLE_NEGOTIATION_STATUSES } from '~/utils/negotiationStatus'
import { PARTNER_RESEARCH_PROMPT } from '~/utils/researchPrompt'
import { libraryScopeForProject, contextPartAccessFilter } from '~/server/utils/libraryScope'
import { sendGmailMessage, refreshAccessToken } from '~/server/utils/google'
import { trackCustomRecipientAddress } from '~/server/utils/project-additional-addresses'
import { STEP_OUTPUT_SCHEMAS, GROUP_FONTS, formatSchemaForPrompt, getMissingPlaceholders, renderPromptTemplate } from '~/config/pipeline'

// Deliberately NOT exposed to MCP agents, even though the user holds edit rights: blacklist
// management and GlobalRecord merge/duplicate resolution. Keep those as human-only actions in
// the app UI — don't add tools for them without revisiting that decision explicitly. Partner
// deletion IS exposed (below), gated behind canManagePartnersGlobally — the same restriction now
// also enforced by the REST endpoint itself (server/api/partners/[id].delete.ts), since it used
// to allow any authenticated user to permanently delete any partner across every project.
//
// Sending email (send_outreach_email, below) WAS in that deliberately-excluded list — a real,
// hard-to-undo external action — until the user explicitly asked for full remote outreach
// automation (value alignment, drafting, signatures, send/schedule) via MCP. send_outreach_email
// performs an *immediate* Gmail send synchronously (no 20s undo grace period like the human UI's
// send button — an agent that already decided to send doesn't need a misclick safety net, and a
// tool call needs a definitive result to report back). Library asset creation/editing (system
// prompts, context parts, selling points, email templates, signatures) is intentionally NOT
// exposed — MCP tools only ever *select* existing library assets by id, never create or mutate
// the shared library.
//
// VALUE_ALIGNMENT and OUTREACH_PREPARATION deliberately do NOT run as server-side AI calls here
// (unlike the REST endpoints, which stream from OpenRouter and bill the server's AI budget).
// get_value_alignment_prompt / get_outreach_draft_prompt assemble and hand back the exact
// system prompt + user message + output schema the REST step would have sent to the model —
// the calling agent runs that "step" itself with its own inference (zero server AI spend) and
// then persists the structured result via save_value_alignment / save_outreach_draft. Same
// pattern as get_research_prompt for partner research, applied consistently to every AI step.

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

// Same gate as alignment.post.ts / draft.post.ts: admin/canEditAll, or specifically the
// OutreachAssignment holder for this partner (narrower than canEditNegotiation, which also
// allows negotiation assignees — value alignment/drafting are part of the outreach step).
async function assertOutreachAssignee(ctx: McpToolContext, projectId: string, globalRecordId: string) {
  const access = await getInteractionAccess(ctx.userId, projectId)
  if (access.isAdmin || access.canEditAll) return
  const assignment = await prisma.outreachAssignment.findFirst({
    where: { projectId, globalRecordId, assigneeId: ctx.userId },
    select: { id: true },
  })
  if (!assignment) throw new Error('Nemáte oprávnění — nejste přiřazeni k oslovení tohoto partnera.')
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

  server.registerTool(
    'list_library',
    {
      title: 'Knihovna kontextu (pro Value Alignment / Draft / podpisy)',
      description: 'Vrátí dostupné Library assety pro daný projekt: systémové prompty pro VALUE_ALIGNMENT/OUTREACH_PREPARATION, context parts, selling points, e-mailové šablony a podpisy (skupinové šablony + osobní). Použij id z výsledků jako vstup do get_value_alignment_prompt/get_outreach_draft_prompt/send_outreach_email. MCP nástroje neumí vytvářet ani upravovat tyto assety — jen vybírat existující.',
      inputSchema: {
        projectId: z.string(),
      },
    },
    async ({ projectId }) => {
      await assertProjectAccess(ctx, projectId)
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, groupId: true } })
      if (!project) return errorResult('Projekt nenalezen.')

      const scopeFilter = libraryScopeForProject(project)

      const [systemPrompts, contextParts, sellingPoints, emailDrafts, signatureTemplates, personalSignatures] = await Promise.all([
        prisma.systemPrompt.findMany({
          where: { stepType: { in: ['VALUE_ALIGNMENT', 'OUTREACH_PREPARATION'] }, OR: [{ isSystem: true }, scopeFilter] },
          select: { id: true, name: true, stepType: true, isSystem: true },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.contextPart.findMany({
          where: contextPartAccessFilter(project, ctx.userId),
          select: { id: true, name: true, stepKeys: true, isPrivate: true },
          orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
        }),
        prisma.sellingPoint.findMany({
          where: scopeFilter,
          select: { id: true, name: true },
          orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
        }),
        prisma.emailDraft.findMany({
          where: scopeFilter,
          select: { id: true, name: true, subject: true, usageTypes: true },
          orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
        }),
        prisma.signature.findMany({
          where: { isTemplate: true, groupId: project.groupId },
          select: { id: true, name: true },
        }),
        prisma.signature.findMany({
          where: { isTemplate: false, authorId: ctx.userId, groupId: project.groupId },
          select: { id: true, name: true },
          orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
        }),
      ])

      return textResult({ systemPrompts, contextParts, sellingPoints, emailDrafts, signatures: { templates: signatureTemplates, personal: personalSignatures } })
    },
  )

  server.registerTool(
    'get_outreach_state',
    {
      title: 'Stav Value Alignment / Draftu / naplánovaných e-mailů',
      description: 'Vrátí uloženou Value Alignment analýzu, uložený e-mailový draft (PartnerOutreachDraft) a čekající naplánované e-maily pro daného partnera v projektu — pro kontrolu stavu před get_value_alignment_prompt/get_outreach_draft_prompt/send_outreach_email.',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
      },
    },
    async ({ projectId, globalRecordId }) => {
      await assertProjectAccess(ctx, projectId)

      const [alignment, draft, scheduledEmails] = await Promise.all([
        prisma.partnerAlignment.findUnique({ where: { projectId_globalRecordId: { projectId, globalRecordId } } }),
        prisma.partnerOutreachDraft.findUnique({ where: { projectId_globalRecordId: { projectId, globalRecordId } } }),
        prisma.scheduledEmail.findMany({
          where: { projectId, globalRecordId, status: { in: ['PENDING', 'SENDING', 'FAILED'] } },
          select: { id: true, toAddress: true, subject: true, scheduledFor: true, status: true, errorMessage: true },
          orderBy: { scheduledFor: 'asc' },
        }),
      ])

      return textResult({
        alignment: alignment ? { id: alignment.id, outputData: alignment.outputData, updatedAt: alignment.updatedAt } : null,
        draft: draft ? {
          id: draft.id, toAddress: draft.toAddress, subject: draft.subject, body: draft.body,
          recommendations: draft.recommendations, config: draft.config,
          sentAt: draft.sentAt, sendError: draft.sendError, savedAt: draft.savedAt,
        } : null,
        scheduledEmails,
      })
    },
  )

  server.registerTool(
    'get_value_alignment_prompt',
    {
      title: 'Sestavit prompt pro Value Alignment (spusť si sám, bez serverové AI)',
      description: 'Sestaví a vrátí přesný systémový prompt, uživatelskou zprávu a výstupní JSON schéma pro krok VALUE_ALIGNMENT (analýza souladu partnera s prodejními argumenty) — stejně jako REST endpoint, ale BEZ volání AI na serveru. Spusť tento prompt sám (svou vlastní inferencí) a výsledný JSON ulož nástrojem save_value_alignment. Volitelný výběr system promptu / context parts / selling pointu — viz list_library. Bez systemPromptId se použije výchozí systémový prompt pro krok. Vyžaduje přiřazení k oslovení tohoto partnera (nebo admin/Vedení obchodu).',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
        systemPromptId: z.string().optional(),
        contextPartIds: z.array(z.string()).optional(),
        sellingPointId: z.string().optional(),
        manualContext: z.string().optional(),
      },
    },
    async ({ projectId, globalRecordId, systemPromptId, contextPartIds, sellingPointId, manualContext }) => {
      await assertProjectAccess(ctx, projectId)
      try {
        await assertOutreachAssignee(ctx, projectId, globalRecordId)
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e))
      }

      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, groupId: true } })
      if (!project) return errorResult('Projekt nenalezen.')
      const globalRecord = await prisma.globalRecord.findUnique({ where: { id: globalRecordId } })
      if (!globalRecord) return errorResult('Partner nenalezen.')

      const scopeFilter = libraryScopeForProject(project)
      const STEP = 'VALUE_ALIGNMENT'

      const [contextParts, customPrompt, dbSystemPrompt, sellingPoint] = await Promise.all([
        contextPartIds?.length
          ? prisma.contextPart.findMany({ where: { id: { in: contextPartIds }, ...contextPartAccessFilter(project, ctx.userId) } })
          : Promise.resolve([]),
        systemPromptId
          ? prisma.systemPrompt.findFirst({ where: { id: systemPromptId, stepType: STEP as never, OR: [{ isSystem: true }, scopeFilter] } })
          : Promise.resolve(null),
        prisma.systemPrompt.findFirst({ where: { stepType: STEP as never, isSystem: true }, orderBy: { createdAt: 'desc' } }),
        sellingPointId
          ? prisma.sellingPoint.findFirst({ where: { id: sellingPointId, ...scopeFilter } })
          : Promise.resolve(null),
      ])

      const rawPromptText = customPrompt?.content ?? dbSystemPrompt?.content
      if (!rawPromptText) return errorResult(`Chybí systémový prompt pro krok ${STEP} (databáze není nasazená, spusťte "bun run db:seed").`)
      const missingPlaceholders = getMissingPlaceholders(STEP, rawPromptText)
      if (missingPlaceholders.length) return errorResult(`Systémový prompt pro krok ${STEP} postrádá povinné placeholdery: ${missingPlaceholders.join(', ')}.`)
      const outputSchema = (customPrompt?.outputSchema as object | null) ?? (dbSystemPrompt?.outputSchema as object | null) ?? STEP_OUTPUT_SCHEMAS[STEP] ?? null

      const contextBlock = [
        ...contextParts.map(c => `${c.name}:\n${c.content}`),
        ...(manualContext?.trim() ? [`Vlastní kontext:\n${manualContext}`] : []),
      ].join('\n\n')
      const argumentsBlock = sellingPoint?.content ?? ''

      const systemPrompt = renderPromptTemplate(rawPromptText, {
        SCHEMA: outputSchema ? formatSchemaForPrompt(outputSchema) : undefined,
        CONTEXT: contextBlock,
        ARGUMENTS: argumentsBlock,
      })

      const profileInput = globalRecord.payload as Record<string, unknown>
      const userMessage = [
        'Analyzuj soulad mezi tímto partnerem a našimi prodejními argumenty. Vrať strukturovaný JSON dle systémového promptu.',
        '',
        'Profil partnera:',
        '```json',
        JSON.stringify(profileInput, null, 2),
        '```',
      ].join('\n')

      return textResult({
        systemPrompt,
        userMessage,
        outputSchema,
        usedSystemPromptId: customPrompt?.id ?? dbSystemPrompt?.id ?? null,
        nextStep: 'Vygeneruj JSON výstup dle outputSchema a ulož ho nástrojem save_value_alignment (projectId, globalRecordId, outputData, ...).',
      })
    },
  )

  server.registerTool(
    'get_outreach_draft_prompt',
    {
      title: 'Sestavit prompt pro e-mailový draft (spusť si sám, bez serverové AI)',
      description: 'Sestaví a vrátí přesný systémový prompt, uživatelskou zprávu a výstupní JSON schéma pro krok OUTREACH_PREPARATION (personalizovaný cold e-mail) — stejně jako REST endpoint, ale BEZ volání AI na serveru. Spusť tento prompt sám (svou vlastní inferencí) a výsledný e-mail ulož nástrojem save_outreach_draft. Vyžaduje předem uloženou Value Alignment (save_value_alignment). Volitelně: emailDraftId (šablona formátu/stylu z list_library), context parts, selling point, konkrétní kontakt adresáta a výběr konkrétních argumentů z alignmentu (selectedArgumentIds). Vyžaduje přiřazení k oslovení tohoto partnera (nebo admin/Vedení obchodu).',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
        systemPromptId: z.string().optional(),
        emailDraftId: z.string().optional(),
        contextPartIds: z.array(z.string()).optional(),
        sellingPointId: z.string().optional(),
        manualContext: z.string().optional(),
        selectedContact: z.object({
          firstName: z.string().nullable().optional(),
          lastName: z.string().nullable().optional(),
          role: z.string().nullable().optional(),
          address: z.string().nullable().optional(),
        }).optional(),
        selectedArgumentIds: z.array(z.string()).optional(),
      },
    },
    async ({ projectId, globalRecordId, systemPromptId, emailDraftId, contextPartIds, sellingPointId, manualContext, selectedContact, selectedArgumentIds }) => {
      await assertProjectAccess(ctx, projectId)
      try {
        await assertOutreachAssignee(ctx, projectId, globalRecordId)
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e))
      }

      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, groupId: true, group: { select: { slug: true } } } })
      if (!project) return errorResult('Projekt nenalezen.')

      const alignment = await prisma.partnerAlignment.findUnique({ where: { projectId_globalRecordId: { projectId, globalRecordId } } })
      if (!alignment) return errorResult('Nejprve spusťte get_value_alignment_prompt + save_value_alignment pro tohoto partnera.')

      const scopeFilter = libraryScopeForProject(project)
      const STEP = 'OUTREACH_PREPARATION'

      const [contextParts, customPrompt, dbSystemPrompt, emailDraft, sellingPoint] = await Promise.all([
        contextPartIds?.length
          ? prisma.contextPart.findMany({ where: { id: { in: contextPartIds }, ...contextPartAccessFilter(project, ctx.userId) } })
          : Promise.resolve([]),
        systemPromptId
          ? prisma.systemPrompt.findFirst({ where: { id: systemPromptId, stepType: STEP as never, OR: [{ isSystem: true }, scopeFilter] } })
          : Promise.resolve(null),
        prisma.systemPrompt.findFirst({ where: { stepType: STEP as never, isSystem: true }, orderBy: { createdAt: 'desc' } }),
        emailDraftId
          ? prisma.emailDraft.findFirst({ where: { id: emailDraftId, ...scopeFilter } })
          : Promise.resolve(null),
        sellingPointId
          ? prisma.sellingPoint.findFirst({ where: { id: sellingPointId, ...scopeFilter } })
          : Promise.resolve(null),
      ])

      const rawPromptText = customPrompt?.content ?? dbSystemPrompt?.content
      if (!rawPromptText) return errorResult(`Chybí systémový prompt pro krok ${STEP} (databáze není nasazená, spusťte "bun run db:seed").`)
      const missingPlaceholders = getMissingPlaceholders(STEP, rawPromptText)
      if (missingPlaceholders.length) return errorResult(`Systémový prompt pro krok ${STEP} postrádá povinné placeholdery: ${missingPlaceholders.join(', ')}.`)
      const outputSchema = (customPrompt?.outputSchema as object | null) ?? (dbSystemPrompt?.outputSchema as object | null) ?? STEP_OUTPUT_SCHEMAS[STEP] ?? null

      const contextBlock = [
        ...contextParts.map(c => `${c.name}:\n${c.content}`),
        ...(manualContext?.trim() ? [`Vlastní kontext:\n${manualContext}`] : []),
      ].join('\n\n')
      const argumentsBlock = sellingPoint?.content ?? ''

      const templateSection = emailDraft
        ? ['E-mailová šablona (respektuj tento formát, styl a délku):', `Předmět: ${emailDraft.subject}`, `Tělo:\n${emailDraft.body}`].join('\n')
        : ''

      const rawPartnerData = alignment.outputData as Record<string, unknown>
      const selectedIds = new Set(selectedArgumentIds ?? [])
      const partnerData: Record<string, unknown> = selectedIds.size === 0
        ? rawPartnerData
        : {
            ...rawPartnerData,
            ...(Array.isArray(rawPartnerData.topArguments)
              ? { topArguments: (rawPartnerData.topArguments as Array<Record<string, unknown>>).filter(a => selectedIds.has(String(a.argumentId))) }
              : {}),
            ...(Array.isArray(rawPartnerData.argumentAlignment)
              ? { argumentAlignment: (rawPartnerData.argumentAlignment as Array<Record<string, unknown>>).filter(a => selectedIds.has(String(a.argumentId))) }
              : {}),
          }
      const partnerDataBlock = '```json\n' + JSON.stringify(partnerData, null, 2) + '\n```'
      const fontFamily = GROUP_FONTS[project.group?.slug ?? ''] ?? ''

      const user = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true } })
      const systemPrompt = renderPromptTemplate(rawPromptText, {
        SCHEMA: outputSchema ? formatSchemaForPrompt(outputSchema) : undefined,
        DATA: partnerDataBlock,
        CONTEXT: contextBlock,
        ARGUMENTS: argumentsBlock,
        TEMPLATE: templateSection,
        USER: user?.name ?? '',
      })

      const contactLine = selectedContact?.address
        ? `Adresát: ${[selectedContact.firstName, selectedContact.lastName].filter(Boolean).join(' ')}${selectedContact.role ? ' (' + selectedContact.role + ')' : ''}, e-mail: ${selectedContact.address}`
        : null
      const selectedArgsLine = selectedArgumentIds?.length
        ? `Použij výhradně tyto prodejní argumenty (podle argumentId): ${selectedArgumentIds.join(', ')}.`
        : null

      const userMessage = [
        'Vytvoř personalizovaný cold e-mail pro tohoto partnera dle systémového promptu.',
        contactLine,
        fontFamily ? `Font pro HTML formátování: ${fontFamily}` : null,
        selectedArgsLine,
      ].filter(Boolean).join('\n')

      return textResult({
        systemPrompt,
        userMessage,
        outputSchema,
        usedSystemPromptId: customPrompt?.id ?? dbSystemPrompt?.id ?? null,
        nextStep: 'Vygeneruj JSON výstup dle outputSchema (to/subject/body/recommendations) a ulož ho nástrojem save_outreach_draft (projectId, globalRecordId, toAddress, subject, body, recommendations, ...).',
      })
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

  server.registerTool(
    'save_value_alignment',
    {
      title: 'Uložit výsledek Value Alignment',
      description: 'Uloží strukturovaný výstup VALUE_ALIGNMENT (outputData — JSON, který jsi sám vygeneroval podle promptu z get_value_alignment_prompt) do PartnerAlignment (přepíše předchozí). Server sám žádnou AI nespouští — tento nástroj jen persistuje výsledek, který si agent vypočítal lokálně. Vyžaduje přiřazení k oslovení tohoto partnera (nebo admin/Vedení obchodu).',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
        outputData: z.record(z.string(), z.any()).describe('Strukturovaný JSON výstup odpovídající outputSchema z get_value_alignment_prompt.'),
        systemPromptId: z.string().optional().describe('id promptu použitého při generování (pro dohledatelnost), pokud jiné než výchozí.'),
        contextPartIds: z.array(z.string()).optional(),
        sellingPointId: z.string().optional(),
      },
    },
    async ({ projectId, globalRecordId, outputData, systemPromptId, contextPartIds, sellingPointId }) => {
      await assertProjectAccess(ctx, projectId)
      try {
        await assertOutreachAssignee(ctx, projectId, globalRecordId)
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e))
      }

      const globalRecord = await prisma.globalRecord.findUnique({ where: { id: globalRecordId }, select: { payload: true } })
      if (!globalRecord) return errorResult('Partner nenalezen.')

      const saved = await prisma.partnerAlignment.upsert({
        where: { projectId_globalRecordId: { projectId, globalRecordId } },
        create: {
          projectId, globalRecordId, outputData: outputData as never,
          systemPromptId: systemPromptId ?? null, contextPartIds: contextPartIds ?? [], sellingPointId: sellingPointId ?? null,
          profileSnapshot: globalRecord.payload as never, authorId: ctx.userId,
        },
        update: {
          outputData: outputData as never,
          systemPromptId: systemPromptId ?? null, contextPartIds: contextPartIds ?? [], sellingPointId: sellingPointId ?? null,
          profileSnapshot: globalRecord.payload as never, authorId: ctx.userId,
        },
      })

      await logEvent({ globalRecordId, userId: ctx.userId, eventType: 'MCP_ALIGNMENT_SAVED', metadata: { projectId, alignmentId: saved.id, source: 'mcp' } })
      return textResult({ alignmentId: saved.id, outputData: saved.outputData })
    },
  )

  server.registerTool(
    'save_outreach_draft',
    {
      title: 'Uložit e-mailový draft',
      description: 'Uloží nebo přepíše obsah PartnerOutreachDraft — ať už jde o výsledek OUTREACH_PREPARATION vygenerovaný sám agentem podle promptu z get_outreach_draft_prompt, nebo o ruční textovou úpravu. Server sám žádnou AI nespouští.',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
        toAddress: z.string(),
        subject: z.string(),
        body: z.string(),
        recommendations: z.array(z.string()).optional(),
        systemPromptId: z.string().optional().describe('id promptu použitého při generování (pro dohledatelnost), pokud jiné než výchozí.'),
        emailDraftId: z.string().optional().describe('id e-mailové šablony (z list_library) použité jako předloha, pokud nějaká.'),
        config: z.record(z.string(), z.any()).optional(),
      },
    },
    async ({ projectId, globalRecordId, toAddress, subject, body, recommendations, systemPromptId, emailDraftId, config }) => {
      await assertProjectAccess(ctx, projectId)
      if (!body.trim()) return errorResult('Tělo e-mailu je povinné.')

      const draft = await prisma.partnerOutreachDraft.upsert({
        where: { projectId_globalRecordId: { projectId, globalRecordId } },
        create: {
          projectId, globalRecordId, toAddress, subject, body,
          recommendations: recommendations ?? [], systemPromptId: systemPromptId ?? null, emailDraftId: emailDraftId ?? null,
          config: (config ?? null) as never, savedById: ctx.userId,
        },
        update: {
          toAddress, subject, body,
          recommendations: recommendations ?? [], systemPromptId: systemPromptId ?? null, emailDraftId: emailDraftId ?? null,
          config: (config ?? null) as never, savedById: ctx.userId, savedAt: new Date(),
        },
      })

      await logEvent({ globalRecordId, userId: ctx.userId, eventType: 'MCP_DRAFT_SAVED', metadata: { projectId, draftId: draft.id, source: 'mcp' } })
      return textResult({ id: draft.id, toAddress: draft.toAddress, subject: draft.subject, body: draft.body, recommendations: draft.recommendations })
    },
  )

  server.registerTool(
    'send_outreach_email',
    {
      title: 'Odeslat / naplánovat e-mail',
      description: 'Bez scheduledFor: e-mail se ihned a synchronně odešle přes Gmail (žádná 20s undo grace perioda jako v UI — výsledek nástroje už je definitivní odpověď, jestli odeslání proběhlo). Se scheduledFor (budoucí ISO datum): vytvoří ScheduledEmail, který odešle nezávislý poller v naplánovaný čas — dá se zrušit přes cancel_scheduled_email. Volitelný signatureId (z list_library) připojí podpis pod tělo e-mailu. Pokud draft pro tohoto partnera připravil jiný uživatel, vyžaduje oprávnění project.pipeline.manage (nebo admina).',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
        toAddress: z.string(),
        subject: z.string(),
        body: z.string(),
        signatureId: z.string().optional(),
        scheduledFor: z.string().datetime().optional().describe('ISO datum v budoucnosti — pokud zadáno, e-mail se naplánuje místo okamžitého odeslání.'),
      },
    },
    async ({ projectId, globalRecordId, toAddress, subject, body, signatureId, scheduledFor }) => {
      await assertProjectAccess(ctx, projectId)
      if (!toAddress || !subject || !body) return errorResult('toAddress, subject a body jsou povinné.')

      const existingDraft = await prisma.partnerOutreachDraft.findUnique({
        where: { projectId_globalRecordId: { projectId, globalRecordId } },
        select: { savedById: true },
      })
      if (existingDraft && existingDraft.savedById !== ctx.userId && !ctx.isAdmin) {
        const perms = await getProjectPermissions(ctx.userId, projectId)
        if (!perms.includes('project.pipeline.manage')) {
          return errorResult('Nemáte oprávnění odeslat e-mail připravený jiným uživatelem.')
        }
      }

      await prisma.partnerOutreachDraft.upsert({
        where: { projectId_globalRecordId: { projectId, globalRecordId } },
        create: { projectId, globalRecordId, toAddress, subject, body, savedById: ctx.userId },
        update: { toAddress, subject, body },
      })

      let signatureContent: string | null = null
      if (signatureId) {
        const signature = await prisma.signature.findUnique({ where: { id: signatureId }, select: { content: true } })
        if (!signature) return errorResult('Podpis nenalezen.')
        signatureContent = signature.content
      }
      const fullBody = signatureContent ? body + '<br><br>' + signatureContent : body

      if (scheduledFor) {
        const scheduledDate = new Date(scheduledFor)
        if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
          return errorResult('Naplánovaný čas musí být v budoucnosti.')
        }

        const scheduledEmail = await prisma.scheduledEmail.create({
          data: { projectId, globalRecordId, toAddress, subject, body: fullBody, scheduledFor: scheduledDate, createdById: ctx.userId },
        })

        await logEvent({ globalRecordId, userId: ctx.userId, eventType: 'MCP_EMAIL_SCHEDULED', metadata: { projectId, scheduledEmailId: scheduledEmail.id, scheduledFor, source: 'mcp' } })
        return textResult({ scheduled: true, scheduledEmail })
      }

      const dbUser = await prisma.user.findUnique({ where: { id: ctx.userId } })
      if (!dbUser?.accessToken) return errorResult('Uživatel nemá připojený Gmail účet.')

      let accessToken = dbUser.accessToken
      if (dbUser.refreshToken && (!dbUser.tokenExpiry || dbUser.tokenExpiry < new Date())) {
        const config = useRuntimeConfig()
        const refreshed = await refreshAccessToken(dbUser.refreshToken, config.googleClientId, config.googleClientSecret)
        accessToken = refreshed.access_token
        await prisma.user.update({
          where: { id: ctx.userId },
          data: { accessToken: refreshed.access_token, tokenExpiry: new Date(Date.now() + refreshed.expires_in * 1000) },
        })
      }

      let result: { id: string; threadId: string }
      try {
        result = await sendGmailMessage(accessToken, toAddress, subject, fullBody)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await prisma.partnerOutreachDraft.update({
          where: { projectId_globalRecordId: { projectId, globalRecordId } },
          data: { sendError: message },
        }).catch(() => {})
        return errorResult(`Odeslání selhalo: ${message}`)
      }

      await trackCustomRecipientAddress(projectId, globalRecordId, toAddress)
      const negotiation = await assignNegotiationOnSend(projectId, globalRecordId, ctx.userId)

      await prisma.email.create({
        data: {
          negotiationId: negotiation.id, direction: 'SENT', subject, sentAt: new Date(),
          fromAddress: dbUser.email, toAddress, gmailId: result.id, content: fullBody,
          createdBy: ctx.userId, isRead: true,
        },
      }).catch(err => console.error('[mcp send_outreach_email] failed to create email:', err))

      await prisma.partnerOutreachDraft.update({
        where: { projectId_globalRecordId: { projectId, globalRecordId } },
        data: { sentAt: new Date(), sentById: ctx.userId, gmailId: result.id, sendError: null },
      }).catch(() => {})

      await logEvent({ globalRecordId, userId: ctx.userId, eventType: 'MCP_EMAIL_SENT', metadata: { projectId, gmailId: result.id, source: 'mcp' } })
      return textResult({ scheduled: false, sent: true, gmailId: result.id, threadId: result.threadId })
    },
  )

  server.registerTool(
    'cancel_scheduled_email',
    {
      title: 'Zrušit naplánovaný e-mail',
      description: 'Zruší čekající naplánovaný e-mail (ScheduledEmail ve stavu PENDING nebo FAILED) vytvořený přes send_outreach_email se scheduledFor.',
      inputSchema: {
        projectId: z.string(),
        globalRecordId: z.string(),
        scheduledId: z.string(),
      },
    },
    async ({ projectId, globalRecordId, scheduledId }) => {
      const canEdit = await canEditNegotiation(ctx.userId, projectId, globalRecordId)
      if (!canEdit) return errorResult('Nemáte oprávnění k tomuto naplánovanému e-mailu.')

      const cancelled = await prisma.scheduledEmail.updateMany({
        where: { id: scheduledId, projectId, globalRecordId, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'CANCELLED' },
      })
      if (cancelled.count === 0) return errorResult('Tento e-mail už není možné zrušit — právě se odesílá, už byl odeslán, nebo neexistuje.')

      await logEvent({ globalRecordId, userId: ctx.userId, eventType: 'MCP_SCHEDULED_EMAIL_CANCELLED', metadata: { projectId, scheduledId, source: 'mcp' } })
      return textResult({ cancelled: true })
    },
  )
}
