<script setup lang="ts">
import { adminCapabilitiesSchema } from '~~/shared/admin-navigation'
import {
  adminOrderViewDefinitionSchema,
  adminOrderViewCreateInputSchema,
  adminOrderViewUpdateInputSchema,
  adminOrderViewArchiveInputSchema,
  adminOrderViewListSchema,
  adminOrderViewDetailSchema,
  adminOrderViewReceiptSchema,
  adminOrderViewCommandSchema,
  adminOrderViewIntentHash,
  type AdminOrderView
} from '~~/shared/admin-order-views'
const props = defineProps<{ scopeKey: string; enabled: boolean; pending: boolean; appliedDefinition: unknown }>()
const emit = defineEmits<{ pending: [value: boolean]; apply: [definition: unknown] }>()
const runtime = useRuntimeConfig(),
  request = useRequestFetch(),
  navigation = useAdminNavigation()
const { ready, loggedIn, user, session } = useUserSession()
const denied = ref(false)
const authority = computed(() => {
  const caps = adminCapabilitiesSchema.safeParse(navigation.capabilities.value)
  if (
    !props.enabled ||
    !props.scopeKey ||
    runtime.public.serverRuntime !== 'cloudflare' ||
    !ready.value ||
    !loggedIn.value ||
    !user.value?.emailVerified ||
    !user.value?.mfaVerified ||
    navigation.status.value !== 'ready' ||
    !caps.success ||
    caps.data.state !== 'ready' ||
    !caps.data.permissions.includes('administration.manage') ||
    caps.data.identityId !== user.value.id ||
    caps.data.sessionId !== session.value?.sessionId ||
    caps.data.sessionVersion !== session.value?.sessionVersion
  )
    return null
  return JSON.stringify([props.scopeKey, caps.data.identityId, caps.data.sessionId, caps.data.sessionVersion])
})
const usable = computed(() => Boolean(authority.value) && !denied.value)
const items = shallowRef<AdminOrderView[] | null>(null),
  selected = ref(''),
  detail = shallowRef<AdminOrderView | null>(null),
  name = ref('')
const busy = ref(false),
  status = ref<'idle' | 'error' | 'confirmed' | 'confirmed_archived' | 'uncertain' | 'conflict'>('idle')
type Intent = {
  action: 'create' | 'update' | 'archive'
  target: string | null
  key: string
  hash: string
  body: unknown
  scope: string
  version: number
}
const intent = shallowRef<Intent | null>(null)
let alive = true,
  epoch = 0,
  controller: AbortController | null = null
