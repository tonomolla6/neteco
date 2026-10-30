<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type {
  SendTimeOptimizationPolicy,
  SendTimeOptimizationDecision,
  SendTimeCategory,
  SendTimeChannel
} from '../../shared/send-time-optimization'

const requestFetch = useRequestFetch()
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')
const notice = ref('')

const policy = ref<SendTimeOptimizationPolicy | null>(null)
const decisions = ref<SendTimeOptimizationDecision[]>([])

// Policy editing
const showEditPolicy = ref(false)
const editHoldoutBp = ref(1000)
const editMinHours = ref(24)
const editMaxWeekly = ref(2)
const editStartHour = ref(9)
const editEndHour = ref(18)

// Message evaluation simulator
const evalMessageId = ref('msg-test-' + Math.floor(Math.random() * 10000))
const evalCustomerId = ref('30000000-0000-4000-8000-000000000001')
const evalCategory = ref<SendTimeCategory>('operational')
const evalChannel = ref<SendTimeChannel>('email')
const evalCampaign = ref('boletin_quimica_marzo')
const latestDecision = ref<SendTimeOptimizationDecision | null>(null)

function errorText(error: unknown, fallback: string): string {
  const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return code ? `${fallback} (${code})` : fallback
}

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [policyRes, decisionsRes] = await Promise.all([
      requestFetch('/api/admin/marketing/send-time/policy') as Promise<{ policy: SendTimeOptimizationPolicy }>,
      requestFetch('/api/admin/marketing/send-time/decisions') as Promise<{
        items: SendTimeOptimizationDecision[]
        total: number
      }>
    ])
    policy.value = policyRes?.policy ?? null
    if (policy.value) {
      editHoldoutBp.value = policy.value.holdoutRateBasisPoints
      editMinHours.value = policy.value.minHoursBetweenMarketing
      editMaxWeekly.value = policy.value.maxWeeklyMarketingSends
      editStartHour.value = policy.value.allowedWindowStartHour
      editEndHour.value = policy.value.allowedWindowEndHour
    }
    decisions.value = decisionsRes?.items ?? []
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al cargar la política de optimización de envíos')
  } finally {
    loading.value = false
  }
}

async function updatePolicy() {
  if (!policy.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/marketing/send-time/policy', {
      method: 'PUT',
      body: {
        commandId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        expectedVersion: policy.value.version,
        holdoutRateBasisPoints: Number(editHoldoutBp.value),
        minHoursBetweenMarketing: Number(editMinHours.value),
        maxWeeklyMarketingSends: Number(editMaxWeekly.value),
        allowedWindowStartHour: Number(editStartHour.value),
        allowedWindowEndHour: Number(editEndHour.value)
      }
    })) as { policy: SendTimeOptimizationPolicy }
    policy.value = res.policy
    notice.value = 'Política de envíos actualizada con éxito.'
    showEditPolicy.value = false
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al actualizar la política (conflicto CAS o parámetros inválidos)')
  } finally {
    busy.value = false
  }
}

