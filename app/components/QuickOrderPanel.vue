<script setup lang="ts">
import { z } from 'zod'
import { useCartStore } from '~/stores/cart'
import {
  parseQuickOrderCsv,
  previewQuickOrder,
  type QuickOrderInput,
  type QuickOrderReady,
  type QuickOrderRow
} from '~~/shared/quick-order'

const runtime = useRuntimeConfig().public.serverRuntime
const { ready, loggedIn, user, session } = useUserSession()
const request = useRequestFetch()
const cart = useCartStore()
const csv = ref('')
const rows = shallowRef<QuickOrderRow[]>([])
const selected = ref<number[]>([])
const confirmed = ref(false)
const reading = ref(false)
const adding = ref(false)
const error = ref('')
const notice = ref('')
const remaining = shallowRef<QuickOrderInput[]>([])
const added = ref(0)
const attempted = ref<number[]>([])
// An uncertain variant is never a replay candidate in this mounted panel. Only
// the cart owns its frozen operation, receipt/journal and any explicit retry.
const uncertain = new Set<number>()
let generation = 0
let disposed = false
const scope = computed(() =>
  JSON.stringify([
    ready.value,
    loggedIn.value,
    user.value?.id,
    user.value?.email,
    user.value?.emailVerified,
    session.value?.sessionId,
    session.value?.sessionVersion
  ])
)
const allowed = computed(
  () =>
    runtime === 'cloudflare' &&
    ready.value &&
    (!loggedIn.value
      ? !user.value?.id
      : user.value?.emailVerified === true &&
        z.string().uuid().safeParse(user.value.id).success &&
        z.string().email().safeParse(user.value.email).success &&
        z.string().uuid().safeParse(session.value?.sessionId).success &&
        Number.isSafeInteger(session.value?.sessionVersion) &&
        Number(session.value?.sessionVersion) >= 1)
)
const busy = computed(() => reading.value || adding.value)
const selectedRows = computed(() =>
  selected.value.flatMap((index) => {
    const row = rows.value[index]
    return row?.status === 'ready' && !attempted.value.includes(index) && !uncertain.has(row.variant.id) ? [row] : []
  })
)
function purge() {
  generation++
  csv.value = ''
  rows.value = []
  selected.value = []
  confirmed.value = false
  reading.value = false
  adding.value = false
  error.value = ''
  notice.value = ''
  remaining.value = []
  attempted.value = []
  added.value = 0
  uncertain.clear()
}
watch([scope, allowed], purge, { flush: 'sync' })
watch(
  csv,
  () => {
    generation++
    rows.value = []
    selected.value = []
    confirmed.value = false
    error.value = ''
    notice.value = ''
    attempted.value = []
  },
  { flush: 'sync' }
)
watch(
  selected,
  () => {
    confirmed.value = false
  },
  { deep: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  disposed = true
  purge()
})
function current(epoch: number) {
  return !disposed && epoch === generation && allowed.value
}
async function preview(input?: QuickOrderInput[]) {
  if (!allowed.value || busy.value) return
  error.value = ''
  notice.value = ''
  rows.value = []
  selected.value = []
  confirmed.value = false
  attempted.value = []
  const epoch = ++generation
  try {
    const parsed = input ?? parseQuickOrderCsv(csv.value)
    reading.value = true
    const result = await previewQuickOrder(parsed, async (path, options) => {
      if (!current(epoch)) throw new Error('obsolete_scope')
      const value: unknown = await request(path, options)
      if (!current(epoch)) throw new Error('obsolete_scope')
      return value
    })
    if (!current(epoch)) return
    rows.value = result.map((row) =>
      row.status === 'ready' && uncertain.has(row.variant.id)
        ? {
            reference: row.reference,
            quantity: row.quantity,
            status: 'error',
            message: 'Esta variante tuvo un resultado incierto. Revísala en el carrito; este panel no la reenviará.'
          }
        : row
    )
    selected.value = rows.value.flatMap((row, index) => (row.status === 'ready' ? [index] : []))
    remaining.value = []
    if (!input) added.value = 0
  } catch {
    if (current(epoch))
      error.value =
        'No se pudo previsualizar. Usa referencia,cantidad, hasta 10 filas, cantidades enteras de 1 a 999 y máximo 8 KiB. No se recorta el lote.'
  } finally {
    if (current(epoch)) reading.value = false
  }
}
async function resume() {
  if (!remaining.value.length || !allowed.value || busy.value) return
  if (cart.pendingMutation || cart.blockedMutations) {
    error.value = 'Resuelve primero la adición pendiente en el carrito. No se reenviará desde este panel.'
    return
  }
  // This is a fresh read-only preview, never an automatic continuation/POST.
  await preview(remaining.value.map((row) => ({ ...row })))
}
async function addSelection() {
  if (!allowed.value || busy.value || !confirmed.value || !selectedRows.value.length) return
  if (cart.pendingMutation || cart.blockedMutations) {
    error.value = 'Revisa la adición pendiente en el carrito antes de añadir otras referencias.'
    return
  }
  const selection = selectedRows.value.map((row) => ({ ...row }))
  const epoch = generation
  adding.value = true
  confirmed.value = false
  error.value = ''
  notice.value = ''
  try {
    for (const [index, row] of selection.entries()) {
      if (!current(epoch)) return
      if (cart.pendingMutation || cart.blockedMutations) {
        remaining.value = selection.slice(index).map(({ reference, quantity }) => ({ reference, quantity }))
        notice.value = `${added.value} ${added.value === 1 ? 'adición confirmada' : 'adiciones confirmadas'}. ${remaining.value.length} filas sin intentar. Revisa el carrito antes de continuar.`
        return
      }
      const rowIndex = rows.value.indexOf(
        rows.value.find((item) => item.status === 'ready' && item.variant.id === row.variant.id)!
      )
      attempted.value = [...attempted.value, rowIndex]
      try {
        await cart.add({ variantId: row.variant.id }, row.quantity)
        if (!current(epoch)) return
        added.value++
      } catch {
        if (!current(epoch)) return
        uncertain.add(row.variant.id)
        remaining.value = selection.slice(index + 1).map(({ reference, quantity }) => ({ reference, quantity }))
        notice.value = `${added.value} ${added.value === 1 ? 'adición confirmada' : 'adiciones confirmadas'}. Una adición tiene resultado incierto; ${remaining.value.length} filas sin intentar. Comprueba la adición en el carrito. No se reenviará esa referencia desde este panel.`
        return
      }
    }
    notice.value = `${added.value} ${added.value === 1 ? 'adición confirmada' : 'adiciones confirmadas'} en el carrito. Revisa allí los precios actuales antes de comprar.`
  } finally {
    if (current(epoch)) adding.value = false
  }
}
function money(cents: number) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100)
}
function maximum(row: QuickOrderReady) {
  return Math.min(
    999,
    row.variant.maximumQuantity ?? Infinity,
    row.variant.backorderAllowed ? Infinity : row.variant.stock
  )
}
</script>

