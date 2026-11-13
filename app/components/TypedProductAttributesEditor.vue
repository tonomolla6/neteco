<script setup lang="ts">
import {
  CATALOG_TYPED_ATTRIBUTE_UNITS,
  validateTypedAttributeValues,
  type CatalogTypedAttributeDefinition,
  type CatalogTypedAttributeValues,
  type CatalogTypedAttributeValue,
  type CatalogTypedAttributeUnit
} from '~~/shared/catalog-typed-attributes'
import {
  catalogTypedAttributeProductViewSchema,
  catalogTypedAttributeValuesReceiptSchema,
  updateCatalogTypedAttributeValuesSchema,
  type CatalogTypedAttributeProductView,
  type CatalogTypedAttributeValuesReceipt
} from '~~/shared/catalog-typed-attribute-views'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import { randomId } from '../utils/uuid'
import ReferencePicker from './ReferencePicker.vue'

const props = defineProps<{ runtime: unknown; available?: boolean; product: unknown }>()
const emit = defineEmits<{ completed: [receipt: CatalogTypedAttributeValuesReceipt] }>()
const request = useRequestFetch(),
  { ready, loggedIn, user } = useUserSession(),
  prefix = useId()
const actor = computed(() => {
  const value: unknown = user.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const field = (key: string) => {
    Reflect.has(value, key)
    return Object.getOwnPropertyDescriptor(value, key)?.value
  }
  if (field('role') !== 'admin' || field('emailVerified') !== true || field('mfaVerified') !== true) return null
  const parsed = catalogPolicyUuidSchema.safeParse(field('id'))
  return parsed.success ? parsed.data : null
})
const parent = computed(() => {
  try {
    const raw = props.product
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    for (const key of ['id', 'uuid', 'categoryId', 'categoryUuid', 'catalogVersion', 'status']) Reflect.has(raw, key)
    const value = catalogPolicyOwnJson(raw) as Record<string, unknown>
    if (
      !Number.isSafeInteger(value.id) ||
      (value.id as number) < 1 ||
      typeof value.uuid !== 'string' ||
      !value.uuid.trim() ||
      !Number.isSafeInteger(value.categoryId) ||
      (value.categoryId as number) < 1 ||
      !Number.isSafeInteger(value.catalogVersion) ||
      (value.catalogVersion as number) < 1 ||
      typeof value.status !== 'string'
    )
      return null
    if (value.categoryUuid !== undefined && (typeof value.categoryUuid !== 'string' || !value.categoryUuid.trim()))
      return null
    return {
      id: value.id as number,
      uuid: value.uuid,
      categoryId: value.categoryId as number,
      categoryUuid: value.categoryUuid as string | undefined,
      catalogVersion: value.catalogVersion as number,
      status: value.status
    }
  } catch {
    return null
  }
})
const allowed = computed(
  () =>
    props.runtime === 'cloudflare' &&
    props.available === true &&
    ready.value === true &&
    loggedIn.value === true &&
    !!actor.value &&
    !!parent.value
)
const authority = computed(() => JSON.stringify([allowed.value, actor.value, parent.value]))
const view = shallowRef<CatalogTypedAttributeProductView | null>(null),
  loading = ref(false),
  busy = ref(false),
  uncertain = ref(false),
  rejected = ref(false),
  rejectionRead = ref(false),
  blocked = ref(false),
  message = ref('')
const reason = ref(''),
  confirmation = ref(false)
type Entry = CatalogTypedAttributeValues['values'][number]
type Field = { present: boolean; input: string | number; unit: CatalogTypedAttributeUnit; selections: string[] }
const fields = reactive<Record<string, Field>>({}),
  historical = ref<Entry[]>([])
type Intent = Readonly<{
  owner: string
  parent: string
  productId: number
  productUuid: string
  categoryId: number
  categoryUuid: string
  expectedVersion: number
  body: string
  key: string
}>
const intent = shallowRef<Intent | null>(null)
let epoch = 0,
  alive = true
