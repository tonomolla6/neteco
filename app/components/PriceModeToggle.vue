<script setup lang="ts">
import type { PriceDisplayMode } from '~/composables/usePriceDisplay'

const { mode, setMode } = usePriceDisplay()
const options: Array<{ value: PriceDisplayMode; label: string }> = [
  { value: 'net', label: 'Sin IVA' },
  { value: 'gross', label: 'Con IVA' }
]
const buttons = ref<HTMLButtonElement[]>([])
function move() {
  const next = mode.value === 'net' ? 'gross' : 'net'
  setMode(next)
  nextTick(() => buttons.value[options.findIndex((option) => option.value === next)]?.focus())
}
</script>

<template>
  <div role="radiogroup" aria-label="Precios" class="inline-flex items-center gap-1.5">
    <span aria-hidden="true" class="hidden sm:inline">Precios:</span>
    <span class="inline-flex rounded-[var(--radius-control)] border border-white/30 p-0.5">
      <button
        v-for="option in options"
        :key="option.value"
        ref="buttons"
        type="button"
        role="radio"
        :aria-checked="mode === option.value"
        :tabindex="mode === option.value ? 0 : -1"
        class="rounded-[6px] px-2 py-0.5 font-medium transition-colors"
        :class="mode === option.value ? 'bg-white text-neteco-900' : 'text-white hover:bg-white/10'"
        @click="setMode(option.value)"
        @keydown.left.prevent="move"
        @keydown.right.prevent="move"
        @keydown.up.prevent="move"
        @keydown.down.prevent="move"
      >
        {{ option.label }}
      </button>
    </span>
  </div>
</template>
