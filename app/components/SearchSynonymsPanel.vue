<script setup lang="ts">
import {
  searchSynonymDraftSchema,
  searchSynonymPreviewInputSchema,
  searchSynonymPreviewSchema,
  searchSynonymListSchema,
  searchSynonymReceiptSchema,
  searchSynonymCommandInputSchema,
  type SearchSynonymItem,
  type SearchSynonymPreview,
  type SearchSynonymReceipt
} from '~~/shared/search-synonyms'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
import { adminCapabilitiesSchema } from '~~/shared/admin-navigation'
import { useAdminNavigation } from '../composables/useAdminNavigation'
import { randomId } from '../utils/uuid'

const props = defineProps<{ runtime: unknown }>()
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
  // Bind every pending read/preview/command to both identity and session epoch.
  // Role labels and capability responses from another session never grant access.
  return `${parsed.data.identityId}:${parsed.data.sessionId}:${parsed.data.sessionVersion}`
})
const list = shallowRef<ReturnType<typeof searchSynonymListSchema.parse> | null>(null)
const readStatus = ref('idle'),
  search = ref(''),
  appliedSearch = ref(''),
  page = ref(1)
const mode = ref<'save' | 'retire' | null>(null),
  target = shallowRef<SearchSynonymItem | null>(null)
const sourceTerm = ref(''),
  replacements = ref(''),
  active = ref(true),
  reason = ref(''),
  query = ref('')
const preview = shallowRef<SearchSynonymPreview | null>(null),
  receipt = shallowRef<SearchSynonymReceipt | null>(null)
const preparing = ref(false),
  working = ref(false),
  looking = ref(false),
  unknown = ref(false),
  retryReady = ref(false)
const message = ref('')
let alive = true,
  epoch = 0,
  readSequence = 0,
  formVersion = 0
