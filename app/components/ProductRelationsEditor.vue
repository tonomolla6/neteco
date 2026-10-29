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
  <section v-if="authorized" aria-label="Relaciones dirigidas de producto" class="min-w-0 space-y-3">
    <h2>Relaciones dirigidas de producto</h2>
    <p>
      Una relación origen → destino no confirma compatibilidad química ni reciprocidad. Requiere revisión documental
      manual.
    </p>
    <p v-if="state === 'loading'" role="status">Consultando relaciones…</p>
    <p v-else-if="state === 'error'" role="alert">
      No se pudieron consultar las relaciones. No se habilitarán cambios.
    </p>
    <button v-if="state === 'error'" type="button" :disabled="busy" @click="read">Actualizar relaciones</button>
    <template v-if="snapshot">
      <p v-if="!relations.length">Sin relaciones configuradas</p>
      <ul>
        <li v-for="(item, index) in relations" :key="item.targetProductId + ':' + item.kind">
          Producto {{ item.targetProductId }} · {{ item.kind }}
          <button type="button" :disabled="busy || !!intent" @click="relations.splice(index, 1)">
            Quitar relación
          </button>
        </li>
      </ul>
      <form data-relation-search @submit.prevent="search">
        <label
          >Buscar producto <input v-model="query" data-relation-query maxlength="100" :disabled="busy || !!intent"
        /></label>
        <button type="submit" :disabled="busy || !!intent">Buscar</button>
      </form>
      <ul>
        <li v-for="choice in choices" :key="choice.id">
          <button
            type="button"
            :data-relation-pick="choice.id"
            :disabled="busy || !!intent"
            @click="picked = choice.id"
          >
            {{ choice.name }}
          </button>
        </li>
      </ul>
      <label
        >Tipo de relación
        <select v-model="kind" data-relation-kind :disabled="busy || !!intent">
          <option value="substitute">Sustitución</option>
          <option value="compatible">Compatibilidad</option>
          <option value="accessory">Accesorio</option>
          <option value="equivalent">Equivalente</option>
        </select></label
      >
      <button data-relation-add type="button" :disabled="busy || !!intent || picked === null" @click="add">
        Añadir relación dirigida
      </button>
      <form data-relation-review @submit.prevent="review">
        <label
          >Motivo <textarea v-model="reason" data-relation-reason maxlength="500" :disabled="busy || !!intent" />
        </label>
        <label
          >Referencia de revisión manual
          <input v-model="reference" data-relation-reference maxlength="200" :disabled="busy || !!intent"
        /></label>
        <button type="submit" :disabled="busy || !!intent">Revisar cambios</button>
      </form>
      <template v-if="intent">
        <p>
          Se enviará la instantánea revisada, versión {{ intent.body.expectedVersion }}. No se crean relaciones
          inversas.
        </p>
        <button v-if="!intent.sent" data-relation-confirm type="button" :disabled="busy" @click="send">
          Confirmar relaciones
        </button>
        <template v-else
          ><button data-relation-check type="button" :disabled="busy" @click="check">Comprobar operación</button
          ><button type="button" :disabled="busy" @click="send">
            Reintentar exactamente la misma operación
          </button></template
        >
      </template>
    </template>
    <p v-if="feedback" role="status">{{ feedback }}</p>
  </section>
</template>
