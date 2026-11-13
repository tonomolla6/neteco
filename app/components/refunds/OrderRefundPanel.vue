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
import type { AdminTone } from '~/utils/adminLabels'

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
  denied = ref(false),
  /** Solo interfaz: el servicio de reembolsos no está activado (la lectura responde 503). */
  unavailable = ref(false)
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
  unavailable.value = false
  const read = async (endpoint: string): Promise<unknown> =>
    requestFetch(endpoint, {
      method: 'GET',
      retry: 0,
      cache: 'no-store',
      onResponseError(context: unknown) {
        if (current() && responseStatus(context) === 503) unavailable.value = true
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
function responseStatus(context: unknown): number | null {
  if (!context || typeof context !== 'object' || !('response' in context)) return null
  const response: unknown = context.response
  if (!response || typeof response !== 'object' || !('status' in response)) return null
  return typeof response.status === 'number' ? response.status : null
}
type RefundItem = FinancialSnapshot['refunds']['items'][number]
const workflowBadges: Record<RefundItem['workflow'], [string, AdminTone]> = {
  awaiting_confirmation: ['Pendiente de autorizar', 'warning'],
  queued: ['Autorizado, pendiente de enviar', 'info'],
  leased: ['En comprobación', 'info'],
  submitting: ['Enviándose al banco', 'warning'],
  pending_provider: ['Esperando al banco', 'warning'],
  uncertain: ['Sin confirmar', 'warning'],
  reconciling: ['En comprobación', 'warning'],
  cancelled: ['Cancelado', 'neutral'],
  manual_review: ['Requiere revisión', 'danger'],
  completed: ['Reembolsado', 'success']
}
function workflowBadge(item: RefundItem): [string, AdminTone] {
  return item.workflow === 'completed' && item.validationOnly
    ? ['Completado (prueba)', 'info']
    : workflowBadges[item.workflow]
}
const inProgress = (item: RefundItem) =>
  ['submitting', 'pending_provider', 'uncertain', 'reconciling'].includes(item.workflow)
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
    unavailable.value = false
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
  <AdminCard
    v-if="audience === 'admin'"
    aria-label="Reembolsos y facturas rectificativas"
    title="Reembolsos"
    description="Dinero devuelto al cliente por este pedido y sus facturas rectificativas."
  >
    <template v-if="authorize()" #actions>
      <AdminButton size="sm" icon="i-lucide-rotate-cw" data-testid="refunds-refresh" :loading="loading" @click="reload">
        Actualizar
      </AdminButton>
    </template>
    <div class="adm-stack">
      <UAlert
        v-if="!authorize()"
        role="status"
        data-testid="refunds-access"
        color="warning"
        variant="subtle"
        icon="i-lucide-lock"
        title="Confirma tu sesión para ver los reembolsos"
        description="Hace falta tener el correo verificado y la verificación en dos pasos."
      />
      <template v-else>
        <p v-if="loading" role="status" data-testid="refunds-loading" class="adm-help">Cargando los reembolsos…</p>
        <div v-else-if="unavailable" role="status" data-testid="refunds-unavailable">
          <AdminEmptyState
            compact
            icon="i-lucide-banknote"
            title="Los reembolsos no están activados en esta tienda"
            description="Cuando se activen, aquí verás el dinero devuelto de este pedido y podrás preparar reembolsos nuevos."
          />
        </div>
        <div v-else-if="failed" role="alert" data-testid="refunds-read-error">
          <AdminEmptyState
            variant="error"
            compact
            title="No hemos podido cargar los reembolsos"
            description="No significa que no haya ninguno. Vuelve a intentarlo antes de preparar otro."
          >
            <AdminButton size="sm" icon="i-lucide-rotate-cw" @click="reload">Reintentar</AdminButton>
          </AdminEmptyState>
        </div>
        <div v-if="snapshot" data-testid="refunds-facts" class="adm-stack">
          <UAlert
            v-if="localValidation"
            role="status"
            data-testid="refunds-validation"
            color="warning"
            variant="subtle"
            icon="i-lucide-flask-conical"
            title="Datos de prueba"
            description="Estas operaciones son simuladas: no hay movimiento en el banco ni facturas rectificativas con validez."
          />
          <dl class="grid grid-cols-2 gap-x-5 gap-y-4 lg:grid-cols-4">
            <div>
              <dt class="adm-help">Cobrado</dt>
              <dd class="mt-0.5 whitespace-nowrap text-base font-semibold tabular-nums text-[var(--text-strong)]">
                {{ financialAmount(snapshot.refunds.capturedCents) }}
              </dd>
            </div>
            <div>
              <dt class="adm-help">Reembolsos en curso o hechos</dt>
              <dd class="mt-0.5 whitespace-nowrap text-base font-semibold tabular-nums text-[var(--text-strong)]">
                {{ financialAmount(snapshot.refunds.reservedCents) }}
              </dd>
            </div>
            <div>
              <dt class="adm-help">Reembolsado</dt>
              <dd class="mt-0.5 whitespace-nowrap text-base font-semibold tabular-nums text-[var(--text-strong)]">
                {{ financialAmount(snapshot.refunds.confirmedCents) }}
              </dd>
            </div>
            <div v-if="localValidation">
              <dt class="adm-help">Reembolsado (prueba)</dt>
              <dd class="mt-0.5 whitespace-nowrap text-base font-semibold tabular-nums text-[var(--text-strong)]">
                {{ financialAmount(snapshot.refunds.simulatedConfirmedCents) }}
              </dd>
            </div>
          </dl>
          <div v-if="snapshot.refunds.items.length === 0" data-testid="refunds-empty">
            <AdminEmptyState
              compact
              icon="i-lucide-banknote"
              title="Este pedido no tiene reembolsos"
              description="Cuando prepares uno, aparecerá aquí con su estado y su factura rectificativa."
            />
          </div>
          <ul v-else class="divide-y divide-[var(--border)] border-y border-[var(--border)]">
            <li v-for="item in snapshot.refunds.items" :key="item.id" class="py-4" :data-testid="`refund-${item.id}`">
              <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <h3 class="whitespace-nowrap font-semibold tabular-nums text-[var(--text-strong)]">
                      {{ financialAmount(item.amountCents) }}
                    </h3>
                    <AdminBadge :tone="workflowBadge(item)[1]" class="whitespace-nowrap" :title="refundLabel(item)">
                      {{ workflowBadge(item)[0] }}
                    </AdminBadge>
                  </div>
                  <p class="mt-1 text-xs text-[var(--text-muted)]">
                    Devolución <span class="whitespace-nowrap tabular-nums">{{ item.returnPublicRef }}</span>
                  </p>
                </div>
              </div>
              <UAlert
                v-if="inProgress(item)"
                class="mt-3"
                color="warning"
                variant="subtle"
                icon="i-lucide-hourglass"
                title="No repitas este reembolso"
                description="Está en curso o falta confirmar su resultado."
              />
              <ul class="mt-3 space-y-1.5">
                <li
                  v-for="line in item.components"
                  :key="`${line.component}:${line.lineIndex}`"
                  class="flex items-baseline justify-between gap-4"
                >
                  <span class="min-w-0 break-words text-[var(--text)]">
                    {{ line.component === 'shipping' ? 'Gastos de envío' : line.description }}
                    <span class="text-xs text-[var(--text-muted)]">
                      · {{ line.sku }} · {{ line.quantity }} {{ line.quantity === 1 ? 'unidad' : 'unidades' }}
                    </span>
                  </span>
                  <span class="whitespace-nowrap tabular-nums">{{ financialAmount(line.grossCents) }}</span>
                </li>
              </ul>
              <div
                v-if="creditFor(item.id)"
                class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2.5"
              >
                <div class="min-w-0">
                  <p class="font-medium text-[var(--text-strong)]">{{ creditLabel(creditFor(item.id)!) }}</p>
                  <p v-if="creditFor(item.id)!.code" class="text-xs text-[var(--text-muted)]">
                    Número <span class="whitespace-nowrap tabular-nums">{{ creditFor(item.id)!.code }}</span>
                  </p>
                  <p
                    v-if="['issuing', 'uncertain', 'reconciling'].includes(creditFor(item.id)!.workflow)"
                    class="mt-1 text-xs text-[var(--text-muted)]"
                  >
                    Se está emitiendo: no vuelvas a pedirla. La factura original no cambia.
                  </p>
                </div>
                <a
                  v-if="privateCreditHref(creditFor(item.id)!, audience)"
                  :href="privateCreditHref(creditFor(item.id)!, audience)!"
                  data-testid="credit-private-pdf"
                  referrerpolicy="no-referrer"
                  rel="noreferrer"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                >
                  <UIcon name="i-lucide-download" class="size-4" />
                  {{ creditFor(item.id)!.validationOnly ? 'Descargar documento de prueba' : 'Descargar rectificativa' }}
                </a>
              </div>
              <p v-else class="adm-help mt-3">{{ correctiveLabel(item) }}</p>
            </li>
          </ul>
          <p class="adm-help">
            Un reembolso confirmado no indica el día en que el banco abona el dinero, ni devuelve las unidades al stock.
          </p>
        </div>
        <!-- Keep the admin slot mounted while a fresh read clears the snapshot:
             unmounting its command session would lose an ambiguous replay key. -->
        <slot
          name="admin"
          :snapshot="snapshot?.refunds ?? null"
          :credits="snapshot?.credits ?? []"
          :reload="reload"
          :authorize="authorize"
          :operator-id="identity === 'guest' ? null : identity"
        />
      </template>
    </div>
  </AdminCard>
  <section
    v-else
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
    </template>
  </section>
</template>
