<script setup lang="ts">
import { NEGOTIATION_STATUS_LABELS, NEGOTIATION_STATUS_COLORS, lastActivityColor } from '~/utils/negotiationStatus'
import { todoUrgency, todoColorClass, formatTodoDate } from '~/utils/checklist'

definePageMeta({ middleware: 'auth' })

interface Contact { id: string; address: string | null; label: string | null }
interface AssigneeUser { id: string; name: string; image: string | null }
interface Partner {
  id: string
  canonicalName: string
  payload: Record<string, unknown>
  contacts: Contact[]
  assignees: AssigneeUser[]
  lastInteractionAt: string | null
  interactionCount: number
  unreadEmailCount: number
  openTasks: number
  nearestDueDate: string | null
  nearestTaskText: string | null
  taskOverdue: boolean
  negotiationStatus: string | null
  dealConfidence: 'MOZNA' | 'DOMLUVENO' | null
  inProject: boolean
}

const CLOSED_STATUSES = new Set(['NOT_INTERESTED', 'NOT_THIS_TIME'])

const search = ref('')
const statusFilter = ref('')
const dealConfidenceFilter = ref('')
const showClosedStatuses = ref(false)
const { data: partnersData, pending, refresh: refreshPartners } = await useFetch<{ partners: Partner[]; canManageAll: boolean }>('/api/partners')
const { data: meData } = await useFetch<{ user: { id: string; isAdmin: boolean } }>('/api/settings/me')

const allPartners = computed(() => partnersData.value?.partners ?? [])
const canManageAll = computed(() => partnersData.value?.canManageAll ?? false)
const currentUserId = computed(() => meData.value?.user?.id ?? null)
const isAdmin = computed(() => meData.value?.user?.isAdmin ?? false)

const showAssignModal = ref(false)
function onPartnerAdded() {
  showAssignModal.value = false
  refreshPartners()
}

/** Seřadí skupinu partnerů dle lastInteractionAt DESC, záznamy bez data na konec */
function sortByLastInteraction(list: Partner[]): Partner[] {
  return [...list].sort((a, b) => {
    if (a.lastInteractionAt && b.lastInteractionAt) {
      return new Date(b.lastInteractionAt).getTime() - new Date(a.lastInteractionAt).getTime()
    }
    if (a.lastInteractionAt) return -1
    if (b.lastInteractionAt) return 1
    return 0
  })
}

/** Stavy přítomné v aktuálních datech, pro nabídku filtru */
const availableStatuses = computed(() => {
  const set = new Set<string>()
  for (const p of allPartners.value) {
    if (p.negotiationStatus) set.add(p.negotiationStatus)
  }
  return Array.from(set)
})

type SortKey = 'name' | 'status' | 'assignees' | 'interactions' | 'tasks' | 'lastContact'
const sortKey = ref<SortKey | null>(null)
const sortDir = ref<'asc' | 'desc'>('asc')

function toggleSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = 'asc'
  }
}

function sortByColumn(list: Partner[], key: SortKey, dir: 'asc' | 'desc'): Partner[] {
  const mult = dir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    switch (key) {
      case 'name':
        return mult * a.canonicalName.localeCompare(b.canonicalName)
      case 'status':
        return mult * (NEGOTIATION_STATUS_LABELS[a.negotiationStatus ?? ''] ?? '').localeCompare(NEGOTIATION_STATUS_LABELS[b.negotiationStatus ?? ''] ?? '')
      case 'assignees':
        return mult * (a.assignees.length - b.assignees.length)
      case 'interactions':
        return mult * (a.interactionCount - b.interactionCount)
      case 'tasks':
        return mult * (a.openTasks - b.openTasks)
      case 'lastContact': {
        const at = a.lastInteractionAt ? new Date(a.lastInteractionAt).getTime() : 0
        const bt = b.lastInteractionAt ? new Date(b.lastInteractionAt).getTime() : 0
        return mult * (at - bt)
      }
    }
  })
}

