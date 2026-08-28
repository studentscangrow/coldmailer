<script setup lang="ts">
const { user, loggedIn, clear } = useUserSession()
const { groups, activeProject, activeGroup, setProject } = useActiveProject()

// "Přehled" is only for admins and users with the "Vedení obchodu" role
// (project.pipeline.manage) in the currently active project.
interface MeProjectRole { permissions: string[]; project: { id: string } }
const { data: me } = useFetch<{ user: { isAdmin: boolean }; projectRoles: MeProjectRole[] }>('/api/settings/me', {
  key: 'me-for-nav',
})
const canSeeOverview = computed(() => {
  if (!me.value || !activeProject.value) return false
  if (me.value.user.isAdmin) return true
  return me.value.projectRoles.some(r => r.project.id === activeProject.value!.id && r.permissions.includes('project.pipeline.manage'))
})

// `/negotiations` and `/outreach` each have a sibling `[id].vue` detail page with
// no shared parent route, so Vue Router's built-in active-class matching doesn't
// consider the detail page "active" for the list-page NuxtLink — check manually.
const route = useRoute()
function isNavActive(prefix: string) {
  return route.path === prefix || route.path.startsWith(prefix + '/')
}

// Shared with useProjectOutreach — lets us show that an AI job (Value Alignment /
// email draft) is still running even after navigating away from the Oslovení page.
const outreachExecuting = useState<'alignment' | 'draft' | null>('outreachExecuting', () => null)

const projectMenuOpen = ref(false)

const projects = computed(() =>
  groups.value.flatMap(group =>
    group.projects.map(project => ({ ...project, group })),
  ),
)

const groupsWithProjects = computed(() => {
  return groups.value.filter(g => g.projects && g.projects.length > 0)
})

const hasMultipleCategories = computed(() => {
  return groupsWithProjects.value.length > 1
})

function selectProject(id: string) {
  projectMenuOpen.value = false
  setProject(id)
}

function closeProjectMenu(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest('.project-selector')) projectMenuOpen.value = false
}
onMounted(() => document.addEventListener('click', closeProjectMenu))
onBeforeUnmount(() => document.removeEventListener('click', closeProjectMenu))

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  await navigateTo('/login')
}
</script>

