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
        data-cart-remove
        class="inline-flex min-h-11 items-center rounded-[var(--radius-control)] px-2 text-[13px] font-medium text-[var(--text-muted)] underline hover:text-[var(--ui-error)]"
        :aria-label="`Quitar ${label} del carrito`"
        @click="emit('remove')"
      >
        Quitar
      </button>
    </div>
    <p v-if="error" role="alert" class="mt-1 text-sm text-red-700">{{ error }}</p>
  </div>
</template>
