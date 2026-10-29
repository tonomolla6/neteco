<script setup lang="ts">
import { fiscalUuid } from '~~/shared/fiscal-issuance'
import {
  parseRefunds,
  parseCredit,
  parseFinancialSnapshot,
  financialAmount,
  refundLabel,
  creditLabel,
  correctiveLabel,
  privateCreditHref,
  financialResponseErrorCode,
  financialAccessDenied,
  type FinancialSnapshot
} from './financial-ui'

const props = defineProps<{
  orderId: string
  runtime: unknown
  audience: 'admin' | 'customer'
  /** Confirmed access to THIS current order, using existing session/guest cookie. */
  orderAccessConfirmed?: boolean
}>()
const emit = defineEmits<{ loaded: [snapshot: FinancialSnapshot]; invalidated: [] }>()
const { ready, loggedIn, user } = useUserSession(),
  requestFetch = useRequestFetch()
const snapshot = shallowRef<FinancialSnapshot | null>(null),
  loading = ref(false),
  failed = ref(false),
  denied = ref(false)
let active = true,
  epoch = 0,
  sequence = 0
const identity = computed(() =>
  loggedIn.value === true && fiscalUuid.safeParse(user.value?.id).success
    ? user.value!.id
    : loggedIn.value === false && user.value === null
      ? 'guest'
      : null
)
const owner = computed(() =>
  identity.value !== null && fiscalUuid.safeParse(props.orderId).success
    ? `${props.audience}:${props.orderId}:${identity.value}`
    : null
)
function authorize() {
  if (!active || denied.value || ready.value !== true || props.runtime !== 'cloudflare' || owner.value === null)
    return false
  if (props.audience === 'admin')
    return loggedIn.value === true && user.value?.emailVerified === true && user.value?.mfaVerified === true
  return (
    props.audience === 'customer' &&
    props.orderAccessConfirmed === true &&
    (loggedIn.value === true ? user.value?.emailVerified === true : identity.value === 'guest')
  )
}
function invalidate() {
  snapshot.value = null
  emit('invalidated')
}
async function reload(): Promise<FinancialSnapshot | null> {
  if (!authorize()) {
    invalidate()
    return null
  }
  const key = owner.value,
    generation = epoch,
    request = ++sequence,
    orderId = props.orderId,
    audience = props.audience,
    current = () => active && generation === epoch && request === sequence && key === owner.value && authorize()
  invalidate()
  loading.value = true
  failed.value = false
  const read = async (endpoint: string): Promise<unknown> =>
    requestFetch(endpoint, {
      method: 'GET',
      retry: 0,
      cache: 'no-store',
      onResponseError(context: unknown) {
        if (current() && financialAccessDenied(financialResponseErrorCode(context))) {
          denied.value = true
          invalidate()
        }
      }
    })
  try {
    const prefix = `/api/${audience === 'admin' ? 'admin/' : ''}orders/${orderId}`,
      raw = await read(`${prefix}/refunds`)
    if (!current()) return null
    const refunds = parseRefunds(raw, orderId, audience),
      credits = []
    // Only identifiers from the owned DTO. No tokens, storage keys, current
    // catalog prices or speculative/guessable cross-order credit requests.
    for (const item of refunds.items) {
      if (item.creditId === null) continue
      if (!current()) return null
      const value = await read(`${prefix}/credits/${item.creditId}`)
      if (!current()) return null
      credits.push(parseCredit(value, item, audience))
    }
    const confirmed = parseFinancialSnapshot({ refunds, credits }, orderId, audience)
    if (!current()) return null
    snapshot.value = confirmed
    emit('loaded', confirmed)
    return confirmed
  } catch {
    if (active && generation === epoch && request === sequence && key === owner.value) {
      invalidate()
      failed.value = true
    }
    return null
  } finally {
    if (active && generation === epoch && request === sequence && key === owner.value) loading.value = false
  }
}
const localValidation = computed(() => snapshot.value?.refunds.items.some((item) => item.validationOnly) === true)
const creditFor = (refundId: string) => snapshot.value?.credits.find((item) => item.refundId === refundId)
watch(
  () => [
    props.orderId,
    props.runtime,
    props.audience,
    props.orderAccessConfirmed,
    identity.value,
    ready.value,
    loggedIn.value,
    user.value?.emailVerified,
    user.value?.mfaVerified
  ],
  () => {
    epoch++
    sequence++
    denied.value = false
    loading.value = false
    failed.value = false
    invalidate()
    if (authorize()) void reload()
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  active = false
  epoch++
  sequence++
  invalidate()
})
defineExpose({ reload })
</script>

