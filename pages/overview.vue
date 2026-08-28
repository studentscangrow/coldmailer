<script setup lang="ts">
import { NEGOTIATION_STATUS_LABELS, NEGOTIATION_STATUS_COLORS } from '~/utils/negotiationStatus'

definePageMeta({ middleware: 'auth' })

interface Note { id: string; content: string; createdAt: string; creatorName: string }
interface AssigneeUser { id: string; name: string; image: string | null }
interface OverviewPartner {
  id: string
  canonicalName: string
  dealConfidence: 'MOZNA' | 'DOMLUVENO'
  negotiationStatus: string | null
  discordThreadUrl: string | null
  fulfillmentDocUrl: string | null
  fulfillment: { myToThem: string | null; themToUs: string | null }
  todoList: string | null
  openTasks: number
  notes: Note[]
  assignees: AssigneeUser[]
  lastActivityAt: string | null
}

const includeUncertain = ref(false)

const { data, pending, error } = await useFetch<{ partners: OverviewPartner[] }>('/api/partners/overview', {
  query: computed(() => ({ includeUncertain: includeUncertain.value ? 'true' : 'false' })),
})

const partners = computed(() => data.value?.partners ?? [])

const expandedIds = ref(new Set<string>())
function toggleExpand(id: string) {
  const s = new Set(expandedIds.value)
  s.has(id) ? s.delete(id) : s.add(id)
  expandedIds.value = s
}

