<script setup lang="ts">
import {
  adminMarketingModalDetailSchema,
  adminMarketingModalInputSchema,
  adminMarketingModalIntentHash,
  adminMarketingModalListSchema,
  adminMarketingModalPolicyIntentHash,
  adminMarketingModalPolicyInputSchema,
  adminMarketingModalPolicyReceiptSchema,
  adminMarketingModalReceiptSchema,
  type AdminMarketingModalDetail,
  type AdminMarketingModalInput,
  type AdminMarketingModalItem,
  type AdminMarketingModalList,
  type AdminMarketingModalPolicyInput
} from '~~/shared/marketing-modals'

/**
 * Administration of marketing modals. Writes are frozen commands: the reviewed body and
 * its Idempotency-Key are kept until the server confirms the receipt. An uncertain outcome is never
 * resent automatically; it must be verified first and then replayed with the exact same key.
 */
const request = useRequestFetch()
const runtime = useRuntimeConfig()

const COLLECTION = '/api/admin/marketing-modals'
const POLICY = '/api/admin/marketing-modals/policy'

const list = ref<AdminMarketingModalList | null>(null)
const detail = ref<AdminMarketingModalDetail | null>(null)
const loadError = ref('')
const notice = ref('')
const formError = ref('')
const busy = ref(false)
const search = ref('')
const statusFilter = ref<'all' | 'draft' | 'published' | 'retired'>('all')
const page = ref(1)

const editing = ref(false)
const editingVersion = ref(0)
const draft = reactive({
  id: '',
  code: '',
  title: '',
  body: '',
  ctaLabel: '',
  ctaPath: '/',
  objective: 'newsletter_subscription' as AdminMarketingModalInput['definition']['objective'],
  status: 'draft' as 'draft' | 'published' | 'retired',
  triggerKind: 'time_on_page' as 'time_on_page' | 'scroll_depth' | 'exit_intent' | 'page_views',
  triggerValue: '10',
  segments: ['anonymous', 'customer', 'professional'] as Array<'anonymous' | 'customer' | 'professional'>,
  marketingConsent: 'any' as 'any' | 'with_consent' | 'without_consent',
  includePrefixes: '/catalogo',
  excludePrefixes: '',
  priority: '100',
  priorityTier: 'normal' as 'normal' | 'high' | 'critical',
  maxImpressions: '2',
  windowSeconds: '86400',
  startsAt: '',
  endsAt: '',
  reason: ''
})

interface FrozenCommand {
  raw: AdminMarketingModalInput
  key: string
  payloadHash: string
  uncertain: boolean
  absent: boolean
}
const frozen = ref<FrozenCommand | null>(null)

const policyCooldown = ref('3600')
const policyReason = ref('')
const policyKey = ref<string | null>(null)
const policyFrozen = ref<{ raw: AdminMarketingModalPolicyInput; payloadHash: string } | null>(null)

const instant = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z')
const localInput = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const toInstant = (local: string): string | null => {
  if (!local) return null
  const time = Date.parse(local)
  return Number.isFinite(time) ? instant(new Date(time)) : null
}

function errorCode(cause: unknown): string | undefined {
  const code = (cause as { data?: { error?: { code?: unknown } } } | null)?.data?.error?.code
  return typeof code === 'string' ? code : undefined
}

const FINAL_ERRORS: Record<string, string> = {
  version_conflict: 'La ventana ha cambiado desde que la abriste. Consulta de nuevo antes de guardar.',
  idempotency_conflict: 'Este cambio no coincide con el que ya se registró. Consulta de nuevo antes de repetirlo.',
  code_immutable: 'El nombre interno de una ventana no puede cambiarse.',
  code_conflict: 'Ya existe una ventana con ese nombre interno.',
  modal_retired: 'Una ventana retirada no puede modificarse.',
  forbidden: 'No tienes permiso para esta operación.',
  mfa_required: 'Confirma la verificación en dos pasos y consulta de nuevo.',
  unauthenticated: 'Inicia sesión y consulta de nuevo.',
  invalid_input: 'El servidor ha rechazado los datos. Revisa los campos y el motivo.',
  rate_limited: 'Hay demasiados intentos. Espera antes de volver a intentarlo.'
}

