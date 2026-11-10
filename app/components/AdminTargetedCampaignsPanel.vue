<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  validateStrictNoSedeNoHierarchy,
  type CampaignReportingMetrics,
  type CreateTargetedCampaignInput,
  type TargetedCampaign
} from '~~/shared/targeted-campaigns'

const requestFetch = useRequestFetch()
const loading = ref(true)
const errorMessage = ref('')
const campaigns = ref<TargetedCampaign[]>([])

// Create campaign modal / form
const showModal = ref(false)
const code = ref('')
const name = ref('')
const description = ref('')
const targetType = ref<'customer' | 'company' | 'sector'>('sector')
const targetId = ref('lavanderia_industrial')
const tariffType = ref<'percentage_discount' | 'fixed_price' | 'rate_table' | 'rebate_bonus'>('percentage_discount')
const discountPercent = ref<number>(15)
const minOrderNetCents = ref<number>(10000)
const marginFloorBasisPoints = ref<number>(1500)
const startAt = ref('2026-10-01T00:00:00Z')
const endAt = ref('2026-12-31T23:59:59Z')
const validationError = ref('')

// Reporting view state
const activeReport = ref<{ campaign: TargetedCampaign; metrics: CampaignReportingMetrics } | null>(null)
const loadingReport = ref(false)

function errorText(error: unknown, fallback: string): string {
  const c = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return c ? `${fallback} (${c})` : fallback
}

async function loadCampaigns() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/marketing/targeted-campaigns')) as {
      campaigns: TargetedCampaign[]
    }
    campaigns.value = res?.campaigns ?? []
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al cargar las campañas de marketing')
  } finally {
    loading.value = false
  }
}

async function handleCreateCampaign() {
  validationError.value = ''

  // Validate strict no sede and no hierarchy
  const check = validateStrictNoSedeNoHierarchy({
    code: code.value,
    name: name.value,
    description: description.value,
    targetType: targetType.value,
    targetId: targetId.value
  })

  if (!check.valid) {
    validationError.value = check.reason || 'Segmentación por sede o jerarquía prohibida.'
    return
  }

  try {
    const payload: CreateTargetedCampaignInput = {
      code: code.value.trim(),
      name: name.value.trim(),
      description: description.value.trim(),
      targetType: targetType.value,
      targetId: targetId.value.trim(),
      tariffType: tariffType.value,
      discountPercent: discountPercent.value,
      minOrderNetCents: minOrderNetCents.value,
      marginFloorBasisPoints: marginFloorBasisPoints.value,
      startAt: startAt.value,
      endAt: endAt.value,
      status: 'active'
    }

    await requestFetch('/api/admin/marketing/targeted-campaigns', {
      method: 'POST',
      body: payload
    })

    showModal.value = false
    await loadCampaigns()
  } catch (error) {
    validationError.value = errorText(error, 'Error al crear la campaña')
  }
}

async function viewReporting(campaignId: string) {
  loadingReport.value = true
  try {
    const res = (await requestFetch(`/api/admin/marketing/targeted-campaigns/${campaignId}/reporting`)) as {
      campaign: TargetedCampaign
      metrics: CampaignReportingMetrics
    }
    activeReport.value = res
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al cargar las métricas de la campaña')
  } finally {
    loadingReport.value = false
  }
}

onMounted(() => {
  loadCampaigns()
})
</script>

