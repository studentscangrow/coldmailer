<script setup lang="ts">
interface ApiTokenItem {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

const toast = useToast()
const { data: tokens, refresh } = await useFetch<ApiTokenItem[]>('/api/settings/api-tokens')

const activeTokens = computed(() => (tokens.value ?? []).filter(t => !t.revokedAt))

const creating = ref(false)
const newName = ref('')
const saving = ref(false)
const justCreatedToken = ref<string | null>(null)

function startNew() {
  newName.value = ''
  justCreatedToken.value = null
  creating.value = true
}

async function create() {
  if (!newName.value.trim() || saving.value) return
  saving.value = true
  try {
    const res = await $fetch<{ id: string; name: string; token: string }>('/api/settings/api-tokens', {
      method: 'POST',
      body: { name: newName.value.trim() },
    })
    justCreatedToken.value = res.token
    await refresh()
  } catch (err: any) {
    toast.show(err?.data?.message || err?.message || 'Nepodařilo se vytvořit token', 'error')
  } finally {
    saving.value = false
  }
}

function closeCreate() {
  creating.value = false
  justCreatedToken.value = null
}

async function revoke(t: ApiTokenItem) {
  if (!confirm(`Zneplatnit token "${t.name}"? Agenti, kteří ho používají, ztratí přístup okamžitě.`)) return
  try {
    await $fetch(`/api/settings/api-tokens/${t.id}`, { method: 'DELETE' })
    toast.show('Token zneplatněn', 'success')
    await refresh()
  } catch (err: any) {
    toast.show(err?.data?.message || err?.message || 'Nepodařilo se zneplatnit token', 'error')
  }
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const copied = ref(false)
async function copyToken() {
  if (!justCreatedToken.value) return
  await navigator.clipboard.writeText(justCreatedToken.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <div>
        <h2 class="text-lg font-semibold text-gray-800">MCP / API tokeny</h2>
        <p class="text-xs text-gray-400 mt-0.5">Osobní tokeny pro připojení AI agentů (např. přes MCP) pod vaší identitou a oprávněními.</p>
      </div>
      <button
        v-if="!creating"
        class="bg-primary text-white px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
        @click="startNew"
      >+ Nový token</button>
    </div>

    <!-- Create form / just-created reveal -->
    <div v-if="creating" class="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 mb-6">
      <template v-if="!justCreatedToken">
        <h3 class="text-sm font-semibold text-gray-800 mb-3">Nový token</h3>
        <label class="block text-xs font-medium text-gray-500 mb-1">Název (např. "Claude Code")</label>
        <input
          v-model="newName"
          type="text"
          class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          placeholder="Claude Code"
          @keyup.enter="create"
        />
        <div class="flex gap-2 mt-4 justify-end">
          <button class="text-sm text-gray-400 hover:text-gray-600 px-4 py-2" @click="closeCreate">Zrušit</button>
          <button
            class="bg-primary text-white px-5 py-2 rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            :disabled="!newName.trim() || saving"
            @click="create"
          >{{ saving ? 'Vytvářím…' : 'Vytvořit' }}</button>
        </div>
      </template>

      <template v-else>
        <h3 class="text-sm font-semibold text-gray-800 mb-2">Token vytvořen</h3>
        <p class="text-xs text-amber-600 bg-amber-50 border border-amber-200/60 rounded-lg px-3 py-2 mb-3">
          Zkopírujte si ho teď — z bezpečnostních důvodů se znovu nezobrazí.
        </p>
        <div class="flex items-center gap-2">
          <code class="flex-1 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 break-all">{{ justCreatedToken }}</code>
          <button
            class="text-xs bg-primary/10 text-primary px-3 py-2 rounded-lg hover:bg-primary/20 transition-colors font-medium shrink-0"
            @click="copyToken"
          >{{ copied ? 'Zkopírováno' : 'Kopírovat' }}</button>
        </div>
        <div class="flex justify-end mt-4">
          <button class="text-sm text-gray-500 hover:text-gray-700 px-4 py-2" @click="closeCreate">Hotovo</button>
        </div>
      </template>
    </div>

    <!-- Token list -->
    <div v-if="activeTokens.length === 0 && !creating" class="flex flex-col items-center text-center gap-2 py-8 bg-gray-50 rounded-xl border border-dashed border-gray-200">
      <p class="text-sm font-medium text-gray-600">Zatím nemáte žádný API token</p>
      <button
        class="bg-primary text-white px-4 py-1.5 rounded-lg text-xs font-medium hover:opacity-90 transition-opacity mt-1"
        @click="startNew"
      >+ Vytvořit token</button>
    </div>

    <div v-else-if="!creating" class="bg-white rounded-2xl border border-gray-100 shadow-sm divide-y divide-gray-100">
      <div
        v-for="t in activeTokens"
        :key="t.id"
        class="flex items-center justify-between px-5 py-3"
      >
        <div>
          <div class="text-sm font-medium text-gray-800">{{ t.name }}</div>
          <div class="text-[11px] text-gray-400 mt-0.5">
            Vytvořeno {{ fmtDate(t.createdAt) }} · Naposledy použito {{ fmtDate(t.lastUsedAt) }}
          </div>
        </div>
        <button
          class="text-xs text-gray-400 hover:text-red-500 px-2.5 py-1 rounded transition-colors"
          @click="revoke(t)"
        >Zneplatnit</button>
      </div>
    </div>
  </div>
</template>
