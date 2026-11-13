<script setup lang="ts">
import { z as zod, type z } from 'zod'
import {
  newsletterAdminSnapshotSchema,
  newsletterAdminInputSchema,
  newsletterCommandReceiptSchema,
  newsletterPreviewSchema,
  newsletterDispatchReportSchema,
  newsletterPrecommitRejectionSchema,
  newsletterHttpAuthorityLossSchema,
  type NewsletterAdminInput
} from '~~/shared/newsletter-editorial'
import NewsletterCampaignPreview from './NewsletterCampaignPreview.vue'
const props = defineProps<{ actorId: string; authorize: () => boolean }>(),
  fetch = useRequestFetch()
const snapshot = ref<z.infer<typeof newsletterAdminSnapshotSchema> | null>(null),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  preview = ref<z.infer<typeof newsletterPreviewSchema> | null>(null),
  report = ref<z.infer<typeof newsletterDispatchReportSchema> | null>(null)
const selected = ref(''),
  topicId = ref(''),
  cursor = ref<string | undefined>(),
  reason = ref('')
const policy = reactive({
  name: '',
  immediate: '',
  weekly: '',
  monthly: '',
  ratio: '',
  quiet: false,
  start: '',
  end: ''
})
const topic = reactive({ code: '', label: '', active: true })
type Block = {
  id: string
  type: 'heading' | 'paragraph' | 'link'
  kind: 'editorial' | 'commercial'
  text: string
  label: string
  targetType: 'static' | 'cms' | 'product'
  target: string
}
const document = reactive({
  name: '',
  subject: '',
  topics: [] as string[],
  topicMatch: 'any' as 'any' | 'all',
  frequencies: [] as Array<'immediate' | 'weekly' | 'monthly'>,
  changeSummary: '',
  blocks: [] as Block[]
})
const windowForm = reactive({ start: '', end: '', repeated: 'earlier' as 'earlier' | 'later' })
const pending = ref<{
  path: string
  method: 'POST' | 'PUT'
  body: NewsletterAdminInput
  key: string
  actor: string
  target: string | null
} | null>(null)
const campaign = computed(() => snapshot.value?.campaigns.find((c) => c.id === selected.value) ?? null)
const canOperate = computed(
  () => props.authorize() && !!props.actorId && !busy.value && !pending.value && !!snapshot.value
)
let epoch = 0
const minute = (value: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(value)
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1
}
function topicEditing(id: string) {
  const current = snapshot.value?.topics.find((t) => t.id === id)
  if (!current) return
  topicId.value = id
  topic.code = current.code
  topic.label = current.label
  topic.active = current.active
}
function newTopic() {
  topicId.value = ''
  topic.code = ''
  topic.label = ''
  topic.active = true
}
function newCampaign() {
  selected.value = ''
  preview.value = null
  report.value = null
  document.name = ''
  document.subject = ''
  document.topics = []
  document.frequencies = []
  document.topicMatch = 'any'
  document.changeSummary = ''
  document.blocks = []
}
function clearPrivate() {
  snapshot.value = null
  pending.value = null
  preview.value = null
  report.value = null
  busy.value = false
  notice.value = ''
  reason.value = ''
  cursor.value = undefined
  newCampaign()
  newTopic()
  Object.assign(policy, {
    name: '',
    immediate: '',
    weekly: '',
    monthly: '',
    ratio: '',
    quiet: false,
    start: '',
    end: ''
  })
  Object.assign(windowForm, { start: '', end: '', repeated: 'earlier' })
}
function selectCampaign(id: string) {
  const c = snapshot.value?.campaigns.find((row) => row.id === id)
  if (!c) return
  selected.value = id
  preview.value = null
  report.value = null
  document.name = c.document.name
  document.subject = c.document.subject
  document.topics = [...c.document.topics]
  document.topicMatch = c.document.topicMatch
  document.frequencies = [...c.document.frequencies]
  document.changeSummary = ''
  document.blocks = c.document.blocks.map((b) => ({
    id: b.id,
    type: b.type,
    kind: b.kind,
    text: b.type === 'link' ? '' : b.text,
    label: b.type === 'link' ? b.label : '',
    targetType: b.type === 'link' ? b.target.type : 'static',
    target: b.type === 'link' ? (b.target.type === 'static' ? b.target.path : b.target.slug) : '/catalogo'
  }))
}
function addBlock() {
  document.blocks.push({
    id: crypto.randomUUID(),
    type: 'paragraph',
    kind: 'editorial',
    text: '',
    label: '',
    targetType: 'static',
    target: '/catalogo'
  })
}
async function load(next?: string) {
  const turn = ++epoch,
    actor = props.actorId
  if (!props.authorize() || !actor) {
    snapshot.value = null
    return
  }
  busy.value = true
  error.value = ''
  try {
    const data = newsletterAdminSnapshotSchema.parse(
      await fetch<unknown>('/api/admin/newsletter', {
        query: next ? { cursor: next } : {},
        onRequest: () => {
          if (!props.authorize() || props.actorId !== actor) throw new Error('authority_changed')
        }
      })
    )
    if (turn !== epoch || !props.authorize() || actor !== props.actorId) return
    snapshot.value = data
    cursor.value = next
    if (!pending.value && selected.value && !data.campaigns.some((c) => c.id === selected.value)) newCampaign()
  } catch (failure) {
    if (turn === epoch) {
      if (newsletterHttpAuthorityLossSchema.safeParse(failure).success || !props.authorize()) clearPrivate()
      snapshot.value = null
      error.value =
        'Lectura no confirmada. El servicio puede estar apagado o faltan permisos/MFA; no usamos datos anteriores para operar.'
    }
  } finally {
    if (turn === epoch) busy.value = false
  }
}
async function send() {
  const intent = pending.value
  if (!intent || busy.value || !props.authorize() || intent.actor !== props.actorId) return
  const turn = ++epoch
  busy.value = true
  error.value = ''
  try {
    const receipt = newsletterCommandReceiptSchema.parse(
      await fetch<unknown>(intent.path, {
        method: intent.method,
        body: intent.body,
        headers: { 'Idempotency-Key': intent.key },
        onRequest: () => {
          if (!props.authorize() || intent.actor !== props.actorId) throw new Error('authority_changed')
        }
      })
    )
    if (turn !== epoch || !props.authorize() || intent.actor !== props.actorId) return
    if (
      receipt.action !== intent.body.action ||
      receipt.revision !== intent.body.expectedRevision + 1 ||
      (intent.target && receipt.resourceId !== intent.target)
    )
      throw new Error('unconfirmed_receipt')
    pending.value = null
    notice.value = 'Comando confirmado por el servidor. La aprobación editorial no activa por sí sola el envío externo.'
    reason.value = ''
    preview.value = null
    const resource = receipt.resourceId
    busy.value = false
    await load(cursor.value)
    if (receipt.action === 'create_campaign' || receipt.action === 'update_campaign') selectCampaign(resource)
  } catch (failure) {
    if (turn === epoch) {
      if (newsletterHttpAuthorityLossSchema.safeParse(failure).success || !props.authorize()) {
        clearPrivate()
        error.value =
          'La sesión o MFA no autorizan esta lectura. Hemos retirado datos privados; actualiza el estado tras verificar tu acceso.'
      } else if (newsletterPrecommitRejectionSchema.safeParse(failure).success) {
        pending.value = null
        snapshot.value = null
        preview.value = null
        error.value =
          'El servidor ha rechazado el comando antes de guardarlo. Actualiza el estado confirmado antes de preparar otro comando.'
      } else
        error.value =
          'Resultado no confirmado. Conservamos exactamente petición y clave. Actualiza el estado o reintenta manualmente; no enviamos automáticamente otra versión.'
    }
  } finally {
    if (turn === epoch) busy.value = false
  }
}
function stage(path: string, method: 'POST' | 'PUT', raw: unknown, target: string | null = null) {
  if (!canOperate.value) return
  const parsed = newsletterAdminInputSchema.safeParse(raw)
  if (!parsed.success) {
    error.value = 'Revisa los campos obligatorios, los límites, los temas, el motivo y los bloques.'
    return
  }
  pending.value = { path, method, body: parsed.data, key: crypto.randomUUID(), actor: props.actorId, target }
  void send()
}
function savePolicy() {
  if ([policy.immediate, policy.weekly, policy.monthly, policy.ratio].some((value) => value.trim() === '')) {
    error.value = 'Completa explícitamente todos los límites y el porcentaje editorial.'
    return
  }
  stage('/api/admin/newsletter/policy', 'POST', {
    action: 'set_policy',
    expectedRevision: snapshot.value?.policyRevision,
    reason: reason.value,
    policy: {
      name: policy.name,
      reason: reason.value,
      intervalHours: {
        immediate: Number(policy.immediate),
        weekly: Number(policy.weekly),
        monthly: Number(policy.monthly)
      },
      quietHours: policy.quiet
        ? { startMinute: minute(policy.start), endMinute: minute(policy.end), timezone: 'Europe/Madrid' }
        : null,
      minEditorialPercent: Number(policy.ratio),
      locale: 'es'
    }
  })
}
function retirePolicy() {
  if (snapshot.value?.policy)
    stage('/api/admin/newsletter/policy', 'POST', {
      action: 'retire_policy',
      expectedRevision: snapshot.value.policyRevision,
      reason: reason.value
    })
}
function saveTopic() {
  const current = snapshot.value?.topics.find((t) => t.id === topicId.value)
  stage(
    `/api/admin/newsletter/topics${current ? `/${current.id}` : ''}`,
    current ? 'PUT' : 'POST',
    current
      ? {
          action: 'update_topic',
          expectedRevision: current.revision,
          label: topic.label,
          active: topic.active,
          reason: reason.value
        }
      : { action: 'create_topic', expectedRevision: 0, code: topic.code, label: topic.label, reason: reason.value },
    current?.id ?? null
  )
}
function saveCampaign() {
  const current = campaign.value
  const blocks = document.blocks.map((b) =>
    b.type === 'link'
      ? {
          id: b.id,
          type: b.type,
          kind: b.kind,
          label: b.label,
          target:
            b.targetType === 'static' ? { type: 'static', path: b.target } : { type: b.targetType, slug: b.target }
        }
      : { id: b.id, type: b.type, kind: b.kind, text: b.text }
  )
  stage(
    `/api/admin/newsletter/campaigns${current ? `/${current.id}` : ''}`,
    current ? 'PUT' : 'POST',
    {
      action: current ? 'update_campaign' : 'create_campaign',
      expectedRevision: current?.revision ?? 0,
      reason: reason.value,
      document: {
        name: document.name,
        subject: document.subject,
        topics: [...document.topics],
        topicMatch: document.topicMatch,
        frequencies: [...document.frequencies],
        locale: 'es',
        blocks,
        changeSummary: document.changeSummary
      }
    },
    current?.id ?? null
  )
}
function approve() {
  const c = campaign.value,
    p = snapshot.value?.policy
  if (!c || !p) return
  stage(
    `/api/admin/newsletter/campaigns/${c.id}/approve`,
    'POST',
    {
      action: 'approve_campaign',
      expectedRevision: c.revision,
      versionId: c.versionId,
      policyId: p.id,
      startsAtLocal: windowForm.start,
      endsAtLocal: windowForm.end,
      repeatedHour: windowForm.repeated,
      reason: reason.value
    },
    c.id
  )
}
function cancel() {
  const c = campaign.value
  if (c)
    stage(
      `/api/admin/newsletter/campaigns/${c.id}/cancel`,
      'POST',
      { action: 'cancel_campaign', expectedRevision: c.revision, reason: reason.value },
      c.id
    )
}
async function execute(action: 'preview' | 'test' | 'dispatch') {
  const c = campaign.value
  if (!c || !canOperate.value) return
  const turn = ++epoch,
    actor = props.actorId
  busy.value = true
  error.value = ''
  try {
    const data = await fetch<unknown>(`/api/admin/newsletter/campaigns/${c.id}/${action}`, {
      method: action === 'preview' ? 'GET' : 'POST',
      ...(action === 'preview' ? {} : { body: {} }),
      onRequest: () => {
        if (!props.authorize() || actor !== props.actorId) throw new Error('authority_changed')
      }
    })
    if (turn !== epoch || !props.authorize() || actor !== props.actorId) return
    if (action === 'preview') {
      const result = newsletterPreviewSchema.parse(data)
      if (result.campaignId !== c.id || result.versionId !== c.versionId) throw new Error('stale_preview')
      preview.value = result
    } else if (action === 'dispatch') {
      report.value = newsletterDispatchReportSchema.parse(data)
      busy.value = false
      await load(cursor.value)
    } else {
      const result = zTest.safeParse(data)
      if (!result.success) throw new Error('unconfirmed')
      notice.value = 'Prueba aceptada por el envío local de pruebas. No acredita entrega externa.'
    }
  } catch (failure) {
    if (turn === epoch && (newsletterHttpAuthorityLossSchema.safeParse(failure).success || !props.authorize()))
      clearPrivate()
    if (turn === epoch)
      error.value =
        'Acción no confirmada o deshabilitada por el servidor. No se reintentará automáticamente; consulta los resultados de la cola.'
  } finally {
    if (turn === epoch) busy.value = false
  }
}
const zTest = zod
  .object({
    source: zod.literal('cloudflare'),
    synthetic: zod.literal(true),
    externalDelivery: zod.literal(false),
    acceptedLocal: zod.literal(true),
    delivered: zod.literal(false)
  })
  .strict()