/** Filtrovaný + seřazený seznam — bez explicitního řazení sloupce jsou přiřazení mně nahoře, ostatní dole */
const sortedPartners = computed(() => {
  const q = search.value.toLowerCase().trim()
  let filtered = (allPartners.value ?? []).filter(p =>
    !q || p.canonicalName.toLowerCase().includes(q),
  )
  if (statusFilter.value) {
    filtered = filtered.filter(p => p.negotiationStatus === statusFilter.value)
  }
  if (dealConfidenceFilter.value) {
    filtered = filtered.filter(p => p.dealConfidence === dealConfidenceFilter.value)
  }
  if (!showClosedStatuses.value) {
    filtered = filtered.filter(p => !CLOSED_STATUSES.has(p.negotiationStatus ?? ''))
  }

  if (sortKey.value) {
    return sortByColumn(filtered, sortKey.value, sortDir.value)
  }

  const uid = currentUserId.value
  const mine = filtered.filter(p => uid && p.assignees.some(a => a.id === uid))
  const others = filtered.filter(p => !uid || !p.assignees.some(a => a.id === uid))
  return [
    ...sortByLastInteraction(mine),
    ...sortByLastInteraction(others),
  ]
})

// ── Pagination (client-side — the full list is already fetched/sorted above) ──

const page = ref(1)
const pageSize = 25
const totalPages = computed(() => Math.max(1, Math.ceil(sortedPartners.value.length / pageSize)))
const pagedPartners = computed(() => sortedPartners.value.slice((page.value - 1) * pageSize, page.value * pageSize))

watch([search, statusFilter, dealConfidenceFilter, showClosedStatuses], () => { page.value = 1 })
watch(totalPages, (tp) => { if (page.value > tp) page.value = tp })

/** Vrátí true, pokud je partner READ-ONLY pro přihlášeného uživatele (není mu přiřazen, nebo je admin) */
function isReadOnly(p: Partner): boolean {
  if (isAdmin.value) return false
  const uid = currentUserId.value
  if (!uid) return false
  return !p.assignees.some(a => a.id === uid)
}

function lastContact(p: Partner) {
  if (!p.lastInteractionAt) return null
  return new Date(p.lastInteractionAt).toLocaleDateString('cs-CZ')
}

function lastInteractionColor(p: Partner): string {
  if (isReadOnly(p)) return ''
  return lastActivityColor(p.negotiationStatus, p.lastInteractionAt)
}

// Barva sloupce Úkoly dle blízkosti nejnaléhavějšího termínu (po termínu / dnes = červená + "!").
function todoColor(p: Partner): string {
  if (isReadOnly(p) || p.openTasks === 0 || !p.nearestDueDate) return ''
  return todoColorClass(todoUrgency(new Date(p.nearestDueDate)))
}

// Tooltip pro sloupec Úkoly — nejvíce po termínu, jinak nejbližší úkol.
function taskTooltip(p: Partner): string {
  if (p.openTasks === 0) return 'Žádné nesplněné úkoly'
  if (!p.nearestDueDate || !p.nearestTaskText) {
    return `Nesplněných úkolů: ${p.openTasks} (bez termínu)`
  }
  const dateStr = formatTodoDate(new Date(p.nearestDueDate))
  const prefix = p.taskOverdue ? 'Po termínu' : 'Nejbližší'
  return `${prefix}: ${dateStr} – ${p.nearestTaskText}`
}

</script>

