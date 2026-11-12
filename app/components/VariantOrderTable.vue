<script
  setup
  lang="ts"
  generic="
    T extends {
      id: number
      format: string
      sku: string
      minimumQuantity: number
      quantityIncrement: number
    }
  "
>
/**
 * Tabla de formatos con cantidad por fila.
 *
 * Quien repone guantes pide S, M y L en el mismo pedido. Antes eran tres ciclos «elegir fila,
 * ir a la caja de compra, cantidad, añadir»; ahora cada formato tiene su cantidad y un único
 * botón los añade todos. Es como se lee y se rellena una tarifa.
 *
 * La fila sigue siendo un grupo de radio (se recorre con flechas): el formato elegido decide
 * la foto, la entrega estimada y la información de peligro que se enseñan. La cantidad es un
 * control aparte, hermano del radio, nunca anidado en él.
 */
const props = withDefaults(
  defineProps<{
    variants: T[]
    /** Formato elegido. */
    modelValue: number
    /** Cantidad pedida de cada formato; 0 es «no pedir». */
    quantities: Record<number, number>
    /** Máximo que se puede pedir de un formato; 0 o menos lo deja sin cantidad. */
    maximum: (variant: T) => number | null
    label?: string
  }>(),
  { label: 'Elige formato y cantidad' }
)
const emit = defineEmits<{ 'update:modelValue': [value: number]; quantity: [variantId: number, value: number] }>()

const group = ref<HTMLDivElement | null>(null)
function select(index: number, focus = false) {
  const variant = props.variants[index]
  if (!variant) return
  emit('update:modelValue', variant.id)
  // La navegación con flechas de un radio mueve también el foco.
  if (focus) group.value?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus()
}
function move(delta: number) {
  if (!props.variants.length) return
  const index = props.variants.findIndex((variant) => variant.id === props.modelValue)
  select((index + delta + props.variants.length) % props.variants.length, true)
}
const orderable = (variant: T) => {
  const limit = props.maximum(variant)
  return limit === null || limit >= variant.minimumQuantity
}
function setQuantity(variant: T, value: number) {
  emit('quantity', variant.id, value)
  if (variant.id !== props.modelValue) emit('update:modelValue', variant.id)
}
</script>

<template>
  <fieldset>
    <legend class="sr-only">{{ label }}</legend>
    <div class="mb-2 flex items-baseline justify-between gap-3 text-[15px] font-semibold text-[var(--text-strong)]">
      <span>{{ variants.length > 1 ? label : 'Cantidad' }}</span>
      <span v-if="variants.length > 1" class="text-[13px] font-normal text-[var(--text-muted)]">
        {{ variants.length }} formatos
      </span>
    </div>

    <div
      ref="group"
      role="radiogroup"
      :aria-label="label"
      class="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)]"
    >
      <div
        v-for="(variant, index) in variants"
        :key="variant.id"
        data-variant-row
        :data-selected="modelValue === variant.id"
        class="grid grid-cols-1 items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto]"
        :class="modelValue === variant.id && variants.length > 1 ? 'bg-neteco-50' : ''"
      >
        <button
          type="button"
          role="radio"
          :aria-checked="modelValue === variant.id"
          :tabindex="modelValue === variant.id ? 0 : -1"
          class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-[var(--radius-control)] text-left"
          @click="select(index)"
          @keydown.down.prevent="move(1)"
          @keydown.right.prevent="move(1)"
          @keydown.up.prevent="move(-1)"
          @keydown.left.prevent="move(-1)"
          @keydown.home.prevent="select(0, true)"
          @keydown.end.prevent="select(variants.length - 1, true)"
        >
          <slot :variant="variant" :selected="modelValue === variant.id">
            <span>{{ variant.format }} · Ref. {{ variant.sku }}</span>
          </slot>
        </button>
        <QuantityStepper
          class="justify-self-end"
          :model-value="quantities[variant.id] ?? 0"
          :minimum="variant.minimumQuantity"
          :maximum="maximum(variant)"
          :step="variant.quantityIncrement"
          :label="variant.format"
          :disabled="!orderable(variant)"
          allow-zero
          @update:model-value="setQuantity(variant, $event)"
        />
      </div>
    </div>
  </fieldset>
</template>
