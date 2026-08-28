<script setup lang="ts">
const SIZE_LABELS: Record<string, string> = {
  micro: '<10', small: '10–50', medium: '50–500', large: '500–5k', enterprise: '>5k',
}
const CONTACT_TYPE_COLORS: Record<string, string> = {
  PR: 'bg-blue-100 text-blue-700', HR: 'bg-purple-100 text-purple-700',
  Marketing: 'bg-orange-100 text-orange-700', CEO: 'bg-red-100 text-red-700',
  General: 'bg-gray-100 text-gray-600',
}

interface Contact {
  id: string; address: string | null; firstName: string | null; lastName: string | null
  role: string | null; contactType: string | null; note: string | null; priority: number
}

const props = defineProps<{
  payload: Record<string, unknown>
  contacts: Contact[]
}>()

const isProfiled = computed(() => !!props.payload.summary)

function getStr(key: string): string {
  return String(props.payload[key] ?? '')
}

function getArr(key: string): string[] {
  const v = props.payload[key]
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string' && v) return [v]
  return []
}

interface EvidenceEntry { event: string; role: string; year: string; source: string }
const evidence = computed<EvidenceEntry[]>(() => {
  const v = props.payload.partnershipEvidence
  if (!Array.isArray(v)) return []
  return v.map((e) => {
    const o = (e ?? {}) as Record<string, unknown>
    return { event: String(o.event ?? ''), role: String(o.role ?? ''), year: String(o.year ?? ''), source: String(o.source ?? '') }
  })
})
</script>

<template>
  <div class="space-y-3">
    <!-- Profiled partner: rich detail -->
    <template v-if="isProfiled">
      <p class="text-sm text-gray-700 leading-relaxed">{{ payload.summary }}</p>

      <div class="flex flex-wrap gap-1.5">
        <span v-if="payload.industry" class="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-600">{{ payload.industry }}</span>
        <span v-if="payload.size" class="text-xs px-2 py-0.5 rounded bg-purple-50 text-purple-600">{{ SIZE_LABELS[String(payload.size)] ?? payload.size }}</span>
        <span v-if="payload.parentCompany" class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">{{ payload.parentCompany }}</span>
      </div>

      <!-- Links -->
      <div v-if="getStr('website') || getStr('linkedinUrl') || getStr('instagramUrl')" class="flex flex-wrap gap-3">
        <a v-if="getStr('website')" :href="getStr('website')" target="_blank" rel="noopener" class="text-xs text-indigo-500 hover:underline">Web ↗</a>
        <a v-if="getStr('linkedinUrl')" :href="getStr('linkedinUrl')" target="_blank" rel="noopener" class="text-xs text-indigo-500 hover:underline">LinkedIn ↗</a>
        <a v-if="getStr('instagramUrl')" :href="getStr('instagramUrl')" target="_blank" rel="noopener" class="text-xs text-indigo-500 hover:underline">Instagram ↗</a>
      </div>

      <!-- Activities -->
      <div v-if="getArr('activities').length > 0">
        <p class="text-xs font-medium text-gray-500 mb-1">Aktivity</p>
        <div class="flex flex-wrap gap-1">
          <span v-for="(a, i) in getArr('activities')" :key="i" class="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600">{{ a }}</span>
        </div>
      </div>

      <!-- Partnership style -->
      <div v-if="getArr('partnershipStyle').length > 0">
        <p class="text-xs font-medium text-gray-500 mb-1">Styl partnerství</p>
        <div class="flex flex-wrap gap-1">
          <span v-for="(s, i) in getArr('partnershipStyle')" :key="i" class="text-xs px-2 py-0.5 rounded bg-amber-50 text-amber-600">{{ s }}</span>
        </div>
      </div>

      <!-- Recent highlights -->
      <div v-if="getArr('recentHighlights').length > 0">
        <p class="text-xs font-medium text-gray-500 mb-1">Poslední novinky</p>
        <ul class="text-xs text-gray-600 space-y-0.5 list-disc list-inside">
          <li v-for="(h, i) in getArr('recentHighlights')" :key="i">{{ h }}</li>
        </ul>
      </div>

      <!-- Partnership evidence -->
      <div v-if="evidence.length > 0">
        <p class="text-xs font-medium text-gray-500 mb-1">Doklady o partnerství</p>
        <div class="space-y-1">
          <div v-for="(e, i) in evidence" :key="i" class="text-xs text-gray-600">
            <span class="font-medium">{{ e.event }}</span>
            <span v-if="e.role"> — {{ e.role }}</span>
            <span v-if="e.year" class="text-gray-400"> ({{ e.year }})</span>
            <a v-if="e.source" :href="e.source" target="_blank" rel="noopener" class="text-indigo-500 hover:underline ml-1" @click.stop>zdroj ↗</a>
          </div>
        </div>
      </div>

      <!-- Contacts -->
      <div v-if="contacts.length > 0">
        <p class="text-xs font-medium text-gray-500 mb-1">Kontakty</p>
        <div class="space-y-1">
          <div v-for="c in contacts" :key="c.id" class="flex items-center gap-2 text-xs text-gray-600">
            <span :class="['px-1.5 py-0.5 rounded flex-shrink-0 text-xs', CONTACT_TYPE_COLORS[String(c.contactType || '')] ?? 'bg-gray-100 text-gray-500']">{{ c.contactType || 'kontakt' }}</span>
            <span class="font-medium">{{ [c.firstName, c.lastName].filter(Boolean).join(' ') || 'generický' }}</span>
            <span v-if="c.role && (c.firstName || c.lastName)" class="text-gray-400">{{ c.role }}</span>
            <a v-if="c.address" :href="`mailto:${c.address}`" class="text-indigo-500 hover:underline ml-auto" @click.stop>{{ c.address }}</a>
            <span v-else class="text-gray-300 italic ml-auto">bez emailu</span>
          </div>
        </div>
      </div>

      <!-- Research notes -->
      <p v-if="getStr('researchNotes')" class="text-xs text-gray-500 italic">{{ payload.researchNotes }}</p>
    </template>

    <!-- Unprofiled partner: basic info -->
    <template v-else>
      <p v-if="payload.description" class="text-sm text-gray-600 leading-relaxed">{{ payload.description }}</p>
      <p v-else class="text-xs text-gray-400">Tento partner zatím nebyl profilován.</p>
    </template>
  </div>
</template>
