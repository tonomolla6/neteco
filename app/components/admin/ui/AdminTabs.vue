<script setup lang="ts">
/** Pestañas locales de una pantalla (secciones de un formulario largo, vistas de un detalle). */
defineProps<{ tabs: Array<{ value: string; label: string; count?: number | null }>; label?: string }>()
const model = defineModel<string>({ required: true })
</script>

<template>
  <div class="adm-tabs" role="tablist" :aria-label="label ?? 'Apartados'">
    <button
      v-for="entry in tabs"
      :key="entry.value"
      type="button"
      role="tab"
      class="adm-tab"
      :aria-selected="model === entry.value"
      @click="model = entry.value"
    >
      {{ entry.label }}
      <span v-if="entry.count !== undefined && entry.count !== null" class="adm-segment__count">{{ entry.count }}</span>
    </button>
  </div>
</template>
