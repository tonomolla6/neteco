<script setup lang="ts">
/** Reparto de un total en categorías: barras horizontales de un solo color con su cifra al lado. */
const props = defineProps<{
  items: Array<{ label: string; value: number; to?: string }>
  format?: (value: number) => string
}>()
const max = computed(() => Math.max(1, ...props.items.map((item) => item.value)))
const total = computed(() => props.items.reduce((sum, item) => sum + item.value, 0))
const show = (value: number) => (props.format ? props.format(value) : value.toLocaleString('es-ES'))
const NuxtLink = resolveComponent('NuxtLink')
</script>

<template>
  <ul class="adm-breakdown">
    <li v-for="item in items" :key="item.label">
      <component :is="item.to ? NuxtLink : 'div'" :to="item.to" class="adm-breakdown__row">
        <span class="adm-breakdown__label">{{ item.label }}</span>
        <span class="adm-breakdown__value">
          {{ show(item.value) }}
          <small v-if="total">{{ Math.round((item.value / total) * 100) }} %</small>
        </span>
        <span class="adm-breakdown__track">
          <i :style="{ width: `${(item.value / max) * 100}%` }" />
        </span>
      </component>
    </li>
  </ul>
</template>
