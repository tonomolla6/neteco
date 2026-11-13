<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AdminTone } from '~/utils/adminLabels'

interface PreauthView {
  id: string
  orderId: string
  merchantOrder: string
  amountCents: number
  reasonCode: string
  justification: string
  requestedBy: string
  status: string
  version: number
  createdAt: string
  updatedAt: string
}

const requestFetch = useRequestFetch()

const searchOrderId = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const successBanner = ref<string | null>(null)
const items = ref<PreauthView[]>([])

// New Preauth Form
const newOrderId = ref('')
const newAmount = ref<number | ''>(0)
const newReasonCode = ref('delayed_fulfillment')
const newJustification = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)

// Action state
const actingId = ref<string | null>(null)

/* --- Presentación --- */
const formId = useId()
const createOpen = ref(false)
const searched = ref(false)
const asking = ref<{ item: PreauthView; action: 'capture' | 'cancel' } | null>(null)
/** El importe se escribe en euros; la API sigue recibiendo céntimos. */
const newAmountEuros = computed<number | ''>({
  get: () => (newAmount.value ? Number(newAmount.value) / 100 : ''),
  set: (value) =>
    (newAmount.value = value === '' || !Number.isFinite(Number(value)) ? '' : Math.round(Number(value) * 100))
})
const reasonLabels: Record<string, string> = {
  delayed_fulfillment: 'Envío aplazado',
  custom_formulation: 'Producto a medida',
  volume_reserve: 'Reserva de volumen'
}
const STATUS: Record<string, [string, AdminTone]> = {
  requested: ['Solicitada', 'warning'],
  authorized: ['Importe retenido', 'info'],
  captured: ['Cobrada', 'success'],
  cancelled: ['Anulada', 'neutral'],
  expired: ['Caducada', 'neutral']
}
const preauthStatus = (status: string) => {
  const [label, tone] = STATUS[status] ?? [adminStatusLabel(status), 'neutral' as AdminTone]
  return { label, tone }
}
const columns = [
  { key: 'merchantOrder', label: 'Referencia' },
  { key: 'amount', label: 'Importe', numeric: true, value: (row: PreauthView) => row.amountCents },
  { key: 'reason', label: 'Motivo', hideOnMobile: true },
  { key: 'status', label: 'Estado' },
  { key: 'createdAt', label: 'Fecha', hideOnMobile: true }
]
const ERRORS: Record<string, string> = {
  not_found: 'No encontramos ese pedido.',
  order_not_found: 'No encontramos ese pedido.',
  validation_error: 'Revisa los datos e inténtalo de nuevo.',
  forbidden: 'No tienes permiso para hacer esto.',
  unauthenticated: 'Tu sesión ha caducado. Vuelve a entrar.',
  version_conflict: 'La preautorización ha cambiado mientras tanto. Vuelve a buscar el pedido.',
  error_servidor: 'Ha fallado la conexión. Vuelve a intentarlo.'
}
/** Los códigos internos de error nunca se enseñan tal cual. */
const friendlyError = (code: string) =>
  ERRORS[code] ?? (/^[a-z0-9_]+$/.test(code) ? 'Vuelve a intentarlo en unos minutos.' : code)
function openCreate() {
  createError.value = null
  if (!newOrderId.value && searchOrderId.value) newOrderId.value = searchOrderId.value.trim()
  createOpen.value = true
}
async function runSearch() {
  await search()
  searched.value = true
}
function confirmAsking() {
  const request = asking.value
  asking.value = null
  if (!request) return
  if (request.action === 'capture') void capturePreauth(request.item)
  else void cancelPreauth(request.item)
}

function errorMessage(caught: unknown): string {
  const code = (caught as { data?: { error?: { code?: string } } })?.data?.error?.code
  if (code) return code
  return caught instanceof Error ? caught.message : 'error_servidor'
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100)
}

function randomUuid(): string {
  return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `cmd-${Date.now()}`
}

async function search(keepBanner = false) {
  if (!searchOrderId.value.trim()) return
  loading.value = true
  error.value = null
  if (!keepBanner) successBanner.value = null
  items.value = []
  try {
    const res = await requestFetch<{ preauthorizations: PreauthView[] }>(
      `/api/admin/payments/preauthorizations?orderId=${encodeURIComponent(searchOrderId.value.trim())}`
    )
    items.value = res.preauthorizations ?? []
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    loading.value = false
  }
}

