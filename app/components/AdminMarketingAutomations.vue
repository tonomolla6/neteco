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

const STREAM_LABELS: Record<string, string> = {
  transactional_safety_usage: 'Seguridad y uso del producto (informativo)',
  commercial_replenishment: 'Reposición (comercial)'
}
const streamLabel = (code: string) => STREAM_LABELS[code] ?? adminHumanize(code)
const countTotal = (counts?: Record<string, number>) =>
  counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : null
</script>

<template>
  <div class="adm-stack" role="region" aria-label="Automatizaciones de marketing">
    <AdminPageActions>
      <button
        type="button"
        class="adm-btn adm-btn--primary"
        :disabled="saving || loading"
        aria-label="Guardar configuración de políticas"
        @click="savePolicy"
      >
        {{ saving ? 'Guardando…' : 'Guardar cambios' }}
      </button>
    </AdminPageActions>

    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
    />

    <div v-if="overview" class="adm-grid">
      <AdminStat
        label="Correos de bienvenida"
        :value="countTotal(overview.counts.welcomeDispatches)"
        icon="i-lucide-hand"
      />
      <AdminStat
        label="Clientes inactivos evaluados"
        :value="countTotal(overview.counts.winbackEvaluations)"
        icon="i-lucide-user-round-search"
      />
      <AdminStat
        label="Mensajes tras la compra"
        :value="countTotal(overview.counts.postpurchaseDispatches)"
        icon="i-lucide-package-check"
      />
    </div>

    <AdminCard
      description="Correos para nuevos clientes: qué ofrecemos a profesionales, categorías, servicio local y un descuento con límites."
      aria-labelledby="heading-mkt-015"
    >
      <template #title><span id="heading-mkt-015">Serie de bienvenida</span></template>
      <template #actions>
        <button
          type="button"
          data-test="trigger-welcome"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          aria-label="Probar simulación de bienvenida"
          @click="triggerWelcomeSimulation"
        >
          Probar envío
        </button>
      </template>
      <div class="adm-form-grid">
        <AdminFormField label="Descuento de bienvenida (%)" for="welcomeDiscountPercent">
          <input
            id="welcomeDiscountPercent"
            v-model.number="policy.welcomeDiscountPercent"
            name="welcomeDiscountPercent"
            type="number"
            min="1"
            max="30"
            aria-label="Porcentaje de descuento de bienvenida"
          />
        </AdminFormField>
        <AdminFormField
          label="Descuento máximo (céntimos)"
          for="welcomeDiscountMaxCents"
          :help="`Ahora: ${adminMoney(policy.welcomeDiscountMaxCents)}`"
        >
          <input
            id="welcomeDiscountMaxCents"
            v-model.number="policy.welcomeDiscountMaxCents"
            name="welcomeDiscountMaxCents"
            type="number"
            aria-label="Tope de descuento en céntimos"
          />
        </AdminFormField>
        <AdminFormField
          label="Margen mínimo (centésimas de %)"
          for="welcomeMarginFloorBasisPoints"
          :help="`Ahora: ${policy.welcomeMarginFloorBasisPoints / 100} %. Por debajo no se aplica el descuento.`"
        >
          <input
            id="welcomeMarginFloorBasisPoints"
            v-model.number="policy.welcomeMarginFloorBasisPoints"
            name="welcomeMarginFloorBasisPoints"
            type="number"
            aria-label="Suelo de margen en puntos básicos"
          />
        </AdminFormField>
      </div>
      <UAlert
        v-if="welcomeStatus"
        role="status"
        color="success"
        variant="subtle"
        icon="i-lucide-circle-check"
        :title="welcomeStatus"
        class="mt-4"
      />
    </AdminCard>

    <AdminCard
      description="Reactivación automática de clientes que llevan tiempo sin comprar. Se excluyen quienes tienen incidencias abiertas, impagos o han pedido no recibir comunicaciones."
      aria-labelledby="heading-mkt-018"
    >
      <template #title><span id="heading-mkt-018">Recuperación de clientes inactivos</span></template>
      <template #actions>
        <button
          type="button"
          data-test="trigger-winback"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          aria-label="Probar evaluación de winback"
          @click="triggerWinbackSimulation"
        >
          Probar evaluación
        </button>
      </template>
      <div class="adm-form-grid">
        <AdminFormField
          label="Días sin comprar"
          for="winbackInactivityDays"
          help="A partir de aquí se considera inactivo."
        >
          <input
            id="winbackInactivityDays"
            v-model.number="policy.winbackInactivityDays"
            name="winbackInactivityDays"
            type="number"
            min="14"
            max="365"
            aria-label="Días de inactividad para activar winback"
          />
        </AdminFormField>
        <AdminFormField
          label="Días de espera entre ofertas"
          for="winbackCooldownDays"
          help="Evita que un cliente reciba la oferta una y otra vez."
        >
          <input
            id="winbackCooldownDays"
            v-model.number="policy.winbackCooldownDays"
            name="winbackCooldownDays"
            type="number"
            aria-label="Días de enfriamiento de winback"
          />
        </AdminFormField>
        <AdminFormField label="Descuento de recuperación (%)" for="winbackDiscountPercent">
          <input
            id="winbackDiscountPercent"
            v-model.number="policy.winbackDiscountPercent"
            name="winbackDiscountPercent"
            type="number"
            aria-label="Porcentaje de descuento de winback"
          />
        </AdminFormField>
      </div>
      <UAlert
        v-if="winbackStatus"
        role="status"
        color="success"
        variant="subtle"
        icon="i-lucide-circle-check"
        :title="winbackStatus"
        :description="winbackCode ? `Código: ${winbackCode}` : undefined"
        class="mt-4"
      />
    </AdminCard>

    <AdminCard
      description="Tras cada pedido: información de seguridad y uso del producto para todos, y propuestas comerciales solo a quien ha dado su consentimiento."
      aria-labelledby="heading-mkt-019"
    >
      <template #title><span id="heading-mkt-019">Mensajes tras la compra</span></template>
      <template #actions>
        <button
          type="button"
          data-test="trigger-postpurchase"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          aria-label="Probar emisión postcompra"
          @click="triggerPostpurchaseSimulation"
        >
          Probar envío
        </button>
      </template>
      <div class="adm-form-grid">
        <AdminFormField label="Espera antes de enviar (horas)" for="postpurchaseDelayHours">
          <input
            id="postpurchaseDelayHours"
            v-model.number="policy.postpurchaseDelayHours"
            name="postpurchaseDelayHours"
            type="number"
            min="0"
            max="168"
            aria-label="Horas de demora postcompra"
          />
        </AdminFormField>
      </div>
      <div v-if="postpurchaseStatus" role="status" class="mt-4">
        <UAlert color="success" variant="subtle" icon="i-lucide-circle-check" :title="postpurchaseStatus" />
        <ul v-if="postpurchaseDispatches.length" class="mt-3 space-y-2">
          <li v-for="d in postpurchaseDispatches" :key="d.id" class="flex flex-wrap items-center gap-2">
            <span>{{ streamLabel(d.streamType) }}</span>
            <AdminBadge :status="d.status" />
          </li>
        </ul>
      </div>
    </AdminCard>
  </div>
</template>
