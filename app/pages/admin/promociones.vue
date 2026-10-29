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
import { promotionContextSchema, promotionRuleSchema } from '~~/shared/promotions'

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
  draft.value = { ...emptyDraft(), id: crypto.randomUUID(), startsAt: new Date().toISOString().slice(0, 19) }
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
    startsAt: rule.startsAt.slice(0, 19),
    endsAt: rule.endsAt?.slice(0, 19) ?? '',
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
    if (!handleAuth(error, owner) && current(owner, token)) feedback.value = 'No se pudo leer la regla o su historial.'
  } finally {
    if (current(owner, token)) readBusy.value = false
  }
}
function integer(value: string) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw Error('invalid_integer')
  return Number(value)
}
function utc(value: string) {
  return new Date(value + 'Z').toISOString().replace(/\.\d{3}Z$/, 'Z')
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
      feedback.value = 'Revise la regla antes de confirmar. No se ha guardado.'
    }
  } catch {
    feedback.value = 'Revise código, calendario UTC, importe entero, límites, alcance y motivo (10–500 caracteres).'
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
  feedback.value = 'Cambio registrado y regla vigente comprobada.'
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
      feedback.value = 'Resultado incierto. No vuelva a crear la regla: compruebe el recibo del intento original.'
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
        'Resultado incierto: el recibo aún no confirma el efecto. Puede consultar otra vez o reenviar expresamente el mismo intento.'
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
            'Otro cambio ha avanzado la versión. Revise la regla vigente y prepare un nuevo cambio explícito.'
        }
      }
    }
  } catch (error) {
    if (!handleAuth(error, frozen.owner) && current(frozen.owner, token))
      feedback.value = 'Resultado incierto: no se pudo comprobar el recibo; el intento original se conserva.'
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
      feedback.value = 'No se pudo consultar el catálogo autorizado.'
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
      feedback.value = 'No se pudo simular: revise los datos introducidos.'
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
onBeforeRouteLeave(
  () =>
    !pending.value ||
    window.confirm(
      'Hay un resultado incierto o una confirmación pendiente. Salir descarta sólo el intento local, no revierte un posible cambio. ¿Salir?'
    )
)
</script>
<template>
  <section aria-label="Promociones" class="space-y-6 min-w-0">
    <header>
      <h1 class="text-2xl font-semibold">Promociones</h1>
      <p>Cupones versionados. Pausar conserva su historial y sus usos entre versiones.</p>
    </header>
    <p v-if="runtime !== 'cloudflare'" role="status">
      Esta administración requiere Cloudflare; no se llama a endpoints de promociones Node.
    </p>
    <p v-else-if="!authorized" role="status">
      Se requiere autorización administrativa vigente, correo verificado y MFA.
    </p>
    <template v-else>
      <form data-testid="promotion-search" class="flex flex-wrap gap-3" @submit.prevent="search">
        <label
          >Código<input
            v-model="query"
            data-testid="promotion-query"
            maxlength="100"
            :disabled="pending"
            class="block border rounded p-2"
        /></label>
        <label
          >Estado<select v-model="queryStatus" :disabled="pending" class="block border rounded p-2">
            <option value="all">Todos</option>
            <option value="active">Activo</option>
            <option value="paused">Pausado</option>
          </select></label
        >
        <button type="submit" :disabled="readBusy || pending">Buscar</button>
        <button data-testid="promotion-refresh" type="button" :disabled="readBusy || pending" @click="readList">
          Actualizar
        </button>
        <button
          data-testid="promotion-create"
          type="button"
          :disabled="readState !== 'ready' || readBusy || pending"
          @click="openCreate"
        >
          Crear cupón
        </button>
      </form>
      <p v-if="readState === 'loading'" role="status">Cargando promociones…</p>
      <p v-else-if="readState === 'error'" role="alert">
        No se pudieron cargar las promociones. No es una lista vacía.
      </p>
      <template v-else-if="data">
        <p v-if="data.items.length === 0" role="status">No hay promociones para los filtros confirmados.</p>
        <ul class="space-y-2">
          <li
            v-for="entry in data.items"
            :key="entry.rule.id"
            class="border rounded p-3 flex flex-wrap gap-3 break-words"
          >
            <span class="min-w-0 [overflow-wrap:anywhere]"
              >{{ entry.rule.code }} · v{{ entry.rule.version }} ·
              {{ entry.rule.status === 'active' ? 'Activo' : 'Pausado' }} · {{ entry.redemptions }} usos registrados en
              todas las versiones</span
            >
            <button data-testid="promotion-edit" :disabled="pending || readBusy" @click="edit(entry.rule.id)">
              Editar / historial
            </button>
          </li>
        </ul>
        <nav aria-label="Páginas de promociones" class="flex gap-3">
          <button :disabled="pending || readBusy || applied.page <= 1" @click="page(-1)">Anterior</button
          ><span>Página {{ data.page }} · {{ data.total }} reglas</span
          ><button :disabled="pending || readBusy || data.page * data.perPage >= data.total" @click="page(1)">
            Siguiente
          </button>
        </nav>
      </template>
      <p v-if="feedback" role="status" class="break-words">{{ feedback }}</p>
      <form v-if="editor" class="border rounded p-4 space-y-4 min-w-0" @submit.prevent="review">
        <h2 class="text-lg font-semibold">{{ draft.expectedVersion ? 'Editar regla' : 'Nueva regla pausada' }}</h2>
        <fieldset :disabled="pending || writeBusy" class="grid gap-4 sm:grid-cols-2 min-w-0">
          <label
            >Código ASCII<input
              v-model="draft.code"
              data-testid="promotion-code"
              :readonly="draft.expectedVersion > 0"
              maxlength="64"
              required
              class="block w-full min-w-0 border rounded p-2"
          /></label>
          <label
            >Estado<select
              v-model="draft.status"
              data-testid="promotion-status"
              class="block w-full border rounded p-2"
            >
              <option value="paused">Pausado</option>
              <option value="active">Activo</option>
            </select></label
          >
          <label
            >Inicio UTC<input
              v-model="draft.startsAt"
              data-testid="promotion-start"
              type="datetime-local"
              step="1"
              required
              class="block w-full min-w-0 border rounded p-2"
          /></label>
          <label
            >Fin UTC (opcional, exclusivo)<input
              v-model="draft.endsAt"
              type="datetime-local"
              step="1"
              class="block w-full min-w-0 border rounded p-2"
          /></label>
          <label
            >Beneficio<select v-model="draft.benefitKind" class="block w-full border rounded p-2">
              <option value="percent">Porcentaje (puntos básicos; 1000 = 10%)</option>
              <option value="fixed">Importe bruto (céntimos EUR)</option>
            </select></label
          >
          <label
            >{{ draft.benefitKind === 'percent' ? 'Puntos básicos (1–10000)' : 'Céntimos brutos'
            }}<input
              v-model="draft.benefitValue"
              type="number"
              min="1"
              step="1"
              required
              class="block w-full border rounded p-2"
          /></label>
          <label
            >Segmento<select v-model="draft.segment" class="block w-full border rounded p-2">
              <option value="all">Todos</option>
              <option value="registered">Clientes registrados</option>
              <option value="approved_company">Empresa aprobada</option>
            </select></label
          >
          <label
            >Volumen<select v-model="draft.volumeMode" class="block w-full border rounded p-2">
              <option value="exclude_volume">Excluir líneas con descuento por volumen</option>
              <option value="stack_volume">Acumular sobre volumen</option>
              <option value="best_of_volume">Mejor resultado permitido</option>
            </select></label
          >
          <label
            >Límite total por regla (vacío: sin límite)<input
              v-model="draft.totalLimit"
              type="number"
              min="1"
              step="1"
              class="block w-full border rounded p-2"
          /></label>
          <label
            >Límite por cliente (vacío: sin límite)<input
              v-model="draft.perCustomerLimit"
              type="number"
              min="1"
              step="1"
              class="block w-full border rounded p-2"
          /></label>
          <label
            >Alcance<select v-model="draft.scopeKind" class="block w-full border rounded p-2" @change="scopeChanged">
              <option value="all">Todos los productos</option>
              <option value="product">Productos seleccionados</option>
              <option value="category">Categorías seleccionadas</option>
            </select></label
          >
          <div v-if="draft.scopeKind !== 'all'" class="space-y-2 min-w-0">
            <template v-if="caps?.permissions.includes('catalog.write')"
              ><label
                >Buscar en catálogo autorizado<input
                  v-model="lookupQuery"
                  maxlength="100"
                  class="block w-full border rounded p-2" /></label
              ><button type="button" :disabled="lookupBusy" @click="lookup">Consultar catálogo</button>
              <label v-for="choice in choices" :key="choice.id" class="flex gap-2 break-words"
                ><input v-model="draft.scopeIds" type="checkbox" :value="choice.id" />{{ choice.label }}</label
              >
              <p>{{ draft.scopeIds.length }} seleccionados; las selecciones anteriores se conservan al buscar.</p>
            </template>
            <p v-else>Elegir productos o categorías requiere también permiso de catálogo vigente.</p>
          </div>
          <label class="sm:col-span-2"
            >Motivo administrativo (10–500 caracteres)<textarea
              v-model="draft.reason"
              data-testid="promotion-reason"
              minlength="10"
              maxlength="500"
              required
              class="block w-full border rounded p-2"
            />
          </label>
        </fieldset>
        <button v-if="!pending" data-testid="promotion-review" type="submit" :disabled="writeBusy">
          Revisar cambio
        </button>
        <div v-if="intent && !pending" class="border rounded p-3 space-y-2">
          <p>
            Confirmar {{ intent.body.rule.code }} versión {{ intent.body.rule.version }} ·
            {{ intent.body.rule.status }}. El código no puede cambiar tras la creación.
          </p>
          <button data-testid="promotion-confirm" type="button" :disabled="writeBusy" @click="send()">
            Confirmar y guardar
          </button>
        </div>
        <div v-if="pending" class="border rounded p-3 space-y-2">
          <p>
            {{
              unknown
                ? 'Resultado incierto; no se confirma éxito ni ausencia.'
                : 'Guardando y comprobando la regla vigente…'
            }}
          </p>
          <button data-testid="promotion-check" type="button" :disabled="writeBusy" @click="check">
            Comprobar cambio</button
          ><button
            v-if="replayAllowed"
            data-testid="promotion-retry"
            type="button"
            :disabled="writeBusy"
            @click="send(true)"
          >
            Reenviar el mismo intento explícitamente
          </button>
        </div>
        <details v-if="!pending" class="border rounded p-3">
          <summary>Simulación explícita (no cotización ni margen)</summary>
          <p>
            Una línea y contadores introducidos manualmente; no acredita precios, usos reales, costes ni elegibilidad de
            una venta. No modifica el carrito.
          </p>
          <div class="grid gap-3 sm:grid-cols-2 mt-3">
            <label
              >Cantidad<input
                v-model="simulation.quantity"
                type="number"
                min="1"
                step="1"
                class="block w-full border p-2" /></label
            ><label
              >Precio base bruto en céntimos<input
                v-model="simulation.base"
                type="number"
                min="0"
                step="1"
                class="block w-full border p-2" /></label
            ><label
              >Precio volumen bruto en céntimos<input
                v-model="simulation.volume"
                type="number"
                min="0"
                step="1"
                class="block w-full border p-2" /></label
            ><label
              >IVA en puntos básicos<input
                v-model="simulation.tax"
                type="number"
                min="0"
                max="10000"
                step="1"
                class="block w-full border p-2" /></label
            ><label
              >Usos totales simulados<input
                v-model="simulation.total"
                type="number"
                min="0"
                step="1"
                class="block w-full border p-2" /></label
            ><label
              >Usos del cliente simulados<input
                v-model="simulation.customer"
                type="number"
                min="0"
                step="1"
                class="block w-full border p-2" /></label
            ><label><input v-model="simulation.registered" type="checkbox" /> Cliente registrado simulado</label
            ><label><input v-model="simulation.company" type="checkbox" /> Empresa aprobada simulada</label>
          </div>
          <button type="button" :disabled="previewBusy" @click="simulate">Simular sin guardar</button>
          <p v-if="preview" role="status">
            {{ preview.eligible ? 'Aplicable a esta simulación' : 'No aplicable: ' + preview.reason }} · descuento
            {{ preview.totals.discountGrossCents }} céntimos · neto {{ preview.totals.netCents }} · IVA
            {{ preview.totals.taxCents }} · bruto {{ preview.totals.grossCents }}
          </p>
        </details>
      </form>
      <PromotionBasketSimulator
        v-if="editor"
        :rule="simulatorRule"
        :scope-key="scope"
        :enabled="authorized"
        :pending="pending"
      />
      <section v-if="detail" aria-label="Historial de la regla" class="space-y-2 min-w-0">
        <h2>Historial · {{ detail.historyTotal }} versiones</h2>
        <ul>
          <li v-for="version in detail.history" :key="version.rule.version" class="border rounded p-2 break-words">
            v{{ version.rule.version }} · {{ version.rule.status }} ·
            <time :datetime="version.createdAt">{{ version.createdAt }}</time> · {{ version.reason }}
          </li>
        </ul>
        <nav aria-label="Páginas del historial" class="flex gap-3">
          <button
            :disabled="pending || readBusy || detail.historyPage <= 1"
            @click="edit(detail.rule.id, detail.historyPage - 1)"
          >
            Anterior</button
          ><button
            :disabled="pending || readBusy || detail.historyPage * 20 >= detail.historyTotal"
            @click="edit(detail.rule.id, detail.historyPage + 1)"
          >
            Siguiente
          </button>
        </nav>
      </section>
    </template>
  </section>
</template>
