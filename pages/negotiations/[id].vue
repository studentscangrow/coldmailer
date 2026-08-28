<script setup lang="ts">
import { normalizeChecklist, normalizeTodo, toggleChecklistLine } from '~/utils/checklist'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const id = route.params.id as string

// ── Types ─────────────────────────────────────────────────────────────────────

interface Contact { id: string; address: string | null; label: string | null; firstName: string | null; lastName: string | null; role: string | null; contactType: string | null; priority: number; note: string | null }
interface AssigneeUser { id: string; name: string; image: string | null }
interface InteractionAssignee { userId: string; user: AssigneeUser }
interface EmailItem {
  type: 'EMAIL'
  id: string
  content: string | null
  createdAt: string
  updatedAt: string
  creator: AssigneeUser
  assignees: InteractionAssignee[]
  direction: 'SENT' | 'RECEIVED'
  subject: string | null
  sentAt: string | null
  fromAddress: string | null
  toAddress: string | null
  ccAddress: string | null
  bccAddress: string | null
  gmailId: string | null
  threadId: string | null
  canEdit: boolean
  isUnknownContact: boolean
  unknownContactAddress: string | null
  isRead: boolean
  isCalendarBooking: boolean
}
interface NoteItem {
  type: 'NOTE'
  id: string
  content: string | null
  createdAt: string
  updatedAt: string
  creator: AssigneeUser
  assignees: InteractionAssignee[]
  canEdit: boolean
}
type Interaction = EmailItem | NoteItem
interface CrossProjectMeta {
  projectId: string
  projectName: string
  interactionCount: number
  lastActivityAt: string | null
  assigneeNames: string[]
}
interface TimelineResponse {
  items: Interaction[]
  fulfillment: { myToThem: string | null; themToUs: string | null }
  todoList: string | null
  crossProjectSummary: CrossProjectMeta[]
  access: { canViewAll: boolean; canEditAll: boolean; canEdit: boolean; canManageAssignees: boolean }
}
interface Partner {
  id: string; canonicalName: string; payload: Record<string, string>
  contacts: Contact[]
  assignees: AssigneeUser[]
  negotiationStatus: 'CONTACTED' | 'REMINDED' | 'WAITING_FOR_THEM' | 'WAITING_FOR_US' | 'PRED_SCHUZKOU' | 'FULFILLING' | 'THANKS_REMAINING' | 'COMPLETED' | 'NOT_INTERESTED' | 'NOT_THIS_TIME' | null
}
interface AppUser { id: string; name: string; image: string | null; email: string }

// ── Data ─────────────────────────────────────────────────────────────────────

const { data: partner, refresh: refreshPartner } = await useFetch<Partner>(`/api/partners/${id}`)
const { data: interactionsData, refresh: refreshInteractions } = await useFetch<TimelineResponse>(`/api/partners/${id}/timeline`)
const { data: blacklistData, refresh: refreshBlacklist } = await useFetch<{
  blacklist: string[]
  emailDisplayMode: string
  domains: string[]
  additionalAddresses: string[]
  autoIncludeDomain: boolean
  detectedDomain: string | null
  domainOverride: string | null
  domainIsManual: boolean
}>(`/api/partners/${id}/blacklist`)
const { data: allUsers } = await useFetch<AppUser[]>('/api/users')
const { user: me } = useUserSession()

const canEdit = computed(() => interactionsData.value?.access.canEdit ?? false)
const canManageAssignees = computed(() => interactionsData.value?.access.canManageAssignees ?? false)

interface ScheduledEmailItem {
  id: string
  toAddress: string
  cc: string | null
  bcc: string | null
  subject: string
  body: string
  scheduledFor: string | null
  status: 'PENDING' | 'SENDING' | 'FAILED'
  errorMessage: string | null
  createdBy: AppUser
  source?: 'app' | 'gmail'
}
const { data: scheduledEmails, refresh: refreshScheduledEmails } = await useFetch<ScheduledEmailItem[]>(`/api/partners/${id}/scheduled-emails`)

