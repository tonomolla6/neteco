<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { UpliftReport } from '~~/shared/personalized-rerank'

defineProps<{
  runtime?: unknown
}>()

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const report = ref<UpliftReport | null>(null)
const experiments = ref<Array<{ id: string; name: string; status: string }>>([])
const selectedExperimentId = ref('rerank_affinity_v1')
const selectId = useId()

async function loadUplift() {
  loading.value = true
  error.value = null
  try {
    const [expRes, upliftRes] = await Promise.all([
      requestFetch<{ items: Array<{ id: string; name: string; status: string }> }>(
        '/api/admin/search-personalization/experiments'
      ),
      requestFetch<UpliftReport>(`/api/admin/search-personalization/uplift?experimentId=${selectedExperimentId.value}`)
    ])
    experiments.value = expRes.items
    report.value = upliftRes
  } catch {
    error.value = 'No se ha podido cargar el resultado de la prueba de orden personalizado.'
  } finally {
    loading.value = false
  }
}

function formatPercent(val: number | undefined): string {
  if (val === undefined || Number.isNaN(val)) return '0.0%'
  const prefix = val > 0 ? '+' : ''
  return `${prefix}${val.toFixed(1)}%`
}

function formatCurrency(cents: number | undefined): string {
  if (!cents) return '0,00 €'
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`
}

onMounted(() => {
  void loadUplift()
})

const EXPERIMENT_STATUS: Record<string, string> = {
  running: 'en curso',
  active: 'en curso',
  paused: 'en pausa',
  completed: 'terminada',
  stopped: 'detenida',
  draft: 'borrador'
}
const experimentStatus = (code: string) => EXPERIMENT_STATUS[code.toLowerCase()] ?? adminStatusLabel(code).toLowerCase()
const rate = (value: number) => (value * 100).toFixed(1) + '%'
</script>

<template>
  <div class="adm-stack">
    <div class="adm-toolbar">
      <label :for="selectId" class="adm-label">Prueba</label>
      <select
        :id="selectId"
        v-model="selectedExperimentId"
        class="adm-input w-auto min-w-0"
        aria-label="Seleccionar experimento"
        @change="loadUplift"
      >
        <option v-for="exp in experiments" :key="exp.id" :value="exp.id">
          {{ exp.name }} ({{ experimentStatus(exp.status) }})
        </option>
      </select>
      <div class="adm-toolbar__end">
        <AdminButton size="sm" icon="i-lucide-rotate-cw" :loading="loading" @click="loadUplift">Actualizar</AdminButton>
      </div>
    </div>

    <UAlert
      v-if="error"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="error"
      :actions="[{ label: 'Reintentar', color: 'neutral', variant: 'outline', onClick: () => void loadUplift() }]"
    />

    <UAlert
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      title="El orden y los filtros que elige el cliente se respetan siempre"
      :description="
        'Si el cliente ordena por precio o por nombre, o aplica filtros, el orden personalizado no interviene.' +
        (report && report.explicitSortBypassHonoredCount > 0
          ? ` En esta prueba se respetó en ${report.explicitSortBypassHonoredCount} búsquedas.`
          : '')
      "
    />

    <div v-if="report" class="grid gap-5 md:grid-cols-3">
      <AdminCard title="Orden normal" description="Clientes que ven los resultados sin personalizar.">
        <dl class="adm-stack">
          <div class="flex justify-between gap-3">
            <dt class="text-[var(--text-muted)]">Veces mostrado</dt>
            <dd class="font-semibold text-[var(--text-strong)] tabular-nums">{{ report.control.impressions }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-[var(--text-muted)]">Clics</dt>
            <dd class="font-semibold text-[var(--text-strong)] tabular-nums">
              {{ report.control.clicks }} ({{ rate(report.control.ctr) }})
            </dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-[var(--text-muted)]">Compras</dt>
            <dd class="font-semibold text-[var(--text-strong)] tabular-nums">
              {{ report.control.conversions }} ({{ rate(report.control.cvr) }})
            </dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-[var(--text-muted)]">Ventas</dt>
            <dd class="font-semibold text-[var(--text-strong)] tabular-nums">
              {{ formatCurrency(report.control.revenueCents) }}
            </dd>
          </div>
        </dl>
      </AdminCard>

      <AdminCard title="Orden personalizado" description="Clientes que ven los resultados adaptados a sus compras.">
        <dl class="adm-stack">
          <div class="flex justify-between gap-3">
            <dt class="text-[var(--text-muted)]">Veces mostrado</dt>
            <dd class="font-semibold text-[var(--text-strong)] tabular-nums">{{ report.treatment.impressions }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-[var(--text-muted)]">Clics</dt>
            <dd class="font-semibold text-[var(--text-strong)] tabular-nums">
              {{ report.treatment.clicks }} ({{ rate(report.treatment.ctr) }})
            </dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-[var(--text-muted)]">Compras</dt>
            <dd class="font-semibold text-[var(--text-strong)] tabular-nums">
              {{ report.treatment.conversions }} ({{ rate(report.treatment.cvr) }})
            </dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-[var(--text-muted)]">Ventas</dt>
            <dd class="font-semibold text-[var(--text-strong)] tabular-nums">
              {{ formatCurrency(report.treatment.revenueCents) }}
            </dd>
          </div>
        </dl>
      </AdminCard>

      <AdminCard title="Diferencia" description="Lo que cambia con el orden personalizado.">
        <template #actions>
          <AdminBadge :tone="report.statisticallySignificant ? 'success' : 'neutral'">
            {{ report.statisticallySignificant ? 'Resultado fiable' : 'Faltan datos' }}
          </AdminBadge>
        </template>
        <dl class="adm-stack">
          <div class="flex justify-between gap-3">
            <dt class="text-[var(--text-muted)]">Clics</dt>
            <dd
              class="font-semibold tabular-nums"
              :class="report.ctrUpliftPercent >= 0 ? 'text-[var(--text-strong)]' : 'text-red-700'"
            >
              {{ formatPercent(report.ctrUpliftPercent) }}
            </dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-[var(--text-muted)]">Compras</dt>
            <dd
              class="font-semibold tabular-nums"
              :class="report.convUpliftPercent >= 0 ? 'text-[var(--text-strong)]' : 'text-red-700'"
            >
              {{ formatPercent(report.convUpliftPercent) }}
            </dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-[var(--text-muted)]">Ventas</dt>
            <dd
              class="font-semibold tabular-nums"
              :class="report.revenueUpliftPercent >= 0 ? 'text-[var(--text-strong)]' : 'text-red-700'"
            >
              {{ formatPercent(report.revenueUpliftPercent) }}
            </dd>
          </div>
        </dl>
        <template #footer>
          <span class="adm-help mr-auto">{{ report.totalEvaluatedEvents }} búsquedas analizadas</span>
        </template>
      </AdminCard>
    </div>

    <div v-else-if="loading" class="adm-card">
      <div class="adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando resultados…</span>
        <div v-for="row in 3" :key="row"><i /><i /><i /></div>
      </div>
    </div>

    <div v-else class="adm-card">
      <AdminEmptyState
        icon="i-lucide-flask-conical"
        title="Todavía no hay datos de esta prueba"
        description="Aparecerán cuando los clientes hagan búsquedas con la prueba activa."
      />
    </div>
  </div>
</template>