async function evaluateMessage() {
  busy.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/marketing/send-time/evaluate', {
      method: 'POST',
      body: {
        commandId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        messageId: evalMessageId.value,
        customerId: evalCustomerId.value,
        category: evalCategory.value,
        channel: evalChannel.value,
        campaignCode: evalCategory.value === 'marketing' ? evalCampaign.value : undefined
      }
    })) as { decision: SendTimeOptimizationDecision }
    latestDecision.value = res.decision
    notice.value = 'Mensaje evaluado correctamente.'
    evalMessageId.value = 'msg-test-' + Math.floor(Math.random() * 10000)
    await loadData()
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al evaluar el mensaje')
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h2 class="text-lg font-bold text-neutral-900">Optimización de Send-Time (COM-020)</h2>
        <p class="text-sm text-neutral-600">
          Envíos comerciales sólo con consentimiento verificado, grupo de control (holdout), límites de frecuencia y
          entrega inmediata sin demoras para comunicaciones operativas.
        </p>
      </div>
      <button
        v-if="policy"
        class="inline-flex items-center rounded-md bg-neutral-900 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-neutral-800"
        @click="showEditPolicy = true"
      >
        Editar Política (v{{ policy.version }})
      </button>
    </div>

    <!-- Notices -->
    <div v-if="notice" class="rounded-md bg-emerald-50 p-4 text-sm text-emerald-800 border border-emerald-200">
      {{ notice }}
    </div>
    <div
      v-if="errorMessage"
      data-error
      class="rounded-md bg-rose-50 p-4 text-sm text-rose-800 border border-rose-200 flex items-center justify-between"
    >
      <span>{{ errorMessage }}</span>
      <button class="underline font-semibold" @click="loadData">Reintentar</button>
    </div>

    <!-- Loading State -->
    <div v-if="loading" data-loading class="py-12 text-center text-sm text-neutral-500">
      Cargando configuración de send-time...
    </div>

    <div v-else-if="policy" class="grid grid-cols-1 md:grid-cols-4 gap-4">
      <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <span class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Grupo Holdout</span>
        <div class="mt-1 text-2xl font-bold text-neutral-900">
          {{ (policy.holdoutRateBasisPoints / 100).toFixed(0) }}%
        </div>
        <p class="text-xs text-neutral-500 mt-1">{{ policy.holdoutRateBasisPoints }} puntos básicos</p>
      </div>

      <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <span class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Ventana Comercial</span>
        <div class="mt-1 text-2xl font-bold text-neutral-900">
          {{ String(policy.allowedWindowStartHour).padStart(2, '0') }}:00 -
          {{ String(policy.allowedWindowEndHour).padStart(2, '0') }}:00
        </div>
        <p class="text-xs text-neutral-500 mt-1">Horas hábiles UTC (Lunes-Viernes)</p>
      </div>

      <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <span class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Protección Fatiga</span>
        <div class="mt-1 text-2xl font-bold text-neutral-900">{{ policy.minHoursBetweenMarketing }}h mín.</div>
        <p class="text-xs text-neutral-500 mt-1">Intervalo mínimo entre envíos</p>
      </div>

      <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <span class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Límite Semanal</span>
        <div class="mt-1 text-2xl font-bold text-neutral-900">{{ policy.maxWeeklyMarketingSends }} envíos</div>
        <p class="text-xs text-neutral-500 mt-1">Máximo por cliente/semana</p>
      </div>
    </div>

    <!-- Simulator Section -->
    <div class="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm space-y-4">
      <h3 class="text-base font-bold text-neutral-900">Simulador de Evaluación de Envíos</h3>
      <p class="text-xs text-neutral-500">
        Evalúa el tratamiento de un mensaje según su categoría: si es operativo se despacha inmediatamente (cero
        demora); si es marketing se exige consentimiento activo, verificación de grupo holdout y ajuste a ventana
        óptima.
      </p>

      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <div>
          <label class="block font-medium text-neutral-700">Categoría</label>
          <select v-model="evalCategory" class="w-full rounded border-neutral-300 p-2 text-sm border">
            <option value="operational">Operativo (Entrega Inmediata)</option>
            <option value="marketing">Marketing / Comercial</option>
          </select>
        </div>

        <div>
          <label class="block font-medium text-neutral-700">Canal</label>
          <select v-model="evalChannel" class="w-full rounded border-neutral-300 p-2 text-sm border">
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="push">Notificación Push</option>
          </select>
        </div>

        <div>
          <label class="block font-medium text-neutral-700">ID Cliente (UUID)</label>
          <input
            v-model="evalCustomerId"
            type="text"
            class="w-full rounded border-neutral-300 p-2 text-sm border"
            placeholder="UUID del cliente"
          />
        </div>

        <div v-if="evalCategory === 'marketing'">
          <label class="block font-medium text-neutral-700">Campaña</label>
          <input
            v-model="evalCampaign"
            type="text"
            class="w-full rounded border-neutral-300 p-2 text-sm border"
            placeholder="Código de campaña"
          />
        </div>
      </div>

      <div class="flex justify-end">
        <button
          data-btn-evaluate
          class="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:opacity-50"
          :disabled="busy"
          @click="evaluateMessage"
        >
          Evaluar Envío
        </button>
      </div>

      <!-- Simulator Result -->
      <div v-if="latestDecision" class="mt-4 rounded-lg bg-neutral-50 p-4 border border-neutral-200 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-neutral-500 uppercase tracking-wider"
            >Resultado de la Evaluación:</span
          >
          <span
            class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
            :class="{
              'bg-emerald-100 text-emerald-800': latestDecision.status === 'sent_immediate',
              'bg-blue-100 text-blue-800': latestDecision.status === 'scheduled_optimized',
              'bg-purple-100 text-purple-800': latestDecision.status === 'held_out',
              'bg-rose-100 text-rose-800': latestDecision.status.startsWith('suppressed_')
            }"
          >
            {{ latestDecision.status }}
          </span>
        </div>
        <p class="text-sm font-medium text-neutral-800">
          Programado para: <span class="font-bold">{{ latestDecision.scheduledFor }}</span>
        </p>
        <p class="text-xs text-neutral-600">
          Motivo: {{ latestDecision.reason }} · Consentimiento: {{ latestDecision.consentVerified ? 'Sí' : 'No' }} ·
          Holdout aplicado: {{ latestDecision.holdoutApplied ? 'Sí' : 'No' }}
        </p>
      </div>
    </div>

    <!-- Decisions History -->
    <div class="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm space-y-4">
      <h3 class="text-base font-bold text-neutral-900">Registro de Decisiones Recientes</h3>
      <div v-if="decisions.length === 0" data-empty-decisions class="py-6 text-center text-sm text-neutral-500">
        No hay decisiones de envío registradas.
      </div>
      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-neutral-200 text-sm">
          <thead>
            <tr class="text-left text-xs font-semibold text-neutral-500 uppercase">
              <th class="py-2">Mensaje / Campaña</th>
              <th class="py-2">Categoría</th>
              <th class="py-2">Canal</th>
              <th class="py-2">Estado</th>
              <th class="py-2">Programado Para</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            <tr v-for="d in decisions" :key="d.id">
              <td class="py-2 font-mono text-xs">
                {{ d.messageId }} <span v-if="d.campaignCode" class="text-neutral-500">({{ d.campaignCode }})</span>
              </td>
              <td class="py-2">{{ d.category }}</td>
              <td class="py-2 uppercase text-xs">{{ d.channel }}</td>
              <td class="py-2 font-medium">{{ d.status }}</td>
              <td class="py-2 font-mono text-xs">{{ d.scheduledFor }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Edit Policy Modal -->
    <div v-if="showEditPolicy" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-md rounded-xl bg-white p-6 shadow-xl space-y-4">
        <h3 class="text-lg font-bold text-neutral-900">Editar Política de Send-Time</h3>
        <p class="text-xs text-neutral-500">
          Actualización atómica gobernada por CAS (versión esperada: {{ policy?.version }}).
        </p>

        <div class="space-y-3 text-sm">
          <div>
            <label class="block font-medium text-neutral-700">Tasa de Holdout (puntos básicos, 1000 = 10%)</label>
            <input
              v-model.number="editHoldoutBp"
              type="number"
              min="0"
              max="5000"
              class="w-full rounded border-neutral-300 p-2 text-sm border"
            />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-medium text-neutral-700">Hora Inicio (UTC)</label>
              <input
                v-model.number="editStartHour"
                type="number"
                min="0"
                max="23"
                class="w-full rounded border-neutral-300 p-2 text-sm border"
              />
            </div>
            <div>
              <label class="block font-medium text-neutral-700">Hora Fin (UTC)</label>
              <input
                v-model.number="editEndHour"
                type="number"
                min="1"
                max="24"
                class="w-full rounded border-neutral-300 p-2 text-sm border"
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-medium text-neutral-700">Horas Mínimas Fatiga</label>
              <input
                v-model.number="editMinHours"
                type="number"
                min="1"
                max="168"
                class="w-full rounded border-neutral-300 p-2 text-sm border"
              />
            </div>
            <div>
              <label class="block font-medium text-neutral-700">Máx. Envíos/Semana</label>
              <input
                v-model.number="editMaxWeekly"
                type="number"
                min="1"
                max="14"
                class="w-full rounded border-neutral-300 p-2 text-sm border"
              />
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <button
            class="rounded px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100"
            @click="showEditPolicy = false"
          >
            Cancelar
          </button>
          <button
            class="rounded bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
            :disabled="busy"
            @click="updatePolicy"
          >
            Guardar Política
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
