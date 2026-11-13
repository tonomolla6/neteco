<script setup lang="ts">
/** Cifra clave con comparación opcional frente al periodo anterior. */
const props = defineProps<{
  label: string
  value: string | number | null
  /** Variación relativa frente al periodo anterior (0.12 = +12 %). */
  delta?: number | null
  hint?: string
  icon?: string
  to?: string
  /** Si bajar es bueno (devoluciones, incidencias), invierte el color de la variación. */
  invert?: boolean
}>()
const NuxtLink = resolveComponent('NuxtLink')
const trend = computed(() => {
  if (props.delta === undefined || props.delta === null || !Number.isFinite(props.delta)) return null
  const up = props.delta > 0.0005,
    down = props.delta < -0.0005
  const good = props.invert ? down : up,
    bad = props.invert ? up : down
  return {
    text: `${up ? '+' : ''}${(props.delta * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`,
    icon: up ? 'i-lucide-trending-up' : down ? 'i-lucide-trending-down' : 'i-lucide-minus',
    tone: good ? 'adm-stat__delta--up' : bad ? 'adm-stat__delta--down' : ''
  }
})
</script>

<template>
  <component :is="to ? NuxtLink : 'div'" :to="to" class="adm-card adm-stat" :class="to && 'adm-stat--link'">
    <p class="adm-stat__label"><UIcon v-if="icon" :name="icon" class="size-4" />{{ label }}</p>
    <p class="adm-stat__value">{{ value ?? '—' }}</p>
    <p class="adm-stat__foot">
      <span v-if="trend" class="adm-stat__delta" :class="trend.tone">
        <UIcon :name="trend.icon" class="size-3.5" />{{ trend.text }}
      </span>
      <span v-if="hint">{{ hint }}</span>
    </p>
  </component>
</template>
