<script setup lang="ts">
interface PartnerContact {
  id: string; address: string | null; firstName: string | null; lastName: string | null
  role: string | null; contactType: string | null; note: string | null; priority: number
}
const props = defineProps<{
  mode: 'create' | 'edit'
  partner?: { id: string; canonicalName: string; payload: Record<string, unknown>; contacts?: PartnerContact[] }
  duplicateBehavior?: 'show-error' | 'use-existing'
  canDelete?: boolean
}>()
const emit = defineEmits<{ close: []; saved: [{ id: string }]; deleted: [] }>()

interface ContactEntry {
  id?: string; firstName: string; lastName: string; role: string; email: string
  type: string; priority: number; note: string
}

const SIZE_OPTIONS = [
  { value: '', label: '—' },
  { value: 'micro', label: 'Mikro (<10)' },
  { value: 'small', label: 'Malá (10–50)' },
  { value: 'medium', label: 'Střední (50–500)' },
  { value: 'large', label: 'Velká (500–5k)' },
  { value: 'enterprise', label: 'Korporát (>5k)' },
]
const CONTACT_TYPE_OPTIONS = ['Partnerships', 'PR', 'HR', 'Marketing', 'CEO', 'General']

interface EvidenceEntry { event: string; role: string; year: string; source: string }

const payload = props.partner?.payload ?? {}
const form = reactive({
  canonicalName: props.partner?.canonicalName ?? '',
  website: String(payload.website ?? payload.url ?? ''),
  linkedinUrl: String(payload.linkedinUrl ?? ''),
  instagramUrl: String(payload.instagramUrl ?? ''),
  industry: String(payload.industry ?? ''),
  size: String(payload.size ?? ''),
  sizeNote: String(payload.sizeNote ?? ''),
  parentCompany: String(payload.parentCompany ?? ''),
  summary: String(payload.summary ?? ''),
  activities: String(payload.activities ?? ''),
  socialInvolvement: String(payload.socialInvolvement ?? ''),
  researchNotes: String(payload.researchNotes ?? ''),
})
const originalForm = { ...form }

const partnershipStyle = ref<string[]>(Array.isArray(payload.partnershipStyle) ? payload.partnershipStyle.map(String) : [])
const recentHighlights = ref<string[]>(Array.isArray(payload.recentHighlights) ? payload.recentHighlights.map(String) : [])
const partnershipEvidence = ref<EvidenceEntry[]>(
  Array.isArray(payload.partnershipEvidence)
    ? (payload.partnershipEvidence as Record<string, unknown>[]).map(e => ({
        event: String(e.event ?? ''), role: String(e.role ?? ''), year: String(e.year ?? ''), source: String(e.source ?? ''),
      }))
    : [],
)
const originalPartnershipStyleJSON = JSON.stringify(partnershipStyle.value)
const originalRecentHighlightsJSON = JSON.stringify(recentHighlights.value)
const originalPartnershipEvidenceJSON = JSON.stringify(partnershipEvidence.value)

function addPartnershipStyle() { partnershipStyle.value.push('') }
function removePartnershipStyle(i: number) { partnershipStyle.value.splice(i, 1) }
function addHighlight() { recentHighlights.value.push('') }
function removeHighlight(i: number) { recentHighlights.value.splice(i, 1) }
function addEvidence() { partnershipEvidence.value.push({ event: '', role: '', year: '', source: '' }) }
function removeEvidence(i: number) { partnershipEvidence.value.splice(i, 1) }

// Fields not covered by the named inputs above (legacy data from imports/old pipeline
// runs, or anything a pasted JSON adds) — shown as raw JSON so nothing is hidden or
// silently dropped when saving.
const NAMED_PAYLOAD_KEYS = [
  'website', 'linkedinUrl', 'instagramUrl', 'industry', 'size', 'sizeNote',
  'parentCompany', 'summary', 'activities', 'socialInvolvement', 'researchNotes', 'contacts',
  'partnershipStyle', 'recentHighlights', 'partnershipEvidence',
]
const extraPayloadEntries = Object.entries(payload).filter(([key]) => !NAMED_PAYLOAD_KEYS.includes(key))
const extraJson = ref(extraPayloadEntries.length > 0 ? JSON.stringify(Object.fromEntries(extraPayloadEntries), null, 2) : '')
const originalExtraJson = extraJson.value
const extraJsonError = ref('')

