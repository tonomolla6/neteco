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
    message.value = 'Revisa las palabras (máximo 8, distintas) y el motivo.'
    return
  }
  const input = searchSynonymPreviewInputSchema.safeParse({ draft: parsedDraft.data, query: query.value })
  if (!input.success) {
    message.value = 'Escribe una búsqueda de prueba válida para la simulación.'
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
  message.value = 'Recibo confirmado. Actualizando la lista…'
  await load()
  if (live(command.owner, generation))
    message.value =
      readStatus.value === 'success'
        ? 'Recibo confirmado: el cambio se ha guardado.'
        : 'Recibo confirmado: el cambio se ha guardado, pero no se ha podido actualizar la lista. Recarga la lista; no repitas el cambio.'
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
      message.value = 'Cambio rechazado: no se ha guardado nada. Revisa la lista y vuelve a simular.'
      await load()
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
      message.value = 'El cambio no llegó a guardarse. Puedes volver a enviarlo tal cual.'
    } else
      message.value =
        'No se ha podido comprobar. El resultado sigue desconocido; vuelve a comprobarlo en unos segundos.'
  } finally {
    if (live(command.owner, generation)) looking.value = false
  }
}
async function retry() {
  if (intent && retryReady.value && unknown.value) await send(intent)
}
const needsSecondFactor = computed(
  () => session.ready.value === true && session.loggedIn.value === true && session.user.value?.mfaVerified !== true
)
/** Con el resultado sin confirmar se cierra el panel para dejar a la vista la comprobación. */
const drawerOpen = computed({
  get: () => mode.value === 'save' && !unknown.value,
  set: (open: boolean) => {
    if (!open && !locked.value && !preparing.value) clearForm()
  }
})
const retireOpen = computed({
  get: () => mode.value === 'retire' && !unknown.value,
  set: (open: boolean) => {
    if (!open && !locked.value && !preparing.value) clearForm()
  }
})
/** La retirada no cambia resultados que haya que comparar: se simula y se confirma en un paso. */
async function confirmRetire() {
  await prepare()
  if (preview.value?.draft.action === 'retire') await submit()
}
</script>