async function refresh() {
  await Promise.all([refreshPartner(), refreshInteractions(), refreshBlacklist(), refreshScheduledEmails()])
}

const toast = useToast()

// ── Live sync ─────────────────────────────────────────────────────────────────
// Poll the timeline and negotiation status so changes made by other users while
// this page is open show up without a manual refresh. Optimistic local mutations
// (toggleCheckItem, toggleTodoLine, toggleEvent) bump mutationInFlight around
// their request so an in-flight poll never overwrites interactionsData with
// stale pre-mutation data — the result is simply dropped and picked up by the
// next tick instead. Status/assignees have no local optimistic mutation to race
// (updateStatus always waits for the request then re-fetches), so that half of
// the poll isn't gated on mutationInFlight.
const mutationInFlight = ref(0)
let interactionsSyncInterval: ReturnType<typeof setInterval> | undefined

async function pollInteractions() {
  if (document.hidden) return
  const partnerPromise = $fetch<Partner>(`/api/partners/${id}`).catch(() => null)
  if (mutationInFlight.value === 0) {
    const fresh = await $fetch<TimelineResponse>(`/api/partners/${id}/timeline`).catch(() => null)
    if (fresh && mutationInFlight.value === 0) interactionsData.value = fresh
  }
  const freshPartner = await partnerPromise
  if (freshPartner) partner.value = freshPartner
}

onMounted(() => {
  interactionsSyncInterval = setInterval(pollInteractions, 10_000)
})
onUnmounted(() => {
  if (interactionsSyncInterval) clearInterval(interactionsSyncInterval)
})

// ── UI state ──────────────────────────────────────────────────────────────────

const showProfileModal = ref(false)
const showEditModal = ref(false)
const expandedEvents = ref(new Set<string>())
const showCrossProject = ref(false)

// ── Computed ─────────────────────────────────────────────────────────────────

const interactions = computed(() => interactionsData.value?.items ?? [])
const crossProjectSummary = computed(() => interactionsData.value?.crossProjectSummary ?? [])
const firstContact = computed(() => partner.value?.contacts[0] ?? null)
const hasSentEmail = computed(() => interactions.value.some(i => i.type === 'EMAIL' && i.direction === 'SENT'))
const emailCount = computed(() => interactions.value.filter(i => i.type === 'EMAIL').length)

// ── Unknown contacts ─────────────────────────────────────────────────────────

const unknownContacts = computed(() => {
  const byEmail = new Map<string, EmailItem[]>()
  for (const i of interactions.value) {
    if (i.type === 'EMAIL' && i.isUnknownContact && i.unknownContactAddress) {
      const list = byEmail.get(i.unknownContactAddress) ?? []
      list.push(i)
      byEmail.set(i.unknownContactAddress, list)
    }
  }
  return byEmail
})

// Contacts offered in the "New Email" composer: saved contacts + whitelisted additional
// addresses + manually-used addresses from Oslovování/interactions that aren't saved as a
// contact yet — minus anything explicitly blacklisted for this partner.
const composerContacts = computed(() => {
  const known = (partner.value?.contacts ?? []).filter((c): c is Contact & { address: string } => !!c.address)
  const knownAddresses = new Set(known.map(c => c.address))
  const blacklisted = new Set(blacklist.value)
  const extraAddresses = new Set([
    ...additionalAddresses.value,
    ...unknownContacts.value.keys(),
  ])
  const extra = [...extraAddresses]
    .filter(address => !knownAddresses.has(address) && !blacklisted.has(address))
    .map(address => ({ id: `extra-${address}`, address, firstName: null, lastName: null }))
  return [...known.filter(c => !blacklisted.has(c.address)), ...extra]
})

// ── Blacklist / additional addresses (managed by ContactManagementPanel) ────

const blacklist = computed(() => blacklistData.value?.blacklist ?? [])
const additionalAddresses = computed(() => blacklistData.value?.additionalAddresses ?? [])
const autoIncludeDomain = computed(() => blacklistData.value?.autoIncludeDomain ?? false)
const detectedDomain = computed(() => blacklistData.value?.detectedDomain ?? null)
const domainOverride = computed(() => blacklistData.value?.domainOverride ?? null)
const domainIsManual = computed(() => blacklistData.value?.domainIsManual ?? false)

