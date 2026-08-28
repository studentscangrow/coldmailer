<script setup lang="ts">
interface Contact {
  id: string; address: string | null; firstName: string | null; lastName: string | null
  role: string | null; contactType: string | null; note: string | null; priority: number
}

defineProps<{
  canonicalName: string
  payload: Record<string, unknown>
  contacts: Contact[]
}>()

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" @click.self="emit('close')">
    <div class="bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <h2 class="font-semibold text-gray-800">{{ canonicalName }}</h2>
        <button class="text-gray-400 hover:text-gray-600 text-xl leading-none" @click="emit('close')">×</button>
      </div>
      <div class="overflow-y-auto p-6 flex-1">
        <PartnersPartnerDetailContent :payload="payload" :contacts="contacts" />
      </div>
    </div>
  </div>
</template>
