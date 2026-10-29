<script setup lang="ts">
import { useAdminNavigation } from '../composables/useAdminNavigation'
import { supportUuid } from '~~/shared/support-operations'
import { parseCatalogCsvCells } from '~~/shared/catalog-tabular-core'
import {
  ADMIN_AUDIT_FAMILIES,
  ADMIN_AUDIT_EXPORT_COLUMNS,
  ADMIN_AUDIT_EXPORT_FILENAME,
  ADMIN_AUDIT_EXPORT_CONTENT_TYPE,
  ADMIN_AUDIT_EXPORT_MAX_BYTES,
  ADMIN_AUDIT_EXPORT_HEADERS,
  adminAuditFiltersSchema,
  adminAuditQuerySchema,
  adminAuditListSchema,
  adminAuditDetailSchema,
  adminAuditReviewInputSchema,
  adminAuditExportInputSchema,
  adminAuditReceiptSchema,
  adminAuditCommandSchema,
  adminAuditIntentHash,
  adminAuditFilterHash,
  adminAuditHash,
  type AdminAuditList,
  type AdminAuditDetail,
  type AdminAuditItem,
  type AdminAuditReceipt,
  type AdminAuditReviewInput,
  type AdminAuditExportInput,
  type AdminAuditFamily
} from '~~/shared/admin-audit'
const props = defineProps<{ scopeKey: string; enabled: boolean; pending?: boolean }>()
const emit = defineEmits<{ pending: [boolean]; confirmed: [AdminAuditReceipt] }>()
const auth = useUserSession(),
  navigation = useAdminNavigation(),
  request = useRequestFetch(),
  runtime = useRuntimeConfig(),
  prefix = useId()
const owner = computed(() => {
  const identity = auth.user.value?.id,
    sid = auth.session.value?.sessionId,
    version = auth.session.value?.sessionVersion,
    caps = navigation.capabilities.value
  if (
    runtime.public.serverRuntime !== 'cloudflare' ||
    !props.enabled ||
    !props.scopeKey ||
    props.scopeKey.length > 1000 ||
    !auth.ready.value ||
    !auth.loggedIn.value ||
    auth.user.value?.emailVerified !== true ||
    auth.user.value?.mfaVerified !== true ||
    !supportUuid.safeParse(identity).success ||
    !supportUuid.safeParse(sid).success ||
    !Number.isSafeInteger(version) ||
    Number(version) < 1 ||
    navigation.status.value !== 'ready' ||
    caps?.state !== 'ready' ||
    caps.identityId !== identity ||
    caps.sessionId !== sid ||
    caps.sessionVersion !== version ||
    !caps.permissions.includes('administration.manage')
  )
    return null
  return JSON.stringify([props.scopeKey, identity, sid, version])
})
type Filters = ReturnType<typeof adminAuditFiltersSchema.parse>
type ExportReceipt = Extract<AdminAuditReceipt, { action: 'export' }>
type Intent = { owner: string; actorId: string; key: string; hash: string; attempted: boolean } & (
  | { action: 'review'; targetId: string; body: AdminAuditReviewInput }
  | { action: 'export'; targetId: null; body: AdminAuditExportInput; filterHash: string }
)
const endpoint = '/api/admin/audit'
const filters = reactive({ family: '', actorId: '', resourceId: '', from: '', to: '' }),
  appliedFilters = shallowRef<Filters | null>(null),
  snapshot = shallowRef<AdminAuditList | null>(null),
  detail = shallowRef<AdminAuditDetail | null>(null),
  intent = shallowRef<Intent | null>(null),
  exportReceipt = shallowRef<ExportReceipt | null>(null),
  exportFilters = shallowRef<Filters | null>(null),
  reviewReason = ref(''),
  exportReason = ref(''),
  disposition = ref<'reviewed' | 'follow_up'>('reviewed'),
  busy = ref(false),
  blocked = ref<string | null>(null),
  message = ref(''),
  phase = ref<'idle' | 'review' | 'unknown' | 'confirmed' | 'error'>('idle'),
  downloadStatus = ref<'idle' | 'done' | 'error'>('idle')
