<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { FunnelAnalyticsDashboardResponse } from '../../workers/analytics/funnel'

const props = defineProps<{ runtime: unknown }>()
const { ready, loggedIn, user } = useUserSession()
const requestFetch = useRequestFetch()

const fromDate = ref('')
const toDate = ref('')
const selectedDevice = ref<'all' | 'desktop' | 'mobile' | 'tablet'>('all')
const selectedSource = ref<'all' | 'direct' | 'organic' | 'cpc' | 'social' | 'email' | 'referral' | 'other'>('all')
const selectedSegment = ref<'all' | 'anonymous' | 'customer' | 'professional'>('all')

const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<FunnelAnalyticsDashboardResponse | null>(null)

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

async function fetchFunnel() {
  if (!isAuthorized.value) return
  loading.value = true
  error.value = null

  try {
    const params = new URLSearchParams()
    if (fromDate.value) params.set('from', `${fromDate.value}T00:00:00Z`)
    if (toDate.value) params.set('to', `${toDate.value}T23:59:59Z`)
    if (selectedDevice.value !== 'all') params.set('device', selectedDevice.value)
    if (selectedSource.value !== 'all') params.set('source', selectedSource.value)
    if (selectedSegment.value !== 'all') params.set('segment', selectedSegment.value)

    const response = await requestFetch<FunnelAnalyticsDashboardResponse>(
      `/api/admin/analytics/funnel${params.toString() ? `?${params.toString()}` : ''}`,
      { method: 'GET' }
    )
    data.value = response
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Error al cargar el embudo de conversión'
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
  void fetchFunnel()
})
function onDateChange() {
  preset.value = ''
  void fetchFunnel()
}
const keyLabels: Record<string, string> = {
  desktop: 'Ordenador',
  mobile: 'Móvil',
  tablet: 'Tableta',
  direct: 'Acceso directo',
  organic: 'Buscadores',
  cpc: 'Anuncios de pago',
  social: 'Redes sociales',
  email: 'Correo',
  referral: 'Otras webs',
  other: 'Otros',
  anonymous: 'Sin identificar',
  customer: 'Particular',
  professional: 'Profesional',
  unknown: 'Sin clasificar'
}
const keyLabel = (key: string) => keyLabels[key] ?? adminHumanize(key)
const breakdowns = computed(() =>
  data.value
    ? [
        { id: 'device', title: 'Por dispositivo', column: 'Dispositivo', rows: data.value.breakdown.byDevice },
        { id: 'source', title: 'Por origen de la visita', column: 'Origen', rows: data.value.breakdown.bySource },
        { id: 'segment', title: 'Por tipo de cliente', column: 'Cliente', rows: data.value.breakdown.bySegment }
      ]
    : []
)
const maxSessions = computed(() => Math.max(1, ...(data.value?.steps ?? []).map((step) => step.sessions)))

onMounted(() => {
  if (isAuthorized.value) {
    void fetchFunnel()
  }
})
</script>

