<script setup lang="ts">
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import { adminCapabilitiesSchema } from '~~/shared/admin-navigation'
import { catalogPriceListSchema } from '~~/shared/catalog-price-commands'
import {
  adminCatalogRelationsSchema,
  catalogRelationsInputSchema,
  catalogRelationsReceiptSchema,
  catalogRelationsCommandSchema,
  catalogRelationsIntentHash,
  type AdminCatalogRelations,
  type CatalogRelationsInput
} from '~~/shared/catalog-relations'
const props = defineProps<{ productId: number; runtime: unknown }>()
const request = useRequestFetch(),
  navigation = useAdminNavigation()
const { ready, loggedIn, user, session } = useUserSession()
const caps = computed(() => {
  const p = adminCapabilitiesSchema.safeParse(navigation.capabilities.value)
  return p.success ? p.data : null
})
const boundary = computed(() =>
  JSON.stringify([
    props.productId,
    props.runtime,
    ready.value,
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified,
    user.value?.mfaVerified,
    session.value,
    caps.value,
    navigation.status.value
  ])
)
const revoked = ref<string | null>(null)
const authorized = computed(
  () =>
    props.runtime === 'cloudflare' &&
    ready.value &&
    loggedIn.value &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true &&
    navigation.status.value === 'ready' &&
    caps.value?.state === 'ready' &&
    caps.value.identityId === user.value.id &&
    caps.value.sessionId === session.value?.sessionId &&
    caps.value.sessionVersion === session.value?.sessionVersion &&
    caps.value.permissions.includes('catalog.write') &&
    revoked.value !== boundary.value
)
const root = computed(() => `/api/admin/products/${props.productId}/relations`)
const snapshot = shallowRef<AdminCatalogRelations | null>(null),
  state = ref<'loading' | 'ready' | 'error'>('loading')
const query = ref(''),
  choices = ref<Array<{ id: number; name: string }>>([]),
  picked = ref<number | null>(null)
const kind = ref<'substitute' | 'compatible' | 'accessory' | 'equivalent'>('substitute')
const KIND_LABELS: Record<'substitute' | 'compatible' | 'accessory' | 'equivalent', string> = {
  substitute: 'Sustitución',
  compatible: 'Compatibilidad',
  accessory: 'Accesorio',
  equivalent: 'Equivalente'
}
const relations = ref<CatalogRelationsInput['relations']>([]),
  reason = ref(''),
  reference = ref(''),
  feedback = ref(''),
  busy = ref(false)
type Intent = {
  body: CatalogRelationsInput
  key: string
  hash: string
  scope: string
  productId: number
  sent: boolean
}
const intent = shallowRef<Intent | null>(null)
let generation = 0,
  alive = true
const current = (scope: string, token: number) =>
  alive && authorized.value && boundary.value === scope && token === generation
