<script setup lang="ts">
/** Estado vacío, sin resultados o de error: siempre explica qué pasa y ofrece la siguiente acción. */
withDefaults(
  defineProps<{
    title: string
    description?: string
    icon?: string
    variant?: 'empty' | 'filtered' | 'error'
    compact?: boolean
  }>(),
  { description: undefined, icon: 'i-lucide-inbox', variant: 'empty', compact: false }
)
</script>

<template>
  <div class="adm-empty" :class="[compact && 'adm-empty--compact', variant === 'error' && 'adm-empty--error']">
    <span class="adm-empty__icon">
      <UIcon
        :name="variant === 'error' ? 'i-lucide-triangle-alert' : variant === 'filtered' ? 'i-lucide-search-x' : icon"
        class="size-5"
      />
    </span>
    <p class="adm-empty__title">{{ title }}</p>
    <p v-if="description" class="adm-empty__text">{{ description }}</p>
    <div v-if="$slots.default" class="mt-4 flex flex-wrap justify-center gap-2">
      <slot />
    </div>
  </div>
</template>
