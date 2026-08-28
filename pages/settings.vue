<script setup lang="ts">
import type { MeResponse, AdminUser, GroupInfo, BudgetResponse, ManagedProject } from '~/utils/settings-constants'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const router = useRouter()
const { refreshProjects } = useActiveProject()

// ── Credits ──────────────────────────────────────────────────────────────────
const { data: credits, pending: creditsPending, error: creditsError, refresh: refreshCredits } = await useFetch('/api/settings/credits')

const usedPct = computed(() => {
  if (!credits.value || credits.value.totalCredits <= 0) return 0
  return Math.min(100, (credits.value.usedCredits / credits.value.totalCredits) * 100)
})
const remainingPct = computed(() => 100 - usedPct.value)
const barColor = computed(() => {
  if (remainingPct.value > 40) return 'bg-emerald-400'
  if (remainingPct.value > 15) return 'bg-amber-400'
  return 'bg-red-400'
})
const textColor = computed(() => {
  if (remainingPct.value > 40) return 'text-emerald-500'
  if (remainingPct.value > 15) return 'text-amber-500'
  return 'text-red-500'
})
function fmt(n: number) { return n.toFixed(4) }

// ── Current user profile ──────────────────────────────────────────────────────
const { data: me } = await useFetch<MeResponse>('/api/settings/me')

const isAdmin = computed(() => me.value?.user.isAdmin ?? false)

// ── Admin data ───────────────────────────────────────────────────────────────
const { data: adminUsers, refresh: refreshUsers } = isAdmin.value
  ? await useFetch<AdminUser[]>('/api/admin/users')
  : { data: ref<AdminUser[] | null>(null), refresh: async () => {} }

const { data: adminGroups, refresh: refreshGroups } = isAdmin.value
  ? await useFetch<GroupInfo[]>('/api/admin/groups')
  : { data: ref<GroupInfo[] | null>(null), refresh: async () => {} }

const { data: budgetData, refresh: refreshBudget } = isAdmin.value
  ? await useFetch<BudgetResponse>('/api/admin/budget')
  : { data: ref<BudgetResponse | null>(null), refresh: async () => {} }

// ── Project members (for users with pipeline.manage role) ────────────────────
const { data: managedProjects } = await useFetch<ManagedProject[]>('/api/settings/project-members')

// Uživatel má vedoucí roli v alespoň jednom projektu?
const isProjectManager = computed(() =>
  !isAdmin.value && (managedProjects.value?.length ?? 0) > 0,
)

// ── Sidebar navigation ────────────────────────────────────────────────────────
type NavSection = 'permissions' | 'signatures' | 'api-tokens' | 'users' | 'projects' | 'budget' | 'system' | 'team'

interface NavItem {
  id: NavSection
  label: string
  icon: string
  adminOnly?: boolean
  permission?: string
}

const NAV_ITEMS: NavItem[] = [
  { id: 'permissions', label: 'Moje oprávnění', icon: 'shield' },
  { id: 'signatures',  label: 'Můj podpis',     icon: 'pen' },
  { id: 'api-tokens',  label: 'MCP tokeny',     icon: 'tag' },
  { id: 'team',        label: 'Tým projektu',    icon: 'users', permission: 'manager' },
  { id: 'users',       label: 'Správa uživatelů', icon: 'users',  adminOnly: true },
  { id: 'projects',    label: 'Správa projektů',  icon: 'folder', adminOnly: true },
  { id: 'budget',      label: 'Správa limitů',    icon: 'chart',  adminOnly: true },
  { id: 'system',      label: 'Systémová nastavení', icon: 'cog', adminOnly: true },
]

const VALID_SECTIONS: NavSection[] = ['permissions', 'signatures', 'api-tokens', 'users', 'projects', 'budget', 'system', 'team']
const initialSection = VALID_SECTIONS.includes(route.query.tab as NavSection) ? (route.query.tab as NavSection) : 'permissions'
const activeSection = ref<NavSection>(initialSection)

watch(activeSection, (newSection) => {
  router.replace({ query: { ...route.query, tab: newSection } })
})

const visibleNav = computed(() =>
  NAV_ITEMS.filter(item => {
    if (item.adminOnly && !isAdmin.value) return false
    if (item.permission === 'manager' && !isProjectManager.value) return false
    return true
  }),
)
</script>