<template>
  <section class="mx-auto w-full min-w-0 max-w-4xl space-y-5 px-4 py-8" aria-labelledby="quick-title">
    <h1 id="quick-title" class="text-2xl font-semibold">Pedido rápido por SKU / EAN</h1>
    <p v-if="runtime !== 'cloudflare'" role="status">
      Este pedido rápido requiere el catálogo Cloudflare. Puedes usar el catálogo y carrito habituales.
    </p>
    <p v-else-if="!allowed" role="status">
      Espera a verificar la sesión o verifica el correo de tu cuenta para continuar.
    </p>
    <template v-else>
      <p id="quick-help">
        Escribe o pega CSV con cabecera <code>referencia,cantidad</code>. Máximo 10 filas y 8 KiB. Cada cantidad cuenta
        unidades de compra de la variante, no litros ni unidades inferidas. Identificadores exactos SKU, EAN, GTIN o
        MPN; no nombres.
      </p>
      <p class="text-sm">
        Ejemplo de formato: <code>referencia,cantidad</code> seguido de una línea <code>TU-SKU,2</code>. Sin recortes ni
        sumas automáticas de duplicados.
      </p>
      <form data-quick-input class="space-y-3" @submit.prevent="preview()">
        <label for="quick-csv" class="block font-medium">Referencias y cantidades</label>
        <textarea
          id="quick-csv"
          v-model="csv"
          data-quick-csv
          rows="7"
          class="block w-full min-w-0 rounded border p-3 font-mono"
          aria-describedby="quick-help"
          :disabled="busy || remaining.length > 0"
        />
        <button
          type="submit"
          data-quick-preview
          class="rounded border px-4 py-2"
          :disabled="busy || !csv.trim() || remaining.length > 0"
        >
          Previsualizar catálogo actual
        </button>
      </form>
      <p v-if="reading" data-quick-loading role="status">
        Consultando referencias: máximo 20 productos únicos por previsualización…
      </p>
      <p v-if="error" data-quick-error role="alert" class="break-words">{{ error }}</p>
      <div aria-live="polite" class="break-words">
        <p v-if="notice">{{ notice }}</p>
      </div>
      <template v-if="rows.length">
        <p>
          Coincidencias exactas observadas entre los candidatos devueltos; la API no acredita unicidad en todo el
          catálogo. Precios e IVA observados ahora: no son una cotización contractual, no incluyen portes ni condiciones
          finales. El carrito vuelve a validar cantidades y precios.
        </p>
        <ul data-quick-results class="min-w-0 space-y-3 break-words">
          <li v-for="(row, index) in rows" :key="index" class="min-w-0 rounded border p-4">
            <p class="font-medium">{{ row.reference }} · {{ row.quantity }}</p>
            <p v-if="row.status === 'error'" role="alert">{{ row.message }}</p>
            <template v-else>
              <label class="flex min-w-0 items-start gap-2"
                ><input
                  v-model="selected"
                  type="checkbox"
                  :value="index"
                  :data-quick-select="index"
                  :disabled="busy || attempted.includes(index)"
                /><span
                  >Seleccionar {{ row.name }} — {{ row.variant.format }} ({{ row.variant.unitLabel }})</span
                ></label
              >
              <p>
                Mínimo {{ row.variant.minimumQuantity }} · Incremento {{ row.variant.quantityIncrement }} · Máximo
                {{ maximum(row) }} {{ row.variant.unitLabel }}
              </p>
              <p>
                {{ money(row.unitGrossCents) }} / {{ row.variant.unitLabel }} con IVA · {{ money(row.netCents) }} sin
                IVA + {{ money(row.taxCents) }} IVA ({{ row.variant.taxRateBasisPoints / 100 }} %) =
                {{ money(row.grossCents) }}
              </p>
              <p class="text-sm">Versión de precio observada: {{ row.variant.pricingVersion }}.</p>
              <p v-if="attempted.includes(index)">Fila intentada; no se volverá a enviar desde esta selección.</p>
            </template>
          </li>
        </ul>
        <div class="space-y-3">
          <label class="flex items-start gap-2"
            ><input
              v-model="confirmed"
              data-quick-confirm
              type="checkbox"
              :disabled="busy || !selectedRows.length"
            /><span>He revisado las filas seleccionadas, cantidades y precios observados.</span></label
          >
          <button
            data-quick-add
            type="button"
            class="rounded border px-4 py-2"
            :disabled="busy || !confirmed || !selectedRows.length"
            @click="addSelection"
          >
            {{ adding ? 'Añadiendo…' : 'Añadir selección al carrito' }}
          </button>
        </div>
      </template>
      <div v-if="remaining.length" class="space-y-2">
        <p>
          Las filas sin intentar requieren una nueva previsualización y confirmación. Resolver el carrito no prueba por
          sí solo el resultado de la fila incierta.
        </p>
        <button data-quick-resume type="button" class="rounded border px-4 py-2" :disabled="busy" @click="resume">
          Previsualizar filas sin intentar
        </button>
      </div>
      <NuxtLink to="/carrito" class="inline-block underline">Ir al carrito y comprobar adición</NuxtLink>
    </template>
  </section>
</template>
