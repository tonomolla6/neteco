<script setup lang="ts" generic="T extends { id: string | number; format: string; sku: string }">
/**
 * Selector de formato.
 *
 * Antes era una pila de tarjetas a ancho completo de tres líneas cada una. Con las
 * cinco tallas de un guante ya empujaba «Añadir al carrito» por debajo del pliegue en
 * un portátil; con los diez formatos de un químico (1 L, 5 L, 10 L, 20 L, garrafa,
 * bag-in-box…) la ficha se volvía impracticable.
 *
 * Ahora es una tabla de precios compacta: una fila por formato, columnas alineadas para
 * poder comparar en vertical, y scroll interno a partir de seis formatos para que la
 * altura de la ficha no dependa del número de referencias. Es la forma en que un
 * comprador profesional lee una tarifa.
 *
 * Semántica de grupo de radio, no de botones sueltos: se recorre con flechas, como se
 * espera de una elección excluyente.
 */
const props = withDefaults(
  defineProps<{
    variants: T[]
    modelValue: string | number
    label?: string
    /** Cabeceras de columna. Si se omiten, no se pinta fila de cabecera. */
    columns?: [string, string, string]
  }>(),
  { label: 'Formato', columns: undefined }
)
const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>()

const scrolls = computed(() => props.variants.length > 6)
const radioGroup = ref<HTMLDivElement | null>(null)

function select(index: number) {
  const variant = props.variants[index]
  if (!variant) return
  emit('update:modelValue', variant.id)
  // A radio's arrow navigation moves focus as well as selection; otherwise
  // assistive technology stays on the previously selected variant.
  radioGroup.value?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus()
}

function move(delta: number) {
  if (!props.variants.length) return
  const index = props.variants.findIndex((variant) => variant.id === props.modelValue)
  select((index + delta + props.variants.length) % props.variants.length)
}
</script>

<template>
  <fieldset>
    <!-- `<legend>` no respeta `display:flex` de forma fiable, así que el título visible va en un
         div normal y la leyenda queda solo para lectores de pantalla. -->
    <legend class="sr-only">{{ label }}</legend>
    <div class="mb-2 flex items-baseline justify-between gap-3 text-sm font-semibold text-[var(--text)]">
      <span>{{ label }}</span>
      <span class="font-normal text-[var(--text-muted)]">
        {{ variants.length }} {{ variants.length === 1 ? 'formato' : 'formatos' }}
      </span>
    </div>

    <div class="overflow-hidden rounded-[var(--radius-surface)] border border-[var(--border)]">
      <div
        v-if="columns"
        class="grid grid-cols-[1fr_auto_auto] gap-x-4 border-b border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]"
      >
        <span>{{ columns[0] }}</span>
        <span class="text-right">{{ columns[1] }}</span>
        <span class="text-right">{{ columns[2] }}</span>
      </div>

      <div
        ref="radioGroup"
        role="radiogroup"
        :aria-label="label"
        class="divide-y divide-[var(--border)] bg-[var(--surface)]"
        :class="scrolls && 'max-h-[19.5rem] overflow-y-auto'"
        @keydown.down.prevent="move(1)"
        @keydown.right.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.left.prevent="move(-1)"
        @keydown.home.prevent="select(0)"
        @keydown.end.prevent="select(variants.length - 1)"
      >
        <button
          v-for="variant in variants"
          :key="variant.id"
          type="button"
          role="radio"
          :aria-checked="modelValue === variant.id"
          :tabindex="modelValue === variant.id ? 0 : -1"
          class="grid w-full grid-cols-[1fr_auto_auto] items-center gap-x-4 px-3 py-2.5 text-left transition-colors"
          :class="
            modelValue === variant.id ? 'bg-neteco-50 ring-1 ring-inset ring-neteco-500' : 'hover:bg-[var(--canvas)]'
          "
          @click="emit('update:modelValue', variant.id)"
        >
          <slot :variant="variant" :selected="modelValue === variant.id">
            <span>{{ variant.format }} · Ref. {{ variant.sku }}</span>
          </slot>
        </button>
      </div>
    </div>

    <p v-if="scrolls" class="mt-1.5 text-xs text-[var(--text-muted)]">
      Desplázate para ver los {{ variants.length }} formatos.
    </p>
  </fieldset>
</template>
