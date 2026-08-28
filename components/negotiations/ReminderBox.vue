<script setup lang="ts">
import { NEGOTIATION_STATUS_LABELS, lastActivityColor, isReminderWorthy } from '~/utils/negotiationStatus'

interface ReminderTemplate { id: string; name: string }

const props = defineProps<{
  negotiationStatus: string | null
  lastActivityAt: string | null
  reminderTemplates: ReminderTemplate[]
  canEdit: boolean
  generating: boolean
  emailCount: number
}>()

const emit = defineEmits<{ remind: [emailDraftId: string | null] }>()

const colorClass = computed(() => {
  const c = lastActivityColor(props.negotiationStatus, props.lastActivityAt)
  return c || 'bg-gray-50 text-gray-500'
})

const lastActivityLabel = computed(() => {
  if (!props.lastActivityAt) return 'zatím žádná aktivita'
  return new Date(props.lastActivityAt).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' })
})

const statusLabel = computed(() => NEGOTIATION_STATUS_LABELS[props.negotiationStatus ?? ''] ?? '—')

const showReminder = computed(() =>
  props.canEdit
  && props.negotiationStatus === 'WAITING_FOR_THEM'
  && isReminderWorthy(props.negotiationStatus, props.lastActivityAt),
)

const selectedTemplateId = ref('')

watch(() => props.reminderTemplates, (tpls) => {
  if (!selectedTemplateId.value && tpls.length) selectedTemplateId.value = tpls[0].id
}, { immediate: true })
</script>

<template>
  <div v-if="emailCount < 3" class="rounded-lg px-4 py-3 mb-6 flex flex-wrap items-center gap-x-4 gap-y-2" :class="colorClass">
    <div class="text-xs font-medium">
      Poslední aktivita: <span class="font-semibold">{{ lastActivityLabel }}</span>
      <span class="opacity-70"> · {{ statusLabel }}</span>
    </div>

    <div v-if="showReminder" class="flex items-center gap-2 ml-auto">
      <select
        v-if="reminderTemplates.length"
        v-model="selectedTemplateId"
        class="text-xs rounded-md border border-black/10 bg-white/80 px-2 py-1.5 text-gray-700 focus:outline-none focus:ring-2 focus:ring-black/10"
        :disabled="generating"
      >
        <option v-for="t in reminderTemplates" :key="t.id" :value="t.id">{{ t.name }}</option>
      </select>

      <button
        class="text-xs px-3 py-1.5 rounded-md bg-white/90 text-gray-800 font-semibold hover:bg-white transition-colors flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
        :disabled="generating"
        @click="emit('remind', selectedTemplateId || null)"
      >
        <svg v-if="generating" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
        {{ generating ? 'Generuji…' : 'Připomenout se' }}
      </button>
    </div>
  </div>
</template>
