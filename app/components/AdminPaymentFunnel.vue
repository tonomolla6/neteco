<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { PaymentFunnelDashboardResponse } from '../../workers/payments/funnel-analytics'

const props = defineProps<{ runtime: unknown }>()
const { ready, loggedIn, user } = useUserSession()
const requestFetch = useRequestFetch()

const fromDate = ref('')
const toDate = ref('')
const selectedDevice = ref<'all' | 'desktop' | 'mobile' | 'tablet' | 'unknown'>('all')
const selectedMethod = ref<'all' | 'card' | 'bizum' | 'bank_transfer'>('all')
const selectedBank = ref<string>('all')

const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<PaymentFunnelDashboardResponse | null>(null)

const isAuthorized = computed(() => {
  return (
    props.runtime === 'cloudflare' &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true
  )
})

function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '-'
  return `${(rate * 100).toFixed(1)}%`
}

function formatWilsonInterval(lower: number, upper: number): string {
  return `[${(lower * 100).toFixed(1)}% - ${(upper * 100).toFixed(1)}%]`
}

async function fetchPaymentFunnel() {
  if (!isAuthorized.value) return
  loading.value = true
  error.value = null

  try {
    const params = new URLSearchParams()
    if (fromDate.value) params.set('from', `${fromDate.value}T00:00:00Z`)
    if (toDate.value) params.set('to', `${toDate.value}T23:59:59Z`)
    if (selectedDevice.value !== 'all') params.set('device', selectedDevice.value)
    if (selectedMethod.value !== 'all') params.set('method', selectedMethod.value)
    if (selectedBank.value !== 'all') params.set('bank', selectedBank.value)

    const response = await requestFetch<PaymentFunnelDashboardResponse>(
      `/api/admin/payments/funnel${params.toString() ? `?${params.toString()}` : ''}`,
      { method: 'GET' }
    )
    data.value = response
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Error al cargar el funnel de pago'
  } finally {
    loading.value = false
  }
}

const preset = ref('')
const presetOptions = [
  { value: '7', label: '7 días' },
  { value: '30', label: '30 días' },
  { value: '90', label: '90 días' }
]
watch(preset, (value) => {
  if (!value) return
  const end = new Date()
  fromDate.value = new Date(end.getTime() - Number(value) * 86_400_000).toISOString().slice(0, 10)
  toDate.value = end.toISOString().slice(0, 10)
  void fetchPaymentFunnel()
})
function onDateChange() {
  preset.value = ''
  void fetchPaymentFunnel()
}
const breakdowns = computed(() =>
  data.value
    ? [
        { id: 'device', title: 'Por dispositivo', column: 'Dispositivo', rows: data.value.breakdowns.byDevice },
        { id: 'method', title: 'Por forma de pago', column: 'Forma de pago', rows: data.value.breakdowns.byMethod },
        { id: 'bank', title: 'Por banco del cliente', column: 'Banco', rows: data.value.breakdowns.byBank }
      ]
    : []
)
const maxStage = computed(() => Math.max(1, ...(data.value?.stages ?? []).map((stage) => stage.count)))

onMounted(() => {
  if (isAuthorized.value) {
    void fetchPaymentFunnel()
  }
})
</script>

