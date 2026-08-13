<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue: number
    minimum?: number
    maximum?: number | null
    step?: number
    label?: string
    compact?: boolean
  }>(),
  { minimum: 1, maximum: null, step: 1, label: 'Cantidad', compact: false }
)
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

const canDecrease = computed(() => props.modelValue - props.step >= props.minimum)
const canIncrease = computed(() => props.maximum == null || props.modelValue + props.step <= props.maximum)

function change(delta: number) {
  const value = props.modelValue + delta * props.step
  if (value < props.minimum || (props.maximum != null && value > props.maximum)) return
  emit('update:modelValue', value)
}
</script>

<template>
  <div class="flex items-center border border-slate-300" :class="compact ? 'rounded-lg' : 'rounded-xl'">
    <button
      type="button"
      :disabled="!canDecrease"
      :aria-label="`Menos unidades${label ? ` de ${label}` : ''}`"
      class="text-slate-500 hover:text-neteco-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500 disabled:opacity-30"
      :class="compact ? 'rounded-l-lg px-3 py-2.5' : 'rounded-l-xl px-3.5 py-3'"
      @click="change(-1)"
      @keydown.enter.prevent="change(-1)"
      @keydown.space.prevent="change(-1)"
    >
      <UIcon name="i-lucide-minus" :class="compact ? 'block size-4' : 'block size-5'" />
    </button>
    <span
      role="status"
      :aria-label="label"
      :class="compact ? 'w-8 text-center text-sm font-semibold' : 'w-10 text-center font-semibold'"
      >{{ modelValue }}</span
    >
    <button
      type="button"
      :disabled="!canIncrease"
      :aria-label="`Más unidades${label ? ` de ${label}` : ''}`"
      class="text-slate-500 hover:text-neteco-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500 disabled:opacity-30"
      :class="compact ? 'rounded-r-lg px-3 py-2.5' : 'rounded-r-xl px-3.5 py-3'"
      @click="change(1)"
      @keydown.enter.prevent="change(1)"
      @keydown.space.prevent="change(1)"
    >
      <UIcon name="i-lucide-plus" :class="compact ? 'block size-4' : 'block size-5'" />
    </button>
  </div>
</template>
