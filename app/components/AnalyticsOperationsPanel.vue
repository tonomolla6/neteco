<script setup lang="ts">
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import type { AnalyticsSnapshot, AnalyticsReconciliation } from '~~/shared/analytics-measurement'
import { useSupportRead } from './support/state'
import {
  analyticsRange,
  defaultAnalyticsDates,
  analyticsMoney,
  analyticsCount,
  analyticsInstant,
  analyticsLag,
  analyticsDenied,
  parseAnalyticsSnapshot,
  parseAnalyticsReconciliation,
  matchingAnalyticsPopulation,
  type AnalyticsRange,
  type AnalyticsQuery
} from './analytics/operations-ui'

const props = defineProps<{ runtime: unknown }>(),
  emit = defineEmits<{ loaded: [snapshot: AnalyticsSnapshot]; invalidated: [] }>(),
  { ready, loggedIn, user } = useUserSession(),
  requestFetch = useRequestFetch(),
  defaults = defaultAnalyticsDates(),
  fromDate = ref(defaults.from),
  toDate = ref(defaults.to),
  applied = shallowRef<AnalyticsRange | null>(null),
  rangeError = ref(false),
  denied = ref(false),
  contextError = ref(false),
  reconciliationPage = ref(1),
  perPage = 20
let active = true

const actor = computed(() => {
  const id = user.value?.id
  return typeof id === 'string' && catalogPolicyUuidSchema.safeParse(id).success ? id : null
})
function authorize() {
  return (
    active &&
    props.runtime === 'cloudflare' &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true &&
    actor.value !== null
  )
}
const readable = () => authorize() && !denied.value && applied.value !== null
function query(page: number): AnalyticsQuery {
  if (!applied.value) throw new Error('analytics_range_unconfirmed')
  return { ...applied.value, page, perPage }
}
async function request(endpoint: string, values: Record<string, string | number>) {
  const epoch = generation,
    owner = actor.value
  try {
    return await requestFetch<unknown>(endpoint, {
      method: 'GET',
      query: values,
      retry: 0,
      cache: 'no-store'
    })
  } catch (error) {
    if (generation === epoch && actor.value === owner && authorize() && analyticsDenied(error)) {
      denied.value = true
      invalidate()
    }
    throw error
  }
}
const summary = useSupportRead<AnalyticsSnapshot>({
    authorize: readable,
    owner: () => actor.value,
    request,
    endpoint: () => '/api/admin/analytics',
    query: () => query(1),
    decode: (raw) => parseAnalyticsSnapshot(raw, query(1))
  }),
  reconciliation = useSupportRead<AnalyticsReconciliation>({
    authorize: readable,
    owner: () => actor.value,
    request,
    endpoint: () => '/api/admin/analytics/reconciliation',
    query: () => query(reconciliationPage.value),
    decode: (raw) => parseAnalyticsReconciliation(raw, query(reconciliationPage.value))
  })

let generation = 0
function invalidate() {
  generation++
  summary.reset()
  reconciliation.reset()
  contextError.value = false
  emit('invalidated')
}
const snapshot = computed<AnalyticsSnapshot | null>(() =>
    readable() && !contextError.value ? summary.snapshot.value : null
  ),
  exceptionView = computed<AnalyticsReconciliation | null>(() =>
    readable() && !contextError.value ? reconciliation.snapshot.value : null
  ),
  loading = computed(() => summary.loading.value || reconciliation.loading.value)

