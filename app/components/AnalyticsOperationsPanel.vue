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
    capture_applied: 'Capturas aplicadas',
    refund_confirmed: 'Reembolsos confirmados',
    fiscal_issued: 'Documentos fiscales ordinarios'
  } as const,
  eventLabels = {
    page_view: 'Páginas vistas',
    catalog_viewed: 'Catálogo consultado',
    search_completed: 'Búsquedas completadas',
    product_viewed: 'Productos consultados',
    cart_item_added: 'Adiciones al carrito',
    cart_item_removed: 'Retiradas del carrito',
    checkout_started: 'Checkouts iniciados',
    web_vital: 'Mediciones de rendimiento',
    promotional_impression: 'Impresiones promocionales',
    promotional_click: 'Clics en promociones'
  } as const,
  issueLabels = {
    missing: 'Proyección pendiente',
    mismatch: 'Proyección discordante',
    unconfirmed: 'Fuente no confirmada'
  },
  hintLabels = {
    projection_pending: 'Revisar la proyección gobernada en el servidor; esta pantalla no la ejecuta.',
    projection_mismatch: 'Revisar el hecho proyectado frente al contrato de origen inmutable.',
    source_proof_unavailable: 'Revisar las pruebas durables del contrato y su recibo; no reenviar operaciones.',
    capture_provenance_unavailable:
      'Falta procedencia histórica de la captura; no inferir entorno ni movimiento bancario.'
  } as const
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
  <section class="space-y-6" aria-labelledby="analytics-heading">
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 id="analytics-heading" class="text-2xl font-bold">Analítica operativa</h1>
        <p class="mt-1 text-sm text-muted">Hechos del servidor y medición consentida, separados. Sólo lectura.</p>
      </div>
      <UButton
        v-if="authorize()"
        type="button"
        icon="i-lucide-refresh-cw"
        variant="outline"
        :disabled="loading"
        data-testid="analytics-refresh"
        @click="refresh"
      >
        Actualizar lecturas
      </UButton>
    </header>

    <p v-if="runtime !== 'cloudflare'" data-testid="analytics-runtime-unavailable" role="status">
      Esta analítica requiere el servicio D1 de Cloudflare. No está disponible en Node ni en un entorno desconocido.
    </p>
    <p v-else-if="!authorize()" data-testid="analytics-auth-required" role="status">
      Requiere identidad actual confirmada, email verificado y MFA. El permiso administrativo se comprueba en el
      servidor.
    </p>
    <template v-else>
      <form class="flex flex-wrap items-end gap-4 rounded-lg border border-default p-4" @submit.prevent="refresh">
        <div class="space-y-1">
          <label for="analytics-from" class="block text-sm font-medium">Desde · UTC, incluido</label>
          <input
            id="analytics-from"
            v-model="fromDate"
            type="date"
            class="rounded-md border border-default p-2"
            required
          />
        </div>
        <div class="space-y-1">
          <label for="analytics-to" class="block text-sm font-medium">Hasta · UTC, excluido</label>
          <input id="analytics-to" v-model="toDate" type="date" class="rounded-md border border-default p-2" required />
        </div>
        <UButton type="submit" :disabled="loading" data-testid="analytics-apply">Consultar rango</UButton>
        <p class="w-full text-sm text-muted">
          Máximo 31 días. El rango inicial contiene los últimos 7 días UTC completos.
        </p>
      </form>
      <p v-if="rangeError" role="alert" data-testid="analytics-range-error">
        Elige fechas UTC válidas, con inicio anterior al final y un máximo de 31 días.
      </p>
      <p v-if="!applied && !rangeError" role="status">Rango cambiado: consulta de nuevo para confirmar los datos.</p>
      <p v-if="denied" role="alert" data-testid="analytics-access-denied">
        El servidor no confirma el acceso actual. Los datos anteriores se han eliminado; verifica la sesión y actualiza
        explícitamente.
      </p>
      <p v-if="contextError" role="alert" data-testid="analytics-context-error">
        Las lecturas no corresponden a la misma política y población confirmadas. No se combinan; actualiza ambas
        lecturas.
      </p>
      <p v-if="summary.loading.value" role="status" data-testid="analytics-loading">
        Confirmando métricas, cobertura e identidad vigente…
      </p>
      <p v-if="summary.failed.value" role="alert" data-testid="analytics-read-error">
        No hay una lectura confirmada de las métricas. Un fallo no equivale a actividad cero. Puedes actualizar
        explícitamente.
      </p>

      <template v-if="snapshot">
        <div class="rounded-lg border border-default p-4 text-sm" data-testid="analytics-provenance">
          <p class="font-medium">
            Fuente: Cloudflare D1 · {{ snapshot.population.environment }} · perfil {{ snapshot.schemaVersion }} de sólo
            lectura
          </p>
          <p>Observado: {{ analyticsInstant(snapshot.generatedAt) }}</p>
          <p>Periodo: [{{ snapshot.period.from }}, {{ snapshot.period.to }}) · inicio incluido, final excluido</p>
          <p>
            Política: {{ snapshot.policy.reference }} · versión {{ snapshot.policy.version }} · retención
            {{ snapshot.policy.retentionDays }} días
          </p>
          <p>Propósito: medición propia. Esta lectura no certifica liquidación bancaria ni aceptación externa.</p>
        </div>
        <p
          v-if="snapshot.population.validationOnly"
          class="rounded-lg border border-warning p-4"
          role="status"
          data-testid="analytics-validation-only"
        >
          Datos de validación local o preview. No representan ventas reales, movimientos bancarios ni documentos
          fiscales válidos.
        </p>
        <p
          v-if="
            snapshot.coverage.status !== 'complete' || Object.values(snapshot.metrics).some((value) => value === null)
          "
          class="rounded-lg border border-warning p-4"
          role="status"
          data-testid="analytics-partial"
        >
          {{
            snapshot.coverage.status === 'unavailable'
              ? 'Cobertura no disponible'
              : snapshot.coverage.status === 'partial'
                ? 'Cobertura parcial'
                : 'Métricas parcialmente disponibles'
          }}. Consulta la cobertura y las definiciones antes de interpretar importes ausentes. «No disponible» no
          significa cero.
        </p>
        <p
          v-if="
            snapshot.coverage.status === 'complete' &&
            snapshot.coverage.streams.every((stream) => stream.sourceCount === 0)
          "
          role="status"
          data-testid="analytics-commerce-empty"
        >
          Sin fuentes financieras confirmadas en este rango y población. La medición del navegador se muestra por
          separado.
        </p>
        <div class="grid gap-4 md:grid-cols-3" data-testid="analytics-money">
          <article class="rounded-lg border border-default p-4">
            <h2 class="text-sm font-medium">Cobrado bruto</h2>
            <p class="mt-2 text-2xl font-semibold" data-testid="analytics-gross">
              {{ analyticsMoney(snapshot.metrics.grossCollectedCents) }}
            </p>
            <p class="mt-1 text-sm">Capturas aplicadas: {{ analyticsCount(snapshot.metrics.capturedOrders) }}</p>
            <p class="mt-2 text-sm text-muted">{{ definition('grossCollectedCents') }}</p>
          </article>
          <article class="rounded-lg border border-default p-4">
            <h2 class="text-sm font-medium">Reembolsado confirmado</h2>
            <p class="mt-2 text-2xl font-semibold" data-testid="analytics-refunded">
              {{ analyticsMoney(snapshot.metrics.refundedCents) }}
            </p>
            <p class="mt-1 text-sm">Operaciones confirmadas: {{ analyticsCount(snapshot.metrics.confirmedRefunds) }}</p>
            <p class="mt-2 text-sm text-muted">{{ definition('refundedCents') }}</p>
          </article>
          <article class="rounded-lg border border-default p-4">
            <h2 class="text-sm font-medium">Cobrado menos reembolsos</h2>
            <p class="mt-2 text-2xl font-semibold" data-testid="analytics-after-refunds">
              {{ analyticsMoney(snapshot.metrics.collectedAfterRefundsCents) }}
            </p>
            <p class="mt-2 text-sm text-muted">{{ definition('collectedAfterRefundsCents') }}</p>
          </article>
        </div>
        <article class="rounded-lg border border-default p-4" data-testid="analytics-fiscal">
          <h2 class="font-semibold">Documentación fiscal ordinaria · No es una venta</h2>
          <p class="mt-2">
            {{ analyticsCount(snapshot.metrics.issuedFiscalDocuments) }} documentos ·
            {{ analyticsMoney(snapshot.metrics.issuedFiscalCents) }}
          </p>
          <p class="mt-2 text-sm text-muted">{{ definition('issuedFiscalCents') }}</p>
        </article>

        <section class="space-y-3" aria-labelledby="analytics-coverage-heading">
          <h2 id="analytics-coverage-heading" class="text-lg font-semibold">Cobertura y retraso de proyección</h2>
          <p class="text-sm text-muted">
            Fuentes elegibles, no confirmadas y excluidas se distinguen. Los retrasos se observan respecto a la fecha
            del servidor.
          </p>
          <div class="overflow-x-auto rounded-lg border border-default">
            <table class="w-full text-left text-sm" data-testid="analytics-coverage">
              <caption class="sr-only">
                Cobertura de las tres corrientes financieras del periodo
              </caption>
              <thead>
                <tr class="bg-elevated">
                  <th scope="col" class="p-3">Corriente</th>
                  <th scope="col" class="p-3">Fuentes</th>
                  <th scope="col" class="p-3">Elegibles</th>
                  <th scope="col" class="p-3">Sin confirmar</th>
                  <th scope="col" class="p-3">Excluidas</th>
                  <th scope="col" class="p-3">Proyectadas</th>
                  <th scope="col" class="p-3">Pendientes</th>
                  <th scope="col" class="p-3">Retraso más antiguo</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="stream in snapshot.coverage.streams" :key="stream.kind" class="border-t border-default">
                  <th scope="row" class="p-3 font-medium">
                    {{ streamLabels[stream.kind] }}
                    <p
                      v-if="stream.provenance === 'legacy_capture_unavailable'"
                      class="mt-1 text-xs font-normal text-muted"
                    >
                      Procedencia histórica de captura no verificable.
                    </p>
                  </th>
                  <td class="p-3">{{ analyticsCount(stream.sourceCount) }}</td>
                  <td class="p-3">{{ analyticsCount(stream.eligibleCount) }}</td>
                  <td class="p-3">{{ analyticsCount(stream.unconfirmedCount) }}</td>
                  <td class="p-3">{{ analyticsCount(stream.excludedCount) }}</td>
                  <td class="p-3">{{ analyticsCount(stream.projectedCount) }}</td>
                  <td class="p-3">{{ analyticsCount(stream.backlogCount) }}</td>
                  <td class="p-3">
                    {{
                      stream.backlogCount === 0
                        ? 'Sin pendientes elegibles'
                        : analyticsLag(stream.oldestUnprojectedAt, snapshot.generatedAt)
                    }}
                    <p v-if="stream.oldestUnprojectedAt" class="mt-1 text-xs text-muted">
                      {{ analyticsInstant(stream.oldestUnprojectedAt) }}
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section
          class="space-y-3 rounded-lg border border-default p-4"
          aria-labelledby="analytics-browser-heading"
          data-testid="analytics-browser"
        >
          <h2 id="analytics-browser-heading" class="text-lg font-semibold">Medición consentida del navegador</h2>
          <p class="text-sm text-muted">{{ definition('browserEvents') }}</p>
          <p>
            Sesiones anónimas medidas: {{ analyticsCount(snapshot.browser.uniqueSessions) }}. Sin autoridad financiera
            ni conversiones atribuidas.
          </p>
          <dl class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div v-for="event in snapshot.browser.eventCounts" :key="event.name">
              <dt class="text-sm text-muted">{{ eventLabels[event.name] }}</dt>
              <dd class="font-semibold">{{ analyticsCount(event.count) }}</dd>
            </div>
          </dl>
          <p
            v-if="snapshot.browser.eventCounts.every((event) => event.count === 0)"
            data-testid="analytics-browser-empty"
          >
            No hay eventos de navegador confirmados en este periodo. Esto no demuestra ausencia de compras.
          </p>
        </section>

        <details class="rounded-lg border border-default p-4" data-testid="analytics-definitions">
          <summary class="cursor-pointer font-medium">Definiciones, población y fuentes</summary>
          <dl class="mt-4 space-y-4">
            <div v-for="item in snapshot.definitions" :key="item.key">
              <dt class="font-semibold">{{ item.label }}</dt>
              <dd class="mt-1 text-sm">{{ item.definition }}</dd>
              <dd class="mt-1 text-sm text-muted">Población: {{ item.population }}</dd>
              <dd class="mt-1 break-words text-xs text-muted">Fuente: {{ item.source }}</dd>
            </div>
          </dl>
        </details>
      </template>

      <section
        v-if="applied && !denied && !contextError"
        class="space-y-3"
        aria-labelledby="analytics-reconciliation-heading"
      >
        <header class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="analytics-reconciliation-heading" class="text-lg font-semibold">Excepciones de conciliación</h2>
            <p class="text-sm text-muted">
              Comparación de fuentes y hechos proyectados. No certifica banco ni fiscalidad; no ejecuta correcciones.
            </p>
          </div>
          <UButton
            type="button"
            variant="outline"
            :disabled="reconciliation.loading.value"
            data-testid="analytics-reconciliation-refresh"
            @click="refreshExceptions"
            >Actualizar excepciones</UButton
          >
        </header>
        <p v-if="reconciliation.loading.value" role="status" data-testid="analytics-reconciliation-loading">
          Confirmando excepciones del rango y de la página solicitados…
        </p>
        <p v-if="reconciliation.failed.value" role="alert" data-testid="analytics-reconciliation-error">
          No hay una conciliación confirmada. No se interpreta como una lista vacía; actualiza explícitamente.
        </p>
        <template v-if="exceptionView">
          <p class="text-sm text-muted">
            Fuente: Cloudflare D1 · {{ exceptionView.population.environment }} · observado
            {{ analyticsInstant(exceptionView.generatedAt) }}
          </p>
          <p class="text-sm text-muted">
            Política: {{ exceptionView.policy.reference }} · versión {{ exceptionView.policy.version }} · retención
            {{ exceptionView.policy.retentionDays }} días · [{{ exceptionView.period.from }},
            {{ exceptionView.period.to }})
          </p>
          <p v-if="exceptionView.population.validationOnly && !snapshot" role="status">
            Conciliación de validación local o preview; no confirma operaciones reales.
          </p>
          <dl class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="analytics-reconciliation-summary">
            <div>
              <dt class="text-sm text-muted">Fuentes observadas</dt>
              <dd>{{ analyticsCount(exceptionView.summary.sourceCount) }}</dd>
            </div>
            <div>
              <dt class="text-sm text-muted">Proyecciones pendientes</dt>
              <dd>{{ analyticsCount(exceptionView.summary.missingCount) }}</dd>
            </div>
            <div>
              <dt class="text-sm text-muted">Discordancias</dt>
              <dd>{{ analyticsCount(exceptionView.summary.mismatchCount) }}</dd>
            </div>
            <div>
              <dt class="text-sm text-muted">Sin prueba confirmada</dt>
              <dd>{{ analyticsCount(exceptionView.summary.unconfirmedCount) }}</dd>
            </div>
            <div>
              <dt class="text-sm text-muted">Fuentes excluidas</dt>
              <dd>{{ analyticsCount(exceptionView.summary.excludedCount) }}</dd>
            </div>
            <div>
              <dt class="text-sm text-muted">Retraso observado</dt>
              <dd>
                {{
                  exceptionView.summary.projectionLagSeconds === null
                    ? 'No disponible'
                    : `${analyticsCount(exceptionView.summary.projectionLagSeconds)} s`
                }}
              </dd>
            </div>
          </dl>
          <p v-if="exceptionView.pagination.total === 0" role="status" data-testid="analytics-reconciliation-empty">
            Sin excepciones confirmadas dentro de este rango y población. No certifica actividad, liquidación ni
            aceptación externa.
          </p>
          <div v-else class="overflow-x-auto rounded-lg border border-default">
            <table class="w-full text-left text-sm" data-testid="analytics-issues">
              <caption class="sr-only">
                Excepciones de conciliación de sólo lectura, sin datos de contacto
              </caption>
              <thead>
                <tr class="bg-elevated">
                  <th scope="col" class="p-3">Incidencia / fuente</th>
                  <th scope="col" class="p-3">Referencia técnica</th>
                  <th scope="col" class="p-3">Fecha UTC</th>
                  <th scope="col" class="p-3">Retraso</th>
                  <th scope="col" class="p-3">Revisión necesaria</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="issue in exceptionView.issues"
                  :key="`${issue.code}:${issue.sourceKind}:${issue.sourceId}`"
                  class="border-t border-default"
                >
                  <th scope="row" class="p-3 font-medium">
                    {{ issueLabels[issue.code] }}
                    <p class="mt-1 text-xs font-normal text-muted">{{ streamLabels[issue.sourceKind] }}</p>
                  </th>
                  <td class="p-3 font-mono text-xs">{{ issue.sourceId }}</td>
                  <td class="p-3">{{ analyticsInstant(issue.occurredAt) }}</td>
                  <td class="p-3">
                    {{ issue.lagSeconds === null ? 'No disponible' : `${analyticsCount(issue.lagSeconds)} s` }}
                  </td>
                  <td class="p-3">{{ hintLabels[issue.hint] }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div
            v-if="exceptionView.pagination.pages > 0"
            class="flex flex-wrap items-center justify-between gap-3"
            aria-label="Paginación de excepciones"
          >
            <p class="text-sm">
              Página {{ exceptionView.pagination.page }} de {{ exceptionView.pagination.pages }} ·
              {{ analyticsCount(exceptionView.pagination.total) }} excepciones
            </p>
            <div class="flex gap-2">
              <UButton
                type="button"
                variant="outline"
                :disabled="reconciliation.loading.value || exceptionView.pagination.page <= 1"
                data-testid="analytics-previous"
                @click="changePage(exceptionView.pagination.page - 1)"
                >Anterior</UButton
              ><UButton
                type="button"
                variant="outline"
                :disabled="
                  reconciliation.loading.value || exceptionView.pagination.page >= exceptionView.pagination.pages
                "
                data-testid="analytics-next"
                @click="changePage(exceptionView.pagination.page + 1)"
                >Siguiente</UButton
              >
            </div>
          </div>
        </template>
      </section>
    </template>
  </section>
</template>