watch(
  () => [props.actorId, props.authorize()],
  () => {
    epoch++
    clearPrivate()
    error.value = ''
    if (props.authorize()) void load()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  epoch++
})

// Estado de interfaz: paneles laterales, pestañas y confirmaciones.
const policyOpen = ref(false),
  topicOpen = ref(false),
  campaignOpen = ref(false),
  campaignTab = ref('content'),
  campaignSearch = ref(''),
  campaignStatus = ref('all'),
  confirmAction = ref<'cancel' | 'retire' | null>(null)
const confirmOpen = computed({
  get: () => confirmAction.value !== null,
  set: (open: boolean) => {
    if (!open) confirmAction.value = null
  }
})
function runConfirm() {
  const action = confirmAction.value
  confirmAction.value = null
  if (action === 'cancel') cancel()
  else if (action === 'retire') retirePolicy()
}
const CAMPAIGN_STATUS: Record<string, string> = {
  draft: 'Borrador',
  approved: 'Aprobada',
  cancelled: 'Cancelada',
  completed: 'Completada'
}
const campaignStatusOptions = [
  { value: 'all', label: 'Todas' },
  { value: 'draft', label: 'Borradores' },
  { value: 'approved', label: 'Aprobadas' },
  { value: 'completed', label: 'Completadas' },
  { value: 'cancelled', label: 'Canceladas' }
]
const campaignRows = computed(() => {
  const term = campaignSearch.value.toLowerCase()
  return (snapshot.value?.campaigns ?? []).filter(
    (c) =>
      (campaignStatus.value === 'all' || c.status === campaignStatus.value) &&
      (!term || c.document.name.toLowerCase().includes(term) || c.document.subject.toLowerCase().includes(term))
  )
})
const campaignColumns = [
  { key: 'name', label: 'Campaña' },
  { key: 'status', label: 'Estado' },
  { key: 'accepted', label: 'Aceptados', numeric: true, hideOnMobile: true },
  { key: 'delivered', label: 'Entregados', numeric: true },
  { key: 'bounced', label: 'Rebotes', numeric: true, hideOnMobile: true },
  { key: 'complained', label: 'Quejas', numeric: true, hideOnMobile: true },
  { key: 'pending', label: 'Pendientes', numeric: true, hideOnMobile: true }
]
const campaignTabs = computed(() => [
  { value: 'content', label: 'Contenido' },
  ...(campaign.value ? [{ value: 'delivery', label: 'Revisión y envío' }] : [])
])
const shortId = (id: string) => `#${id.slice(0, 8).toUpperCase()}`
function openNewCampaign() {
  newCampaign()
  campaignTab.value = 'content'
  campaignOpen.value = true
}
function openCampaign(id: string) {
  selectCampaign(id)
  campaignTab.value = 'content'
  campaignOpen.value = true
}
function openNewTopic() {
  newTopic()
  topicOpen.value = true
}
function openTopic(id: string) {
  topicEditing(id)
  topicOpen.value = true
}
// Un comando confirmado sin error cierra los paneles de tema y política.
watch(pending, (now, before) => {
  if (before && !now && !error.value) {
    topicOpen.value = false
    policyOpen.value = false
  }
})
</script>
<template>
  <section aria-label="Boletín" class="adm-stack">
    <AdminPageActions>
      <button
        type="button"
        class="adm-btn adm-btn--secondary"
        :disabled="busy || !props.authorize()"
        @click="load(cursor)"
      >
        <UIcon name="i-lucide-rotate-cw" class="size-4" />Actualizar estado confirmado
      </button>
      <button
        v-if="snapshot"
        type="button"
        class="adm-btn adm-btn--primary"
        :disabled="!canOperate"
        @click="openNewCampaign"
      >
        <UIcon name="i-lucide-plus" class="size-4" />Nueva campaña
      </button>
    </AdminPageActions>

    <UAlert v-if="notice" role="status" color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />
    <UAlert v-if="error" role="alert" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />
    <UAlert
      v-if="pending"
      color="warning"
      variant="subtle"
      icon="i-lucide-clock"
      title="Hay un cambio pendiente de confirmar"
      description="El reintento conserva exactamente el mismo contenido y la misma clave."
    >
      <template #actions>
        <button
          type="button"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          :disabled="busy || !props.authorize()"
          @click="send"
        >
          Reintentar mismo comando
        </button>
      </template>
    </UAlert>

    <div v-if="!snapshot && busy" class="adm-card adm-table-skeleton" aria-busy="true">
      <span class="sr-only">Cargando…</span>
      <div v-for="row in 4" :key="row"><i /><i /><i /></div>
    </div>

    <template v-if="snapshot">
      <div class="adm-grid">
        <AdminStat label="Campañas" :value="snapshot.campaigns.length" icon="i-lucide-mail" />
        <AdminStat label="Temas activos" :value="snapshot.topics.filter((t) => t.active).length" icon="i-lucide-tags" />
        <AdminStat
          label="Entrega"
          icon="i-lucide-send"
          :value="
            snapshot.capabilities.externalDelivery
              ? 'Activada'
              : snapshot.capabilities.localDispatch
                ? 'Solo pruebas'
                : 'Desactivada'
          "
          :hint="
            snapshot.capabilities.externalDelivery
              ? 'Entrega externa habilitada explícitamente en el servidor.'
              : snapshot.capabilities.localDispatch
                ? 'Solo está habilitado el envío local de pruebas.'
                : 'Entrega desactivada.'
          "
        />
      </div>

      <AdminTable
        :rows="campaignRows"
        :columns="campaignColumns"
        :row-key="(c) => c.id"
        :filtered="!!campaignSearch || campaignStatus !== 'all'"
        empty-title="Todavía no hay campañas"
        empty-description="Crea la primera campaña del boletín y guárdala como borrador."
        empty-icon="i-lucide-mail"
        caption="Campañas del boletín"
        @clear-filters="((campaignSearch = ''), (campaignStatus = 'all'))"
      >
        <template #toolbar>
          <AdminToolbar v-model:search="campaignSearch" placeholder="Buscar por nombre o asunto…">
            <AdminFilters v-model="campaignStatus" :options="campaignStatusOptions" label="Filtrar por estado" />
            <template #actions>
              <button
                v-if="cursor"
                type="button"
                class="adm-btn adm-btn--ghost adm-btn--sm"
                :disabled="!canOperate"
                @click="load()"
              >
                Primera página
              </button>
              <button
                v-if="snapshot.nextCursor"
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="!canOperate"
                @click="load(snapshot.nextCursor)"
              >
                Siguiente página de campañas
              </button>
            </template>
          </AdminToolbar>
        </template>
        <template #cell-name="{ row }">
          <button
            type="button"
            class="text-left font-semibold text-[var(--text-strong)] hover:underline"
            :disabled="!canOperate"
            @click="openCampaign(row.id)"
          >
            {{ row.document.name }}
          </button>
          <p class="adm-help">{{ row.document.subject }}</p>
        </template>
        <template #cell-status="{ row }">
          <AdminBadge :tone="adminStatusTone(row.status)">{{ CAMPAIGN_STATUS[row.status] ?? row.status }}</AdminBadge>
        </template>
        <template #cell-accepted="{ row }">{{ row.totals.accepted }}</template>
        <template #cell-delivered="{ row }">{{ row.totals.delivered }}</template>
        <template #cell-bounced="{ row }">{{ row.totals.bounced }}</template>
        <template #cell-complained="{ row }">{{ row.totals.complained }}</template>
        <template #cell-pending="{ row }">
          {{ row.totals.pending + row.totals.leased + row.totals.sending }}
          <span v-if="row.totals.manualReview" class="adm-help"> · {{ row.totals.manualReview }} por revisar</span>
        </template>
        <template #actions="{ row }">
          <AdminButton size="sm" :disabled="!canOperate" @click="openCampaign(row.id)">Abrir</AdminButton>
        </template>
        <template #empty-action>
          <AdminButton variant="primary" icon="i-lucide-plus" :disabled="!canOperate" @click="openNewCampaign">
            Nueva campaña
          </AdminButton>
        </template>
      </AdminTable>

      <div class="grid gap-5 lg:grid-cols-2">
        <AdminCard title="Temas" description="Los suscriptores eligen de qué temas quieren recibir correos." flush>
          <template #actions>
            <AdminButton size="sm" icon="i-lucide-plus" :disabled="!canOperate" @click="openNewTopic">
              Nuevo tema
            </AdminButton>
          </template>
          <AdminEmptyState
            v-if="!snapshot.topics.length"
            compact
            icon="i-lucide-tags"
            title="Todavía no hay temas"
            description="Sin temas, las campañas se envían como boletín general."
          />
          <ul v-else class="adm-list">
            <li v-for="t in snapshot.topics" :key="t.id">
              <div class="min-w-0 flex-1">
                <p class="adm-list__title">{{ t.label }}</p>
                <p class="adm-help">{{ t.code }}</p>
              </div>
              <AdminBadge :tone="t.active ? 'success' : 'neutral'">{{ t.active ? 'Activo' : 'Retirado' }}</AdminBadge>
              <AdminButton size="sm" :disabled="!canOperate" @click="openTopic(t.id)">Editar tema</AdminButton>
            </li>
          </ul>
        </AdminCard>

        <AdminCard title="Política de envío" description="Límites de frecuencia y proporción de contenido editorial.">
          <template #actions>
            <AdminButton size="sm" :disabled="!canOperate" @click="policyOpen = true">
              {{ snapshot.policy ? 'Cambiar política' : 'Definir política' }}
            </AdminButton>
            <AdminButton
              v-if="snapshot.policy"
              size="sm"
              variant="danger-soft"
              :disabled="!canOperate"
              @click="confirmAction = 'retire'"
            >
              Retirar
            </AdminButton>
          </template>
          <dl v-if="snapshot.policy" class="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <dt class="adm-help">Nombre</dt>
              <dd class="font-semibold text-[var(--text-strong)]">{{ snapshot.policy.document.name }}</dd>
            </div>
            <div>
              <dt class="adm-help">Contenido editorial mínimo</dt>
              <dd>{{ snapshot.policy.document.minEditorialPercent }} %</dd>
            </div>
            <div>
              <dt class="adm-help">Horas de silencio</dt>
              <dd>
                {{ snapshot.policy.document.quietHours ? 'Activadas (hora de Madrid)' : 'Sin horas de silencio' }}
              </dd>
            </div>
            <div>
              <dt class="adm-help">Entre envíos «al publicarse»</dt>
              <dd>{{ snapshot.policy.document.intervalHours.immediate }} h</dd>
            </div>
            <div>
              <dt class="adm-help">Entre envíos semanales</dt>
              <dd>{{ snapshot.policy.document.intervalHours.weekly }} h</dd>
            </div>
            <div>
              <dt class="adm-help">Entre envíos mensuales</dt>
              <dd>{{ snapshot.policy.document.intervalHours.monthly }} h</dd>
            </div>
          </dl>
          <AdminEmptyState
            v-else
            compact
            icon="i-lucide-shield"
            title="No existe una política aprobada"
            description="Ningún límite se aplica por defecto: sin política no se puede aprobar ningún envío."
          />
          <template #footer>
            <span class="adm-help mr-auto">
              Cambiar o retirar la política bloquea los envíos futuros aprobados con ella.
            </span>
          </template>
        </AdminCard>
      </div>

      <!-- Política -->
      <AdminDrawer
        v-model:open="policyOpen"
        title="Política de envío"
        description="Al guardarla sustituye a la política vigente."
      >
        <div class="adm-stack">
          <UAlert v-if="error" role="alert" color="error" variant="subtle" :title="error" />
          <form id="newsletter-policy-form" @submit.prevent="savePolicy">
            <fieldset :disabled="!canOperate" class="adm-stack">
              <AdminFormField v-slot="{ id }" label="Nombre" required>
                <input :id="id" v-model="policy.name" required minlength="3" />
              </AdminFormField>
              <AdminFormField
                v-slot="{ id }"
                label="Contenido editorial mínimo (%)"
                help="Parte del correo que no puede ser comercial."
                required
              >
                <input :id="id" v-model="policy.ratio" type="number" min="0" max="100" required />
              </AdminFormField>
              <div class="adm-form-grid">
                <AdminFormField v-slot="{ id }" label="Al publicarse: intervalo mínimo (h)" required>
                  <input :id="id" v-model="policy.immediate" type="number" min="1" max="8760" required />
                </AdminFormField>
                <AdminFormField v-slot="{ id }" label="Semanal: intervalo mínimo (h)" required>
                  <input :id="id" v-model="policy.weekly" type="number" min="168" max="8760" required />
                </AdminFormField>
                <AdminFormField v-slot="{ id }" label="Mensual: intervalo mínimo (h)" required>
                  <input :id="id" v-model="policy.monthly" type="number" min="744" max="8760" required />
                </AdminFormField>
              </div>
              <label class="adm-check">
                <input v-model="policy.quiet" type="checkbox" /> Horas de silencio (hora de Madrid)
              </label>
              <div v-if="policy.quiet" class="adm-form-grid">
                <AdminFormField v-slot="{ id }" label="Desde" required>
                  <input :id="id" v-model="policy.start" type="time" required />
                </AdminFormField>
                <AdminFormField v-slot="{ id }" label="Hasta" required>
                  <input :id="id" v-model="policy.end" type="time" required />
                </AdminFormField>
              </div>
              <AdminFormField
                v-slot="{ id }"
                label="Motivo del cambio"
                help="Queda registrado en el historial."
                required
              >
                <textarea
                  :id="id"
                  v-model="reason"
                  aria-label="Motivo editorial"
                  rows="3"
                  minlength="3"
                  maxlength="500"
                />
              </AdminFormField>
            </fieldset>
          </form>
        </div>
        <template #footer>
          <AdminButton @click="policyOpen = false">Cancelar</AdminButton>
          <button type="submit" form="newsletter-policy-form" class="adm-btn adm-btn--primary" :disabled="!canOperate">
            Aprobar nueva política
          </button>
        </template>
      </AdminDrawer>

      <!-- Tema -->
      <AdminDrawer v-model:open="topicOpen" :title="topicId ? 'Editar tema' : 'Nuevo tema'">
        <div class="adm-stack">
          <UAlert v-if="error" role="alert" color="error" variant="subtle" :title="error" />
          <form id="newsletter-topic-form" @submit.prevent="saveTopic">
            <fieldset :disabled="!canOperate" class="adm-stack">
              <AdminFormField
                v-slot="{ id }"
                label="Código"
                help="Identificador corto en minúsculas. No se puede cambiar después."
                required
              >
                <input :id="id" v-model="topic.code" :disabled="!!topicId" required />
              </AdminFormField>
              <AdminFormField v-slot="{ id }" label="Nombre visible" required>
                <input :id="id" v-model="topic.label" required minlength="3" />
              </AdminFormField>
              <label v-if="topicId" class="adm-check"><input v-model="topic.active" type="checkbox" /> Activo</label>
              <AdminFormField
                v-slot="{ id }"
                label="Motivo del cambio"
                help="Queda registrado en el historial."
                required
              >
                <textarea
                  :id="id"
                  v-model="reason"
                  aria-label="Motivo editorial"
                  rows="3"
                  minlength="3"
                  maxlength="500"
                />
              </AdminFormField>
            </fieldset>
          </form>
        </div>
        <template #footer>
          <AdminButton @click="topicOpen = false">Cancelar</AdminButton>
          <button type="submit" form="newsletter-topic-form" class="adm-btn adm-btn--primary" :disabled="!canOperate">
            Guardar tema
          </button>
        </template>
      </AdminDrawer>

      <!-- Campaña -->
      <AdminDrawer
        v-model:open="campaignOpen"
        wide
        :title="campaign ? campaign.document.name : 'Nueva campaña'"
        :description="
          campaign
            ? `${CAMPAIGN_STATUS[campaign.status] ?? campaign.status} · versión ${shortId(campaign.versionId)}`
            : 'Se guarda como borrador hasta que la apruebes.'
        "
      >
        <div class="adm-stack">
          <AdminTabs v-if="campaign" v-model="campaignTab" :tabs="campaignTabs" label="Apartados de la campaña" />
          <UAlert v-if="notice" role="status" color="success" variant="subtle" :title="notice" />
          <UAlert v-if="error" role="alert" color="error" variant="subtle" :title="error" />

          <form
            v-show="campaignTab === 'content' || !campaign"
            id="newsletter-campaign-form"
            @submit.prevent="saveCampaign"
          >
            <fieldset :disabled="!canOperate || (!!campaign && campaign.status !== 'draft')" class="adm-stack">
              <UAlert
                v-if="campaign && campaign.status !== 'draft'"
                color="neutral"
                variant="subtle"
                icon="i-lucide-lock"
                title="Solo se pueden editar las campañas en borrador"
              />
              <AdminFormField v-slot="{ id }" label="Nombre" help="Solo lo ve tu equipo." required>
                <input :id="id" v-model="document.name" required minlength="3" />
              </AdminFormField>
              <AdminFormField v-slot="{ id }" label="Asunto del correo" required>
                <input :id="id" v-model="document.subject" required minlength="3" maxlength="160" />
              </AdminFormField>
              <fieldset class="adm-field">
                <legend class="adm-label">Frecuencias que la reciben</legend>
                <div class="flex flex-wrap gap-x-5 gap-y-2">
                  <label class="adm-check">
                    <input v-model="document.frequencies" type="checkbox" value="immediate" /> Al publicarse
                  </label>
                  <label class="adm-check">
                    <input v-model="document.frequencies" type="checkbox" value="weekly" /> Semanal
                  </label>
                  <label class="adm-check">
                    <input v-model="document.frequencies" type="checkbox" value="monthly" /> Mensual
                  </label>
                </div>
              </fieldset>
              <fieldset class="adm-field">
                <legend class="adm-label">Temas de la campaña</legend>
                <div class="flex flex-wrap gap-x-5 gap-y-2">
                  <label v-for="t in snapshot.topics.filter((t) => t.active)" :key="t.id" class="adm-check">
                    <input v-model="document.topics" type="checkbox" :value="t.code" /> {{ t.label }}
                  </label>
                </div>
                <p class="adm-help">Sin ningún tema marcado se envía como boletín general.</p>
              </fieldset>
              <AdminFormField v-slot="{ id }" label="Coincidencia de temas">
                <select :id="id" v-model="document.topicMatch">
                  <option value="any">Algún tema</option>
                  <option value="all">Todos los temas</option>
                </select>
              </AdminFormField>

              <div class="adm-field">
                <p class="adm-label">Bloques de contenido</p>
                <p v-if="!document.blocks.length" class="adm-help">Añade títulos, párrafos y enlaces a la tienda.</p>
                <div
                  v-for="(b, index) in document.blocks"
                  :key="b.id"
                  class="space-y-3 rounded-[var(--radius-surface)] border border-[var(--border)] p-3"
                >
                  <div class="adm-form-grid">
                    <AdminFormField v-slot="{ id }" label="Tipo">
                      <select :id="id" v-model="b.type">
                        <option value="heading">Título</option>
                        <option value="paragraph">Párrafo</option>
                        <option value="link">Enlace interno</option>
                      </select>
                    </AdminFormField>
                    <AdminFormField v-slot="{ id }" label="Clasificación">
                      <select :id="id" v-model="b.kind">
                        <option value="editorial">Editorial</option>
                        <option value="commercial">Comercial</option>
                      </select>
                    </AdminFormField>
                  </div>
                  <template v-if="b.type === 'link'">
                    <AdminFormField v-slot="{ id }" label="Texto del enlace" required>
                      <input :id="id" v-model="b.label" required />
                    </AdminFormField>
                    <div class="adm-form-grid">
                      <AdminFormField v-slot="{ id }" label="Destino">
                        <select :id="id" v-model="b.targetType">
                          <option value="static">Página fija</option>
                          <option value="cms">Contenido publicado</option>
                          <option value="product">Producto público vigente</option>
                        </select>
                      </AdminFormField>
                      <AdminFormField v-if="b.targetType === 'static'" v-slot="{ id }" label="Página">
                        <select :id="id" v-model="b.target">
                          <option value="/catalogo">Catálogo</option>
                          <option value="/ayuda">Ayuda</option>
                          <option value="/contacto">Contacto</option>
                          <option value="/envios">Envíos</option>
                          <option value="/devoluciones">Devoluciones</option>
                          <option value="/formas-de-pago">Formas de pago</option>
                          <option value="/accesibilidad">Accesibilidad</option>
                        </select>
                      </AdminFormField>
                      <AdminFormField
                        v-else
                        v-slot="{ id }"
                        label="Dirección publicada"
                        help="La parte final de la dirección de la página o del producto."
                        required
                      >
                        <input :id="id" v-model="b.target" required />
                      </AdminFormField>
                    </div>
                  </template>
                  <AdminFormField v-else v-slot="{ id }" label="Contenido" required>
                    <textarea :id="id" v-model="b.text" rows="3" required />
                  </AdminFormField>
                  <div class="flex flex-wrap justify-end gap-2">
                    <button
                      v-if="index > 0"
                      type="button"
                      class="adm-btn adm-btn--ghost adm-btn--sm"
                      @click="document.blocks.splice(index - 1, 0, ...document.blocks.splice(index, 1))"
                    >
                      <UIcon name="i-lucide-arrow-up" class="size-4" />Subir bloque
                    </button>
                    <button
                      type="button"
                      class="adm-btn adm-btn--ghost adm-btn--sm"
                      @click="document.blocks.splice(index, 1)"
                    >
                      <UIcon name="i-lucide-trash-2" class="size-4" />Quitar bloque
                    </button>
                  </div>
                </div>
                <div>
                  <button
                    type="button"
                    class="adm-btn adm-btn--secondary adm-btn--sm"
                    :disabled="document.blocks.length >= 50"
                    @click="addBlock"
                  >
                    <UIcon name="i-lucide-plus" class="size-4" />Añadir bloque
                  </button>
                </div>
              </div>

              <AdminFormField
                v-slot="{ id }"
                label="Resumen de esta versión"
                help="Qué cambia respecto a la versión anterior."
                required
              >
                <textarea :id="id" v-model="document.changeSummary" rows="2" required minlength="3" />
              </AdminFormField>
              <AdminFormField
                v-slot="{ id }"
                label="Motivo del cambio"
                help="Queda registrado en el historial."
                required
              >
                <textarea
                  :id="id"
                  v-model="reason"
                  aria-label="Motivo editorial"
                  rows="2"
                  minlength="3"
                  maxlength="500"
                />
              </AdminFormField>
            </fieldset>
          </form>

          <div v-if="campaign && campaignTab === 'delivery'" class="adm-stack">
            <p class="adm-help">
              Versión confirmada {{ shortId(campaign.versionId) }}. Un correo aceptado para envío todavía no cuenta como
              entregado.
            </p>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="adm-btn adm-btn--secondary"
                :disabled="!canOperate"
                @click="execute('preview')"
              >
                <UIcon name="i-lucide-eye" class="size-4" />Ver vista previa
              </button>
              <button
                v-if="snapshot.capabilities.localDispatch"
                type="button"
                class="adm-btn adm-btn--secondary"
                :disabled="!canOperate"
                @click="execute('test')"
              >
                Prueba sintética local
              </button>
              <button
                v-if="
                  campaign.status === 'approved' &&
                  (snapshot.capabilities.localDispatch || snapshot.capabilities.externalDelivery)
                "
                type="button"
                class="adm-btn adm-btn--secondary"
                :disabled="!canOperate"
                @click="execute('dispatch')"
              >
                <UIcon name="i-lucide-send" class="size-4" />Procesar lote de envío
              </button>
            </div>
            <UAlert
              v-if="report"
              color="info"
              variant="subtle"
              icon="i-lucide-send"
              title="Lote procesado"
              :description="`${report.acceptedLocal} aceptados en pruebas, ${report.acceptedProvider} aceptados por el proveedor, ${report.skipped} omitidos, ${report.deferred} aplazados y ${report.manualReview} en revisión manual. ${report.disabled ? 'La entrega está apagada.' : 'No acredita la recepción.'}`"
            />
            <NewsletterCampaignPreview v-if="preview" :value="preview" />

            <AdminCard v-if="campaign.status === 'draft'" title="Aprobar y programar">
              <UAlert
                v-if="!snapshot.policy"
                color="warning"
                variant="subtle"
                title="Define antes una política de envío"
                class="mb-4"
              />
              <form id="newsletter-approve-form" @submit.prevent="approve">
                <fieldset :disabled="!canOperate || !snapshot.policy" class="adm-stack">
                  <div class="adm-form-grid">
                    <AdminFormField v-slot="{ id }" label="Inicio (hora de Madrid)" required>
                      <input :id="id" v-model="windowForm.start" type="datetime-local" required />
                    </AdminFormField>
                    <AdminFormField v-slot="{ id }" label="Final (hora de Madrid)" required>
                      <input :id="id" v-model="windowForm.end" type="datetime-local" required />
                    </AdminFormField>
                  </div>
                  <AdminFormField
                    v-slot="{ id }"
                    label="Si la hora se repite por el cambio de hora"
                    help="Solo afecta a la madrugada del cambio al horario de invierno."
                  >
                    <select :id="id" v-model="windowForm.repeated">
                      <option value="earlier">Primera ocurrencia</option>
                      <option value="later">Segunda ocurrencia</option>
                    </select>
                  </AdminFormField>
                  <AdminFormField v-slot="{ id }" label="Motivo de la aprobación" required>
                    <textarea
                      :id="id"
                      v-model="reason"
                      aria-label="Motivo editorial"
                      rows="2"
                      minlength="3"
                      maxlength="500"
                    />
                  </AdminFormField>
                  <div>
                    <button type="submit" class="adm-btn adm-btn--primary">Aprobar versión y programar envío</button>
                  </div>
                </fieldset>
              </form>
            </AdminCard>
            <p v-if="campaign.startsAt">
              Envío programado: del {{ adminDate(campaign.startsAt, true) }} al {{ adminDate(campaign.endsAt, true) }}.
            </p>
            <div v-if="campaign.status === 'draft' || campaign.status === 'approved'">
              <button
                type="button"
                class="adm-btn adm-btn--danger-soft"
                :disabled="!canOperate"
                @click="confirmAction = 'cancel'"
              >
                Cancelar campaña
              </button>
            </div>
          </div>
        </div>
        <template #footer>
          <AdminButton @click="campaignOpen = false">Cerrar</AdminButton>
          <button
            v-if="!campaign || campaignTab === 'content'"
            type="submit"
            form="newsletter-campaign-form"
            class="adm-btn adm-btn--primary"
            :disabled="!canOperate || (!!campaign && campaign.status !== 'draft')"
          >
            Guardar borrador
          </button>
        </template>
      </AdminDrawer>

      <AdminConfirm
        v-model:open="confirmOpen"
        :title="confirmAction === 'retire' ? 'Retirar la política de envío' : 'Cancelar la campaña'"
        :description="
          confirmAction === 'retire'
            ? 'Se bloquearán todos los envíos aprobados con esta política hasta que apruebes otra.'
            : 'Se cancela la campaña y los correos que aún no se han enviado.'
        "
        :confirm-label="confirmAction === 'retire' ? 'Retirar política' : 'Cancelar campaña'"
        cancel-label="Volver"
        danger
        @confirm="runConfirm"
      >
        <AdminFormField v-slot="{ id }" label="Motivo" help="Queda registrado en el historial." required>
          <textarea
            :id="id"
            v-model="reason"
            class="adm-input"
            aria-label="Motivo editorial"
            rows="3"
            minlength="3"
            maxlength="500"
          />
        </AdminFormField>
      </AdminConfirm>
    </template>
  </section>
</template>
