<script setup lang="ts">
import { deliveryPromise, formatDeliveryDate, madridToday } from '~~/shared/delivery-promise'
import { businessDaysForLead, type ShipmentMode, type ShipmentPlanEntry } from '~~/shared/shipment-plan'

/**
 * Último paso del pago, como en Amazon: método de entrega y, debajo, cada producto con su
 * fecha. Si los productos tienen plazos distintos (unos están en el almacén y otros llegan
 * con su plazo de reposición), el cliente elige recibirlo todo junto en la fecha más tardía
 * o por separado, pagando un porte por envío. Las fechas y los portes vienen del servidor.
 */
export interface ShipmentRate {
  label: string
  netCents: number
  taxRateBasisPoints: number
  estimatedDeliveryFrom: string | null
  estimatedDeliveryTo: string | null
  profile: string
  shipmentMode?: ShipmentMode
  shipments?: ShipmentPlanEntry[]
}
interface CartLine {
  sku: string
  name: string
  format: string
  qty: number
  image?: string | null
  visual?: { type: string; color: string } | null
}

const props = defineProps<{
  methods: ReadonlyArray<{ value: string; label: string; desc: string }>
  /** Tarifa de un método en un modo; `undefined` si ese método no admite ese modo. */
  rateFor: (method: string, mode: ShipmentMode) => ShipmentRate | undefined
  items: CartLine[]
  postalCode: string
  loading: boolean
  error: string
  /** Hay dirección suficiente para cotizar. */
  ready: boolean
  disabled?: boolean
}>()
const method = defineModel<string>({ required: true })
const mode = defineModel<ShipmentMode>('mode', { required: true })

const { terms } = useCommercialTerms()
const gross = (rate: ShipmentRate) => rate.netCents + Math.round((rate.netCents * rate.taxRateBasisPoints) / 10_000)
const price = (rate: ShipmentRate | undefined) => (rate ? (rate.netCents ? formatPrice(gross(rate)) : 'Gratis') : '')

const together = computed(() => props.rateFor(method.value, 'together'))
const split = computed(() => props.rateFor(method.value, 'split'))
const active = computed(() => (mode.value === 'split' ? (split.value ?? together.value) : together.value))
// La página decide cuándo volver a «todo junto» (tras cada cotización): aquí las tarifas
// pueden vaciarse un instante mientras se recalculan y la elección no debe perderse.

/**
 * Fecha de un envío. Manda la del servidor; si su calendario no da fecha, la previsión de la
 * tienda con el plazo del envío (la misma que enseñan la ficha y el carrito).
 */
const now = ref<Date | null>(null)
onMounted(() => (now.value = new Date()))
function shipmentDay(rate: ShipmentRate, shipment: Pick<ShipmentPlanEntry, 'to' | 'from' | 'leadDays'>) {
  const server = (shipment.to ?? shipment.from)?.slice(0, 10)
  if (!now.value) return server ?? null
  // Una fecha ya pasada no es una promesa: se usa la previsión de la tienda.
  if (server && server >= madridToday(now.value)) return server
  if (rate.profile === 'pickup') {
    const day = new Date(now.value.getTime() + shipment.leadDays * 86_400_000)
    return day.toISOString().slice(0, 10)
  }
  const promise = deliveryPromise({
    now: now.value,
    terms: terms.value,
    // Fuera del reparto propio, un código postal de la zona no debe forzar la ruta propia.
    postalCode: rate.profile === 'own_delivery' ? props.postalCode : null,
    preparationDays: businessDaysForLead(shipment.leadDays)
  })
  return promise?.to ?? null
}
function dayLabel(rate: ShipmentRate | undefined, shipment: Pick<ShipmentPlanEntry, 'to' | 'from' | 'leadDays'>) {
  if (!rate) return ''
  const day = shipmentDay(rate, shipment)
  return day ? formatDeliveryDate(day) : ''
}
const verb = (rate: ShipmentRate | undefined) => (rate?.profile === 'pickup' ? 'Recogida a partir del' : 'Entrega el')
const lastShipment = (rate: ShipmentRate | undefined) => rate?.shipments?.at(-1)
const rateDay = (rate: ShipmentRate | undefined) => {
  const shipment = lastShipment(rate)
  if (rate && shipment) return dayLabel(rate, shipment)
  if (rate) return dayLabel(rate, { to: rate.estimatedDeliveryTo, from: rate.estimatedDeliveryFrom, leadDays: 0 })
  return ''
}

