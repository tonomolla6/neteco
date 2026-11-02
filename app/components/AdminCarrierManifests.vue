<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ManifestSummary, ManifestView } from '../../shared/carrier-manifests'
import { newCommandId } from '../composables/useDeliveryDriverApp'
import { opsErrorMessage } from '../utils/shipping-ops-errors'

const requestFetch = useRequestFetch()
const BASE = '/api/admin/carrier-manifests'

const loading = ref(true)
const busy = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const manifests = ref<ManifestSummary[]>([])
const current = ref<ManifestView | null>(null)
const carrier = ref('')
const pickupDate = ref(new Date().toISOString().slice(0, 10))
const scans = ref('')

const statusLabel: Record<string, string> = {
  open: 'Abierto',
  closed: 'Cerrado',
  picked_up: 'Recogido',
  discrepancy: 'Con discrepancias',
  cancelled: 'Cancelado'
}
const reasonLabel: Record<string, string> = {
  already_manifested: 'Ya manifestada',
  order_exception: 'Pedido en excepción',
  already_delivered: 'Ya entregada',
  manual_hold: 'Retenida manualmente'
}
const canSchedule = computed(() => current.value?.status === 'closed' && !current.value.pickup)
const canConfirm = computed(() => current.value?.status === 'closed' && current.value.pickup?.status === 'scheduled')

async function loadList() {
  loading.value = true
  error.value = null
  try {
    manifests.value = (
      (await requestFetch<{ manifests: ManifestSummary[] }>(BASE)) as { manifests: ManifestSummary[] }
    ).manifests
  } catch (caught) {
    error.value = opsErrorMessage(caught)
  } finally {
    loading.value = false
  }
}
async function open(id: string) {
  error.value = null
  try {
    current.value = (
      (await requestFetch<{ manifest: ManifestView }>(`${BASE}/${id}`)) as { manifest: ManifestView }
    ).manifest
  } catch (caught) {
    error.value = opsErrorMessage(caught)
  }
}
async function act(
  path: string,
  body: Record<string, unknown>,
  done: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST'
) {
  busy.value = true
  error.value = null
  notice.value = null
  try {
    const res = (await requestFetch<{ manifest: ManifestView }>(path, { method, body })) as { manifest: ManifestView }
    current.value = res.manifest
    notice.value = done
    await loadList()
  } catch (caught) {
    error.value = opsErrorMessage(caught)
  } finally {
    busy.value = false
  }
}
const create = () =>
  act(
    BASE,
    { commandId: newCommandId(), carrier: carrier.value.trim(), pickupDate: pickupDate.value },
    'Manifiesto creado.'
  )
const base = () => ({ commandId: newCommandId(), expectedVersion: current.value!.version })
const setItem = (trackingNumber: string, decision: 'included' | 'excluded') =>
  act(
    `${BASE}/${current.value!.id}/items`,
    { ...base(), trackingNumber, decision },
    decision === 'excluded' ? 'Expedición retenida.' : 'Expedición reincorporada.'
  )
const close = () => act(`${BASE}/${current.value!.id}/close`, base(), 'Manifiesto cerrado y archivado.')
const schedule = () => act(`${BASE}/${current.value!.id}/pickup`, base(), 'Recogida solicitada.')
const cancel = () => act(`${BASE}/${current.value!.id}/cancel`, base(), 'Manifiesto cancelado.')
const confirm = () =>
  act(
    `${BASE}/${current.value!.id}/pickup/confirm`,
    {
      ...base(),
      scannedTrackingNumbers: scans.value
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
    },
    'Recogida conciliada.'
  )

onMounted(() => void loadList())
</script>