// ── Email display mode ───────────────────────────────────────────────────────

const emailDisplayMode = computed(() => blacklistData.value?.emailDisplayMode ?? 'text')

async function toggleEmailDisplayMode() {
  const newMode = emailDisplayMode.value === 'text' ? 'html' : 'text'
  await $fetch(`/api/partners/${id}/settings`, {
    method: 'PATCH',
    body: { emailDisplayMode: newMode },
  })
  await refreshBlacklist()
}

// ── Filter ───────────────────────────────────────────────────────────────────

type TypeFilter = 'NOTE' | 'EMAIL' | 'FULFILLMENT' | 'TODO'
const typeFilter = ref<TypeFilter>('EMAIL')

const filteredInteractions = computed(() => {
  if (typeFilter.value === 'NOTE') {
    return interactions.value.filter(i => i.type === 'NOTE')
  }
  if (typeFilter.value === 'EMAIL') {
    return interactions.value.filter(i => i.type === 'EMAIL' && !i.isUnknownContact)
  }
  // FULFILLMENT a TODO mají vlastní obsah (checklisty), ne seznam interakcí.
  return []
})

const emailInteractions = computed<EmailItem[]>(() => filteredInteractions.value.filter((i): i is EmailItem => i.type === 'EMAIL'))
const noteInteractions = computed<NoteItem[]>(() => filteredInteractions.value.filter((i): i is NoteItem => i.type === 'NOTE'))

const fulfillment = computed(() => interactionsData.value?.fulfillment ?? { myToThem: null, themToUs: null })

// ── Interaction CRUD ─────────────────────────────────────────────────────────

type NewInteractionMode = null | 'NOTE'
const newMode = ref<NewInteractionMode>(null)

const editingId = ref<string | null>(null)
const editingContent = ref('')

function startEdit(i: NoteItem) {
  editingId.value = i.id
  editingContent.value = i.content ?? ''
}

async function saveEdit() {
  if (!editingId.value) return
  await $fetch(`/api/partners/${id}/notes/${editingId.value}`, {
    method: 'PATCH',
    body: { content: editingContent.value.trim() || null },
  })
  editingId.value = null
  toast.show('Poznámka uložena', 'success')
  await refreshInteractions()
}

// ── Fulfillment inline editing ───────────────────────────────────────────────

const fulfillmentEditingField = ref<{ field: 'myToThem' | 'themToUs'; value: string } | null>(null)

function startFulfillmentEdit(field: 'myToThem' | 'themToUs') {
  fulfillmentEditingField.value = { field, value: fulfillment.value[field] ?? '' }
}

async function saveFulfillmentField() {
  if (!fulfillmentEditingField.value) return
  const { field, value } = fulfillmentEditingField.value
  fulfillmentEditingField.value = null
  // Normalize to checklist format before saving
  const normalized = value.trim() ? normalizeChecklist(value) : null
  await $fetch(`/api/partners/${id}/negotiation/fulfillment`, {
    method: 'PATCH',
    body: { [field]: normalized },
  })
  toast.show('Obsah plnění uložen', 'success')
  await refreshInteractions()
}

const togglingItem = ref<{ field: string; lineIndex: number } | null>(null)

async function toggleCheckItem(field: 'myToThem' | 'themToUs', lineIndex: number) {
  togglingItem.value = { field, lineIndex }
  mutationInFlight.value++
  try {
    const result = await $fetch<{ id: string; myToThem: string | null; themToUs: string | null }>(
      `/api/partners/${id}/negotiation/fulfillment/toggle-check`,
      { method: 'PATCH', body: { field, lineIndex } }
    )
    // Optimistic update without full refresh
    if (interactionsData.value && result) {
      interactionsData.value.fulfillment = { myToThem: result.myToThem, themToUs: result.themToUs }
    }
  } catch {
    await refreshInteractions()
  } finally {
    togglingItem.value = null
    mutationInFlight.value--
  }
}

