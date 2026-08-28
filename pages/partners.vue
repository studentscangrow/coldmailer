<script setup lang="ts">
import { NEGOTIATION_STATUS_LABELS, NEGOTIATION_STATUS_COLORS } from '~/utils/negotiationStatus'
import { PARTNER_RESEARCH_PROMPT } from '~/utils/researchPrompt'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const router = useRouter()

const { activeProject } = useActiveProject()
const toast = useToast()

const SIZE_LABELS: Record<string, string> = {
  micro: '<10', small: '10–50', medium: '50–500', large: '500–5k', enterprise: '>5k',
}
interface Contact {
  id: string; address: string | null; firstName: string | null; lastName: string | null
  role: string | null; contactType: string | null; note: string | null; priority: number
}
interface GlobalRecord {
  id: string; type: string; canonicalName: string; createdAt: string
  payload: Record<string, unknown>
  creator: { id: string; name: string; image: string | null }
  _count: { events: number }
  negotiations: Array<{ project: { id: string; name: string }; negotiationStatus: string | null }>
  contacts: Contact[]
}

// ── Data ──────────────────────────────────────────────────────────────────────

const activeTab = ref<'PARTNER'>('PARTNER')
const records   = ref<GlobalRecord[]>([])
const loading   = ref(false)
const page      = ref(1)
const limit     = 50
const total     = ref(0)
const search     = ref('')
const filterSize = ref('')

const canManageAll = ref(false)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit)))

async function fetchRecords() {
  loading.value = true
  try {
    const data = await $fetch<{ records: GlobalRecord[]; total: number; canManageAll: boolean }>('/api/records', {
      query: { type: activeTab.value, offset: (page.value - 1) * limit, limit, search: search.value || undefined, withCount: 'true' },
    })
    records.value = data.records
    total.value = data.total
    canManageAll.value = data.canManageAll
  } finally {
    loading.value = false
  }
}

onMounted(() => fetchRecords())

let searchDebounce: ReturnType<typeof setTimeout> | undefined
watch(search, () => {
  clearTimeout(searchDebounce)
  searchDebounce = setTimeout(() => { page.value = 1; fetchRecords() }, 300)
})

watch(page, () => fetchRecords())

// ── Helpers ──────────────────────────────────────────────────────────────────

function isProfiled(rec: GlobalRecord): boolean {
  return !!rec.payload.summary
}

function getContacts(rec: GlobalRecord): Contact[] {
  return rec.contacts ?? []
}

// ── Client-side filters ───────────────────────────────────────────────────────
// Name search is server-side (see fetchRecords/watch above) so it covers the
// full dataset. filterSize only applies within the currently loaded page.

const availableSizes = computed(() =>
  Object.keys(SIZE_LABELS).filter(s => records.value.some(r => String(r.payload.size ?? '') === s)),
)

const filteredRecords = computed(() => {
  return records.value.filter(rec => {
    if (filterSize.value && String(rec.payload.size ?? '') !== filterSize.value) return false
    return true
  })
})

// ── Expand ────────────────────────────────────────────────────────────────────

const expandedIds = ref(new Set<string>())
function toggleExpand(id: string) {
  const s = new Set(expandedIds.value)
  s.has(id) ? s.delete(id) : s.add(id)
  expandedIds.value = s
}

const editingPartner = ref<GlobalRecord | null>(null)
const partnerToAssign = ref<GlobalRecord | null>(null)
const partnerToAssignPeople = ref<GlobalRecord | null>(null)

function isInActiveProject(rec: GlobalRecord): boolean {
  return rec.negotiations.some(pr => pr.project.id === activeProject.value?.id)
}

function activeProjectStatus(rec: GlobalRecord): string | null {
  const entry = rec.negotiations.find(pr => pr.project.id === activeProject.value?.id)
  if (!entry) return null
  return entry.negotiationStatus ?? 'PRED_OSLOVENIM'
}

/** Skočí na první stránku a znovu načte — použije se po vytvoření/importu nového partnera. */
function goToFirstPageAndRefetch() {
  if (page.value === 1) fetchRecords()
  else page.value = 1
}