async function requestNewPreauth() {
  createError.value = null
  successBanner.value = null
  if (!newOrderId.value.trim() || !newAmount.value || Number(newAmount.value) <= 0) {
    createError.value = 'Introduce un pedido válido y un importe mayor a 0.'
    return
  }

  creating.value = true
  try {
    const commandId = randomUuid()
    await requestFetch<PreauthView>('/api/admin/payments/preauthorizations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': commandId
      },
      body: {
        commandId,
        orderId: newOrderId.value.trim(),
        amountCents: Number(newAmount.value),
        reasonCode: newReasonCode.value,
        justification: newJustification.value.trim() || 'Preautorización manual staff'
      }
    })

    successBanner.value = 'Preautorización solicitada.'
    createOpen.value = false
    searched.value = true
    searchOrderId.value = newOrderId.value.trim()
    newAmount.value = 0
    newJustification.value = ''
    await search(true)
  } catch (caught) {
    createError.value = errorMessage(caught)
  } finally {
    creating.value = false
  }
}

async function capturePreauth(item: PreauthView) {
  actingId.value = item.id
  error.value = null
  successBanner.value = null
  try {
    const commandId = randomUuid()
    const updated = await requestFetch<PreauthView>(`/api/admin/payments/preauthorizations/${item.id}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': commandId
      },
      body: {
        commandId,
        amountCents: item.amountCents
      }
    })

    const index = items.value.findIndex((p) => p.id === item.id)
    if (index !== -1) items.value[index] = updated
    successBanner.value = `Preautorización ${item.merchantOrder} cobrada.`
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    actingId.value = null
  }
}

async function cancelPreauth(item: PreauthView) {
  actingId.value = item.id
  error.value = null
  successBanner.value = null
  try {
    const commandId = randomUuid()
    const updated = await requestFetch<PreauthView>(`/api/admin/payments/preauthorizations/${item.id}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': commandId
      },
      body: {
        commandId,
        reason: 'Cancelación solicitada por administración'
      }
    })

    const index = items.value.findIndex((p) => p.id === item.id)
    if (index !== -1) items.value[index] = updated
    successBanner.value = `Preautorización ${item.merchantOrder} anulada.`
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    actingId.value = null
  }
}
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <AdminButton variant="primary" icon="i-lucide-plus" @click="openCreate">Nueva preautorización</AdminButton>
    </AdminPageActions>

    <div v-if="successBanner" data-test="success-banner" role="status" aria-live="polite">
      <UAlert color="success" variant="subtle" icon="i-lucide-circle-check" :title="successBanner" />
    </div>
    <div v-if="error" role="alert">
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="No se ha podido completar la operación"
        :description="friendlyError(error)"
      />
    </div>

    <section aria-labelledby="results-heading">
      <h2 id="results-heading" class="sr-only">Preautorizaciones del pedido</h2>
      <AdminTable
        :data-test="!loading && items.length === 0 ? 'empty-preauth' : undefined"
        :rows="items"
        :columns="columns"
        :row-key="(row) => row.id"
        :status="loading ? 'pending' : 'success'"
        empty-icon="i-lucide-credit-card"
        :empty-title="
          searched ? 'Este pedido no tiene preautorizaciones' : 'Busca un pedido para ver sus preautorizaciones'
        "
        :empty-description="
          searched
            ? 'Puedes retener un importe en la tarjeta del cliente con «Nueva preautorización».'
            : 'Pega el identificador del pedido en el buscador y pulsa «Buscar».'
        "
      >
        <template #toolbar>
          <form class="adm-toolbar" role="search" @submit.prevent="runSearch">
            <label class="adm-toolbar__search" for="search-order-id">
              <span id="search-heading" class="sr-only">Buscar por pedido</span>
              <UIcon name="i-lucide-search" class="size-4" />
              <input
                id="search-order-id"
                v-model="searchOrderId"
                data-test="search-order-id"
                data-slot="adm-search"
                type="search"
                placeholder="Identificador del pedido"
              />
            </label>
            <button
              type="button"
              data-test="search-btn"
              :disabled="loading || !searchOrderId"
              class="adm-btn adm-btn--secondary"
              @click="runSearch"
            >
              {{ loading ? 'Buscando…' : 'Buscar' }}
            </button>
          </form>
        </template>
        <template #cell-merchantOrder="{ row }">
          <span class="font-semibold tabular-nums text-[var(--text-strong)]" :title="row.id">{{
            row.merchantOrder
          }}</span>
        </template>
        <template #cell-amount="{ row }">
          <span class="font-semibold text-[var(--text-strong)]">{{ formatCents(row.amountCents) }}</span>
        </template>
        <template #cell-reason="{ row }">
          <p class="text-[var(--text-strong)]">{{ reasonLabels[row.reasonCode] ?? adminHumanize(row.reasonCode) }}</p>
          <p v-if="row.justification" class="text-xs text-[var(--text-muted)]">{{ row.justification }}</p>
        </template>
        <template #cell-status="{ row }">
          <AdminBadge :tone="preauthStatus(row.status).tone">{{ preauthStatus(row.status).label }}</AdminBadge>
        </template>
        <template #cell-createdAt="{ row }">{{ adminDate(row.createdAt, true) }}</template>
        <template #actions="{ row }">
          <template v-if="row.status === 'authorized' || row.status === 'requested'">
            <button
              type="button"
              data-test="capture-btn"
              :disabled="actingId === row.id"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              @click="asking = { item: row, action: 'capture' }"
            >
              Cobrar
            </button>
            <button
              type="button"
              data-test="cancel-btn"
              :disabled="actingId === row.id"
              class="adm-btn adm-btn--danger-soft adm-btn--sm"
              @click="asking = { item: row, action: 'cancel' }"
            >
              Anular
            </button>
          </template>
        </template>
      </AdminTable>
    </section>

    <AdminDrawer
      v-model:open="createOpen"
      title="Nueva preautorización"
      description="Retiene un importe en la tarjeta del cliente sin cobrarlo todavía."
    >
      <form :id="formId" aria-labelledby="request-heading" class="adm-stack" @submit.prevent="requestNewPreauth">
        <h2 id="request-heading" class="sr-only">Solicitar preautorización</h2>
        <AdminFormField label="Pedido" required for="new-order-id" help="Identificador completo del pedido.">
          <input
            id="new-order-id"
            v-model="newOrderId"
            data-test="new-order-id"
            type="text"
            required
            class="adm-input w-full"
          />
        </AdminFormField>
        <AdminFormField label="Importe (€)" required for="new-amount">
          <input
            id="new-amount"
            v-model.number="newAmountEuros"
            data-test="new-amount"
            type="number"
            min="0.01"
            step="0.01"
            required
            class="adm-input w-full"
          />
        </AdminFormField>
        <AdminFormField label="Motivo" for="new-reason">
          <select id="new-reason" v-model="newReasonCode" data-test="new-reason-code" class="adm-input w-full">
            <option v-for="(label, code) in reasonLabels" :key="code" :value="code">{{ label }}</option>
          </select>
        </AdminFormField>
        <AdminFormField label="Nota interna" for="new-justification" help="Opcional. Solo la ve el equipo.">
          <input
            id="new-justification"
            v-model="newJustification"
            data-test="new-justification"
            type="text"
            class="adm-input w-full"
          />
        </AdminFormField>
        <UAlert
          v-if="createError"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="friendlyError(createError)"
        />
      </form>
      <template #footer>
        <AdminButton @click="createOpen = false">Cancelar</AdminButton>
        <button
          type="button"
          data-test="request-preauth-btn"
          :disabled="creating"
          class="adm-btn adm-btn--primary"
          @click="requestNewPreauth"
        >
          {{ creating ? 'Solicitando…' : 'Solicitar preautorización' }}
        </button>
      </template>
    </AdminDrawer>

    <AdminConfirm
      :open="asking !== null"
      :title="asking?.action === 'cancel' ? '¿Anular esta preautorización?' : '¿Cobrar esta preautorización?'"
      :description="
        asking
          ? asking.action === 'cancel'
            ? `Se liberará la retención de ${formatCents(asking.item.amountCents)} en la tarjeta del cliente. No se puede deshacer.`
            : `Se cobrarán ${formatCents(asking.item.amountCents)} al cliente.`
          : undefined
      "
      :confirm-label="asking?.action === 'cancel' ? 'Anular' : 'Cobrar'"
      :danger="asking?.action === 'cancel'"
      @update:open="(value) => !value && (asking = null)"
      @confirm="confirmAsking"
    />
  </div>
</template>