const notesExpanded = ref(new Set<string>())
function toggleNotesExpand(id: string) {
  const s = new Set(notesExpanded.value)
  s.has(id) ? s.delete(id) : s.add(id)
  notesExpanded.value = s
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
</script>

<template>
  <div>
    <div class="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold text-gray-800">Přehled</h1>
        <p class="text-sm text-gray-400 mt-1">Partneři, se kterými je spolupráce domluvená{{ includeUncertain ? ' (nebo možná)' : '' }}</p>
      </div>
      <label class="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none shrink-0">
        Zahrnout nejisté
        <button
          :class="[
            'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 cursor-pointer',
            includeUncertain ? 'bg-indigo-600' : 'bg-gray-200',
          ]"
          role="switch"
          :aria-checked="includeUncertain"
          @click="includeUncertain = !includeUncertain"
        >
          <span
            :class="[
              'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200',
              includeUncertain ? 'translate-x-4' : 'translate-x-0',
            ]"
          />
        </button>
      </label>
    </div>

    <div v-if="error" class="text-center py-16 text-gray-400 text-sm">
      {{ (error.data as any)?.message || 'Nemáte přístup k Přehledu.' }}
    </div>

    <div v-else class="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-gray-100 bg-gray-50 text-left">
            <th class="px-4 py-3 w-8" />
            <th class="px-4 py-3 font-medium text-gray-500 text-xs">Partner</th>
            <th class="px-4 py-3 font-medium text-gray-500 text-xs">Stav jednání</th>
            <th class="px-4 py-3 font-medium text-gray-500 text-xs">Odkazy</th>
            <th class="px-4 py-3 font-medium text-gray-500 text-xs text-center">Úkoly</th>
            <th class="px-4 py-3 font-medium text-gray-500 text-xs">Poslední aktivita</th>
            <th class="px-4 py-3 w-7" />
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
          <tr v-else-if="partners.length === 0">
            <td colspan="7" class="text-center py-12 text-gray-400 text-sm">
              {{ includeUncertain ? 'Žádní partneři s domluvenou nebo možnou spoluprací.' : 'Žádní partneři s domluvenou spoluprací.' }}
            </td>
          </tr>
          <template v-else>
            <template v-for="p in partners" :key="p.id">
              <tr class="hover:bg-gray-50 cursor-pointer transition-colors" @click="toggleExpand(p.id)">
                <td class="px-4 py-3 text-center text-base" :title="p.dealConfidence === 'DOMLUVENO' ? 'Bude!' : 'Možná'">
                  {{ p.dealConfidence === 'DOMLUVENO' ? '✅' : '❓' }}
                </td>
                <td class="px-4 py-3 font-medium text-gray-800">{{ p.canonicalName }}</td>
                <td class="px-4 py-3">
                  <span
                    v-if="p.negotiationStatus"
                    :class="['text-xs px-2 py-0.5 rounded-full font-medium', NEGOTIATION_STATUS_COLORS[p.negotiationStatus] ?? 'bg-gray-100 text-gray-500']"
                  >{{ NEGOTIATION_STATUS_LABELS[p.negotiationStatus] }}</span>
                  <span v-else class="text-xs text-gray-300">–</span>
                </td>
                <td class="px-4 py-3">
                  <div class="flex items-center gap-1.5">
                    <a
                      v-if="p.discordThreadUrl"
                      :href="p.discordThreadUrl"
                      target="_blank"
                      rel="noopener"
                      title="Discord vlákno"
                      class="inline-flex items-center justify-center w-6 h-6 rounded-lg bg-[#5865F2] text-white hover:bg-[#4752C4] transition-colors"
                      @click.stop
                    >
                      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.522 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1568 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" /></svg>
                    </a>
                    <a
                      v-if="p.fulfillmentDocUrl"
                      :href="p.fulfillmentDocUrl"
                      target="_blank"
                      rel="noopener"
                      title="Návrh plnění"
                      class="inline-flex items-center justify-center w-6 h-6 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50 transition-colors"
                      @click.stop
                    >
                      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    </a>
                    <span v-if="!p.discordThreadUrl && !p.fulfillmentDocUrl" class="text-xs text-gray-300">–</span>
                  </div>
                </td>
                <td class="px-4 py-3 text-center">
                  <span v-if="p.openTasks > 0" class="text-xs font-semibold text-amber-600">{{ p.openTasks }}</span>
                  <span v-else class="text-xs text-gray-300">–</span>
                </td>
                <td class="px-4 py-3 text-xs text-gray-400">{{ p.lastActivityAt ? fmtDate(p.lastActivityAt) : '–' }}</td>
                <td class="px-4 py-3">
                  <svg class="w-3 h-3 text-gray-300 transition-transform" :class="expandedIds.has(p.id) ? 'rotate-180' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </td>
              </tr>

              <tr v-if="expandedIds.has(p.id)" class="bg-indigo-50/20">
                <td />
                <td colspan="6" class="px-4 py-4 space-y-4">
                  <div class="flex items-center gap-2 flex-wrap">
                    <NuxtLink :to="`/negotiations/${p.id}`" class="text-xs text-indigo-500 hover:underline font-medium" @click.stop>Otevřít jednání ↗</NuxtLink>
                    <span v-if="p.assignees.length" class="text-xs text-gray-400">· {{ p.assignees.map(a => a.name).join(', ') }}</span>
                  </div>

                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <NegotiationsFulfillmentChecklist
                      title="My jim" theme="blue" :content="p.fulfillment.myToThem"
                      :can-edit="false" :editing="false" editing-value="" :toggling-line-index="null"
                    />
                    <NegotiationsFulfillmentChecklist
                      title="Oni nám" theme="green" :content="p.fulfillment.themToUs"
                      :can-edit="false" :editing="false" editing-value="" :toggling-line-index="null"
                    />
                  </div>

                  <NegotiationsTodoChecklist
                    :content="p.todoList"
                    :can-edit="false" :editing="false" editing-value="" :toggling-line-index="null"
                  />

                  <div v-if="p.notes.length">
                    <p class="text-xs font-semibold text-gray-500 mb-1">Poznámky ({{ p.notes.length }})</p>
                    <div class="space-y-2">
                      <div
                        v-for="n in (notesExpanded.has(p.id) ? p.notes : p.notes.slice(0, 1))"
                        :key="n.id"
                        class="text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2"
                      >
                        <div class="flex items-center justify-between text-[10px] text-gray-400 mb-0.5">
                          <span>{{ n.creatorName }}</span>
                          <span>{{ fmtDate(n.createdAt) }}</span>
                        </div>
                        {{ n.content }}
                      </div>
                    </div>
                    <button
                      v-if="p.notes.length > 1"
                      class="text-[11px] text-indigo-500 hover:underline mt-1"
                      @click.stop="toggleNotesExpand(p.id)"
                    >{{ notesExpanded.has(p.id) ? 'Skrýt' : `Zobrazit všechny (${p.notes.length})` }}</button>
                  </div>
                </td>
              </tr>
            </template>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>