const familyLabels: Record<AdminAuditFamily, string> = {
  catalog_metadata: 'Metadatos de catálogo',
  catalog_status: 'Estado de catálogo',
  catalog_policy: 'Políticas de catálogo',
  catalog_authoring: 'Edición de catálogo',
  catalog_price: 'Precios',
  catalog_category: 'Familias',
  catalog_editorial: 'Contenido de catálogo',
  catalog_native: 'Catálogo nativo',
  catalog_import: 'Importaciones de catálogo',
  catalog_attributes: 'Atributos',
  search_synonym: 'Sinónimos',
  catalog_relation: 'Relaciones de productos',
  media_rights: 'Derechos de archivos',
  media_publication: 'Publicación de archivos',
  media_withdrawal: 'Retirada de archivos',
  cms_draft: 'Borradores de contenido',
  cms_publication: 'Publicación de contenido',
  inventory: 'Inventario',
  fulfillment: 'Preparación y entrega',
  returns: 'Devoluciones',
  cancellation: 'Cancelaciones',
  order_annotation: 'Anotaciones de pedidos',
  order_packing: 'Bultos y expedición',
  inventory_alert: 'Alertas de inventario',
  inventory_count_import: 'Importación de recuentos',
  shipping_calendar: 'Calendarios de envío',
  fiscal: 'Documentos fiscales',
  financial: 'Operaciones económicas',
  support: 'Soporte',
  support_macro: 'Respuestas de soporte',
  support_escalation: 'Escalados de soporte',
  newsletter_editorial: 'Contenido de newsletter',
  company_review: 'Revisión profesional',
  promotion: 'Promociones',
  communication_history: 'Historial de comunicaciones',
  admin_invitation: 'Invitaciones administrativas',
  admin_bootstrap: 'Alta inicial de administración',
  admin_audit: 'Revisión de auditoría'
}
const fieldLabels = {
  version: 'Versión',
  quantity: 'Cantidad',
  physicalQuantity: 'Cantidad física',
  threshold: 'Umbral',
  grossCents: 'Importe bruto (céntimos)',
  netCents: 'Importe neto (céntimos)',
  labelCount: 'Número de etiquetas',
  noteCount: 'Número de notas',
  permissionCount: 'Número de permisos',
  state: 'Estado',
  status: 'Estado',
  roleCode: 'Rol',
  active: 'Activo'
}
let alive = true,
  epoch = 0,
  pendingCommand = false
