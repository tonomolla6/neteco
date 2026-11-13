<script setup lang="ts">
/**
 * Buscador de variantes para formularios del panel: el comerciante escribe el nombre o la
 * referencia y elige; el formulario sigue recibiendo el identificador interno que espera la API.
 * Usa el mismo listado que la pantalla de precios. Si ese listado no está disponible para la
 * sesión, deja teclear el identificador a mano.
 */
interface VariantOption {
  variantId: string
  id: number | null
  sku: string
  product: string
  format: string
}
const props = withDefaults(
  defineProps<{
    modelValue: string | number | null
    /** Qué dato de la variante espera el formulario: identificador interno, referencia o número. */
    valueKey?: 'variantId' | 'sku' | 'id'
    id?: string
    required?: boolean
    disabled?: boolean
    placeholder?: string
  }>(),
  {
    valueKey: 'variantId',
    id: undefined,
    required: false,
    disabled: false,
    placeholder: 'Busca por nombre o referencia'
  }
)
const emit = defineEmits<{ 'update:modelValue': [value: string]; select: [variant: VariantOption | null] }>()

const cloudflare = useRuntimeConfig().public.serverRuntime === 'cloudflare'
const request = useRequestFetch()
const query = ref('')
const results = shallowRef<VariantOption[]>([])
const status = ref<'idle' | 'loading' | 'done' | 'error'>('idle')
const chosen = shallowRef<VariantOption | null>(null)
const manual = ref(false)
let epoch = 0
let timer: ReturnType<typeof setTimeout> | undefined

const current = computed(() => (props.modelValue === null ? '' : String(props.modelValue)))
const valueOf = (variant: VariantOption) =>
  props.valueKey === 'sku' ? variant.sku : props.valueKey === 'id' ? String(variant.id ?? '') : variant.variantId
const describe = (variant: VariantOption) =>
  [variant.product, variant.format, variant.sku].filter((part) => part).join(' · ')
const currentLabel = computed(() =>
  chosen.value && valueOf(chosen.value) === current.value
    ? describe(chosen.value)
    : props.valueKey === 'variantId'
      ? `Variante ${adminShortId(current.value)}`
      : current.value
)

function toOption(raw: unknown): VariantOption | null {
  if (typeof raw !== 'object' || raw === null) return null
  const item = raw as Record<string, unknown>
  if (typeof item.variantId !== 'string' || typeof item.sku !== 'string') return null
  return {
    variantId: item.variantId,
    id: typeof item.id === 'number' ? item.id : null,
    sku: item.sku,
    product: typeof item.product === 'string' ? item.product : '',
    format: typeof item.format === 'string' ? item.format : ''
  }
}
async function search(term: string) {
  const expected = ++epoch
  status.value = 'loading'
  try {
    const response = await request<{ items?: unknown }>('/api/admin/prices', {
      query: { q: term, ...(cloudflare ? { page: 1, perPage: 25 } : {}) }
    })
    if (expected !== epoch) return
    const items = Array.isArray(response?.items) ? response.items : []
    results.value = items
      .map(toOption)
      .filter((item): item is VariantOption => item !== null && valueOf(item) !== '')
      .slice(0, 8)
    status.value = 'done'
  } catch {
    if (expected !== epoch) return
    results.value = []
    status.value = 'error'
    manual.value = true
  }
}
watch(query, (text) => {
  clearTimeout(timer)
  epoch++
  const term = text.trim()
  if (term.length < 2) {
    results.value = []
    status.value = 'idle'
    return
  }
  timer = setTimeout(() => void search(term), 250)
})
onBeforeUnmount(() => {
  clearTimeout(timer)
  epoch++
})
function pick(variant: VariantOption) {
  chosen.value = variant
  query.value = ''
  results.value = []
  status.value = 'idle'
  emit('update:modelValue', valueOf(variant))
  emit('select', variant)
}
function clear() {
  chosen.value = null
  emit('update:modelValue', '')
  emit('select', null)
}
</script>

<template>
  <div class="min-w-0">
    <div
      v-if="current && !manual"
      class="flex min-h-9 items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-1.5"
    >
      <span class="min-w-0 truncate text-[var(--text-strong)]" :title="currentLabel">{{ currentLabel }}</span>
      <button
        type="button"
        class="adm-btn adm-btn--ghost adm-btn--sm shrink-0"
        :disabled="disabled"
        data-variant-picker-change
        @click="clear"
      >
        Cambiar
      </button>
    </div>
    <template v-else-if="manual">
      <input
        :id="id"
        :value="current"
        class="adm-input"
        autocomplete="off"
        :required="required"
        :disabled="disabled"
        data-variant-picker-manual
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value.trim())"
      />
      <p class="adm-help">
        <template v-if="status === 'error'">No se ha podido abrir el buscador de productos. </template>
        Pega aquí el identificador de la variante: lo encontrarás en la ficha del producto.
        <button type="button" class="underline" @click="((manual = false), (status = 'idle'))">
          Volver al buscador
        </button>
      </p>
    </template>
    <template v-else>
      <input
        :id="id"
        v-model="query"
        type="search"
        class="adm-input"
        autocomplete="off"
        :placeholder="placeholder"
        :required="required"
        :disabled="disabled"
        data-variant-picker-search
      />
      <p v-if="status === 'loading'" role="status" class="adm-help">Buscando…</p>
      <p v-else-if="status === 'done' && !results.length" role="status" class="adm-help">
        No hay productos que coincidan.
      </p>
      <ul
        v-if="results.length"
        class="mt-1 max-h-64 overflow-auto rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)]"
      >
        <li v-for="variant in results" :key="variant.variantId" class="border-b border-[var(--border)] last:border-b-0">
          <button
            type="button"
            class="block w-full px-3 py-2 text-left hover:bg-[var(--surface-sunken)]"
            data-variant-picker-option
            @click="pick(variant)"
          >
            <span class="block truncate text-[var(--text-strong)]">{{ variant.product || variant.sku }}</span>
            <span class="block truncate text-xs text-[var(--text-muted)]">
              {{ [variant.format, variant.sku].filter((part) => part).join(' · ') }}
            </span>
          </button>
        </li>
      </ul>
      <p v-if="status !== 'loading'" class="adm-help">
        <button type="button" class="underline" @click="manual = true">Escribir el identificador a mano</button>
      </p>
    </template>
  </div>
</template>
