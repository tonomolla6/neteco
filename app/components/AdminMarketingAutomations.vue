<script setup lang="ts">
import { ref, onMounted } from 'vue'

const requestFetch = useRequestFetch()

interface PolicyData {
  id: string
  version: number
  welcomeSeriesEnabled: boolean
  welcomeDiscountEnabled: boolean
  welcomeDiscountPercent: number
  welcomeDiscountMaxCents: number
  welcomeMinOrderCents: number
  welcomeMarginFloorBasisPoints: number
  winbackEnabled: boolean
  winbackInactivityDays: number
  winbackCooldownDays: number
  winbackDiscountPercent: number
  winbackDiscountMaxCents: number
  winbackMarginFloorBasisPoints: number
  postpurchaseEnabled: boolean
  postpurchaseDelayHours: number
}

interface OverviewData {
  policy: PolicyData
  counts: {
    welcomeDispatches: Record<string, number>
    winbackEvaluations: Record<string, number>
    postpurchaseDispatches: Record<string, number>
  }
}

const loading = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const welcomeStatus = ref('')
const winbackStatus = ref('')
const winbackCode = ref('')
const postpurchaseStatus = ref('')
const postpurchaseDispatches = ref<Array<{ id: string; streamType: string; status: string }>>([])

const policy = ref<PolicyData>({
  id: 'global',
  version: 1,
  welcomeSeriesEnabled: true,
  welcomeDiscountEnabled: true,
  welcomeDiscountPercent: 10,
  welcomeDiscountMaxCents: 1500,
  welcomeMinOrderCents: 5000,
  welcomeMarginFloorBasisPoints: 2000,
  winbackEnabled: true,
  winbackInactivityDays: 90,
  winbackCooldownDays: 90,
  winbackDiscountPercent: 10,
  winbackDiscountMaxCents: 2000,
  winbackMarginFloorBasisPoints: 2000,
  postpurchaseEnabled: true,
  postpurchaseDelayHours: 12
})

const overview = ref<OverviewData | null>(null)

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const ov = await requestFetch<OverviewData>('/api/admin/marketing-automations/overview')
    overview.value = ov
    if (ov?.policy) {
      policy.value = { ...ov.policy }
    }
  } catch (err: unknown) {
    try {
      const pol = await requestFetch('/api/admin/marketing-automations/policy')
      if (pol) policy.value = pol as PolicyData
    } catch {
      errorMessage.value =
        (err instanceof Error ? err.message : '') || 'Error al cargar las políticas de automatización'
    }
  } finally {
    loading.value = false
  }
}

async function savePolicy() {
  saving.value = true
  errorMessage.value = ''
  try {
    const res = await requestFetch<{ appliedVersion?: number }>('/api/admin/marketing-automations/policy', {
      method: 'PUT',
      body: {
        ...policy.value,
        expectedVersion: policy.value.version
      }
    })
    if (res?.appliedVersion) {
      policy.value.version = res.appliedVersion
    }
  } catch (err: unknown) {
    errorMessage.value = (err instanceof Error ? err.message : '') || 'Error al actualizar la política'
  } finally {
    saving.value = false
  }
}

async function triggerWelcomeSimulation() {
  welcomeStatus.value = ''
  try {
    const res = await requestFetch('/api/admin/marketing-automations/welcome/dispatch', {
      method: 'POST',
      body: {
        customerId: '30000000-0000-4000-8000-000000000001',
        step: 'professional_value',
        idempotencyKey: `idem-w-${Date.now()}`
      }
    })
    if (res) {
      welcomeStatus.value = 'Serie de bienvenida entregada'
    }
  } catch (err: unknown) {
    errorMessage.value = (err instanceof Error ? err.message : '') || 'Error al disparar la serie de bienvenida'
  }
}