watch(totalPages, (tp) => { if (page.value > tp) page.value = tp })

async function removeFromProject(rec: GlobalRecord) {
  if (!confirm(`Opravdu odebrat partnera "${rec.canonicalName}" z projektu "${activeProject.value?.name}"? Historie jednání, e-mailů a poznámek zůstane zachována.`)) return
  await $fetch(`/api/partners/${rec.id}/project`, { method: 'DELETE' })
  toast.show(`Partner "${rec.canonicalName}" odebrán z projektu`, 'success')
  fetchRecords()
}

// ── Permissions ─────────────────────────────────────────────────────────────

const canCreatePartner = ref(true)
const showCreatePartnerModal = ref(false)
const showImportModal = ref(false)
const importPrefill = ref<string | undefined>(undefined)
const showNewDropdown = ref(false)

if (route.query.create === '1' && canCreatePartner.value) {
  activeTab.value = 'PARTNER'
  showCreatePartnerModal.value = true
  router.replace({ query: { ...route.query, create: undefined } })
}

function onPartnerCreated() {
  showCreatePartnerModal.value = false
  if (activeTab.value === 'PARTNER') goToFirstPageAndRefetch()
}

function openTextImport(prefill?: string) {
  importPrefill.value = prefill
  showImportModal.value = true
  showNewDropdown.value = false
}

function openJsonFilePicker() {
  showNewDropdown.value = false
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,.txt,application/json,text/plain'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (e) => openTextImport(String(e.target?.result ?? ''))
    reader.readAsText(file)
  })
  input.click()
}

function onImportSaved() {
  showImportModal.value = false
  goToFirstPageAndRefetch()
}

function onImportClose() {
  showImportModal.value = false
}

async function copyResearchPrompt() {
  showNewDropdown.value = false
  await navigator.clipboard.writeText(PARTNER_RESEARCH_PROMPT)
  toast.show('Research prompt zkopírován do schránky', 'success')
}
</script>

