<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type {
  SendTimeOptimizationPolicy,
  SendTimeOptimizationDecision,
  SendTimeCategory,
  SendTimeChannel
} from '~~/shared/send-time-optimization'

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
    errorMessage.value = errorText(error, 'No se han podido cargar las reglas de envío')
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
    errorMessage.value = errorText(
      error,
      'No se han podido guardar las reglas: alguien las ha cambiado a la vez o algún valor no es válido'
    )
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

const STATUS: Record<string, [string, 'success' | 'info' | 'warning' | 'danger' | 'neutral']> = {
  sent_immediate: ['Enviado al momento', 'success'],
  scheduled_optimized: ['Programado a la mejor hora', 'info'],
  held_out: ['En grupo de control', 'neutral'],
  suppressed_no_consent: ['No enviado: sin consentimiento', 'warning'],
  suppressed_rate_limit: ['No enviado: límite de frecuencia', 'warning']
}
const statusLabel = (code: string) =>
  STATUS[code]?.[0] ?? (code.startsWith('suppressed_') ? 'No enviado' : adminHumanize(code))
const statusTone = (code: string) => STATUS[code]?.[1] ?? (code.startsWith('suppressed_') ? 'warning' : 'neutral')
const REASONS: Record<string, string> = {
  operational_immediate: 'Los avisos operativos salen sin espera',
  operational_immediate_bypass: 'Los avisos operativos salen sin espera',
  suppressed_no_consent: 'El cliente no ha dado su consentimiento comercial',
  holdout_control_group: 'El cliente está en el grupo de control',
  cooldown_active: 'Ha recibido otro envío comercial hace poco',
  optimal_window_scheduled: 'Se envía en la mejor franja horaria permitida'
}
const reasonLabel = (code: string) => REASONS[code] ?? adminHumanize(code)
const CATEGORY: Record<string, string> = { operational: 'Operativo', marketing: 'Comercial' }
const CHANNEL: Record<string, string> = { email: 'Correo', sms: 'SMS', push: 'Notificación' }
const hour = (value: number) => `${String(value).padStart(2, '0')}:00`

