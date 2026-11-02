<script setup lang="ts">
import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import { normalizeSynonymTerm } from '~~/shared/search-synonyms'
import { adminCapabilitiesSchema } from '~~/shared/admin-navigation'
import { useAdminNavigation } from '../composables/useAdminNavigation'
import { randomId } from '../utils/uuid'

const SEARCH_MERCHANDISING_MAX_VALIDITY_DAYS = 180
const SEARCH_MERCHANDISING_MAX_WEIGHT = 10
const DAY_MS = 24 * 60 * 60 * 1000

function isAllowedSearchRedirectPath(path: string) {
  if (path.length < 2 || path.length > 300 || !/^[A-Za-z0-9._~/?=&,+-]+$/.test(path)) return false
  if (path.includes('//') || path.includes('..')) return false
  const parts = path.split('?')
  if (parts.length > 2) return false
  const [pathname = '', query] = parts
  if (query !== undefined && query.length === 0) return false
  if (/(^|\/)\.(\/|$)/.test(pathname)) return false
  if (pathname.startsWith('/producto/'))
    return query === undefined && /^\/producto\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pathname)
  return /^\/(?:catalogo|contenido|recursos)(?:\/|$)/.test(pathname)
}

const noControls = (value: string) => !/[\p{Cc}\p{Cf}]/u.test(value)
const termSchema = z
  .string()
  .min(2)
  .max(160)
  .refine(noControls)
  .transform((value) => value.trim().replace(/\s+/gu, ' '))
  .pipe(z.string().min(2).max(160))
  .refine((value) => /[\p{L}\p{N}]/u.test(normalizeSynonymTerm(value)) && normalizeSynonymTerm(value).length >= 2)
const reasonSchema = z.string().trim().min(3).max(500).refine(noControls)
const instantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .refine((value) => {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) && new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z') === value
  })
const versionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const kindSchema = z.enum(['boost', 'bury', 'redirect'])

const saveInputSchema = z
  .object({
    action: z.literal('save'),
    id: catalogPolicyUuidSchema.nullable(),
    expectedVersion: versionSchema,
    term: termSchema,
    kind: kindSchema,
    productId: catalogPolicyUuidSchema.nullable(),
    weight: z.number().int().min(1).max(SEARCH_MERCHANDISING_MAX_WEIGHT).nullable(),
    redirectPath: z.string().max(300).nullable(),
    reason: reasonSchema,
    validFrom: instantSchema,
    validUntil: instantSchema
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (message: string) => context.addIssue({ code: 'custom', message })
    if ((value.id === null) !== (value.expectedVersion === 0)) issue('La identidad y versión no corresponden.')
    const span = Date.parse(value.validUntil) - Date.parse(value.validFrom)
    if (!(span > 0 && span <= SEARCH_MERCHANDISING_MAX_VALIDITY_DAYS * DAY_MS))
      issue('La vigencia debe ser posterior al inicio y no superar 180 días.')
    // The server's expiry trigger compares the end with its own clock: it must be in the future
    // and at most 180 days ahead. A past rule can be retired but must get a new end date to be saved.
    const until = Date.parse(value.validUntil),
      nowMs = Date.now()
    if (!(until > nowMs && until <= nowMs + SEARCH_MERCHANDISING_MAX_VALIDITY_DAYS * DAY_MS))
      issue('La caducidad debe ser posterior a este momento y no superar 180 días desde ahora.')
    if (value.kind === 'redirect') {
      if (value.productId !== null || value.weight !== null) issue('Una redirección no lleva producto ni peso.')
      if (value.redirectPath === null || !isAllowedSearchRedirectPath(value.redirectPath))
        issue(
          'La ruta de redirección debe ser una ruta interna permitida (/catalogo, /contenido, /recursos o /producto/slug).'
        )
    } else if (value.productId === null || value.weight === null || value.redirectPath !== null) {
      issue('Boost y bury requieren un UUID de producto y un peso entre 1 y 10, sin ruta.')
    }
  })

const retireInputSchema = z
  .object({
    action: z.literal('retire'),
    id: catalogPolicyUuidSchema,
    expectedVersion: versionSchema.refine((value) => value >= 1),
    reason: reasonSchema
  })
  .strict()

const snapshotSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    term: termSchema,
    termNormalized: z.string().min(2).max(160),
    kind: kindSchema,
    productId: catalogPolicyUuidSchema.nullable(),
    weight: z.number().int().min(1).max(SEARCH_MERCHANDISING_MAX_WEIGHT).nullable(),
    redirectPath: z.string().max(300).nullable(),
    reason: reasonSchema,
    validFrom: instantSchema,
    validUntil: instantSchema,
    status: z.enum(['active', 'retired']),
    authorId: catalogPolicyUuidSchema,
    version: versionSchema.refine((value) => value > 0),
    updatedAt: instantSchema
  })
  .strict()