<template>
  <div>
    <div class="mb-6 flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-gray-800">Partneři</h1>
        <p class="text-sm text-gray-400 mt-1">Globální databáze partnerů</p>
      </div>
      <div v-if="canCreatePartner" class="relative flex items-stretch">
        <button
          class="text-sm font-medium text-white bg-primary px-4 py-2 rounded-l-lg hover:opacity-90 transition-opacity"
          @click="showCreatePartnerModal = true"
        >Nový partner</button>
        <button
          class="text-sm font-medium text-white bg-primary px-2 py-2 rounded-r-lg border-l border-white/20 hover:opacity-90 transition-opacity"
          @click="showNewDropdown = !showNewDropdown"
          aria-label="Další možnosti"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        <div v-show="showNewDropdown" class="absolute top-full right-0 mt-1 bg-white rounded-xl shadow-lg border border-gray-200 py-1 z-20 min-w-44">
          <button
            class="w-full text-left text-sm px-4 py-2.5 text-gray-700 hover:bg-gray-50 transition-colors"
            @click="openJsonFilePicker"
          >Nahrát JSON</button>
          <button
            class="w-full text-left text-sm px-4 py-2.5 text-gray-700 hover:bg-gray-50 transition-colors"
            @click="openTextImport()"
          >Vložit text</button>
          <button
            class="w-full text-left text-sm px-4 py-2.5 text-gray-700 hover:bg-gray-50 transition-colors border-t border-gray-100"
            @click="copyResearchPrompt"
          >Kopírovat research prompt</button>
        </div>
        <div v-show="showNewDropdown" class="fixed inset-0 z-10" @click="showNewDropdown = false" />
      </div>
    </div>

    <div class="mb-4 space-y-2.5">
      <input
        v-model="search"
        type="text"
        placeholder="Hledat podle názvu..."
        class="w-full max-w-sm text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300"
      />
      <div v-if="availableSizes.length" class="flex items-center gap-2 flex-wrap">
        <span class="text-xs text-gray-400 font-medium w-16 flex-shrink-0">Velikost</span>
        <button
          v-for="s in availableSizes" :key="s"
          :class="['text-xs px-2.5 py-1 rounded-full border transition-colors', filterSize === s ? 'bg-indigo-100 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-500 hover:border-gray-300']"
          @click="filterSize = filterSize === s ? '' : s"
        >{{ SIZE_LABELS[s] }}</button>
        <button v-if="filterSize" class="text-xs text-indigo-500 hover:underline ml-1" @click="filterSize = ''">Zrušit</button>
      </div>
    </div>

    <div class="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-100 bg-gray-50 text-left">
              <th class="px-4 py-3 w-7" />
              <th class="px-4 py-3 font-medium text-gray-500 text-xs">Název</th>
              <th class="px-4 py-3 font-medium text-gray-500 text-xs">Odvětví</th>
              <th class="px-4 py-3 font-medium text-gray-500 text-xs">Projekty</th>
              <th class="px-4 py-3 font-medium text-gray-500 text-xs">Stav v projektu</th>
              <th class="px-4 py-3 w-10" />
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            <tr v-if="loading">
              <td colspan="6" class="py-12">
                <div class="flex justify-center">
                  <svg class="w-5 h-5 animate-spin text-gray-300" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                </div>
              </td>
            </tr>
            <tr v-else-if="filteredRecords.length === 0">
              <td colspan="6" class="text-center py-12 text-gray-400 text-sm">Žádní partneři</td>
            </tr>
            <template v-else>
              <template v-for="rec in filteredRecords" :key="rec.id">
                <tr class="hover:bg-gray-50 cursor-pointer transition-colors" @click="toggleExpand(rec.id)">
                  <td class="px-4 py-3">
                    <svg class="w-3 h-3 text-gray-300 transition-transform" :class="expandedIds.has(rec.id) ? 'rotate-180' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                    </svg>
                  </td>
                  <td :class="['px-4 py-3 font-medium', isProfiled(rec) ? 'text-gray-800' : 'text-gray-400']">
                    <div class="flex items-center gap-2">
                      <svg
                        v-if="!isProfiled(rec)"
                        class="w-4 h-4 flex-shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        title="Partner není profilován — je potřeba doplnit chybějící pole."
                      >
                        <path d="M12 3.5 2.5 20h19L12 3.5z" fill="#FBBF24" />
                        <rect x="11.1" y="9" width="1.8" height="6" rx="0.9" fill="#F97316" />
                        <rect x="11.1" y="16" width="1.8" height="1.8" rx="0.9" fill="#F97316" />
                      </svg>
                      <span class="truncate max-w-40">{{ rec.canonicalName }}</span>
                      <a v-if="rec.payload.website || rec.payload.url" :href="String(rec.payload.website || rec.payload.url)" target="_blank" rel="noopener" class="text-indigo-400 hover:text-indigo-600 text-xs flex-shrink-0" @click.stop>↗</a>
                    </div>
                  </td>
                  <td class="px-4 py-3">
                    <span
                      v-if="rec.payload.industry || rec.payload.type"
                      class="inline-block max-w-56 truncate align-bottom text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-600"
                      :title="String(rec.payload.industry || rec.payload.type)"
                    >{{ rec.payload.industry || rec.payload.type }}</span>
                  </td>
                  <td class="px-4 py-3">
                    <div class="flex items-center gap-1 flex-wrap max-w-56">
                      <span v-for="pr in rec.negotiations" :key="pr.project.id" class="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{{ pr.project.name }}</span>
                    </div>
                  </td>
                  <td class="px-4 py-3">
                    <span
                      v-if="activeProjectStatus(rec)"
                      :class="['text-xs px-2 py-0.5 rounded-full font-medium', NEGOTIATION_STATUS_COLORS[activeProjectStatus(rec)!] ?? 'bg-gray-100 text-gray-500']"
                    >{{ NEGOTIATION_STATUS_LABELS[activeProjectStatus(rec)!] }}</span>
                    <span v-else class="text-xs text-gray-300">–</span>
                  </td>
                  <td class="px-4 py-3">
                    <div class="flex items-center justify-end gap-3">
                      <button
                        v-if="canManageAll && isInActiveProject(rec)"
                        class="text-red-400 hover:text-red-600 transition-colors"
                        title="Odebrat z aktuálního projektu"
                        @click.stop="removeFromProject(rec)"
                      >
                        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
                        </svg>
                      </button>
                      <button
                        v-else-if="canManageAll"
                        class="text-indigo-400 hover:text-indigo-600 transition-colors"
                        title="Přiřadit do aktuálního projektu"
                        @click.stop="partnerToAssign = rec"
                      >
                        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                        </svg>
                      </button>
                      <button
                        v-if="canManageAll && isInActiveProject(rec)"
                        class="text-gray-400 hover:text-indigo-600 transition-colors"
                        title="Přiřadit jednatele / oslovovatele"
                        @click.stop="partnerToAssignPeople = rec"
                      >
                        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a4 4 0 00-5.197-3.795M9 20H4v-2a4 4 0 015.197-3.795M15 7a4 4 0 11-8 0 4 4 0 018 0zm6 4a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      </button>
                      <button class="text-gray-400 hover:text-gray-600 transition-colors" title="Upravit partnera" @click.stop="editingPartner = rec">
                        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>

                <tr v-if="expandedIds.has(rec.id)" class="bg-indigo-50/20">
                  <td />
                  <td colspan="5" class="px-4 py-4">
                    <PartnersPartnerDetailContent :payload="rec.payload" :contacts="getContacts(rec)" />
                  </td>
                </tr>
              </template>
            </template>
          </tbody>
        </table>
      </div>

    <div v-if="totalPages > 1" class="mt-4 flex items-center justify-center gap-3">
      <button
        class="text-sm px-3 py-1.5 border border-gray-200 rounded-lg text-gray-600 hover:border-gray-300 hover:bg-gray-50 disabled:opacity-40 transition-colors"
        :disabled="page === 1 || loading"
        @click="page--"
      >Předchozí</button>
      <span class="text-xs text-gray-400">Strana {{ page }} z {{ totalPages }}</span>
      <button
        class="text-sm px-3 py-1.5 border border-gray-200 rounded-lg text-gray-600 hover:border-gray-300 hover:bg-gray-50 disabled:opacity-40 transition-colors"
        :disabled="page === totalPages || loading"
        @click="page++"
      >Další</button>
    </div>

    <PartnersPartnerFormModal v-if="showCreatePartnerModal" mode="create" @close="showCreatePartnerModal = false" @saved="onPartnerCreated" />
    <PartnersPartnerFormModal v-if="editingPartner" mode="edit" :partner="editingPartner" :can-delete="canManageAll" @close="editingPartner = null" @saved="editingPartner = null; fetchRecords()" @deleted="editingPartner = null; fetchRecords()" />
    <PartnersPartnerSearchAssign
      v-if="partnerToAssign"
      mode="choice"
      :preselected-partner="{
        id: partnerToAssign.id,
        canonicalName: partnerToAssign.canonicalName,
        industry: String(partnerToAssign.payload.industry ?? ''),
        size: String(partnerToAssign.payload.size ?? ''),
        website: String(partnerToAssign.payload.website ?? ''),
        hasNegotiation: false
      }"
      @close="partnerToAssign = null"
      @assigned="partnerToAssign = null; fetchRecords()"
    />
    <PartnersPartnerImportModal v-if="showImportModal" :prefill="importPrefill" @close="onImportClose" @saved="onImportSaved" />
    <PartnersPartnerAssigneesModal
      v-if="partnerToAssignPeople"
      :partner="{ id: partnerToAssignPeople.id, canonicalName: partnerToAssignPeople.canonicalName }"
      @close="partnerToAssignPeople = null"
      @changed="fetchRecords()"
    />

  </div>
</template>
