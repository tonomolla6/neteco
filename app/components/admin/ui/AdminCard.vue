<script setup lang="ts">
/** Superficie única del panel: título opcional, acciones a la derecha, cuerpo y pie. */
withDefaults(
  defineProps<{
    title?: string
    description?: string
    /** Sin relleno en el cuerpo: para tablas y listas que llegan al borde. */
    flush?: boolean
    as?: string
  }>(),
  { title: undefined, description: undefined, flush: false, as: 'section' }
)
</script>

<template>
  <component :is="as" class="adm-card">
    <div v-if="title || $slots.title || $slots.actions" class="adm-card__head">
      <div class="min-w-0">
        <h2 class="adm-card__title">
          <slot name="title">{{ title }}</slot>
        </h2>
        <p v-if="description" class="adm-card__hint">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
    <div class="adm-card__body" :class="flush && 'adm-card__body--flush'">
      <slot />
    </div>
    <div v-if="$slots.footer" class="adm-card__foot">
      <slot name="footer" />
    </div>
  </component>
</template>
