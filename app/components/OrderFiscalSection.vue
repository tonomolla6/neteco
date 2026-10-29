<script setup lang="ts">
import { fiscalUuid, type FiscalOrderView } from '~~/shared/fiscal-issuance'
import { parseFiscalOrderView } from '~~/shared/fiscal-view'

const props = defineProps<{
  orderId: string
  runtime: unknown
  audience: 'admin' | 'customer'
  /** A successful read of THIS current order, not an email or URL bearer. */
  orderAccessConfirmed?: boolean
}>()
const { ready, loggedIn, user } = useUserSession()
const requestFetch = useRequestFetch()
const snapshot = shallowRef<FiscalOrderView | null>(null),
  loading = ref(false),
  failed = ref(false)
let active = true,
  generation = 0
let flight: { key: string; epoch: number; promise: Promise<void> } | null = null
const identityKey = computed(() =>
  loggedIn.value === true && fiscalUuid.safeParse(user.value?.id).success
    ? user.value!.id
    : loggedIn.value === false && user.value === null
      ? 'guest'
      : null
)
const ownerKey = computed(() =>
  identityKey.value !== null && fiscalUuid.safeParse(props.orderId).success
    ? `${props.audience}:${props.orderId}:${identityKey.value}`
    : null
)
function authorize() {
  if (!active || props.runtime !== 'cloudflare' || ready.value !== true || ownerKey.value === null) return false
  if (props.audience === 'admin')
    return loggedIn.value === true && user.value?.emailVerified === true && user.value?.mfaVerified === true
  if (props.audience !== 'customer' || props.orderAccessConfirmed !== true) return false
  return loggedIn.value === true ? user.value?.emailVerified === true : identityKey.value === 'guest'
}
function reload(): Promise<void> {
  if (!authorize() || ownerKey.value === null) {
    snapshot.value = null
    return Promise.resolve()
  }
  const key = ownerKey.value,
    epoch = generation,
    orderId = props.orderId,
    audience = props.audience
  if (flight?.key === key && flight.epoch === epoch) return flight.promise
  snapshot.value = null
  loading.value = true
  failed.value = false
  const current = () => active && generation === epoch && ownerKey.value === key && authorize()
  const promise = Promise.resolve().then(async () => {
    try {
      if (!current()) return
      // Native resource: do not infer a legacy Nitro wildcard's method.
      const endpoint: string = `/api/${audience === 'admin' ? 'admin/' : ''}orders/${orderId}/fiscal`
      const raw: unknown = await requestFetch(endpoint, { method: 'GET', retry: 0, cache: 'no-store' })
      if (!current()) return
      const confirmed = parseFiscalOrderView(raw, orderId)
      if (current()) snapshot.value = confirmed
    } catch {
      if (current()) {
        snapshot.value = null
        failed.value = true
      }
    } finally {
      if (active && generation === epoch && ownerKey.value === key) {
        loading.value = false
        flight = null
      }
    }
  })
  flight = { key, epoch, promise }
  return promise
}
const stateLabel = computed(() => {
  if (!snapshot.value) return ''
  if (snapshot.value.validationOnly && snapshot.value.status === 'completed')
    return 'Documento de prueba · Sin validez fiscal'
  if (snapshot.value.fiscalStatus === 'fiscal_pending' && snapshot.value.status === 'completed')
    return 'Estado fiscal pendiente'
  if (snapshot.value.status === 'completed' && snapshot.value.fiscalStatus === 'issued') return 'Factura emitida'
  return {
    blocked_policy: 'Emisión pendiente de autorización',
    queued: 'Emisión en cola',
    leased: 'Comprobando emisión',
    issuing: 'Emisión en curso',
    uncertain: 'Resultado pendiente de confirmación',
    reconciling: 'Conciliación en curso',
    manual_review: 'Revisión manual necesaria',
    completed: 'Documento confirmado'
  }[snapshot.value.status]
})
const formattedAmount = computed(() =>
  snapshot.value?.amountCents === null || !snapshot.value
    ? null
    : new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(snapshot.value.amountCents / 100)
)
watch(
  () => [
    props.orderId,
    props.runtime,
    props.audience,
    props.orderAccessConfirmed,
    identityKey.value,
    ready.value,
    loggedIn.value,
    user.value?.emailVerified,
    user.value?.mfaVerified
  ],
  () => {
    generation++
    snapshot.value = null
    failed.value = false
    loading.value = false
    flight = null
    if (authorize()) void reload()
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  active = false
  generation++
  snapshot.value = null
  flight = null
})
</script>

<template>
  <section aria-label="Documento fiscal privado" class="space-y-3">
    <p v-if="!authorize()" role="status" class="text-sm text-slate-600">
      Confirma el acceso al pedido antes de consultar su documento fiscal.
    </p>
    <template v-else>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p v-if="loading" data-testid="fiscal-loading" role="status" class="text-sm text-slate-600">
          Confirmando documento fiscal…
        </p>
        <p v-else-if="failed" data-testid="fiscal-read-error" role="alert" class="text-sm text-amber-800">
          No se ha podido confirmar el documento. Esto no significa que no exista ni permite repetir su emisión.
        </p>
        <p v-else class="text-xs text-slate-500">Información fiscal privada · lectura confirmada</p>
        <button
          data-testid="fiscal-refresh"
          type="button"
          :disabled="loading"
          class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-50"
          @click="reload"
        >
          Actualizar documento
        </button>
      </div>
      <div v-if="snapshot" class="space-y-3 rounded-xl border border-slate-200 p-4">
        <p role="status" class="font-semibold text-slate-900">{{ stateLabel }}</p>
        <p v-if="snapshot.validationOnly" class="text-sm text-amber-800">
          Validación local sintética. Este documento no acredita una factura real ni la aceptación de Beply.
        </p>
        <p v-if="['uncertain', 'issuing', 'reconciling'].includes(snapshot.status)" class="text-sm text-amber-800">
          No reintentes la emisión. Hay una operación en curso o un resultado que debe conciliarse.
        </p>
        <dl v-if="snapshot.code || formattedAmount" class="grid gap-2 text-sm sm:grid-cols-2">
          <div v-if="snapshot.code">
            <dt class="text-slate-500">Documento</dt>
            <dd class="break-all font-medium">{{ snapshot.code }}</dd>
          </div>
          <div v-if="formattedAmount">
            <dt class="text-slate-500">Importe contractual</dt>
            <dd class="font-medium tabular-nums">{{ formattedAmount }}</dd>
          </div>
        </dl>
        <a
          v-if="audience === 'customer' && snapshot.pdfAvailable"
          :href="`/api/orders/${orderId}/invoice`"
          referrerpolicy="no-referrer"
          rel="noreferrer"
          class="inline-flex rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold"
        >
          {{ snapshot.validationOnly ? 'Descargar documento de prueba' : 'Descargar documento PDF' }}
        </a>
        <p v-else-if="audience === 'admin' && snapshot.pdfAvailable" class="text-xs text-slate-500">
          El PDF se entrega mediante el acceso privado del cliente; esta vista no concede un enlace público ni acceso de
          propietario.
        </p>
      </div>
    </template>
  </section>
</template>