// ── To-Do list ────────────────────────────────────────────────────────────────

const todoContent = computed(() => interactionsData.value?.todoList ?? null)
const todoEditing = ref(false)
const todoEditingValue = ref('')
const togglingTodoLine = ref<number | null>(null)

function startTodoEdit() {
  todoEditingValue.value = todoContent.value ?? ''
  todoEditing.value = true
}

async function saveTodo() {
  if (!todoEditing.value) return
  todoEditing.value = false
  const normalized = todoEditingValue.value.trim() ? normalizeTodo(todoEditingValue.value) : null
  await $fetch(`/api/partners/${id}/negotiation/todo`, {
    method: 'PATCH',
    body: { todoList: normalized },
  })
  toast.show('To-Do uloženo', 'success')
  await refreshInteractions()
}

async function toggleTodoLine(lineIndex: number) {
  const current = todoContent.value ?? ''
  const next = toggleChecklistLine(current, lineIndex)
  togglingTodoLine.value = lineIndex
  mutationInFlight.value++
  // Optimistický update
  if (interactionsData.value) interactionsData.value.todoList = next
  try {
    await $fetch(`/api/partners/${id}/negotiation/todo`, {
      method: 'PATCH',
      body: { todoList: next },
    })
  } catch {
    await refreshInteractions()
  } finally {
    togglingTodoLine.value = null
    mutationInFlight.value--
  }
}

async function deleteInteraction(i: Interaction) {
  if (!confirm('Opravdu chcete smazat tuto položku? Tato akce je nevratná.')) return
  const path = i.type === 'EMAIL' ? 'emails' : 'notes'
  await $fetch(`/api/partners/${id}/${path}/${i.id}`, { method: 'DELETE' })
  toast.show('Položka smazána', 'success')
  await refresh()
}

async function toggleEvent(i: Interaction) {
  if (i.type !== 'EMAIL') return
  const s = new Set(expandedEvents.value)
  const opening = !s.has(i.id)
  opening ? s.add(i.id) : s.delete(i.id)
  expandedEvents.value = s

  // Přečtení = rozbalení. Server rozhoduje, jestli čtení počítá (kontrola bez přiřazení
  // nezapočítává, ale přiřazený oslovovatel/řešitel ano, i když je zároveň Vedení obchodu/admin).
  if (opening && !i.isRead) {
    mutationInFlight.value++
    try {
      const res = await $fetch<{ isRead: boolean }>(`/api/partners/${id}/emails/${i.id}/read`, { method: 'PATCH' })
      // Look up the live item rather than mutate the closed-over `i` — a
      // concurrent poll may have already replaced interactionsData.value.items.
      const target = interactionsData.value?.items.find(x => x.id === i.id)
      if (target && target.type === 'EMAIL') target.isRead = res.isRead
    } catch {
      // ponecháme beze změny
    } finally {
      mutationInFlight.value--
    }
  }
}

// ── Email composer ────────────────────────────────────────────────────────────

const composerOpen = ref(false)
const composerPrefilledTo = ref('')
const composerPrefilledCc = ref('')
const composerPrefilledSubject = ref('')
const composerReplyToGmailId = ref<string | null>(null)
const composerReplyContext = ref<{ content: string; sentAt: string; fromAddress: string } | null>(null)
const composerEditScheduled = ref<(ScheduledEmailItem & { scheduledFor: string }) | null>(null)
const composerAiBodyPrefix = ref('')
const composerRecommendations = ref<string[]>([])

function openNewEmail() {
  composerPrefilledTo.value = firstContact.value?.address ?? ''
  composerPrefilledCc.value = ''
  composerPrefilledSubject.value = ''
  composerReplyToGmailId.value = null
  composerReplyContext.value = null
  composerEditScheduled.value = null
  composerAiBodyPrefix.value = ''
  composerRecommendations.value = []
  composerOpen.value = true
}

function extractEmails(raw: string | null | undefined): string[] {
  if (!raw) return []
  return (raw.match(/[^\s<>,]+@[^\s<>,]+/g) ?? []).map(a => a.toLowerCase())
}

