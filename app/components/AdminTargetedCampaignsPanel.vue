<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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
  return c ? `${fallback}. Vuelve a intentarlo.` : fallback
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

const TARGET_LABELS: Record<string, string> = { sector: 'Sector', company: 'Empresa', customer: 'Cliente' }
const STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  active: 'Activa',
  paused: 'En pausa',
  completed: 'Finalizada'
}
const percent = (value: number) => `${value.toLocaleString('es-ES', { maximumFractionDigits: 1 })}%`
function offerLabel(camp: TargetedCampaign): string {
  if (camp.discountPercent !== null && camp.discountPercent !== undefined)
    return `${percent(camp.discountPercent)} de descuento`
  if (camp.fixedPriceCents !== null && camp.fixedPriceCents !== undefined)
    return `Precio fijo ${adminMoney(camp.fixedPriceCents)}`
  return camp.tariffType === 'rebate_bonus' ? 'Bonificación por volumen' : 'Tarifa especial'
}

// Estado de interfaz: búsqueda, filtro y paneles laterales.
const search = ref('')
const statusFilter = ref('all')
const statusOptions = computed(() => [
  { value: 'all', label: 'Todas', count: campaigns.value.length },
  { value: 'active', label: 'Activas', count: campaigns.value.filter((camp) => camp.status === 'active').length },
  { value: 'paused', label: 'En pausa', count: campaigns.value.filter((camp) => camp.status === 'paused').length },
  {
    value: 'completed',
    label: 'Finalizadas',
    count: campaigns.value.filter((camp) => camp.status === 'completed').length
  }
])
const rows = computed(() => {
  const term = search.value.toLowerCase()
  return campaigns.value.filter(
    (camp) =>
      (statusFilter.value === 'all' || camp.status === statusFilter.value) &&
      (!term || camp.name.toLowerCase().includes(term) || camp.code.toLowerCase().includes(term))
  )
})
function clearFilters() {
  search.value = ''
  statusFilter.value = 'all'
}
const columns = [
  { key: 'name', label: 'Campaña', sortable: true },
  { key: 'targetId', label: 'Dirigida a' },
  { key: 'discountPercent', label: 'Oferta' },
  { key: 'marginFloorBasisPoints', label: 'Margen mínimo', numeric: true, hideOnMobile: true },
  { key: 'startAt', label: 'Vigencia', sortable: true, hideOnMobile: true },
  { key: 'status', label: 'Estado' }
]
const reportOpen = computed({
  get: () => activeReport.value !== null,
  set: (open: boolean) => {
    if (!open) activeReport.value = null
  }
})
/** El margen mínimo se edita en porcentaje; se guarda en puntos básicos como hasta ahora. */
const marginFloorPercent = computed({
  get: () => marginFloorBasisPoints.value / 100,
  set: (value: number) => (marginFloorBasisPoints.value = Math.round(Number(value) * 100))
})

onMounted(() => {
  loadCampaigns()
})
</script>

