<script setup lang="ts">
/**
 * Superficie base del sistema. Sustituye a las 49 repeticiones de
 * `rounded-2xl border border-slate-200 bg-white p-6` que había esparcidas por `app/`.
 *
 * `tone` decide el peso visual, no el color de marca:
 *   default  → tarjeta normal
 *   sunken   → agrupa contenido secundario dentro de otra superficie
 *   accent   → una sola por pantalla como máximo; marca la acción principal
 */
withDefaults(
  defineProps<{
    as?: string
    tone?: 'default' | 'sunken' | 'accent'
    padding?: 'none' | 'sm' | 'md' | 'lg'
    raised?: boolean
  }>(),
  { as: 'section', tone: 'default', padding: 'md', raised: false }
)

const PADDING = { none: '', sm: 'p-4', md: 'p-5 sm:p-6', lg: 'p-6 sm:p-8' }
const TONE = {
  default: 'border-[var(--border)] bg-[var(--surface)]',
  sunken: 'border-[var(--border)] bg-[var(--surface-sunken)]',
  accent: 'border-neteco-200 bg-neteco-50'
}
</script>

<template>
  <component
    :is="as"
    class="rounded-[var(--radius-panel)] border"
    :class="[TONE[tone], PADDING[padding], raised && 'shadow-[var(--shadow-raised)]']"
  >
    <slot />
  </component>
</template>