type Intent = Readonly<{
  key: string
  owner: string
  path: string
  method: 'POST' | 'PUT' | 'DELETE'
  body: string
  preview: SearchSynonymPreview
}>
let intent: Intent | null = null
const locked = computed(() => working.value || looking.value || unknown.value)
function live(owner: string | null, generation: number) {
  return alive && owner !== null && actor.value === owner && epoch === generation
}
function clearForm() {
  mode.value = null
  target.value = null
  preview.value = null
  reason.value = ''
  query.value = ''
}
function reset() {
  epoch++
  readSequence++
  list.value = null
  readStatus.value = 'idle'
  clearForm()
  receipt.value = null
  message.value = ''
  intent = null
  unknown.value = false
  retryReady.value = false
  working.value = false
  preparing.value = false
  looking.value = false
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
watch(
  [sourceTerm, replacements, active, reason, query, mode, target],
  () => {
    formVersion++
    preview.value = null
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  epoch++
  readSequence++
})
async function load() {
  const owner = actor.value,
    generation = epoch,
    sequence = ++readSequence,
    requestedPage = page.value
  if (!owner || !alive) return
  readStatus.value = 'pending'
  list.value = null
  try {
    const raw = await request<unknown>('/api/admin/search-synonyms', {
      method: 'GET',
      query: { page: requestedPage, perPage: 25, q: appliedSearch.value },
      retry: 0,
      cache: 'no-store'
    })
    if (!live(owner, generation) || sequence !== readSequence) return
    const parsed = searchSynonymListSchema.safeParse(catalogPolicyOwnJson(raw))
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
  page.value = 1
  void load()
}
function move(delta: number) {
  if (locked.value || readStatus.value !== 'success' || !list.value) return
  page.value += delta
  void load()
}
function begin(action: 'create' | 'edit' | 'pause' | 'retire', item?: SearchSynonymItem) {
  if (!actor.value || !alive || locked.value || preparing.value || readStatus.value !== 'success') return
  const current = item
    ? list.value?.items.find((row) => row.id === item.id && row.version === item.version && !row.retired)
    : null
  if (action !== 'create' && !current) return
  clearForm()
  receipt.value = null
  message.value = ''
  target.value = current ?? null
  mode.value = action === 'retire' ? 'retire' : 'save'
  sourceTerm.value = current?.sourceTerm ?? ''
  replacements.value = current?.replacements.join(', ') ?? ''
  active.value = action === 'pause' ? !current!.active : (current?.active ?? true)
  query.value = current?.sourceTerm ?? ''
}
function draft() {
  return searchSynonymDraftSchema.safeParse({
    id: target.value?.id ?? null,
    expectedVersion: target.value?.version ?? 0,
    sourceTerm: sourceTerm.value,
    replacements: replacements.value
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    active: active.value,
    reason: reason.value,
    action: mode.value
  })
}
async function prepare() {
  if (!actor.value || !alive || locked.value || preparing.value || !mode.value) return
  const parsedDraft = draft()
  if (!parsedDraft.success) {
    message.value = 'Revisa los términos (máximo 8, distintos) y el motivo.'
    return
  }
  const input = searchSynonymPreviewInputSchema.safeParse({ draft: parsedDraft.data, query: query.value })
  if (!input.success) {
    message.value = 'Escribe una consulta válida para la simulación.'
    return
  }
  const owner = actor.value,
    generation = epoch,
    version = formVersion,
    frozen = JSON.stringify(input.data)
  preparing.value = true
  preview.value = null
  message.value = ''
  try {
    const raw = await request<unknown>('/api/admin/search-synonyms/preview', {
      method: 'POST',
      body: JSON.parse(frozen),
      retry: 0
    })
    if (!live(owner, generation) || formVersion !== version) return
    const parsed = searchSynonymPreviewSchema.safeParse(catalogPolicyOwnJson(raw))
    if (
      !parsed.success ||
      JSON.stringify({ draft: parsed.data.draft, query: parsed.data.query }) !== frozen ||
      !Number.isFinite(Date.parse(parsed.data.expiresAt)) ||
      Date.parse(parsed.data.expiresAt) <= Date.now()
    )
      throw new Error('invalid_preview')
    preview.value = parsed.data
  } catch {
    if (live(owner, generation) && formVersion === version)
      message.value = 'No se ha podido confirmar la simulación. No se ha enviado ningún cambio.'
  } finally {
    if (live(owner, generation)) preparing.value = false
  }
}
function validReceipt(raw: unknown, command: Intent) {
  const parsed = searchSynonymReceiptSchema.safeParse(catalogPolicyOwnJson(raw))
  if (!parsed.success) return null
  const value = parsed.data,
    expected = command.preview.draft
  if (
    value.previewId !== command.preview.previewId ||
    value.action !== expected.action ||
    (expected.id !== null && value.item.id !== expected.id) ||
    value.item.version !== expected.expectedVersion + 1 ||
    value.item.sourceTerm !== expected.sourceTerm ||
    JSON.stringify(value.item.replacements) !== JSON.stringify(expected.replacements) ||
    value.item.retired !== (expected.action === 'retire') ||
    value.item.active !== (expected.action === 'retire' ? false : expected.active)
  )
    return null
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
const noEffectCodes = new Set([
  'invalid_input',
  'version_conflict',
  'preview_expired',
  'preview_stale',
  'preview_invalid',
  'preview_conflict',
  'source_conflict',
  'idempotency_conflict',
  'not_found',
  'unauthenticated',
  'email_unverified',
  'mfa_required',
  'csrf_rejected',
  'forbidden',
  'rate_limited'
])
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
  if (!alive || actor.value !== command.owner || working.value || looking.value) return
  const generation = epoch
  working.value = true
  retryReady.value = false
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
    if (typeof code === 'string' && noEffectCodes.has(code)) {
      intent = null
      unknown.value = false
      preview.value = null
      message.value = 'Cambio rechazado sin recibo confirmado. Lee el estado actual y prepara otra simulación.'
      await load()
    } else {
      unknown.value = true
      message.value = 'Resultado desconocido. Consulta el recibo antes de volver a enviar; no prepares otra simulación.'
    }
  } finally {
    if (live(command.owner, generation)) working.value = false
  }
}
async function submit() {
  if (!actor.value || !alive || locked.value || preparing.value || !preview.value) return
  if (Date.parse(preview.value.expiresAt) <= Date.now()) {
    preview.value = null
    message.value = 'La simulación ha caducado. Vuelve a simular antes de confirmar.'
    return
  }
  const value = preview.value,
    parsed = searchSynonymCommandInputSchema.safeParse({ previewId: value.previewId, previewHash: value.previewHash })
  if (!parsed.success) return
  intent = Object.freeze({
    key: randomId(),
    owner: actor.value,
    path: '/api/admin/search-synonyms' + (value.draft.id ? '/' + value.draft.id : ''),
    method: value.draft.action === 'retire' ? 'DELETE' : value.draft.id ? 'PUT' : 'POST',
    body: JSON.stringify(parsed.data),
    preview: value
  })
  await send(intent)
}
async function lookup() {
  const command = intent
  if (!command || !unknown.value || working.value || looking.value || actor.value !== command.owner || !alive) return
  const generation = epoch
  looking.value = true
  retryReady.value = false
  try {
    const raw = await request<unknown>('/api/admin/search-synonyms/commands/' + encodeURIComponent(command.key), {
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
      message.value =
        'Recibo no encontrado. Puedes reenviar explícitamente el mismo comando; conserva su clave y simulación original.'
    } else
      message.value =
        'No se ha podido confirmar el recibo. El resultado sigue desconocido; no se reenvía automáticamente.'
  } finally {
    if (live(command.owner, generation)) looking.value = false
  }
}
async function retry() {
  if (intent && retryReady.value && unknown.value) await send(intent)
}
</script>

<template>
  <section aria-label="Sinónimos de búsqueda" class="min-w-0 space-y-5 break-words">
    <h1 class="text-xl font-semibold">Relevancia de búsqueda</h1>
    <p>
      Conecta las palabras del cliente con el catálogo. Cada cambio exige motivo, simulación y confirmación; no modifica
      productos.
    </p>
    <p v-if="!actor" role="alert">
      Necesitas el permiso vigente de catálogo, correo verificado y MFA para consultar y cambiar sinónimos.
    </p>
    <template v-else>
      <form data-synonym-search-form class="flex flex-wrap gap-2" @submit.prevent="filter">
        <label :for="prefix + '-search'">Buscar sinónimos</label>
        <input
          :id="prefix + '-search'"
          v-model="search"
          data-synonym-search
          maxlength="160"
          :disabled="locked"
          class="min-w-0 rounded border p-2"
        />
        <button type="submit" :disabled="locked" class="rounded border px-3 py-2">Buscar</button>
      </form>
      <p v-if="readStatus === 'pending'" role="status">Consultando sinónimos…</p>
      <div v-else-if="readStatus === 'error'" role="alert">
        <p>No se ha podido confirmar la lista. Un error no significa que esté vacía.</p>
        <button
          data-synonym-read-retry
          type="button"
          :disabled="working || looking"
          class="rounded border p-2"
          @click="load"
        >
          Reintentar lectura
        </button>
      </div>
      <div v-else-if="readStatus === 'success' && list">
        <button
          data-synonym-create
          type="button"
          :disabled="locked || preparing"
          class="rounded border p-2"
          @click="begin('create')"
        >
          Añadir sinónimo
        </button>
        <p v-if="!list.items.length">No hay sinónimos que coincidan con esta búsqueda.</p>
        <ul data-synonym-list class="min-w-0 divide-y break-words">
          <li v-for="item in list.items" :key="item.id" class="flex min-w-0 flex-wrap items-center gap-3 py-3">
            <div class="min-w-0 flex-1">
              <p>{{ item.sourceTerm }} → {{ item.replacements.join(', ') }}</p>
              <p>Versión {{ item.version }} · {{ item.retired ? 'Retirado' : item.active ? 'Activo' : 'Pausado' }}</p>
            </div>
            <div v-if="!item.retired" class="flex flex-wrap gap-2">
              <button
                data-synonym-edit
                type="button"
                :disabled="locked || preparing"
                class="rounded border p-2"
                @click="begin('edit', item)"
              >
                Editar {{ item.sourceTerm }}
              </button>
              <button
                data-synonym-pause
                type="button"
                :disabled="locked || preparing"
                class="rounded border p-2"
                @click="begin('pause', item)"
              >
                {{ item.active ? 'Pausar' : 'Activar' }} {{ item.sourceTerm }}
              </button>
              <button
                data-synonym-retire
                type="button"
                :disabled="locked || preparing"
                class="rounded border p-2"
                @click="begin('retire', item)"
              >
                Retirar {{ item.sourceTerm }}
              </button>
            </div>
          </li>
        </ul>
        <nav aria-label="Páginas de sinónimos" class="flex flex-wrap items-center gap-3">
          <button type="button" :disabled="locked || list.page <= 1" class="rounded border p-2" @click="move(-1)">
            Anterior
          </button>
          <span>Página {{ list.page }} · {{ list.total }} sinónimos</span>
          <button
            data-synonym-next
            type="button"
            :disabled="locked || list.page * list.perPage >= list.total"
            class="rounded border p-2"
            @click="move(1)"
          >
            Siguiente
          </button>
        </nav>
      </div>
      <form v-if="mode" data-synonym-form class="space-y-3 rounded border p-4" @submit.prevent="prepare">
        <h2 class="font-semibold">
          {{ mode === 'retire' ? 'Retirar sinónimo' : target ? 'Editar sinónimo' : 'Nuevo sinónimo' }}
        </h2>
        <p v-if="mode === 'retire'">
          Retirar conserva el historial. La simulación muestra el efecto antes de confirmar.
        </p>
        <div>
          <label :for="prefix + '-source'">Término del cliente</label
          ><input
            :id="prefix + '-source'"
            v-model="sourceTerm"
            data-synonym-source
            maxlength="160"
            required
            :disabled="locked || mode === 'retire'"
            class="block w-full min-w-0 rounded border p-2"
          />
        </div>
        <div>
          <label :for="prefix + '-replacements'">Términos adicionales (máximo 8, separados por comas)</label
          ><input
            :id="prefix + '-replacements'"
            v-model="replacements"
            data-synonym-replacements
            required
            :disabled="locked || mode === 'retire'"
            class="block w-full min-w-0 rounded border p-2"
          />
        </div>
        <label class="flex gap-2"
          ><input v-model="active" type="checkbox" :disabled="locked || mode === 'retire'" />Activo</label
        >
        <div>
          <label :for="prefix + '-reason'">Motivo del cambio</label
          ><textarea
            :id="prefix + '-reason'"
            v-model="reason"
            data-synonym-reason
            required
            maxlength="500"
            :disabled="locked"
            class="block w-full min-w-0 rounded border p-2"
          />
        </div>
        <div>
          <label :for="prefix + '-query'">Consulta para comparar resultados</label
          ><input
            :id="prefix + '-query'"
            v-model="query"
            data-synonym-query
            required
            maxlength="160"
            :disabled="locked"
            class="block w-full min-w-0 rounded border p-2"
          />
        </div>
        <button type="submit" :disabled="locked || preparing" class="rounded border p-2">
          {{ preparing ? 'Simulando…' : 'Simular antes y después' }}
        </button>
        <button type="button" :disabled="locked || preparing" class="ml-2 rounded border p-2" @click="clearForm">
          Cancelar
        </button>
      </form>
      <div v-if="preview" class="space-y-3 rounded border p-4">
        <h2 class="font-semibold">Simulación confirmada por el servidor</h2>
        <p>Resultados orientativos del catálogo actual, hasta 8 por lado. La simulación no guarda el cambio.</p>
        <div class="grid min-w-0 gap-4 sm:grid-cols-2">
          <div>
            <h3>Antes</h3>
            <p>{{ preview.beforeTerms.join(', ') }}</p>
            <ul>
              <li v-for="result in preview.before" :key="result.slug">{{ result.name }}</li>
            </ul>
            <p v-if="!preview.before.length">Sin resultados</p>
          </div>
          <div>
            <h3>Después</h3>
            <p>{{ preview.afterTerms.join(', ') }}</p>
            <ul>
              <li v-for="result in preview.after" :key="result.slug">{{ result.name }}</li>
            </ul>
            <p v-if="!preview.after.length">Sin resultados</p>
          </div>
        </div>
        <p>Caduca: {{ preview.expiresAt }} · Motivo: {{ preview.draft.reason }}</p>
        <button
          data-synonym-confirm
          type="button"
          :disabled="locked || preparing"
          class="rounded border p-2"
          @click="submit"
        >
          Confirmar {{ preview.draft.action === 'retire' ? 'retirada' : 'cambio' }}
        </button>
      </div>
      <div v-if="unknown" class="space-y-2 rounded border p-4">
        <button
          data-synonym-lookup
          type="button"
          :disabled="working || looking"
          class="rounded border p-2"
          @click="lookup"
        >
          Consultar recibo del comando
        </button>
        <button
          v-if="retryReady"
          data-synonym-command-retry
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
        <h2>Recibo confirmado</h2>
        <p>Comando: {{ receipt.commandId }} · Simulación: {{ receipt.previewId }}</p>
        <p>{{ receipt.item.sourceTerm }} · versión {{ receipt.item.version }} · {{ receipt.action }}</p>
      </div>
    </template>
  </section>
</template>