<template>
  <section
    aria-label="Reembolsos y rectificativas privados"
    class="space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-6"
  >
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold text-slate-900">Reembolsos y rectificativas</h2>
        <p class="mt-1 text-sm text-slate-600">Importes históricos del pedido · acceso privado</p>
      </div>
      <button
        v-if="authorize()"
        type="button"
        data-testid="refunds-refresh"
        :disabled="loading"
        class="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold disabled:opacity-50"
        @click="reload"
      >
        Actualizar estado
      </button>
    </header>
    <p v-if="!authorize()" role="status" data-testid="refunds-access" class="text-sm text-slate-600">
      Confirma el acceso actual al pedido antes de consultar esta información.
    </p>
    <template v-else>
      <p v-if="loading" role="status" data-testid="refunds-loading" class="text-sm text-slate-600">
        Confirmando estado financiero…
      </p>
      <p
        v-else-if="failed"
        role="alert"
        data-testid="refunds-read-error"
        class="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
      >
        No se ha podido confirmar el estado. No significa que no haya una operación ni permite repetirla.
      </p>
      <div v-if="snapshot" data-testid="refunds-facts" class="space-y-4">
        <p
          v-if="localValidation"
          role="status"
          data-testid="refunds-validation"
          class="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
        >
          Validación local sintética. No acredita movimiento bancario, aceptación de Redsys ni una factura rectificativa
          real.
        </p>
        <dl class="grid grid-cols-2 gap-4 rounded-lg bg-slate-50 p-4 text-sm lg:grid-cols-4">
          <div>
            <dt class="text-slate-600">Captura histórica</dt>
            <dd class="mt-1 font-semibold tabular-nums">{{ financialAmount(snapshot.refunds.capturedCents) }}</dd>
          </div>
          <div>
            <dt class="text-slate-600">Importe comprometido</dt>
            <dd class="mt-1 font-semibold tabular-nums">{{ financialAmount(snapshot.refunds.reservedCents) }}</dd>
          </div>
          <div>
            <dt class="text-slate-600">Operaciones confirmadas</dt>
            <dd class="mt-1 font-semibold tabular-nums">{{ financialAmount(snapshot.refunds.confirmedCents) }}</dd>
          </div>
          <div v-if="localValidation">
            <dt class="text-slate-600">Confirmación simulada</dt>
            <dd class="mt-1 font-semibold tabular-nums">
              {{ financialAmount(snapshot.refunds.simulatedConfirmedCents) }}
            </dd>
          </div>
        </dl>
        <p class="text-xs text-slate-500">
          El importe comprometido incluye solicitudes pendientes o inciertas. Una confirmación de operación no acredita
          la fecha del abono bancario.
        </p>
        <p v-if="snapshot.refunds.items.length === 0" data-testid="refunds-empty" class="text-sm text-slate-600">
          No hay solicitudes de reembolso registradas en esta lectura.
        </p>
        <article
          v-for="item in snapshot.refunds.items"
          :key="item.id"
          class="space-y-3 rounded-lg border border-slate-200 p-4"
          :data-testid="`refund-${item.id}`"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 class="font-semibold text-slate-900">{{ refundLabel(item) }}</h3>
              <p class="mt-1 break-all text-xs text-slate-600">{{ item.returnPublicRef }}</p>
            </div>
            <p class="font-semibold tabular-nums">{{ financialAmount(item.amountCents) }}</p>
          </div>
          <p
            v-if="['submitting', 'pending_provider', 'uncertain', 'reconciling'].includes(item.workflow)"
            class="rounded bg-amber-50 p-3 text-sm text-amber-900"
          >
            No repitas el reembolso. Hay una operación en curso o un resultado que requiere confirmación.
          </p>
          <ul class="divide-y divide-slate-100 text-sm">
            <li
              v-for="line in item.components"
              :key="`${line.component}:${line.lineIndex}`"
              class="flex flex-wrap justify-between gap-2 py-2"
            >
              <span class="min-w-0 break-words"
                >{{ line.component === 'shipping' ? 'Portes históricos' : line.description
                }}<span class="block text-xs text-slate-500">{{ line.sku }} · {{ line.quantity }} ud.</span></span
              >
              <span class="tabular-nums">{{ financialAmount(line.grossCents) }}</span>
            </li>
          </ul>
          <p class="text-xs text-slate-500">
            Custodia no vendible. Esta operación no repone existencias automáticamente.
          </p>
          <div v-if="creditFor(item.id)" class="space-y-2 border-t border-slate-200 pt-3">
            <p class="text-sm font-medium">{{ creditLabel(creditFor(item.id)!) }}</p>
            <p v-if="creditFor(item.id)!.code" class="break-all text-xs text-slate-600">
              Referencia documental: {{ creditFor(item.id)!.code }}
            </p>
            <p
              v-if="['issuing', 'uncertain', 'reconciling'].includes(creditFor(item.id)!.workflow)"
              class="text-sm text-amber-900"
            >
              No reintentes la emisión. La factura original permanece inmutable.
            </p>
            <a
              v-if="privateCreditHref(creditFor(item.id)!, audience)"
              :href="privateCreditHref(creditFor(item.id)!, audience)!"
              data-testid="credit-private-pdf"
              referrerpolicy="no-referrer"
              rel="noreferrer"
              class="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold"
            >
              {{ creditFor(item.id)!.validationOnly ? 'Descargar documento de prueba' : 'Descargar PDF privado' }}
            </a>
          </div>
          <p v-else class="border-t border-slate-200 pt-3 text-sm text-slate-600">{{ correctiveLabel(item) }}</p>
        </article>
      </div>
      <!-- Keep the admin slot mounted while a fresh read clears the snapshot:
           unmounting its command session would lose an ambiguous replay key. -->
      <slot
        v-if="audience === 'admin'"
        name="admin"
        :snapshot="snapshot?.refunds ?? null"
        :credits="snapshot?.credits ?? []"
        :reload="reload"
        :authorize="authorize"
        :operator-id="identity === 'guest' ? null : identity"
      />
    </template>
  </section>
</template>