const root = '/api/admin/order-views'
function purge() {
  epoch++
  controller?.abort()
  controller = null
  items.value = null
  selected.value = ''
  detail.value = null
  name.value = ''
  busy.value = false
  intent.value = null
  status.value = 'idle'
  emit('pending', false)
}
watch(
  authority,
  () => {
    purge()
    denied.value = false
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  purge()
})
function current(generation: number, scope: string) {
  return alive && epoch === generation && authority.value === scope && !denied.value
}
function errorCode(error: unknown) {
  const e = error as { statusCode?: number; status?: number; data?: { error?: { code?: string } } }
  return { status: e?.statusCode ?? e?.status, code: e?.data?.error?.code }
}
function failed(error: unknown, generation: number, scope: string) {
  if (!current(generation, scope)) return
  if ([401, 403].includes(errorCode(error).status ?? 0)) {
    purge()
    denied.value = true
    return
  }
  status.value = intent.value ? 'uncertain' : 'error'
}
function list(raw: unknown) {
  const result = adminOrderViewListSchema.parse(raw).items
  if (result.some((view) => view.archived) || new Set(result.map((view) => view.id)).size !== result.length)
    throw Error('unconfirmed_views')
  return result
}
async function get(path: string, signal: AbortSignal, query?: Record<string, string>) {
  return await request<unknown>(path, { method: 'GET', query, retry: 0, cache: 'no-store', signal })
}
async function read(id?: string) {
  if (!usable.value || busy.value || intent.value || props.pending) return
  const scope = authority.value!,
    generation = ++epoch
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  busy.value = true
  status.value = 'idle'
  if (id) detail.value = null
  else {
    items.value = null
    detail.value = null
    selected.value = ''
  }
  try {
    const raw = await get(id ? `${root}/${id}` : root, signal)
    if (!current(generation, scope)) return
    if (id) {
      const result = adminOrderViewDetailSchema.parse(raw).view
      if (result.id !== id || result.archived) throw Error('unconfirmed_view')
      detail.value = result
      name.value = result.name
    } else items.value = list(raw)
  } catch (error) {
    failed(error, generation, scope)
  } finally {
    if (current(generation, scope)) {
      busy.value = false
      controller = null
    }
  }
}
async function choose() {
  detail.value = null
  if (selected.value && items.value?.some((view) => view.id === selected.value)) await read(selected.value)
}
function applyView() {
  if (usable.value && !busy.value && !intent.value && !props.pending && detail.value && !detail.value.archived)
    emit('apply', structuredClone(detail.value.definition))
}
async function confirm(receiptRaw: unknown, frozen: Intent, generation: number, signal: AbortSignal) {
  const receipt = adminOrderViewReceiptSchema.parse(receiptRaw)
  if (
    receipt.commandId !== frozen.key ||
    receipt.payloadHash !== frozen.hash ||
    receipt.action !== frozen.action ||
    (frozen.target !== null && receipt.viewId !== frozen.target) ||
    receipt.version !== frozen.version
  )
    throw Error('uncorrelated_receipt')
  const rawDetail = await get(`${root}/${receipt.viewId}`, signal)
  if (!current(generation, frozen.scope)) return
  const fresh = adminOrderViewDetailSchema.parse(rawDetail).view
  if (
    fresh.id !== receipt.viewId ||
    fresh.version < receipt.version ||
    (frozen.action === 'archive' && !fresh.archived) ||
    (frozen.action !== 'archive' && fresh.archived && fresh.version === receipt.version)
  )
    throw Error('unconfirmed_detail')
  if (frozen.action !== 'archive' && fresh.version === receipt.version) {
    const body = frozen.body as { name: string; definition: unknown }
    if (fresh.name !== body.name || JSON.stringify(fresh.definition) !== JSON.stringify(body.definition))
      throw Error('unconfirmed_definition')
  }
  const freshItems = list(await get(root, signal))
  if (!current(generation, frozen.scope)) return
  const match = freshItems.find((view) => view.id === fresh.id)
  if (fresh.archived ? Boolean(match) : !match || JSON.stringify(match) !== JSON.stringify(fresh))
    throw Error('unconfirmed_list')
  items.value = freshItems
  detail.value = fresh.archived ? null : fresh
  selected.value = fresh.archived ? '' : fresh.id
  name.value = fresh.archived ? '' : fresh.name
  intent.value = null
  status.value = fresh.archived && frozen.action !== 'archive' ? 'confirmed_archived' : 'confirmed'
  emit('pending', false)
}
async function write(action: Intent['action']) {
  if (!usable.value || busy.value || intent.value || props.pending) return
  const scope = authority.value!,
    generation = ++epoch,
    target = action === 'create' ? null : (detail.value?.id ?? null)
  if (action !== 'create' && !detail.value) return
  const definition = adminOrderViewDefinitionSchema.safeParse(props.appliedDefinition)
  const parsed =
    action === 'archive'
      ? adminOrderViewArchiveInputSchema.safeParse({ expectedVersion: detail.value?.version })
      : action === 'create'
        ? adminOrderViewCreateInputSchema.safeParse({
            name: name.value,
            definition: definition.success ? definition.data : props.appliedDefinition
          })
        : adminOrderViewUpdateInputSchema.safeParse({
            expectedVersion: detail.value?.version,
            name: name.value,
            definition: definition.success ? definition.data : props.appliedDefinition
          })
  if (!parsed.success) {
    status.value = 'error'
    return
  }
  const body = structuredClone(parsed.data),
    version = action === 'create' ? 1 : detail.value!.version + 1
  const appliedKey = JSON.stringify(props.appliedDefinition)
  busy.value = true
  status.value = 'idle'
  emit('pending', true)
  controller = new AbortController()
  const signal = controller.signal
  let acknowledged = false
  try {
    const key = crypto.randomUUID(),
      hash = await adminOrderViewIntentHash(action, target, body)
    if (!current(generation, scope) || props.pending || JSON.stringify(props.appliedDefinition) !== appliedKey) return
    const frozen: Intent = { action, target, key, hash, body, scope, version }
    intent.value = frozen
    const raw = await request<unknown>(
      action === 'create' ? root : action === 'archive' ? `${root}/${target}/archive` : `${root}/${target}`,
      {
        method: action === 'update' ? 'PUT' : 'POST',
        body,
        headers: { 'Idempotency-Key': key },
        retry: 0,
        cache: 'no-store',
        signal
      }
    )
    acknowledged = true
    if (current(generation, scope)) await confirm(raw, frozen, generation, signal)
  } catch (error) {
    if (
      !acknowledged &&
      current(generation, scope) &&
      errorCode(error).status === 409 &&
      errorCode(error).code === 'version_conflict'
    ) {
      intent.value = null
      status.value = 'conflict'
      emit('pending', false)
    } else failed(error, generation, scope)
  } finally {
    if (current(generation, scope)) {
      busy.value = false
      controller = null
      if (!intent.value) emit('pending', false)
    }
  }
}
async function recover() {
  const frozen = intent.value
  if (!usable.value || !frozen || busy.value || props.pending || authority.value !== frozen.scope) return
  const generation = ++epoch
  busy.value = true
  controller = new AbortController()
  const signal = controller.signal
  try {
    const raw = await get(`${root}/commands/${frozen.key}`, signal, { payloadHash: frozen.hash })
    if (!current(generation, frozen.scope)) return
    const result = adminOrderViewCommandSchema.parse(raw)
    if (result.outcome === 'unknown') {
      status.value = 'uncertain'
      return
    }
    await confirm(result.receipt, frozen, generation, signal)
  } catch (error) {
    failed(error, generation, frozen.scope)
  } finally {
    if (current(generation, frozen.scope)) {
      busy.value = false
      controller = null
    }
  }
}
</script>
<template>
  <section
    v-if="usable"
    aria-label="Vistas privadas de pedidos"
    :aria-busy="busy"
    class="min-w-0 space-y-3 rounded border p-4"
  >
    <h2 class="font-semibold">Vistas privadas de pedidos</h2>
    <p class="text-sm">
      Sólo tú puedes consultar estas vistas. Guardan filtros aplicados y columnas, nunca búsquedas ni datos de pedidos.
      Aplicar una vista consulta los pedidos actuales, sin ejecutar operaciones ni exportar.
    </p>
    <button data-views-refresh type="button" :disabled="busy || Boolean(intent) || pending" @click="read()">
      Consultar vistas
    </button>
    <p v-if="busy" role="status">Confirmando vista privada…</p>
    <p v-if="items && items.length === 0" data-views-empty role="status">No hay vistas privadas guardadas.</p>
    <label v-if="items && items.length"
      >Vista privada<select
        v-model="selected"
        data-views-select
        :disabled="busy || Boolean(intent) || pending"
        @change="choose"
      >
        <option value="">Selecciona una vista</option>
        <option v-for="view in items" :key="view.id" :value="view.id">{{ view.name }}</option>
      </select></label
    >
    <label class="block"
      >Nombre de la vista<input
        v-model="name"
        data-views-name
        maxlength="60"
        :disabled="busy || Boolean(intent) || pending"
        class="max-w-full rounded border p-2"
    /></label>
    <div class="flex flex-wrap gap-3">
      <button data-views-create type="button" :disabled="busy || Boolean(intent) || pending" @click="write('create')">
        Guardar configuración aplicada como nueva vista
      </button>
      <template v-if="detail">
        <button data-views-apply type="button" :disabled="busy || Boolean(intent) || pending" @click="applyView">
          Aplicar vista a filtros
        </button>
        <button data-views-update type="button" :disabled="busy || Boolean(intent) || pending" @click="write('update')">
          Actualizar vista con configuración aplicada
        </button>
        <button
          data-views-archive
          type="button"
          :disabled="busy || Boolean(intent) || pending"
          @click="write('archive')"
        >
          Archivar esta vista
        </button>
      </template>
    </div>
    <p v-if="status === 'error'" data-views-error role="alert">
      No se pudo confirmar la consulta o configuración. No se interpreta como una lista vacía.
    </p>
    <p v-if="status === 'confirmed' || status === 'confirmed_archived'" data-views-confirmed role="status">
      <template v-if="status === 'confirmed_archived'"
        >La operación original está confirmada; la vista fue archivada posteriormente. No se ha vuelto a
        crear.</template
      >
      <template v-else>Operación confirmada con recibo y lectura actual de la vista privada.</template>
    </p>
    <p v-if="status === 'conflict'" data-views-conflict role="alert">
      La versión ha cambiado. Conservamos el nombre del borrador; consulta y revisa la vista antes de una nueva
      operación explícita.
    </p>
    <div v-if="intent" data-views-uncertain role="alert">
      El resultado aún no está confirmado. No se reenviará la operación automáticamente.<button
        data-views-recover
        type="button"
        :disabled="busy || pending"
        @click="recover"
      >
        Comprobar resultado mediante GET
      </button>
    </div>
  </section>
</template>