<template>
  <section aria-label="Sinónimos de búsqueda" class="adm-stack min-w-0">
    <AdminCard v-if="!actor">
      <AdminEmptyState
        v-if="needsSecondFactor"
        icon="i-lucide-shield-check"
        title="Hace falta la verificación en dos pasos"
        description="Por seguridad, los sinónimos solo se pueden cambiar con la verificación en dos pasos activada en tu cuenta. En la demostración pública no está disponible."
      />
      <AdminEmptyState
        v-else
        icon="i-lucide-lock"
        title="No puedes gestionar los sinónimos con esta sesión"
        description="Necesitas permiso de catálogo y el correo verificado. Si acabas de cambiar algo en tu cuenta, vuelve a entrar."
      />
    </AdminCard>
    <template v-else>
      <UAlert
        v-if="message && !drawerOpen && !retireOpen"
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
            data-synonym-lookup
            type="button"
            :disabled="working || looking"
            class="adm-btn adm-btn--secondary"
            @click="lookup"
          >
            Comprobar si se guardó
          </button>
          <button
            v-if="retryReady"
            data-synonym-command-retry
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
        :title="`Último cambio guardado: «${receipt.item.sourceTerm}» ${receipt.action === 'retire' ? 'retirado' : '→ ' + receipt.item.replacements.join(', ')}`"
        :description="`Referencia #${receipt.commandId.slice(0, 8).toUpperCase()}`"
        class="[overflow-wrap:anywhere]"
      />

      <div class="adm-card adm-tablecard min-w-0">
        <div class="adm-tablecard__bar">
          <div class="adm-toolbar">
            <form data-synonym-search-form class="contents" role="search" @submit.prevent="filter">
              <label class="adm-toolbar__search" :for="prefix + '-search'">
                <span class="sr-only">Buscar sinónimos</span>
                <UIcon name="i-lucide-search" class="size-4" />
                <input
                  :id="prefix + '-search'"
                  v-model="search"
                  data-synonym-search
                  data-slot="adm-search"
                  type="search"
                  placeholder="Buscar una palabra…"
                  maxlength="160"
                  :disabled="locked"
                />
              </label>
              <button type="submit" :disabled="locked" class="adm-btn adm-btn--secondary">Buscar</button>
            </form>
            <div v-if="readStatus === 'success' && list" class="adm-toolbar__end">
              <button
                data-synonym-create
                type="button"
                :disabled="locked || preparing"
                class="adm-btn adm-btn--primary"
                @click="begin('create')"
              >
                <UIcon name="i-lucide-plus" class="size-4 shrink-0" />Añadir sinónimo
              </button>
            </div>
          </div>
        </div>

        <div v-if="readStatus === 'pending'" class="adm-table-skeleton" role="status" aria-busy="true">
          <span class="sr-only">Cargando sinónimos…</span>
          <div v-for="row in 5" :key="row"><i /><i /><i /><i /></div>
        </div>
        <div v-else-if="readStatus === 'error'" role="alert">
          <AdminEmptyState
            variant="error"
            title="No se ha podido confirmar la lista de sinónimos"
            description="Es un fallo de carga: no significa que la lista esté vacía."
          >
            <button
              data-synonym-read-retry
              type="button"
              :disabled="working || looking"
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
            :variant="appliedSearch ? 'filtered' : 'empty'"
            icon="i-lucide-search-check"
            :title="appliedSearch ? 'Ningún sinónimo coincide con la búsqueda' : 'Todavía no has creado sinónimos'"
            :description="
              appliedSearch
                ? 'Prueba con otra palabra.'
                : 'Si un cliente busca «lejía» y el catálogo la llama «hipoclorito», un sinónimo hace que la encuentre.'
            "
          />
          <div v-else class="adm-table-wrap">
            <table data-synonym-list class="adm-table min-w-0 break-words">
              <thead>
                <tr>
                  <th scope="col">Lo que escribe el cliente</th>
                  <th scope="col">También se busca</th>
                  <th scope="col">Estado</th>
                  <th scope="col" data-numeric><span class="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in list.items" :key="item.id">
                  <td class="font-semibold text-[var(--text-strong)]">{{ item.sourceTerm }}</td>
                  <td>{{ item.replacements.join(', ') }}</td>
                  <td>
                    <AdminBadge :tone="item.retired ? 'neutral' : item.active ? 'success' : 'warning'">
                      {{ item.retired ? 'Retirado' : item.active ? 'Activo' : 'En pausa' }}
                    </AdminBadge>
                  </td>
                  <td data-numeric class="adm-table__actions">
                    <div v-if="!item.retired" class="flex flex-wrap justify-end gap-1.5">
                      <button
                        data-synonym-edit
                        type="button"
                        :disabled="locked || preparing"
                        :aria-label="`Editar ${item.sourceTerm}`"
                        class="adm-btn adm-btn--secondary adm-btn--sm"
                        @click="begin('edit', item)"
                      >
                        Editar
                      </button>
                      <button
                        data-synonym-pause
                        type="button"
                        :disabled="locked || preparing"
                        :aria-label="`${item.active ? 'Pausar' : 'Activar'} ${item.sourceTerm}`"
                        class="adm-btn adm-btn--secondary adm-btn--sm"
                        @click="begin('pause', item)"
                      >
                        {{ item.active ? 'Pausar' : 'Activar' }}
                      </button>
                      <button
                        data-synonym-retire
                        type="button"
                        :disabled="locked || preparing"
                        :aria-label="`Retirar ${item.sourceTerm}`"
                        class="adm-btn adm-btn--danger-soft adm-btn--sm"
                        @click="begin('retire', item)"
                      >
                        Retirar
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <nav aria-label="Páginas de sinónimos" class="adm-pagination">
            <p>{{ list.total }} {{ list.total === 1 ? 'sinónimo' : 'sinónimos' }}</p>
            <div class="flex items-center gap-2">
              <button
                type="button"
                :disabled="locked || list.page <= 1"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                @click="move(-1)"
              >
                Anterior
              </button>
              <span class="tabular-nums">Página {{ list.page }}</span>
              <button
                data-synonym-next
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

      <AdminDrawer
        v-model:open="drawerOpen"
        :title="
          target
            ? target.active === active
              ? 'Editar sinónimo'
              : active
                ? 'Activar sinónimo'
                : 'Pausar sinónimo'
            : 'Nuevo sinónimo'
        "
        description="Antes de guardar verás cómo cambian los resultados de la tienda."
        wide
      >
        <div class="adm-stack min-w-0">
          <UAlert
            v-if="message"
            role="status"
            aria-live="polite"
            color="neutral"
            variant="subtle"
            icon="i-lucide-info"
            :title="message"
          />
          <form :id="prefix + '-form'" data-synonym-form class="adm-stack" @submit.prevent="prepare">
            <div class="adm-field">
              <label :for="prefix + '-source'" class="adm-label">Lo que escribe el cliente</label>
              <input
                :id="prefix + '-source'"
                v-model="sourceTerm"
                data-synonym-source
                maxlength="160"
                required
                placeholder="lejía"
                :disabled="locked"
                class="w-full min-w-0"
              />
            </div>
            <div class="adm-field">
              <label :for="prefix + '-replacements'" class="adm-label">También se busca</label>
              <input
                :id="prefix + '-replacements'"
                v-model="replacements"
                data-synonym-replacements
                required
                placeholder="hipoclorito, cloro"
                :aria-describedby="prefix + '-replacements-help'"
                :disabled="locked"
                class="w-full min-w-0"
              />
              <p :id="prefix + '-replacements-help'" class="adm-help">Hasta 8 palabras, separadas por comas.</p>
            </div>
            <label class="adm-check"> <input v-model="active" type="checkbox" :disabled="locked" />Activo </label>
            <div class="adm-field">
              <label :for="prefix + '-reason'" class="adm-label">Motivo del cambio</label>
              <textarea
                :id="prefix + '-reason'"
                v-model="reason"
                data-synonym-reason
                required
                maxlength="500"
                :disabled="locked"
                class="w-full min-w-0"
              />
              <p class="adm-help">Queda guardado en el registro de actividad.</p>
            </div>
            <div class="adm-field">
              <label :for="prefix + '-query'" class="adm-label">Búsqueda de prueba</label>
              <input
                :id="prefix + '-query'"
                v-model="query"
                data-synonym-query
                required
                maxlength="160"
                :aria-describedby="prefix + '-query-help'"
                :disabled="locked"
                class="w-full min-w-0"
              />
              <p :id="prefix + '-query-help'" class="adm-help">
                Se usa para comparar los resultados de antes y de después.
              </p>
            </div>
          </form>

          <div v-if="preview" class="adm-stack border-t border-[var(--border)] pt-4">
            <div>
              <h3>Así cambian los resultados</h3>
              <p class="adm-help">
                Hasta 8 productos por lado, con el catálogo actual. Todavía no se ha guardado nada.
              </p>
            </div>
            <div class="grid min-w-0 gap-4 sm:grid-cols-2">
              <div class="min-w-0">
                <h3>Antes</h3>
                <p class="adm-help">{{ preview.beforeTerms.join(', ') }}</p>
                <ul class="mt-2 space-y-1">
                  <li v-for="result in preview.before" :key="result.slug">{{ result.name }}</li>
                </ul>
                <p v-if="!preview.before.length" class="adm-help mt-2">Sin resultados</p>
              </div>
              <div class="min-w-0">
                <h3>Después</h3>
                <p class="adm-help">{{ preview.afterTerms.join(', ') }}</p>
                <ul class="mt-2 space-y-1">
                  <li v-for="result in preview.after" :key="result.slug">{{ result.name }}</li>
                </ul>
                <p v-if="!preview.after.length" class="adm-help mt-2">Sin resultados</p>
              </div>
            </div>
            <p class="adm-help">La simulación caduca el {{ adminDate(preview.expiresAt, true) }}.</p>
          </div>
        </div>
        <template #footer>
          <button type="button" :disabled="locked || preparing" class="adm-btn adm-btn--secondary" @click="clearForm">
            Cancelar
          </button>
          <button
            type="submit"
            :form="prefix + '-form'"
            :disabled="locked || preparing"
            class="adm-btn"
            :class="preview ? 'adm-btn--secondary' : 'adm-btn--primary'"
          >
            {{ preparing ? 'Simulando…' : preview ? 'Volver a simular' : 'Simular el cambio' }}
          </button>
          <button
            v-if="preview"
            data-synonym-confirm
            type="button"
            :disabled="locked || preparing"
            class="adm-btn adm-btn--primary"
            @click="submit"
          >
            Guardar cambio
          </button>
        </template>
      </AdminDrawer>

      <AdminConfirm
        v-model:open="retireOpen"
        title="Retirar sinónimo"
        :description="`Quien busque «${target?.sourceTerm ?? ''}» dejará de encontrar también «${target?.replacements.join(', ') ?? ''}». Se conserva el historial.`"
        confirm-label="Retirar"
        danger
        :loading="preparing || working"
        :confirm-disabled="locked || preparing || !reason.trim()"
        @confirm="confirmRetire"
      >
        <div class="adm-field">
          <label :for="prefix + '-retire-reason'" class="adm-label">Motivo de la retirada</label>
          <textarea
            :id="prefix + '-retire-reason'"
            v-model="reason"
            data-synonym-reason
            required
            maxlength="500"
            :disabled="locked || preparing"
            class="adm-input"
          />
          <p class="adm-help">Si solo quieres probar sin perderlo, ponlo en pausa en lugar de retirarlo.</p>
          <p v-if="message" class="adm-field__error" role="alert">{{ message }}</p>
        </div>
      </AdminConfirm>
    </template>
  </section>
</template>