const controllers = new Set<AbortController>()
type Download = { controller: AbortController; bytes: Uint8Array<ArrayBuffer> | null; url: string | null }
let activeDownload: Download | null = null
const allowed = computed(() => !!owner.value && blocked.value !== owner.value)
function setCommandPending(value: boolean) {
  if (pendingCommand !== value) {
    pendingCommand = value
    emit('pending', value)
  }
}
function discardDownload(value: Download) {
  value.controller.abort()
  value.bytes?.fill(0)
  value.bytes = null
  if (value.url !== null) URL.revokeObjectURL(value.url)
  value.url = null
}
function reset() {
  epoch++
  controllers.forEach((item) => item.abort())
  controllers.clear()
  if (activeDownload) discardDownload(activeDownload)
  activeDownload = null
  snapshot.value = null
  detail.value = null
  intent.value = null
  appliedFilters.value = null
  exportReceipt.value = null
  exportFilters.value = null
  reviewReason.value = ''
  exportReason.value = ''
  disposition.value = 'reviewed'
  for (const key of Object.keys(filters) as Array<keyof typeof filters>) filters[key] = ''
  busy.value = false
  phase.value = 'idle'
  message.value = ''
  downloadStatus.value = 'idle'
  setCommandPending(false)
}
function live(turn: number, actor: string) {
  return alive && epoch === turn && allowed.value && owner.value === actor
}
function controller() {
  const value = new AbortController()
  controllers.add(value)
  return value
}
function denied(cause: unknown, actor: string) {
  const error = cause as { statusCode?: number; status?: number; response?: { status?: number } }
  if (![401, 403].includes(error?.statusCode ?? error?.status ?? error?.response?.status ?? 0)) return false
  reset()
  blocked.value = actor
  message.value = 'La autorización ha cambiado. Los datos privados se han borrado.'
  return true
}
function utc(value: string) {
  return `${value.slice(0, 10)} ${value.slice(11, 19)} UTC`
}
function display(value: string | number | boolean | null) {
  return value === null ? 'No registrado' : typeof value === 'boolean' ? (value ? 'Sí' : 'No') : String(value)
}
function redaction(value: 'redacted' | 'unknown') {
  return value === 'redacted' ? 'Redactado' : 'No registrado'
}
function draftFilters() {
  return adminAuditFiltersSchema.parse({
    ...(filters.family ? { family: filters.family } : {}),
    ...(filters.actorId.trim() ? { actorId: filters.actorId.trim() } : {}),
    ...(filters.resourceId.trim() ? { resourceId: filters.resourceId.trim() } : {}),
    ...(filters.from.trim() ? { from: filters.from.trim() } : {}),
    ...(filters.to.trim() ? { to: filters.to.trim() } : {})
  })
}
async function load(cursor?: string) {
  const actor = owner.value
  if (!actor || !allowed.value || busy.value || props.pending || intent.value) return
  let selected: Filters
  try {
    selected = cursor ? adminAuditFiltersSchema.parse(appliedFilters.value) : draftFilters()
  } catch {
    message.value = 'Revisa filtros, identificadores y fechas UTC completas (AAAA-MM-DDTHH:mm:ssZ).'
    return
  }
  const query = adminAuditQuerySchema.safeParse({ ...selected, limit: 25, ...(cursor ? { cursor } : {}) })
  if (!query.success) {
    message.value = 'No se pudo validar la página solicitada.'
    return
  }
  const turn = epoch,
    abort = controller()
  busy.value = true
  message.value = ''
  detail.value = null
  exportReceipt.value = null
  exportFilters.value = null
  downloadStatus.value = 'idle'
  try {
    const value = adminAuditListSchema.parse(
      await request<unknown>(endpoint, {
        method: 'GET',
        query: query.data,
        retry: 0,
        cache: 'no-store',
        signal: abort.signal
      })
    )
    if (new Set(value.items.map((item) => item.id)).size !== value.items.length) throw Error('list_mismatch')
    if (live(turn, actor)) {
      snapshot.value = value
      appliedFilters.value = selected
      phase.value = 'idle'
    }
  } catch (cause) {
    if (live(turn, actor) && !denied(cause, actor)) {
      snapshot.value = null
      phase.value = 'error'
      message.value = 'No se pudo leer la auditoría. No se ha supuesto una lista vacía.'
    }
  } finally {
    controllers.delete(abort)
    if (live(turn, actor)) busy.value = false
  }
}
async function readDetail(id: string, turn: number, actor: string, abort: AbortController) {
  const value = adminAuditDetailSchema.parse(
    await request<unknown>(`${endpoint}/${encodeURIComponent(id)}`, {
      method: 'GET',
      retry: 0,
      cache: 'no-store',
      signal: abort.signal
    })
  )
  if (value.item.id !== id || new Set(value.reviews.map((item) => item.commandId)).size !== value.reviews.length)
    throw Error('detail_mismatch')
  if (!live(turn, actor)) throw Error('scope_changed')
  return value
}
async function open(item: AdminAuditItem) {
  const actor = owner.value
  if (
    !actor ||
    !allowed.value ||
    busy.value ||
    props.pending ||
    intent.value ||
    !snapshot.value?.items.some((row) => row.id === item.id)
  )
    return
  const turn = epoch,
    abort = controller()
  busy.value = true
  detail.value = null
  reviewReason.value = ''
  message.value = ''
  phase.value = 'idle'
  try {
    const value = await readDetail(item.id, turn, actor, abort)
    if (live(turn, actor)) detail.value = value
  } catch (cause) {
    if (live(turn, actor) && !denied(cause, actor)) {
      phase.value = 'error'
      message.value = 'No se pudo verificar el detalle redactado.'
    }
  } finally {
    controllers.delete(abort)
    if (live(turn, actor)) busy.value = false
  }
}
async function review() {
  const actor = owner.value,
    current = detail.value
  if (!actor || !allowed.value || !current || busy.value || props.pending || intent.value) return
  const input = adminAuditReviewInputSchema.safeParse({
    expectedVersion: current.item.reviewVersion,
    disposition: disposition.value,
    reason: reviewReason.value
  })
  if (!input.success) {
    message.value = 'Revisa la decisión y el motivo privado (10–500 caracteres).'
    return
  }
  const turn = epoch
  busy.value = true
  exportReceipt.value = null
  exportFilters.value = null
  try {
    const hash = await adminAuditIntentHash('review', current.item.id, input.data)
    if (live(turn, actor)) {
      intent.value = {
        owner: actor,
        actorId: supportUuid.parse(auth.user.value?.id),
        key: crypto.randomUUID(),
        hash,
        attempted: false,
        action: 'review',
        targetId: current.item.id,
        body: input.data
      }
      phase.value = 'review'
      message.value = 'Revisa la decisión. Sólo se añadirá una revisión; el registro original no se modifica.'
      setCommandPending(true)
    }
  } catch {
    if (live(turn, actor)) message.value = 'No se pudo preparar la revisión. No se ha enviado ningún cambio.'
  } finally {
    if (live(turn, actor)) busy.value = false
  }
}
async function reviewExport() {
  const actor = owner.value
  if (
    !actor ||
    !allowed.value ||
    !snapshot.value ||
    !appliedFilters.value ||
    busy.value ||
    props.pending ||
    intent.value
  )
    return
  const input = adminAuditExportInputSchema.safeParse({ filters: appliedFilters.value, reason: exportReason.value })
  if (!input.success) {
    message.value = 'Explica el motivo de exportación (10–500 caracteres).'
    return
  }
  const turn = epoch
  busy.value = true
  exportReceipt.value = null
  exportFilters.value = null
  downloadStatus.value = 'idle'
  try {
    const hash = await adminAuditIntentHash('export', null, input.data),
      filterHash = await adminAuditFilterHash(input.data.filters)
    if (live(turn, actor)) {
      intent.value = {
        owner: actor,
        actorId: supportUuid.parse(auth.user.value?.id),
        key: crypto.randomUUID(),
        hash,
        attempted: false,
        action: 'export',
        targetId: null,
        body: input.data,
        filterHash
      }
      phase.value = 'review'
      message.value =
        'Revisa la exportación privada de los filtros aplicados, no sólo de la página visible. No se ha descargado nada.'
      setCommandPending(true)
    }
  } catch {
    if (live(turn, actor)) message.value = 'No se pudo preparar la exportación. No se ha enviado ningún cambio.'
  } finally {
    if (live(turn, actor)) busy.value = false
  }
}
async function command(expected: Intent, turn: number, abort: AbortController) {
  const value = adminAuditCommandSchema.parse(
    await request<unknown>(`${endpoint}/commands/${expected.key}`, {
      method: 'GET',
      query: { payloadHash: expected.hash },
      retry: 0,
      cache: 'no-store',
      signal: abort.signal
    })
  )
  if (!live(turn, expected.owner)) throw Error('scope_changed')
  return value
}
async function acknowledge(
  raw: unknown,
  expected: Intent,
  turn: number,
  abort: AbortController,
  verifiedCommand = false
) {
  const receipt = adminAuditReceiptSchema.parse(raw)
  if (receipt.commandId !== expected.key || receipt.payloadHash !== expected.hash || receipt.action !== expected.action)
    throw Error('receipt_mismatch')
  if (!live(turn, expected.owner) || intent.value?.key !== expected.key) return
  if (expected.action === 'review') {
    if (
      receipt.action !== 'review' ||
      receipt.eventId !== expected.targetId ||
      receipt.version !== expected.body.expectedVersion + 1 ||
      receipt.disposition !== expected.body.disposition
    )
      throw Error('receipt_mismatch')
    const value = await readDetail(expected.targetId, turn, expected.owner, abort)
    if (
      value.item.reviewVersion < receipt.version ||
      (value.item.reviewVersion === receipt.version && value.item.disposition !== receipt.disposition) ||
      !value.reviews.some(
        (row) =>
          row.commandId === expected.key &&
          row.actorId === expected.actorId &&
          row.version === receipt.version &&
          row.disposition === receipt.disposition &&
          row.recordedAt === receipt.recordedAt
      )
    )
      throw Error('review_unconfirmed')
    if (!live(turn, expected.owner)) return
    detail.value = value
    if (snapshot.value)
      snapshot.value = {
        ...snapshot.value,
        items: snapshot.value.items.map((item) => (item.id === value.item.id ? value.item : item))
      }
  } else {
    if (receipt.action !== 'export' || receipt.filterHash !== expected.filterHash) throw Error('receipt_mismatch')
    if (!verifiedCommand) {
      const result = await command(expected, turn, abort)
      if (result.outcome !== 'applied' || JSON.stringify(result.receipt) !== JSON.stringify(receipt))
        throw Error('export_unconfirmed')
    }
    if (!live(turn, expected.owner)) return
    exportReceipt.value = receipt
    exportFilters.value = expected.body.filters
  }
  if (!live(turn, expected.owner) || intent.value?.key !== expected.key) return
  intent.value = null
  reviewReason.value = ''
  exportReason.value = ''
  phase.value = 'confirmed'
  setCommandPending(false)
  message.value =
    receipt.action === 'review'
      ? 'Revisión añadida y verificada; el registro original permanece intacto.'
      : 'Exportación registrada y verificada. Descarga el CSV explícitamente antes de su caducidad.'
  emit('confirmed', receipt)
}
async function send() {
  const expected = intent.value
  if (
    !expected ||
    !allowed.value ||
    owner.value !== expected.owner ||
    busy.value ||
    props.pending ||
    expected.attempted
  )
    return
  const turn = epoch,
    abort = controller()
  expected.attempted = true
  busy.value = true
  try {
    const value = await request<unknown>(
      expected.action === 'review'
        ? `${endpoint}/${encodeURIComponent(expected.targetId)}/reviews`
        : `${endpoint}/exports`,
      {
        method: 'POST',
        body: expected.body,
        headers: { 'Idempotency-Key': expected.key },
        retry: 0,
        signal: abort.signal
      }
    )
    await acknowledge(value, expected, turn, abort)
  } catch (cause) {
    if (live(turn, expected.owner) && !denied(cause, expected.owner)) {
      phase.value = 'unknown'
      message.value = 'Resultado sin confirmar. Consulta el recibo; no se repetirá el cambio automáticamente.'
    }
  } finally {
    controllers.delete(abort)
    if (live(turn, expected.owner)) busy.value = false
  }
}
async function check() {
  const expected = intent.value
  if (!expected?.attempted || !allowed.value || busy.value || props.pending) return
  const turn = epoch,
    abort = controller()
  busy.value = true
  try {
    const result = await command(expected, turn, abort)
    if (result.outcome === 'unknown') {
      if (live(turn, expected.owner))
        message.value = 'No hay un recibo confirmado de esta intención. El resultado sigue sin confirmar.'
      return
    }
    await acknowledge(result.receipt, expected, turn, abort, true)
  } catch (cause) {
    if (live(turn, expected.owner) && !denied(cause, expected.owner)) {
      phase.value = 'unknown'
      message.value = 'No se pudo verificar el recibo y su resultado vigente.'
    }
  } finally {
    controllers.delete(abort)
    if (live(turn, expected.owner)) busy.value = false
  }
}
function cancel() {
  if (busy.value || intent.value?.attempted) return
  intent.value = null
  phase.value = 'idle'
  message.value = ''
  setCommandPending(false)
}
function integerHeader(headers: Headers, name: string) {
  const value = headers.get(name) ?? ''
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw Error('export_unconfirmed')
  return Number(value)
}
async function download() {
  const actor = owner.value,
    receipt = exportReceipt.value
  if (!actor || !allowed.value || !receipt || busy.value || props.pending || intent.value) return
  const turn = epoch,
    read: Download = { controller: controller(), bytes: null, url: null }
  activeDownload = read
  busy.value = true
  downloadStatus.value = 'idle'
  try {
    if (Date.parse(receipt.expiresAt) <= Date.now()) throw Error('export_expired')
    const response = await (request as typeof $fetch).raw<ArrayBuffer>(
      `${endpoint}/exports/${receipt.commandId}/download`,
      {
        method: 'GET',
        responseType: 'arrayBuffer',
        retry: 0,
        cache: 'no-store',
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
        signal: read.controller.signal
      }
    )
    const raw: unknown =
      response && typeof response === 'object' ? Object.getOwnPropertyDescriptor(response, '_data')?.value : undefined
    if (!live(turn, actor)) {
      if (raw instanceof ArrayBuffer) new Uint8Array(raw).fill(0)
      return
    }
    if (!(raw instanceof ArrayBuffer)) throw Error('export_unconfirmed')
    const received = new Uint8Array(raw)
    try {
      if (
        received.byteLength !== receipt.bytes ||
        received.byteLength > ADMIN_AUDIT_EXPORT_MAX_BYTES ||
        received.byteLength < 1
      )
        throw Error('export_unconfirmed')
      read.bytes = received.slice()
    } finally {
      received.fill(0)
    }
    const headers = response.headers,
      cache = headers.get('cache-control') ?? ''
    if (
      response.ok !== true ||
      response.status !== 200 ||
      headers.get('content-type')?.toLowerCase() !== ADMIN_AUDIT_EXPORT_CONTENT_TYPE ||
      headers.get('content-disposition') !== `attachment; filename="${ADMIN_AUDIT_EXPORT_FILENAME}"` ||
      !/\bprivate\b/i.test(cache) ||
      !/\bno-store\b/i.test(cache) ||
      /\bpublic\b/i.test(cache) ||
      headers.get(ADMIN_AUDIT_EXPORT_HEADERS.source) !== 'cloudflare' ||
      headers.get(ADMIN_AUDIT_EXPORT_HEADERS.digest) !== receipt.digest ||
      integerHeader(headers, ADMIN_AUDIT_EXPORT_HEADERS.rows) !== receipt.rows ||
      integerHeader(headers, ADMIN_AUDIT_EXPORT_HEADERS.bytes) !== receipt.bytes
    )
      throw Error('export_unconfirmed')
    const bytes = read.bytes
    if (bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf) throw Error('export_unconfirmed')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (!text.endsWith('\r\n') || /(^|[^\r])\n/.test(text) || (await adminAuditHash(text)) !== receipt.digest)
      throw Error('export_unconfirmed')
    const rows = parseCatalogCsvCells(text.slice(1), {
      maxRows: 1001,
      maxColumns: ADMIN_AUDIT_EXPORT_COLUMNS.length,
      maxCellCharacters: 4096
    })
    if (
      rows.length !== receipt.rows + 1 ||
      JSON.stringify(rows[0]) !== JSON.stringify(ADMIN_AUDIT_EXPORT_COLUMNS) ||
      rows.some((row) => row.length !== ADMIN_AUDIT_EXPORT_COLUMNS.length)
    )
      throw Error('export_unconfirmed')
    if (!live(turn, actor) || exportReceipt.value?.commandId !== receipt.commandId) return
    read.url = URL.createObjectURL(new Blob([bytes.buffer], { type: ADMIN_AUDIT_EXPORT_CONTENT_TYPE }))
    if (!live(turn, actor)) return
    const link = document.createElement('a')
    link.href = read.url
    link.download = ADMIN_AUDIT_EXPORT_FILENAME
    link.referrerPolicy = 'no-referrer'
    document.body.appendChild(link)
    try {
      link.click()
    } finally {
      link.remove()
    }
    if (live(turn, actor)) downloadStatus.value = 'done'
  } catch (cause) {
    if (live(turn, actor) && !denied(cause, actor)) downloadStatus.value = 'error'
  } finally {
    discardDownload(read)
    controllers.delete(read.controller)
    if (activeDownload === read) activeDownload = null
    if (live(turn, actor)) busy.value = false
  }
}
watch(
  owner,
  () => {
    reset()
    blocked.value = null
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  reset()
})
</script>
<template>
  <section aria-label="Auditoría administrativa" class="min-w-0 max-w-full space-y-4 rounded-xl border bg-white p-4">
    <h2 class="text-lg font-semibold">Auditoría administrativa</h2>
    <p class="text-sm">
      Consulta privada de registros normalizados. La revisión se añade sin alterar el evento original. Motivos y datos
      sensibles permanecen redactados.
    </p>
    <p v-if="!allowed" role="status">Se requiere sesión vigente, correo verificado, MFA y permiso de administración.</p>
    <template v-else>
      <p
        v-if="message"
        :data-audit-confirmed="phase === 'confirmed' ? '' : undefined"
        :role="phase === 'unknown' || phase === 'error' ? 'alert' : 'status'"
      >
        {{ message }}
      </p>
      <fieldset :disabled="busy || pending || !!intent" class="grid gap-3 sm:grid-cols-2">
        <label :for="`${prefix}-family`"
          >Fuente<select
            :id="`${prefix}-family`"
            v-model="filters.family"
            data-audit-family
            class="block w-full rounded border p-2"
          >
            <option value="">Todas las fuentes incluidas</option>
            <option v-for="family in ADMIN_AUDIT_FAMILIES" :key="family" :value="family">
              {{ familyLabels[family] }}
            </option>
          </select></label
        >
        <label :for="`${prefix}-actor`"
          >Identificador de actor (UUID)<input
            :id="`${prefix}-actor`"
            v-model="filters.actorId"
            data-audit-actor
            autocomplete="off"
            maxlength="36"
            class="block w-full rounded border p-2"
        /></label>
        <label :for="`${prefix}-resource`"
          >Identificador de recurso<input
            :id="`${prefix}-resource`"
            v-model="filters.resourceId"
            data-audit-resource
            autocomplete="off"
            maxlength="160"
            class="block w-full rounded border p-2"
        /></label>
        <label :for="`${prefix}-from`"
          >Desde (UTC)<input
            :id="`${prefix}-from`"
            v-model="filters.from"
            data-audit-from
            placeholder="2026-10-09T00:00:00Z"
            maxlength="20"
            class="block w-full rounded border p-2"
        /></label>
        <label :for="`${prefix}-to`"
          >Hasta (UTC)<input
            :id="`${prefix}-to`"
            v-model="filters.to"
            data-audit-to
            placeholder="2026-10-09T23:59:59Z"
            maxlength="20"
            class="block w-full rounded border p-2"
        /></label>
        <button data-audit-load type="button" class="rounded border px-3 py-2" @click="load()">
          Aplicar filtros y leer auditoría
        </button>
      </fieldset>
      <template v-if="snapshot">
        <p class="break-words text-sm">
          Fuentes incluidas: {{ snapshot.coverage.families.map((family) => familyLabels[family]).join(', ') }}. IP y
          sesión históricas sólo cuando se registraron; su ausencia no se reconstruye.
        </p>
        <p class="text-sm">
          No incluye autoservicio de clientes, eventos automáticos de proveedores ni logs de aplicación. Filtros
          aplicados: {{ appliedFilters?.family ? familyLabels[appliedFilters.family] : 'Todas las fuentes' }} ·
          {{ appliedFilters?.resourceId || 'Todos los recursos' }}.
        </p>
        <ol data-audit-list class="min-w-0 space-y-3">
          <li v-for="item in snapshot.items" :key="item.id" class="min-w-0 break-words rounded border p-3">
            <p>{{ familyLabels[item.family] }} · {{ item.action }} · recurso {{ item.resourceId }}</p>
            <time :datetime="item.createdAt">{{ utc(item.createdAt) }}</time>
            <p>
              Actor: {{ display(item.actorId) }} · revisión {{ item.reviewVersion }} ·
              {{ item.disposition || 'Sin revisar' }}
            </p>
            <button
              :data-audit-open="item.id"
              type="button"
              :disabled="busy || pending || !!intent"
              class="rounded border px-3 py-2"
              @click="open(item)"
            >
              Ver detalle redactado
            </button>
          </li>
        </ol>
        <p v-if="!snapshot.items.length" role="status">Sin registros para los filtros aplicados y tu acceso vigente.</p>
        <button
          v-if="snapshot.nextCursor"
          data-audit-next
          type="button"
          :disabled="busy || pending || !!intent"
          class="rounded border px-3 py-2"
          @click="load(snapshot.nextCursor)"
        >
          Página siguiente (máximo 25 registros)
        </button>
        <form class="space-y-3 rounded border p-3" @submit.prevent="reviewExport">
          <p>
            Exportar los filtros aplicados, no sólo esta página: máximo 1000 filas y 2 MB; no se truncan resultados. CSV
            de metadatos redactados, no detalle completo. Caduca a las 24 horas.
          </p>
          <label :for="`${prefix}-export-reason`"
            >Motivo privado de exportación<textarea
              :id="`${prefix}-export-reason`"
              v-model="exportReason"
              data-audit-export-reason
              :disabled="busy || pending || !!intent"
              minlength="10"
              maxlength="500"
              class="block w-full rounded border p-2"
            />
          </label>
          <button
            data-audit-export-review
            type="submit"
            :disabled="busy || pending || !!intent"
            class="rounded border px-3 py-2"
          >
            Revisar exportación privada
          </button>
        </form>
      </template>
      <div v-if="detail" data-audit-detail class="min-w-0 space-y-3 rounded border p-3 [overflow-wrap:anywhere]">
        <h3 class="font-semibold">Detalle redactado · {{ familyLabels[detail.item.family] }}</h3>
        <dl class="space-y-1">
          <dt>Recurso</dt>
          <dd>{{ detail.item.resourceId }}</dd>
          <dt>Actor</dt>
          <dd>{{ display(detail.item.actorId) }}</dd>
          <dt>Comando</dt>
          <dd>{{ display(detail.item.commandId) }}</dd>
          <dt>Sesión</dt>
          <dd>{{ display(detail.item.sessionId) }}</dd>
          <dt>Hash de IP (no dirección IP)</dt>
          <dd>{{ display(detail.item.ipHash) }}</dd>
          <dt>Motivo original</dt>
          <dd>{{ redaction(detail.item.reason) }}</dd>
          <dt>Antes / después sensibles</dt>
          <dd>{{ redaction(detail.item.before) }} / {{ redaction(detail.item.after) }}</dd>
        </dl>
        <template v-if="detail.changesAvailability === 'recorded'">
          <h4>Cambios permitidos registrados</h4>
          <ul>
            <li v-for="(change, index) in detail.changes" :key="index">
              {{ fieldLabels[change.field] }}: {{ display(change.before) }} → {{ display(change.after) }}
            </li>
          </ul>
        </template>
        <p v-else>
          {{
            detail.changesAvailability === 'redacted'
              ? 'Cambios redactados.'
              : 'Cambios no registrados o no disponibles; no se reconstruyen.'
          }}
        </p>
        <ol>
          <li v-for="row in detail.reviews" :key="row.commandId">
            Revisión {{ row.version }} · {{ row.disposition }} · {{ utc(row.recordedAt) }} · motivo redactado.
          </li>
        </ol>
        <form class="space-y-3" @submit.prevent="review">
          <label :for="`${prefix}-disposition`"
            >Decisión<select
              :id="`${prefix}-disposition`"
              v-model="disposition"
              data-audit-disposition
              :disabled="busy || pending || !!intent"
              class="block w-full rounded border p-2"
            >
              <option value="reviewed">Revisado</option>
              <option value="follow_up">Requiere seguimiento</option>
            </select></label
          >
          <label :for="`${prefix}-review-reason`"
            >Motivo privado de revisión<textarea
              :id="`${prefix}-review-reason`"
              v-model="reviewReason"
              data-audit-review-reason
              :disabled="busy || pending || !!intent"
              minlength="10"
              maxlength="500"
              class="block w-full rounded border p-2"
            />
          </label>
          <button
            data-audit-review
            type="submit"
            :disabled="busy || pending || !!intent"
            class="rounded border px-3 py-2"
          >
            Revisar decisión
          </button>
        </form>
      </div>
      <div v-if="intent && !intent.attempted" class="space-y-3 rounded border p-3">
        <p v-if="intent.action === 'review'">
          Añadir revisión {{ intent.body.disposition }} a {{ intent.targetId }} en versión
          {{ intent.body.expectedVersion }}.
        </p>
        <p v-else>Crear una exportación privada de los filtros aplicados revisados. No se descargarán datos todavía.</p>
        <p class="break-words">{{ intent.body.reason }}</p>
        <button
          data-audit-confirm
          type="button"
          :disabled="busy || pending"
          class="rounded border px-3 py-2"
          @click="send"
        >
          Confirmar {{ intent.action === 'review' ? 'revisión' : 'exportación' }}
        </button>
        <button type="button" :disabled="busy" @click="cancel">Cancelar revisión local</button>
      </div>
      <button
        v-if="intent?.attempted && phase === 'unknown'"
        data-audit-check
        type="button"
        :disabled="busy || pending"
        class="rounded border px-3 py-2"
        @click="check"
      >
        Consultar recibo y verificar resultado
      </button>
      <div v-if="exportReceipt" class="space-y-2 rounded border p-3">
        <p>
          CSV confirmado: {{ exportReceipt.rows }} filas · {{ exportReceipt.bytes }} bytes. Caduca
          {{ utc(exportReceipt.expiresAt) }}.
        </p>
        <p>
          Filtros congelados del archivo:
          {{ exportFilters?.family ? familyLabels[exportFilters.family] : 'Todas las fuentes' }} ·
          {{ exportFilters?.resourceId || 'Todos los recursos' }}.
        </p>
        <button
          data-audit-download
          type="button"
          :disabled="busy || pending || !!intent"
          class="rounded border px-3 py-2"
          @click="download"
        >
          Descargar CSV verificado
        </button>
      </div>
      <p v-if="downloadStatus === 'error'" data-audit-download-error role="alert">
        No se pudo validar o autorizar el CSV; no se ha descargado ningún archivo. Comprueba acceso y caducidad.
      </p>
      <p v-if="downloadStatus === 'done'" role="status">
        CSV verificado y preparado para descarga. No se conserva una copia en esta pantalla.
      </p>
    </template>
  </section>
</template>