<template>
  <div>
    <div class="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold text-gray-800">Oslovení partneři</h1>
        <p class="text-sm text-gray-400 mt-1">Partneři s probíhající komunikací</p>
      </div>
      <button
        v-if="canManageAll"
        class="shrink-0 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
        @click="showAssignModal = true"
      >+ Přidat firmu</button>
    </div>

    <div class="mb-4 flex items-center gap-3">
      <input
        v-model="search"
        type="text"
        placeholder="Hledat partnera..."
        class="w-full max-w-sm text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300"
      />
      <select
        v-model="statusFilter"
        class="text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300 text-gray-600"
      >
        <option value="">Všechny stavy</option>
        <option v-for="s in availableStatuses" :key="s" :value="s">{{ NEGOTIATION_STATUS_LABELS[s] ?? s }}</option>
      </select>
      <select
        v-model="dealConfidenceFilter"
        class="text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300 text-gray-600"
      >
        <option value="">Jistota jednání — vše</option>
        <option value="DOMLUVENO">✅ Bude!</option>
        <option value="MOZNA">❓ Možná</option>
      </select>

      <label class="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none ml-auto">
        Zobrazit Nezájem / Tentokrát nezájem
        <button
          :class="[
            'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 cursor-pointer',
            showClosedStatuses ? 'bg-indigo-600' : 'bg-gray-200',
          ]"
          role="switch"
          :aria-checked="showClosedStatuses"
          @click="showClosedStatuses = !showClosedStatuses"
        >
          <span
            :class="[
              'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200',
              showClosedStatuses ? 'translate-x-4' : 'translate-x-0',
            ]"
          />
        </button>
      </label>
    </div>

    <PartnersPartnerSearchAssign v-if="showAssignModal" mode="negotiation" @close="showAssignModal = false" @assigned="onPartnerAdded" />

    <div class="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-gray-100 bg-gray-50 text-left">
            <th class="px-4 py-3 w-8" title="Jistota jednání" />
            <th class="px-4 py-3 font-medium text-gray-500 text-xs cursor-pointer select-none hover:text-gray-700" @click="toggleSort('name')">
              Název<span v-if="sortKey === 'name'">{{ sortDir === 'asc' ? ' ▲' : ' ▼' }}</span>
            </th>
            <th class="px-4 py-3 font-medium text-gray-500 text-xs cursor-pointer select-none hover:text-gray-700" @click="toggleSort('status')">
              Stav jednání<span v-if="sortKey === 'status'">{{ sortDir === 'asc' ? ' ▲' : ' ▼' }}</span>
            </th>

            <th class="px-4 py-3 font-medium text-gray-500 text-xs cursor-pointer select-none hover:text-gray-700" @click="toggleSort('assignees')">
              Přiřazení<span v-if="sortKey === 'assignees'">{{ sortDir === 'asc' ? ' ▲' : ' ▼' }}</span>
            </th>
            <th class="px-4 py-3 font-medium text-gray-500 text-xs text-center cursor-pointer select-none hover:text-gray-700" @click="toggleSort('interactions')">
              Interakce<span v-if="sortKey === 'interactions'">{{ sortDir === 'asc' ? ' ▲' : ' ▼' }}</span>
            </th>
            <th class="px-4 py-3 font-medium text-gray-500 text-xs text-center cursor-pointer select-none hover:text-gray-700" @click="toggleSort('tasks')">
              Úkoly<span v-if="sortKey === 'tasks'">{{ sortDir === 'asc' ? ' ▲' : ' ▼' }}</span>
            </th>
            <th class="px-4 py-3 font-medium text-gray-500 text-xs cursor-pointer select-none hover:text-gray-700" @click="toggleSort('lastContact')">
              Poslední kontakt<span v-if="sortKey === 'lastContact'">{{ sortDir === 'asc' ? ' ▲' : ' ▼' }}</span>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-50">
          <tr v-if="pending">
            <td colspan="7" class="py-12">
              <div class="flex justify-center">
                <svg class="w-5 h-5 animate-spin text-gray-300" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              </div>
            </td>
          </tr>
          <tr v-else-if="!sortedPartners?.length">
            <td colspan="7" class="text-center py-12 text-gray-400 text-sm">
              {{ search || statusFilter || dealConfidenceFilter ? 'Žádný partner nenalezen' : 'Zatím žádní oslovení partneři' }}
            </td>
          </tr>
          <tr
            v-for="p in pagedPartners"
            :key="p.id"
            :class="[
              'cursor-pointer transition-colors',
              isReadOnly(p)
                ? 'opacity-40 hover:opacity-60 grayscale'
                : 'hover:bg-gray-50',
              !isReadOnly(p) && (CLOSED_STATUSES.has(p.negotiationStatus ?? '') || !p.inProject) ? 'opacity-60' : '',
            ]"
            @click="navigateTo(`/negotiations/${p.id}`)"
          >
            <td class="px-4 py-3 text-center text-base" :title="p.dealConfidence === 'DOMLUVENO' ? 'Bude!' : p.dealConfidence === 'MOZNA' ? 'Možná' : ''">
              <span v-if="p.dealConfidence">{{ p.dealConfidence === 'DOMLUVENO' ? '✅' : '❓' }}</span>
              <span v-else class="text-gray-300">—</span>
            </td>
            <td class="px-4 py-3 font-medium" :class="isReadOnly(p) ? 'text-gray-500' : 'text-gray-800'">
              <div class="flex items-center gap-2">
                <span class="truncate max-w-56">{{ p.canonicalName }}</span>
                <a
                  v-if="p.payload.website || p.payload.url"
                  :href="String(p.payload.website || p.payload.url)"
                  target="_blank"
                  rel="noopener"
                  class="text-indigo-400 hover:text-indigo-600 text-xs flex-shrink-0"
                  @click.stop
                >↗</a>
                <span v-if="!p.inProject" class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-400 whitespace-nowrap">Mimo projekt</span>
              </div>
              <div v-if="p.payload.summary" :title="String(p.payload.summary)" class="text-[11px] text-gray-400 mt-0.5 line-clamp-1 max-w-56">
                {{ p.payload.summary }}
              </div>
            </td>
            <td class="px-4 py-3">
              <span
                v-if="p.negotiationStatus"
                class="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium"
                :class="isReadOnly(p) ? 'bg-gray-100 text-gray-400' : (NEGOTIATION_STATUS_COLORS[p.negotiationStatus] ?? 'bg-gray-100 text-gray-600')"
              >
                {{ NEGOTIATION_STATUS_LABELS[p.negotiationStatus] ?? p.negotiationStatus }}
              </span>
              <span v-else class="text-xs text-gray-300">—</span>
            </td>

            <td class="px-4 py-3">
              <div class="flex items-center -space-x-1">
                <template v-for="a in p.assignees.slice(0, 4)" :key="a.id">
                  <img
                    v-if="a.image"
                    :src="a.image"
                    :alt="a.name"
                    :title="a.name"
                    class="w-6 h-6 rounded-full ring-2 ring-white object-cover"
                    referrerpolicy="no-referrer"
                  />
                  <div
                    v-else
                    :title="a.name"
                    class="w-6 h-6 rounded-full ring-2 ring-white bg-indigo-400 flex items-center justify-center text-white text-xs font-medium"
                  >
                    {{ a.name.charAt(0).toUpperCase() }}
                  </div>
                </template>
                <span v-if="p.assignees.length > 4" class="text-xs text-gray-400 pl-2">+{{ p.assignees.length - 4 }}</span>
                <span v-if="!p.assignees.length" class="text-xs text-gray-300">—</span>
              </div>
            </td>
            <td class="px-4 py-3 text-center">
              <span class="text-xs font-medium" :class="isReadOnly(p) ? 'text-gray-400' : 'text-gray-700'">{{ p.interactionCount }}</span>
              <span
                v-if="p.unreadEmailCount > 0"
                :title="`${p.unreadEmailCount} nepřečtených e-mailů`"
                class="text-xs font-bold ml-0.5"
                :class="isReadOnly(p) ? 'text-gray-400' : 'text-red-600'"
              >({{ p.unreadEmailCount }})</span>
            </td>
            <td
              class="px-4 py-3 text-center"
              :title="taskTooltip(p)"
            >
              <span
                v-if="p.openTasks > 0"
                class="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                :class="isReadOnly(p) ? 'text-gray-400' : (todoColor(p) || 'text-gray-600')"
              >
                <span v-if="!isReadOnly(p) && p.taskOverdue" class="font-bold">!</span>
                {{ p.openTasks }}
              </span>
              <span v-else class="text-xs text-gray-300">—</span>
            </td>
            <td
              class="px-4 py-3 text-xs"
              :class="isReadOnly(p) ? 'text-gray-400' : (lastInteractionColor(p) ? [lastInteractionColor(p), 'rounded font-medium'] : 'text-gray-400')"
            >
              {{ lastContact(p) ?? '—' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="!pending && sortedPartners.length > pageSize" class="mt-4 flex items-center justify-center gap-3">
      <button
        class="text-sm px-3 py-1.5 border border-gray-200 rounded-lg text-gray-600 hover:border-gray-300 hover:bg-gray-50 disabled:opacity-40 transition-colors"
        :disabled="page === 1"
        @click="page--"
      >Předchozí</button>
      <span class="text-xs text-gray-400">Strana {{ page }} z {{ totalPages }}</span>
      <button
        class="text-sm px-3 py-1.5 border border-gray-200 rounded-lg text-gray-600 hover:border-gray-300 hover:bg-gray-50 disabled:opacity-40 transition-colors"
        :disabled="page === totalPages"
        @click="page++"
      >Další</button>
    </div>

  </div>
</template>