<template>
  <div class="adm-stack">
    <AdminCard v-if="!isAuthorized">
      <AdminEmptyState
        icon="i-lucide-lock"
        title="El embudo no está disponible ahora"
        description="Necesitas la sesión iniciada, el correo verificado y la verificación en dos pasos, y solo se puede consultar en la tienda publicada."
      />
    </AdminCard>
    <template v-else>
      <form class="adm-toolbar" aria-label="Filtros del embudo" @submit.prevent="fetchFunnel">
        <AdminFilters v-model="preset" :options="presetOptions" label="Periodo" />
        <label for="funnel-from" class="adm-help">Desde</label>
        <input id="funnel-from" v-model="fromDate" type="date" class="adm-input w-auto" @change="onDateChange" />
        <label for="funnel-to" class="adm-help">Hasta</label>
        <input id="funnel-to" v-model="toDate" type="date" class="adm-input w-auto" @change="onDateChange" />
        <label for="funnel-device" class="sr-only">Dispositivo</label>
        <select id="funnel-device" v-model="selectedDevice" class="adm-input w-auto" @change="fetchFunnel">
          <option value="all">Todos los dispositivos</option>
          <option value="desktop">Ordenador</option>
          <option value="mobile">Móvil</option>
          <option value="tablet">Tableta</option>
        </select>
        <label for="funnel-source" class="sr-only">Origen de la visita</label>
        <select id="funnel-source" v-model="selectedSource" class="adm-input w-auto" @change="fetchFunnel">
          <option value="all">Todos los orígenes</option>
          <option value="direct">Acceso directo</option>
          <option value="organic">Buscadores</option>
          <option value="cpc">Anuncios de pago</option>
          <option value="social">Redes sociales</option>
          <option value="email">Correo</option>
          <option value="referral">Otras webs</option>
        </select>
        <label for="funnel-segment" class="sr-only">Tipo de cliente</label>
        <select id="funnel-segment" v-model="selectedSegment" class="adm-input w-auto" @change="fetchFunnel">
          <option value="all">Todos los clientes</option>
          <option value="anonymous">Sin identificar</option>
          <option value="customer">Particular</option>
          <option value="professional">Profesional</option>
        </select>
        <button
          type="submit"
          class="sr-only"
          tabindex="-1"
          :disabled="loading"
          data-testid="funnel-apply"
          @click.prevent="fetchFunnel"
        >
          Aplicar filtros
        </button>
        <div class="adm-toolbar__end">
          <button
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="loading"
            data-testid="funnel-refresh"
            @click="fetchFunnel"
          >
            <UIcon name="i-lucide-rotate-cw" class="size-4" :class="loading && 'animate-spin'" />Actualizar
          </button>
        </div>
      </form>

      <AdminCard v-if="error">
        <AdminEmptyState
          role="alert"
          data-testid="funnel-error"
          variant="error"
          title="No hemos podido cargar el embudo"
          description="Vuelve a intentarlo en unos segundos."
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="fetchFunnel">Reintentar</AdminButton>
        </AdminEmptyState>
      </AdminCard>

      <div v-else-if="loading && !data" class="adm-grid" aria-busy="true">
        <span class="sr-only">Cargando el embudo…</span>
        <div
          v-for="row in 4"
          :key="row"
          class="h-28 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        />
      </div>

      <template v-if="data">
        <div class="grid gap-5 xl:grid-cols-3">
          <AdminCard
            class="xl:col-span-2"
            title="Embudo de conversión"
            description="Cuántas visitas llegan a cada paso, de la primera página al pago."
          >
            <ol class="adm-breakdown">
              <li v-for="(s, idx) in data.steps" :key="s.step" :data-testid="`funnel-step-${s.step}`">
                <div class="adm-breakdown__row">
                  <span class="adm-breakdown__label">
                    {{ idx + 1 }}. {{ s.name }}
                    <AdminBadge
                      v-if="s.isSmallSampleWarning"
                      tone="warning"
                      plain
                      class="ml-1"
                      data-testid="funnel-sample-warning"
                    >
                      Muestra pequeña
                    </AdminBadge>
                  </span>
                  <span class="adm-breakdown__value">
                    {{ s.sessions }}
                    <small>visitas</small>
                  </span>
                  <span class="adm-breakdown__track">
                    <i :style="{ width: `${(s.sessions / maxSessions) * 100}%` }" />
                  </span>
                </div>
                <p v-if="idx > 0" class="adm-help mt-1">
                  <template v-if="s.conversionFromPrevious.rate !== null">
                    {{ formatPercent(s.conversionFromPrevious.rate) }} del paso anterior
                    <span
                      :title="`Intervalo de confianza del 95 %: el valor real está casi con seguridad entre estos dos porcentajes`"
                    >
                      (IC 95%:
                      {{ formatWilsonInterval(s.conversionFromPrevious.lower, s.conversionFromPrevious.upper) }})
                    </span>
                    ·
                  </template>
                  {{ formatPercent(s.conversionFromStart.rate) }} de las visitas
                </p>
              </li>
            </ol>
          </AdminCard>

          <AdminStat
            class="self-start"
            label="Visitas que acaban pagando"
            icon="i-lucide-badge-check"
            :value="formatPercent(data.overallConversion.rate)"
            :hint="`Margen de error (IC 95%): ${formatWilsonInterval(data.overallConversion.lower, data.overallConversion.upper)}`"
          />
        </div>

        <div class="grid gap-5 lg:grid-cols-3">
          <AdminCard v-for="group in breakdowns" :key="group.id" flush :title="group.title">
            <AdminEmptyState v-if="!group.rows.length" compact title="Sin visitas en este periodo" />
            <div v-else class="adm-table-wrap">
              <table class="adm-table">
                <thead>
                  <tr>
                    <th scope="col">{{ group.column }}</th>
                    <th scope="col" data-numeric>Visitas</th>
                    <th scope="col" data-numeric>Pagos</th>
                    <th scope="col" data-numeric>Conversión</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in group.rows" :key="item.key">
                    <td>{{ keyLabel(item.key) }}</td>
                    <td data-numeric>{{ item.sessions }}</td>
                    <td data-numeric>{{ item.purchaseSessions }}</td>
                    <td data-numeric class="font-semibold">{{ formatPercent(item.conversionRate) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </AdminCard>
        </div>
      </template>
    </template>
  </div>
</template>