function openReply(i: EmailItem, replyAll = false) {
  const primary = i.direction === 'RECEIVED' ? (i.fromAddress ?? '') : (i.toAddress ?? '')
  composerPrefilledTo.value = primary

  if (replyAll) {
    const selfEmail = me.value?.email?.toLowerCase()
    const primaryEmails = extractEmails(primary)
    const others = i.direction === 'RECEIVED' ? extractEmails(i.toAddress) : extractEmails(i.fromAddress)
    const ccEmails = [...new Set([...others, ...extractEmails(i.ccAddress)])]
      .filter(a => a !== selfEmail && !primaryEmails.includes(a))
    composerPrefilledCc.value = ccEmails.join(', ')
  } else {
    composerPrefilledCc.value = ''
  }

  const subj = i.subject ?? ''
  composerPrefilledSubject.value = /^re:/i.test(subj) ? subj : `Re: ${subj}`
  composerReplyToGmailId.value = i.gmailId
  composerReplyContext.value = i.content
    ? { content: i.content, sentAt: i.sentAt ?? i.createdAt, fromAddress: i.fromAddress ?? '' }
    : null
  composerEditScheduled.value = null
  composerAiBodyPrefix.value = ''
  composerRecommendations.value = []
  composerOpen.value = true
}

// ── Reminder (AI follow-up) ─────────────────────────────────────────────────
interface ReminderTemplate { id: string; name: string }
const { data: reminderTemplates } = await useFetch<ReminderTemplate[]>('/api/library/email-drafts', {
  query: { usage: 'REMINDER' },
})

const lastActivityAt = computed<string | null>(() => {
  let latest: number | null = null
  for (const i of interactions.value) {
    const d = i.type === 'EMAIL' ? (i.sentAt ?? i.createdAt) : i.updatedAt
    const t = new Date(d).getTime()
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t
  }
  return latest === null ? null : new Date(latest).toISOString()
})

const reminderGenerating = ref(false)

async function onRemind(emailDraftId: string | null) {
  reminderGenerating.value = true
  try {
    const res = await $fetch<{
      recipients: string[]
      body: string
      recommendations: string[]
      previousEmail: { gmailId: string; subject: string; content: string; sentAt: string | null; fromAddress: string }
    }>(`/api/partners/${id}/reminder-draft`, {
      method: 'POST',
      body: { emailDraftId: emailDraftId ?? undefined },
    })

    const prev = res.previousEmail
    composerPrefilledTo.value = res.recipients.join(', ')
    composerPrefilledCc.value = ''
    composerPrefilledSubject.value = /^re:/i.test(prev.subject) ? prev.subject : `Re: ${prev.subject}`
    composerReplyToGmailId.value = prev.gmailId
    composerReplyContext.value = prev.content
      ? { content: prev.content, sentAt: prev.sentAt ?? new Date().toISOString(), fromAddress: prev.fromAddress }
      : null
    composerEditScheduled.value = null
    composerAiBodyPrefix.value = res.body
    composerRecommendations.value = res.recommendations
    composerOpen.value = true
  } catch (err) {
    toast.show(err instanceof Error ? err.message : 'Vygenerování připomínky selhalo', 'error')
  } finally {
    reminderGenerating.value = false
  }
}

function editScheduledEmail(se: ScheduledEmailItem) {
  const scheduledFor = se.scheduledFor
  if (!scheduledFor) return
  composerEditScheduled.value = { ...se, scheduledFor }
  composerOpen.value = true
}

const scheduledActionLoading = ref<string | null>(null)
const returningToOutreach = ref(false)

async function returnToOutreach() {
  returningToOutreach.value = true
  try {
    const res = await $fetch<{ success: boolean; projectId: string }>(`/api/partners/${id}/return-to-outreach`, { method: 'POST' })
    await navigateTo(`/outreach/${res.projectId}`)
  } catch (err) {
    toast.show(err instanceof Error ? err.message : 'Vrácení k oslovení selhalo', 'error')
  } finally {
    returningToOutreach.value = false
  }
}

