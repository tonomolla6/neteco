<script setup lang="ts">
defineProps<{
  quantity: number
  minimum: number
  maximum?: number | null
  step: number
  label: string
  error?: string
}>()
const emit = defineEmits<{ quantity: [value: number]; remove: [] }>()
</script>

<template>
  <div>
    <div class="flex items-center gap-2">
      <QuantityStepper
        :model-value="quantity"
        :minimum="minimum"
        :maximum="maximum"
        :step="step"
        :label="label"
        compact
        @update:model-value="emit('quantity', $event)"
      />
      <button
        type="button"
        class="rounded-lg p-2.5 text-slate-400 transition hover:bg-red-50 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
        :aria-label="`Quitar ${label} del carrito`"
        @click="emit('remove')"
      >
        <UIcon name="i-lucide-trash-2" class="block size-5" />
      </button>
    </div>
    <p v-if="error" role="alert" class="mt-1 text-sm text-red-700">{{ error }}</p>
  </div>
</template>
