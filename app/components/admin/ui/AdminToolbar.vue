<script setup lang="ts">
/**
 * Barra de filtros de un listado: búsqueda compacta a la izquierda, filtros a continuación
 * y acciones secundarias (exportar, columnas…) a la derecha. Sustituye a los buscadores
 * a ancho completo que encabezaban las pantallas.
 */
const props = withDefaults(
  defineProps<{ searchable?: boolean; placeholder?: string; debounce?: number; searchLabel?: string }>(),
  { searchable: true, placeholder: 'Buscar…', debounce: 250, searchLabel: 'Buscar en el listado' }
)
const search = defineModel<string>('search', { default: '' })
const draft = ref(search.value)
let timer: ReturnType<typeof setTimeout> | undefined
watch(draft, (value) => {
  clearTimeout(timer)
  timer = setTimeout(() => (search.value = value.trim()), props.debounce)
})
watch(search, (value) => {
  if (value !== draft.value.trim()) draft.value = value
})
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="adm-toolbar" role="search">
    <label v-if="searchable" class="adm-toolbar__search">
      <span class="sr-only">{{ searchLabel }}</span>
      <UIcon name="i-lucide-search" class="size-4" />
      <input v-model="draft" type="search" :placeholder="placeholder" data-slot="adm-search" />
    </label>
    <slot />
    <div v-if="$slots.actions" class="adm-toolbar__end">
      <slot name="actions" />
    </div>
  </div>
</template>