function resetDraft(next?: AdminMarketingModalItem) {
  const definition = next?.definition
  Object.assign(draft, {
    id: definition?.id ?? crypto.randomUUID(),
    code: definition?.code ?? '',
    title: definition?.title ?? '',
    body: definition?.body ?? '',
    ctaLabel: definition?.ctaLabel ?? '',
    ctaPath: definition?.ctaPath ?? '/',
    objective: definition?.objective ?? 'newsletter_subscription',
    status: definition?.status === 'published' ? 'published' : 'draft',
    triggerKind: definition?.trigger.kind ?? 'time_on_page',
    triggerValue: String(
      definition
        ? definition.trigger.kind === 'scroll_depth'
          ? definition.trigger.minPercent
          : definition.trigger.kind === 'page_views'
            ? definition.trigger.minPageViews
            : definition.trigger.minSeconds
        : 10
    ),
    segments: definition?.audience.segments ?? ['anonymous', 'customer', 'professional'],
    marketingConsent: definition?.audience.marketingConsent ?? 'any',
    includePrefixes: definition?.targeting.includePrefixes.join(', ') ?? '/catalogo',
    excludePrefixes: definition?.targeting.excludePrefixes.join(', ') ?? '',
    priority: String(definition?.priority ?? 100),
    priorityTier: definition?.priorityTier ?? 'normal',
    maxImpressions: String(definition?.frequency.maxImpressionsPerVisitor ?? 2),
    windowSeconds: String(definition?.frequency.windowSeconds ?? 86400),
    startsAt: localInput(definition ? new Date(definition.startsAt) : new Date()),
    endsAt: definition?.endsAt ? localInput(new Date(definition.endsAt)) : '',
    reason: ''
  })
  editingVersion.value = definition?.version ?? 0
  frozen.value = null
  formError.value = ''
}

function startCreate() {
  editing.value = true
  resetDraft()
}

function startEdit(item: AdminMarketingModalItem) {
  if (item.definition.status === 'retired') return
  editing.value = true
  resetDraft(item)
}