const bySku = computed(() => new Map(props.items.map((item) => [item.sku, item])))
/** Los envíos que se enseñan: los del plan elegido o, sin cotización todavía, todo el carrito junto. */
const groups = computed(() => {
  const rate = active.value
  const shipments = rate?.shipments?.length ? rate.shipments : null
  if (!rate || !shipments)
    return [{ key: 'all', title: rate ? `${verb(rate)} ${rateDay(rate)}`.trim() : '', cost: '', lines: props.items }]
  return shipments.map((shipment) => {
    const day = dayLabel(rate, shipment)
    return {
      key: `shipment-${shipment.index}`,
      title: day ? `${verb(rate)} ${day}` : 'Fecha por confirmar',
      cost:
        shipments.length > 1
          ? `Envío ${shipment.index + 1} de ${shipments.length} · ${shipment.grossCents ? formatPrice(shipment.grossCents) : 'gratis'}`
          : '',
      lines: shipment.lines
        .map((line) => {
          const item = bySku.value.get(line.sku)
          return item ? { ...item, qty: line.quantity } : null
        })
        .filter((line): line is CartLine => line !== null)
    }
  })
})
</script>

<template>
  <div data-checkout-shipments>
    <p
      v-if="!ready"
      class="mt-4 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 text-[15px] text-[var(--text)]"
    >
      Completa la dirección de entrega y verás aquí el coste y la fecha de cada producto.
    </p>

    <fieldset class="mt-4 space-y-2" :disabled="disabled">
      <legend class="mb-2 text-[15px] font-semibold text-[var(--text-strong)]">Método de entrega</legend>
      <label
        v-for="m in methods"
        :key="m.value"
        :data-delivery-method="m.value"
        class="flex cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-control)] border-2 px-4 py-3 transition"
        :class="
          method === m.value
            ? 'border-[var(--action)] bg-neteco-50'
            : 'border-[var(--border)] hover:border-[var(--border-strong)]'
        "
      >
        <span class="flex min-w-0 items-center gap-3">
          <input
            v-model="method"
            type="radio"
            name="checkout-delivery-method"
            :value="m.value"
            class="size-4 shrink-0 accent-[var(--action)]"
          />
          <span class="min-w-0">
            <span class="block font-semibold text-[var(--text-strong)]">{{ m.label }}</span>
            <span class="block text-[13px] text-[var(--text-muted)]">
              <template v-if="rateFor(m.value, 'together') && rateDay(rateFor(m.value, 'together'))">
                {{ verb(rateFor(m.value, 'together')) }} {{ rateDay(rateFor(m.value, 'together')) }}
              </template>
              <template v-else>{{ m.desc }}</template>
            </span>
          </span>
        </span>
        <span class="tabular shrink-0 font-semibold text-[var(--text-strong)]">
          {{ rateFor(m.value, 'together') ? price(rateFor(m.value, 'together')) : 'Por calcular' }}
        </span>
      </label>
    </fieldset>
    <p v-if="loading" role="status" aria-live="polite" class="mt-3 text-[13px] text-[var(--text-muted)]">
      Calculando coste y fecha de entrega…
    </p>
    <p v-if="error" role="alert" class="mt-3 text-[15px] text-[var(--ui-error)]">{{ error }}</p>

    <!-- Plazos distintos: todo junto o un envío por plazo -->
    <fieldset v-if="together && split" class="mt-6 space-y-2" :disabled="disabled" data-shipment-mode>
      <legend class="mb-2 text-[15px] font-semibold text-[var(--text-strong)]">
        Tus productos tienen plazos distintos. ¿Cómo quieres recibirlos?
      </legend>
      <label
        class="flex cursor-pointer items-start justify-between gap-3 rounded-[var(--radius-control)] border-2 px-4 py-3 transition"
        :class="
          mode === 'together'
            ? 'border-[var(--action)] bg-neteco-50'
            : 'border-[var(--border)] hover:border-[var(--border-strong)]'
        "
      >
        <span class="flex min-w-0 items-start gap-3">
          <input
            v-model="mode"
            type="radio"
            name="checkout-shipment-mode"
            value="together"
            class="mt-1 size-4 shrink-0 accent-[var(--action)]"
          />
          <span class="min-w-0">
            <span class="block font-semibold text-[var(--text-strong)]">Todo junto, en un solo envío</span>
            <span class="block text-[13px] text-[var(--text-muted)]">
              Un solo porte. Llega todo el {{ rateDay(together) || 'día del producto con más plazo' }}.
            </span>
          </span>
        </span>
        <span class="tabular shrink-0 font-semibold text-[var(--text-strong)]">{{ price(together) }}</span>
      </label>
      <label
        class="flex cursor-pointer items-start justify-between gap-3 rounded-[var(--radius-control)] border-2 px-4 py-3 transition"
        :class="
          mode === 'split'
            ? 'border-[var(--action)] bg-neteco-50'
            : 'border-[var(--border)] hover:border-[var(--border-strong)]'
        "
      >
        <span class="flex min-w-0 items-start gap-3">
          <input
            v-model="mode"
            type="radio"
            name="checkout-shipment-mode"
            value="split"
            class="mt-1 size-4 shrink-0 accent-[var(--action)]"
          />
          <span class="min-w-0">
            <span class="block font-semibold text-[var(--text-strong)]">
              Por separado, en {{ split.shipments?.length ?? 2 }} envíos
            </span>
            <span class="block text-[13px] text-[var(--text-muted)]">
              Lo que está en el almacén llega antes<template
                v-if="split.shipments?.[0] && dayLabel(split, split.shipments[0])"
                >, el {{ dayLabel(split, split.shipments[0]) }}</template
              >. Un porte por envío.
            </span>
          </span>
        </span>
        <span class="tabular shrink-0 font-semibold text-[var(--text-strong)]">{{ price(split) }}</span>
      </label>
    </fieldset>

    <!-- Cada producto con su fecha -->
    <div class="mt-6 space-y-3">
      <section
        v-for="group in groups"
        :key="group.key"
        data-shipment-group
        class="overflow-hidden rounded-[var(--radius-control)] border border-[var(--border)]"
      >
        <header
          v-if="group.title || group.cost"
          class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-2.5"
        >
          <h3 class="font-sans text-[15px] font-semibold tracking-normal text-[var(--stock-ok)]" data-shipment-date>
            {{ group.title }}
          </h3>
          <p v-if="group.cost" class="tabular text-[13px] text-[var(--text-muted)]">{{ group.cost }}</p>
        </header>
        <ul class="divide-y divide-[var(--border)]">
          <li v-for="line in group.lines" :key="line.sku" class="flex items-center gap-3 px-4 py-2.5">
            <div class="w-12 shrink-0"><ProductImage :product="line" sizes="48px" /></div>
            <div class="min-w-0 flex-1">
              <p class="line-clamp-2 text-[15px] leading-snug text-[var(--text-strong)]">{{ line.name }}</p>
              <p class="text-[13px] text-[var(--text-muted)]">{{ line.format }}</p>
            </div>
            <p class="tabular shrink-0 text-[15px] text-[var(--text)]">× {{ line.qty }}</p>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
