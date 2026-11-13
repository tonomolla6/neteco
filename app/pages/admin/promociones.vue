<script setup lang="ts">
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import PromotionBasketSimulator from '~/components/PromotionBasketSimulator.vue'
import { adminCapabilitiesSchema } from '~~/shared/admin-navigation'
import {
  adminPromotionListSchema,
  adminPromotionDetailSchema,
  adminPromotionInputSchema,
  adminPromotionReceiptSchema,
  adminPromotionCommandSchema,
  adminPromotionPreviewSchema,
  adminPromotionIntentHash,
  type AdminPromotionInput,
  type AdminPromotionDetail,
  type AdminPromotionReceipt
} from '~~/shared/admin-promotions'
import { promotionContextSchema, promotionRuleSchema, type PromotionRule } from '~~/shared/promotions'
import type { AdminTone } from '~/utils/adminLabels'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Promociones · Admin' })
const runtime = useRuntimeConfig().public.serverRuntime
const request = useRequestFetch(),
  navigation = useAdminNavigation()
const { ready, loggedIn, user, session } = useUserSession()
const caps = computed(() => {
  const parsed = adminCapabilitiesSchema.safeParse(navigation.capabilities.value)
  return parsed.success ? parsed.data : null
})
const scope = computed(() =>
  JSON.stringify([
    runtime,
    ready.value,
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified,
    user.value?.mfaVerified,
    session.value?.sessionId,
    session.value?.sessionVersion,
    caps.value,
    navigation.status.value
  ])
)
const revoked = ref<string | null>(null)
const authorized = computed(
  () =>
    runtime === 'cloudflare' &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true &&
    caps.value?.state === 'ready' &&
    navigation.status.value === 'ready' &&
    caps.value.identityId === user.value?.id &&
    caps.value.sessionId === session.value?.sessionId &&
    caps.value.sessionVersion === session.value?.sessionVersion &&
    caps.value.permissions.includes('administration.manage') &&
    revoked.value !== scope.value
)
const data = shallowRef<ReturnType<typeof adminPromotionListSchema.parse> | null>(null),
  detail = shallowRef<AdminPromotionDetail | null>(null)
const readState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle'),
  readBusy = ref(false),
  writeBusy = ref(false),
  pending = ref(false)
const query = ref(''),
  applied = ref({ q: '', status: 'all', page: 1, perPage: 25 }),
  queryStatus = ref('all')
const editor = ref(false),
  feedback = ref(''),
  unknown = ref(false),
  replayAllowed = ref(false)
interface Draft {
  id: string
  expectedVersion: number
  code: string
  status: 'active' | 'paused'
  startsAt: string
  endsAt: string
  benefitKind: 'fixed' | 'percent'
  benefitValue: string
  scopeKind: 'all' | 'product' | 'category'
  scopeIds: string[]
  segment: 'all' | 'registered' | 'approved_company'
  totalLimit: string
  perCustomerLimit: string
  volumeMode: 'exclude_volume' | 'stack_volume' | 'best_of_volume'
  reason: string
}
function emptyDraft(): Draft {
  return {
    id: '',
    expectedVersion: 0,
    code: '',
    status: 'paused',
    startsAt: '',
    endsAt: '',
    benefitKind: 'percent',
    benefitValue: '1000',
    scopeKind: 'all',
    scopeIds: [],
    segment: 'all',
    totalLimit: '',
    perCustomerLimit: '',
    volumeMode: 'exclude_volume',
    reason: ''
  }
}
const draft = ref<Draft>(emptyDraft())
type Intent = { body: AdminPromotionInput; key: string; hash: string; owner: string }
const intent = shallowRef<Intent | null>(null),
  preview = shallowRef<ReturnType<typeof adminPromotionPreviewSchema.parse> | null>(null)
const previewBusy = ref(false),
  lookupBusy = ref(false),
  lookupQuery = ref(''),
  choices = ref<Array<{ id: string; label: string }>>([])
const simulation = ref({
  quantity: '1',
  base: '1000',
  volume: '1000',
  tax: '2100',
  registered: false,
  company: false,
  total: '0',
  customer: '0'
})
let generation = 0,
  alive = true
const current = (owner: string, token: number) =>
  alive && authorized.value && scope.value === owner && generation === token