async function triggerWinbackSimulation() {
  winbackStatus.value = ''
  winbackCode.value = ''
  try {
    const res = await requestFetch<{ discountCode?: string }>('/api/admin/marketing-automations/winback/evaluate', {
      method: 'POST',
      body: {
        customerId: '30000000-0000-4000-8000-000000000001',
        idempotencyKey: `idem-wb-${Date.now()}`
      }
    })
    if (res) {
      winbackStatus.value = 'Evaluación de win-back completada'
      if (res.discountCode) {
        winbackCode.value = res.discountCode
      }
    }
  } catch (err: unknown) {
    errorMessage.value = (err instanceof Error ? err.message : '') || 'Error al evaluar el winback'
  }
}

async function triggerPostpurchaseSimulation() {
  postpurchaseStatus.value = ''
  postpurchaseDispatches.value = []
  try {
    const res = await requestFetch('/api/admin/marketing-automations/postpurchase/dispatch', {
      method: 'POST',
      body: {
        orderId: '50000000-0000-4000-8000-000000000001',
        idempotencyKey: `idem-pp-${Date.now()}`
      }
    })
    if (Array.isArray(res)) {
      postpurchaseStatus.value = 'Flujo postcompra emitido'
      postpurchaseDispatches.value = res
    }
  } catch (err: unknown) {
    errorMessage.value = (err instanceof Error ? err.message : '') || 'Error al disparar el postcompra'
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <main class="space-y-8 p-6" role="region" aria-label="Automatizaciones de Marketing">
    <header class="flex items-center justify-between border-b pb-4">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-slate-900">Automatizaciones de Marketing</h1>
        <p class="text-sm text-slate-600">
          Gobierno integral de series de bienvenida, reactivación comercial win-back y postcompra útil.
        </p>
      </div>
      <button
        type="button"
        class="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-indigo-500 disabled:opacity-50"
        :disabled="saving || loading"
        aria-label="Guardar configuración de políticas"
        @click="savePolicy"
      >
        {{ saving ? 'Guardando...' : 'Guardar políticas' }}
      </button>
    </header>

    <div v-if="errorMessage" role="alert" class="rounded-lg bg-red-50 p-4 text-sm text-red-700">
      {{ errorMessage }}
    </div>

    <!-- MKT-015: Serie de Bienvenida -->
    <section class="rounded-lg border bg-white p-6 shadow-sm" aria-labelledby="heading-mkt-015">
      <div class="flex items-center justify-between">
        <h2 id="heading-mkt-015" class="text-lg font-semibold text-slate-800">MKT-015: Serie de Bienvenida</h2>
        <button
          type="button"
          data-test="trigger-welcome"
          class="rounded border border-indigo-600 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
          aria-label="Probar simulación de bienvenida"
          @click="triggerWelcomeSimulation"
        >
          Simular paso de bienvenida
        </button>
      </div>
      <p class="mt-1 text-sm text-slate-500">
        Secuencia educativa con valor B2B, categorías especializadas, servicio local y descuento gobernado.
      </p>

      <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label for="welcomeDiscountPercent" class="block text-xs font-medium text-slate-700">
            Descuento bienvenida (%)
          </label>
          <input
            id="welcomeDiscountPercent"
            v-model.number="policy.welcomeDiscountPercent"
            name="welcomeDiscountPercent"
            type="number"
            min="1"
            max="30"
            aria-label="Porcentaje de descuento de bienvenida"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label for="welcomeDiscountMaxCents" class="block text-xs font-medium text-slate-700">
            Tope de descuento (céntimos)
          </label>
          <input
            id="welcomeDiscountMaxCents"
            v-model.number="policy.welcomeDiscountMaxCents"
            name="welcomeDiscountMaxCents"
            type="number"
            aria-label="Tope de descuento en céntimos"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label for="welcomeMarginFloorBasisPoints" class="block text-xs font-medium text-slate-700">
            Suelo de margen (puntos básicos)
          </label>
          <input
            id="welcomeMarginFloorBasisPoints"
            v-model.number="policy.welcomeMarginFloorBasisPoints"
            name="welcomeMarginFloorBasisPoints"
            type="number"
            aria-label="Suelo de margen en puntos básicos"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div v-if="welcomeStatus" role="status" class="mt-3 text-sm font-medium text-emerald-600">
        {{ welcomeStatus }}
      </div>
    </section>

    <!-- MKT-018: Win-back por Inactividad -->
    <section class="rounded-lg border bg-white p-6 shadow-sm" aria-labelledby="heading-mkt-018">
      <div class="flex items-center justify-between">
        <h2 id="heading-mkt-018" class="text-lg font-semibold text-slate-800">MKT-018: Win-back por Inactividad</h2>
        <button
          type="button"
          data-test="trigger-winback"
          class="rounded border border-indigo-600 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
          aria-label="Probar evaluación de winback"
          @click="triggerWinbackSimulation"
        >
          Evaluar cliente win-back
        </button>
      </div>
      <p class="mt-1 text-sm text-slate-500">
        Reactivación automática con exclusión de incidencias abiertas, impagos/deuda, bajas comerciales y periodo de
        enfriamiento.
      </p>

      <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label for="winbackInactivityDays" class="block text-xs font-medium text-slate-700">
            Días de inactividad umbral
          </label>
          <input
            id="winbackInactivityDays"
            v-model.number="policy.winbackInactivityDays"
            name="winbackInactivityDays"
            type="number"
            min="14"
            max="365"
            aria-label="Días de inactividad para activar winback"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label for="winbackCooldownDays" class="block text-xs font-medium text-slate-700">
            Enfriamiento / Anti-gaming (días)
          </label>
          <input
            id="winbackCooldownDays"
            v-model.number="policy.winbackCooldownDays"
            name="winbackCooldownDays"
            type="number"
            aria-label="Días de enfriamiento de winback"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label for="winbackDiscountPercent" class="block text-xs font-medium text-slate-700">
            Descuento win-back (%)
          </label>
          <input
            id="winbackDiscountPercent"
            v-model.number="policy.winbackDiscountPercent"
            name="winbackDiscountPercent"
            type="number"
            aria-label="Porcentaje de descuento de winback"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div v-if="winbackStatus" role="status" class="mt-3 text-sm font-medium text-emerald-600">
        {{ winbackStatus }}
        <span v-if="winbackCode" class="ml-2 font-mono font-bold text-slate-900"> Código: {{ winbackCode }} </span>
      </div>
    </section>

    <!-- MKT-019: Postcompra Útil -->
    <section class="rounded-lg border bg-white p-6 shadow-sm" aria-labelledby="heading-mkt-019">
      <div class="flex items-center justify-between">
        <h2 id="heading-mkt-019" class="text-lg font-semibold text-slate-800">MKT-019: Postcompra Útil</h2>
        <button
          type="button"
          data-test="trigger-postpurchase"
          class="rounded border border-indigo-600 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
          aria-label="Probar emisión postcompra"
          @click="triggerPostpurchaseSimulation"
        >
          Emitir flujos postcompra
        </button>
      </div>
      <p class="mt-1 text-sm text-slate-500">
        Separación estricta entre canal transaccional (seguridad, dilución, FDS y EPIs) y canal comercial condicionado a
        consentimiento expreso.
      </p>

      <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label for="postpurchaseDelayHours" class="block text-xs font-medium text-slate-700">
            Demora de emisión (horas)
          </label>
          <input
            id="postpurchaseDelayHours"
            v-model.number="policy.postpurchaseDelayHours"
            name="postpurchaseDelayHours"
            type="number"
            min="0"
            max="168"
            aria-label="Horas de demora postcompra"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div v-if="postpurchaseStatus" role="status" class="mt-3">
        <p class="text-sm font-medium text-emerald-600">{{ postpurchaseStatus }}</p>
        <ul class="mt-2 space-y-1">
          <li v-for="d in postpurchaseDispatches" :key="d.id" class="text-xs font-mono text-slate-700">
            Canal: <span class="font-bold">{{ d.streamType }}</span> (Estado: {{ d.status }})
          </li>
        </ul>
      </div>
    </section>
  </main>
</template>
