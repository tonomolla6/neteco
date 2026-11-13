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
const dispositionLabels = { reviewed: 'Revisado', follow_up: 'Requiere seguimiento' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function shortId(value: string | null) {
  if (value === null) return display(null)
  return UUID.test(value) ? `#${value.slice(0, 8).toUpperCase()}` : value
}
function setDay(key: 'from' | 'to', event: Event) {
  const day = (event.target as HTMLInputElement).value
  filters[key] = day ? `${day}T${key === 'from' ? '00:00:00' : '23:59:59'}Z` : ''
}
function size(bytes: number) {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toLocaleString('es-ES', { maximumFractionDigits: 1 })} KB`
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
    message.value = 'Revisa los filtros: el identificador de usuario o las fechas no son válidos.'
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
  <section aria-label="Auditoría administrativa" class="adm-stack min-w-0 max-w-full">
    <UAlert
      v-if="!allowed"
      role="status"
      color="warning"
      variant="subtle"
      icon="i-lucide-lock"
      title="No puedes consultar el registro de actividad ahora mismo"
      description="Hace falta una sesión activa, el correo verificado, la verificación en dos pasos y permiso de administración."
    />
    <template v-else>
      <UAlert
        v-if="message"
        :data-audit-confirmed="phase === 'confirmed' ? '' : undefined"
        :role="phase === 'unknown' || phase === 'error' ? 'alert' : 'status'"
        :color="phase === 'unknown' || phase === 'error' ? 'error' : phase === 'confirmed' ? 'success' : 'neutral'"
        variant="subtle"
        :icon="
          phase === 'unknown' || phase === 'error'
            ? 'i-lucide-triangle-alert'
            : phase === 'confirmed'
              ? 'i-lucide-circle-check'
              : 'i-lucide-info'
        "
        :title="message"
      />

      <AdminCard v-if="intent && !intent.attempted" title="Revisa antes de confirmar">
        <p v-if="intent.action === 'review'">
          Vas a marcar el registro {{ shortId(intent.targetId) }} como
          <strong>«{{ dispositionLabels[intent.body.disposition] }}»</strong>. El registro original no cambia.
        </p>
        <p v-else>
          Vas a preparar un archivo con todos los registros que cumplen los filtros aplicados. Todavía no se descarga
          nada.
        </p>
        <p class="adm-help mt-2 break-words">Motivo: {{ intent.body.reason }}</p>
        <template #footer>
          <button type="button" class="adm-btn adm-btn--secondary" :disabled="busy" @click="cancel">Cancelar</button>
          <button
            data-audit-confirm
            type="button"
            :disabled="busy || pending"
            class="adm-btn adm-btn--primary"
            @click="send"
          >
            Confirmar {{ intent.action === 'review' ? 'revisión' : 'exportación' }}
          </button>
        </template>
      </AdminCard>

      <div v-if="intent?.attempted && phase === 'unknown'">
        <button
          data-audit-check
          type="button"
          :disabled="busy || pending"
          class="adm-btn adm-btn--secondary"
          @click="check"
        >
          Comprobar si se ha guardado
        </button>
      </div>

      <AdminCard v-if="exportReceipt" title="Archivo listo para descargar">
        <p>
          {{ exportReceipt.rows }} registros · {{ size(exportReceipt.bytes) }}. Disponible hasta el
          {{ adminDate(exportReceipt.expiresAt, true) }}.
        </p>
        <p class="adm-help mt-1 break-words">
          Contiene: {{ exportFilters?.family ? familyLabels[exportFilters.family] : 'todas las áreas' }} ·
          {{ exportFilters?.resourceId || 'todas las referencias' }}.
        </p>
        <template #footer>
          <button
            data-audit-download
            type="button"
            :disabled="busy || pending || !!intent"
            class="adm-btn adm-btn--primary"
            @click="download"
          >
            <UIcon name="i-lucide-download" class="size-4" />Descargar CSV
          </button>
        </template>
      </AdminCard>
      <UAlert
        v-if="downloadStatus === 'error'"
        data-audit-download-error
        role="alert"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="No se ha podido descargar el archivo"
        description="Puede que haya caducado o que ya no tengas acceso. Vuelve a prepararlo."
      />
      <UAlert
        v-if="downloadStatus === 'done'"
        role="status"
        color="success"
        variant="subtle"
        icon="i-lucide-circle-check"
        title="Archivo descargado"
      />

      <div class="grid items-start gap-5" :class="detail && 'lg:grid-cols-[minmax(0,1fr)_24rem]'">
        <div class="adm-card adm-tablecard min-w-0">
          <div class="adm-tablecard__bar">
            <fieldset :disabled="busy || pending || !!intent" class="adm-toolbar m-0 min-w-0 border-0 p-0">
              <label :for="`${prefix}-family`" class="sr-only">Área</label>
              <select :id="`${prefix}-family`" v-model="filters.family" data-audit-family class="adm-input">
                <option value="">Todas las áreas</option>
                <option v-for="family in ADMIN_AUDIT_FAMILIES" :key="family" :value="family">
                  {{ familyLabels[family] }}
                </option>
              </select>
              <label :for="`${prefix}-from`" class="adm-help">Desde</label>
              <input
                :id="`${prefix}-from`"
                :value="filters.from.slice(0, 10)"
                data-audit-from
                type="date"
                class="adm-input"
                @input="setDay('from', $event)"
              />
              <label :for="`${prefix}-to`" class="adm-help">Hasta</label>
              <input
                :id="`${prefix}-to`"
                :value="filters.to.slice(0, 10)"
                data-audit-to
                type="date"
                class="adm-input"
                @input="setDay('to', $event)"
              />
              <label :for="`${prefix}-resource`" class="sr-only">Referencia del elemento</label>
              <input
                :id="`${prefix}-resource`"
                v-model="filters.resourceId"
                data-audit-resource
                autocomplete="off"
                maxlength="160"
                placeholder="Referencia (producto, pedido…)"
                class="adm-input w-56"
              />
              <label :for="`${prefix}-actor`" class="sr-only">Identificador del usuario</label>
              <input
                :id="`${prefix}-actor`"
                v-model="filters.actorId"
                data-audit-actor
                autocomplete="off"
                maxlength="36"
                placeholder="Identificador del usuario"
                class="adm-input w-56"
              />
              <div class="adm-toolbar__end">
                <button data-audit-load type="button" class="adm-btn adm-btn--primary" @click="load()">
                  <UIcon name="i-lucide-search" class="size-4" />{{ snapshot ? 'Aplicar' : 'Ver actividad' }}
                </button>
              </div>
            </fieldset>
          </div>

          <AdminEmptyState
            v-if="!snapshot"
            :variant="phase === 'error' ? 'error' : 'empty'"
            icon="i-lucide-history"
            :title="phase === 'error' ? 'No se ha podido cargar la actividad' : 'Consulta quién hizo qué y cuándo'"
            :description="
              phase === 'error'
                ? 'Vuelve a intentarlo con el botón de arriba.'
                : 'Elige un área o unas fechas y pulsa «Ver actividad». Las fechas se interpretan en hora UTC.'
            "
          />
          <template v-else>
            <div class="adm-table-wrap">
              <table class="adm-table">
                <caption class="sr-only">
                  Registro de actividad
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Fecha</th>
                    <th scope="col">Área</th>
                    <th scope="col">Acción</th>
                    <th scope="col">Referencia</th>
                    <th scope="col">Usuario</th>
                    <th scope="col">Revisión</th>
                    <th scope="col" data-numeric><span class="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody data-audit-list>
                  <tr v-for="item in snapshot.items" :key="item.id">
                    <td class="whitespace-nowrap">
                      <time :datetime="item.createdAt" :title="utc(item.createdAt)">{{
                        adminDate(item.createdAt, true)
                      }}</time>
                    </td>
                    <td>{{ familyLabels[item.family] }}</td>
                    <td>{{ adminHumanize(item.action) }}</td>
                    <td class="break-all" :title="item.resourceId">{{ shortId(item.resourceId) }}</td>
                    <td :title="item.actorId ?? undefined">{{ shortId(item.actorId) }}</td>
                    <td>
                      <AdminBadge
                        :tone="
                          item.disposition === 'reviewed'
                            ? 'success'
                            : item.disposition === 'follow_up'
                              ? 'warning'
                              : 'neutral'
                        "
                      >
                        {{ item.disposition ? dispositionLabels[item.disposition] : 'Sin revisar' }}
                      </AdminBadge>
                    </td>
                    <td data-numeric class="adm-table__actions">
                      <button
                        :data-audit-open="item.id"
                        type="button"
                        :disabled="busy || pending || !!intent"
                        class="adm-btn adm-btn--secondary adm-btn--sm"
                        @click="open(item)"
                      >
                        Ver detalle
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <AdminEmptyState
              v-if="!snapshot.items.length"
              role="status"
              variant="filtered"
              compact
              title="No hay actividad con estos filtros"
              description="Prueba con otra área o amplía las fechas."
            />
            <div class="adm-pagination">
              <details class="min-w-0">
                <summary class="cursor-pointer">Qué incluye este registro</summary>
                <p class="mt-2 break-words">
                  Fuentes incluidas:
                  {{ snapshot.coverage.families.map((family) => familyLabels[family]).join(', ') }}. No incluye lo que
                  hacen los clientes desde su cuenta ni los procesos automáticos. Las horas exactas se guardan en UTC.
                </p>
                <p class="mt-1 break-words">
                  Filtros aplicados:
                  {{ appliedFilters?.family ? familyLabels[appliedFilters.family] : 'todas las áreas' }} ·
                  {{ appliedFilters?.resourceId || 'todas las referencias' }}.
                </p>
              </details>
              <button
                v-if="snapshot.nextCursor"
                data-audit-next
                type="button"
                :disabled="busy || pending || !!intent"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                @click="load(snapshot.nextCursor)"
              >
                Siguientes 25<UIcon name="i-lucide-chevron-right" class="size-4" />
              </button>
            </div>
          </template>
        </div>

        <AdminCard v-if="detail" data-audit-detail :title="familyLabels[detail.item.family]" class="min-w-0">
          <template #actions>
            <AdminButton variant="ghost" size="sm" icon="i-lucide-x" label="Cerrar detalle" @click="detail = null" />
          </template>
          <div class="adm-stack [overflow-wrap:anywhere]">
            <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
              <dt class="adm-help">Referencia</dt>
              <dd>{{ detail.item.resourceId }}</dd>
              <dt class="adm-help">Usuario</dt>
              <dd :title="detail.item.actorId ?? undefined">{{ shortId(detail.item.actorId) }}</dd>
              <dt class="adm-help">Operación</dt>
              <dd :title="detail.item.commandId ?? undefined">{{ shortId(detail.item.commandId) }}</dd>
              <dt class="adm-help">Sesión</dt>
              <dd :title="detail.item.sessionId ?? undefined">{{ shortId(detail.item.sessionId) }}</dd>
              <dt class="adm-help">Huella de conexión</dt>
              <dd class="break-all">{{ display(detail.item.ipHash) }}</dd>
              <dt class="adm-help">Motivo original</dt>
              <dd>{{ redaction(detail.item.reason) }}</dd>
              <dt class="adm-help">Datos anteriores</dt>
              <dd>{{ redaction(detail.item.before) }}</dd>
              <dt class="adm-help">Datos nuevos</dt>
              <dd>{{ redaction(detail.item.after) }}</dd>
            </dl>
            <div>
              <h3>Cambios</h3>
              <ul v-if="detail.changesAvailability === 'recorded'" class="mt-1 space-y-1">
                <li v-for="(change, index) in detail.changes" :key="index">
                  {{ fieldLabels[change.field] }}: {{ display(change.before) }} → {{ display(change.after) }}
                </li>
              </ul>
              <p v-else class="adm-help mt-1">
                {{
                  detail.changesAvailability === 'redacted'
                    ? 'Los cambios están ocultos por privacidad.'
                    : 'No se guardó el detalle de los cambios.'
                }}
              </p>
            </div>
            <div v-if="detail.reviews.length">
              <h3>Revisiones anteriores</h3>
              <ol class="mt-1 space-y-1">
                <li v-for="row in detail.reviews" :key="row.commandId">
                  {{ dispositionLabels[row.disposition] }} · {{ adminDate(row.recordedAt, true) }}
                </li>
              </ol>
            </div>
            <form class="adm-stack border-t border-[var(--border)] pt-4" @submit.prevent="review">
              <div class="adm-field">
                <label :for="`${prefix}-disposition`" class="adm-label">Marcar como</label>
                <select
                  :id="`${prefix}-disposition`"
                  v-model="disposition"
                  data-audit-disposition
                  :disabled="busy || pending || !!intent"
                  class="adm-input"
                >
                  <option value="reviewed">Revisado</option>
                  <option value="follow_up">Requiere seguimiento</option>
                </select>
              </div>
              <div class="adm-field">
                <label :for="`${prefix}-review-reason`" class="adm-label">Motivo</label>
                <textarea
                  :id="`${prefix}-review-reason`"
                  v-model="reviewReason"
                  data-audit-review-reason
                  :disabled="busy || pending || !!intent"
                  minlength="10"
                  maxlength="500"
                  class="adm-input"
                />
                <p class="adm-help">Entre 10 y 500 caracteres. Solo lo ven los administradores.</p>
              </div>
              <button
                data-audit-review
                type="submit"
                :disabled="busy || pending || !!intent"
                class="adm-btn adm-btn--primary justify-center"
              >
                Guardar revisión
              </button>
            </form>
          </div>
        </AdminCard>
      </div>

      <AdminCard
        v-if="snapshot"
        title="Exportar a CSV"
        description="Incluye todos los registros de los filtros aplicados (hasta 1.000), no solo esta página. El archivo caduca a las 24 horas."
      >
        <form class="flex flex-wrap items-end gap-3" @submit.prevent="reviewExport">
          <div class="adm-field min-w-0 flex-1 basis-64">
            <label :for="`${prefix}-export-reason`" class="adm-label">Motivo de la exportación</label>
            <textarea
              :id="`${prefix}-export-reason`"
              v-model="exportReason"
              data-audit-export-reason
              :disabled="busy || pending || !!intent"
              minlength="10"
              maxlength="500"
              rows="2"
              class="adm-input"
            />
          </div>
          <button
            data-audit-export-review
            type="submit"
            :disabled="busy || pending || !!intent"
            class="adm-btn adm-btn--secondary"
          >
            <UIcon name="i-lucide-file-down" class="size-4" />Preparar exportación
          </button>
        </form>
      </AdminCard>
    </template>
  </section>
</template>