function purge() {
  generation++
  data.value = null
  detail.value = null
  draft.value = emptyDraft()
  editor.value = false
  intent.value = null
  preview.value = null
  choices.value = []
  lookupQuery.value = ''
  query.value = ''
  queryStatus.value = 'all'
  applied.value = { q: '', status: 'all', page: 1, perPage: 25 }
  feedback.value = ''
  readState.value = 'idle'
  readBusy.value = false
  writeBusy.value = false
  pending.value = false
  unknown.value = false
  replayAllowed.value = false
  previewBusy.value = false
  lookupBusy.value = false
  simulation.value = {
    quantity: '1',
    base: '1000',
    volume: '1000',
    tax: '2100',
    registered: false,
    company: false,
    total: '0',
    customer: '0'
  }
}
function status(error: unknown) {
  const failure = error as { statusCode?: number; status?: number; response?: { status?: number } }
  return failure?.statusCode ?? failure?.status ?? failure?.response?.status
}
function handleAuth(error: unknown, owner: string) {
  if (scope.value === owner && [401, 403].includes(status(error) ?? 0)) {
    purge()
    revoked.value = owner
    return true
  }
  return false
}
async function readList() {
  if (!authorized.value || readBusy.value || pending.value) return
  const owner = scope.value,
    token = generation
  readBusy.value = true
  readState.value = 'loading'
  data.value = null
  try {
    const parsed = adminPromotionListSchema.parse(
      await request('/api/admin/promotions', { query: { ...applied.value }, cache: 'no-store', retry: 0 })
    )
    if (current(owner, token)) {
      data.value = parsed
      readState.value = 'ready'
    }
  } catch (error) {
    if (!handleAuth(error, owner) && current(owner, token)) readState.value = 'error'
  } finally {
    if (current(owner, token)) readBusy.value = false
  }
}
function search() {
  if (pending.value || readBusy.value) return
  applied.value = { q: query.value, status: queryStatus.value, page: 1, perPage: 25 }
  void readList()
}
function page(delta: number) {
  if (pending.value || readBusy.value) return
  applied.value = { ...applied.value, page: applied.value.page + delta }
  void readList()
}
function openCreate() {
  if (!authorized.value || pending.value || readState.value !== 'ready') return
  detail.value = null
  draft.value = { ...emptyDraft(), id: crypto.randomUUID(), startsAt: adminIsoToLocal(new Date()) }
  editor.value = true
  feedback.value = ''
  intent.value = null
}
function fromRule(value: AdminPromotionDetail) {
  const rule = value.rule
  draft.value = {
    id: rule.id,
    expectedVersion: rule.version,
    code: rule.code,
    status: rule.status,
    startsAt: adminIsoToLocal(rule.startsAt, true, true),
    endsAt: adminIsoToLocal(rule.endsAt, true, true),
    benefitKind: rule.benefit.kind,
    benefitValue: String(rule.benefit.kind === 'fixed' ? rule.benefit.grossCents : rule.benefit.basisPoints),
    scopeKind: rule.scope.kind,
    scopeIds: rule.scope.kind === 'all' ? [] : [...rule.scope.ids],
    segment: rule.segment,
    totalLimit: rule.totalLimit === null ? '' : String(rule.totalLimit),
    perCustomerLimit: rule.perCustomerLimit === null ? '' : String(rule.perCustomerLimit),
    volumeMode: rule.volumeMode,
    reason: ''
  }
}
async function edit(id: string, historyPage = 1) {
  if (!authorized.value || pending.value || readBusy.value) return
  const owner = scope.value,
    token = generation
  readBusy.value = true
  try {
    const parsed = adminPromotionDetailSchema.parse(
      await request(`/api/admin/promotions/${id}`, {
        query: historyPage === 1 ? {} : { historyPage },
        cache: 'no-store',
        retry: 0
      })
    )
    if (parsed.rule.id !== id) throw Error('mismatched_rule')
    if (current(owner, token)) {
      detail.value = parsed
      fromRule(parsed)
      editor.value = true
      feedback.value = ''
      intent.value = null
    }
  } catch (error) {
    if (!handleAuth(error, owner) && current(owner, token))
      feedback.value = 'No se pudo abrir la promoción ni su historial. Vuelve a intentarlo.'
  } finally {
    if (current(owner, token)) readBusy.value = false
  }
}
function integer(value: string) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw Error('invalid_integer')
  return Number(value)
}
/** Las fechas se eligen en hora local; la API recibe el instante en UTC. */
function utc(value: string) {
  const iso = adminLocalToIso(value)
  if (!iso) throw Error('invalid_date')
  return iso
}
function input(): AdminPromotionInput {
  return adminPromotionInputSchema.parse({
    expectedVersion: draft.value.expectedVersion,
    reason: draft.value.reason,
    rule: proposedRule()
  })
}
function proposedRule() {
  const d = draft.value
  return promotionRuleSchema.parse({
    id: d.id,
    version: d.expectedVersion + 1,
    code: d.code,
    status: d.status,
    channel: 'online',
    startsAt: utc(d.startsAt),
    endsAt: d.endsAt ? utc(d.endsAt) : null,
    benefit:
      d.benefitKind === 'fixed'
        ? { kind: 'fixed', grossCents: integer(d.benefitValue) }
        : { kind: 'percent', basisPoints: integer(d.benefitValue) },
    scope: d.scopeKind === 'all' ? { kind: 'all' } : { kind: d.scopeKind, ids: d.scopeIds },
    segment: d.segment,
    totalLimit: d.totalLimit ? integer(d.totalLimit) : null,
    perCustomerLimit: d.perCustomerLimit ? integer(d.perCustomerLimit) : null,
    volumeMode: d.volumeMode
  })
}
const simulatorRule = computed(() => {
  try {
    return proposedRule()
  } catch {
    return null
  }
})
async function review() {
  if (!authorized.value || pending.value || writeBusy.value) return
  const owner = scope.value,
    token = generation,
    snapshot = JSON.stringify(draft.value)
  try {
    const body = input(),
      hash = await adminPromotionIntentHash(body)
    if (current(owner, token) && JSON.stringify(draft.value) === snapshot) {
      intent.value = { body, key: crypto.randomUUID(), hash, owner }
      feedback.value = 'Revisa el resumen antes de confirmar. Todavía no se ha guardado nada.'
    }
  } catch {
    feedback.value =
      'Revisa el código, las fechas, el valor del descuento, los límites, los productos elegidos y el motivo (entre 10 y 500 caracteres).'
  }
}
async function accept(raw: unknown, frozen: Intent, token: number) {
  const receipt: AdminPromotionReceipt = adminPromotionReceiptSchema.parse(raw)
  if (
    receipt.commandId !== frozen.key ||
    receipt.ruleId !== frozen.body.rule.id ||
    receipt.version !== frozen.body.rule.version ||
    receipt.payloadHash !== frozen.hash
  )
    throw Error('mismatched_receipt')
  const fresh = adminPromotionDetailSchema.parse(
    await request(`/api/admin/promotions/${receipt.ruleId}`, { cache: 'no-store', retry: 0 })
  )
  if (
    fresh.rule.id !== receipt.ruleId ||
    fresh.rule.version < receipt.version ||
    (fresh.rule.version === receipt.version && JSON.stringify(fresh.rule) !== JSON.stringify(frozen.body.rule))
  )
    throw Error('mismatched_fresh_rule')
  if (!current(frozen.owner, token)) return
  detail.value = fresh
  fromRule(fresh)
  intent.value = null
  pending.value = false
  unknown.value = false
  replayAllowed.value = false
  feedback.value = 'Cambio registrado y regla vigente comprobada. La promoción ya está guardada.'
  await readList()
}
async function send(replay = false) {
  const frozen = intent.value
  if (
    !frozen ||
    !authorized.value ||
    frozen.owner !== scope.value ||
    writeBusy.value ||
    (!replay && pending.value) ||
    (replay && !replayAllowed.value)
  )
    return
  const token = generation
  writeBusy.value = true
  pending.value = true
  replayAllowed.value = false
  try {
    const path =
      frozen.body.expectedVersion === 0 ? '/api/admin/promotions' : `/api/admin/promotions/${frozen.body.rule.id}`
    const raw = await request(path, {
      method: frozen.body.expectedVersion === 0 ? 'POST' : 'PUT',
      body: structuredClone(frozen.body),
      headers: { 'Idempotency-Key': frozen.key },
      retry: 0
    })
    if (current(frozen.owner, token)) await accept(raw, frozen, token)
  } catch (error) {
    if (!handleAuth(error, frozen.owner) && current(frozen.owner, token)) {
      unknown.value = true
      feedback.value =
        'Resultado incierto. No vuelvas a crear la promoción: pulsa «Comprobar cambio» para saber si se guardó.'
    }
  } finally {
    if (current(frozen.owner, token)) writeBusy.value = false
  }
}
async function check() {
  const frozen = intent.value
  if (!frozen || !authorized.value || writeBusy.value) return
  const token = generation
  writeBusy.value = true
  replayAllowed.value = false
  try {
    const result = adminPromotionCommandSchema.parse(
      await request(`/api/admin/promotions/commands/${frozen.key}`, {
        headers: { 'X-Neteco-Command-Payload-Hash': frozen.hash },
        cache: 'no-store',
        retry: 0
      })
    )
    if (!current(frozen.owner, token)) return
    if (result.outcome === 'applied') await accept(result.receipt, frozen, token)
    else {
      unknown.value = true
      replayAllowed.value = true
      feedback.value =
        'Resultado incierto: todavía no consta que el cambio se haya guardado. Puedes comprobarlo otra vez o reenviar el mismo cambio.'
      const fresh = adminPromotionDetailSchema.parse(
        await request(`/api/admin/promotions/${frozen.body.rule.id}`, { cache: 'no-store', retry: 0 })
      )
      if (fresh.rule.id !== frozen.body.rule.id) throw Error('mismatched_fresh_rule')
      if (!current(frozen.owner, token)) return
      if (fresh.rule.version > frozen.body.expectedVersion) {
        // Immutable monotonically increasing versions make the original CAS
        // impossible now. Check its ledger again after the read: it may have
        // committed between the first lookup and that confirmed newer state.
        replayAllowed.value = false
        const second = adminPromotionCommandSchema.parse(
          await request(`/api/admin/promotions/commands/${frozen.key}`, {
            headers: { 'X-Neteco-Command-Payload-Hash': frozen.hash },
            cache: 'no-store',
            retry: 0
          })
        )
        if (!current(frozen.owner, token)) return
        if (second.outcome === 'applied') await accept(second.receipt, frozen, token)
        else {
          detail.value = fresh
          fromRule(fresh)
          draft.value.reason = frozen.body.reason
          intent.value = null
          pending.value = false
          unknown.value = false
          feedback.value =
            'Otro cambio se ha guardado antes que el tuyo. Revisa la promoción tal como está ahora y prepara el cambio de nuevo.'
        }
      }
    }
  } catch (error) {
    if (!handleAuth(error, frozen.owner) && current(frozen.owner, token))
      feedback.value = 'Resultado incierto: no se ha podido comprobar el cambio. Tu intento sigue guardado aquí.'
  } finally {
    if (current(frozen.owner, token)) writeBusy.value = false
  }
}
async function lookup() {
  if (
    !authorized.value ||
    pending.value ||
    lookupBusy.value ||
    !caps.value?.permissions.includes('catalog.write') ||
    draft.value.scopeKind === 'all'
  )
    return
  const owner = scope.value,
    token = generation,
    kind = draft.value.scopeKind
  lookupBusy.value = true
  choices.value = []
  try {
    const raw = (await request(kind === 'product' ? '/api/admin/products' : '/api/admin/categories', {
      ...(kind === 'product' ? { query: { q: lookupQuery.value, page: 1, perPage: 25 } } : {}),
      cache: 'no-store',
      retry: 0
    })) as {
      source?: unknown
      items?: Array<{ uuid?: unknown; name?: unknown }>
      flat?: Array<{ name?: unknown; authoring?: { uuid?: unknown } }>
    }
    if (raw.source !== 'cloudflare') throw Error('invalid_catalog')
    const rows =
      kind === 'product'
        ? raw.items?.map((r) => ({ id: r.uuid, label: r.name }))
        : raw.flat
            ?.filter((r) => String(r.name).toLocaleLowerCase().includes(lookupQuery.value.toLocaleLowerCase()))
            .map((r) => ({ id: r.authoring?.uuid, label: r.name }))
    if (
      !rows ||
      rows.length > 1000 ||
      rows.some(
        (r) =>
          typeof r.id !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(r.id) ||
          typeof r.label !== 'string' ||
          r.label.length > 200
      )
    )
      throw Error('invalid_catalog')
    if (current(owner, token) && draft.value.scopeKind === kind)
      choices.value = rows.slice(0, 25) as Array<{ id: string; label: string }>
  } catch (error) {
    if (!handleAuth(error, owner) && current(owner, token))
      feedback.value = 'No se pudo consultar el catálogo. Vuelve a intentarlo.'
  } finally {
    if (current(owner, token)) lookupBusy.value = false
  }
}
async function simulate() {
  if (!authorized.value || pending.value || previewBusy.value) return
  const owner = scope.value,
    token = generation,
    original = JSON.stringify([draft.value, simulation.value])
  previewBusy.value = true
  preview.value = null
  try {
    const body = input(),
      s = simulation.value,
      simId = '00000000-0000-4000-8000-000000000073'
    const context = promotionContextSchema.parse({
      now: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      channel: 'online',
      customerId: s.registered ? simId : null,
      companyApproved: s.company,
      redemptions: { total: integer(s.total), customer: integer(s.customer) },
      lines: [
        {
          lineIndex: 0,
          variantId: simId,
          productId: body.rule.scope.kind === 'product' ? body.rule.scope.ids[0] : simId,
          categoryId: body.rule.scope.kind === 'category' ? body.rule.scope.ids[0] : simId,
          sku: 'SIMULACION-NO-CATALOGO',
          quantity: integer(s.quantity),
          baseUnitGrossCents: integer(s.base),
          volumeUnitGrossCents: integer(s.volume),
          taxRateBasisPoints: integer(s.tax)
        }
      ]
    })
    const result = adminPromotionPreviewSchema.parse(
      await request('/api/admin/promotions/preview', { method: 'POST', body: { rule: body.rule, context }, retry: 0 })
    )
    if (current(owner, token) && JSON.stringify([draft.value, simulation.value]) === original) preview.value = result
  } catch (error) {
    if (!handleAuth(error, owner) && current(owner, token))
      feedback.value = 'No se pudo simular: revisa los datos introducidos.'
  } finally {
    if (current(owner, token)) previewBusy.value = false
  }
}
watch(
  draft,
  () => {
    if (!pending.value) intent.value = null
    preview.value = null
  },
  { deep: true, flush: 'sync' }
)
function scopeChanged() {
  draft.value.scopeIds = []
  choices.value = []
  lookupQuery.value = ''
}
watch(simulation, () => (preview.value = null), { deep: true, flush: 'sync' })
watch(
  scope,
  () => {
    purge()
    revoked.value = null
    if (authorized.value) void readList()
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  purge()
})
const leaveOpen = ref(false)
let leaveAnswer: ((leave: boolean) => void) | null = null
function answerLeave(leave: boolean) {
  const answer = leaveAnswer
  leaveAnswer = null
  leaveOpen.value = false
  answer?.(leave)
}
watch(leaveOpen, (open) => {
  if (!open) answerLeave(false)
})
onBeforeRouteLeave(
  () =>
    !pending.value ||
    new Promise<boolean>((resolve) => {
      leaveAnswer?.(false)
      leaveAnswer = resolve
      leaveOpen.value = true
    })
)