watch(
  () => [summary.snapshot.value, reconciliation.snapshot.value] as const,
  ([left, right]) => {
    if (left && right && !matchingAnalyticsPopulation(left, right)) {
      invalidate()
      contextError.value = true
    }
  },
  { flush: 'sync' }
)
async function refresh() {
  if (!authorize() || loading.value) return
  let range: AnalyticsRange
  try {
    range = analyticsRange({ from: fromDate.value, to: toDate.value })
  } catch {
    invalidate()
    applied.value = null
    rangeError.value = true
    return
  }
  invalidate()
  denied.value = false
  rangeError.value = false
  reconciliationPage.value = 1
  applied.value = range
  const epoch = generation
  const results = await Promise.allSettled([summary.reload(), reconciliation.reload()])
  if (generation === epoch && readable() && !contextError.value && results[0]?.status === 'fulfilled')
    emit('loaded', results[0].value)
}
async function changePage(next: number) {
  const view = exceptionView.value
  if (
    !readable() ||
    reconciliation.loading.value ||
    !view ||
    !Number.isSafeInteger(next) ||
    next < 1 ||
    next > view.pagination.pages ||
    next === reconciliationPage.value
  )
    return
  reconciliation.reset()
  reconciliationPage.value = next
  await reconciliation.reload().catch(() => undefined)
}
async function refreshExceptions() {
  if (!readable() || reconciliation.loading.value) return
  reconciliation.reset()
  await reconciliation.reload().catch(() => undefined)
}
watch(
  [fromDate, toDate],
  () => {
    invalidate()
    applied.value = null
    rangeError.value = false
    reconciliationPage.value = 1
  },
  { flush: 'sync' }
)
watch(
  () => [props.runtime, ready.value, loggedIn.value, actor.value, user.value?.emailVerified, user.value?.mfaVerified],
  () => {
    invalidate()
    applied.value = null
    denied.value = false
    rangeError.value = false
    reconciliationPage.value = 1
    const dates = defaultAnalyticsDates()
    fromDate.value = dates.from
    toDate.value = dates.to
    if (authorize()) void refresh()
  },
  { immediate: true, flush: 'sync' }
)

const streamLabels = {
    capture_applied: 'Cobros',
    refund_confirmed: 'Reembolsos',
    fiscal_issued: 'Facturas'
  } as const,
  eventLabels = {
    page_view: 'Páginas vistas',
    catalog_viewed: 'Visitas al catálogo',
    search_completed: 'Búsquedas',
    product_viewed: 'Productos vistos',
    cart_item_added: 'Añadidos al carrito',
    cart_item_removed: 'Quitados del carrito',
    checkout_started: 'Compras iniciadas',
    web_vital: 'Mediciones de velocidad',
    promotional_impression: 'Impresiones promocionales',
    promotional_click: 'Clics en promociones'
  } as const,
  issueLabels = {
    missing: 'Pendiente de contabilizar',
    mismatch: 'No coincide con lo contabilizado',
    unconfirmed: 'Origen sin confirmar'
  },
  issueTones = { missing: 'warning', mismatch: 'danger', unconfirmed: 'neutral' } as const,
  hintLabels = {
    projection_pending: 'Lo debe revisar el equipo técnico; esta pantalla no la ejecuta.',
    projection_mismatch: 'Comparar el importe contabilizado con el del cobro original.',
    source_proof_unavailable: 'Revisar el justificante de la operación; no hay que repetirla.',
    capture_provenance_unavailable: 'Cobro antiguo sin datos de origen; no se puede asociar a un movimiento bancario.'
  } as const,
  presetOptions = [
    { value: '7', label: '7 días' },
    { value: '14', label: '14 días' },
    { value: '30', label: '30 días' }
  ],
  // El atajo activo se deduce de las fechas: así nunca queda desfasado respecto al rango.
  preset = computed({
    get: () => {
      const days = String(Math.round((Date.parse(toDate.value) - Date.parse(fromDate.value)) / 86_400_000))
      return toDate.value === defaultAnalyticsDates().to && presetOptions.some((option) => option.value === days)
        ? days
        : ''
    },
    set: (value: string) => {
      const days = Number(value),
        to = defaultAnalyticsDates().to
      if (!days) return
      fromDate.value = new Date(Date.parse(to) - days * 86_400_000).toISOString().slice(0, 10)
      toDate.value = to
      void refresh()
    }
  })
function definition(key: string) {
  return snapshot.value?.definitions.find((item) => item.key === key)?.definition
}
onBeforeUnmount(() => {
  active = false
  generation++
})
defineExpose({ refresh })
</script>

