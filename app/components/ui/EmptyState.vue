<script setup lang="ts">
/**
 * Una pantalla vacía es una invitación a actuar, no un hueco.
 *
 * Seis pantallas del panel (`medios`, `soporte`, `busqueda`, `devoluciones`,
 * `contenido`, `flags`) renderizaban a la altura del viewport con una tabla de
 * una fila que decía «no hay datos» y el 80 % de la pantalla en blanco. Este
 * componente exige explicar qué es la sección y cuál es la primera acción.
 */
withDefaults(
  defineProps<{
    icon?: string
    title: string
    description?: string
    /** `filtered` cuando el vacío lo ha causado un filtro y no la ausencia de datos. */
    variant?: 'empty' | 'filtered' | 'error'
  }>(),
  { icon: 'i-lucide-inbox', description: undefined, variant: 'empty' }
)

const TONE = {
  empty: 'text-[var(--text-muted)] bg-[var(--surface-sunken)]',
  filtered: 'text-[var(--text-muted)] bg-[var(--surface-sunken)]',
  error: 'text-red-700 bg-red-50'
}
</script>

<template>
  <div class="flex flex-col items-center px-6 py-14 text-center">
    <div class="flex size-12 items-center justify-center rounded-full" :class="TONE[variant]">
      <UIcon :name="variant === 'error' ? 'i-lucide-triangle-alert' : icon" class="size-6" />
    </div>
    <p class="mt-4 font-semibold text-[var(--text-strong)]">{{ title }}</p>
    <p v-if="description" class="mt-1.5 max-w-md text-sm text-[var(--text-muted)]">{{ description }}</p>
    <div v-if="$slots.default" class="mt-5 flex flex-wrap justify-center gap-2">
      <slot />
    </div>
  </div>
</template>
