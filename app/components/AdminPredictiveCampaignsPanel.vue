<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  validateStrictNoSedeNoHierarchy,
  type CampaignOptimizationMetrics,
  type CampaignOptimizationRule
} from '~~/shared/predictive-personalization'

const requestFetch = useRequestFetch()
const loading = ref(true)
const errorMessage = ref('')
const successMessage = ref('')

// Metrics state
const metrics = ref<CampaignOptimizationMetrics | null>(null)

// Rules state
const rules = ref<CampaignOptimizationRule[]>([])

// Create rule modal / form
const showModal = ref(false)
const ruleId = ref('')
const campaignId = ref('camp-b2b-turia-vip')
const ruleName = ref('')
const maxDiscount = ref<number>(20)
const frequencyCapDays = ref<number>(7)
const budgetCapEur = ref<number>(2000)
const autoApprovalMaxDiscount = ref<number>(10)
const validationError = ref('')

// Kill switch action loading
const togglingKillSwitch = ref<string | null>(null)

function errorText(error: unknown, fallback: string): string {
  const c = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return c ? `${fallback}. Vuelve a intentarlo.` : fallback
}

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [metricsRes, rulesRes] = await Promise.all([
      requestFetch('/api/admin/marketing/predictive-campaigns/metrics').catch(() => null) as Promise<{
        metrics: CampaignOptimizationMetrics
      } | null>,
      requestFetch('/api/admin/marketing/predictive-campaigns/rules').catch(() => null) as Promise<{
        rules: CampaignOptimizationRule[]
      } | null>
    ])

    if (metricsRes?.metrics) {
      metrics.value = metricsRes.metrics
    }
    if (rulesRes?.rules) {
      rules.value = rulesRes.rules
    }
  } catch (error) {
    errorMessage.value = errorText(error, 'No se han podido cargar los datos de optimización')
  } finally {
    loading.value = false
  }
}

async function handleCreateRule() {
  validationError.value = ''

  const check = validateStrictNoSedeNoHierarchy({
    name: ruleName.value,
    ruleId: ruleId.value,
    campaignId: campaignId.value
  })

  if (!check.valid) {
    validationError.value = check.reason || 'No se admite segmentar por sede ni por jerarquía.'
    return
  }

  if (maxDiscount.value > 50 || maxDiscount.value <= 0) {
    validationError.value = 'El descuento máximo debe estar entre el 1 % y el 50 % para proteger el margen.'
    return
  }

  try {
    await requestFetch('/api/admin/marketing/predictive-campaigns/rules', {
      method: 'POST',
      body: {
        id: ruleId.value || `rule-opt-${Date.now().toString(36)}`,
        campaignId: campaignId.value,
        name: ruleName.value,
        maxDiscountPercent: Number(maxDiscount.value),
        frequencyCapDays: Number(frequencyCapDays.value),
        budgetCapCents: Math.round(Number(budgetCapEur.value) * 100),
        autoApprovalMaxDiscount: Number(autoApprovalMaxDiscount.value)
      }
    })

    showModal.value = false
    successMessage.value = 'Regla creada con sus límites activos.'
    ruleName.value = ''
    ruleId.value = ''
    await loadData()
  } catch (error) {
    validationError.value = errorText(error, 'Error al guardar la regla')
  }
}

async function handleToggleKillSwitch(rule: CampaignOptimizationRule) {
  togglingKillSwitch.value = rule.id
  errorMessage.value = ''
  try {
    const nextState = !rule.killSwitchActive
    await requestFetch('/api/admin/marketing/predictive-campaigns/kill-switch', {
      method: 'POST',
      body: {
        ruleId: rule.id,
        active: nextState,
        reason: nextState
          ? 'Parada de emergencia activada desde el panel de control'
          : 'Reactivación autorizada tras verificar los límites'
      }
    })
    rule.killSwitchActive = nextState
    rule.status = nextState ? 'killed' : 'active'
    successMessage.value = nextState
      ? `Parada de emergencia activada en «${rule.name}». La optimización y los envíos se han detenido.`
      : `La regla «${rule.name}» vuelve a estar en marcha.`
  } catch (error) {
    errorMessage.value = errorText(error, 'No se ha podido cambiar la parada de emergencia')
  } finally {
    togglingKillSwitch.value = null
  }
}

