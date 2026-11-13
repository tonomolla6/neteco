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
        'Revisa la búsqueda (2-160 caracteres), el motivo obligatorio (3-500), el destino (identificador de producto con peso 1-10 o ruta interna permitida) y las fechas (máx. 180 días).'
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
  invalid_idempotency_key: 'El envío no era válido. Vuelve a intentarlo.',
  idempotency_conflict: 'Este envío ya se había usado con otros datos. Vuelve a preparar el cambio.',
  version_conflict:
    'Otra persona ha cambiado o retirado esta regla mientras la editabas. Carga la versión actual antes de continuar.',
  rule_conflict: 'Ya existe otra regla activa para el mismo término y producto o redirección.',
  rule_limit: 'Se ha alcanzado el límite máximo de 20 reglas activas para este término.',
  expiry_invalid: 'La caducidad no es válida en el servidor (debe ser futura y no superar 180 días).',
  product_unavailable: 'El producto indicado no existe o no está publicado.',
  redirect_target_unavailable: 'El producto destino de la redirección no existe o no está publicado.',
  not_found: 'La regla solicitada no existe.',
  unauthenticated: 'La sesión ha caducado.',
  email_unverified: 'Se requiere correo verificado.',
  mfa_required: 'Hace falta la verificación en dos pasos.',
  csrf_rejected: 'La sesión no ha validado el envío. Recarga la página y vuelve a intentarlo.',
  rate_limited: 'Has superado el límite de operaciones por hora. Espera antes de reintentar.',
  abuse_control_unavailable: 'El control de uso no está disponible: el cambio no se ha aplicado. Reintenta más tarde.',
  body_too_large: 'El tamaño de la solicitud supera el límite permitido.',
  json_required: 'El envío no tenía el formato correcto.',
  missing_body: 'El envío llegó vacío.',
  invalid_json: 'El envío no tenía el formato correcto.',
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
  message.value = 'Recibo confirmado. Actualizando la lista…'
  await load()
  if (live(command.owner, generation))
    message.value =
      readStatus.value === 'success'
        ? 'Recibo confirmado: el cambio se ha guardado.'
        : 'Recibo confirmado: el cambio se ha guardado, pero no se ha podido actualizar la lista. Recarga la lista; no repitas el cambio.'
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
        'Resultado desconocido: no sabemos si el cambio se ha guardado. Compruébalo antes de volver a enviarlo.'
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
      message.value = 'El cambio no llegó a guardarse. Puedes volver a enviarlo tal cual.'
    } else {
      message.value =
        'No se ha podido comprobar. El resultado sigue desconocido; vuelve a comprobarlo en unos segundos.'
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
      return 'Subir producto'
    case 'bury':
      return 'Bajar producto'
    case 'redirect':
      return 'Llevar a otra página'
  }
}

const STATE_TONES = { live: 'success', scheduled: 'info', expired: 'warning', retired: 'neutral' } as const
const shortId = (id: string | null | undefined) => (id ? `#${id.slice(0, 8).toUpperCase()}` : '—')
const formTitle = computed(() =>
  mode.value === 'retire' ? 'Retirar regla' : target.value ? 'Editar regla' : 'Nueva regla'
)
</script>