<template>
  <div class="min-h-screen flex flex-col">

    <!-- ── Page header ────────────────────────────────────────────────────── -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-semibold text-gray-800">Nastavení</h1>
        <p class="text-sm text-gray-400 mt-0.5">Přehled účtu a konfigurace integrace.</p>
      </div>

      <!-- Credits widget – admin only -->
      <div v-if="isAdmin" class="w-68 bg-white rounded-2xl border border-gray-100 shadow-sm p-4 shrink-0">
        <div class="flex items-center justify-between mb-1">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-gray-400">OpenRouter kredity</span>
          <button
            class="text-gray-300 hover:text-gray-500 transition-colors"
            :class="{ 'animate-spin': creditsPending }"
            title="Obnovit"
            @click="refreshCredits()"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        <div v-if="creditsPending" class="py-4 flex items-center justify-center text-gray-300">
          <svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        </div>

        <div v-else-if="creditsError" class="py-2 text-center">
          <p class="text-xs text-red-500">{{ creditsError.message }}</p>
          <p class="text-xs text-gray-400 mt-1">Zkontrolujte <code class="bg-gray-50 px-1 rounded">OPEN_ROUTER_MANAGEMENT_KEY</code></p>
        </div>

        <template v-else-if="credits">
          <div class="mt-2 mb-3">
            <span class="text-2xl font-bold" :class="textColor">${{ fmt(credits.remainingCredits) }}</span>
            <span class="text-xs text-gray-400 ml-1">zbývá</span>
          </div>
          <div class="w-full bg-gray-100 rounded-full h-1.5 mb-2 overflow-hidden">
            <div class="h-1.5 rounded-full transition-all duration-700" :class="barColor" :style="`width: ${remainingPct}%`" />
          </div>
          <div class="text-[11px] text-gray-400">
            <span>Využito ${{ fmt(credits.usedCredits) }}</span>
          </div>
        </template>
      </div>
    </div>

    <!-- ── Two-column layout ──────────────────────────────────────────────── -->
    <div class="flex gap-6 flex-1 min-h-0">

      <!-- ══ SIDEBAR ══════════════════════════════════════════════════════ -->
      <aside class="w-56 shrink-0">
        <nav class="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden sticky top-6">

          <!-- User identity pill -->
          <div v-if="me" class="px-4 py-4 border-b border-gray-100">
            <div class="flex items-center gap-2.5">
              <img
                v-if="me.user.image"
                :src="me.user.image"
                :alt="me.user.name"
                class="w-8 h-8 rounded-full shrink-0"
                referrerpolicy="no-referrer"
              />
              <div v-else class="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 shrink-0 flex items-center justify-center text-xs font-bold text-white">
                {{ me.user.name.charAt(0).toUpperCase() }}
              </div>
              <div class="min-w-0">
                <div class="text-sm font-semibold text-gray-800 truncate">{{ me.user.name }}</div>
                <div class="text-[11px] text-gray-400 truncate">{{ me.user.email }}</div>
              </div>
            </div>
          </div>

          <!-- Nav items -->
          <ul class="py-2">
            <li v-for="item in visibleNav" :key="item.id">
              <button
                class="w-full flex items-center gap-3 px-4 py-2.5 text-sm font-medium transition-all duration-150 rounded-none"
                :class="activeSection === item.id
                  ? 'bg-indigo-50 text-indigo-600 border-r-2 border-indigo-500'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-800'"
                @click="activeSection = item.id"
              >
                <!-- shield icon -->
                <svg v-if="item.icon === 'shield'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                <!-- users icon -->
                <svg v-if="item.icon === 'users'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <!-- tag icon -->
                <svg v-if="item.icon === 'tag'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
                </svg>
                <!-- cog icon -->
                <svg v-if="item.icon === 'cog'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <!-- pen icon -->
                <svg v-if="item.icon === 'pen'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
                <!-- folder icon -->
                <svg v-if="item.icon === 'folder'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <!-- chart icon -->
                <svg v-if="item.icon === 'chart'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                {{ item.label }}
              </button>
            </li>
          </ul>
        </nav>
      </aside>

      <!-- ══ MAIN CONTENT ══════════════════════════════════════════════════ -->
      <main class="flex-1 min-w-0">
        <SettingsBudget
          v-if="activeSection === 'budget'"
          :budget-data="budgetData"
          @refresh="refreshBudget()"
        />

        <SettingsPermissions
          v-if="activeSection === 'permissions' && me"
          :me="me"
        />

        <SettingsSignatures
          v-else-if="activeSection === 'signatures'"
        />

        <SettingsApiTokens
          v-else-if="activeSection === 'api-tokens'"
        />

        <SettingsUsers
          v-else-if="activeSection === 'users'"
          :me="me!"
          :admin-users="adminUsers"
          :admin-groups="adminGroups"
          :is-admin="isAdmin"
          @refresh-users="refreshUsers()"
          @refresh-groups="async () => { await refreshGroups(); refreshProjects() }"
        />

        <SettingsProjects
          v-else-if="activeSection === 'projects'"
          :admin-groups="adminGroups"
          @refresh="async () => { await refreshGroups(); refreshProjects() }"
        />

        <SettingsProjectMembers
          v-else-if="activeSection === 'team'"
          :projects="managedProjects ?? []"
        />

        <SettingsSystem
          v-else-if="activeSection === 'system' && isAdmin"
        />
      </main>
    </div>

  </div>
</template>