// Estado de interfaz: búsqueda y confirmación de la parada de emergencia.
const search = ref('')
const rows = computed(() => {
  const term = search.value.toLowerCase()
  return term ? rules.value.filter((rule) => rule.name.toLowerCase().includes(term)) : rules.value
})
const columns = [
  { key: 'name', label: 'Regla', sortable: true },
  { key: 'maxDiscountPercent', label: 'Descuento máximo', numeric: true, sortable: true },
  { key: 'autoApprovalMaxDiscount', label: 'Sin revisión hasta', numeric: true, hideOnMobile: true },
  { key: 'frequencyCapDays', label: 'Frecuencia', hideOnMobile: true },
  { key: 'budgetCapCents', label: 'Presupuesto gastado', numeric: true },
  { key: 'killSwitchActive', label: 'Estado' }
]
const signed = (value: string, amount: number) => (amount > 0 ? `+${value}` : value)
const ruleToToggle = ref<CampaignOptimizationRule | null>(null)
const confirmToggle = computed({
  get: () => ruleToToggle.value !== null,
  set: (open: boolean) => {
    if (!open) ruleToToggle.value = null
  }
})
async function confirmToggleRule() {
  const rule = ruleToToggle.value
  ruleToToggle.value = null
  if (rule) await handleToggleKillSwitch(rule)
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="adm-stack" role="region" aria-label="Panel de optimización predictiva y límites">
    <AdminPageActions>
      <AdminButton variant="primary" icon="i-lucide-plus" data-test="create-rule-btn" @click="showModal = true">
        Nueva regla
      </AdminButton>
    </AdminPageActions>

    <UAlert
      v-if="errorMessage"
      data-test="error-alert"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
    />
    <UAlert
      v-if="successMessage"
      data-test="success-alert"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successMessage"
      close
      @update:open="successMessage = ''"
    />

    <div v-if="loading" data-test="loading-state" class="adm-card adm-table-skeleton" aria-busy="true">
      <span class="sr-only">Cargando resultados y reglas…</span>
      <div v-for="row in 4" :key="row"><i /><i /><i /></div>
    </div>

    <template v-else>
      <section aria-labelledby="metrics-heading" class="adm-section">
        <div class="adm-section__head">
          <div class="min-w-0">
            <h2 id="metrics-heading" class="adm-section__title">Resultado frente al grupo de control</h2>
            <p class="adm-help">
              Compara a los clientes que reciben ofertas personalizadas con un grupo que no las recibe.
            </p>
          </div>
        </div>
        <div class="adm-grid">
          <AdminStat
            label="Margen adicional conseguido"
            :value="
              signed(adminMoney(metrics?.incrementalMarginLiftCents ?? 0), metrics?.incrementalMarginLiftCents ?? 0)
            "
            hint="Frente al grupo de control"
            icon="i-lucide-trending-up"
          />
          <AdminStat
            label="Mejora en compras"
            :value="
              signed(
                `${(metrics?.conversionLiftPercent ?? 0).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`,
                metrics?.conversionLiftPercent ?? 0
              )
            "
            hint="Aumento relativo de visitas que acaban en pedido"
            icon="i-lucide-shopping-cart"
          />
          <AdminStat
            label="Visitas con personalización"
            :value="(metrics?.testImpressions ?? 0).toLocaleString('es-ES')"
            :hint="`${metrics?.testConversions ?? 0} pedidos`"
            icon="i-lucide-sparkles"
          />
          <AdminStat
            label="Visitas del grupo de control"
            :value="(metrics?.holdoutImpressions ?? 0).toLocaleString('es-ES')"
            :hint="`${metrics?.holdoutConversions ?? 0} pedidos`"
            icon="i-lucide-users"
          />
        </div>
      </section>

      <section aria-labelledby="rules-heading" class="adm-section">
        <div class="adm-section__head">
          <div class="min-w-0">
            <h2 id="rules-heading" class="adm-section__title">Reglas de optimización y sus límites</h2>
            <p class="adm-help">
              Ninguna regla puede superar el 50 % de descuento ni contactar al mismo cliente más de una vez por semana.
            </p>
          </div>
        </div>

        <div v-if="rules.length === 0" class="adm-card">
          <AdminEmptyState
            data-test="empty-rules"
            icon="i-lucide-sliders-horizontal"
            title="Todavía no hay reglas de optimización"
            description="Crea una regla para ajustar las ofertas de una campaña dentro de unos límites seguros."
          >
            <AdminButton icon="i-lucide-plus" @click="showModal = true">Crear la primera regla</AdminButton>
          </AdminEmptyState>
        </div>

        <AdminTable
          v-else
          :rows="rows"
          :columns="columns"
          :row-key="(row) => row.id"
          :filtered="Boolean(search)"
          @clear-filters="search = ''"
        >
          <template #toolbar>
            <AdminToolbar v-model:search="search" placeholder="Buscar regla…" />
          </template>
          <template #cell-name="{ row }">
            <p class="font-semibold text-[var(--text-strong)]">{{ row.name }}</p>
            <p class="adm-help">Campaña {{ row.campaignId }}</p>
          </template>
          <template #cell-maxDiscountPercent="{ row }">{{ row.maxDiscountPercent }} %</template>
          <template #cell-autoApprovalMaxDiscount="{ row }">{{ row.autoApprovalMaxDiscount }} %</template>
          <template #cell-frequencyCapDays="{ row }">
            1 contacto cada {{ row.frequencyCapDays }} {{ row.frequencyCapDays === 1 ? 'día' : 'días' }}
          </template>
          <template #cell-budgetCapCents="{ row }">
            {{ adminMoney(row.currentSpendCents) }} de {{ adminMoney(row.budgetCapCents) }}
          </template>
          <template #cell-killSwitchActive="{ row }">
            <AdminBadge :tone="row.killSwitchActive ? 'danger' : 'success'">
              {{ row.killSwitchActive ? 'Detenida' : 'En marcha' }}
            </AdminBadge>
          </template>
          <template #actions="{ row }">
            <button
              type="button"
              class="adm-btn adm-btn--sm"
              :class="row.killSwitchActive ? 'adm-btn--secondary' : 'adm-btn--danger-soft'"
              :data-test="'kill-switch-btn-' + row.id"
              :disabled="togglingKillSwitch === row.id"
              @click="ruleToToggle = row"
            >
              {{ row.killSwitchActive ? 'Reanudar' : 'Detener' }}
            </button>
          </template>
        </AdminTable>
      </section>
    </template>

    <AdminDrawer
      v-model:open="showModal"
      title="Nueva regla de optimización"
      description="La regla ajusta las ofertas de una campaña sin salirse de los límites que marques."
    >
      <div data-test="create-rule-modal" class="adm-stack">
        <UAlert
          v-if="validationError"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="validationError"
        />
        <form id="predictive-rule-form" class="adm-stack" @submit.prevent="handleCreateRule">
          <AdminFormField v-slot="{ id }" label="Nombre de la regla" required>
            <input
              :id="id"
              v-model="ruleName"
              data-test="rule-name-input"
              type="text"
              required
              placeholder="Por ejemplo: lavanderías industriales, 4.º trimestre"
            />
          </AdminFormField>
          <div class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Campaña" help="Código de la campaña a la que se aplica." required>
              <input :id="id" v-model="campaignId" type="text" required placeholder="camp-b2b-turia-vip" />
            </AdminFormField>
            <AdminFormField
              v-slot="{ id }"
              label="Referencia de la regla"
              help="Opcional. Si la dejas vacía se genera sola."
            >
              <input :id="id" v-model="ruleId" type="text" placeholder="rule-opt-01" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Descuento máximo (%)" required>
              <input :id="id" v-model.number="maxDiscount" type="number" min="1" max="50" required />
            </AdminFormField>
            <AdminFormField
              v-slot="{ id }"
              label="Sin revisión hasta (%)"
              help="Los descuentos mayores necesitan tu aprobación."
              required
            >
              <input :id="id" v-model.number="autoApprovalMaxDiscount" type="number" min="1" max="50" required />
            </AdminFormField>
            <AdminFormField
              v-slot="{ id }"
              label="Días entre contactos"
              help="Mínimo de días entre dos ofertas al mismo cliente."
              required
            >
              <input :id="id" v-model.number="frequencyCapDays" type="number" min="1" max="90" required />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Presupuesto máximo (€)" required>
              <input :id="id" v-model.number="budgetCapEur" type="number" min="10" required />
            </AdminFormField>
          </div>
        </form>
      </div>
      <template #footer>
        <AdminButton @click="showModal = false">Cancelar</AdminButton>
        <button data-test="save-rule-btn" type="submit" form="predictive-rule-form" class="adm-btn adm-btn--primary">
          Guardar regla
        </button>
      </template>
    </AdminDrawer>

    <AdminConfirm
      v-model:open="confirmToggle"
      :title="ruleToToggle?.killSwitchActive ? 'Reanudar regla' : 'Detener regla'"
      :description="
        ruleToToggle?.killSwitchActive
          ? `«${ruleToToggle?.name ?? ''}» volverá a ajustar ofertas y a enviar comunicaciones.`
          : `«${ruleToToggle?.name ?? ''}» dejará de ajustar ofertas y de enviar comunicaciones de inmediato.`
      "
      :confirm-label="ruleToToggle?.killSwitchActive ? 'Reanudar' : 'Detener ahora'"
      :danger="!ruleToToggle?.killSwitchActive"
      @confirm="confirmToggleRule"
    />
  </div>
</template>