<template>
  <div class="admin-targeted-campaigns-panel p-6 max-w-6xl mx-auto space-y-6">
    <header class="flex items-center justify-between border-b pb-4">
      <div>
        <h1 class="text-2xl font-bold text-slate-900">Campañas B2B Segmentadas (MKT-035)</h1>
        <p class="text-sm text-slate-600 mt-1">
          Segmentación por cliente, empresa o sector. Estrictamente sin targeting por sede o jerarquía de compradores.
        </p>
      </div>
      <button
        data-test="create-campaign-btn"
        class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium transition"
        @click="showModal = true"
      >
        Nueva campaña
      </button>
    </header>

    <!-- Loading & Error -->
    <div v-if="loading" class="p-8 text-center text-slate-500 animate-pulse">Cargando campañas comerciales...</div>
    <div v-else-if="errorMessage" class="p-4 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
      {{ errorMessage }}
    </div>

    <!-- Campaigns List -->
    <div v-else class="space-y-4">
      <div v-if="campaigns.length === 0" class="p-8 text-center bg-slate-50 border rounded text-slate-500">
        No hay campañas segmentadas configuradas actualmente.
      </div>
      <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div
          v-for="camp in campaigns"
          :key="camp.id"
          class="bg-white border rounded p-4 shadow-sm space-y-3 flex flex-col justify-between"
        >
          <div>
            <div class="flex items-center justify-between">
              <span class="text-xs font-mono font-semibold text-slate-500">{{ camp.code }}</span>
              <span class="text-xs px-2 py-0.5 rounded font-semibold uppercase bg-slate-100 text-slate-700">
                {{ camp.targetType }}: {{ camp.targetId }}
              </span>
            </div>
            <h2 class="text-base font-bold text-slate-900 mt-1">{{ camp.name }}</h2>
            <p class="text-xs text-slate-600 mt-1 line-clamp-2">{{ camp.description }}</p>
            <div class="mt-2 text-xs text-slate-700 space-y-0.5">
              <div>
                Tarifa: <span class="font-medium">{{ camp.discountPercent }}% dto.</span>
              </div>
              <div>
                Suelo de margen: <span class="font-medium">{{ camp.marginFloorBasisPoints / 100 }}%</span>
              </div>
              <div>
                Vigencia:
                <span class="font-medium">{{ camp.startAt.slice(0, 10) }} a {{ camp.endAt.slice(0, 10) }}</span>
              </div>
            </div>
          </div>
          <button
            class="w-full text-xs py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 font-medium rounded transition"
            @click="viewReporting(camp.id)"
          >
            Ver reporting & analítica &rarr;
          </button>
        </div>
      </div>
    </div>

    <!-- Reporting Modal / Drawer -->
    <div v-if="activeReport" class="bg-slate-50 border-2 border-blue-400 p-6 rounded space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-bold text-slate-900">
          Informe de Rendimiento: {{ activeReport.campaign.name }} ({{ activeReport.campaign.code }})
        </h2>
        <button class="text-xs text-slate-500 hover:text-slate-800 underline" @click="activeReport = null">
          Cerrar informe
        </button>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
        <div class="bg-white p-3 rounded border">
          <span class="text-xs text-slate-500 block">Enviados</span>
          <span class="text-xl font-bold text-slate-900">{{ activeReport.metrics.totalDispatched }}</span>
        </div>
        <div class="bg-white p-3 rounded border">
          <span class="text-xs text-slate-500 block">Aperturas (Open Rate)</span>
          <span class="text-xl font-bold text-blue-700">
            {{ activeReport.metrics.totalOpened }} ({{ activeReport.metrics.openRatePercent }}%)
          </span>
        </div>
        <div class="bg-white p-3 rounded border">
          <span class="text-xs text-slate-500 block">Clics (Click Rate)</span>
          <span class="text-xl font-bold text-indigo-700">
            {{ activeReport.metrics.totalClicked }} ({{ activeReport.metrics.clickRatePercent }}%)
          </span>
        </div>
        <div class="bg-white p-3 rounded border">
          <span class="text-xs text-slate-500 block">Conversiones & Facturación</span>
          <span class="text-xl font-bold text-green-700">
            {{ activeReport.metrics.totalConverted }} (€{{
              (activeReport.metrics.totalRevenueNetCents / 100).toFixed(2)
            }})
          </span>
        </div>
      </div>
    </div>

    <!-- Create Campaign Modal -->
    <div v-if="showModal" class="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div class="bg-white rounded-lg max-w-lg w-full p-6 space-y-4 shadow-xl">
        <h2 class="text-lg font-bold text-slate-900">Crear nueva campaña segmentada</h2>
        <div v-if="validationError" class="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-xs">
          {{ validationError }}
        </div>
        <div class="space-y-3 text-sm">
          <div>
            <label class="block text-xs font-medium text-slate-700">Código único</label>
            <input v-model="code" type="text" placeholder="camp-ejemplo-2026" class="w-full border rounded p-2" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-700">Nombre de la campaña</label>
            <input
              v-model="name"
              data-test="campaign-name"
              type="text"
              placeholder="Descuento peróxidos lavanderías"
              class="w-full border rounded p-2"
            />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-700">Descripción</label>
            <textarea v-model="description" rows="2" class="w-full border rounded p-2"></textarea>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-700">Tipo de destinatario</label>
              <select v-model="targetType" class="w-full border rounded p-2">
                <option value="sector">Sector</option>
                <option value="company">Empresa</option>
                <option value="customer">Cliente</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-700">Identificador objetivo</label>
              <input v-model="targetId" type="text" class="w-full border rounded p-2" />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-700">Descuento (%)</label>
              <input
                v-model.number="discountPercent"
                type="number"
                min="1"
                max="50"
                class="w-full border rounded p-2"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-700">Suelo de margen (p.b.)</label>
              <input
                v-model.number="marginFloorBasisPoints"
                type="number"
                min="500"
                max="5000"
                class="w-full border rounded p-2"
              />
            </div>
          </div>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <button class="px-3 py-1.5 text-xs text-slate-600 hover:text-slate-800" @click="showModal = false">
            Cancelar
          </button>
          <button
            class="px-4 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded font-medium"
            @click="handleCreateCampaign"
          >
            Crear campaña
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