<template>
  <div class="admin-targeted-campaigns-panel adm-stack">
    <AdminPageActions>
      <AdminButton variant="primary" icon="i-lucide-plus" data-test="create-campaign-btn" @click="showModal = true">
        Nueva campaña
      </AdminButton>
    </AdminPageActions>

    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
    />

    <AdminTable
      :rows="rows"
      :columns="columns"
      :row-key="(row) => row.id"
      :status="loading ? 'pending' : 'idle'"
      :filtered="Boolean(search) || statusFilter !== 'all'"
      empty-title="Todavía no hay campañas segmentadas"
      empty-description="Crea una campaña con condiciones especiales para un sector, una empresa o un cliente."
      empty-icon="i-lucide-target"
      @clear-filters="clearFilters"
    >
      <template #toolbar>
        <AdminToolbar v-model:search="search" placeholder="Buscar por nombre o código…">
          <AdminFilters v-model="statusFilter" :options="statusOptions" label="Filtrar por estado" />
        </AdminToolbar>
      </template>
      <template #cell-name="{ row }">
        <p class="font-semibold text-[var(--text-strong)]">{{ row.name }}</p>
        <p class="adm-help">{{ row.code }}</p>
      </template>
      <template #cell-targetId="{ row }">
        <p>{{ adminHumanize(row.targetId) }}</p>
        <p class="adm-help">{{ TARGET_LABELS[row.targetType] ?? adminHumanize(row.targetType) }}</p>
      </template>
      <template #cell-discountPercent="{ row }">{{ offerLabel(row) }}</template>
      <template #cell-marginFloorBasisPoints="{ row }">{{ percent(row.marginFloorBasisPoints / 100) }}</template>
      <template #cell-startAt="{ row }">{{ adminDate(row.startAt) }} – {{ adminDate(row.endAt) }}</template>
      <template #cell-status="{ row }">
        <AdminBadge :tone="adminStatusTone(row.status)">
          {{ STATUS_LABELS[row.status] ?? adminHumanize(row.status) }}
        </AdminBadge>
      </template>
      <template #actions="{ row }">
        <AdminButton size="sm" icon="i-lucide-chart-column" :loading="loadingReport" @click="viewReporting(row.id)">
          Ver resultados
        </AdminButton>
      </template>
      <template #empty-action>
        <AdminButton variant="primary" icon="i-lucide-plus" @click="showModal = true">Nueva campaña</AdminButton>
      </template>
    </AdminTable>

    <!-- Resultados de la campaña -->
    <AdminDrawer
      v-model:open="reportOpen"
      wide
      :title="activeReport ? `Resultados de «${activeReport.campaign.name}»` : 'Resultados'"
      :description="
        activeReport
          ? `${adminDate(activeReport.campaign.startAt)} – ${adminDate(activeReport.campaign.endAt)}`
          : undefined
      "
    >
      <div v-if="activeReport" class="grid gap-4 sm:grid-cols-2">
        <AdminStat label="Envíos" :value="activeReport.metrics.totalDispatched" icon="i-lucide-send" />
        <AdminStat
          label="Aperturas"
          :value="activeReport.metrics.totalOpened"
          :hint="`${percent(activeReport.metrics.openRatePercent)} de los envíos`"
          icon="i-lucide-mail-open"
        />
        <AdminStat
          label="Clics"
          :value="activeReport.metrics.totalClicked"
          :hint="`${percent(activeReport.metrics.clickRatePercent)} de los envíos`"
          icon="i-lucide-mouse-pointer-click"
        />
        <AdminStat
          label="Pedidos conseguidos"
          :value="activeReport.metrics.totalConverted"
          :hint="`${percent(activeReport.metrics.conversionRatePercent)} de los envíos`"
          icon="i-lucide-shopping-cart"
        />
        <AdminStat
          class="sm:col-span-2"
          label="Facturación sin impuestos"
          :value="adminMoney(activeReport.metrics.totalRevenueNetCents)"
          icon="i-lucide-euro"
        />
      </div>
      <template #footer>
        <AdminButton @click="reportOpen = false">Cerrar</AdminButton>
      </template>
    </AdminDrawer>

    <!-- Nueva campaña -->
    <AdminDrawer v-model:open="showModal" title="Nueva campaña segmentada">
      <div class="adm-stack">
        <UAlert
          v-if="validationError"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="validationError"
        />
        <AdminFormField v-slot="{ id }" label="Nombre de la campaña" required>
          <input
            :id="id"
            v-model="name"
            data-test="campaign-name"
            type="text"
            placeholder="Descuento peróxidos lavanderías"
          />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Código" help="Identificador corto y único, sin espacios." required>
          <input :id="id" v-model="code" type="text" placeholder="camp-ejemplo-2026" />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Descripción">
          <textarea :id="id" v-model="description" rows="2"></textarea>
        </AdminFormField>
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Dirigida a">
            <select :id="id" v-model="targetType">
              <option value="sector">Un sector</option>
              <option value="company">Una empresa</option>
              <option value="customer">Un cliente</option>
            </select>
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            label="Sector, empresa o cliente"
            help="Referencia del destinatario. No se admite segmentar por sede."
          >
            <input :id="id" v-model="targetId" type="text" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Descuento (%)">
            <input :id="id" v-model.number="discountPercent" type="number" min="1" max="50" />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            label="Margen mínimo (%)"
            help="La campaña nunca venderá por debajo de este margen."
          >
            <input :id="id" v-model.number="marginFloorPercent" type="number" min="5" max="50" step="0.5" />
          </AdminFormField>
        </div>
      </div>
      <template #footer>
        <AdminButton @click="showModal = false">Cancelar</AdminButton>
        <AdminButton variant="primary" @click="handleCreateCampaign">Crear campaña</AdminButton>
      </template>
    </AdminDrawer>
  </div>
</template>