// ── Presentación: etiquetas legibles y estado de la interfaz (sin lógica de negocio) ──
type PromotionRow = NonNullable<typeof data.value>['items'][number]
const STATUS_OPTIONS = [
  { value: 'all', label: 'Todas' },
  { value: 'active', label: 'Activas' },
  { value: 'paused', label: 'En pausa' }
]
const SEGMENT_LABELS: Record<PromotionRule['segment'], string> = {
  all: 'Todos los clientes',
  registered: 'Clientes registrados',
  approved_company: 'Empresas aprobadas'
}
const SCOPE_LABELS: Record<PromotionRule['scope']['kind'], string> = {
  all: 'Todo el catálogo',
  product: 'Productos concretos',
  category: 'Categorías concretas'
}
const REASON_LABELS: Record<string, string> = {
  unavailable: 'la promoción no está disponible',
  not_started: 'todavía no ha empezado',
  expired: 'ya ha terminado',
  segment_not_eligible: 'el cliente no pertenece al grupo al que va dirigida',
  customer_required: 'hace falta un cliente registrado',
  usage_limit: 'se ha alcanzado el límite de usos',
  no_eligible_lines: 'ningún producto de la cesta entra en la promoción',
  no_benefit: 'el descuento resultante es cero'
}
const columns = [
  { key: 'code', label: 'Código', value: (row: PromotionRow) => row.rule.code },
  { key: 'benefit', label: 'Descuento' },
  { key: 'validity', label: 'Vigencia', hideOnMobile: true },
  { key: 'uses', label: 'Usos', numeric: true, value: (row: PromotionRow) => row.redemptions },
  { key: 'state', label: 'Estado' }
]
function benefitLabel(rule: PromotionRule) {
  return rule.benefit.kind === 'fixed'
    ? adminMoney(rule.benefit.grossCents)
    : `${(rule.benefit.basisPoints / 100).toLocaleString('es-ES')} %`
}
function ruleState(rule: PromotionRule): { label: string; tone: AdminTone } {
  if (rule.status === 'paused') return { label: 'En pausa', tone: 'neutral' }
  const now = Date.now()
  if (new Date(rule.startsAt).getTime() > now) return { label: 'Programada', tone: 'info' }
  if (rule.endsAt && new Date(rule.endsAt).getTime() <= now) return { label: 'Finalizada', tone: 'neutral' }
  return { label: 'Activa', tone: 'success' }
}
const tableStatus = computed(() =>
  readState.value === 'loading' ? 'pending' : readState.value === 'error' ? 'error' : 'success'
)
const filtered = computed(() => applied.value.q !== '' || applied.value.status !== 'all')
function setStatus(value: string) {
  if (pending.value || readBusy.value) return
  queryStatus.value = value
  search()
}
function clearFilters() {
  if (pending.value || readBusy.value) return
  query.value = ''
  queryStatus.value = 'all'
  search()
}
function goToPage(next: number) {
  if (next !== applied.value.page) page(next - applied.value.page)
}
const editorTab = ref('datos')
const editorTabs = computed(() => [
  { value: 'datos', label: 'Datos' },
  { value: 'condiciones', label: 'Condiciones' },
  { value: 'vigencia', label: 'Vigencia y límites' },
  { value: 'simulador', label: 'Simulador' },
  ...(detail.value ? [{ value: 'historial', label: 'Historial', count: detail.value.historyTotal }] : [])
])
const formTab = computed(() => ['datos', 'condiciones', 'vigencia'].includes(editorTab.value))
watch(editor, (open) => {
  if (open) editorTab.value = 'datos'
})
watch(detail, (value) => {
  if (!value && editorTab.value === 'historial') editorTab.value = 'datos'
})
const feedbackColor = computed(() => {
  if (unknown.value || feedback.value.startsWith('Resultado incierto') || feedback.value.startsWith('Otro cambio'))
    return 'warning' as const
  if (feedback.value.startsWith('Cambio registrado')) return 'success' as const
  if (feedback.value.startsWith('No se pudo') || feedback.value.startsWith('Revisa el código')) return 'error' as const
  return 'neutral' as const
})
/** Los importes y porcentajes se guardan en céntimos y centésimas; en pantalla se editan en euros y en %. */
function hundredths(read: () => string, write: (value: string) => void) {
  return computed<number | ''>({
    get: () => {
      const raw = read(),
        value = Number(raw)
      return raw === '' || !Number.isFinite(value) ? '' : value / 100
    },
    set: (entered) => {
      const value = Number(entered)
      write((entered as unknown) === '' || !Number.isFinite(value) ? '' : String(Math.round(value * 100)))
    }
  })
}
const benefitAmount = hundredths(
  () => draft.value.benefitValue,
  (value) => (draft.value.benefitValue = value)
)
const simulationBase = hundredths(
  () => simulation.value.base,
  (value) => (simulation.value.base = value)
)
const simulationVolume = hundredths(
  () => simulation.value.volume,
  (value) => (simulation.value.volume = value)
)
const simulationTax = hundredths(
  () => simulation.value.tax,
  (value) => (simulation.value.tax = value)
)
</script>
<template>
  <AdminPage>
    <template v-if="authorized" #actions>
      <button
        data-testid="promotion-create"
        type="button"
        class="adm-btn adm-btn--primary"
        :disabled="readState !== 'ready' || readBusy || pending"
        @click="openCreate"
      >
        <UIcon name="i-lucide-plus" class="size-4 shrink-0" />Nueva promoción
      </button>
    </template>

    <section aria-label="Promociones" class="adm-stack min-w-0">
      <AdminEmptyState
        v-if="runtime !== 'cloudflare'"
        role="status"
        icon="i-lucide-ticket-percent"
        title="Promociones no disponibles en este entorno"
        description="Las promociones solo se gestionan en la tienda publicada en Cloudflare."
      />
      <AdminEmptyState
        v-else-if="!authorized"
        role="status"
        icon="i-lucide-lock"
        title="No puedes gestionar promociones ahora mismo"
        description="Hace falta permiso de administración, el correo verificado y la verificación en dos pasos activa."
      />
      <template v-else>
        <UAlert
          v-if="feedback && !editor"
          role="status"
          :color="feedbackColor"
          variant="subtle"
          icon="i-lucide-info"
          :title="feedback"
        />

        <AdminTable
          :rows="data?.items ?? []"
          :columns="columns"
          :row-key="(row) => row.rule.id"
          :status="tableStatus"
          :total="data?.total ?? applied.page * applied.perPage"
          :per-page="data?.perPage ?? applied.perPage"
          :page="applied.page"
          :filtered="filtered"
          empty-icon="i-lucide-ticket-percent"
          empty-title="Todavía no hay promociones"
          empty-description="Crea la primera con «Nueva promoción». Se guardará en pausa hasta que la actives."
          error-message="No se pudieron cargar las promociones. Vuelve a intentarlo."
          caption="Promociones"
          @update:page="goToPage"
          @retry="readList"
          @clear-filters="clearFilters"
        >
          <template #toolbar>
            <form data-testid="promotion-search" class="adm-toolbar" role="search" @submit.prevent="search">
              <label class="adm-toolbar__search">
                <span class="sr-only">Buscar por código</span>
                <UIcon name="i-lucide-search" class="size-4" />
                <input
                  v-model="query"
                  data-testid="promotion-query"
                  type="search"
                  maxlength="100"
                  placeholder="Buscar por código…"
                  :disabled="pending"
                />
              </label>
              <AdminFilters
                :model-value="queryStatus"
                :options="STATUS_OPTIONS"
                label="Filtrar por estado"
                @update:model-value="setStatus"
              />
              <div class="adm-toolbar__end">
                <button type="submit" class="adm-btn adm-btn--secondary adm-btn--sm" :disabled="readBusy || pending">
                  Buscar
                </button>
                <button
                  data-testid="promotion-refresh"
                  type="button"
                  class="adm-btn adm-btn--ghost adm-btn--sm"
                  :disabled="readBusy || pending"
                  @click="readList"
                >
                  <UIcon name="i-lucide-rotate-cw" class="size-4 shrink-0" />Actualizar
                </button>
              </div>
            </form>
          </template>
          <template #cell-code="{ row }">
            <span class="font-semibold text-[var(--text-strong)] [overflow-wrap:anywhere]">{{ row.rule.code }}</span>
          </template>
          <template #cell-benefit="{ row }">
            <span class="block text-[var(--text-strong)]">{{ benefitLabel(row.rule) }}</span>
            <span class="adm-help"
              >{{ SCOPE_LABELS[row.rule.scope.kind] }} · {{ SEGMENT_LABELS[row.rule.segment] }}</span
            >
          </template>
          <template #cell-validity="{ row }">
            <time :datetime="row.rule.startsAt">{{ adminDate(row.rule.startsAt) }}</time>
            –
            <time v-if="row.rule.endsAt" :datetime="row.rule.endsAt">{{ adminDate(row.rule.endsAt) }}</time>
            <span v-else class="text-[var(--text-muted)]">sin fecha de fin</span>
          </template>
          <template #cell-uses="{ row }">
            {{ row.redemptions }}
            <span v-if="row.rule.totalLimit !== null" class="text-[var(--text-muted)]">
              de {{ row.rule.totalLimit }}
            </span>
          </template>
          <template #cell-state="{ row }">
            <AdminBadge :tone="ruleState(row.rule).tone">{{ ruleState(row.rule).label }}</AdminBadge>
          </template>
          <template #actions="{ row }">
            <button
              data-testid="promotion-edit"
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="pending || readBusy"
              @click="edit(row.rule.id)"
            >
              Editar
            </button>
          </template>
          <template #empty-action>
            <AdminButton variant="secondary" icon="i-lucide-plus" :disabled="readBusy || pending" @click="openCreate">
              Nueva promoción
            </AdminButton>
          </template>
        </AdminTable>
      </template>
    </section>

    <!-- El panel se pinta dentro de la página (sin portal) y por encima de la cabecera fija. -->
    <div v-if="authorized" class="relative z-50">
      <AdminDrawer
        v-model:open="editor"
        wide
        :portal="false"
        :dismissible="!pending"
        :close="!pending"
        :title="draft.expectedVersion ? `Editar ${draft.code}` : 'Nueva promoción'"
        :description="
          draft.expectedVersion
            ? 'Cada cambio se guarda como una versión nueva y queda en el historial.'
            : 'Se crea en pausa: actívala cuando esté lista.'
        "
      >
        <div class="adm-stack">
          <UAlert
            v-if="feedback"
            role="status"
            :color="feedbackColor"
            variant="subtle"
            icon="i-lucide-info"
            :title="feedback"
          />
          <AdminTabs v-model="editorTab" :tabs="editorTabs" label="Apartados de la promoción" />

          <form v-show="formTab" class="adm-stack min-w-0" novalidate @submit.prevent="review">
            <fieldset :disabled="pending || writeBusy" class="adm-stack min-w-0">
              <div v-show="editorTab === 'datos'" class="adm-form-grid">
                <AdminFormField
                  v-slot="{ id }"
                  label="Código"
                  required
                  :help="
                    draft.expectedVersion
                      ? 'El código no se puede cambiar una vez creada la promoción.'
                      : 'Lo que escribe el cliente al pagar. Letras, números y guiones, sin espacios ni tildes.'
                  "
                >
                  <input
                    :id="id"
                    v-model="draft.code"
                    data-testid="promotion-code"
                    :readonly="draft.expectedVersion > 0"
                    maxlength="64"
                    required
                    class="w-full uppercase"
                  />
                </AdminFormField>
                <AdminFormField
                  v-slot="{ id }"
                  label="Estado"
                  help="En pausa no se puede usar, aunque esté dentro de las fechas."
                >
                  <select :id="id" v-model="draft.status" data-testid="promotion-status" class="w-full">
                    <option value="paused">En pausa</option>
                    <option value="active">Activa</option>
                  </select>
                </AdminFormField>
                <AdminFormField v-slot="{ id }" label="Tipo de descuento">
                  <select :id="id" v-model="draft.benefitKind" class="w-full">
                    <option value="percent">Porcentaje</option>
                    <option value="fixed">Importe fijo</option>
                  </select>
                </AdminFormField>
                <AdminFormField
                  v-slot="{ id }"
                  :label="draft.benefitKind === 'percent' ? 'Descuento (%)' : 'Descuento (€, IVA incluido)'"
                  required
                  :help="
                    draft.benefitKind === 'percent'
                      ? 'Entre 0,01 y 100.'
                      : 'Se descuenta del total con IVA de la cesta.'
                  "
                >
                  <input
                    :id="id"
                    v-model="benefitAmount"
                    type="number"
                    min="0.01"
                    :max="draft.benefitKind === 'percent' ? 100 : undefined"
                    step="0.01"
                    required
                    class="w-full"
                  />
                </AdminFormField>
              </div>

              <div v-show="editorTab === 'condiciones'" class="adm-stack">
                <div class="adm-form-grid">
                  <AdminFormField v-slot="{ id }" label="Quién puede usarla">
                    <select :id="id" v-model="draft.segment" class="w-full">
                      <option value="all">Todos los clientes</option>
                      <option value="registered">Clientes registrados</option>
                      <option value="approved_company">Empresas aprobadas</option>
                    </select>
                  </AdminFormField>
                  <AdminFormField v-slot="{ id }" label="Productos con precio por volumen">
                    <select :id="id" v-model="draft.volumeMode" class="w-full">
                      <option value="exclude_volume">No aplicar a los que ya tienen descuento por volumen</option>
                      <option value="stack_volume">Sumar al descuento por volumen</option>
                      <option value="best_of_volume">Aplicar solo el mejor de los dos</option>
                    </select>
                  </AdminFormField>
                  <AdminFormField v-slot="{ id }" label="A qué productos se aplica">
                    <select :id="id" v-model="draft.scopeKind" class="w-full" @change="scopeChanged">
                      <option value="all">Todo el catálogo</option>
                      <option value="product">Productos concretos</option>
                      <option value="category">Categorías concretas</option>
                    </select>
                  </AdminFormField>
                </div>
                <AdminCard
                  v-if="draft.scopeKind !== 'all'"
                  :title="draft.scopeKind === 'product' ? 'Productos incluidos' : 'Categorías incluidas'"
                  :description="`${draft.scopeIds.length} seleccionados. Lo ya marcado se conserva aunque busques otra cosa.`"
                >
                  <div v-if="caps?.permissions.includes('catalog.write')" class="adm-stack">
                    <div class="adm-toolbar">
                      <label class="adm-toolbar__search">
                        <span class="sr-only">Buscar en el catálogo</span>
                        <UIcon name="i-lucide-search" class="size-4" />
                        <input
                          v-model="lookupQuery"
                          type="search"
                          maxlength="100"
                          placeholder="Buscar en el catálogo…"
                          @keydown.enter.prevent="lookup"
                        />
                      </label>
                      <button
                        type="button"
                        class="adm-btn adm-btn--secondary adm-btn--sm"
                        :disabled="lookupBusy"
                        @click="lookup"
                      >
                        {{ lookupBusy ? 'Buscando…' : 'Buscar' }}
                      </button>
                    </div>
                    <div v-if="choices.length" class="grid gap-2">
                      <label v-for="choice in choices" :key="choice.id" class="adm-check [overflow-wrap:anywhere]">
                        <input v-model="draft.scopeIds" type="checkbox" :value="choice.id" />{{ choice.label }}
                      </label>
                    </div>
                    <p v-else class="adm-help">Busca para ver resultados y marca los que quieras incluir.</p>
                  </div>
                  <p v-else class="adm-help">
                    Para elegir productos o categorías necesitas además permiso para editar el catálogo.
                  </p>
                </AdminCard>
              </div>

              <div v-show="editorTab === 'vigencia'" class="adm-stack">
                <div class="adm-form-grid">
                  <AdminFormField v-slot="{ id }" label="Empieza" required>
                    <input
                      :id="id"
                      v-model="draft.startsAt"
                      data-testid="promotion-start"
                      type="datetime-local"
                      step="1"
                      required
                      class="w-full"
                    />
                  </AdminFormField>
                  <AdminFormField
                    v-slot="{ id }"
                    label="Termina"
                    help="Opcional. Déjalo vacío si no tiene fecha de fin."
                  >
                    <input :id="id" v-model="draft.endsAt" type="datetime-local" step="1" class="w-full" />
                  </AdminFormField>
                  <AdminFormField v-slot="{ id }" label="Usos máximos en total" help="Vacío: sin límite.">
                    <input :id="id" v-model="draft.totalLimit" type="number" min="1" step="1" class="w-full" />
                  </AdminFormField>
                  <AdminFormField v-slot="{ id }" label="Usos máximos por cliente" help="Vacío: sin límite.">
                    <input :id="id" v-model="draft.perCustomerLimit" type="number" min="1" step="1" class="w-full" />
                  </AdminFormField>
                </div>
              </div>

              <AdminFormField
                v-slot="{ id }"
                label="Motivo del cambio"
                required
                help="Queda en el historial. Entre 10 y 500 caracteres."
              >
                <textarea
                  :id="id"
                  v-model="draft.reason"
                  data-testid="promotion-reason"
                  minlength="10"
                  maxlength="500"
                  required
                  rows="2"
                  class="w-full"
                />
              </AdminFormField>
            </fieldset>

            <div
              v-if="intent && !pending"
              class="rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4"
            >
              <p class="font-semibold text-[var(--text-strong)]">Confirma el cambio</p>
              <p class="adm-help mt-1">
                Se guardará {{ intent.body.rule.code }} (versión {{ intent.body.rule.version }}) como
                {{ intent.body.rule.status === 'active' ? 'activa' : 'en pausa' }}, con
                {{ benefitLabel(intent.body.rule) }} de descuento. El código no se puede cambiar después de crearla.
              </p>
              <div class="mt-3 flex justify-end">
                <button
                  data-testid="promotion-confirm"
                  type="button"
                  class="adm-btn adm-btn--primary"
                  :disabled="writeBusy"
                  @click="send()"
                >
                  Confirmar y guardar
                </button>
              </div>
            </div>

            <div
              v-if="pending"
              class="rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4"
            >
              <p class="font-semibold text-[var(--text-strong)]">
                {{ unknown ? 'No sabemos si el cambio se ha guardado' : 'Guardando y comprobando la promoción…' }}
              </p>
              <p v-if="unknown" class="adm-help mt-1">
                Compruébalo antes de hacer nada más: así evitas crear la promoción dos veces.
              </p>
              <div class="mt-3 flex flex-wrap justify-end gap-2">
                <button
                  v-if="replayAllowed"
                  data-testid="promotion-retry"
                  type="button"
                  class="adm-btn adm-btn--secondary"
                  :disabled="writeBusy"
                  @click="send(true)"
                >
                  Reenviar el mismo cambio
                </button>
                <button
                  data-testid="promotion-check"
                  type="button"
                  class="adm-btn adm-btn--primary"
                  :disabled="writeBusy"
                  @click="check"
                >
                  Comprobar cambio
                </button>
              </div>
            </div>

            <div v-if="!pending" class="flex flex-wrap justify-end gap-2 border-t border-[var(--border)] pt-4">
              <button type="button" class="adm-btn adm-btn--secondary" @click="editor = false">Cancelar</button>
              <button
                data-testid="promotion-review"
                type="submit"
                class="adm-btn"
                :class="intent ? 'adm-btn--secondary' : 'adm-btn--primary'"
                :disabled="writeBusy"
              >
                Revisar cambio
              </button>
            </div>
          </form>

          <div v-show="editorTab === 'simulador'" class="adm-stack min-w-0">
            <PromotionBasketSimulator
              :rule="simulatorRule"
              :scope-key="scope"
              :enabled="authorized"
              :pending="pending"
            />

            <AdminCard
              v-if="!pending"
              title="Prueba rápida con importes a mano"
              description="Calcula el descuento sobre una línea inventada. No consulta precios reales ni cambia ningún carrito."
            >
              <div class="adm-stack">
                <div class="adm-form-grid">
                  <AdminFormField v-slot="{ id }" label="Cantidad">
                    <input :id="id" v-model="simulation.quantity" type="number" min="1" step="1" class="w-full" />
                  </AdminFormField>
                  <AdminFormField v-slot="{ id }" label="Precio normal (€, IVA incluido)">
                    <input :id="id" v-model="simulationBase" type="number" min="0" step="0.01" class="w-full" />
                  </AdminFormField>
                  <AdminFormField v-slot="{ id }" label="Precio por volumen (€, IVA incluido)">
                    <input :id="id" v-model="simulationVolume" type="number" min="0" step="0.01" class="w-full" />
                  </AdminFormField>
                  <AdminFormField v-slot="{ id }" label="IVA (%)">
                    <input
                      :id="id"
                      v-model="simulationTax"
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      class="w-full"
                    />
                  </AdminFormField>
                  <AdminFormField v-slot="{ id }" label="Usos ya hechos en total">
                    <input :id="id" v-model="simulation.total" type="number" min="0" step="1" class="w-full" />
                  </AdminFormField>
                  <AdminFormField v-slot="{ id }" label="Usos ya hechos por este cliente">
                    <input :id="id" v-model="simulation.customer" type="number" min="0" step="1" class="w-full" />
                  </AdminFormField>
                </div>
                <div class="flex flex-wrap gap-x-6 gap-y-2">
                  <label class="adm-check">
                    <input v-model="simulation.registered" type="checkbox" /> El cliente está registrado
                  </label>
                  <label class="adm-check">
                    <input v-model="simulation.company" type="checkbox" /> Es una empresa aprobada
                  </label>
                </div>
                <div v-if="preview" role="status" class="adm-stack">
                  <AdminBadge :tone="preview.eligible ? 'success' : 'warning'">
                    {{
                      preview.eligible
                        ? 'Se aplicaría'
                        : `No se aplicaría: ${REASON_LABELS[preview.reason ?? ''] ?? 'no cumple las condiciones'}`
                    }}
                  </AdminBadge>
                  <div class="adm-grid">
                    <AdminStat label="Descuento" :value="adminMoney(preview.totals.discountGrossCents)" />
                    <AdminStat label="Total con IVA" :value="adminMoney(preview.totals.grossCents)" />
                    <AdminStat label="Sin IVA" :value="adminMoney(preview.totals.netCents)" />
                    <AdminStat label="IVA" :value="adminMoney(preview.totals.taxCents)" />
                  </div>
                </div>
              </div>
              <template #footer>
                <span class="adm-help mr-auto">Rellena también el motivo del cambio para poder calcular.</span>
                <button type="button" class="adm-btn adm-btn--secondary" :disabled="previewBusy" @click="simulate">
                  {{ previewBusy ? 'Calculando…' : 'Calcular sin guardar' }}
                </button>
              </template>
            </AdminCard>
          </div>

          <section
            v-if="detail"
            v-show="editorTab === 'historial'"
            aria-label="Historial de la regla"
            class="adm-stack min-w-0"
          >
            <AdminCard
              title="Historial de cambios"
              :description="`${detail.historyTotal} ${detail.historyTotal === 1 ? 'versión' : 'versiones'} · ${detail.redemptions} usos registrados entre todas`"
              flush
            >
              <ul class="adm-list">
                <li v-for="version in detail.history" :key="version.rule.version">
                  <span class="adm-list__index">{{ version.rule.version }}</span>
                  <div class="min-w-0 flex-1">
                    <p class="adm-list__title">
                      {{ benefitLabel(version.rule) }}
                      <AdminBadge :tone="version.rule.status === 'active' ? 'success' : 'neutral'" plain>
                        {{ version.rule.status === 'active' ? 'Activa' : 'En pausa' }}
                      </AdminBadge>
                    </p>
                    <p class="adm-help [overflow-wrap:anywhere]">{{ version.reason }}</p>
                  </div>
                  <time :datetime="version.createdAt" class="adm-help">{{ adminDate(version.createdAt, true) }}</time>
                </li>
              </ul>
              <template v-if="detail.historyTotal > 20" #footer>
                <nav aria-label="Páginas del historial" class="flex items-center gap-2">
                  <button
                    type="button"
                    class="adm-btn adm-btn--secondary adm-btn--sm"
                    :disabled="pending || readBusy || detail.historyPage <= 1"
                    @click="edit(detail.rule.id, detail.historyPage - 1)"
                  >
                    Anterior
                  </button>
                  <span class="adm-help">Página {{ detail.historyPage }}</span>
                  <button
                    type="button"
                    class="adm-btn adm-btn--secondary adm-btn--sm"
                    :disabled="pending || readBusy || detail.historyPage * 20 >= detail.historyTotal"
                    @click="edit(detail.rule.id, detail.historyPage + 1)"
                  >
                    Siguiente
                  </button>
                </nav>
              </template>
            </AdminCard>
          </section>
        </div>
      </AdminDrawer>
    </div>

    <AdminConfirm
      v-model:open="leaveOpen"
      title="Hay un cambio sin comprobar"
      description="Si sales ahora solo se descarta lo que ves en esta pantalla: no se deshace un cambio que quizá ya se haya guardado."
      confirm-label="Salir de todos modos"
      cancel-label="Seguir aquí"
      danger
      @confirm="answerLeave(true)"
    />
  </AdminPage>
</template>
