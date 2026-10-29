<script setup lang="ts">
import {
  arrangeAlternatives,
  productDetailExtrasSchema,
  type AvailabilityStatus,
  type DetailExtrasSort,
  type ProductDetailExtras
} from '~~/shared/product-detail-extras'

// PDP-014/015/020: reviewed alternatives, complements and single-warehouse
// availability/pickup. Loaded after hydration so the product page (and its SEO
// markup) never waits on it. Hazard data is always rendered, never filtered.
const props = defineProps<{ productSlug: string; variantId?: number | null }>()
const request = useRequestFetch(),
  runtime = useRuntimeConfig()
const data = shallowRef<ProductDetailExtras | null>(null)
const state = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const sort = ref<DetailExtrasSort>('relevance')
const availableOnly = ref(false)
let generation = 0,
  alive = true
const enabled = computed(() => runtime.public.serverRuntime === 'cloudflare' && Boolean(props.productSlug))

async function load() {
  const token = ++generation
  data.value = null
  if (!enabled.value) {
    state.value = 'idle'
    return
  }
  state.value = 'loading'
  try {
    const parsed = productDetailExtrasSchema.parse(
      await request('/api/product-detail-extras', { query: { slug: props.productSlug }, retry: 0 })
    )
    if (parsed.productSlug !== props.productSlug) throw new Error('correlation')
    if (!alive || token !== generation) return
    data.value = parsed
    state.value = 'ready'
  } catch {
    if (alive && token === generation) {
      data.value = null
      state.value = 'error'
    }
  }
}
watch(() => props.productSlug, load, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => {
  alive = false
  generation++
})

const money = (cents: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100)
const statusLabel: Record<AvailabilityStatus, string> = {
  in_stock: 'Disponible',
  low_stock: 'Pocas unidades',
  backorder: 'Bajo pedido',
  out_of_stock: 'Agotado',
  unavailable: 'Disponibilidad no confirmada'
}
const current = computed(
  () => data.value?.availability.find((row) => row.variantId === props.variantId) ?? data.value?.availability[0] ?? null
)
const alternatives = computed(() =>
  data.value ? arrangeAlternatives(data.value.alternatives, sort.value, availableOnly.value) : []
)
const hiddenByStock = computed(() => (data.value ? data.value.alternatives.length - alternatives.value.length : 0))
const kindLabel = { substitute: 'Sustitución revisada', equivalent: 'Equivalencia revisada' }
</script>

<template>
  <section v-if="enabled" aria-label="Disponibilidad, alternativas y complementos" class="min-w-0 space-y-4">
    <p v-if="state === 'loading'" role="status">Consultando disponibilidad y alternativas…</p>
    <p v-else-if="state === 'error'" role="alert">No se pudo consultar la disponibilidad ni las alternativas.</p>
    <template v-else-if="state === 'ready' && data">
      <div data-warehouse-availability class="space-y-1">
        <h2>Almacén único</h2>
        <p v-if="!data.warehouse.single || !current || current.status === 'unavailable'">
          Disponibilidad no confirmada.
        </p>
        <p v-else-if="current.status === 'out_of_stock'">Agotado en el almacén.</p>
        <p v-else-if="current.status === 'backorder'">Bajo pedido; sin stock inmediato en el almacén.</p>
        <p v-else>{{ current.sellable }} uds. disponibles en el almacén.</p>
        <p v-if="!data.warehouse.pickupEnabled">Recogida no habilitada.</p>
        <p v-else-if="current?.pickupAvailable">Recogida en almacén disponible.</p>
        <p v-else>Recogida no disponible para esta referencia ahora.</p>
      </div>

      <div data-hazard-summary class="space-y-1">
        <h2>Peligros y seguridad</h2>
        <template v-if="data.hazard.hasHazardData">
          <p v-if="data.hazard.signalWord">Palabra de advertencia: {{ data.hazard.signalWord }}</p>
          <ul>
            <li v-for="statement in data.hazard.hazardStatements" :key="statement">{{ statement }}</li>
          </ul>
        </template>
        <p v-else>Sin datos de peligro publicados; consulte la etiqueta y la ficha de datos de seguridad.</p>
      </div>

      <div class="space-y-2">
        <h2>Alternativas revisadas</h2>
        <p>{{ data.notice }}</p>
        <template v-if="data.alternatives.length">
          <label>
            Ordenar
            <select v-model="sort" data-alternatives-sort>
              <option value="relevance">Selección del equipo</option>
              <option value="price">Precio</option>
              <option value="availability">Disponibilidad</option>
            </select>
          </label>
          <label>
            <input v-model="availableOnly" type="checkbox" data-available-only />
            Solo disponibles
          </label>
          <p v-if="hiddenByStock" role="status">
            {{ hiddenByStock }} {{ hiddenByStock === 1 ? 'alternativa oculta' : 'alternativas ocultas' }} por falta de
            stock.
          </p>
          <ul class="space-y-2">
            <li
              v-for="item in alternatives"
              :key="item.productId"
              :data-alternative="item.productId"
              class="break-words"
            >
              <a :href="'/producto/' + encodeURIComponent(item.slug)" class="underline">{{ item.name }}</a>
              — {{ item.brand }} · {{ kindLabel[item.kind] }} · Desde {{ money(item.minPrice) }} IVA incluido ·
              {{ statusLabel[item.availability]
              }}<template v-if="item.pickupAvailable"> · Recogida disponible</template>
              <p v-if="item.hazard.hasHazardData">
                <template v-if="item.hazard.signalWord">{{ item.hazard.signalWord }}: </template
                >{{ item.hazard.hazardStatements.join('; ') }}
              </p>
              <p v-else>Sin datos de peligro publicados.</p>
            </li>
          </ul>
        </template>
        <p v-else>No hay alternativas revisadas para este producto.</p>
      </div>

      <div v-if="data.complements.length" class="space-y-2">
        <h2>Complementos</h2>
        <ul class="space-y-2">
          <li
            v-for="item in data.complements"
            :key="item.productId"
            :data-complement="item.productId"
            class="break-words"
          >
            <a :href="'/producto/' + encodeURIComponent(item.slug)" class="underline">{{ item.name }}</a>
            — {{ item.brand }} · Desde {{ money(item.minPrice) }} IVA incluido ·
            <template v-if="item.basis === 'co_purchase'">Comprado junto en {{ item.support }} pedidos</template>
            <template v-else>Seleccionado por el equipo</template>
            · {{ statusLabel[item.availability] }}
            <p v-if="item.hazard.hasHazardData">
              <template v-if="item.hazard.signalWord">{{ item.hazard.signalWord }}: </template
              >{{ item.hazard.hazardStatements.join('; ') }}
            </p>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