async function sendScheduledNow(se: ScheduledEmailItem) {
  if (!confirm(`Odeslat tento e-mail hned partnerovi na ${se.toAddress}?`)) return
  scheduledActionLoading.value = se.id
  try {
    await $fetch(`/api/partners/${id}/scheduled-emails/${se.id}/send-now`, { method: 'POST' })
    toast.show('E-mail odeslán', 'success')
    await refresh()
  } catch (err) {
    toast.show(err instanceof Error ? err.message : 'Odeslání selhalo', 'error')
  } finally {
    scheduledActionLoading.value = null
  }
}

async function cancelScheduledEmail(se: ScheduledEmailItem) {
  if (!confirm('Opravdu zrušit toto naplánované odeslání?')) return
  scheduledActionLoading.value = se.id
  try {
    await $fetch(`/api/partners/${id}/scheduled-emails/${se.id}`, { method: 'DELETE' })
    toast.show('Naplánované odeslání zrušeno', 'success')
    await refreshScheduledEmails()
  } catch (err) {
    toast.show(err instanceof Error ? err.message : 'Zrušení selhalo', 'error')
  } finally {
    scheduledActionLoading.value = null
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDateShort(d: string) {
  return new Date(d).toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

const TYPE_LABELS: Record<string, string> = {
  NOTE: 'Poznámky',
  EMAIL: 'Email',
  FULFILLMENT: 'Obsah plnění',
  TODO: 'To-Do',
}
</script>

<template>
  <div v-if="partner">
    <NegotiationsPartnerHeader
      :global-record-id="id"
      :partner="partner"
      :can-edit="canEdit"
      :can-manage-assignees="canManageAssignees"
      :all-users="allUsers ?? []"
      @synced="refreshInteractions(); refreshPartner()"
      @partner-changed="refreshPartner()"
      @open-profile="showProfileModal = true"
      @open-edit="showEditModal = true"
    />

    <!-- ── Last activity + reminder ── -->
    <NegotiationsReminderBox
      :negotiation-status="partner.negotiationStatus"
      :last-activity-at="lastActivityAt"
      :reminder-templates="reminderTemplates ?? []"
      :can-edit="canEdit"
      :generating="reminderGenerating"
      :email-count="emailCount"
      @remind="onRemind"
    />

    <!-- ── Toolbar ── -->
    <div class="flex items-center justify-between gap-4 mb-6">
      <div class="flex gap-1">
        <button
          v-for="f in (['EMAIL', 'NOTE', 'FULFILLMENT', 'TODO'] as TypeFilter[])"
          :key="f"
          :class="['px-3 py-1.5 text-xs font-medium rounded-lg transition-colors', typeFilter === f ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500 hover:bg-gray-100']"
          @click="typeFilter = f"
        >{{ TYPE_LABELS[f] }}</button>
      </div>

      <div class="flex items-center gap-2 ml-auto">
        <button
          v-if="typeFilter === 'NOTE' && canEdit"
          class="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors"
          @click="newMode = newMode === 'NOTE' ? null : 'NOTE'"
        >{{ newMode === 'NOTE' ? 'Zrušit' : '+ Poznámka' }}</button>

        <button
          v-if="typeFilter === 'EMAIL' && canEdit"
          class="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          @click="openNewEmail"
        >+ Nový e-mail</button>

        <div v-if="typeFilter === 'EMAIL'" class="flex items-center border border-gray-200 rounded-lg overflow-hidden">
        <button
          :class="['px-2.5 py-1 text-xs font-medium transition-colors flex items-center gap-1', emailDisplayMode === 'text' ? 'bg-gray-100 text-gray-700' : 'text-gray-400 hover:text-gray-600']"
          title="Textový režim"
          @click="emailDisplayMode !== 'text' && toggleEmailDisplayMode()"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h10" /></svg>
          Text
        </button>
        <button
          :class="['px-2.5 py-1 text-xs font-medium transition-colors flex items-center gap-1 border-l border-gray-200', emailDisplayMode === 'html' ? 'bg-gray-100 text-gray-700' : 'text-gray-400 hover:text-gray-600']"
          title="HTML náhled"
          @click="emailDisplayMode !== 'html' && toggleEmailDisplayMode()"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
          HTML
        </button>
      </div>
      </div>
    </div>

    <!-- ── Scheduled emails (not yet sent) ── -->
    <div v-if="scheduledEmails?.length" class="mb-6 space-y-2">
      <NegotiationsScheduledEmailsPanel
        :scheduled-emails="scheduledEmails"
        :can-edit="canEdit"
        :action-loading="scheduledActionLoading"
        @edit="editScheduledEmail"
        @send-now="sendScheduledNow"
        @cancel="cancelScheduledEmail"
      />
    </div>

    <!-- ── Unknown Contact Warnings ── -->
    <div v-if="unknownContacts.size > 0" class="mb-6 space-y-3">
      <NegotiationsUnknownContactsPanel
        :global-record-id="id"
        :unknown-contacts="unknownContacts"
        @changed="refresh()"
      />
    </div>

    <!-- ── New Interaction Forms ── -->
    <NegotiationsNewInteractionForms
      :global-record-id="id"
      :mode="newMode"
      @cancel="newMode = null"
      @created="newMode = null; refresh()"
    />

    <!-- ── Fulfillment checklist (jedna na jednání, mimo seznam interakcí) ── -->
    <div v-if="typeFilter === 'FULFILLMENT'" class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
      <NegotiationsFulfillmentChecklist
        title="My jim"
        theme="blue"
        :content="fulfillment.myToThem"
        :can-edit="canEdit"
        :editing="fulfillmentEditingField?.field === 'myToThem'"
        :editing-value="fulfillmentEditingField?.field === 'myToThem' ? fulfillmentEditingField.value : ''"
        :toggling-line-index="togglingItem?.field === 'myToThem' ? togglingItem.lineIndex : null"
        @start-edit="startFulfillmentEdit('myToThem')"
        @update:editing-value="v => { if (fulfillmentEditingField) fulfillmentEditingField.value = v }"
        @save="saveFulfillmentField"
        @cancel-edit="fulfillmentEditingField = null"
        @toggle-line="i => toggleCheckItem('myToThem', i)"
      />
      <NegotiationsFulfillmentChecklist
        title="Oni nám"
        theme="green"
        :content="fulfillment.themToUs"
        :can-edit="canEdit"
        :editing="fulfillmentEditingField?.field === 'themToUs'"
        :editing-value="fulfillmentEditingField?.field === 'themToUs' ? fulfillmentEditingField.value : ''"
        :toggling-line-index="togglingItem?.field === 'themToUs' ? togglingItem.lineIndex : null"
        @start-edit="startFulfillmentEdit('themToUs')"
        @update:editing-value="v => { if (fulfillmentEditingField) fulfillmentEditingField.value = v }"
        @save="saveFulfillmentField"
        @cancel-edit="fulfillmentEditingField = null"
        @toggle-line="i => toggleCheckItem('themToUs', i)"
      />
    </div>

    <!-- ── To-Do list (jeden na jednání, mimo seznam interakcí) ── -->
    <div v-if="typeFilter === 'TODO'" class="mb-6">
      <NegotiationsTodoChecklist
        :content="todoContent"
        :can-edit="canEdit"
        :editing="todoEditing"
        :editing-value="todoEditingValue"
        :toggling-line-index="togglingTodoLine"
        @start-edit="startTodoEdit"
        @update:editing-value="v => todoEditingValue = v"
        @save="saveTodo"
        @cancel-edit="todoEditing = false"
        @toggle-line="toggleTodoLine"
      />
    </div>

    <!-- ── Interaction List ── -->
    <div class="space-y-3">
      <template v-if="typeFilter === 'EMAIL'">
        <NegotiationsEmailThreadList
          :emails="emailInteractions"
          :expanded-events="expandedEvents"
          :email-display-mode="emailDisplayMode"
          :can-edit="canEdit"
          :returning-to-outreach="returningToOutreach"
          @toggle="toggleEvent"
          @reply="openReply($event)"
          @reply-all="openReply($event, true)"
          @delete="deleteInteraction"
          @return-to-outreach="returnToOutreach"
        />
      </template>

      <!-- Notes -->
      <template v-else-if="typeFilter === 'NOTE'">
        <NegotiationsNoteList
          :notes="noteInteractions"
          :show-type-badge="false"
          :editing-id="editingId"
          :editing-content="editingContent"
          @start-edit="startEdit"
          @update:editing-content="editingContent = $event"
          @save="saveEdit"
          @cancel="editingId = null"
          @delete="deleteInteraction"
        />
      </template>
    </div>

    <!-- ── Cross-Project Visibility ── -->
    <div v-if="crossProjectSummary.length" class="mt-8">
      <button
        class="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-600 transition-colors mb-3"
        @click="showCrossProject = !showCrossProject"
      >
        <span>{{ showCrossProject ? '▾' : '▸' }}</span>
        <span>Ostatní projekty ({{ crossProjectSummary.length }})</span>
      </button>
      <div v-if="showCrossProject" class="space-y-2">
        <div
          v-for="cp in crossProjectSummary"
          :key="cp.projectId"
          class="bg-gray-50 border border-gray-100 rounded-lg p-3"
        >
          <div class="flex items-center justify-between mb-1">
            <span class="text-sm font-medium text-gray-700">{{ cp.projectName }}</span>
            <span class="text-xs text-gray-400">{{ cp.interactionCount }} jednání</span>
          </div>
          <div class="flex items-center gap-3 flex-wrap text-xs text-gray-500">
            <span v-if="cp.lastActivityAt">Poslední aktivita: {{ fmtDateShort(cp.lastActivityAt) }}</span>
            <span v-if="cp.assigneeNames.length" class="text-gray-400">{{ cp.assigneeNames.join(', ') }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Email contact management ── -->
    <div v-if="typeFilter === 'EMAIL'" class="mt-8">
      <NegotiationsContactManagementPanel
        :global-record-id="id"
        :detected-domain="detectedDomain"
        :domain-override="domainOverride"
        :domain-is-manual="domainIsManual"
        :auto-include-domain="autoIncludeDomain"
        :blacklist="blacklist"
        :additional-addresses="additionalAddresses"
        :can-edit="canEdit"
        @changed="refreshBlacklist()"
      />
    </div>

    <!-- ── Profile modal ── -->
    <div v-if="showProfileModal" class="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" @click.self="showProfileModal = false">
      <div class="bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 class="font-semibold text-gray-800">Profil partnera</h2>
          <button class="text-gray-400 hover:text-gray-600 text-xl leading-none" @click="showProfileModal = false">×</button>
        </div>
        <div class="overflow-y-auto p-6 flex-1">
          <p class="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{{ partner.payload.description }}</p>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="text-center py-16 text-gray-400 text-sm">Načítám...</div>

  <PartnersPartnerFormModal
    v-if="showEditModal && partner"
    mode="edit"
    :partner="{ id: partner.id, canonicalName: partner.canonicalName, payload: partner.payload, contacts: partner.contacts }"
    @close="showEditModal = false"
    @saved="showEditModal = false; refreshPartner()"
  />

  <NegotiationsEmailComposer
    v-if="composerOpen && partner"
    :global-record-id="id"
    :contacts="composerContacts"
    :prefilled-to="composerPrefilledTo"
    :prefilled-cc="composerPrefilledCc"
    :prefilled-subject="composerPrefilledSubject"
    :in-reply-to-gmail-id="composerReplyToGmailId ?? undefined"
    :reply-context="composerReplyContext"
    :edit-scheduled="composerEditScheduled"
    :has-prior-communication="hasSentEmail"
    :ai-body-prefix="composerAiBodyPrefix"
    :recommendations="composerRecommendations"
    @close="composerOpen = false"
    @sent="composerOpen = false; refreshInteractions(); refreshScheduledEmails()"
  />
</template>
