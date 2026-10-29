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
  <section
    v-if="allowed"
    class="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"
    :aria-labelledby="`${prefix}-title`"
  >
    <h2 :id="`${prefix}-title`" class="text-lg font-semibold">Atributos tipados del producto</h2>
    <p class="mt-1 text-sm text-slate-600">
      Valores separados de los atributos heredados. Ausente no equivale a cero ni a «No».
    </p>
    <button
      data-typed-load
      type="button"
      class="mt-3 rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
      :disabled="loading || busy"
      @click="load"
    >
      {{ loading ? 'Consultando…' : 'Consultar atributos' }}
    </button>
    <p v-if="message" role="status" class="mt-3 text-sm">{{ message }}</p>
    <form v-if="view || intent" data-typed-form class="mt-4 space-y-4" @submit.prevent="submit">
      <p v-if="view && !writable()" class="text-sm">
        Edición no disponible: se requiere un borrador y permiso de catálogo vigente.
      </p>
      <fieldset :disabled="frozen || !writable()" class="space-y-4">
        <legend class="sr-only">Valores tipados por definición</legend>
        <div
          v-for="entry in historical"
          :key="entry.definitionId"
          :data-typed-historical="entry.definitionId"
          class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"
        >
          <p class="break-words">
            {{ historicalLabel(entry) }} · Histórico, revisión {{ entry.revision }}:
            {{ typeof entry.value === 'object' ? JSON.stringify(entry.value) : String(entry.value) }}
          </p>
          <p class="mt-1">Se conservará sin cambios. Una definición retirada u obsoleta no se reinterpreta.</p>
          <button
            :data-typed-remove="entry.definitionId"
            type="button"
            class="mt-2 rounded border px-3 py-1"
            @click="removeHistorical(entry.definitionId)"
          >
            Quitar explícitamente este histórico
          </button>
        </div>
        <div v-for="definition in editable" :key="definition.id" class="min-w-0 rounded-lg border p-3">
          <label class="flex items-start gap-2 text-sm font-medium"
            ><input
              v-model="fields[definition.id]!.present"
              :data-typed-presence="definition.id"
              type="checkbox"
              class="mt-1"
            />{{ definition.label }} · {{ definition.code }} <span class="text-slate-500">(presente)</span></label
          >
          <template v-if="fields[definition.id]!.present">
            <fieldset v-if="definition.kind === 'list'" class="mt-3 flex flex-wrap gap-3">
              <legend class="mb-2 text-sm">{{ definition.label }}: hasta 16 opciones</legend>
              <label
                v-for="option in definition.config.options.filter((item) => item.status === 'active')"
                :key="option.code"
                class="flex items-center gap-2 text-sm"
                ><input
                  v-model="fields[definition.id]!.selections"
                  :data-typed-option="`${definition.id}:${option.code}`"
                  type="checkbox"
                  :value="option.code"
                />{{ option.label }}</label
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
            <label v-else class="mt-3 block text-sm"
              >{{ definition.label }}
              <select
                v-if="definition.kind === 'boolean'"
                v-model="fields[definition.id]!.input"
                :data-typed-input="definition.id"
                class="mt-1 block w-full rounded-lg border p-2"
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
                class="mt-1 block w-full rounded-lg border p-2"
              />
            </label>
            <label v-if="definition.kind === 'unit'" class="mt-2 block text-sm"
              >Unidad (sin conversión)<select
                v-model="fields[definition.id]!.unit"
                :data-typed-unit="definition.id"
                class="mt-1 block w-full rounded-lg border p-2"
              >
                <option v-for="unit in definition.config.units" :key="unit" :value="unit">
                  {{ CATALOG_TYPED_ATTRIBUTE_UNITS[unit] }} ({{ unit }})
                </option>
              </select></label
            >
          </template>
        </div>
        <p v-if="!current.length" class="text-sm text-slate-600">No hay definiciones para esta categoría.</p>
        <label class="block text-sm"
          >Motivo<input
            v-model="reason"
            data-typed-reason
            :disabled="frozen || !writable()"
            maxlength="500"
            class="mt-1 block w-full rounded-lg border p-2"
        /></label>
        <label class="flex items-start gap-2 text-sm"
          ><input v-model="confirmation" data-typed-confirm type="checkbox" class="mt-1" />Confirmo estos valores y las
          retiradas explícitas indicadas.</label
        >
      </fieldset>
      <p v-if="confirmation && !prepared() && !frozen" role="status" class="text-sm text-amber-800">
        Revise motivo, presencia, precisión, rango, opciones y referencias antes de guardar.
      </p>
      <button
        data-typed-save
        type="submit"
        :disabled="!canSave"
        class="rounded-lg bg-neteco-600 px-3 py-2 text-sm text-white disabled:opacity-50"
      >
        {{ busy ? 'Enviando…' : 'Guardar valores tipados' }}
      </button>
      <button
        v-if="rejected && rejectionRead && intent && !blocked"
        data-typed-discard
        type="button"
        :disabled="busy || loading || !sameAuthority(intent)"
        class="ml-2 rounded-lg border px-3 py-2 text-sm"
        @click="discardRejected"
      >
        Descartar intento rechazado y revisar borrador
      </button>
      <button
        v-if="uncertain && intent && !blocked"
        data-typed-retry
        type="button"
        :disabled="busy || loading || !sameAuthority(intent)"
        class="ml-2 rounded-lg border px-3 py-2 text-sm"
        @click="retry"
      >
        Reintentar la misma solicitud
      </button>
    </form>
  </section>
</template>