function purge() {
  generation++
  snapshot.value = null
  relations.value = []
  query.value = ''
  choices.value = []
  picked.value = null
  reason.value = ''
  reference.value = ''
  feedback.value = ''
  intent.value = null
  busy.value = false
  state.value = 'loading'
}
function failure(error: unknown, scope: string) {
  const e = error as { statusCode?: number; status?: number; response?: { status?: number } }
  if (boundary.value === scope && [401, 403].includes(e?.statusCode ?? e?.status ?? e?.response?.status ?? 0)) {
    purge()
    revoked.value = scope
    return true
  }
  return false
}
async function read() {
  if (!authorized.value || busy.value || intent.value) return
  const scope = boundary.value,
    token = generation
  busy.value = true
  state.value = 'loading'
  snapshot.value = null
  try {
    const data = adminCatalogRelationsSchema.parse(await request(root.value, { cache: 'no-store', retry: 0 }))
    if (!current(scope, token)) return
    if (data.productId !== props.productId) throw new Error('correlation')
    snapshot.value = data
    relations.value = data.items.map((item) => ({ ...item }))
    state.value = 'ready'
  } catch (error) {
    if (current(scope, token) && !failure(error, scope)) state.value = 'error'
  } finally {
    if (current(scope, token)) busy.value = false
  }
}
async function search() {
  if (!authorized.value || busy.value || intent.value) return
  const scope = boundary.value,
    token = generation
  busy.value = true
  choices.value = []
  try {
    const data = catalogPriceListSchema.parse(
      await request('/api/admin/prices', {
        query: { q: query.value, page: 1, perPage: 25, historyPerPage: 1 },
        cache: 'no-store',
        retry: 0
      })
    )
    if (data.items.length > 25 || data.pagination.page !== 1 || data.pagination.perPage !== 25)
      throw new Error('picker correlation')
    if (!current(scope, token)) return
    choices.value = [
      ...new Map(
        data.items
          .filter((item) => item.productId !== props.productId)
          .map((item) => [item.productId, { id: item.productId, name: item.product }])
      ).values()
    ]
    feedback.value = 'Resultados de productos limitados a esta página de búsqueda.'
  } catch (error) {
    if (current(scope, token) && !failure(error, scope)) feedback.value = 'No se pudieron buscar productos.'
  } finally {
    if (current(scope, token)) busy.value = false
  }
}
function add() {
  if (!authorized.value || intent.value || picked.value === null || relations.value.length >= 50) return
  if (!relations.value.some((item) => item.targetProductId === picked.value && item.kind === kind.value))
    relations.value.push({ targetProductId: picked.value, kind: kind.value })
}
async function review() {
  if (!authorized.value || busy.value || intent.value || !snapshot.value) return
  const parsed = catalogRelationsInputSchema.safeParse({
    expectedVersion: snapshot.value.version,
    relations: relations.value,
    reason: reason.value,
    reviewReference: reference.value
  })
  if (!parsed.success) {
    feedback.value = 'Revise las relaciones, el motivo y la referencia de revisión obligatoria.'
    return
  }
  const scope = boundary.value,
    token = generation,
    productId = props.productId
  busy.value = true
  try {
    const hash = await catalogRelationsIntentHash(productId, parsed.data)
    if (current(scope, token))
      intent.value = { body: parsed.data, key: crypto.randomUUID(), hash, scope, productId, sent: false }
  } finally {
    if (current(scope, token)) busy.value = false
  }
}
async function confirmReceipt(raw: unknown, frozen: Intent, token: number) {
  const receipt = catalogRelationsReceiptSchema.parse(raw)
  if (
    receipt.commandId !== frozen.key ||
    receipt.payloadHash !== frozen.hash ||
    receipt.productId !== frozen.productId ||
    receipt.expectedVersion !== frozen.body.expectedVersion
  )
    throw new Error('correlation')
  const data = adminCatalogRelationsSchema.parse(await request(root.value, { cache: 'no-store', retry: 0 }))
  if (!current(frozen.scope, token) || intent.value !== frozen) return
  const same = (items: CatalogRelationsInput['relations']) =>
    items
      .map((item) => `${item.targetProductId}:${item.kind}`)
      .sort()
      .join(',')
  if (
    data.productId !== frozen.productId ||
    data.version !== receipt.version ||
    same(data.items) !== same(frozen.body.relations)
  )
    throw new Error('fresh correlation')
  snapshot.value = data
  relations.value = data.items.map((item) => ({ ...item }))
  intent.value = null
  reason.value = ''
  reference.value = ''
  feedback.value = 'Relaciones confirmadas.'
}
async function send() {
  const frozen = intent.value
  if (!frozen || !authorized.value || frozen.scope !== boundary.value || busy.value) return
  const token = generation
  busy.value = true
  frozen.sent = true
  feedback.value = 'Resultado incierto hasta confirmar el recibo y la lectura actual.'
  try {
    const raw = await request(`${root.value}/commands`, {
      method: 'POST',
      body: frozen.body,
      headers: { 'Idempotency-Key': frozen.key },
      retry: 0
    })
    if (current(frozen.scope, token)) await confirmReceipt(raw, frozen, token)
  } catch (error) {
    if (current(frozen.scope, token) && !failure(error, frozen.scope))
      feedback.value = 'Resultado incierto. Compruebe la operación antes de continuar.'
  } finally {
    if (current(frozen.scope, token)) busy.value = false
  }
}
async function check() {
  const frozen = intent.value
  if (!frozen || !authorized.value || busy.value) return
  const token = generation
  busy.value = true
  try {
    const data = catalogRelationsCommandSchema.parse(
      await request(`${root.value}/commands/${frozen.key}`, {
        headers: { 'X-Neteco-Command-Payload-Hash': frozen.hash },
        retry: 0
      })
    )
    if (!current(frozen.scope, token)) return
    if (data.outcome === 'applied') await confirmReceipt(data.receipt, frozen, token)
    else feedback.value = 'Resultado incierto. La consulta no demuestra ausencia de cambios.'
  } catch (error) {
    if (current(frozen.scope, token) && !failure(error, frozen.scope))
      feedback.value = 'Resultado incierto. No se pudo confirmar la operación.'
  } finally {
    if (current(frozen.scope, token)) busy.value = false
  }
}
watch(
  boundary,
  () => {
    purge()
    if (authorized.value) void read()
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  purge()
})
</script>

