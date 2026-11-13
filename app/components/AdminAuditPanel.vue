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
  downloadStatus = ref<'idle' | 'done' | 'error'>('idle'),
  exportOpen = ref(false),
  secondFactorRejected = ref(false),
  unavailable = ref(false)
const familyLabels: Record<AdminAuditFamily, string> = {
  catalog_metadata: 'Datos de producto',
  catalog_status: 'Estado de catálogo',
  catalog_policy: 'Políticas de catálogo',
  catalog_authoring: 'Edición de catálogo',
  catalog_price: 'Precios',
  catalog_category: 'Familias',
  catalog_editorial: 'Contenido de catálogo',
  catalog_native: 'Catálogo',
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
  newsletter_editorial: 'Contenido del boletín',
  company_review: 'Revisión profesional',
  promotion: 'Promociones',
  communication_history: 'Historial de comunicaciones',
  admin_invitation: 'Invitaciones al equipo',
  admin_bootstrap: 'Alta inicial de administración',
  admin_audit: 'Revisiones de este registro'
}
const fieldLabels = {
  version: 'Versión',
  quantity: 'Cantidad',
  physicalQuantity: 'Cantidad física',
  threshold: 'Umbral',
  grossCents: 'Importe bruto',
  netCents: 'Importe neto',
  labelCount: 'Número de etiquetas',
  noteCount: 'Número de notas',
  permissionCount: 'Número de permisos',
  state: 'Estado',
  status: 'Estado',
  roleCode: 'Perfil',
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
  exportOpen.value = false
  unavailable.value = false
  setCommandPending(false)
}
function failureCode(cause: unknown) {
  const code = (cause as { data?: { error?: { code?: unknown } } } | null)?.data?.error?.code
  return typeof code === 'string' ? code : null
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
  secondFactorRejected.value = failureCode(cause) === 'mfa_required'
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
    message.value = 'Revisa los filtros: la persona o las fechas no son válidas.'
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
  unavailable.value = false
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
      unavailable.value = failureCode(cause) === 'service_unavailable'
      phase.value = unavailable.value ? 'idle' : 'error'
      message.value = unavailable.value
        ? ''
        : 'No se pudo leer el registro de actividad. No se ha supuesto que esté vacío.'
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
/** Falta el segundo factor: lo dice la sesión o lo ha dicho el servidor al rechazar la consulta. */
const needsSecondFactor = computed(
  () => secondFactorRejected.value || (auth.ready.value && auth.loggedIn.value && auth.user.value?.mfaVerified !== true)
)
const notice = computed(() => {
  const failed = phase.value === 'unknown' || phase.value === 'error'
  return {
    role: failed ? 'alert' : 'status',
    color: failed ? ('error' as const) : phase.value === 'confirmed' ? ('success' as const) : ('neutral' as const),
    icon: failed ? 'i-lucide-triangle-alert' : phase.value === 'confirmed' ? 'i-lucide-circle-check' : 'i-lucide-info'
  }
})
const hasFilters = computed(() => Object.values(filters).some((value) => value.trim() !== ''))
function clearFilters() {
  for (const key of Object.keys(filters) as Array<keyof typeof filters>) filters[key] = ''
  if (snapshot.value) void load()
}
/** Personas que aparecen en la página cargada: se elige de la lista en vez de teclear su identificador. */
const actorOptions = computed(() => {
  const ids = new Set<string>()
  if (filters.actorId) ids.add(filters.actorId)
  for (const item of snapshot.value?.items ?? []) if (item.actorId) ids.add(item.actorId)
  return [...ids]
})
function actorLabel(id: string | null) {
  if (id === null) return 'Sin identificar'
  return id === auth.user.value?.id ? 'Tú' : `Usuario ${shortId(id)}`
}
function dispositionTone(value: 'reviewed' | 'follow_up' | null): 'success' | 'warning' | 'neutral' {
  return value === 'reviewed' ? 'success' : value === 'follow_up' ? 'warning' : 'neutral'
}
function changeValue(field: keyof typeof fieldLabels, value: string | number | boolean | null) {
  if (value === null) return 'Sin dato'
  if ((field === 'grossCents' || field === 'netCents') && typeof value === 'number') return adminMoney(value)
  if ((field === 'state' || field === 'status') && typeof value === 'string') return adminStatusLabel(value)
  if (field === 'roleCode' && typeof value === 'string') return adminRoleLabel(value)
  return display(value)
}
function rangeLabel(scope: Filters | null) {
  // El filtro guarda días completos en UTC: se enseña el día elegido, no su conversión horaria.
  const day = (value: string) => adminDate(`${value.slice(0, 10)}T12:00:00Z`)
  if (scope?.from && scope.to) return `Del ${day(scope.from)} al ${day(scope.to)}`
  if (scope?.from) return `Desde el ${day(scope.from)}`
  if (scope?.to) return `Hasta el ${day(scope.to)}`
  return 'Todas las fechas'
}
const exportScope = computed(() => exportFilters.value ?? appliedFilters.value)
function openRow(item: AdminAuditItem, event: MouseEvent) {
  if ((event.target as HTMLElement).closest('a,button,input,label,select')) return
  void open(item)
}
const detailDrawer = computed({
  get: () => detail.value !== null,
  set: (visible: boolean) => {
    if (visible) return
    if (intent.value?.action === 'review') cancel()
    detail.value = null
  }
})
function openExport() {
  if (!snapshot.value || busy.value || props.pending) return
  exportOpen.value = true
}
const exportDrawer = computed({
  get: () => exportOpen.value,
  set: (visible: boolean) => {
    if (visible) return openExport()
    if (intent.value?.action === 'export') cancel()
    exportOpen.value = false
  }
})
watch(
  owner,
  () => {
    reset()
    blocked.value = null
    secondFactorRejected.value = false
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
    <AdminCard v-if="!allowed">
      <AdminEmptyState
        v-if="runtime.public.serverRuntime !== 'cloudflare'"
        icon="i-lucide-history"
        title="El registro de actividad no está disponible en esta instalación"
        description="Solo se guarda y se consulta en la tienda publicada."
      />
      <AdminEmptyState
        v-else-if="needsSecondFactor"
        data-audit-mfa-required
        icon="i-lucide-shield-check"
        title="Hace falta la verificación en dos pasos"
        description="Por seguridad, el registro de actividad solo se puede consultar con la verificación en dos pasos activada en tu cuenta. En la demostración pública no está disponible."
      />
      <AdminEmptyState
        v-else
        icon="i-lucide-lock"
        title="No puedes consultar el registro de actividad ahora mismo"
        description="Hace falta una sesión activa, el correo verificado y permiso de administración. Si acabas de cambiar algo en tu cuenta, vuelve a entrar."
      />
    </AdminCard>
    <template v-else>
      <AdminPageActions>
        <button
          type="button"
          data-audit-export-open
          :disabled="!snapshot || busy || pending || (!!intent && !exportOpen)"
          :title="snapshot ? undefined : 'Consulta primero la actividad que quieres exportar'"
          class="adm-btn adm-btn--secondary"
          @click="exportDrawer = true"
        >
          <UIcon name="i-lucide-file-down" class="size-4" />Exportar
        </button>
      </AdminPageActions>

      <UAlert
        v-if="message && !detailDrawer && !exportOpen"
        :data-audit-confirmed="phase === 'confirmed' ? '' : undefined"
        :role="notice.role"
        :color="notice.color"
        variant="subtle"
        :icon="notice.icon"
        :title="message"
      />

      <div v-if="intent?.attempted && phase === 'unknown' && !detailDrawer && !exportOpen">
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

      <UAlert
        v-if="exportReceipt && !exportOpen"
        role="status"
        color="neutral"
        variant="subtle"
        icon="i-lucide-file-down"
        title="Tienes un archivo listo para descargar"
        :description="`${exportReceipt.rows} registros · ${size(exportReceipt.bytes)}. Disponible hasta el ${adminDate(exportReceipt.expiresAt, true)}.`"
        :actions="[{ label: 'Ver archivo', color: 'neutral', variant: 'outline', onClick: openExport }]"
      />

      <div class="adm-card adm-tablecard min-w-0">
        <div class="adm-tablecard__bar">
          <fieldset :disabled="busy || pending || !!intent" class="m-0 min-w-0 border-0 p-0">
            <AdminToolbar :searchable="false">
              <label :for="`${prefix}-family`" class="sr-only">Tipo de actividad</label>
              <select :id="`${prefix}-family`" v-model="filters.family" data-audit-family class="adm-input">
                <option value="">Toda la actividad</option>
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
              <label :for="`${prefix}-actor`" class="sr-only">Persona</label>
              <select
                v-if="actorOptions.length"
                :id="`${prefix}-actor`"
                v-model="filters.actorId"
                data-audit-actor
                class="adm-input"
              >
                <option value="">Cualquier persona</option>
                <option v-for="actor in actorOptions" :key="actor" :value="actor">Usuario {{ shortId(actor) }}</option>
              </select>
              <label :for="`${prefix}-resource`" class="sr-only">Referencia del elemento</label>
              <input
                :id="`${prefix}-resource`"
                v-model="filters.resourceId"
                data-audit-resource
                autocomplete="off"
                maxlength="160"
                placeholder="Referencia (producto, pedido…)"
                class="adm-input w-52"
                @keydown.enter.prevent="load()"
              />
              <template #actions>
                <button
                  v-if="hasFilters"
                  type="button"
                  class="adm-btn adm-btn--ghost adm-btn--sm"
                  @click="clearFilters"
                >
                  Quitar filtros
                </button>
                <button data-audit-load type="button" class="adm-btn adm-btn--primary" @click="load()">
                  <UIcon name="i-lucide-search" class="size-4" />{{ snapshot ? 'Aplicar' : 'Ver actividad' }}
                </button>
              </template>
            </AdminToolbar>
          </fieldset>
        </div>

        <AdminEmptyState
          v-if="!snapshot && unavailable"
          icon="i-lucide-cloud-off"
          title="El registro de actividad no está disponible ahora mismo"
          description="El servicio está desactivado o en mantenimiento. No se ha perdido nada: prueba de nuevo en unos minutos."
        >
          <AdminButton icon="i-lucide-rotate-cw" :disabled="busy || pending" @click="load()">Reintentar</AdminButton>
        </AdminEmptyState>
        <AdminEmptyState
          v-else-if="!snapshot"
          :variant="phase === 'error' ? 'error' : 'empty'"
          icon="i-lucide-history"
          :title="phase === 'error' ? 'No se ha podido cargar la actividad' : 'Consulta quién hizo qué y cuándo'"
          :description="
            phase === 'error'
              ? 'Puede ser un fallo de conexión. Vuelve a intentarlo.'
              : 'Elige un tipo de actividad o unas fechas y pulsa «Ver actividad».'
          "
        >
          <AdminButton v-if="phase === 'error'" icon="i-lucide-rotate-cw" :disabled="busy || pending" @click="load()">
            Reintentar
          </AdminButton>
        </AdminEmptyState>
        <template v-else>
          <div v-if="snapshot.items.length" class="adm-table-wrap">
            <table class="adm-table">
              <caption class="sr-only">
                Registro de actividad
              </caption>
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Qué se hizo</th>
                  <th scope="col">Sobre</th>
                  <th scope="col">Quién</th>
                  <th scope="col">Revisión</th>
                  <th scope="col" data-numeric><span class="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody data-audit-list>
                <tr v-for="item in snapshot.items" :key="item.id" class="cursor-pointer" @click="openRow(item, $event)">
                  <td class="whitespace-nowrap">
                    <time :datetime="item.createdAt">{{ adminDate(item.createdAt, true) }}</time>
                  </td>
                  <td>{{ familyLabels[item.family] }}</td>
                  <td>{{ adminHumanize(item.action) }}</td>
                  <td class="break-all">{{ shortId(item.resourceId) }}</td>
                  <td>{{ actorLabel(item.actorId) }}</td>
                  <td>
                    <AdminBadge :tone="dispositionTone(item.disposition)">
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
            v-else
            role="status"
            variant="filtered"
            title="No hay actividad con estos filtros"
            description="Prueba con otro tipo de actividad o amplía las fechas."
          >
            <AdminButton v-if="hasFilters" :disabled="busy || pending || !!intent" @click="clearFilters">
              Quitar filtros
            </AdminButton>
          </AdminEmptyState>
          <div class="adm-pagination">
            <details class="min-w-0">
              <summary class="cursor-pointer">Qué incluye este registro</summary>
              <p class="mt-2 break-words">
                Recoge: {{ snapshot.coverage.families.map((family) => familyLabels[family]).join(', ') }}. No incluye lo
                que hacen los clientes desde su cuenta ni los procesos automáticos.
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

      <AdminDrawer
        v-model:open="detailDrawer"
        :title="detail ? adminHumanize(detail.item.action) : 'Detalle de la actividad'"
        :description="
          detail ? `${familyLabels[detail.item.family]} · ${adminDate(detail.item.createdAt, true)}` : undefined
        "
      >
        <div v-if="detail" data-audit-detail class="adm-stack min-w-0 [overflow-wrap:anywhere]">
          <UAlert
            v-if="message"
            :data-audit-confirmed="phase === 'confirmed' ? '' : undefined"
            :role="notice.role"
            :color="notice.color"
            variant="subtle"
            :icon="notice.icon"
            :title="message"
          />

          <template v-if="intent?.action === 'review'">
            <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
              <dt class="adm-help">Se marcará como</dt>
              <dd class="font-semibold text-[var(--text-strong)]">{{ dispositionLabels[intent.body.disposition] }}</dd>
              <dt class="adm-help">Motivo</dt>
              <dd>{{ intent.body.reason }}</dd>
            </dl>
            <p class="adm-help">El registro original no cambia: solo se añade tu revisión.</p>
          </template>

          <template v-else>
            <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
              <dt class="adm-help">Fecha</dt>
              <dd>{{ adminDate(detail.item.createdAt, true) }}</dd>
              <dt class="adm-help">Tipo</dt>
              <dd>{{ familyLabels[detail.item.family] }}</dd>
              <dt class="adm-help">Qué se hizo</dt>
              <dd>{{ adminHumanize(detail.item.action) }}</dd>
              <dt class="adm-help">Sobre</dt>
              <dd>{{ shortId(detail.item.resourceId) }}</dd>
              <dt class="adm-help">Quién</dt>
              <dd>{{ actorLabel(detail.item.actorId) }}</dd>
              <dt class="adm-help">Revisión</dt>
              <dd>
                <AdminBadge :tone="dispositionTone(detail.item.disposition)">
                  {{ detail.item.disposition ? dispositionLabels[detail.item.disposition] : 'Sin revisar' }}
                </AdminBadge>
              </dd>
            </dl>

            <div>
              <h3>Cambios</h3>
              <ul v-if="detail.changesAvailability === 'recorded' && detail.changes.length" class="adm-list mt-2">
                <li v-for="(change, index) in detail.changes" :key="index">
                  <div class="min-w-0 flex-1">
                    <p class="adm-list__title">{{ fieldLabels[change.field] }}</p>
                    <p class="adm-help">
                      {{ changeValue(change.field, change.before) }} → {{ changeValue(change.field, change.after) }}
                    </p>
                  </div>
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
                  {{ dispositionLabels[row.disposition] }} · {{ adminDate(row.recordedAt, true) }} ·
                  {{ actorLabel(row.actorId) }}
                </li>
              </ol>
            </div>

            <form
              :id="`${prefix}-review-form`"
              class="adm-stack border-t border-[var(--border)] pt-4"
              @submit.prevent="review"
            >
              <h3>Añadir una revisión</h3>
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
            </form>

            <details class="border-t border-[var(--border)] pt-4">
              <summary class="cursor-pointer font-semibold text-[var(--text-strong)]">Datos técnicos</summary>
              <dl class="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
                <dt class="adm-help">Referencia completa</dt>
                <dd class="break-all">{{ detail.item.resourceId }}</dd>
                <dt class="adm-help">Usuario</dt>
                <dd class="break-all">{{ display(detail.item.actorId) }}</dd>
                <dt class="adm-help">Operación</dt>
                <dd class="break-all">{{ display(detail.item.commandId) }}</dd>
                <dt class="adm-help">Sesión</dt>
                <dd class="break-all">{{ display(detail.item.sessionId) }}</dd>
                <dt class="adm-help">Huella de conexión</dt>
                <dd class="break-all">{{ display(detail.item.ipHash) }}</dd>
                <dt class="adm-help">Hora exacta</dt>
                <dd>{{ utc(detail.item.createdAt) }}</dd>
                <dt class="adm-help">Motivo original</dt>
                <dd>{{ redaction(detail.item.reason) }}</dd>
                <dt class="adm-help">Datos anteriores</dt>
                <dd>{{ redaction(detail.item.before) }}</dd>
                <dt class="adm-help">Datos nuevos</dt>
                <dd>{{ redaction(detail.item.after) }}</dd>
              </dl>
            </details>
          </template>
        </div>
        <template #footer>
          <template v-if="intent?.action === 'review' && !intent.attempted">
            <button type="button" class="adm-btn adm-btn--secondary" :disabled="busy" @click="cancel">
              Volver a editar
            </button>
            <button
              data-audit-confirm
              type="button"
              :disabled="busy || pending"
              class="adm-btn adm-btn--primary"
              @click="send"
            >
              Confirmar revisión
            </button>
          </template>
          <template v-else-if="intent?.attempted">
            <button type="button" class="adm-btn adm-btn--secondary" @click="detailDrawer = false">Cerrar</button>
            <button
              v-if="phase === 'unknown'"
              data-audit-check
              type="button"
              :disabled="busy || pending"
              class="adm-btn adm-btn--primary"
              @click="check"
            >
              Comprobar si se ha guardado
            </button>
          </template>
          <template v-else>
            <button type="button" class="adm-btn adm-btn--secondary" @click="detailDrawer = false">Cerrar</button>
            <button
              data-audit-review
              type="submit"
              :form="`${prefix}-review-form`"
              :disabled="busy || pending || !!intent"
              class="adm-btn adm-btn--primary"
            >
              Guardar revisión
            </button>
          </template>
        </template>
      </AdminDrawer>

      <AdminDrawer
        v-model:open="exportDrawer"
        title="Exportar la actividad"
        description="Se exportan todos los registros de los filtros aplicados (hasta 1.000), no solo los que ves en pantalla."
      >
        <div class="adm-stack min-w-0">
          <UAlert
            v-if="message"
            :data-audit-confirmed="phase === 'confirmed' ? '' : undefined"
            :role="notice.role"
            :color="notice.color"
            variant="subtle"
            :icon="notice.icon"
            :title="message"
          />
          <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
            <dt class="adm-help">Tipo de actividad</dt>
            <dd>{{ exportScope?.family ? familyLabels[exportScope.family] : 'Toda la actividad' }}</dd>
            <dt class="adm-help">Fechas</dt>
            <dd>{{ rangeLabel(exportScope) }}</dd>
            <dt class="adm-help">Sobre</dt>
            <dd class="break-all">{{ exportScope?.resourceId || 'Cualquier elemento' }}</dd>
            <dt class="adm-help">Quién</dt>
            <dd>{{ exportScope?.actorId ? actorLabel(exportScope.actorId) : 'Cualquier persona' }}</dd>
          </dl>

          <template v-if="exportReceipt">
            <div class="rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3">
              <p class="font-semibold text-[var(--text-strong)]">Archivo listo para descargar</p>
              <p class="adm-help">
                {{ exportReceipt.rows }} registros · {{ size(exportReceipt.bytes) }}. Disponible hasta el
                {{ adminDate(exportReceipt.expiresAt, true) }}.
              </p>
            </div>
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
          </template>
          <p v-else-if="intent?.action === 'export'" class="break-words">
            <span class="adm-help">Motivo:</span> {{ intent.body.reason }}
          </p>
          <form v-else :id="`${prefix}-export-form`" @submit.prevent="reviewExport">
            <div class="adm-field">
              <label :for="`${prefix}-export-reason`" class="adm-label">Motivo de la exportación</label>
              <textarea
                :id="`${prefix}-export-reason`"
                v-model="exportReason"
                data-audit-export-reason
                :disabled="busy || pending || !!intent"
                minlength="10"
                maxlength="500"
                rows="3"
                class="adm-input"
              />
              <p class="adm-help">
                Entre 10 y 500 caracteres. Queda guardado en el registro. El archivo caduca a las 24 horas.
              </p>
            </div>
          </form>
        </div>
        <template #footer>
          <template v-if="exportReceipt">
            <button type="button" class="adm-btn adm-btn--secondary" @click="exportDrawer = false">Cerrar</button>
            <button
              data-audit-download
              type="button"
              :disabled="busy || pending || !!intent"
              class="adm-btn adm-btn--primary"
              @click="download"
            >
              <UIcon name="i-lucide-download" class="size-4" />Descargar archivo
            </button>
          </template>
          <template v-else-if="intent?.action === 'export' && !intent.attempted">
            <button type="button" class="adm-btn adm-btn--secondary" :disabled="busy" @click="cancel">
              Volver a editar
            </button>
            <button
              data-audit-confirm
              type="button"
              :disabled="busy || pending"
              class="adm-btn adm-btn--primary"
              @click="send"
            >
              Confirmar exportación
            </button>
          </template>
          <template v-else-if="intent?.attempted">
            <button type="button" class="adm-btn adm-btn--secondary" @click="exportDrawer = false">Cerrar</button>
            <button
              v-if="phase === 'unknown'"
              data-audit-check
              type="button"
              :disabled="busy || pending"
              class="adm-btn adm-btn--primary"
              @click="check"
            >
              Comprobar si se ha guardado
            </button>
          </template>
          <template v-else>
            <button type="button" class="adm-btn adm-btn--secondary" @click="exportDrawer = false">Cancelar</button>
            <button
              data-audit-export-review
              type="submit"
              :form="`${prefix}-export-form`"
              :disabled="busy || pending || !!intent"
              class="adm-btn adm-btn--primary"
            >
              Preparar exportación
            </button>
          </template>
        </template>
      </AdminDrawer>
    </template>
  </section>
</template>