<template>
  <div class="adm-stack">
    <AdminCard v-if="!isAuthorized">
      <AdminEmptyState
        icon="i-lucide-lock"
        title="El embudo de pago no está disponible ahora"
        description="Necesitas la sesión iniciada, el correo verificado y la verificación en dos pasos, y solo se puede consultar en la tienda publicada."
      />
    </AdminCard>
    <template v-else>
      <form class="adm-toolbar" aria-label="Filtros del embudo de pago" @submit.prevent="fetchPaymentFunnel">
        <AdminFilters v-model="preset" :options="presetOptions" label="Periodo" />
        <label for="payment-funnel-from" class="adm-help">Desde</label>
        <input
          id="payment-funnel-from"
          v-model="fromDate"
          type="date"
          class="adm-input w-auto"
          @change="onDateChange"
        />
        <label for="payment-funnel-to" class="adm-help">Hasta</label>
        <input id="payment-funnel-to" v-model="toDate" type="date" class="adm-input w-auto" @change="onDateChange" />
        <label for="payment-funnel-device" class="sr-only">Dispositivo</label>
        <select
          id="payment-funnel-device"
          v-model="selectedDevice"
          class="adm-input w-auto"
          @change="fetchPaymentFunnel"
        >
          <option value="all">Todos los dispositivos</option>
          <option value="desktop">Ordenador</option>
          <option value="mobile">Móvil</option>
          <option value="tablet">Tableta</option>
          <option value="unknown">Desconocido</option>
        </select>
        <label for="payment-funnel-method" class="sr-only">Forma de pago</label>
        <select
          id="payment-funnel-method"
          v-model="selectedMethod"
          class="adm-input w-auto"
          @change="fetchPaymentFunnel"
        >
          <option value="all">Todas las formas de pago</option>
          <option value="card">Tarjeta</option>
          <option value="bizum">Bizum</option>
          <option value="bank_transfer">Transferencia</option>
        </select>
        <label for="payment-funnel-bank" class="sr-only">Banco del cliente</label>
        <select id="payment-funnel-bank" v-model="selectedBank" class="adm-input w-auto" @change="fetchPaymentFunnel">
          <option value="all">Todos los bancos</option>
          <option value="BBVA">BBVA</option>
          <option value="Santander">Santander</option>
          <option value="CaixaBank">CaixaBank</option>
          <option value="Sabadell">Banco Sabadell</option>
          <option value="Bankinter">Bankinter</option>
          <option value="Otro">Otro</option>
        </select>
        <button
          type="submit"
          class="sr-only"
          tabindex="-1"
          :disabled="loading"
          data-testid="payment-funnel-apply"
          @click.prevent="fetchPaymentFunnel"
        >
          Aplicar filtros
        </button>
        <div class="adm-toolbar__end">
          <button
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="loading"
            data-testid="payment-funnel-refresh"
            @click="fetchPaymentFunnel"
          >
            <UIcon name="i-lucide-rotate-cw" class="size-4" :class="loading && 'animate-spin'" />Actualizar
          </button>
        </div>
      </form>

      <AdminCard v-if="error">
        <AdminEmptyState
          role="alert"
          data-testid="payment-funnel-error"
          variant="error"
          title="No hemos podido cargar los pagos"
          description="Vuelve a intentarlo en unos segundos."
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="fetchPaymentFunnel">Reintentar</AdminButton>
        </AdminEmptyState>
      </AdminCard>

      <div v-else-if="loading && !data" class="adm-grid" aria-busy="true">
        <span class="sr-only">Cargando los pagos…</span>
        <div
          v-for="row in 5"
          :key="row"
          class="h-28 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        />
      </div>

      <template v-if="data">
        <div class="adm-grid">
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-credit-card" class="size-4" />Intentos de pago</p>
            <p class="adm-stat__value" data-testid="summary-total-attempts">{{ data.summary.totalAttempts }}</p>
            <p class="adm-stat__foot">Clientes que llegaron a pagar</p>
          </div>
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-circle-check" class="size-4" />Pagos cobrados</p>
            <p class="adm-stat__value" data-testid="summary-authorized">{{ data.summary.authorizedCount }}</p>
            <p class="adm-stat__foot">Autorizados por el banco</p>
          </div>
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-percent" class="size-4" />Pagos con éxito</p>
            <p class="adm-stat__value" data-testid="summary-success-rate">
              {{ formatPercent(data.summary.authorizationRate) }}
            </p>
            <p
              class="adm-stat__foot"
              title="Intervalo de confianza del 95 %: el valor real está casi con seguridad entre estos dos porcentajes"
            >
              Margen de error:
              {{ formatWilsonInterval(data.summary.wilsonInterval.lower, data.summary.wilsonInterval.upper) }}
            </p>
          </div>
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-ban" class="size-4" />Pagos rechazados</p>
            <p class="adm-stat__value" data-testid="summary-decline-rate">
              {{ formatPercent(data.summary.declineRate) }}
            </p>
            <p class="adm-stat__foot">{{ data.summary.declinedCount }} rechazados por el banco</p>
          </div>
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-log-out" class="size-4" />Pagos abandonados</p>
            <p class="adm-stat__value" data-testid="summary-cancellation-rate">
              {{ formatPercent(data.summary.cancellationRate) }}
            </p>
            <p class="adm-stat__foot">{{ data.summary.cancelledCount }} sin terminar</p>
          </div>
        </div>

        <div class="grid gap-5 xl:grid-cols-2">
          <AdminCard title="Pasos del pago" description="Cuántos intentos superan cada paso.">
            <ol class="adm-breakdown">
              <li v-for="(st, idx) in data.stages" :key="st.step" :data-testid="`funnel-step-${st.step}`">
                <div class="adm-breakdown__row">
                  <span class="adm-breakdown__label">
                    {{ idx + 1 }}. {{ st.name }}
                    <AdminBadge
                      v-if="st.isSmallSampleWarning"
                      tone="warning"
                      plain
                      class="ml-1"
                      title="Menos de 30 intentos: el porcentaje es poco fiable"
                      data-testid="funnel-sample-warning"
                    >
                      Muestra pequeña
                    </AdminBadge>
                  </span>
                  <span class="adm-breakdown__value">{{ st.count }}</span>
                  <span class="adm-breakdown__track">
                    <i :style="{ width: `${(st.count / maxStage) * 100}%` }" />
                  </span>
                </div>
                <p v-if="idx > 0" class="adm-help mt-1">
                  {{ formatPercent(st.conversionFromPrevious.rate) }} del paso anterior ·
                  {{ formatPercent(st.conversionFromStart.rate) }} de los intentos
                </p>
              </li>
            </ol>
          </AdminCard>

          <AdminCard
            flush
            title="Por qué se rechazan los pagos"
            :description="`${data.summary.declinedCount} pagos rechazados en el periodo`"
          >
            <AdminEmptyState
              v-if="data.declineCauses.length === 0"
              compact
              icon="i-lucide-circle-check"
              title="Ningún pago rechazado"
              description="No hay rechazos en el periodo seleccionado."
            />
            <div v-else class="adm-table-wrap">
              <table class="adm-table" data-testid="payment-decline-causes-table">
                <thead>
                  <tr>
                    <th scope="col">Motivo</th>
                    <th scope="col">Código del banco</th>
                    <th scope="col" data-numeric>Pagos</th>
                    <th scope="col" data-numeric>Parte del total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="cause in data.declineCauses" :key="`${cause.category}-${cause.code}`">
                    <td>
                      <span class="font-semibold text-[var(--text-strong)]">{{ cause.label }}</span>
                      <span class="adm-breakdown__track mt-1.5 block">
                        <i :style="{ width: `${Math.min(100, Math.max(0, cause.percentage * 100))}%` }" />
                      </span>
                    </td>
                    <td class="adm-help tabular-nums">{{ cause.code }}</td>
                    <td data-numeric>{{ cause.count }}</td>
                    <td data-numeric>{{ formatPercent(cause.percentage) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </AdminCard>
        </div>

        <div class="grid gap-5 lg:grid-cols-3">
          <AdminCard v-for="group in breakdowns" :key="group.id" flush :title="group.title">
            <div class="adm-table-wrap">
              <table class="adm-table" :data-testid="`breakdown-${group.id}-table`">
                <thead>
                  <tr>
                    <th scope="col">{{ group.column }}</th>
                    <th scope="col" data-numeric>Intentos</th>
                    <th scope="col" data-numeric>Con éxito</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in group.rows" :key="item.key">
                    <td>{{ item.label }}</td>
                    <td data-numeric>{{ item.attempts }}</td>
                    <td data-numeric class="font-semibold">{{ formatPercent(item.successRate) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </AdminCard>
        </div>

        <p class="adm-help" data-testid="payment-funnel-privacy-notice">
          Estas cifras no guardan números de tarjeta, códigos de seguridad ni datos personales.
        </p>
      </template>
    </template>
  </div>
</template>