<template>
  <AdminCard
    v-if="authorized"
    aria-label="Relaciones dirigidas de producto"
    title="Productos relacionados"
    description="Sustitutos, compatibles, accesorios y equivalentes que se sugieren desde este producto. Una relación no confirma compatibilidad química ni se aplica en sentido contrario: revísala con la documentación técnica."
  >
    <div class="adm-stack min-w-0">
      <p v-if="state === 'loading'" role="status" class="adm-help">Cargando productos relacionados…</p>
      <UAlert
        v-else-if="state === 'error'"
        role="alert"
        color="error"
        variant="subtle"
        title="No se han podido cargar los productos relacionados, así que no se pueden hacer cambios."
      />
      <div v-if="state === 'error'">
        <button type="button" class="adm-btn adm-btn--secondary adm-btn--sm" :disabled="busy" @click="read">
          <UIcon name="i-lucide-rotate-cw" class="size-4" />Volver a cargar
        </button>
      </div>
      <template v-if="snapshot">
        <AdminEmptyState
          v-if="!relations.length"
          compact
          icon="i-lucide-link"
          title="Sin relaciones configuradas"
          description="Busca un producto abajo y añádelo."
        />
        <ul v-else class="adm-list">
          <li
            v-for="(item, index) in relations"
            :key="item.targetProductId + ':' + item.kind"
            class="flex flex-wrap items-center justify-between gap-2"
          >
            <span class="min-w-0">
              <span class="font-medium text-[var(--text-strong)]">Producto n.º {{ item.targetProductId }}</span>
              <AdminBadge class="ml-2">{{ KIND_LABELS[item.kind] }}</AdminBadge>
            </span>
            <button
              type="button"
              class="adm-btn adm-btn--ghost adm-btn--sm"
              :disabled="busy || !!intent"
              @click="relations.splice(index, 1)"
            >
              <UIcon name="i-lucide-x" class="size-4" />Quitar
            </button>
          </li>
        </ul>

        <div class="rounded-[var(--radius-surface)] border border-[var(--border)] p-4">
          <h3 class="adm-label">Añadir un producto relacionado</h3>
          <form data-relation-search class="mt-2 flex flex-wrap items-end gap-2" @submit.prevent="search">
            <label class="adm-label min-w-0 flex-1"
              >Buscar producto
              <input
                v-model="query"
                data-relation-query
                maxlength="100"
                class="adm-input mt-1 w-full"
                placeholder="Nombre o referencia"
                :disabled="busy || !!intent"
            /></label>
            <button type="submit" class="adm-btn adm-btn--secondary" :disabled="busy || !!intent">Buscar</button>
          </form>
          <ul v-if="choices.length" class="mt-3 flex flex-wrap gap-2">
            <li v-for="choice in choices" :key="choice.id">
              <button
                type="button"
                class="adm-chip"
                :data-relation-pick="choice.id"
                :aria-pressed="picked === choice.id"
                :disabled="busy || !!intent"
                @click="picked = choice.id"
              >
                {{ choice.name }}
              </button>
            </li>
          </ul>
          <div class="mt-3 flex flex-wrap items-end gap-2">
            <label class="adm-label"
              >Tipo de relación
              <select v-model="kind" data-relation-kind class="adm-input mt-1" :disabled="busy || !!intent">
                <option value="substitute">Sustitución</option>
                <option value="compatible">Compatibilidad</option>
                <option value="accessory">Accesorio</option>
                <option value="equivalent">Equivalente</option>
              </select></label
            >
            <button
              data-relation-add
              type="button"
              class="adm-btn adm-btn--secondary"
              :disabled="busy || !!intent || picked === null"
              @click="add"
            >
              <UIcon name="i-lucide-plus" class="size-4" />Añadir
            </button>
          </div>
        </div>

        <form data-relation-review class="adm-stack" @submit.prevent="review">
          <div class="adm-form-grid">
            <label class="adm-label"
              >Motivo del cambio
              <textarea
                v-model="reason"
                data-relation-reason
                maxlength="500"
                rows="2"
                class="adm-input mt-1 w-full"
                :disabled="busy || !!intent"
              />
            </label>
            <label class="adm-label"
              >Documento o nota de la revisión
              <input
                v-model="reference"
                data-relation-reference
                maxlength="200"
                class="adm-input mt-1 w-full"
                placeholder="Ficha técnica, correo del proveedor…"
                :disabled="busy || !!intent"
            /></label>
          </div>
          <div>
            <button type="submit" class="adm-btn adm-btn--secondary" :disabled="busy || !!intent">
              Revisar cambios
            </button>
          </div>
        </form>
        <UAlert
          v-if="intent"
          color="warning"
          variant="subtle"
          title="Se guardará la lista tal como la ves. No se crean relaciones en sentido contrario."
        />
        <div v-if="intent" class="flex flex-wrap gap-2">
          <button
            v-if="!intent.sent"
            data-relation-confirm
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="busy"
            @click="send"
          >
            Guardar productos relacionados
          </button>
          <template v-else
            ><button
              data-relation-check
              type="button"
              class="adm-btn adm-btn--secondary"
              :disabled="busy"
              @click="check"
            >
              Comprobar si se ha guardado</button
            ><button type="button" class="adm-btn adm-btn--ghost" :disabled="busy" @click="send">
              Reintentar el mismo guardado
            </button></template
          >
        </div>
      </template>
      <p v-if="feedback" role="status" class="adm-help">{{ feedback }}</p>
    </div>
  </AdminCard>
</template>
