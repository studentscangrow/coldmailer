<script setup lang="ts">
import { NEGOTIATION_STATUS_LABELS, NEGOTIATION_STATUS_COLORS, EDITABLE_NEGOTIATION_STATUSES } from '~/utils/negotiationStatus'

interface AssigneeUser { id: string; name: string; image: string | null }
interface AppUser { id: string; name: string; image: string | null; email: string }
interface Contact {
  id: string; address: string | null; firstName: string | null; lastName: string | null
  role: string | null; contactType: string | null; note: string | null; priority: number
}
interface Partner {
  canonicalName: string
  payload: Record<string, string>
  contacts: Contact[]
  assignees: AssigneeUser[]
  negotiationStatus: 'CONTACTED' | 'REMINDED' | 'WAITING_FOR_THEM' | 'WAITING_FOR_US' | 'PRED_SCHUZKOU' | 'FULFILLING' | 'THANKS_REMAINING' | 'COMPLETED' | 'NOT_INTERESTED' | 'NOT_THIS_TIME' | null
  discordThreadUrl: string | null
}

const props = defineProps<{
  globalRecordId: string
  partner: Partner
  canEdit: boolean
  canManageAssignees: boolean
  allUsers: AppUser[]
}>()

const emit = defineEmits<{
  synced: []
  'partner-changed': []
  'open-detail': []
}>()

const toast = useToast()

// ── Gmail sync ───────────────────────────────────────────────────────────────

const gmailSyncActive = ref(false)
const lastSyncAt = ref(0)
const showSyncDropdown = ref(false)
const syncLookbackDays = ref(90)

const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval>
onMounted(() => {
  nowTimer = setInterval(() => { now.value = Date.now() }, 1000)
  document.addEventListener('click', () => { showSyncDropdown.value = false; showAddAssignee.value = false })
})
onUnmounted(() => {
  if (nowTimer) clearInterval(nowTimer)
})

const syncCooldownActive = computed(() => now.value - lastSyncAt.value < 10_000)
const syncDisabled = computed(() => gmailSyncActive.value || syncCooldownActive.value)

async function syncNow(lookbackDays?: number) {
  if (gmailSyncActive.value) return
  gmailSyncActive.value = true
  showSyncDropdown.value = false
  try {
    const body = { lookbackDays: lookbackDays ?? syncLookbackDays.value }
    const res = await $fetch<{ synced: number; skipped?: string }>(`/api/partners/${props.globalRecordId}/sync-assignees`, { method: 'POST', body })
    if (res.skipped === 'no-assignees') {
      toast.show('K tomuto jednání není nikdo přiřazený', 'info')
    } else {
      const n = res.synced
      const word = n === 1 ? 'email' : n >= 2 && n <= 4 ? 'emaily' : 'emailů'
      toast.show(`Synchronizováno ${n} ${word}`, 'success')
    }
    emit('synced')
  } catch {
    toast.show('Sync selhal', 'error')
  } finally {
    lastSyncAt.value = Date.now()
    gmailSyncActive.value = false
  }
}

// ── Status ───────────────────────────────────────────────────────────────────

async function updateStatus(value: string | null) {
  await $fetch(`/api/partners/${props.globalRecordId}/status`, {
    method: 'PATCH',
    body: { negotiationStatus: value },
  })
  toast.show('Stav jednání aktualizován', 'success')
  emit('partner-changed')
}

// v-model (not a plain :value/@change) so Vue's SSR renderer marks the right <option> as
// selected — a bound :value on a native <select> only sets the DOM property client-side,
// which caused a hydration mismatch on every load with a non-empty negotiationStatus.
const negotiationStatusModel = computed({
  get: () => props.partner.negotiationStatus ?? '',
  set: (value: string) => { updateStatus(value || null) },
})

// ── Solution assignees ───────────────────────────────────────────────────────

const showAddAssignee = ref(false)
const addAssigneeUserId = ref('')

const unassignedSolutionUsers = computed(() => {
  const assigned = new Set(props.partner.assignees.map(a => a.id))
  return props.allUsers.filter(u => !assigned.has(u.id))
})

async function addSolutionAssignee() {
  if (!addAssigneeUserId.value) return
  await $fetch(`/api/partners/${props.globalRecordId}/status`, {
    method: 'PATCH',
    body: { addAssigneeId: addAssigneeUserId.value },
  })
  addAssigneeUserId.value = ''
  showAddAssignee.value = false
  toast.show('Řešitel přidán', 'success')
  emit('partner-changed')
}

async function removeSolutionAssignee(userId: string) {
  if (!confirm('Odstranit tohoto uživatele z řešitelů partnera?')) return
  await $fetch(`/api/partners/${props.globalRecordId}/status`, {
    method: 'PATCH',
    body: { removeAssigneeId: userId },
  })
  toast.show('Řešitel odebrán', 'success')
  emit('partner-changed')
}

