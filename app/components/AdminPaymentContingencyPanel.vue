<script setup lang="ts">
import { ref, onMounted } from 'vue'

interface ContingencyRoute {
  id: string
  marketCode: string
  primaryProvider: string
  alternativeProvider: string
  activeProvider: string
  contingencyActive: boolean
  contingencyReason: string | null
  circuitState: string
  version: number
}

interface ReconciliationItem {
  id: string
  intentId: string
  orderId: string
  provider: string
  providerReference: string
  amountCents: number
  currency: string
  status: string
  settledAt: string | null
}

interface ContingencyData {
  routes: ContingencyRoute[]
  reconciliations: ReconciliationItem[]
}

const loading = ref(true)
const error = ref<string | null>(null)
const data = ref<ContingencyData | null>(null)
const toggling = ref(false)

const requestFetch = useRequestFetch()

async function loadData() {
  loading.value = true
  error.value = null
  try {
    const res = await requestFetch('/api/admin/payments/contingency/status')
    data.value = res as ContingencyData
  } catch (err: unknown) {
    const fetchErr = err as { data?: { error?: { code?: string } } }
    error.value = fetchErr?.data?.error?.code ?? 'error_loading_contingency'
  } finally {
    loading.value = false
  }
}

async function handleToggle(route: ContingencyRoute) {
  toggling.value = true
  try {
    const res = await requestFetch('/api/admin/payments/contingency/toggle', {
      method: 'POST',
      body: {
        marketCode: route.marketCode,
        activateContingency: !route.contingencyActive,
        reason: !route.contingencyActive
          ? 'Activación manual de contingencia hacia pasarela alternativa'
          : 'Restauración del proveedor principal',
        expectedVersion: route.version
      }
    })
    const updated = res as ContingencyRoute
    const idx = data.value?.routes.findIndex((r) => r.marketCode === updated.marketCode)
    if (idx !== undefined && idx >= 0 && data.value) {
      data.value.routes[idx] = updated
    }
  } catch (err: unknown) {
    const fetchErr = err as { data?: { error?: { code?: string } } }
    error.value = fetchErr?.data?.error?.code ?? 'error_toggling_contingency'
  } finally {
    toggling.value = false
  }
}

const confirmRoute = ref<ContingencyRoute | null>(null)
function confirmToggle() {
  const route = confirmRoute.value
  confirmRoute.value = null
  if (route) void handleToggle(route)
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <AdminCard
    title="Formas de cobro"
    description="Qué pasarela de pago se usa en cada mercado y cuál es la de reserva si la principal falla"
    flush
  >
    <div v-if="loading" class="adm-help p-5" aria-live="polite">Cargando el estado de las pasarelas…</div>

    <AdminEmptyState
      v-else-if="error"
      role="alert"
      compact
      variant="error"
      title="No se ha podido cargar el estado de las pasarelas"
      description="Vuelve a intentarlo en unos minutos."
    >
      <AdminButton icon="i-lucide-rotate-cw" @click="loadData">Reintentar</AdminButton>
    </AdminEmptyState>

    <template v-else-if="data">
      <AdminEmptyState
        v-if="!data.routes.length"
        compact
        icon="i-lucide-credit-card"
        title="No hay pasarelas configuradas"
      />
      <ul v-else class="divide-y divide-[var(--border)]">
        <li v-for="route in data.routes" :key="route.id" class="px-5 py-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="min-w-0">
              <p class="flex flex-wrap items-center gap-2 font-semibold text-[var(--text-strong)]">
                Mercado {{ route.marketCode }}
                <AdminBadge :tone="route.contingencyActive ? 'warning' : 'success'">
                  {{ route.contingencyActive ? 'Usando la pasarela de reserva' : 'Funcionamiento normal' }}
                </AdminBadge>
              </p>
              <p class="mt-1 text-xs text-[var(--text-muted)]">
                Principal: {{ adminHumanize(route.primaryProvider) }} · Reserva:
                {{ adminHumanize(route.alternativeProvider) }} ·
                <span class="font-semibold text-[var(--text)]">En uso: {{ adminHumanize(route.activeProvider) }}</span>
              </p>
              <p v-if="route.contingencyActive" class="mt-1 text-xs text-[var(--text-muted)]">
                Motivo: {{ route.contingencyReason || 'sin indicar' }}
              </p>
            </div>

            <button
              data-testid="toggle-contingency-btn"
              type="button"
              :disabled="toggling"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              @click="confirmRoute = route"
            >
              {{ route.contingencyActive ? 'Volver a la pasarela principal' : 'Cambiar a la pasarela de reserva' }}
            </button>
          </div>
        </li>
      </ul>

      <div v-if="data.reconciliations.length > 0" class="border-t border-[var(--border)]">
        <p class="adm-label px-5 pt-4">Últimos cobros</p>
        <div class="adm-table-wrap mt-2">
          <table class="adm-table">
            <thead>
              <tr>
                <th scope="col">Pasarela</th>
                <th scope="col">Referencia</th>
                <th scope="col" data-numeric>Importe</th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="rec in data.reconciliations" :key="rec.id">
                <td>{{ adminHumanize(rec.provider) }}</td>
                <td class="tabular-nums">{{ rec.providerReference }}</td>
                <td data-numeric>
                  {{
                    rec.currency === 'EUR'
                      ? adminMoney(rec.amountCents)
                      : `${(rec.amountCents / 100).toFixed(2)} ${rec.currency}`
                  }}
                </td>
                <td><AdminBadge :status="rec.status" /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <AdminConfirm
      :open="confirmRoute !== null"
      :title="
        confirmRoute?.contingencyActive ? '¿Volver a la pasarela principal?' : '¿Cambiar a la pasarela de reserva?'
      "
      :description="
        confirmRoute
          ? `Los nuevos cobros del mercado ${confirmRoute.marketCode} pasarán por ${adminHumanize(
              confirmRoute.contingencyActive ? confirmRoute.primaryProvider : confirmRoute.alternativeProvider
            )}.`
          : undefined
      "
      confirm-label="Cambiar pasarela"
      @update:open="(value) => !value && (confirmRoute = null)"
      @confirm="confirmToggle"
    />
  </AdminCard>
</template>