const stateSchema = z.enum(['live', 'scheduled', 'expired', 'retired'])
const itemSchema = snapshotSchema.extend({ state: stateSchema }).strict()
export type SearchMerchandisingRuleItem = z.infer<typeof itemSchema>

const listSchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z.array(itemSchema).max(100),
    total: z.number().int().min(0),
    page: z.number().int().min(1).max(1000000),
    perPage: z.number().int().min(1).max(100)
  })
  .strict()

const singleItemSchema = z.object({ item: itemSchema }).strict()
const historySchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z.array(itemSchema).min(1)
  })
  .strict()

const receiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: catalogPolicyUuidSchema,
    action: z.enum(['save', 'retire']),
    item: snapshotSchema
  })
  .strict()
export type SearchMerchandisingRuleReceipt = z.infer<typeof receiptSchema>
type CommandPayload = z.infer<typeof saveInputSchema> | z.infer<typeof retireInputSchema>

const props = withDefaults(defineProps<{ runtime?: string }>(), { runtime: 'cloudflare' })
const session = useUserSession(),
  request = useRequestFetch(),
  prefix = useId()
const navigation = props.runtime === 'cloudflare' ? useAdminNavigation() : null

const actor = computed(() => {
  if (
    props.runtime !== 'cloudflare' ||
    session.ready.value !== true ||
    session.loggedIn.value !== true ||
    session.user.value?.emailVerified !== true ||
    session.user.value?.mfaVerified !== true ||
    navigation?.status.value !== 'ready'
  )
    return null
  const parsed = adminCapabilitiesSchema.safeParse(catalogPolicyOwnJson(navigation.capabilities.value))
  if (
    !parsed.success ||
    parsed.data.state !== 'ready' ||
    !parsed.data.permissions.includes('catalog.write') ||
    parsed.data.identityId !== session.user.value.id ||
    parsed.data.sessionId !== session.session.value?.sessionId ||
    parsed.data.sessionVersion !== session.session.value?.sessionVersion
  )
    return null
  return `${parsed.data.identityId}:${parsed.data.sessionId}:${parsed.data.sessionVersion}`
})

const list = shallowRef<z.infer<typeof listSchema> | null>(null)
const readStatus = ref<'idle' | 'pending' | 'success' | 'error'>('idle')
const search = ref(''),
  appliedSearch = ref(''),
  statusFilter = ref<'all' | 'open' | 'retired'>('all'),
  appliedStatus = ref<'all' | 'open' | 'retired'>('all'),
  page = ref(1)

const mode = ref<'save' | 'retire' | null>(null)
const formRef = ref<HTMLFormElement | null>(null)
const target = shallowRef<SearchMerchandisingRuleItem | null>(null)
const term = ref(''),
  kind = ref<'boost' | 'bury' | 'redirect'>('boost'),
  productId = ref(''),
  weightInput = ref<string | number>('5'),
  redirectPath = ref(''),
  validFrom = ref(''),
  validUntil = ref(''),
  reason = ref('')

const receipt = shallowRef<SearchMerchandisingRuleReceipt | null>(null)
const working = ref(false),
  looking = ref(false),
  reloadingConflict = ref(false),
  unknown = ref(false),
  retryReady = ref(false),
  conflict = ref(false)
const message = ref('')

const historyRuleId = ref<string | null>(null),
  historyTerm = ref(''),
  historyStatus = ref<'idle' | 'pending' | 'success' | 'error'>('idle'),
  historyItems = shallowRef<SearchMerchandisingRuleItem[]>([])

let alive = true,
  epoch = 0,
  readSequence = 0,
  historySequence = 0

type Intent = Readonly<{
  key: string
  owner: string
  path: string
  method: 'POST' | 'PUT' | 'DELETE'
  body: string
  expected: CommandPayload
}>
let intent: Intent | null = null

const locked = computed(() => working.value || looking.value || reloadingConflict.value || unknown.value)

function live(owner: string | null, generation: number) {
  return alive && owner !== null && actor.value === owner && epoch === generation
}