// ── Discord thread ───────────────────────────────────────────────────────────

const editingDiscordUrl = ref(false)
const discordUrlValue = ref('')
const discordInput = ref<HTMLInputElement | null>(null)

function startDiscordEdit() {
  discordUrlValue.value = props.partner.discordThreadUrl ?? ''
  editingDiscordUrl.value = true
  nextTick(() => discordInput.value?.focus())
}

async function saveDiscordUrl() {
  if (!editingDiscordUrl.value) return
  editingDiscordUrl.value = false
  await $fetch(`/api/partners/${props.globalRecordId}/negotiation/discord-thread`, {
    method: 'PATCH',
    body: { discordThreadUrl: discordUrlValue.value.trim() || null },
  })
  toast.show('Discord vlákno uloženo', 'success')
  emit('partner-changed')
}
</script>

<template>
  <div class="mb-6">
    <div class="flex items-start justify-between gap-4">
      <div>
        <div class="flex items-center gap-3 flex-wrap">
          <h1 class="text-2xl font-semibold text-gray-800">{{ partner.canonicalName }}</h1>
          <a
            v-if="partner.payload.website || partner.payload.url"
            :href="partner.payload.website || partner.payload.url"
            target="_blank"
            rel="noopener"
            class="text-indigo-400 hover:text-indigo-600 text-sm"
          >↗ web</a>
          <span
            v-if="partner.payload.industry || partner.payload.type"
            class="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600"
          >{{ partner.payload.industry || partner.payload.type }}</span>
        </div>
        <div v-if="partner.payload.summary || partner.payload.description" class="mt-1.5 text-sm text-gray-400 max-w-xl line-clamp-2">
          {{ partner.payload.summary || partner.payload.description }}
        </div>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <div v-if="canEdit" class="relative flex">
          <button
            class="text-xs px-3 py-1.5 rounded-l-lg border border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50 transition-colors flex items-center gap-1.5 disabled:opacity-40"
            :disabled="syncDisabled"
            @click="syncNow()"
          >
            <svg v-if="gmailSyncActive" class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>
            <svg v-else class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            {{ gmailSyncActive ? 'Sync...' : 'Sync' }}
          </button>
          <button
            class="text-xs px-1.5 py-1.5 rounded-r-lg border border-l-0 border-gray-200 text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
            :disabled="syncDisabled"
            @click.stop="showSyncDropdown = !showSyncDropdown"
          >
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
          </button>
          <div v-if="showSyncDropdown" class="absolute right-0 top-full mt-1 z-50 bg-white rounded-xl border border-gray-200 shadow-xl p-4 w-64" @click.stop>
            <h4 class="text-xs font-medium text-gray-700 mb-2">Hloubka synchronizace</h4>
            <p class="text-[11px] text-gray-400 mb-3">Znovu načte maily z minulosti. Duplikáty se nevytvoří.</p>
            <div class="flex items-center gap-2 mb-3">
              <input v-model.number="syncLookbackDays" type="number" min="1" max="365" class="w-20 text-sm px-2 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300 text-center" />
              <span class="text-xs text-gray-500">dní zpět</span>
            </div>
            <div class="flex gap-1 mb-3">
              <button v-for="d in [30, 90, 180, 365]" :key="d" class="text-[10px] px-2 py-1 rounded border transition-colors" :class="syncLookbackDays === d ? 'border-indigo-300 bg-indigo-50 text-indigo-600' : 'border-gray-200 text-gray-500 hover:bg-gray-50'" @click="syncLookbackDays = d">{{ d }}d</button>
            </div>
            <button
              :disabled="syncDisabled"
              class="w-full text-xs px-3 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40 transition-colors"
              @click="syncNow(syncLookbackDays)"
            >Synchronizovat {{ syncLookbackDays }} dní zpět</button>
          </div>
        </div>
        <!-- Stav jednání inline vedle tlačítek -->
        <div v-if="canEdit || partner.negotiationStatus" class="flex items-center gap-1.5">
          <span class="text-xs text-gray-400 font-medium whitespace-nowrap">Stav:</span>
          <select
            v-if="canEdit"
            v-model="negotiationStatusModel"
            class="text-xs px-2 py-1.5 border border-gray-200 rounded-lg text-gray-700 focus:outline-none focus:border-indigo-300 bg-white min-w-36"
          >
            <option value="">—</option>
            <option v-for="key in EDITABLE_NEGOTIATION_STATUSES" :key="key" :value="key">{{ NEGOTIATION_STATUS_LABELS[key] }}</option>
          </select>
          <span
            v-else-if="partner.negotiationStatus"
            :class="['text-xs px-2 py-1 rounded font-medium', NEGOTIATION_STATUS_COLORS[partner.negotiationStatus] ?? 'bg-gray-100 text-gray-600']"
          >{{ NEGOTIATION_STATUS_LABELS[partner.negotiationStatus] }}</span>
        </div>
        <!-- Discord vlákno -->
        <div class="flex items-center gap-1">
          <input
            v-if="editingDiscordUrl"
            ref="discordInput"
            v-model="discordUrlValue"
            type="url"
            placeholder="https://discord.com/channels/..."
            class="text-xs px-2 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300 w-56"
            @keydown.enter="saveDiscordUrl"
            @keydown.escape="editingDiscordUrl = false"
            @blur="saveDiscordUrl"
          />
          <template v-else-if="partner.discordThreadUrl">
            <a
              :href="partner.discordThreadUrl"
              target="_blank"
              rel="noopener"
              class="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-[#5865F2] text-white hover:bg-[#4752C4] transition-colors"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.522 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1568 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" /></svg>
              Discord vlákno
            </a>
            <button v-if="canEdit" class="text-[10px] text-gray-400 hover:text-indigo-600 transition-colors" @click="startDiscordEdit">✏️</button>
          </template>
          <button
            v-else-if="canEdit"
            class="text-xs text-gray-400 hover:text-indigo-500 transition-colors whitespace-nowrap"
            @click="startDiscordEdit"
          >+ Discord vlákno</button>
        </div>
        <button
          class="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50 transition-colors"
          @click="emit('open-detail')"
        >
          Detail
        </button>
      </div>
    </div>

    <!-- Souhrnné přiřazení -->
    <div v-if="partner.assignees.length || canManageAssignees" class="mt-4 flex items-center gap-3 flex-wrap">
      <span class="text-xs text-gray-400 font-medium">Přiřazeni:</span>
      <div class="flex items-center gap-2">
        <template v-for="a in partner.assignees" :key="a.id">
          <button
            v-if="canManageAssignees"
            class="group relative flex items-center gap-1.5"
            :title="a.name"
            @click="removeSolutionAssignee(a.id)"
          >
            <img v-if="a.image" :src="a.image" :alt="a.name" class="w-7 h-7 rounded-full ring-2 ring-white object-cover group-hover:opacity-60" referrerpolicy="no-referrer" />
            <div v-else class="w-7 h-7 rounded-full ring-2 ring-white bg-indigo-400 flex items-center justify-center text-white text-[11px] font-medium group-hover:opacity-60">{{ a.name.charAt(0).toUpperCase() }}</div>
            <span class="text-xs text-gray-500 group-hover:text-red-400">{{ a.name }}</span>
            <span class="absolute -top-0.5 -left-0.5 hidden group-hover:flex w-3.5 h-3.5 bg-red-400 rounded-full items-center justify-center text-white text-[9px]">×</span>
          </button>
          <span v-else :title="a.name" class="flex items-center gap-1.5">
            <img v-if="a.image" :src="a.image" :alt="a.name" class="w-7 h-7 rounded-full ring-2 ring-white object-cover" referrerpolicy="no-referrer" />
            <div v-else class="w-7 h-7 rounded-full ring-2 ring-white bg-indigo-400 flex items-center justify-center text-white text-[11px] font-medium">{{ a.name.charAt(0).toUpperCase() }}</div>
            <span class="text-xs text-gray-500">{{ a.name }}</span>
          </span>
        </template>
        <div class="relative ml-1">
          <button
            v-if="canManageAssignees"
            class="w-7 h-7 rounded-full border border-dashed flex items-center justify-center text-xs transition-colors"
            :class="showAddAssignee ? 'border-indigo-300 text-indigo-500 bg-indigo-50' : 'border-gray-300 text-gray-400 hover:text-indigo-500 hover:border-indigo-300'"
            @click.stop="showAddAssignee = !showAddAssignee"
          >+</button>
          <div
            v-if="showAddAssignee && unassignedSolutionUsers.length"
            class="absolute left-0 top-full mt-1 z-50 bg-white rounded-xl border border-gray-200 shadow-xl py-1 min-w-36"
            @click.stop
          >
            <button
              v-for="u in unassignedSolutionUsers"
              :key="u.id"
              class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-indigo-50 text-left transition-colors"
              @click="addAssigneeUserId = u.id; addSolutionAssignee(); showAddAssignee = false"
            >
              <img v-if="u.image" :src="u.image" :alt="u.name" class="w-5 h-5 rounded-full object-cover" referrerpolicy="no-referrer" />
              <div v-else class="w-5 h-5 rounded-full bg-indigo-400 flex items-center justify-center text-white text-[10px] font-medium">{{ u.name.charAt(0).toUpperCase() }}</div>
              <span class="text-xs text-gray-700">{{ u.name }}</span>
            </button>
          </div>
          <div
            v-else-if="showAddAssignee && !unassignedSolutionUsers.length"
            class="absolute left-0 top-full mt-1 z-50 bg-white rounded-xl border border-gray-200 shadow-xl py-2 px-3 min-w-36"
          >
            <span class="text-xs text-gray-400">Nikdo další</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