const contacts = ref<ContactEntry[]>(
  (props.partner?.contacts ?? []).map(c => ({
    id: c.id, firstName: c.firstName ?? '', lastName: c.lastName ?? '',
    role: c.role ?? '', email: c.address ?? '',
    type: c.contactType ?? 'General', priority: c.priority ?? 3,
    note: c.note ?? '',
  })),
)
const originalContactsJSON = JSON.stringify(contacts.value)

function addContact() {
  contacts.value.push({ firstName: '', lastName: '', role: '', email: '', type: 'General', priority: 3, note: '' })
}
function removeContact(i: number) {
  contacts.value.splice(i, 1)
}

const joinProject = ref(false)
const assigneeIds = ref<string[]>([])
const { data: allUsers } = useFetch<{ id: string; name: string; image: string | null; email: string }[]>('/api/users')

const saving = ref(false)
const deleting = ref(false)
const error = ref('')
const duplicateLink = ref('')
const toast = useToast()

const canSubmit = computed(() => form.canonicalName.trim().length > 0)

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))

async function deletePartner() {
  if (!props.partner || deleting.value) return
  deleting.value = true
  error.value = ''
  try {
    await $fetch(`/api/partners/${props.partner.id}`, { method: 'DELETE' })
    toast.show(`Partner "${props.partner.canonicalName}" byl smazán`, 'success')
    emit('deleted')
    emit('close')
  } catch (e: any) {
    error.value = e.data?.message ?? e.statusMessage ?? 'Nepodařilo se smazat.'
  } finally {
    deleting.value = false
  }
}