const search = ref('')
const categoryFilter = ref('all')
const categoryOptions = [
  { value: 'all', label: 'Todos' },
  { value: 'operational', label: 'Operativos' },
  { value: 'marketing', label: 'Comerciales' }
]
const decisionRows = computed(() => {
  const term = search.value.toLowerCase()
  return decisions.value.filter(
    (d) =>
      (categoryFilter.value === 'all' || d.category === categoryFilter.value) &&
      (!term || d.messageId.toLowerCase().includes(term) || (d.campaignCode ?? '').toLowerCase().includes(term))
  )
})
const decisionColumns = [
  { key: 'messageId', label: 'Mensaje' },
  { key: 'category', label: 'Tipo' },
  { key: 'channel', label: 'Canal', hideOnMobile: true },
  { key: 'status', label: 'Estado' },
  { key: 'scheduledFor', label: 'Fecha de envío', sortable: true }
]
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <button v-if="policy" type="button" class="adm-btn adm-btn--primary" @click="showEditPolicy = true">
        <UIcon name="i-lucide-settings-2" class="size-4" />Editar reglas
      </button>
    </AdminPageActions>

    <UAlert v-if="notice" role="status" color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />
    <div v-if="errorMessage" data-error>
      <UAlert role="alert" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="errorMessage">
        <template #actions>
          <button type="button" class="adm-btn adm-btn--secondary adm-btn--sm" @click="loadData">Reintentar</button>
        </template>
      </UAlert>
    </div>

    <div v-if="loading" data-loading class="adm-card adm-table-skeleton" aria-busy="true">
      <span class="sr-only">Cargando las reglas de envío…</span>
      <div v-for="row in 3" :key="row"><i /><i /><i /></div>
    </div>

    <div v-else-if="policy" class="adm-grid">
      <AdminStat
        label="Grupo de control"
        :value="`${(policy.holdoutRateBasisPoints / 100).toFixed(0)}%`"
        hint="Clientes que no reciben el envío, para medir su efecto"
        icon="i-lucide-flask-conical"
      />
      <AdminStat
        label="Horario comercial"
        :value="`${hour(policy.allowedWindowStartHour)} – ${hour(policy.allowedWindowEndHour)}`"
        hint="De lunes a viernes, hora universal (UTC)"
        icon="i-lucide-clock"
      />
      <AdminStat
        label="Descanso entre envíos"
        :value="`${policy.minHoursBetweenMarketing} h`"
        hint="Mínimo entre dos envíos comerciales"
        icon="i-lucide-hourglass"
      />
      <AdminStat
        label="Límite semanal"
        :value="policy.maxWeeklyMarketingSends"
        hint="Envíos comerciales por cliente y semana"
        icon="i-lucide-calendar-range"
      />
    </div>

    <AdminCard
      title="Probar un envío"
      description="Comprueba qué pasaría con un mensaje: los avisos operativos salen al momento; los comerciales exigen consentimiento y respetan el grupo de control y el horario."
    >
      <div class="adm-form-grid">
        <AdminFormField v-slot="{ id }" label="Tipo de mensaje">
          <select :id="id" v-model="evalCategory">
            <option value="operational">Operativo (entrega inmediata)</option>
            <option value="marketing">Comercial</option>
          </select>
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Canal">
          <select :id="id" v-model="evalChannel">
            <option value="email">Correo</option>
            <option value="sms">SMS</option>
            <option value="push">Notificación</option>
          </select>
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Identificador de cliente">
          <input :id="id" v-model="evalCustomerId" type="text" placeholder="Identificador de la ficha del cliente" />
        </AdminFormField>
        <AdminFormField v-if="evalCategory === 'marketing'" v-slot="{ id }" label="Campaña">
          <input :id="id" v-model="evalCampaign" type="text" placeholder="Nombre corto de la campaña" />
        </AdminFormField>
      </div>

      <div
        v-if="latestDecision"
        class="mt-4 space-y-1 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="adm-label">Resultado de la prueba</span>
          <AdminBadge :tone="statusTone(latestDecision.status)">{{ statusLabel(latestDecision.status) }}</AdminBadge>
        </div>
        <p>
          Fecha de envío:
          <strong class="text-[var(--text-strong)]">{{ adminDate(latestDecision.scheduledFor, true) }}</strong>
        </p>
        <p class="adm-help">
          {{ reasonLabel(latestDecision.reason) }} · Consentimiento comprobado:
          {{ latestDecision.consentVerified ? 'sí' : 'no' }} · Grupo de control:
          {{ latestDecision.holdoutApplied ? 'sí' : 'no' }}
        </p>
      </div>
      <template #footer>
        <button
          data-btn-evaluate
          type="button"
          class="adm-btn adm-btn--secondary"
          :disabled="busy"
          @click="evaluateMessage"
        >
          Probar envío
        </button>
      </template>
    </AdminCard>

    <AdminSection title="Decisiones recientes">
      <div v-if="decisions.length === 0" data-empty-decisions class="adm-card">
        <AdminEmptyState
          icon="i-lucide-send"
          title="No hay decisiones de envío registradas."
          description="Aquí verás cuándo se ha enviado, programado o retenido cada mensaje."
        />
      </div>
      <AdminTable
        v-else
        :rows="decisionRows"
        :columns="decisionColumns"
        :row-key="(d) => d.id"
        :filtered="!!search || categoryFilter !== 'all'"
        caption="Decisiones de envío recientes"
        @clear-filters="((search = ''), (categoryFilter = 'all'))"
      >
        <template #toolbar>
          <AdminToolbar v-model:search="search" placeholder="Buscar por mensaje o campaña…">
            <AdminFilters v-model="categoryFilter" :options="categoryOptions" label="Filtrar por tipo" />
          </AdminToolbar>
        </template>
        <template #cell-messageId="{ row }">
          <span class="font-medium text-[var(--text-strong)]">{{ row.messageId }}</span>
          <span v-if="row.campaignCode" class="adm-help"> · {{ row.campaignCode }}</span>
        </template>
        <template #cell-category="{ row }">{{ CATEGORY[row.category] ?? row.category }}</template>
        <template #cell-channel="{ row }">{{ CHANNEL[row.channel] ?? row.channel }}</template>
        <template #cell-status="{ row }">
          <AdminBadge :tone="statusTone(row.status)">{{ statusLabel(row.status) }}</AdminBadge>
        </template>
        <template #cell-scheduledFor="{ row }">{{ adminDate(row.scheduledFor, true) }}</template>
      </AdminTable>
    </AdminSection>

    <AdminDrawer
      v-model:open="showEditPolicy"
      title="Reglas de envío"
      description="Se aplican a todos los envíos comerciales. Los avisos operativos no se retrasan nunca."
    >
      <div class="adm-stack">
        <UAlert v-if="errorMessage" role="alert" color="error" variant="subtle" :title="errorMessage" />
        <AdminFormField
          v-slot="{ id }"
          label="Grupo de control"
          help="Porcentaje de clientes que no recibe el envío, para comparar resultados. Hasta 50."
        >
          <div class="flex items-center gap-2">
            <input
              :id="id"
              :value="adminBpsToPercent(editHoldoutBp)"
              type="text"
              inputmode="decimal"
              class="adm-input"
              @change="editHoldoutBp = adminPercentFromInput($event, editHoldoutBp, 5000)"
            />
            <span class="text-[var(--text-muted)]">%</span>
          </div>
        </AdminFormField>
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Hora de inicio" help="De 0 a 23, en hora universal.">
            <input :id="id" v-model.number="editStartHour" type="number" min="0" max="23" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Hora de fin" help="De 1 a 24, en hora universal.">
            <input :id="id" v-model.number="editEndHour" type="number" min="1" max="24" />
          </AdminFormField>
        </div>
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Horas mínimas entre envíos">
            <input :id="id" v-model.number="editMinHours" type="number" min="1" max="168" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Máximo de envíos por semana">
            <input :id="id" v-model.number="editMaxWeekly" type="number" min="1" max="14" />
          </AdminFormField>
        </div>
      </div>
      <template #footer>
        <button type="button" class="adm-btn adm-btn--secondary" @click="showEditPolicy = false">Cancelar</button>
        <button type="button" class="adm-btn adm-btn--primary" :disabled="busy" @click="updatePolicy">
          Guardar reglas
        </button>
      </template>
    </AdminDrawer>
  </div>
</template>
