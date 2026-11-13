<script setup lang="ts">
/** Filtro rápido por segmentos (Todos · Pendientes · …) con recuento opcional. */
defineProps<{
  options: Array<{ value: string; label: string; count?: number | null; disabled?: boolean }>
  label?: string
}>()
const model = defineModel<string>({ required: true })
</script>

<template>
  <div class="adm-segments" role="group" :aria-label="label ?? 'Filtrar'">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="adm-segment"
      :aria-pressed="model === option.value"
      :disabled="option.disabled"
      @click="model = option.value"
    >
      {{ option.label }}
      <span v-if="option.count !== undefined && option.count !== null" class="adm-segment__count">{{
        option.count
      }}</span>
    </button>
  </div>
</template>