function defaultWindow() {
  const startMs = Math.floor(Date.now() / 1000) * 1000
  const endMs = startMs + 30 * DAY_MS
  return {
    from: new Date(startMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    until: new Date(endMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
}

function clearForm() {
  mode.value = null
  target.value = null
  conflict.value = false
  term.value = ''
  kind.value = 'boost'
  productId.value = ''
  weightInput.value = '5'
  redirectPath.value = ''
  validFrom.value = ''
  validUntil.value = ''
  reason.value = ''
}

function closeHistory() {
  historySequence++
  historyRuleId.value = null
  historyTerm.value = ''
  historyStatus.value = 'idle'
  historyItems.value = []
}

function reset() {
  epoch++
  readSequence++
  closeHistory()
  list.value = null
  readStatus.value = 'idle'
  clearForm()
  receipt.value = null
  message.value = ''
  intent = null
  unknown.value = false
  retryReady.value = false
  working.value = false
  looking.value = false
  reloadingConflict.value = false
  page.value = 1
}

watch(
  actor,
  () => {
    reset()
    if (actor.value) void load()
  },
  { immediate: true, flush: 'sync' }
)

onBeforeUnmount(() => {
  alive = false
  epoch++
  readSequence++
  historySequence++
})

async function load() {
  const owner = actor.value,
    generation = epoch,
    sequence = ++readSequence,
    requestedPage = page.value,
    requestedStatus = appliedStatus.value,
    requestedQuery = appliedSearch.value
  if (!owner || !alive) return
  readStatus.value = 'pending'
  list.value = null
  try {
    const raw = await request<unknown>('/api/admin/search-merchandising', {
      method: 'GET',
      query: { page: requestedPage, perPage: 25, q: requestedQuery, status: requestedStatus },
      retry: 0,
      cache: 'no-store'
    })
    if (!live(owner, generation) || sequence !== readSequence) return
    const parsed = listSchema.safeParse(catalogPolicyOwnJson(raw))
    if (!parsed.success || parsed.data.page !== requestedPage || parsed.data.perPage !== 25)
      throw new Error('invalid_list')
    list.value = parsed.data
    readStatus.value = 'success'
  } catch {
    if (live(owner, generation) && sequence === readSequence) {
      list.value = null
      readStatus.value = 'error'
    }
  }
}

function filter() {
  if (locked.value || !actor.value) return
  appliedSearch.value = search.value.trim()
  appliedStatus.value = statusFilter.value
  page.value = 1
  void load()
}

function move(delta: number) {
  if (locked.value || readStatus.value !== 'success' || !list.value) return
  page.value += delta
  void load()
}

function populateFromRule(item: SearchMerchandisingRuleItem) {
  target.value = item
  term.value = item.term
  kind.value = item.kind
  productId.value = item.productId ?? ''
  weightInput.value = item.weight !== null ? String(item.weight) : '5'
  redirectPath.value = item.redirectPath ?? ''
  validFrom.value = item.validFrom
  validUntil.value = item.validUntil
  reason.value = item.reason
}

function begin(action: 'create' | 'edit' | 'retire', item?: SearchMerchandisingRuleItem) {
  if (!actor.value || !alive || locked.value || readStatus.value !== 'success') return
  const current = item
    ? list.value?.items.find((row) => row.id === item.id && row.version === item.version && row.status !== 'retired')
    : null
  if (action !== 'create' && !current) return
  clearForm()
  receipt.value = null
  message.value = ''
  if (action === 'create') {
    const window = defaultWindow()
    mode.value = 'save'
    validFrom.value = window.from
    validUntil.value = window.until
  } else if (current) {
    populateFromRule(current)
    mode.value = action === 'retire' ? 'retire' : 'save'
    if (action === 'retire') reason.value = ''
  }
  void focusForm()
}

/** Keyboard users land in the form they just opened; the first enabled control is the start. */
async function focusForm() {
  await nextTick()
  formRef.value
    ?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
    ?.focus()
}

function buildPayload(): { success: true; data: CommandPayload } | { success: false; error: string } {
  if (mode.value === 'retire') {
    if (!target.value) return { success: false, error: 'Selecciona una regla activa para retirarla.' }
    const parsed = retireInputSchema.safeParse({
      action: 'retire',
      id: target.value.id,
      expectedVersion: target.value.version,
      reason: reason.value
    })
    if (!parsed.success) {
      return {
        success: false,
        error: 'El motivo de retirada es obligatorio (entre 3 y 500 caracteres).'
      }
    }
    return { success: true, data: parsed.data }
  }

  const rawWeight = String(weightInput.value ?? '').trim()
  const parsedWeight = kind.value === 'redirect' ? null : /^\d+$/.test(rawWeight) ? Number(rawWeight) : Number.NaN

  const candidate = {
    action: 'save' as const,
    id: target.value?.id ?? null,
    expectedVersion: target.value?.version ?? 0,
    term: term.value,
    kind: kind.value,
    productId: kind.value === 'redirect' ? null : productId.value.trim() || null,
    weight: parsedWeight,
    redirectPath: kind.value === 'redirect' ? redirectPath.value.trim() || null : null,
    reason: reason.value,
    validFrom: validFrom.value.trim(),
    validUntil: validUntil.value.trim()
  }

  const parsed = saveInputSchema.safeParse(candidate)
  if (!parsed.success) {
    const customIssue = parsed.error.issues.find((issue) => issue.code === 'custom')?.message
    if (customIssue) return { success: false, error: customIssue }
    return {
      success: false,
      error:
        'Revisa el término (2-160 caracteres), el motivo obligatorio (3-500), el destino (UUID de producto con peso 1-10 o ruta interna permitida) y las fechas ISO UTC (máx. 180 días).'
    }
  }
  return { success: true, data: parsed.data }
}

function validReceipt(raw: unknown, command: Intent): SearchMerchandisingRuleReceipt | null {
  const parsed = receiptSchema.safeParse(catalogPolicyOwnJson(raw))
  if (!parsed.success) return null
  const value = parsed.data,
    expected = command.expected
  if (
    value.action !== expected.action ||
    (expected.id !== null && value.item.id !== expected.id) ||
    value.item.version !== expected.expectedVersion + 1 ||
    value.item.reason !== expected.reason
  )
    return null
  if (expected.action === 'retire') {
    if (value.item.status !== 'retired') return null
  } else {
    if (
      value.item.status !== 'active' ||
      value.item.term !== expected.term ||
      value.item.termNormalized !== normalizeSynonymTerm(expected.term) ||
      value.item.kind !== expected.kind ||
      value.item.productId !== expected.productId ||
      value.item.weight !== expected.weight ||
      value.item.redirectPath !== expected.redirectPath ||
      value.item.validFrom !== expected.validFrom ||
      value.item.validUntil !== expected.validUntil
    )
      return null
  }
  return value
}

function failureCode(error: unknown) {
  try {
    const value = error as { data?: { error?: { code?: unknown } }; statusCode?: number; status?: number }
    return { code: value?.data?.error?.code, status: value?.statusCode ?? value?.status }
  } catch {
    return { code: undefined, status: undefined }
  }
}

/**
 * Codes the server raises before the command can commit (validation, CAS, uniqueness and
 * insert triggers, body/quota checks). Anything else, including `forbidden` (the post-insert
 * authority check can fail after the write) and 5xx, leaves the outcome unknown: lookup first.
 */
const deterministicErrorMessages: Record<string, string> = {
  invalid_input: 'El servidor rechazó los datos de la regla (revisa término, motivo, fechas máx. 180 días y destino).',
  invalid_idempotency_key: 'La clave de idempotencia no es válida.',
  idempotency_conflict: 'Conflicto de idempotencia: la clave ya se usó con otro contenido.',
  version_conflict:
    'Conflicto de versión (409): la regla fue modificada o retirada por otra operación. Recarga la versión actual antes de continuar.',
  rule_conflict: 'Ya existe otra regla activa para el mismo término y producto o redirección.',
  rule_limit: 'Se ha alcanzado el límite máximo de 20 reglas activas para este término.',
  expiry_invalid: 'La caducidad no es válida en el servidor (debe ser futura y no superar 180 días).',
  product_unavailable: 'El producto indicado no existe o no está publicado.',
  redirect_target_unavailable: 'El producto destino de la redirección no existe o no está publicado.',
  not_found: 'La regla solicitada no existe.',
  unauthenticated: 'La sesión ha caducado.',
  email_unverified: 'Se requiere correo verificado.',
  mfa_required: 'Se requiere verificación MFA.',
  csrf_rejected: 'Solicitud rechazada por protección CSRF.',
  rate_limited: 'Has superado el límite de operaciones por hora. Espera antes de reintentar.',
  abuse_control_unavailable: 'El control de uso no está disponible: el cambio no se ha aplicado. Reintenta más tarde.',
  body_too_large: 'El tamaño de la solicitud supera el límite permitido.',
  json_required: 'Formato de solicitud inválido.',
  missing_body: 'Falta el cuerpo de la solicitud.',
  invalid_json: 'El cuerpo JSON no es válido.',
  body_timeout: 'Tiempo de espera agotado al enviar la solicitud.'
}

async function confirmed(raw: unknown, command: Intent, generation: number) {
  const value = validReceipt(raw, command)
  if (!value) throw new Error('invalid_receipt')
  if (!live(command.owner, generation)) return
  receipt.value = value
  intent = null
  unknown.value = false
  retryReady.value = false
  clearForm()
  message.value = 'Recibo confirmado. Consultando el estado actual…'
  await load()
  if (live(command.owner, generation))
    message.value =
      readStatus.value === 'success'
        ? 'Recibo confirmado y estado actual leído.'
        : 'Recibo confirmado; no se ha podido confirmar el estado actual. Reintenta la lectura, no el cambio.'
}

async function send(command: Intent) {
  if (!alive || actor.value !== command.owner || working.value || looking.value || reloadingConflict.value) return
  const generation = epoch
  working.value = true
  retryReady.value = false
  conflict.value = false
  message.value = ''
  try {
    const raw = await request<unknown>(command.path, {
      method: command.method,
      body: JSON.parse(command.body),
      headers: { 'Idempotency-Key': command.key },
      retry: 0
    })
    if (live(command.owner, generation)) await confirmed(raw, command, generation)
  } catch (error) {
    if (!live(command.owner, generation)) return
    const { code } = failureCode(error)
    if (typeof code === 'string' && code in deterministicErrorMessages) {
      intent = null
      unknown.value = false
      retryReady.value = false
      if (code === 'version_conflict') {
        conflict.value = true
        message.value = deterministicErrorMessages[code]!
      } else {
        message.value = deterministicErrorMessages[code]!
        await load()
      }
    } else {
      unknown.value = true
      message.value =
        'Resultado desconocido. Consulta el recibo del comando antes de reenviar; no envíes un comando nuevo.'
    }
  } finally {
    if (live(command.owner, generation)) working.value = false
  }
}

async function submit() {
  if (!actor.value || !alive || locked.value || !mode.value) return
  conflict.value = false
  const validated = buildPayload()
  if (!validated.success) {
    message.value = validated.error
    return
  }
  const payload = validated.data
  intent = Object.freeze({
    key: randomId(),
    owner: actor.value,
    path: '/api/admin/search-merchandising' + (payload.id ? '/' + payload.id : ''),
    method: payload.action === 'retire' ? 'DELETE' : payload.id ? 'PUT' : 'POST',
    body: JSON.stringify(payload),
    expected: payload
  })
  await send(intent)
}

async function reloadConflict() {
  const currentTarget = target.value,
    owner = actor.value,
    generation = epoch
  if (!currentTarget || !owner || !alive || working.value || looking.value || reloadingConflict.value) return
  reloadingConflict.value = true
  message.value = ''
  try {
    const raw = await request<unknown>('/api/admin/search-merchandising/' + encodeURIComponent(currentTarget.id), {
      method: 'GET',
      retry: 0,
      cache: 'no-store'
    })
    if (!live(owner, generation)) return
    const parsed = singleItemSchema.safeParse(catalogPolicyOwnJson(raw))
    if (!parsed.success) throw new Error('invalid_rule')
    await load()
    if (!live(owner, generation)) return
    conflict.value = false
    if (parsed.data.item.status === 'retired') {
      clearForm()
      message.value = 'La regla ya fue retirada en otra sesión. Se ha actualizado la lista.'
    } else {
      populateFromRule(parsed.data.item)
      message.value = `Versión ${parsed.data.item.version} recargada. Revisa los datos actuales antes de guardar.`
    }
  } catch {
    if (live(owner, generation))
      message.value = 'No se ha podido recargar la versión actual de la regla. Inténtalo de nuevo.'
  } finally {
    if (live(owner, generation)) reloadingConflict.value = false
  }
}

async function lookup() {
  const command = intent
  if (!command || !unknown.value || working.value || looking.value || actor.value !== command.owner || !alive) return
  const generation = epoch
  looking.value = true
  retryReady.value = false
  try {
    const raw = await request<unknown>('/api/admin/search-merchandising/commands/' + encodeURIComponent(command.key), {
      method: 'GET',
      retry: 0,
      cache: 'no-store'
    })
    if (live(command.owner, generation)) await confirmed(raw, command, generation)
  } catch (error) {
    if (!live(command.owner, generation)) return
    const failure = failureCode(error)
    if (failure.status === 404 && failure.code === 'not_found') {
      retryReady.value = true
      message.value = 'Recibo no encontrado. Puedes reenviar exactamente el mismo comando con su clave original.'
    } else {
      message.value =
        'No se ha podido confirmar el recibo. El resultado sigue desconocido; no se reenvía automáticamente.'
    }
  } finally {
    if (live(command.owner, generation)) looking.value = false
  }
}

async function retry() {
  if (intent && retryReady.value && unknown.value) await send(intent)
}

async function openHistory(item: SearchMerchandisingRuleItem) {
  if (!actor.value || !alive || locked.value) return
  historyRuleId.value = item.id
  historyTerm.value = item.term
  await loadHistory(item.id)
}

async function loadHistory(id: string) {
  const owner = actor.value,
    generation = epoch,
    sequence = ++historySequence
  if (!owner || !alive) return
  historyStatus.value = 'pending'
  historyItems.value = []
  try {
    const raw = await request<unknown>('/api/admin/search-merchandising/' + encodeURIComponent(id) + '/history', {
      method: 'GET',
      retry: 0,
      cache: 'no-store'
    })
    if (!live(owner, generation) || sequence !== historySequence) return
    const parsed = historySchema.safeParse(catalogPolicyOwnJson(raw))
    if (!parsed.success) throw new Error('invalid_history')
    historyItems.value = parsed.data.items
    historyStatus.value = 'success'
  } catch {
    if (live(owner, generation) && sequence === historySequence) {
      historyItems.value = []
      historyStatus.value = 'error'
    }
  }
}

function stateLabel(state: SearchMerchandisingRuleItem['state']) {
  switch (state) {
    case 'live':
      return 'Activa'
    case 'scheduled':
      return 'Programada'
    case 'expired':
      return 'Caducada'
    case 'retired':
      return 'Retirada'
  }
}

function kindLabel(ruleKind: SearchMerchandisingRuleItem['kind']) {
  switch (ruleKind) {
    case 'boost':
      return 'Boost (promocionar)'
    case 'bury':
      return 'Bury (relegar)'
    case 'redirect':
      return 'Redirección interna'
  }
}
</script>

<template>
  <section
    aria-label="Reglas de resultados"
    data-merchandising-panel
    class="min-w-0 space-y-5 break-words border-t border-[var(--border)] pt-6"
  >
    <div>
      <h2 class="text-xl font-semibold">Reglas de resultados</h2>
      <p class="text-sm text-[var(--text-muted)]">
        Ajusta el orden de productos (boost o bury con peso 1-10) o redirige consultas a rutas internas de la tienda.
        Todas las reglas exigen motivo y fecha de caducidad (máximo 180 días) y nunca promocionan productos no
        vendibles.
      </p>
    </div>

    <p v-if="!actor" role="alert">
      Necesitas el permiso vigente de catálogo, correo verificado y MFA para consultar y modificar reglas de resultados.
    </p>

    <template v-else>
      <form data-merchandising-search-form class="flex flex-wrap items-end gap-2" @submit.prevent="filter">
        <div>
          <label :for="prefix + '-search'" class="block text-sm">Buscar término</label>
          <input
            :id="prefix + '-search'"
            v-model="search"
            data-merchandising-search
            maxlength="160"
            :disabled="locked"
            class="min-w-0 rounded border p-2"
          />
        </div>
        <div>
          <label :for="prefix + '-status'" class="block text-sm">Estado de reglas</label>
          <select
            :id="prefix + '-status'"
            v-model="statusFilter"
            data-merchandising-status-filter
            :disabled="locked"
            class="rounded border p-2"
          >
            <option value="all">Todas (activas, programadas, caducadas y retiradas)</option>
            <option value="open">Abiertas (activas, programadas y caducadas)</option>
            <option value="retired">Retiradas</option>
          </select>
        </div>
        <button type="submit" :disabled="locked" class="rounded border px-3 py-2">Filtrar</button>
      </form>

      <p v-if="readStatus === 'pending'" role="status">Consultando reglas de resultados…</p>

      <div v-else-if="readStatus === 'error'" role="alert" class="space-y-2">
        <p>No se ha podido confirmar la lista de reglas. Un error no significa que esté vacía.</p>
        <button
          data-merchandising-read-retry
          type="button"
          :disabled="working || looking || reloadingConflict"
          class="rounded border p-2"
          @click="load"
        >
          Reintentar lectura
        </button>
      </div>

      <div v-else-if="readStatus === 'success' && list" class="space-y-4">
        <button
          data-merchandising-create
          type="button"
          :disabled="locked"
          class="rounded border p-2"
          @click="begin('create')"
        >
          Nueva regla de resultados
        </button>

        <p v-if="!list.items.length">No hay reglas de resultados que coincidan con este filtro.</p>

        <ul v-else data-merchandising-list class="min-w-0 divide-y break-words">
          <li
            v-for="item in list.items"
            :key="item.id"
            :data-merchandising-row="item.id"
            class="flex min-w-0 flex-wrap items-start justify-between gap-3 py-3"
          >
            <div class="min-w-0 flex-1 space-y-1">
              <p class="font-medium">
                <span>{{ item.term }}</span>
                · <span>{{ stateLabel(item.state) }}</span> · <span>{{ kindLabel(item.kind) }}</span>
              </p>
              <p class="text-sm">
                <template v-if="item.kind === 'redirect'"> Ruta interna: {{ item.redirectPath }} </template>
                <template v-else> Producto: {{ item.productId }} · Peso: {{ item.weight }} </template>
              </p>
              <p class="text-xs text-[var(--text-muted)]">
                Versión {{ item.version }} · Vigencia: {{ item.validFrom }} → {{ item.validUntil }} · Motivo:
                {{ item.reason }}
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
              <template v-if="item.status !== 'retired'">
                <button
                  data-merchandising-edit
                  type="button"
                  :disabled="locked"
                  class="rounded border p-2"
                  @click="begin('edit', item)"
                >
                  Editar {{ item.term }}
                </button>
                <button
                  data-merchandising-retire
                  type="button"
                  :disabled="locked"
                  class="rounded border p-2"
                  @click="begin('retire', item)"
                >
                  Retirar {{ item.term }}
                </button>
              </template>
              <button
                data-merchandising-history-open
                type="button"
                :disabled="locked"
                class="rounded border p-2"
                @click="openHistory(item)"
              >
                Historial {{ item.term }}
              </button>
            </div>
          </li>
        </ul>

        <nav aria-label="Páginas de reglas de resultados" class="flex flex-wrap items-center gap-3">
          <button
            data-merchandising-prev
            type="button"
            :disabled="locked || list.page <= 1"
            class="rounded border p-2"
            @click="move(-1)"
          >
            Anterior
          </button>
          <span>Página {{ list.page }} · {{ list.total }} reglas</span>
          <button
            data-merchandising-next
            type="button"
            :disabled="locked || list.page * list.perPage >= list.total"
            class="rounded border p-2"
            @click="move(1)"
          >
            Siguiente
          </button>
        </nav>
      </div>

      <form
        v-if="mode"
        ref="formRef"
        data-merchandising-form
        class="space-y-3 rounded border p-4"
        @submit.prevent="submit"
      >
        <h3 class="font-semibold">
          {{
            mode === 'retire'
              ? 'Retirar regla'
              : target
                ? `Editar regla (versión esperada ${target.version})`
                : 'Nueva regla de resultados'
          }}
        </h3>
        <p class="text-sm text-[var(--text-muted)]">
          El motivo y la caducidad son obligatorios. La caducidad debe ser futura, la vigencia (inicio a caducidad) no
          puede superar 180 días y la caducidad no puede estar a más de 180 días de ahora.
        </p>

        <div v-if="conflict" data-merchandising-conflict role="alert" class="space-y-2 rounded border p-3">
          <p>
            Se ha detectado un conflicto de versión (409). Otro operador ha modificado o retirado esta regla mientras la
            editabas.
          </p>
          <button
            data-merchandising-conflict-reload
            type="button"
            :disabled="working || looking || reloadingConflict"
            class="rounded border p-2"
            @click="reloadConflict"
          >
            Recargar versión actual
          </button>
        </div>

        <template v-if="mode === 'save'">
          <div>
            <label :for="prefix + '-term'">Término de búsqueda</label>
            <input
              :id="prefix + '-term'"
              v-model="term"
              data-merchandising-term
              maxlength="160"
              required
              :disabled="locked"
              class="block w-full min-w-0 rounded border p-2"
            />
          </div>

          <div>
            <label :for="prefix + '-kind'">Tipo de regla</label>
            <select
              :id="prefix + '-kind'"
              v-model="kind"
              data-merchandising-kind
              :disabled="locked"
              class="block w-full min-w-0 rounded border p-2"
            >
              <option value="boost">Boost (promocionar producto)</option>
              <option value="bury">Bury (relegar producto)</option>
              <option value="redirect">Redirect (redirigir a ruta interna)</option>
            </select>
          </div>

          <template v-if="kind !== 'redirect'">
            <div>
              <label :for="prefix + '-product'">UUID del producto publicado</label>
              <input
                :id="prefix + '-product'"
                v-model="productId"
                data-merchandising-product-id
                required
                :disabled="locked"
                placeholder="10000000-0000-4000-8000-000000000001"
                class="block w-full min-w-0 rounded border p-2"
              />
            </div>
            <div>
              <label :for="prefix + '-weight'">Peso (1 a 10)</label>
              <input
                :id="prefix + '-weight'"
                v-model="weightInput"
                data-merchandising-weight
                type="number"
                min="1"
                max="10"
                required
                :disabled="locked"
                class="block w-full min-w-0 rounded border p-2"
              />
            </div>
          </template>

          <div v-else>
            <label :for="prefix + '-redirect'"
              >Ruta interna permitida (/catalogo, /contenido, /recursos o /producto/slug)</label
            >
            <input
              :id="prefix + '-redirect'"
              v-model="redirectPath"
              data-merchandising-redirect-path
              maxlength="300"
              required
              :disabled="locked"
              placeholder="/catalogo?familia=desinfeccion"
              class="block w-full min-w-0 rounded border p-2"
            />
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label :for="prefix + '-valid-from'">Inicio de vigencia (UTC ISO)</label>
              <input
                :id="prefix + '-valid-from'"
                v-model="validFrom"
                data-merchandising-valid-from
                required
                :disabled="locked"
                placeholder="2026-10-29T00:00:00Z"
                class="block w-full min-w-0 rounded border p-2"
              />
            </div>
            <div>
              <label :for="prefix + '-valid-until'">Caducidad obligatoria (UTC ISO, máx. 180 días)</label>
              <input
                :id="prefix + '-valid-until'"
                v-model="validUntil"
                data-merchandising-valid-until
                required
                :disabled="locked"
                placeholder="2026-12-29T00:00:00Z"
                class="block w-full min-w-0 rounded border p-2"
              />
            </div>
          </div>
        </template>

        <p v-else class="text-sm">
          Vas a retirar la regla para <strong>{{ target?.term }}</strong> (versión {{ target?.version }}). La retirada
          es permanente y queda registrada en el historial auditado.
        </p>

        <div>
          <label :for="prefix + '-reason'">Motivo obligatorio (3 a 500 caracteres)</label>
          <textarea
            :id="prefix + '-reason'"
            v-model="reason"
            data-merchandising-reason
            required
            maxlength="500"
            :disabled="locked"
            class="block w-full min-w-0 rounded border p-2"
          />
        </div>

        <div class="flex flex-wrap gap-2">
          <button data-merchandising-submit type="submit" :disabled="locked" class="rounded border p-2">
            {{
              working
                ? 'Enviando…'
                : mode === 'retire'
                  ? 'Confirmar retirada'
                  : target
                    ? 'Guardar cambios'
                    : 'Crear regla'
            }}
          </button>
          <button type="button" :disabled="locked" class="rounded border p-2" @click="clearForm">Cancelar</button>
        </div>
      </form>

      <div v-if="unknown" class="space-y-2 rounded border p-4">
        <button
          data-merchandising-lookup
          type="button"
          :disabled="working || looking"
          class="rounded border p-2"
          @click="lookup"
        >
          Consultar recibo del comando
        </button>
        <button
          v-if="retryReady"
          data-merchandising-command-retry
          type="button"
          :disabled="working || looking"
          class="rounded border p-2"
          @click="retry"
        >
          Reenviar exactamente el mismo comando
        </button>
      </div>

      <p v-if="message" role="status" aria-live="polite">{{ message }}</p>

      <div v-if="receipt" class="min-w-0 rounded border p-3 [overflow-wrap:anywhere]">
        <h3 class="font-semibold">Recibo confirmado</h3>
        <p>Comando: {{ receipt.commandId }}</p>
        <p>{{ receipt.item.term }} · versión {{ receipt.item.version }} · {{ receipt.action }}</p>
      </div>

      <section
        v-if="historyRuleId"
        data-merchandising-history
        aria-label="Historial de la regla"
        class="space-y-3 rounded border p-4"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="font-semibold">Historial de la regla: {{ historyTerm }}</h3>
          <button data-merchandising-history-close type="button" class="rounded border px-2 py-1" @click="closeHistory">
            Cerrar historial
          </button>
        </div>
        <p v-if="historyStatus === 'pending'" role="status">Consultando historial…</p>
        <div v-else-if="historyStatus === 'error'" role="alert" class="space-y-2">
          <p>No se ha podido cargar el historial de la regla.</p>
          <button
            data-merchandising-history-retry
            type="button"
            class="rounded border p-2"
            @click="loadHistory(historyRuleId)"
          >
            Reintentar historial
          </button>
        </div>
        <ol v-else-if="historyStatus === 'success'" class="divide-y">
          <li v-for="rev in historyItems" :key="rev.version" class="py-2 text-sm">
            <p class="font-medium">
              Versión {{ rev.version }} · {{ stateLabel(rev.state) }} · {{ kindLabel(rev.kind) }}
            </p>
            <p>
              <template v-if="rev.kind === 'redirect'">Ruta: {{ rev.redirectPath }}</template>
              <template v-else>Producto: {{ rev.productId }} · Peso: {{ rev.weight }}</template>
            </p>
            <p class="text-xs text-[var(--text-muted)]">
              Vigencia: {{ rev.validFrom }} → {{ rev.validUntil }} · Actualizado: {{ rev.updatedAt }} · Autor:
              {{ rev.authorId }}
            </p>
            <p>Motivo: {{ rev.reason }}</p>
          </li>
        </ol>
      </section>
    </template>
  </section>
</template>