watch(
  authority,
  () => {
    epoch++
    view.value = null
    intent.value = null
    historical.value = []
    for (const key of Object.keys(fields)) Reflect.deleteProperty(fields, key)
    reason.value = ''
    confirmation.value = false
    uncertain.value = false
    rejected.value = false
    rejectionRead.value = false
    blocked.value = false
    message.value = ''
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  epoch++
})
const current = computed(() => {
  const result = new Map<string, CatalogTypedAttributeDefinition>()
  for (const definition of view.value?.definitions ?? [])
    if ((result.get(definition.id)?.revision ?? 0) < definition.revision) result.set(definition.id, definition)
  return [...result.values()]
})
const editable = computed(() =>
  current.value.filter(
    (definition) =>
      definition.status === 'active' && !historical.value.some((entry) => entry.definitionId === definition.id)
  )
)
const frozen = computed(() => loading.value || busy.value || !!intent.value || blocked.value)
function writable() {
  return (
    allowed.value &&
    parent.value?.status === 'draft' &&
    view.value?.product.status === 'draft' &&
    view.value.capabilities.update === true
  )
}
function initialize(data: CatalogTypedAttributeProductView) {
  historical.value = []
  for (const key of Object.keys(fields)) Reflect.deleteProperty(fields, key)
  const latest = new Map<string, CatalogTypedAttributeDefinition>()
  for (const definition of data.definitions)
    if ((latest.get(definition.id)?.revision ?? 0) < definition.revision) latest.set(definition.id, definition)
  for (const entry of data.typed.values) {
    const validation = validateTypedAttributeValues({ version: 1, values: [entry] }, data.definitions, {
      categoryId: data.product.categoryId,
      mode: 'write'
    })
    if (!validation.success) historical.value.push(structuredClone(entry))
  }
  for (const definition of latest.values()) {
    const entry = data.typed.values.find((item) => item.definitionId === definition.id),
      value = entry?.value
    fields[definition.id] = {
      present: !!entry,
      input:
        value === undefined
          ? definition.kind === 'boolean'
            ? 'false'
            : ''
          : typeof value === 'object'
            ? Array.isArray(value)
              ? ''
              : String(value.quantity)
            : String(value),
      unit:
        definition.kind === 'unit'
          ? value && typeof value === 'object' && !Array.isArray(value)
            ? value.unit
            : definition.config.units[0]!
          : 'ud',
      selections: Array.isArray(value) ? [...value] : []
    }
  }
  reason.value = ''
  confirmation.value = false
}
function entryValue(definition: CatalogTypedAttributeDefinition, field: Field): CatalogTypedAttributeValue | null {
  if (definition.kind === 'text' || definition.kind === 'reference')
    return typeof field.input === 'string' ? field.input : null
  if (definition.kind === 'boolean') return field.input === 'true' ? true : field.input === 'false' ? false : null
  if (definition.kind === 'list') return [...field.selections]
  // Parsing is limited to this explicitly numeric control; blank is absence of
  // valid input, never numeric zero. The shared validator enforces precision.
  if (typeof field.input === 'string' && !field.input.trim()) return null
  const value = Number(field.input)
  return definition.kind === 'unit' ? { quantity: value, unit: field.unit } : value
}
function prepared() {
  const binding = view.value
  if (!binding || !writable() || !confirmation.value) return null
  const values: Entry[] = historical.value.map((entry) => structuredClone(toRaw(entry)))
  for (const definition of editable.value) {
    const field = fields[definition.id]
    if (!field?.present) continue
    const value = entryValue(definition, field)
    if (value === null || (definition.kind === 'reference' && value === binding.product.uuid)) return null
    const entry = { definitionId: definition.id, revision: definition.revision, value }
    const old = binding.typed.values.find((item) => item.definitionId === definition.id)
    if (JSON.stringify(entry) !== JSON.stringify(old)) {
      const valid = validateTypedAttributeValues({ version: 1, values: [entry] }, binding.definitions, {
        categoryId: binding.product.categoryId,
        mode: 'write'
      })
      if (!valid.success) return null
    }
    values.push(entry)
  }
  const parsed = updateCatalogTypedAttributeValuesSchema.safeParse({
    expectedVersion: binding.product.catalogVersion,
    reason: reason.value,
    typed: { version: 1, values }
  })
  return parsed.success ? parsed.data : null
}
const canSave = computed(() => !frozen.value && !!prepared())
function httpFailure(error: unknown): 'denied' | 'rejected' | 'unknown' {
  try {
    if (!error || typeof error !== 'object') return 'unknown'
    const status = Reflect.get(error, 'statusCode') ?? Reflect.get(error, 'status')
    if (status === 401 || status === 403) return 'denied'
    const data = catalogPolicyOwnJson(Reflect.get(error, 'data')) as { error?: { code?: unknown } }
    return status === 409 &&
      typeof data?.error?.code === 'string' &&
      [
        'version_conflict',
        'idempotency_conflict',
        'conflict',
        'reference_unavailable',
        'definition_retired',
        'invalid_config_transition'
      ].includes(data.error.code)
      ? 'rejected'
      : 'unknown'
  } catch {
    return 'unknown'
  }
}
function revoke() {
  view.value = null
  intent.value = null
  uncertain.value = false
  rejected.value = false
  rejectionRead.value = false
  blocked.value = true
  confirmation.value = false
}
async function load() {
  const supplied = parent.value
  if (!allowed.value || !supplied || loading.value || busy.value) return
  const generation = epoch,
    owner = actor.value
  loading.value = true
  rejectionRead.value = false
  try {
    const raw = await request(`/api/admin/catalog-attributes/products/${supplied.id}`, {
      method: 'GET',
      cache: 'no-store',
      retry: 0
    })
    if (!alive || generation !== epoch || !allowed.value || owner !== actor.value) return
    const parsed = catalogTypedAttributeProductViewSchema.safeParse(raw)
    if (
      !parsed.success ||
      parsed.data.product.id !== supplied.id ||
      parsed.data.product.uuid !== supplied.uuid ||
      parsed.data.product.categoryId !== supplied.categoryId ||
      (supplied.categoryUuid !== undefined && parsed.data.product.categoryUuid !== supplied.categoryUuid) ||
      parsed.data.product.catalogVersion < supplied.catalogVersion ||
      (intent.value && parsed.data.product.categoryUuid !== intent.value.categoryUuid)
    )
      throw new Error('invalid_view')
    view.value = parsed.data
    rejectionRead.value = rejected.value && writable()
    if (intent.value && (!parsed.data.capabilities.update || parsed.data.product.status !== 'draft')) {
      intent.value = null
      uncertain.value = false
      blocked.value = true
    }
    if (!intent.value) {
      blocked.value = false
      initialize(parsed.data)
    }
    message.value = rejected.value
      ? 'Solicitud rechazada. Puede descartar explícitamente este intento para revisar el borrador con el estado consultado.'
      : uncertain.value
        ? 'Éste es el estado consultado. El resultado del comando sigue sin confirmarse; puede repetir exactamente la misma solicitud.'
        : 'Atributos consultados. Los atributos heredados no se modifican aquí.'
  } catch (error) {
    if (alive && generation === epoch) {
      if (httpFailure(error) === 'denied') revoke()
      view.value = null
      message.value = 'No se han podido validar los atributos del producto. No se ha autorizado ninguna escritura.'
    }
  } finally {
    loading.value = false
  }
}
function sameAuthority(command: Intent) {
  return (
    writable() &&
    actor.value === command.owner &&
    authority.value === command.parent &&
    view.value?.product.id === command.productId &&
    view.value.product.uuid === command.productUuid &&
    view.value.product.categoryId === command.categoryId &&
    view.value.product.categoryUuid === command.categoryUuid
  )
}
async function send(command: Intent) {
  if (busy.value || loading.value || !sameAuthority(command)) return
  const generation = epoch
  const previouslyUncertain = uncertain.value
  busy.value = true
  uncertain.value = false
  rejected.value = false
  rejectionRead.value = false
  try {
    const raw = await request(`/api/admin/catalog-attributes/products/${command.productId}`, {
      method: 'PUT',
      body: command.body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command.key },
      retry: 0
    })
    if (!alive || generation !== epoch || !sameAuthority(command)) return
    const parsed = catalogTypedAttributeValuesReceiptSchema.safeParse(raw)
    if (
      !parsed.success ||
      parsed.data.productId !== command.productId ||
      parsed.data.productUuid !== command.productUuid ||
      parsed.data.catalogVersion !== command.expectedVersion + 1 ||
      JSON.stringify(parsed.data.typed) !== JSON.stringify(JSON.parse(command.body).typed)
    ) {
      blocked.value = true
      intent.value = null
      message.value = 'Recibo no válido o ajeno a la solicitud. Consulte el estado antes de continuar.'
      return
    }
    emit('completed', parsed.data)
    intent.value = null
    view.value = null
    message.value = 'Comando confirmado. Consulte los atributos para obtener su estado actual.'
  } catch (error) {
    if (alive && generation === epoch && sameAuthority(command)) {
      const failure = httpFailure(error)
      if (failure === 'denied') {
        revoke()
        message.value = 'Autorización revocada. Consulte de nuevo los atributos antes de continuar.'
      } else if (failure === 'rejected' && !previouslyUncertain) {
        rejected.value = true
        message.value =
          'Solicitud rechazada. Consulte el estado antes de descartar explícitamente el intento y revisar el borrador.'
      } else {
        uncertain.value = true
        message.value =
          'Resultado no confirmado. No se repetirá automáticamente. Consulte el estado o reintente la misma solicitud.'
      }
    }
  } finally {
    busy.value = false
  }
}
function submit() {
  const body = prepared(),
    binding = view.value
  if (!canSave.value || !body || !binding || !actor.value) return
  try {
    intent.value = Object.freeze({
      owner: actor.value,
      parent: authority.value,
      productId: binding.product.id,
      productUuid: binding.product.uuid,
      categoryId: binding.product.categoryId,
      categoryUuid: binding.product.categoryUuid,
      expectedVersion: binding.product.catalogVersion,
      body: JSON.stringify(body),
      key: randomId()
    })
    void send(intent.value)
  } catch {
    intent.value = null
    message.value = 'No se ha podido preparar una solicitud segura.'
  }
}
function retry() {
  if (intent.value && uncertain.value && !blocked.value) void send(intent.value)
}
function discardRejected() {
  if (
    !intent.value ||
    !rejected.value ||
    !rejectionRead.value ||
    busy.value ||
    loading.value ||
    !sameAuthority(intent.value)
  )
    return
  intent.value = null
  rejected.value = false
  rejectionRead.value = false
  confirmation.value = false
  message.value = 'Intento rechazado descartado. Revise y confirme el borrador antes de preparar una solicitud nueva.'
}
function historicalLabel(entry: Entry) {
  return (
    view.value?.definitions.find(
      (definition) => definition.id === entry.definitionId && definition.revision === entry.revision
    )?.label ?? entry.definitionId
  )
}
function removeHistorical(id: string) {
  if (frozen.value || !writable()) return
  if (fields[id]) fields[id]!.present = false
  historical.value = historical.value.filter((entry) => entry.definitionId !== id)
}
</script>
<template>
  <AdminCard
    v-if="allowed"
    :aria-labelledby="`${prefix}-title`"
    description="Características técnicas de la familia del producto. Deja sin marcar las que no apliquen: un dato sin rellenar no equivale a cero ni a «no»."
  >
    <template #title><span :id="`${prefix}-title`">Características del producto</span></template>
    <template #actions>
      <button
        data-typed-load
        type="button"
        class="adm-btn adm-btn--secondary adm-btn--sm"
        :disabled="loading || busy"
        @click="load"
      >
        {{ loading ? 'Cargando…' : 'Cargar características' }}
      </button>
    </template>
    <div class="adm-stack">
      <p v-if="message" role="status" class="adm-help">{{ message }}</p>
      <p v-if="!message && !view && !intent" class="adm-help">
        Pulsa «Cargar características» para verlas y editarlas.
      </p>
      <form v-if="view || intent" data-typed-form class="adm-stack" @submit.prevent="submit">
        <UAlert
          v-if="view && !writable()"
          color="neutral"
          variant="subtle"
          title="No se pueden editar: el producto tiene que estar en borrador y necesitas permiso de catálogo."
        />
        <fieldset :disabled="frozen || !writable()" class="adm-stack">
          <legend class="sr-only">Valores de cada característica</legend>
          <div
            v-for="entry in historical"
            :key="entry.definitionId"
            :data-typed-historical="entry.definitionId"
            class="rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3"
          >
            <p class="break-words">
              <span class="font-medium text-[var(--text-strong)]">{{ historicalLabel(entry) }}</span>
              <AdminBadge tone="warning" class="ml-2">Característica retirada</AdminBadge>
              <span class="mt-1 block">{{
                typeof entry.value === 'object' ? JSON.stringify(entry.value) : String(entry.value)
              }}</span>
            </p>
            <p class="adm-help mt-1">
              Este dato es de una característica que ya no se usa. Se conserva tal cual salvo que lo quites.
            </p>
            <button
              :data-typed-remove="entry.definitionId"
              type="button"
              class="adm-btn adm-btn--ghost adm-btn--sm mt-2"
              @click="removeHistorical(entry.definitionId)"
            >
              Quitar este dato
            </button>
          </div>
          <div
            v-for="definition in editable"
            :key="definition.id"
            class="min-w-0 rounded-[var(--radius-surface)] border border-[var(--border)] p-3"
          >
            <label class="adm-check font-medium"
              ><input
                v-model="fields[definition.id]!.present"
                :data-typed-presence="definition.id"
                type="checkbox"
              /><span>{{ definition.label }}</span></label
            >
            <template v-if="fields[definition.id]!.present">
              <fieldset v-if="definition.kind === 'list'" class="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                <legend class="adm-help mb-2">{{ definition.label }}: puedes marcar hasta 16 opciones</legend>
                <label
                  v-for="option in definition.config.options.filter((item) => item.status === 'active')"
                  :key="option.code"
                  class="adm-check"
                  ><input
                    v-model="fields[definition.id]!.selections"
                    :data-typed-option="`${definition.id}:${option.code}`"
                    type="checkbox"
                    :value="option.code"
                  /><span>{{ option.label }}</span></label
                >
              </fieldset>
              <ReferencePicker
                v-else-if="definition.kind === 'reference'"
                v-model="fields[definition.id]!.input"
                :definition-id="definition.id"
                :label="definition.label"
                :self-id="view?.product.uuid ?? ''"
                :available="!frozen && writable()"
                :authority="authority"
                @denied="revoke"
              />
              <div v-else class="mt-3 grid gap-3 sm:grid-cols-2">
                <label class="adm-label"
                  >{{ definition.label }}
                  <select
                    v-if="definition.kind === 'boolean'"
                    v-model="fields[definition.id]!.input"
                    :data-typed-input="definition.id"
                    class="adm-input mt-1 w-full"
                  >
                    <option value="false">No</option>
                    <option value="true">Sí</option>
                  </select>
                  <input
                    v-else
                    v-model="fields[definition.id]!.input"
                    :data-typed-input="definition.id"
                    :type="definition.kind === 'number' || definition.kind === 'unit' ? 'number' : 'text'"
                    :step="
                      definition.kind === 'number' || definition.kind === 'unit'
                        ? 10 ** -definition.config.precision
                        : undefined
                    "
                    :maxlength="definition.kind === 'text' ? definition.config.maxLength : undefined"
                    class="adm-input mt-1 w-full"
                  />
                </label>
                <label v-if="definition.kind === 'unit'" class="adm-label"
                  >Unidad<select
                    v-model="fields[definition.id]!.unit"
                    :data-typed-unit="definition.id"
                    class="adm-input mt-1 w-full"
                  >
                    <option v-for="unit in definition.config.units" :key="unit" :value="unit">
                      {{ CATALOG_TYPED_ATTRIBUTE_UNITS[unit] }} ({{ unit }})
                    </option>
                  </select></label
                >
              </div>
            </template>
          </div>
          <AdminEmptyState
            v-if="!current.length"
            compact
            icon="i-lucide-sliders-horizontal"
            title="Esta familia no tiene características definidas"
            description="Puedes crearlas desde Categorías."
          />
          <label class="adm-label"
            >Motivo del cambio<input
              v-model="reason"
              data-typed-reason
              :disabled="frozen || !writable()"
              maxlength="500"
              class="adm-input mt-1 w-full"
          /></label>
          <label class="adm-check"
            ><input v-model="confirmation" data-typed-confirm type="checkbox" /><span
              >Confirmo estos valores y los datos que he quitado.</span
            ></label
          >
        </fieldset>
        <p v-if="confirmation && !prepared() && !frozen" role="status" class="adm-help">
          Antes de guardar, revisa el motivo, las casillas marcadas, los decimales, los valores permitidos y los
          productos enlazados.
        </p>
        <div class="flex flex-wrap gap-2">
          <button data-typed-save type="submit" :disabled="!canSave" class="adm-btn adm-btn--secondary">
            {{ busy ? 'Guardando…' : 'Guardar características' }}
          </button>
          <button
            v-if="rejected && rejectionRead && intent && !blocked"
            data-typed-discard
            type="button"
            :disabled="busy || loading || !sameAuthority(intent)"
            class="adm-btn adm-btn--ghost"
            @click="discardRejected"
          >
            Descartar el intento rechazado y revisar
          </button>
          <button
            v-if="uncertain && intent && !blocked"
            data-typed-retry
            type="button"
            :disabled="busy || loading || !sameAuthority(intent)"
            class="adm-btn adm-btn--ghost"
            @click="retry"
          >
            Reintentar el mismo guardado
          </button>
        </div>
      </form>
    </div>
  </AdminCard>
</template>
