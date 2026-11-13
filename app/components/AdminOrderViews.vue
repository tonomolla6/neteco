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
  <section v-if="usable" aria-label="Vistas privadas de pedidos" :aria-busy="busy" class="min-w-0 space-y-3">
    <div class="flex flex-wrap items-end gap-x-3 gap-y-2">
      <label v-if="items && items.length" class="adm-field w-full sm:w-64"
        ><span class="adm-label">Vista guardada</span
        ><select
          v-model="selected"
          data-views-select
          class="adm-input w-full"
          :disabled="busy || Boolean(intent) || pending"
          @change="choose"
        >
          <option value="">Elige una vista</option>
          <option v-for="view in items" :key="view.id" :value="view.id">{{ view.name }}</option>
        </select></label
      >
      <button
        v-if="detail"
        data-views-apply
        type="button"
        class="adm-btn adm-btn--primary"
        :disabled="busy || Boolean(intent) || pending"
        @click="applyView"
      >
        Aplicar vista
      </button>
      <button
        data-views-refresh
        type="button"
        class="adm-btn adm-btn--secondary"
        :disabled="busy || Boolean(intent) || pending"
        @click="read()"
      >
        <UIcon name="i-lucide-rotate-cw" class="size-4" :class="busy && 'animate-spin'" />
        {{ items ? 'Actualizar lista' : 'Cargar mis vistas' }}
      </button>
      <p v-if="busy" role="status" class="adm-help self-center">Cargando…</p>
      <p v-if="items && items.length === 0" data-views-empty role="status" class="adm-help self-center">
        No hay vistas guardadas todavía.
      </p>
    </div>
    <div class="flex flex-wrap items-end gap-x-3 gap-y-2 border-t border-[var(--border)] pt-3">
      <label class="adm-field w-full sm:w-64"
        ><span class="adm-label">Nombre de la vista</span
        ><input
          v-model="name"
          data-views-name
          maxlength="60"
          placeholder="Por ejemplo: pendientes de hoy"
          :disabled="busy || Boolean(intent) || pending"
          class="adm-input w-full"
      /></label>
      <button
        data-views-create
        type="button"
        class="adm-btn adm-btn--secondary"
        :disabled="busy || Boolean(intent) || pending"
        @click="write('create')"
      >
        Guardar como vista nueva
      </button>
      <template v-if="detail">
        <button
          data-views-update
          type="button"
          class="adm-btn adm-btn--secondary"
          :disabled="busy || Boolean(intent) || pending"
          @click="write('update')"
        >
          Actualizar esta vista
        </button>
        <button
          data-views-archive
          type="button"
          class="adm-btn adm-btn--danger-soft"
          :disabled="busy || Boolean(intent) || pending"
          @click="write('archive')"
        >
          Archivar
        </button>
      </template>
    </div>
    <p class="adm-help">
      Una vista guarda los filtros y las columnas que tienes aplicados ahora (no la búsqueda). Solo las ves tú.
    </p>
    <div v-if="status === 'error'" data-views-error role="alert">
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="No se ha podido completar"
        description="Revisa el nombre de la vista y vuelve a intentarlo."
      />
    </div>
    <div v-if="status === 'confirmed' || status === 'confirmed_archived'" data-views-confirmed role="status">
      <UAlert
        color="success"
        variant="subtle"
        icon="i-lucide-circle-check"
        :title="
          status === 'confirmed_archived'
            ? 'El cambio se guardó, pero la vista fue archivada posteriormente. No se ha vuelto a crear.'
            : 'Cambios confirmados en tus vistas.'
        "
      />
    </div>
    <div v-if="status === 'conflict'" data-views-conflict role="alert">
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Esta vista se ha modificado desde otra sesión"
        description="Hemos conservado el nombre que has escrito. Actualiza la lista y revisa la vista antes de volver a guardar."
      />
    </div>
    <div v-if="intent" data-views-uncertain role="alert">
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-hourglass"
        title="Todavía no sabemos si se ha guardado"
        description="No se volverá a enviar por su cuenta. Comprueba el resultado antes de seguir."
      />
      <button
        data-views-recover
        type="button"
        class="adm-btn adm-btn--secondary mt-2"
        :disabled="busy || pending"
        @click="recover"
      >
        Comprobar resultado
      </button>
    </div>
  </section>
</template>
