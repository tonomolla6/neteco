<script setup lang="ts">
/** Bloque con título fuera de tarjeta: agrupa varias tarjetas o una rejilla bajo un mismo epígrafe. */
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <section class="adm-section">
    <div class="adm-section__head">
      <div class="min-w-0">
        <h2 class="adm-section__title">{{ title }}</h2>
        <p v-if="description" class="adm-help">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
    <slot />
  </section>
</template>