function values(text: string) {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function buildRaw(): unknown {
  const trigger = (() => {
    const value = Number(draft.triggerValue)
    switch (draft.triggerKind) {
      case 'scroll_depth':
        return { kind: 'scroll_depth', minPercent: value }
      case 'page_views':
        return { kind: 'page_views', minPageViews: value }
      case 'exit_intent':
        return { kind: 'exit_intent', minSeconds: value }
      default:
        return { kind: 'time_on_page', minSeconds: value }
    }
  })()
  return {
    expectedVersion: editingVersion.value,
    definition: {
      id: draft.id,
      version: editingVersion.value + 1,
      code: draft.code.trim(),
      status: draft.status,
      title: draft.title,
      body: draft.body,
      ctaLabel: draft.ctaLabel,
      ctaPath: draft.ctaPath.trim(),
      objective: draft.objective,
      abVariant: null,
      trigger,
      audience: { segments: draft.segments, marketingConsent: draft.marketingConsent },
      targeting: { includePrefixes: values(draft.includePrefixes), excludePrefixes: values(draft.excludePrefixes) },
      priority: Number(draft.priority),
      priorityTier: draft.priorityTier,
      frequency: {
        maxImpressionsPerVisitor: Number(draft.maxImpressions),
        windowSeconds: Number(draft.windowSeconds)
      },
      startsAt: toInstant(draft.startsAt),
      endsAt: toInstant(draft.endsAt)
    },
    reason: draft.reason
  }
}

async function review() {
  formError.value = ''
  const parsed = adminMarketingModalInputSchema.safeParse(buildRaw())
  if (!parsed.success) {
    formError.value = 'Revisa los campos: hay datos incompletos o que no cumplen las reglas de la ventana.'
    return
  }
  const raw = parsed.data
  frozen.value = {
    raw,
    key: crypto.randomUUID(),
    payloadHash: await adminMarketingModalIntentHash(raw),
    uncertain: false,
    absent: false
  }
}

function closeEditor() {
  editing.value = false
  frozen.value = null
}

function cancelReview() {
  frozen.value = null
}

async function loadList() {
  loadError.value = ''
  const params = new URLSearchParams({
    q: search.value.trim(),
    status: statusFilter.value,
    page: String(page.value),
    perPage: '25'
  })
  try {
    const parsed = adminMarketingModalListSchema.safeParse(await request(`${COLLECTION}?${params}`))
    if (!parsed.success) throw new Error('unconfirmed_list')
    list.value = parsed.data
  } catch (cause) {
    loadError.value = apiErrorMessage(cause, 'No se han podido cargar las ventanas emergentes.')
  }
}

async function inspect(id: string) {
  try {
    const parsed = adminMarketingModalDetailSchema.safeParse(await request(`${COLLECTION}/${id}`))
    detail.value = parsed.success ? parsed.data : null
    if (!parsed.success) loadError.value = 'No se ha podido confirmar el historial de la ventana.'
  } catch (cause) {
    loadError.value = apiErrorMessage(cause, 'No se ha podido cargar el historial.')
  }
}

async function confirmWrite(replay: boolean) {
  const command = frozen.value
  if (!command || busy.value) return
  busy.value = true
  notice.value = ''
  try {
    const receipt = await request(COLLECTION, {
      method: 'POST',
      body: command.raw,
      headers: { 'Idempotency-Key': command.key }
    })
    const parsed = adminMarketingModalReceiptSchema.safeParse(receipt)
    if (!parsed.success || parsed.data.payloadHash !== command.payloadHash) throw new Error('unconfirmed_receipt')
    frozen.value = null
    editing.value = false
    notice.value = `Ventana «${parsed.data.item.definition.title}» guardada (versión ${parsed.data.version}).`
    await loadList()
  } catch (cause) {
    const code = errorCode(cause)
    if (code && FINAL_ERRORS[code]) {
      // Definitive rejection: the server did not register the command, a new draft needs a new key.
      frozen.value = null
      formError.value = FINAL_ERRORS[code]!
    } else {
      command.uncertain = true
      formError.value = replay
        ? 'El reintento tampoco se ha podido confirmar. Comprueba el resultado antes de volver a intentarlo.'
        : 'No se ha podido confirmar el resultado. Compruébalo antes de reintentar; no se reenviará automáticamente.'
    }
  } finally {
    busy.value = false
  }
}

async function verifyReceipt() {
  const command = frozen.value
  if (!command || busy.value) return
  busy.value = true
  try {
    const response = (await request(`${COLLECTION}/commands/${command.key}`, {
      headers: { 'X-Neteco-Command-Payload-Hash': command.payloadHash }
    })) as { outcome?: unknown; receipt?: { payloadHash?: unknown }; error?: { code?: unknown } }
    if (response?.outcome === 'applied' && response.receipt?.payloadHash === command.payloadHash) {
      frozen.value = null
      editing.value = false
      notice.value = 'El cambio ya estaba registrado; la lista se ha actualizado.'
      await loadList()
      return
    }
    if (response?.error?.code === 'not_found') command.absent = true
    else formError.value = 'No se ha podido verificar el resultado. Consulta de nuevo más tarde.'
  } catch (cause) {
    if (errorCode(cause) === 'not_found') command.absent = true
    else formError.value = 'No se ha podido verificar el resultado. Consulta de nuevo más tarde.'
  } finally {
    busy.value = false
  }
}

async function reviewPolicy() {
  const parsed = adminMarketingModalPolicyInputSchema.safeParse({
    expectedVersion: list.value?.policy.version ?? 0,
    globalCooldownSeconds: Number(policyCooldown.value),
    reason: policyReason.value
  })
  if (!parsed.success) {
    formError.value = 'La pausa debe estar entre 60 segundos y 7 días, con un motivo de al menos 5 caracteres.'
    return
  }
  policyFrozen.value = {
    raw: parsed.data,
    payloadHash: await adminMarketingModalPolicyIntentHash(parsed.data)
  }
  policyKey.value = crypto.randomUUID()
}

async function savePolicy() {
  const command = policyFrozen.value
  if (!command || !policyKey.value || busy.value) return
  busy.value = true
  try {
    const receipt = await request(POLICY, {
      method: 'POST',
      body: command.raw,
      headers: { 'Idempotency-Key': policyKey.value }
    })
    const parsed = adminMarketingModalPolicyReceiptSchema.safeParse(receipt)
    if (!parsed.success || parsed.data.payloadHash !== command.payloadHash) throw new Error('unconfirmed_receipt')
    policyFrozen.value = null
    policyKey.value = null
    notice.value = 'Pausa global actualizada.'
    await loadList()
  } catch (cause) {
    const code = errorCode(cause)
    if (code && FINAL_ERRORS[code]) {
      policyFrozen.value = null
      policyKey.value = null
      formError.value = FINAL_ERRORS[code]!
    } else {
      formError.value = 'No se ha podido confirmar el cambio de pausa. Consulta antes de reintentar.'
    }
  } finally {
    busy.value = false
  }
}

function statusLabel(status: string) {
  return status === 'published' ? 'Publicada' : status === 'retired' ? 'Retirada' : 'Borrador'
}

function triggerLabel(item: AdminMarketingModalItem) {
  const trigger = item.definition.trigger
  switch (trigger.kind) {
    case 'scroll_depth':
      return `Al bajar un ${trigger.minPercent} % de la página`
    case 'exit_intent':
      return `Al ir a salir (ordenador, tras ${trigger.minSeconds} s)`
    case 'page_views':
      return `Tras ver ${trigger.minPageViews} páginas`
    default:
      return `Tras ${trigger.minSeconds} s en la página`
  }
}

// Estado de interfaz: panel lateral, pestañas del formulario y columnas del listado.
const STATUS_OPTIONS = [
  { value: 'all', label: 'Todas' },
  { value: 'published', label: 'Publicadas' },
  { value: 'draft', label: 'Borradores' },
  { value: 'retired', label: 'Retiradas' }
]
const EDITOR_TABS = [
  { value: 'content', label: 'Contenido' },
  { value: 'display', label: 'Cuándo y a quién' },
  { value: 'limits', label: 'Límites y fechas' }
]
const editorTab = ref('content')
const columns = [
  { key: 'title', label: 'Ventana' },
  { key: 'status', label: 'Estado' },
  { key: 'trigger', label: 'Cuándo aparece', hideOnMobile: true },
  {
    key: 'impressions',
    label: 'Mostrada',
    numeric: true,
    value: (row: AdminMarketingModalItem) => row.stats.impressions
  },
  {
    key: 'dismissals',
    label: 'Cierres',
    numeric: true,
    hideOnMobile: true,
    value: (row: AdminMarketingModalItem) => row.stats.dismissals
  },
  {
    key: 'conversions',
    label: 'Conversiones',
    numeric: true,
    value: (row: AdminMarketingModalItem) => row.stats.conversions
  }
]
const statusTone = (status: string): 'success' | 'neutral' | 'warning' =>
  status === 'published' ? 'success' : status === 'retired' ? 'neutral' : 'warning'
const tableStatus = computed<'success' | 'error' | 'pending'>(() =>
  list.value ? 'success' : loadError.value ? 'error' : 'pending'
)
const totals = computed(() => {
  if (!list.value) return null
  const sum = list.value.items.reduce(
    (acc, item) => ({
      impressions: acc.impressions + item.stats.impressions,
      dismissals: acc.dismissals + item.stats.dismissals,
      conversions: acc.conversions + item.stats.conversions
    }),
    { impressions: 0, dismissals: 0, conversions: 0 }
  )
  return {
    ...sum,
    rate: sum.impressions
      ? `${Math.round((sum.conversions / sum.impressions) * 100)} % de las veces mostradas`
      : undefined
  }
})
const editorOpen = computed({
  get: () => editing.value,
  set: (open: boolean) => {
    if (!open) closeEditor()
  }
})
function setStatusFilter(value: string) {
  statusFilter.value = value as typeof statusFilter.value
}
function clearFilters() {
  search.value = ''
  statusFilter.value = 'all'
}

onMounted(() => {
  if (runtime.public.serverRuntime === 'cloudflare') void loadList()
})

watch([statusFilter, page], () => {
  void loadList()
})
watch(search, () => {
  if (page.value !== 1) page.value = 1
  else void loadList()
})
watch(editing, (open) => {
  if (open) editorTab.value = 'content'
})
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <button type="button" data-testid="modal-create" class="adm-btn adm-btn--primary" @click="startCreate">
        <UIcon name="i-lucide-plus" class="size-4 shrink-0" />
        Nueva ventana
      </button>
    </AdminPageActions>

    <UAlert v-if="notice" role="status" color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />
    <UAlert
      v-if="loadError && list"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="loadError"
    />
    <UAlert
      v-if="formError && !editing"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="formError"
    />

    <div class="adm-grid">
      <AdminStat label="Ventanas" :value="list?.total ?? null" icon="i-lucide-app-window" />
      <AdminStat label="Veces mostradas" :value="totals?.impressions ?? null" hint="En las ventanas de esta página" />
      <AdminStat label="Cierres" :value="totals?.dismissals ?? null" />
      <AdminStat label="Conversiones" :value="totals?.conversions ?? null" :hint="totals?.rate" />
    </div>

    <AdminTable
      v-model:page="page"
      :rows="list?.items ?? []"
      :columns="columns"
      :row-key="(row) => row.definition.id"
      :status="tableStatus"
      :total="list?.total ?? 0"
      :per-page="list?.perPage ?? 25"
      :filtered="search.trim() !== '' || statusFilter !== 'all'"
      :error-message="loadError || undefined"
      caption="Ventanas emergentes"
      empty-title="Todavía no hay ventanas emergentes"
      empty-description="Crea la primera para captar suscripciones o destacar una promoción."
      empty-icon="i-lucide-app-window"
      @retry="loadList"
      @clear-filters="clearFilters"
    >
      <template #toolbar>
        <AdminToolbar
          v-model:search="search"
          placeholder="Buscar por nombre o título…"
          search-label="Buscar ventanas emergentes"
        >
          <AdminFilters
            :model-value="statusFilter"
            :options="STATUS_OPTIONS"
            label="Filtrar por estado"
            data-testid="modal-status-filter"
            @update:model-value="setStatusFilter"
          />
        </AdminToolbar>
      </template>
      <template #cell-title="{ row }">
        <p class="font-semibold text-[var(--text-strong)]">{{ row.definition.title }}</p>
        <p class="adm-help">{{ row.definition.code }}</p>
      </template>
      <template #cell-status="{ row }">
        <AdminBadge :tone="statusTone(row.definition.status)">{{ statusLabel(row.definition.status) }}</AdminBadge>
        <AdminBadge v-if="row.definition.abVariant" tone="info" plain>Con variante B</AdminBadge>
      </template>
      <template #cell-trigger="{ row }">{{ triggerLabel(row) }}</template>
      <template #cell-conversions="{ row }">
        {{ row.stats.conversions }}
        <span v-if="row.stats.impressions" class="adm-help">
          ({{ Math.round((row.stats.conversions / row.stats.impressions) * 100) }} %)
        </span>
      </template>
      <template #actions="{ row }">
        <button
          type="button"
          :data-testid="`modal-inspect-${row.definition.id}`"
          class="adm-btn adm-btn--ghost adm-btn--sm"
          @click="inspect(row.definition.id)"
        >
          Historial
        </button>
        <button
          v-if="row.definition.status !== 'retired'"
          type="button"
          :data-testid="`modal-edit-${row.definition.id}`"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          @click="startEdit(row)"
        >
          Editar
        </button>
      </template>
      <template #empty-action>
        <AdminButton variant="primary" icon="i-lucide-plus" @click="startCreate">Nueva ventana</AdminButton>
      </template>
    </AdminTable>

    <AdminCard
      v-if="detail"
      :title="`Historial de «${detail.item.definition.title}»`"
      description="Cada cambio guardado, con su motivo."
      aria-label="Historial de auditoría"
      flush
    >
      <template #actions>
        <AdminButton size="sm" variant="ghost" icon="i-lucide-x" label="Cerrar historial" @click="detail = null" />
      </template>
      <ol class="adm-list">
        <li v-for="entry in detail.history" :key="`${entry.definition.version}-${entry.createdAt}`">
          <span class="adm-list__index">{{ entry.definition.version }}</span>
          <div class="min-w-0 flex-1">
            <p class="adm-list__title">{{ entry.reason }}</p>
            <p class="adm-help">{{ adminDate(entry.createdAt, true) }} · {{ statusLabel(entry.definition.status) }}</p>
          </div>
        </li>
      </ol>
    </AdminCard>

    <AdminCard
      title="Pausa entre ventanas"
      description="Después de cerrar una ventana o de aceptar su propuesta, el visitante no ve ninguna otra durante este tiempo."
    >
      <template #actions>
        <span class="adm-help">
          Ahora:
          <strong data-testid="modal-policy-current" class="text-[var(--text-strong)]"
            >{{ list?.policy.globalCooldownSeconds ?? '—' }} s</strong
          >
        </span>
      </template>
      <form class="grid gap-4 sm:grid-cols-[10rem_1fr_auto] sm:items-end" @submit.prevent="reviewPolicy">
        <AdminFormField v-slot="{ id }" label="Pausa (segundos)">
          <input
            :id="id"
            v-model="policyCooldown"
            type="number"
            min="60"
            max="604800"
            data-testid="modal-policy-cooldown"
            class="adm-input"
          />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Motivo del cambio">
          <input :id="id" v-model="policyReason" type="text" data-testid="modal-policy-reason" class="adm-input" />
        </AdminFormField>
        <button type="submit" class="adm-btn adm-btn--secondary">Revisar pausa</button>
      </form>
      <UAlert
        v-if="policyFrozen"
        class="mt-4"
        color="warning"
        variant="subtle"
        icon="i-lucide-clock"
        :title="`Se aplicará una pausa de ${policyFrozen.raw.globalCooldownSeconds} s`"
        :description="`Motivo: ${policyFrozen.raw.reason}`"
      >
        <template #actions>
          <button
            type="button"
            data-testid="modal-policy-confirm"
            class="adm-btn adm-btn--primary adm-btn--sm"
            :disabled="busy"
            @click="savePolicy"
          >
            Confirmar pausa
          </button>
        </template>
      </UAlert>
    </AdminCard>

    <AdminDrawer
      v-model:open="editorOpen"
      wide
      :title="editingVersion ? 'Editar ventana emergente' : 'Nueva ventana emergente'"
      :description="
        editingVersion
          ? `Versión ${editingVersion} → ${editingVersion + 1}`
          : 'Se guarda como borrador hasta que la publiques.'
      "
    >
      <div class="adm-stack">
        <UAlert
          v-if="formError"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="formError"
        />

        <div v-if="frozen" class="adm-card" data-testid="modal-frozen">
          <div class="adm-card__body">
            <p class="font-semibold text-[var(--text-strong)]">Revisa el cambio antes de guardarlo</p>
            <p class="adm-help mt-1">
              «{{ frozen.raw.definition.title }}» ({{ frozen.raw.definition.code }}), versión
              {{ frozen.raw.definition.version }}, estado {{ statusLabel(frozen.raw.definition.status) }}.
            </p>
            <p v-if="frozen.uncertain" class="adm-help mt-2">
              No sabemos si el cambio llegó a guardarse. Comprueba el resultado antes de volver a enviarlo.
            </p>
          </div>
        </div>

        <form v-show="!frozen" id="modal-editor-form" class="adm-stack" @submit.prevent="review">
          <AdminTabs v-model="editorTab" :tabs="EDITOR_TABS" label="Apartados de la ventana" />

          <div v-show="editorTab === 'content'" class="adm-form-grid">
            <AdminFormField
              v-slot="{ id }"
              label="Nombre interno"
              help="Identificador corto, sin espacios. No se puede cambiar después."
              required
            >
              <input
                :id="id"
                v-model="draft.code"
                data-testid="modal-code"
                :disabled="editingVersion > 0"
                class="adm-input"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Estado">
              <select :id="id" v-model="draft.status" data-testid="modal-status" class="adm-input">
                <option value="draft">Borrador</option>
                <option value="published">Publicada</option>
                <option value="retired">Retirada</option>
              </select>
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Título" class="col-span-full" required>
              <input :id="id" v-model="draft.title" data-testid="modal-title" class="adm-input" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Texto" help="Texto sin formato." class="col-span-full" required>
              <textarea :id="id" v-model="draft.body" data-testid="modal-body" rows="3" class="adm-input" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Texto del botón" required>
              <input :id="id" v-model="draft.ctaLabel" data-testid="modal-cta-label" class="adm-input" />
            </AdminFormField>
            <AdminFormField
              v-slot="{ id }"
              label="Página a la que lleva el botón"
              help="Ruta de la tienda, por ejemplo /contacto."
              required
            >
              <input :id="id" v-model="draft.ctaPath" data-testid="modal-cta-path" class="adm-input" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Objetivo">
              <select :id="id" v-model="draft.objective" data-testid="modal-objective" class="adm-input">
                <option value="newsletter_subscription">Suscripción al boletín</option>
                <option value="professional_lead">Captación profesional</option>
                <option value="catalog_discovery">Descubrimiento de catálogo</option>
                <option value="promotion_redemption">Canje de promoción</option>
                <option value="support_guidance">Orientación de soporte</option>
              </select>
            </AdminFormField>
          </div>

          <div v-show="editorTab === 'display'" class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Cuándo aparece">
              <select :id="id" v-model="draft.triggerKind" data-testid="modal-trigger-kind" class="adm-input">
                <option value="time_on_page">Tras un tiempo en la página (segundos)</option>
                <option value="scroll_depth">Al bajar por la página (%)</option>
                <option value="exit_intent">Al ir a salir, solo en ordenador (segundos mínimos)</option>
                <option value="page_views">Tras ver varias páginas</option>
              </select>
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Valor">
              <input
                :id="id"
                v-model="draft.triggerValue"
                type="number"
                data-testid="modal-trigger-value"
                class="adm-input"
              />
            </AdminFormField>
            <fieldset class="adm-field col-span-full">
              <legend class="adm-label">A quién se muestra</legend>
              <div class="flex flex-wrap gap-x-5 gap-y-2">
                <label class="adm-check">
                  <input v-model="draft.segments" type="checkbox" value="anonymous" /> Visitantes sin cuenta
                </label>
                <label class="adm-check">
                  <input v-model="draft.segments" type="checkbox" value="customer" /> Clientes
                </label>
                <label class="adm-check">
                  <input v-model="draft.segments" type="checkbox" value="professional" /> Profesionales
                </label>
              </div>
              <select
                v-model="draft.marketingConsent"
                data-testid="modal-consent"
                aria-label="Consentimiento de publicidad"
                class="adm-input mt-2"
              >
                <option value="any">Con o sin consentimiento de publicidad</option>
                <option value="with_consent">Solo con consentimiento de publicidad</option>
                <option value="without_consent">Solo sin consentimiento de publicidad</option>
              </select>
            </fieldset>
            <AdminFormField
              v-slot="{ id }"
              label="Páginas donde aparece"
              help="Comienzo de la ruta, separados por comas: /catalogo, /producto."
            >
              <input :id="id" v-model="draft.includePrefixes" data-testid="modal-include" class="adm-input" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Páginas donde no aparece" help="Separadas por comas. Opcional.">
              <input :id="id" v-model="draft.excludePrefixes" data-testid="modal-exclude" class="adm-input" />
            </AdminFormField>
          </div>

          <div v-show="editorTab === 'limits'" class="adm-form-grid">
            <AdminFormField
              v-slot="{ id }"
              label="Prioridad"
              help="De 0 a 1000. Si coinciden varias, gana la más alta."
            >
              <input :id="id" v-model="draft.priority" type="number" data-testid="modal-priority" class="adm-input" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Nivel de prioridad">
              <select :id="id" v-model="draft.priorityTier" data-testid="modal-priority-tier" class="adm-input">
                <option value="normal">Normal</option>
                <option value="high">Alta</option>
                <option value="critical">Crítica (se muestra aunque se haya alcanzado el límite de la visita)</option>
              </select>
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Veces máximas por visitante">
              <input
                :id="id"
                v-model="draft.maxImpressions"
                type="number"
                min="1"
                max="50"
                data-testid="modal-max-impressions"
                class="adm-input"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Periodo del límite (segundos)" help="86400 equivale a un día.">
              <input
                :id="id"
                v-model="draft.windowSeconds"
                type="number"
                min="60"
                data-testid="modal-window"
                class="adm-input"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Empieza">
              <input
                :id="id"
                v-model="draft.startsAt"
                type="datetime-local"
                data-testid="modal-starts-at"
                class="adm-input"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Termina" help="Opcional.">
              <input
                :id="id"
                v-model="draft.endsAt"
                type="datetime-local"
                data-testid="modal-ends-at"
                class="adm-input"
              />
            </AdminFormField>
          </div>

          <AdminFormField
            v-slot="{ id }"
            label="Motivo del cambio"
            help="Queda guardado en el historial de la ventana."
            required
          >
            <input :id="id" v-model="draft.reason" data-testid="modal-reason" class="adm-input" />
          </AdminFormField>
        </form>
      </div>

      <template #footer>
        <template v-if="frozen">
          <button type="button" class="adm-btn adm-btn--secondary" @click="cancelReview">Volver al formulario</button>
          <button
            v-if="frozen.uncertain && !frozen.absent"
            type="button"
            data-testid="modal-verify-receipt"
            :disabled="busy"
            class="adm-btn adm-btn--primary"
            @click="verifyReceipt"
          >
            Comprobar resultado
          </button>
          <button
            v-if="frozen.uncertain && frozen.absent"
            type="button"
            data-testid="modal-replay"
            :disabled="busy"
            class="adm-btn adm-btn--primary"
            @click="confirmWrite(true)"
          >
            Volver a enviar el mismo cambio
          </button>
          <button
            v-if="!frozen.uncertain"
            type="button"
            data-testid="modal-confirm"
            :disabled="busy"
            class="adm-btn adm-btn--primary"
            @click="confirmWrite(false)"
          >
            Confirmar y guardar
          </button>
        </template>
        <template v-else>
          <button type="button" class="adm-btn adm-btn--secondary" @click="closeEditor">Cancelar</button>
          <button type="submit" form="modal-editor-form" data-testid="modal-review" class="adm-btn adm-btn--primary">
            Revisar cambios
          </button>
        </template>
      </template>
    </AdminDrawer>
  </div>
</template>