<template>
  <section class="adm-stack" aria-labelledby="analytics-heading">
    <h2 id="analytics-heading" class="sr-only">Cobros y actividad de la tienda</h2>

    <AdminCard v-if="runtime !== 'cloudflare'">
      <AdminEmptyState
        data-testid="analytics-runtime-unavailable"
        role="status"
        icon="i-lucide-chart-no-axes-combined"
        title="La analítica no está disponible en este entorno"
        description="Estas cifras solo se pueden consultar en la tienda publicada."
      />
    </AdminCard>
    <AdminCard v-else-if="!authorize()">
      <AdminEmptyState
        data-testid="analytics-auth-required"
        role="status"
        icon="i-lucide-lock"
        title="Confirma tu identidad para ver las cifras"
        description="Necesitas la sesión iniciada, el correo verificado y la verificación en dos pasos. El permiso se comprueba en el servidor."
      />
    </AdminCard>
    <template v-else>
      <form class="adm-toolbar" aria-label="Periodo de las cifras" @submit.prevent="refresh">
        <AdminFilters v-model="preset" :options="presetOptions" label="Periodo" />
        <label for="analytics-from" class="adm-help">Desde</label>
        <input id="analytics-from" v-model="fromDate" type="date" class="adm-input w-auto" required @change="refresh" />
        <label for="analytics-to" class="adm-help">Hasta (no incluido)</label>
        <input id="analytics-to" v-model="toDate" type="date" class="adm-input w-auto" required @change="refresh" />
        <button
          v-if="!applied"
          type="submit"
          class="adm-btn adm-btn--primary"
          :disabled="loading"
          data-testid="analytics-apply"
        >
          Consultar
        </button>
        <div class="adm-toolbar__end">
          <button
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="loading"
            data-testid="analytics-refresh"
            @click="refresh"
          >
            <UIcon name="i-lucide-rotate-cw" class="size-4" />Actualizar
          </button>
        </div>
      </form>

      <UAlert
        v-if="rangeError"
        role="alert"
        data-testid="analytics-range-error"
        color="error"
        variant="subtle"
        title="Revisa las fechas"
        description="La fecha inicial debe ser anterior a la final y el periodo no puede superar 31 días."
      />
      <p v-if="!applied && !rangeError" role="status" class="adm-help">
        Has cambiado el periodo: pulsa «Consultar» para ver sus cifras.
      </p>
      <UAlert
        v-if="denied"
        role="alert"
        data-testid="analytics-access-denied"
        color="error"
        variant="subtle"
        title="No tienes acceso a estas cifras"
        description="Hemos retirado los datos que había en pantalla. Vuelve a iniciar sesión y pulsa «Actualizar»."
      />
      <UAlert
        v-if="contextError"
        role="alert"
        data-testid="analytics-context-error"
        color="warning"
        variant="subtle"
        title="Las cifras han cambiado mientras se cargaban"
        description="Para no mezclar datos de momentos distintos no se muestran. Pulsa «Actualizar» para cargarlas de nuevo."
      />
      <div v-if="summary.loading.value" class="adm-grid" role="status" data-testid="analytics-loading">
        <span class="sr-only">Cargando cifras…</span>
        <div
          v-for="row in 4"
          :key="row"
          class="h-28 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        />
      </div>
      <AdminCard v-if="summary.failed.value">
        <AdminEmptyState
          role="alert"
          data-testid="analytics-read-error"
          variant="error"
          title="No hemos podido cargar las cifras"
          description="Un fallo de carga no equivale a actividad cero. Vuelve a intentarlo."
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="refresh">Reintentar</AdminButton>
        </AdminEmptyState>
      </AdminCard>

      <template v-if="snapshot">
        <UAlert
          v-if="snapshot.population.validationOnly"
          role="status"
          data-testid="analytics-validation-only"
          color="warning"
          variant="subtle"
          title="Datos de prueba"
          description="No representan ventas reales, movimientos bancarios ni facturas válidas."
        />
        <UAlert
          v-if="
            snapshot.coverage.status !== 'complete' || Object.values(snapshot.metrics).some((value) => value === null)
          "
          role="status"
          data-testid="analytics-partial"
          color="warning"
          variant="subtle"
          :title="
            snapshot.coverage.status === 'unavailable'
              ? 'Cobertura no disponible'
              : snapshot.coverage.status === 'partial'
                ? 'Cobertura parcial'
                : 'Métricas parcialmente disponibles'
          "
          description="Faltan datos por confirmar en este periodo. «No disponible» no significa cero."
        />
        <p
          v-if="
            snapshot.coverage.status === 'complete' &&
            snapshot.coverage.streams.every((stream) => stream.sourceCount === 0)
          "
          role="status"
          class="adm-help"
          data-testid="analytics-commerce-empty"
        >
          No hay cobros, reembolsos ni facturas en este periodo. La actividad de la web se muestra más abajo.
        </p>

        <div class="adm-grid" data-testid="analytics-money">
          <div class="adm-card adm-stat" :title="definition('grossCollectedCents')">
            <p class="adm-stat__label"><UIcon name="i-lucide-banknote" class="size-4" />Cobrado</p>
            <p class="adm-stat__value" data-testid="analytics-gross">
              {{ analyticsMoney(snapshot.metrics.grossCollectedCents) }}
            </p>
            <p class="adm-stat__foot">{{ analyticsCount(snapshot.metrics.capturedOrders) }} cobros</p>
          </div>
          <div class="adm-card adm-stat" :title="definition('refundedCents')">
            <p class="adm-stat__label"><UIcon name="i-lucide-undo-2" class="size-4" />Reembolsado</p>
            <p class="adm-stat__value" data-testid="analytics-refunded">
              {{ analyticsMoney(snapshot.metrics.refundedCents) }}
            </p>
            <p class="adm-stat__foot">{{ analyticsCount(snapshot.metrics.confirmedRefunds) }} reembolsos</p>
          </div>
          <div class="adm-card adm-stat" :title="definition('collectedAfterRefundsCents')">
            <p class="adm-stat__label"><UIcon name="i-lucide-wallet" class="size-4" />Cobrado menos reembolsos</p>
            <p class="adm-stat__value" data-testid="analytics-after-refunds">
              {{ analyticsMoney(snapshot.metrics.collectedAfterRefundsCents) }}
            </p>
            <p class="adm-stat__foot">Sin descontar costes ni comisiones</p>
          </div>
          <div class="adm-card adm-stat" :title="definition('issuedFiscalCents')" data-testid="analytics-fiscal">
            <p class="adm-stat__label"><UIcon name="i-lucide-file-text" class="size-4" />Facturas emitidas</p>
            <p class="adm-stat__value">{{ analyticsMoney(snapshot.metrics.issuedFiscalCents) }}</p>
            <p class="adm-stat__foot">
              {{ analyticsCount(snapshot.metrics.issuedFiscalDocuments) }} documentos. No es una venta: es lo facturado.
            </p>
          </div>
        </div>

        <AdminCard
          title="Actividad en la web"
          description="Solo se mide a los visitantes que han aceptado las cookies de medición."
          aria-labelledby="analytics-browser-heading"
          data-testid="analytics-browser"
        >
          <template #title><span id="analytics-browser-heading">Actividad en la web</span></template>
          <AdminEmptyState
            v-if="snapshot.browser.eventCounts.every((event) => event.count === 0)"
            compact
            icon="i-lucide-mouse-pointer-click"
            title="Sin visitas medidas en este periodo"
            description="Esto no demuestra ausencia de compras: solo que nadie aceptó la medición."
            data-testid="analytics-browser-empty"
          />
          <p class="adm-help">
            {{ analyticsCount(snapshot.browser.uniqueSessions) }} visitas anónimas medidas. Sin autoridad financiera ni
            conversiones atribuidas: estas cifras no se cruzan con los cobros.
          </p>
          <dl class="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-5">
            <div v-for="event in snapshot.browser.eventCounts" :key="event.name">
              <dt class="adm-help">{{ eventLabels[event.name] }}</dt>
              <dd class="text-lg font-semibold tabular-nums text-[var(--text-strong)]">
                {{ analyticsCount(event.count) }}
              </dd>
            </div>
          </dl>
        </AdminCard>

        <AdminCard
          flush
          title="Cobertura de los datos"
          description="Cuántos cobros, reembolsos y facturas del periodo están ya contabilizados en estas cifras."
          aria-labelledby="analytics-coverage-heading"
        >
          <template #title><span id="analytics-coverage-heading">Cobertura de los datos</span></template>
          <div class="adm-table-wrap">
            <table class="adm-table" data-testid="analytics-coverage">
              <caption class="sr-only">
                Cobertura de cobros, reembolsos y facturas del periodo
              </caption>
              <thead>
                <tr>
                  <th scope="col">Origen</th>
                  <th scope="col" data-numeric>Registros</th>
                  <th scope="col" data-numeric>Válidos</th>
                  <th scope="col" data-numeric>Sin confirmar</th>
                  <th scope="col" data-numeric>Excluidos</th>
                  <th scope="col" data-numeric>Contabilizados</th>
                  <th scope="col" data-numeric>Pendientes</th>
                  <th scope="col">Pendiente más antiguo</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="stream in snapshot.coverage.streams" :key="stream.kind">
                  <th scope="row">
                    {{ streamLabels[stream.kind] }}
                    <p v-if="stream.provenance === 'legacy_capture_unavailable'" class="adm-help font-normal">
                      Procedencia histórica de captura no verificable.
                    </p>
                  </th>
                  <td data-numeric>{{ analyticsCount(stream.sourceCount) }}</td>
                  <td data-numeric>{{ analyticsCount(stream.eligibleCount) }}</td>
                  <td data-numeric>{{ analyticsCount(stream.unconfirmedCount) }}</td>
                  <td data-numeric>{{ analyticsCount(stream.excludedCount) }}</td>
                  <td data-numeric>{{ analyticsCount(stream.projectedCount) }}</td>
                  <td data-numeric>{{ analyticsCount(stream.backlogCount) }}</td>
                  <td>
                    {{
                      stream.backlogCount === 0
                        ? 'Sin pendientes'
                        : analyticsLag(stream.oldestUnprojectedAt, snapshot.generatedAt)
                    }}
                    <p v-if="stream.oldestUnprojectedAt" class="adm-help">
                      {{ analyticsInstant(stream.oldestUnprojectedAt) }}
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </AdminCard>

        <details data-testid="analytics-definitions">
          <summary>Cómo se calculan estas cifras</summary>
          <dl class="mt-3 space-y-3">
            <div v-for="item in snapshot.definitions" :key="item.key">
              <dt class="font-semibold text-[var(--text-strong)]">{{ item.label }}</dt>
              <dd>{{ item.definition }}</dd>
              <dd class="adm-help">Se cuenta: {{ item.population }}</dd>
              <dd class="adm-help break-words">Origen: {{ item.source }}</dd>
            </div>
          </dl>
          <div class="adm-help mt-3 space-y-1" data-testid="analytics-provenance">
            <p>
              Periodo consultado: [{{ snapshot.period.from }}, {{ snapshot.period.to }}) · inicio incluido, final
              excluido
            </p>
            <p>Datos leídos el {{ analyticsInstant(snapshot.generatedAt) }} · {{ snapshot.population.environment }}</p>
            <p>
              Política de medición: {{ snapshot.policy.reference }} · versión {{ snapshot.policy.version }} · formato
              {{ snapshot.schemaVersion }} · los datos se conservan {{ snapshot.policy.retentionDays }} días
            </p>
            <p>Medición propia de la tienda: no sustituye al extracto del banco ni a la contabilidad.</p>
          </div>
        </details>
      </template>

      <AdminSection
        v-if="applied && !denied && !contextError"
        title="Operaciones pendientes de cuadrar"
        description="Cobros, reembolsos y facturas que todavía no coinciden con lo contabilizado. Solo consulta: aquí no se corrige nada."
        aria-labelledby="analytics-reconciliation-heading"
      >
        <template #actions>
          <span id="analytics-reconciliation-heading" class="sr-only">Operaciones pendientes de cuadrar</span>
          <button
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="reconciliation.loading.value"
            data-testid="analytics-reconciliation-refresh"
            @click="refreshExceptions"
          >
            <UIcon name="i-lucide-rotate-cw" class="size-4" />Actualizar
          </button>
        </template>
        <div class="adm-stack">
          <p
            v-if="reconciliation.loading.value"
            role="status"
            class="adm-help"
            data-testid="analytics-reconciliation-loading"
          >
            Comprobando las operaciones del periodo…
          </p>
          <AdminCard v-if="reconciliation.failed.value">
            <AdminEmptyState
              compact
              role="alert"
              data-testid="analytics-reconciliation-error"
              variant="error"
              title="No hemos podido comprobar las operaciones"
              description="Esto no significa que no haya ninguna pendiente. Vuelve a intentarlo."
            >
              <AdminButton icon="i-lucide-rotate-cw" @click="refreshExceptions">Reintentar</AdminButton>
            </AdminEmptyState>
          </AdminCard>
          <template v-if="exceptionView">
            <UAlert
              v-if="exceptionView.population.validationOnly && !snapshot"
              role="status"
              color="warning"
              variant="subtle"
              title="Datos de prueba"
              description="Esta comprobación no confirma operaciones reales."
            />
            <AdminCard>
              <dl
                class="grid gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6"
                data-testid="analytics-reconciliation-summary"
              >
                <div>
                  <dt class="adm-help">Operaciones revisadas</dt>
                  <dd class="text-lg font-semibold tabular-nums text-[var(--text-strong)]">
                    {{ analyticsCount(exceptionView.summary.sourceCount) }}
                  </dd>
                </div>
                <div>
                  <dt class="adm-help">Pendientes de contabilizar</dt>
                  <dd class="text-lg font-semibold tabular-nums text-[var(--text-strong)]">
                    {{ analyticsCount(exceptionView.summary.missingCount) }}
                  </dd>
                </div>
                <div>
                  <dt class="adm-help">No coinciden</dt>
                  <dd class="text-lg font-semibold tabular-nums text-[var(--text-strong)]">
                    {{ analyticsCount(exceptionView.summary.mismatchCount) }}
                  </dd>
                </div>
                <div>
                  <dt class="adm-help">Sin confirmar</dt>
                  <dd class="text-lg font-semibold tabular-nums text-[var(--text-strong)]">
                    {{ analyticsCount(exceptionView.summary.unconfirmedCount) }}
                  </dd>
                </div>
                <div>
                  <dt class="adm-help">Excluidas</dt>
                  <dd class="text-lg font-semibold tabular-nums text-[var(--text-strong)]">
                    {{ analyticsCount(exceptionView.summary.excludedCount) }}
                  </dd>
                </div>
                <div>
                  <dt class="adm-help">Retraso actual</dt>
                  <dd class="text-lg font-semibold tabular-nums text-[var(--text-strong)]">
                    {{
                      exceptionView.summary.projectionLagSeconds === null
                        ? 'No disponible'
                        : `${analyticsCount(exceptionView.summary.projectionLagSeconds)} s`
                    }}
                  </dd>
                </div>
              </dl>
              <p class="adm-help mt-4">
                Comprobado el {{ analyticsInstant(exceptionView.generatedAt) }} · periodo [{{
                  exceptionView.period.from
                }}, {{ exceptionView.period.to }}) · {{ exceptionView.population.environment }} · política
                {{ exceptionView.policy.reference }}, versión {{ exceptionView.policy.version }}, conservación
                {{ exceptionView.policy.retentionDays }} días
              </p>
            </AdminCard>
            <AdminCard v-if="exceptionView.pagination.total === 0">
              <AdminEmptyState
                compact
                role="status"
                icon="i-lucide-circle-check"
                title="Todo cuadra en este periodo"
                description="Sin excepciones confirmadas. Es una comprobación interna: no sustituye al extracto del banco."
                data-testid="analytics-reconciliation-empty"
              />
            </AdminCard>
            <AdminCard v-else flush>
              <div class="adm-table-wrap">
                <table class="adm-table" data-testid="analytics-issues">
                  <caption class="sr-only">
                    Operaciones pendientes de cuadrar, de solo lectura y sin datos de contacto
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Qué ocurre</th>
                      <th scope="col">Referencia</th>
                      <th scope="col">Fecha</th>
                      <th scope="col" data-numeric>Retraso</th>
                      <th scope="col">Qué hacer</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="issue in exceptionView.issues"
                      :key="`${issue.code}:${issue.sourceKind}:${issue.sourceId}`"
                    >
                      <th scope="row">
                        <AdminBadge :tone="issueTones[issue.code]">{{ issueLabels[issue.code] }}</AdminBadge>
                        <p class="adm-help mt-1 font-normal">{{ streamLabels[issue.sourceKind] }}</p>
                      </th>
                      <td class="font-mono break-all">{{ issue.sourceId }}</td>
                      <td>{{ analyticsInstant(issue.occurredAt) }}</td>
                      <td data-numeric>
                        {{ issue.lagSeconds === null ? 'No disponible' : `${analyticsCount(issue.lagSeconds)} s` }}
                      </td>
                      <td>{{ hintLabels[issue.hint] }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div
                v-if="exceptionView.pagination.pages > 0"
                class="adm-pagination"
                aria-label="Paginación de excepciones"
              >
                <p>
                  Página {{ exceptionView.pagination.page }} de {{ exceptionView.pagination.pages }} ·
                  {{ analyticsCount(exceptionView.pagination.total) }} operaciones
                </p>
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    class="adm-btn adm-btn--secondary adm-btn--sm"
                    :disabled="reconciliation.loading.value || exceptionView.pagination.page <= 1"
                    data-testid="analytics-previous"
                    @click="changePage(exceptionView.pagination.page - 1)"
                  >
                    Anterior
                  </button>
                  <button
                    type="button"
                    class="adm-btn adm-btn--secondary adm-btn--sm"
                    :disabled="
                      reconciliation.loading.value || exceptionView.pagination.page >= exceptionView.pagination.pages
                    "
                    data-testid="analytics-next"
                    @click="changePage(exceptionView.pagination.page + 1)"
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            </AdminCard>
          </template>
        </div>
      </AdminSection>
    </template>
  </section>
</template>