<template>
  <nav class="bg-white border-b border-gray-100 shadow-sm shrink-0">
    <div class="w-full px-5 h-16 flex items-center justify-between">
      <div class="flex items-center gap-6">
        <NuxtLink to="/" class="text-lg font-semibold tracking-tight">
          <span class="text-primary">S</span><span class="text-success">C</span><span class="text-danger">G</span> ColdMailer
        </NuxtLink>

        <!-- Project selector -->
        <div v-if="loggedIn && (projects.length > 0 || groups.length > 0)" class="relative project-selector">
          <button
            class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-sm font-medium border transition-colors"
            :class="projectMenuOpen ? 'border-gray-300 bg-gray-50' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'"
            @click.stop="projectMenuOpen = !projectMenuOpen"
          >
            <span class="w-2.5 h-2.5 rounded-full shrink-0" :style="{ backgroundColor: activeGroup?.color ?? '#6366f1' }" />
            <span v-if="activeProject" class="text-gray-700 text-xs sm:text-sm">{{ activeProject.name }}</span>
            <span v-else class="text-gray-400 text-xs sm:text-sm">Vyberte projekt</span>
            
            <span v-if="activeProject && hasMultipleCategories" class="text-[10px] text-gray-400 shrink-0 ml-1">({{ activeGroup?.name }})</span>
            <svg class="w-3.5 h-3.5 text-gray-400 transition-transform ml-1" :class="projectMenuOpen ? 'rotate-180' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
          </button>

          <div
            v-if="projectMenuOpen"
            class="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded-xl shadow-lg py-1.5 w-60"
          >
            <!-- 1. MULTIPLE CATEGORIES MODE (Nested/Multi-level Dropdown) -->
            <div v-if="hasMultipleCategories">
              <div class="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Typ projektu / Projekt</div>
              <div 
                v-for="group in groupsWithProjects" 
                :key="group.id" 
                class="relative group/item border-t border-gray-50 first:border-0 pt-0.5 first:pt-0"
              >
                <!-- Category trigger (not selectable) -->
                <div class="w-full text-left px-3 py-2 text-xs font-semibold text-gray-700 flex items-center justify-between hover:bg-gray-50 cursor-default select-none">
                  <div class="flex items-center gap-2">
                    <span class="w-2.5 h-2.5 rounded-full shrink-0" :style="{ backgroundColor: group.color }" />
                    {{ group.name }}
                  </div>
                  <svg class="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                  </svg>
                </div>

                <!-- Submenu (projects of this category) -->
                <div class="absolute left-full top-0 -ml-2 pl-3.5 hidden group-hover/item:block z-[60]">
                <div class="bg-white border border-gray-200 rounded-xl shadow-xl py-1.5 w-56 border-l-2" :style="{ borderLeftColor: group.color }">
                  <button
                    v-for="project in group.projects"
                    :key="project.id"
                    class="w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-gray-50 flex items-center gap-2"
                    :class="project.id === activeProject?.id ? 'bg-indigo-50/50 font-semibold text-indigo-700' : 'text-gray-600'"
                    @click="selectProject(project.id)"
                  >
                    <span class="w-1.5 h-1.5 rounded-full" :class="project.id === activeProject?.id ? 'bg-indigo-500' : 'bg-transparent'" />
                    {{ project.name }}
                  </button>
                </div>
                </div>
              </div>
            </div>

            <!-- 2. SINGLE CATEGORY MODE (Flat List of Projects) -->
            <div v-else-if="projects.length > 0">
              <div class="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Projekty</div>
              <button
                v-for="project in projects"
                :key="project.id"
                class="w-full text-left px-3 py-2 text-xs transition-colors hover:bg-gray-50 flex items-center gap-2.5"
                :class="project.id === activeProject?.id ? 'bg-indigo-50/50 font-semibold text-indigo-700' : 'text-gray-600'"
                @click="selectProject(project.id)"
              >
                <span class="w-2.5 h-2.5 rounded-full shrink-0" :style="{ backgroundColor: project.group.color }" />
                {{ project.name }}
              </button>
            </div>

            <!-- 3. NO PROJECTS AT ALL -->
            <div v-else class="px-4 py-3 text-xs text-gray-400 italic text-center">
              Žádné projekty k dispozici
            </div>
          </div>
        </div>

        <template v-if="loggedIn">
          <NuxtLink
            to="/partners"
            class="text-sm text-gray-500 hover:text-gray-800 transition-colors"
            active-class="text-gray-800 font-medium"
          >
            Partneři
          </NuxtLink>
          <NuxtLink
            to="/outreach"
            class="text-sm transition-colors inline-flex items-center gap-1.5"
            :class="isNavActive('/outreach') ? 'text-gray-800 font-medium' : 'text-gray-500 hover:text-gray-800'"
          >
            Oslovení
            <span
              v-if="outreachExecuting"
              class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"
              :title="outreachExecuting === 'alignment' ? 'Probíhá Value Alignment' : 'Probíhá generování e-mailu'"
            />
          </NuxtLink>
          <NuxtLink
            to="/negotiations"
            class="text-sm transition-colors"
            :class="isNavActive('/negotiations') ? 'text-gray-800 font-medium' : 'text-gray-500 hover:text-gray-800'"
          >
            Jednání
          </NuxtLink>
          <NuxtLink
            v-if="canSeeOverview"
            to="/overview"
            class="text-sm text-gray-500 hover:text-gray-800 transition-colors"
            active-class="text-gray-800 font-medium"
          >
            Přehled
          </NuxtLink>
          <NuxtLink
            to="/library"
            class="text-sm text-gray-500 hover:text-gray-800 transition-colors"
            active-class="text-gray-800 font-medium"
          >
            Databáze
          </NuxtLink>
          <NuxtLink
            to="/settings"
            class="text-sm text-gray-500 hover:text-gray-800 transition-colors"
            active-class="text-gray-800 font-medium"
          >
            Nastavení
          </NuxtLink>
        </template>
      </div>

      <div v-if="loggedIn && user" class="flex items-center gap-3">
        <span class="text-sm text-gray-600 hidden sm:block">{{ user.name }}</span>
        <img
          v-if="user.image"
          :src="user.image"
          :alt="user.name"
          class="w-8 h-8 rounded-full object-cover ring-2 ring-gray-100"
          referrerpolicy="no-referrer"
        />
        <div
          v-else
          class="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white text-xs font-semibold"
        >
          {{ user.name.charAt(0).toUpperCase() }}
        </div>
        <button
          class="text-xs text-gray-400 hover:text-danger transition-colors"
          @click="logout"
        >
          Odhlásit se
        </button>
      </div>
    </div>
  </nav>
</template>