<template>
  <div class="space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
    <h2 class="text-lg font-semibold text-slate-900">Manifiestos, cierres y recogidas de transportista</h2>

    <form class="flex flex-wrap items-end gap-3" @submit.prevent="create">
      <label class="text-sm font-medium text-slate-700">
        Transportista
        <input
          v-model="carrier"
          data-test="carrier"
          required
          maxlength="100"
          class="mt-1 block rounded-md border border-slate-300 px-2 py-1.5"
        />
      </label>
      <label class="text-sm font-medium text-slate-700">
        Fecha de recogida
        <input
          v-model="pickupDate"
          data-test="pickup-date"
          type="date"
          required
          class="mt-1 block rounded-md border border-slate-300 px-2 py-1.5"
        />
      </label>
      <button
        type="submit"
        data-test="create"
        :disabled="busy"
        class="rounded-lg bg-neteco-600 px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        Crear manifiesto
      </button>
    </form>

    <p
      v-if="notice"
      role="status"
      class="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
    >
      {{ notice }}
    </p>
    <p v-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      {{ error }}
    </p>

    <div v-if="loading" role="status" aria-live="polite" class="text-sm text-slate-500">Cargando manifiestos...</div>
    <p v-else-if="manifests.length === 0" class="text-sm text-slate-500">Todavía no hay manifiestos.</p>
    <table v-else class="w-full text-left text-sm">
      <caption class="sr-only">
        Manifiestos
      </caption>
      <thead>
        <tr class="border-b text-xs uppercase text-slate-500">
          <th scope="col" class="py-2">Transportista</th>
          <th scope="col">Fecha</th>
          <th scope="col">Estado</th>
          <th scope="col">Incluidas</th>
          <th scope="col">Excluidas</th>
          <th scope="col"><span class="sr-only">Abrir</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in manifests" :key="m.id" class="border-b">
          <td class="py-2">{{ m.carrier }}</td>
          <td>{{ m.pickupDate }}</td>
          <td>{{ statusLabel[m.status] }}</td>
          <td>{{ m.includedShipments }}</td>
          <td>{{ m.excludedShipments }}</td>
          <td><button type="button" :data-test="`open-${m.id}`" class="underline" @click="open(m.id)">Ver</button></td>
        </tr>
      </tbody>
    </table>

    <section
      v-if="current"
      data-test="detail"
      class="space-y-4 border-t pt-4"
      :aria-label="`Manifiesto ${current.carrier} ${current.pickupDate}`"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-semibold">
          {{ current.carrier }} · {{ current.pickupDate }} · {{ statusLabel[current.status] }}
        </h3>
        <div class="flex flex-wrap gap-2">
          <button
            v-if="current.status === 'open'"
            type="button"
            data-test="close"
            :disabled="busy"
            class="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            @click="close"
          >
            Cerrar manifiesto
          </button>
          <button
            v-if="canSchedule"
            type="button"
            data-test="schedule"
            :disabled="busy"
            class="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            @click="schedule"
          >
            Solicitar recogida
          </button>
          <button
            v-if="(current.status === 'open' || current.status === 'closed') && !current.pickup"
            type="button"
            data-test="cancel"
            :disabled="busy"
            class="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-800 disabled:opacity-50"
            @click="cancel"
          >
            Cancelar
          </button>
        </div>
      </div>

      <p
        data-test="reconciliation"
        class="text-sm text-slate-700"
        :class="current.reconciliation.balanced ? '' : 'font-semibold text-red-700'"
      >
        {{ current.reconciliation.candidates }} expediciones: {{ current.reconciliation.included }} incluidas ·
        {{ current.reconciliation.excluded }} excluidas
        <span v-for="(n, reason) in current.reconciliation.excludedByReason" :key="reason">
          · {{ reasonLabel[reason] }}: {{ n }}</span
        >
        <span v-if="!current.reconciliation.balanced"> · ¡Descuadre detectado!</span>
      </p>

      <table class="w-full text-left text-sm">
        <caption class="sr-only">
          Expediciones del manifiesto
        </caption>
        <thead>
          <tr class="border-b text-xs uppercase text-slate-500">
            <th scope="col" class="py-2">Seguimiento</th>
            <th scope="col">Pedido</th>
            <th scope="col">Peso (g)</th>
            <th scope="col">Decisión</th>
            <th scope="col">Escaneo</th>
            <th scope="col"><span class="sr-only">Acción</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in current.items" :key="item.trackingNumber" class="border-b">
            <td class="py-2">{{ item.trackingNumber }}</td>
            <td>{{ item.orderId }}</td>
            <td>{{ item.weightGrams }}</td>
            <td>
              {{
                item.decision === 'included'
                  ? 'Incluida'
                  : `Excluida (${reasonLabel[item.exclusionReason ?? ''] ?? item.exclusionReason})`
              }}
            </td>
            <td>{{ item.scanStatus === 'scanned' ? 'Escaneada' : item.scanStatus === 'missing' ? 'Falta' : '—' }}</td>
            <td>
              <button
                v-if="current.status === 'open' && item.decision === 'included'"
                type="button"
                :data-test="`hold-${item.trackingNumber}`"
                class="underline"
                :disabled="busy"
                @click="setItem(item.trackingNumber, 'excluded')"
              >
                Retener
              </button>
              <button
                v-else-if="current.status === 'open' && item.exclusionReason === 'manual_hold'"
                type="button"
                :data-test="`release-${item.trackingNumber}`"
                class="underline"
                :disabled="busy"
                @click="setItem(item.trackingNumber, 'included')"
              >
                Reincorporar
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="current.documents.length" class="text-sm">
        <h4 class="font-medium">Documentos archivados</h4>
        <ul>
          <li v-for="doc in current.documents" :key="doc.kind">
            <a
              :data-test="`doc-${doc.kind}`"
              :href="`${BASE}/${current.id}/documents/${doc.kind}`"
              download
              class="underline"
              >{{ doc.kind === 'manifest_csv' ? 'Manifiesto (CSV)' : 'Acta de recogida' }}</a
            >
            <span class="text-xs text-slate-500"> · sha256 {{ doc.sha256.slice(0, 12) }}…</span>
          </li>
        </ul>
      </div>

      <div v-if="current.pickup" class="text-sm" data-test="pickup">
        Recogida {{ current.pickup.providerPickupId }} · {{ current.pickup.status }}
        <span v-if="current.pickup.scannedCount !== null">
          · escaneados {{ current.pickup.scannedCount }}, faltan {{ current.pickup.missingCount }}, inesperados
          {{ current.pickup.unexpectedTrackings.length }}</span
        >
      </div>

      <form v-if="canConfirm" class="space-y-2" @submit.prevent="confirm">
        <label class="block text-sm font-medium text-slate-700">
          Seguimientos escaneados por el transportista (uno por línea)
          <textarea
            v-model="scans"
            data-test="scans"
            rows="4"
            class="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5"
          />
        </label>
        <button
          type="submit"
          data-test="confirm"
          :disabled="busy"
          class="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          Conciliar recogida
        </button>
      </form>
    </section>
  </div>
</template>
