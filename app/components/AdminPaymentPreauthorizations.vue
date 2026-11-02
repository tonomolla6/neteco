<script setup lang="ts">
import { ref } from 'vue'

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

    successBanner.value = 'Preautorización solicitada con éxito.'
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
    successBanner.value = `Preautorización ${item.merchantOrder} capturada.`
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
    successBanner.value = `Preautorización ${item.merchantOrder} cancelada.`
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    actingId.value = null
  }
}
</script>

<template>
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-bold text-slate-900">Preautorizaciones de pago</h1>
      <p class="text-sm text-slate-600">
        Gestión bancaria Redsys para retención de fondos con captura o anulación posterior (PAY-021).
      </p>
    </header>

    <div
      v-if="successBanner"
      data-test="success-banner"
      role="status"
      aria-live="polite"
      class="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"
    >
      {{ successBanner }}
    </div>

    <div v-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      Error: {{ error }}
    </div>

    <!-- Search / Filter -->
    <div class="grid gap-6 md:grid-cols-2">
      <!-- Search By Order ID -->
      <section aria-labelledby="search-heading" class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <h2 id="search-heading" class="text-base font-semibold text-slate-900">Buscar por Pedido</h2>
        <div class="mt-4 flex gap-2">
          <input
            v-model="searchOrderId"
            data-test="search-order-id"
            type="text"
            placeholder="UUID del pedido..."
            class="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            data-test="search-btn"
            :disabled="loading || !searchOrderId"
            class="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            @click="search"
          >
            {{ loading ? 'Buscando...' : 'Buscar' }}
          </button>
        </div>
      </section>

      <!-- New Preauthorization Form -->
      <section aria-labelledby="request-heading" class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <h2 id="request-heading" class="text-base font-semibold text-slate-900">Solicitar preautorización</h2>
        <form class="mt-4 space-y-3" @submit.prevent="requestNewPreauth">
          <div>
            <label for="new-order-id" class="block text-xs font-medium text-slate-700">UUID del Pedido</label>
            <input
              id="new-order-id"
              v-model="newOrderId"
              data-test="new-order-id"
              type="text"
              required
              class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="new-amount" class="block text-xs font-medium text-slate-700">Importe (céntimos)</label>
              <input
                id="new-amount"
                v-model.number="newAmount"
                data-test="new-amount"
                type="number"
                min="1"
                required
                class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label for="new-reason" class="block text-xs font-medium text-slate-700">Motivo</label>
              <select
                id="new-reason"
                v-model="newReasonCode"
                data-test="new-reason-code"
                class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              >
                <option value="delayed_fulfillment">Expedición diferida</option>
                <option value="custom_formulation">Formulación química a medida</option>
                <option value="volume_reserve">Reserva de volumen</option>
              </select>
            </div>
          </div>

          <div>
            <label for="new-justification" class="block text-xs font-medium text-slate-700">Justificación</label>
            <input
              id="new-justification"
              v-model="newJustification"
              data-test="new-justification"
              type="text"
              class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              placeholder="Explicación interna..."
            />
          </div>

          <p v-if="createError" role="alert" class="text-xs text-red-600">{{ createError }}</p>

          <button
            type="button"
            data-test="request-preauth-btn"
            :disabled="creating"
            class="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            @click="requestNewPreauth"
          >
            {{ creating ? 'Solicitando...' : 'Solicitar preautorización' }}
          </button>
        </form>
      </section>
    </div>

    <!-- Preauthorizations List -->
    <section aria-labelledby="results-heading" class="space-y-4">
      <h2 id="results-heading" class="text-lg font-semibold text-slate-900">Resultados de preautorizaciones</h2>

      <div
        v-if="!loading && items.length === 0"
        data-test="empty-preauth"
        class="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500"
      >
        No hay preautorizaciones cargadas. Busca un pedido o solicita una nueva.
      </div>

      <div v-else-if="items.length > 0" class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table class="min-w-full divide-y divide-slate-200 text-left text-xs">
          <thead class="bg-slate-50 font-medium text-slate-600">
            <tr>
              <th scope="col" class="px-4 py-2.5">ID / Ref</th>
              <th scope="col" class="px-4 py-2.5">Importe</th>
              <th scope="col" class="px-4 py-2.5">Motivo</th>
              <th scope="col" class="px-4 py-2.5">Estado</th>
              <th scope="col" class="px-4 py-2.5 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="item in items" :key="item.id" class="hover:bg-slate-50">
              <td class="px-4 py-2 font-mono">
                <span class="font-bold text-slate-900">{{ item.merchantOrder }}</span>
                <span class="block text-[11px] text-slate-400">{{ item.id }}</span>
              </td>
              <td class="whitespace-nowrap px-4 py-2 font-semibold text-slate-900">
                {{ formatCents(item.amountCents) }}
              </td>
              <td class="px-4 py-2 text-slate-600">
                <span class="font-medium text-slate-800">{{ item.reasonCode }}</span>
                <span class="block text-[11px] text-slate-500">{{ item.justification }}</span>
              </td>
              <td class="whitespace-nowrap px-4 py-2">
                <span
                  class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  :class="{
                    'bg-amber-50 text-amber-700': item.status === 'requested' || item.status === 'authorized',
                    'bg-emerald-50 text-emerald-700': item.status === 'captured',
                    'bg-slate-100 text-slate-600': item.status === 'cancelled' || item.status === 'expired'
                  }"
                >
                  {{ item.status }}
                </span>
              </td>
              <td class="whitespace-nowrap px-4 py-2 text-right space-x-2">
                <button
                  v-if="item.status === 'authorized' || item.status === 'requested'"
                  type="button"
                  data-test="capture-btn"
                  :disabled="actingId === item.id"
                  class="rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  @click="capturePreauth(item)"
                >
                  Capturar
                </button>
                <button
                  v-if="item.status === 'authorized' || item.status === 'requested'"
                  type="button"
                  data-test="cancel-btn"
                  :disabled="actingId === item.id"
                  class="rounded border border-red-300 px-2.5 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                  @click="cancelPreauth(item)"
                >
                  Anular
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
