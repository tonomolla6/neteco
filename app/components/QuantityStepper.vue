<script setup lang="ts">
/**
 * Selector de cantidad de compra.
 *
 * Tres zonas: menos, campo numérico editable y más. En almacén o en cocina se pulsa con el
 * pulgar, así que la variante normal usa 44 × 44 px; la compacta (36 px) queda para tablas
 * de escritorio. El campo admite escribir la cantidad directamente y la ajusta al mínimo, al
 * incremento y al máximo de la variante: nunca emite una cantidad que el carrito rechazaría.
 */
const props = withDefaults(
  defineProps<{
    modelValue: number
    minimum?: number
    maximum?: number | null
    step?: number
    label?: string
    compact?: boolean
    /** Permite 0 («no pedir este formato») además de las cantidades válidas. */
    allowZero?: boolean
    disabled?: boolean
  }>(),
  { minimum: 1, maximum: null, step: 1, label: 'Cantidad', compact: false, allowZero: false, disabled: false }
)
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

const lowest = computed(() => (props.allowZero ? 0 : props.minimum))
const highest = computed(() => {
  if (props.maximum == null) return null
  // El máximo real es el mayor valor alcanzable desde el mínimo con el incremento.
  const steps = Math.floor((props.maximum - props.minimum) / props.step)
  return steps < 0 ? lowest.value : props.minimum + steps * props.step
})

function next(direction: 1 | -1) {
  const value = props.modelValue
  if (direction === 1) return value < props.minimum ? props.minimum : value + props.step
  return value - props.step < props.minimum ? lowest.value : value - props.step
}
const canDecrease = computed(() => !props.disabled && props.modelValue > lowest.value)
const canIncrease = computed(
  () => !props.disabled && (highest.value == null || next(1) <= highest.value) && next(1) !== props.modelValue
)

function change(direction: 1 | -1) {
  if (direction === 1 ? !canIncrease.value : !canDecrease.value) return
  emit('update:modelValue', next(direction))
}

/** Ajusta lo tecleado a la cantidad válida más cercana. */
function normalize(raw: number) {
  if (props.allowZero && raw <= 0) return 0
  const steps = Math.max(0, Math.round((raw - props.minimum) / props.step))
  const value = props.minimum + steps * props.step
  return highest.value != null && value > highest.value ? highest.value : value
}

const field = ref<HTMLInputElement | null>(null)
function commit(event: Event) {
  const input = event.target as HTMLInputElement
  const text = input.value.trim()
  if (!/^\d{1,4}$/.test(text)) {
    input.value = String(props.modelValue)
    return
  }
  const value = normalize(Number(text))
  input.value = String(value)
  if (value !== props.modelValue) emit('update:modelValue', value)
}
watch(
  () => props.modelValue,
  (value) => {
    if (field.value && field.value.value !== String(value)) field.value.value = String(value)
  }
)
const fieldLabel = computed(() =>
  props.label && props.label !== 'Cantidad' ? `Cantidad de ${props.label}` : 'Cantidad'
)
</script>

<template>
  <div
    class="inline-flex items-stretch rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)]"
    :class="disabled ? 'opacity-60' : ''"
  >
    <button
      type="button"
      :disabled="!canDecrease"
      :aria-label="`Menos unidades${label ? ` de ${label}` : ''}`"
      class="flex shrink-0 items-center justify-center rounded-l-[var(--radius-control)] text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text-strong)] disabled:opacity-30 disabled:hover:bg-transparent"
      :class="compact ? 'size-9' : 'size-11'"
      @click="change(-1)"
      @keydown.enter.prevent="change(-1)"
      @keydown.space.prevent="change(-1)"
    >
      <UIcon name="i-lucide-minus" :class="compact ? 'block size-4' : 'block size-5'" />
    </button>
    <input
      ref="field"
      type="text"
      inputmode="numeric"
      pattern="[0-9]*"
      autocomplete="off"
      :value="modelValue"
      :disabled="disabled"
      :aria-label="fieldLabel"
      class="tabular min-w-0 border-x border-[var(--border)] bg-transparent text-center font-semibold text-[var(--text-strong)]"
      :class="compact ? 'h-9 w-10 text-sm' : 'h-11 w-14'"
      @change="commit"
      @keydown.enter.prevent="commit"
      @keydown.up.prevent="change(1)"
      @keydown.down.prevent="change(-1)"
      @focus="($event.target as HTMLInputElement).select()"
    />
    <button
      type="button"
      :disabled="!canIncrease"
      :aria-label="`Más unidades${label ? ` de ${label}` : ''}`"
      class="flex shrink-0 items-center justify-center rounded-r-[var(--radius-control)] text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text-strong)] disabled:opacity-30 disabled:hover:bg-transparent"
      :class="compact ? 'size-9' : 'size-11'"
      @click="change(1)"
      @keydown.enter.prevent="change(1)"
      @keydown.space.prevent="change(1)"
    >
      <UIcon name="i-lucide-plus" :class="compact ? 'block size-4' : 'block size-5'" />
    </button>
  </div>
</template>