<template>
  <section aria-label="Reglas de resultados" data-merchandising-panel class="adm-stack min-w-0">
    <UAlert
      v-if="!actor"
      role="alert"
      color="warning"
      variant="subtle"
      icon="i-lucide-lock"
      title="No puedes gestionar las reglas de resultados con esta sesión"
      description="Necesitas permiso de catálogo, el correo verificado y la verificación en dos pasos (MFA) activa."
    />

    <template v-else>
      <UAlert
        v-if="message"
        role="status"
        aria-live="polite"
        color="neutral"
        variant="subtle"
        icon="i-lucide-info"
        :title="message"
      />

      <div v-if="unknown" class="adm-card">
        <div class="adm-card__body flex flex-wrap items-center gap-2">
          <p class="min-w-0 flex-1 basis-64 text-[var(--text)]">
            Antes de repetir el cambio, comprueba si llegó a guardarse.
          </p>
          <button
            data-merchandising-lookup
            type="button"
            :disabled="working || looking"
            class="adm-btn adm-btn--secondary"
            @click="lookup"
          >
            Comprobar si se guardó
          </button>
          <button
            v-if="retryReady"
            data-merchandising-command-retry
            type="button"
            :disabled="working || looking"
            class="adm-btn adm-btn--primary"
            @click="retry"
          >
            Volver a enviar el mismo cambio
          </button>
        </div>
      </div>

      <UAlert
        v-if="receipt"
        color="success"
        variant="subtle"
        icon="i-lucide-circle-check"
        :title="`Último cambio guardado: regla para «${receipt.item.term}»${receipt.action === 'retire' ? ' retirada' : ''}`"
        :description="`Referencia ${shortId(receipt.commandId)}`"
        class="[overflow-wrap:anywhere]"
      />

      <div
        class="grid min-w-0 items-start gap-5"
        :class="(mode || historyRuleId) && 'xl:grid-cols-[minmax(0,1fr)_26rem]'"
      >
        <div class="adm-card adm-tablecard min-w-0">
          <div class="adm-tablecard__bar">
            <div class="adm-toolbar">
              <form data-merchandising-search-form class="contents" role="search" @submit.prevent="filter">
                <label class="adm-toolbar__search" :for="prefix + '-search'">
                  <span class="sr-only">Buscar por la búsqueda del cliente</span>
                  <UIcon name="i-lucide-search" class="size-4" />
                  <input
                    :id="prefix + '-search'"
                    v-model="search"
                    data-merchandising-search
                    data-slot="adm-search"
                    type="search"
                    placeholder="Buscar una regla…"
                    maxlength="160"
                    :disabled="locked"
                  />
                </label>
                <label :for="prefix + '-status'" class="sr-only">Estado de las reglas</label>
                <select
                  :id="prefix + '-status'"
                  v-model="statusFilter"
                  data-merchandising-status-filter
                  :disabled="locked"
                  class="adm-input w-auto"
                >
                  <option value="all">Todas</option>
                  <option value="open">Sin retirar</option>
                  <option value="retired">Retiradas</option>
                </select>
                <button type="submit" :disabled="locked" class="adm-btn adm-btn--secondary">Aplicar</button>
              </form>
              <div v-if="readStatus === 'success' && list" class="adm-toolbar__end">
                <button
                  data-merchandising-create
                  type="button"
                  :disabled="locked"
                  class="adm-btn adm-btn--primary"
                  @click="begin('create')"
                >
                  <UIcon name="i-lucide-plus" class="size-4 shrink-0" />Nueva regla
                </button>
              </div>
            </div>
          </div>

          <div v-if="readStatus === 'pending'" class="adm-table-skeleton" role="status" aria-busy="true">
            <span class="sr-only">Cargando reglas de resultados…</span>
            <div v-for="row in 5" :key="row"><i /><i /><i /><i /></div>
          </div>

          <div v-else-if="readStatus === 'error'" role="alert">
            <AdminEmptyState
              variant="error"
              title="No se ha podido confirmar la lista de reglas"
              description="Es un fallo de carga: no significa que la lista esté vacía."
            >
              <button
                data-merchandising-read-retry
                type="button"
                :disabled="working || looking || reloadingConflict"
                class="adm-btn adm-btn--secondary"
                @click="load"
              >
                <UIcon name="i-lucide-rotate-cw" class="size-4 shrink-0" />Reintentar
              </button>
            </AdminEmptyState>
          </div>

          <template v-else-if="readStatus === 'success' && list">
            <AdminEmptyState
              v-if="!list.items.length"
              :variant="appliedSearch || appliedStatus !== 'all' ? 'filtered' : 'empty'"
              icon="i-lucide-arrow-up-down"
              title="No hay reglas que mostrar"
              :description="
                appliedSearch || appliedStatus !== 'all'
                  ? 'Ninguna regla coincide con este filtro.'
                  : 'Crea una regla para subir o bajar un producto en una búsqueda concreta, o para llevar esa búsqueda a otra página de la tienda.'
              "
            />

            <div v-else class="adm-table-wrap">
              <table data-merchandising-list class="adm-table min-w-0 break-words">
                <thead>
                  <tr>
                    <th scope="col">Cuando el cliente busca</th>
                    <th scope="col">Qué hace la regla</th>
                    <th scope="col">Vigencia</th>
                    <th scope="col">Estado</th>
                    <th scope="col" data-numeric><span class="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in list.items" :key="item.id" :data-merchandising-row="item.id">
                    <td>
                      <p class="font-semibold text-[var(--text-strong)]">{{ item.term }}</p>
                      <p class="adm-help">{{ item.reason }}</p>
                    </td>
                    <td>
                      <p>{{ kindLabel(item.kind) }}</p>
                      <p class="adm-help">
                        <template v-if="item.kind === 'redirect'">{{ item.redirectPath }}</template>
                        <template v-else>Producto {{ shortId(item.productId) }} · peso {{ item.weight }}</template>
                      </p>
                    </td>
                    <td class="whitespace-nowrap">
                      {{ adminDate(item.validFrom) }} – {{ adminDate(item.validUntil) }}
                    </td>
                    <td>
                      <AdminBadge :tone="STATE_TONES[item.state]">{{ stateLabel(item.state) }}</AdminBadge>
                    </td>
                    <td data-numeric class="adm-table__actions">
                      <div class="flex flex-wrap justify-end gap-1.5">
                        <template v-if="item.status !== 'retired'">
                          <button
                            data-merchandising-edit
                            type="button"
                            :disabled="locked"
                            :aria-label="`Editar la regla de ${item.term}`"
                            class="adm-btn adm-btn--secondary adm-btn--sm"
                            @click="begin('edit', item)"
                          >
                            Editar
                          </button>
                          <button
                            data-merchandising-retire
                            type="button"
                            :disabled="locked"
                            :aria-label="`Retirar la regla de ${item.term}`"
                            class="adm-btn adm-btn--danger-soft adm-btn--sm"
                            @click="begin('retire', item)"
                          >
                            Retirar
                          </button>
                        </template>
                        <button
                          data-merchandising-history-open
                          type="button"
                          :disabled="locked"
                          :aria-label="`Ver los cambios de la regla de ${item.term}`"
                          class="adm-btn adm-btn--ghost adm-btn--sm"
                          @click="openHistory(item)"
                        >
                          Cambios
                        </button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <nav aria-label="Páginas de reglas de resultados" class="adm-pagination">
              <p>{{ list.total }} {{ list.total === 1 ? 'regla' : 'reglas' }}</p>
              <div class="flex items-center gap-2">
                <button
                  data-merchandising-prev
                  type="button"
                  :disabled="locked || list.page <= 1"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  @click="move(-1)"
                >
                  Anterior
                </button>
                <span class="tabular-nums">Página {{ list.page }}</span>
                <button
                  data-merchandising-next
                  type="button"
                  :disabled="locked || list.page * list.perPage >= list.total"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  @click="move(1)"
                >
                  Siguiente
                </button>
              </div>
            </nav>
          </template>
        </div>

        <div v-if="mode || historyRuleId" class="adm-stack min-w-0">
          <AdminCard
            v-if="mode"
            :title="formTitle"
            description="El motivo y la fecha de fin son obligatorios. Una regla dura como máximo 180 días y nunca destaca productos que no se pueden vender."
          >
            <form
              :id="prefix + '-form'"
              ref="formRef"
              data-merchandising-form
              class="adm-stack"
              @submit.prevent="submit"
            >
              <div v-if="conflict" data-merchandising-conflict role="alert" class="adm-stack">
                <UAlert
                  color="warning"
                  variant="subtle"
                  icon="i-lucide-triangle-alert"
                  title="Otra persona ha cambiado esta regla"
                  description="Hay un conflicto de versión: la regla se modificó o se retiró mientras la editabas. Carga la versión actual para continuar."
                />
                <div>
                  <button
                    data-merchandising-conflict-reload
                    type="button"
                    :disabled="working || looking || reloadingConflict"
                    class="adm-btn adm-btn--secondary"
                    @click="reloadConflict"
                  >
                    Cargar la versión actual
                  </button>
                </div>
              </div>

              <template v-if="mode === 'save'">
                <div class="adm-field">
                  <label :for="prefix + '-term'" class="adm-label">Cuando el cliente busca</label>
                  <input
                    :id="prefix + '-term'"
                    v-model="term"
                    data-merchandising-term
                    maxlength="160"
                    required
                    :disabled="locked"
                    class="w-full min-w-0"
                  />
                </div>

                <div class="adm-field">
                  <label :for="prefix + '-kind'" class="adm-label">Qué hace la regla</label>
                  <select
                    :id="prefix + '-kind'"
                    v-model="kind"
                    data-merchandising-kind
                    :disabled="locked"
                    class="w-full min-w-0"
                  >
                    <option value="boost">Subir un producto en los resultados</option>
                    <option value="bury">Bajar un producto en los resultados</option>
                    <option value="redirect">Llevar la búsqueda a otra página de la tienda</option>
                  </select>
                </div>

                <template v-if="kind !== 'redirect'">
                  <div class="adm-field">
                    <label :for="prefix + '-product'" class="adm-label">Identificador del producto publicado</label>
                    <input
                      :id="prefix + '-product'"
                      v-model="productId"
                      data-merchandising-product-id
                      required
                      :disabled="locked"
                      placeholder="10000000-0000-4000-8000-000000000001"
                      class="w-full min-w-0"
                    />
                  </div>
                  <div class="adm-field">
                    <label :for="prefix + '-weight'" class="adm-label">Fuerza de la regla (1 a 10)</label>
                    <input
                      :id="prefix + '-weight'"
                      v-model="weightInput"
                      data-merchandising-weight
                      type="number"
                      min="1"
                      max="10"
                      required
                      :disabled="locked"
                      class="w-full min-w-0"
                    />
                  </div>
                </template>

                <div v-else class="adm-field">
                  <label :for="prefix + '-redirect'" class="adm-label">Página de destino</label>
                  <input
                    :id="prefix + '-redirect'"
                    v-model="redirectPath"
                    data-merchandising-redirect-path
                    maxlength="300"
                    required
                    :aria-describedby="prefix + '-redirect-help'"
                    :disabled="locked"
                    placeholder="/catalogo?familia=desinfeccion"
                    class="w-full min-w-0"
                  />
                  <p :id="prefix + '-redirect-help'" class="adm-help">
                    Solo páginas de la tienda: /catalogo, /contenido, /recursos o /producto/nombre-del-producto.
                  </p>
                </div>

                <div class="adm-form-grid">
                  <div class="adm-field">
                    <label :for="prefix + '-valid-from'" class="adm-label">Empieza</label>
                    <input
                      :id="prefix + '-valid-from'"
                      v-model="validFrom"
                      data-merchandising-valid-from
                      required
                      :disabled="locked"
                      placeholder="2026-10-29T00:00:00Z"
                      class="w-full min-w-0"
                    />
                  </div>
                  <div class="adm-field">
                    <label :for="prefix + '-valid-until'" class="adm-label">Termina</label>
                    <input
                      :id="prefix + '-valid-until'"
                      v-model="validUntil"
                      data-merchandising-valid-until
                      required
                      :disabled="locked"
                      placeholder="2026-12-29T00:00:00Z"
                      class="w-full min-w-0"
                    />
                  </div>
                </div>
                <p class="adm-help">
                  Fechas en hora universal con el formato del ejemplo (año-mes-díaThora:minuto:segundoZ).
                </p>
              </template>

              <p v-else>
                Vas a retirar la regla de <strong>{{ target?.term }}</strong
                >. No se puede deshacer y queda anotado en sus cambios.
              </p>

              <div class="adm-field">
                <label :for="prefix + '-reason'" class="adm-label">Motivo</label>
                <textarea
                  :id="prefix + '-reason'"
                  v-model="reason"
                  data-merchandising-reason
                  required
                  maxlength="500"
                  :aria-describedby="prefix + '-reason-help'"
                  :disabled="locked"
                  class="w-full min-w-0"
                />
                <p :id="prefix + '-reason-help'" class="adm-help">Obligatorio, entre 3 y 500 caracteres.</p>
              </div>
            </form>
            <template #footer>
              <button type="button" :disabled="locked" class="adm-btn adm-btn--secondary" @click="clearForm">
                Cancelar
              </button>
              <button
                data-merchandising-submit
                type="submit"
                :form="prefix + '-form'"
                :disabled="locked"
                class="adm-btn"
                :class="mode === 'retire' ? 'adm-btn--danger' : 'adm-btn--primary'"
              >
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
            </template>
          </AdminCard>

          <section v-if="historyRuleId" data-merchandising-history aria-label="Historial de la regla" class="adm-card">
            <div class="adm-card__head">
              <div class="min-w-0">
                <h2 class="adm-card__title">Cambios de la regla</h2>
                <p class="adm-card__hint">{{ historyTerm }}</p>
              </div>
              <button
                data-merchandising-history-close
                type="button"
                class="adm-btn adm-btn--ghost adm-btn--sm"
                @click="closeHistory"
              >
                Cerrar
              </button>
            </div>
            <div class="adm-card__body adm-card__body--flush">
              <div v-if="historyStatus === 'pending'" class="adm-table-skeleton" role="status" aria-busy="true">
                <span class="sr-only">Cargando los cambios…</span>
                <div v-for="row in 3" :key="row"><i /><i /></div>
              </div>
              <div v-else-if="historyStatus === 'error'" role="alert">
                <AdminEmptyState variant="error" compact title="No se ha podido cargar el historial de la regla">
                  <button
                    data-merchandising-history-retry
                    type="button"
                    class="adm-btn adm-btn--secondary"
                    @click="loadHistory(historyRuleId)"
                  >
                    <UIcon name="i-lucide-rotate-cw" class="size-4 shrink-0" />Reintentar
                  </button>
                </AdminEmptyState>
              </div>
              <ol v-else-if="historyStatus === 'success'" class="adm-list">
                <li v-for="rev in historyItems" :key="rev.version">
                  <div class="min-w-0 flex-1">
                    <p class="adm-list__title">
                      Versión {{ rev.version }}
                      <AdminBadge :tone="STATE_TONES[rev.state]">{{ stateLabel(rev.state) }}</AdminBadge>
                    </p>
                    <p>
                      {{ kindLabel(rev.kind) }} ·
                      <template v-if="rev.kind === 'redirect'">{{ rev.redirectPath }}</template>
                      <template v-else>producto {{ shortId(rev.productId) }} · peso {{ rev.weight }}</template>
                    </p>
                    <p>Motivo: {{ rev.reason }}</p>
                    <p class="adm-help">
                      Del {{ adminDate(rev.validFrom) }} al {{ adminDate(rev.validUntil) }} · cambiado el
                      {{ adminDate(rev.updatedAt, true) }} por {{ shortId(rev.authorId) }}
                    </p>
                  </div>
                </li>
              </ol>
            </div>
          </section>
        </div>
      </div>
    </template>
  </section>
</template>