async function save() {
  if (!canSubmit.value || saving.value) return
  saving.value = true
  error.value = ''
  duplicateLink.value = ''

  const invalidContactIndex = contacts.value.findIndex(c =>
    !c.firstName && !c.lastName && !c.email && !c.role,
  )
  if (invalidContactIndex !== -1) {
    error.value = `Kontakt ${invalidContactIndex + 1} musí mít vyplněno jméno, příjmení, pozici nebo email.`
    saving.value = false
    return
  }

  extraJsonError.value = ''
  let extraPayload: Record<string, unknown> = {}
  if (extraJson.value.trim()) {
    try {
      const parsed = JSON.parse(extraJson.value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
      extraPayload = parsed
    } catch {
      extraJsonError.value = 'Pole "Další data" musí být validní JSON objekt.'
      saving.value = false
      return
    }
  }

  const filteredContacts = contacts.value
  const filteredPartnershipStyle = partnershipStyle.value.map(s => s.trim()).filter(Boolean)
  const filteredHighlights = recentHighlights.value.map(s => s.trim()).filter(Boolean)
  const filteredEvidence = partnershipEvidence.value
    .map(e => ({ event: e.event.trim(), role: e.role.trim(), year: e.year.trim(), source: e.source.trim() }))
    .filter(e => e.event || e.role || e.year || e.source)

  const payloadData: Record<string, unknown> = {}
  if (props.mode === 'create') {
    if (form.website) payloadData.website = form.website
    if (form.linkedinUrl) payloadData.linkedinUrl = form.linkedinUrl
    if (form.instagramUrl) payloadData.instagramUrl = form.instagramUrl
    if (form.industry) payloadData.industry = form.industry
    if (form.size) payloadData.size = form.size
    if (form.sizeNote) payloadData.sizeNote = form.sizeNote
    if (form.parentCompany) payloadData.parentCompany = form.parentCompany
    if (form.summary) payloadData.summary = form.summary
    if (form.activities) payloadData.activities = form.activities
    if (form.socialInvolvement) payloadData.socialInvolvement = form.socialInvolvement
    if (form.researchNotes) payloadData.researchNotes = form.researchNotes
    if (filteredContacts.length > 0) payloadData.contacts = filteredContacts
    if (filteredPartnershipStyle.length > 0) payloadData.partnershipStyle = filteredPartnershipStyle
    if (filteredHighlights.length > 0) payloadData.recentHighlights = filteredHighlights
    if (filteredEvidence.length > 0) payloadData.partnershipEvidence = filteredEvidence
    Object.assign(payloadData, extraPayload)
  } else {
    // Only send fields the user actually changed in this window — resending
    // untouched fields from a stale-opened modal would silently clobber
    // concurrent edits made to those fields in another window/tab.
    if (form.website !== originalForm.website) payloadData.website = form.website
    if (form.linkedinUrl !== originalForm.linkedinUrl) payloadData.linkedinUrl = form.linkedinUrl
    if (form.instagramUrl !== originalForm.instagramUrl) payloadData.instagramUrl = form.instagramUrl
    if (form.industry !== originalForm.industry) payloadData.industry = form.industry
    if (form.size !== originalForm.size) payloadData.size = form.size
    if (form.sizeNote !== originalForm.sizeNote) payloadData.sizeNote = form.sizeNote
    if (form.parentCompany !== originalForm.parentCompany) payloadData.parentCompany = form.parentCompany
    if (form.summary !== originalForm.summary) payloadData.summary = form.summary
    if (form.activities !== originalForm.activities) payloadData.activities = form.activities
    if (form.socialInvolvement !== originalForm.socialInvolvement) payloadData.socialInvolvement = form.socialInvolvement
    if (form.researchNotes !== originalForm.researchNotes) payloadData.researchNotes = form.researchNotes
    if (JSON.stringify(filteredContacts) !== originalContactsJSON) payloadData.contacts = filteredContacts
    if (JSON.stringify(filteredPartnershipStyle) !== originalPartnershipStyleJSON) payloadData.partnershipStyle = filteredPartnershipStyle
    if (JSON.stringify(filteredHighlights) !== originalRecentHighlightsJSON) payloadData.recentHighlights = filteredHighlights
    if (JSON.stringify(filteredEvidence) !== originalPartnershipEvidenceJSON) payloadData.partnershipEvidence = filteredEvidence
    if (extraJson.value !== originalExtraJson) {
      // Keys removed from the JSON box must be sent as null so the backend deletes
      // them — a plain merge PATCH can only add/overwrite, never unset a key.
      for (const [key] of extraPayloadEntries) {
        if (!(key in extraPayload)) payloadData[key] = null
      }
      Object.assign(payloadData, extraPayload)
    }
  }

  try {
    if (props.mode === 'create') {
      const res = await $fetch<{ record: { id: string } }>('/api/partners', {
        method: 'POST',
        body: {
          canonicalName: form.canonicalName.trim(),
          payload: payloadData,
          joinProject: joinProject.value,
          assigneeIds: joinProject.value ? assigneeIds.value : undefined,
        },
      })
      toast.show(`Partner "${form.canonicalName.trim()}" byl vytvořen`, 'success')
      emit('saved', { id: res.record.id })
    } else {
      const body: Record<string, unknown> = { payload: payloadData }
      if (form.canonicalName.trim() !== props.partner!.canonicalName) {
        body.canonicalName = form.canonicalName.trim()
      }
      const res = await $fetch<{ id: string }>(`/api/partners/${props.partner!.id}/payload`, {
        method: 'PATCH',
        body,
      })
      toast.show(`Změny partnera "${form.canonicalName.trim()}" byly uloženy`, 'success')
      emit('saved', { id: res.id })
    }
    emit('close')
  } catch (e: any) {
    if (e?.statusCode === 409) {
      const existingId = e.data?.data?.existingId as string | undefined
      if (existingId && props.duplicateBehavior === 'use-existing') {
        emit('saved', { id: existingId })
        emit('close')
        return
      }
      error.value = e.data?.message ?? e.statusMessage ?? 'Partner s tímto názvem již existuje.'
      if (existingId) {
        duplicateLink.value = `/negotiations/${existingId}`
      }
    } else {
      error.value = e.statusMessage ?? e.message ?? 'Nepodařilo se uložit.'
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 bg-black/40 z-50 flex items-start justify-center pt-12 px-4 overflow-y-auto" @click.self="emit('close')">
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-3xl mb-12">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 class="text-lg font-semibold text-gray-800">
            {{ mode === 'create' ? 'Nový partner' : 'Upravit profil partnera' }}
          </h2>
          <button class="text-gray-400 hover:text-gray-600 transition-colors" @click="emit('close')">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- Content -->
        <div class="px-6 py-5 space-y-6 max-h-[70vh] overflow-y-auto">

          <!-- Error banner -->
          <div v-if="error" class="px-4 py-3 rounded-lg bg-red-50 border border-red-100 text-sm text-red-700">
            {{ error }}
            <NuxtLink v-if="duplicateLink" :to="duplicateLink" class="ml-2 underline font-medium">Zobrazit existujícího</NuxtLink>
          </div>

          <!-- Section: Základní info -->
          <section>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Základní informace</h3>
            <div class="grid grid-cols-2 gap-4">
              <div class="col-span-2">
                <label class="block text-xs font-medium text-gray-600 mb-1">Název partnera *</label>
                <input v-model="form.canonicalName" type="text" class="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300" placeholder="Acme s.r.o." />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">Web</label>
                <input v-model="form.website" type="url" class="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300" placeholder="https://..." />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">LinkedIn</label>
                <input v-model="form.linkedinUrl" type="url" class="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">Instagram</label>
                <input v-model="form.instagramUrl" type="url" class="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">Odvětví</label>
                <input v-model="form.industry" type="text" class="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300" placeholder="Technologie, Média, ..." />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">Velikost</label>
                <select v-model="form.size" class="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300 bg-white">
                  <option v-for="o in SIZE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">Poznámka k velikosti</label>
                <input v-model="form.sizeNote" type="text" class="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">Mateřská společnost</label>
                <input v-model="form.parentCompany" type="text" class="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300" />
              </div>
            </div>
          </section>

          <!-- Section: Popis -->
          <section>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Popis</h3>
            <div class="space-y-3">
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">Shrnutí</label>
                <textarea v-model="form.summary" rows="3" class="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300 resize-y" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">Aktivity / služby</label>
                <textarea v-model="form.activities" rows="3" class="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300 resize-y" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">Společenská angažovanost</label>
                <textarea v-model="form.socialInvolvement" rows="2" class="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300 resize-y" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">Poznámky k výzkumu</label>
                <textarea v-model="form.researchNotes" rows="2" class="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300 resize-y" />
              </div>
            </div>
          </section>

          <!-- Section: Partnerství -->
          <section>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Partnerství</h3>
            <div class="space-y-4">
              <div>
                <div class="flex items-center justify-between mb-1">
                  <label class="block text-xs font-medium text-gray-600">Styl partnerství</label>
                  <button class="text-xs text-indigo-600 hover:text-indigo-800 font-medium" @click="addPartnershipStyle">+ Přidat</button>
                </div>
                <div v-if="partnershipStyle.length === 0" class="text-xs text-gray-400 py-1">Žádný záznam</div>
                <div v-for="(s, i) in partnershipStyle" :key="i" class="flex items-center gap-2 mb-1.5">
                  <input v-model="partnershipStyle[i]" type="text" placeholder="Např. generální partner" class="flex-1 text-sm px-2.5 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:border-indigo-300" />
                  <button class="text-xs text-red-500 hover:text-red-700" @click="removePartnershipStyle(i)">Odebrat</button>
                </div>
              </div>

              <div>
                <div class="flex items-center justify-between mb-1">
                  <label class="block text-xs font-medium text-gray-600">Poslední novinky</label>
                  <button class="text-xs text-indigo-600 hover:text-indigo-800 font-medium" @click="addHighlight">+ Přidat</button>
                </div>
                <div v-if="recentHighlights.length === 0" class="text-xs text-gray-400 py-1">Žádný záznam</div>
                <div v-for="(h, i) in recentHighlights" :key="i" class="flex items-center gap-2 mb-1.5">
                  <input v-model="recentHighlights[i]" type="text" placeholder="Např. schválení investičního rozpočtu na modernizaci sítě" class="flex-1 text-sm px-2.5 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:border-indigo-300" />
                  <button class="text-xs text-red-500 hover:text-red-700" @click="removeHighlight(i)">Odebrat</button>
                </div>
              </div>

              <div>
                <div class="flex items-center justify-between mb-1">
                  <label class="block text-xs font-medium text-gray-600">Doklady o partnerství</label>
                  <button class="text-xs text-indigo-600 hover:text-indigo-800 font-medium" @click="addEvidence">+ Přidat</button>
                </div>
                <div v-if="partnershipEvidence.length === 0" class="text-xs text-gray-400 py-1">Žádný záznam</div>
                <div v-for="(e, i) in partnershipEvidence" :key="i" class="border border-gray-100 rounded-lg p-3 mb-2">
                  <div class="flex items-center justify-between mb-2">
                    <span class="text-xs font-medium text-gray-500">Záznam {{ i + 1 }}</span>
                    <button class="text-xs text-red-500 hover:text-red-700" @click="removeEvidence(i)">Odebrat</button>
                  </div>
                  <div class="grid grid-cols-2 gap-2">
                    <input v-model="e.event" type="text" placeholder="Akce / událost" class="text-sm px-2.5 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:border-indigo-300" />
                    <input v-model="e.role" type="text" placeholder="Role" class="text-sm px-2.5 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:border-indigo-300" />
                    <input v-model="e.year" type="text" placeholder="Rok" class="text-sm px-2.5 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:border-indigo-300" />
                    <input v-model="e.source" type="text" placeholder="Zdroj (URL)" class="text-sm px-2.5 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:border-indigo-300" />
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- Section: Kontakty -->
          <section>
            <div class="flex items-center justify-between mb-1">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Kontaktní osoby</h3>
              <button class="text-xs text-indigo-600 hover:text-indigo-800 font-medium" @click="addContact">+ Přidat kontakt</button>
            </div>
            <p class="text-xs text-gray-400 mb-2">Vyplňte alespoň jedno z: jméno, příjmení, pozice nebo email.</p>
            <div v-if="contacts.length === 0" class="text-xs text-gray-400 py-2">Žádné kontaktní osoby</div>
            <div v-for="(c, i) in contacts" :key="i" class="border border-gray-100 rounded-lg p-3 mb-3">
              <div class="flex items-center justify-between mb-2">
                <span class="text-xs font-medium text-gray-500">Kontakt {{ i + 1 }}</span>
                <button class="text-xs text-red-500 hover:text-red-700" @click="removeContact(i)">Odebrat</button>
              </div>
              <div class="grid grid-cols-3 gap-2">
                <input v-model="c.firstName" type="text" placeholder="Jméno" class="text-sm px-2.5 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:border-indigo-300" />
                <input v-model="c.lastName" type="text" placeholder="Příjmení" class="text-sm px-2.5 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:border-indigo-300" />
                <input v-model="c.role" type="text" placeholder="Pozice" class="text-sm px-2.5 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:border-indigo-300" />
                <input v-model="c.email" type="email" placeholder="Email" class="text-sm px-2.5 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:border-indigo-300" />
                <select v-model="c.type" class="text-sm px-2.5 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:border-indigo-300 bg-white">
                  <option v-for="t in CONTACT_TYPE_OPTIONS" :key="t" :value="t">{{ t }}</option>
                </select>
                <input v-model="c.note" type="text" placeholder="Poznámka" class="text-sm px-2.5 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:border-indigo-300" />
              </div>
            </div>
          </section>

          <!-- Section: Další data -->
          <section>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Další data (JSON)</h3>
            <p class="text-xs text-gray-400 mb-2">Pole, která nejsou pokryta formulářem výše (např. z importu nebo staršího profilování). Lze přidat i vlastní pole.</p>
            <textarea
              v-model="extraJson"
              rows="5"
              placeholder="{}"
              class="w-full text-xs px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300 resize-y font-mono"
              :class="{ 'border-red-300': extraJsonError }"
            />
            <p v-if="extraJsonError" class="text-xs text-red-500 mt-1">{{ extraJsonError }}</p>
          </section>

          <!-- Section: Přiřazení do projektu (create only) -->
          <section v-if="mode === 'create'">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Přiřazení do projektu</h3>
            <label class="flex items-center gap-2 text-sm text-gray-700 mb-3 cursor-pointer">
              <input v-model="joinProject" type="checkbox" class="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
              Přiřadit partnera do aktivního projektu
            </label>
            <div v-if="joinProject" class="ml-6">
              <label class="block text-xs font-medium text-gray-600 mb-1">Členové obchodního týmu</label>
              <div class="flex flex-wrap gap-2">
                <label
                  v-for="u in allUsers"
                  :key="u.id"
                  class="flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border cursor-pointer transition-colors"
                  :class="assigneeIds.includes(u.id) ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'"
                >
                  <input v-model="assigneeIds" type="checkbox" :value="u.id" class="sr-only" />
                  <img v-if="u.image" :src="u.image" class="w-4 h-4 rounded-full" referrerpolicy="no-referrer" />
                  {{ u.name }}
                </label>
              </div>
            </div>
          </section>

        </div>

        <!-- Footer -->
        <div class="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-100">
          <button
            v-if="mode === 'edit' && canDelete"
            class="text-sm text-red-600 hover:text-red-800 px-4 py-2 transition-colors disabled:opacity-50"
            :disabled="deleting || saving"
            @click="deletePartner"
          >
            {{ deleting ? 'Mazání...' : 'Smazat partnera' }}
          </button>
          <div class="flex items-center gap-3 ml-auto">
            <button class="text-sm text-gray-500 hover:text-gray-700 px-4 py-2" @click="emit('close')">Zrušit</button>
            <button
              class="text-sm font-medium text-white bg-primary px-5 py-2 rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
              :disabled="!canSubmit || saving"
              @click="save"
            >
              {{ saving ? 'Ukládám...' : mode === 'create' ? 'Vytvořit' : 'Uložit' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
