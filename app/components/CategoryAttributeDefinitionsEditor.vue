<script setup lang="ts">
import {
  CATALOG_TYPED_ATTRIBUTE_KINDS,
  CATALOG_TYPED_ATTRIBUTE_UNITS,
  createCatalogTypedAttributeDefinitionSchema,
  catalogTypedAttributeReceiptSchema,
  type CatalogTypedAttributeDefinition,
  type CatalogTypedAttributeKind,
  type CatalogTypedAttributeOption,
  type CatalogTypedAttributeUnit
} from '~~/shared/catalog-typed-attributes'
import {
  catalogTypedAttributeDefinitionsViewSchema,
  catalogTypedAttributeDefinitionHttpUpdateSchema,
  type CatalogTypedAttributeDefinitionsView
} from '~~/shared/catalog-typed-attribute-views'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import { randomId } from '../utils/uuid'

const props = defineProps<{ runtime: unknown; available?: boolean; categories: unknown }>()
const emit = defineEmits<{ completed: [receipt: unknown] }>()
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
  const result = catalogPolicyUuidSchema.safeParse(field('id'))
  return result.success ? result.data : null
})
const categories = computed(() => {
  try {
    if (Array.isArray(props.categories))
      for (const entry of props.categories) {
        if (entry && typeof entry === 'object') {
          Reflect.has(entry, 'id')
          Reflect.has(entry, 'name')
        }
      }
    const value = catalogPolicyOwnJson(props.categories)
    if (!Array.isArray(value)) return []
    const seen = new Set<number>()
    return value.filter((entry): entry is { id: number; name: string } => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !Number.isSafeInteger(entry.id) ||
        entry.id < 1 ||
        typeof entry.name !== 'string' ||
        seen.has(entry.id)
      )
        return false
      seen.add(entry.id)
      return true
    })
  } catch {
    return []
  }
})
const allowed = computed(
  () =>
    props.runtime === 'cloudflare' &&
    props.available === true &&
    ready.value === true &&
    loggedIn.value === true &&
    !!actor.value
)
const selection = ref(''),
  view = shallowRef<CatalogTypedAttributeDefinitionsView | null>(null)
const loading = ref(false),
  busy = ref(false),
  uncertain = ref(false),
  rejected = ref(false),
  rejectionRead = ref(false),
  blocked = ref(false),
  message = ref('')
const mode = ref<'create' | 'update' | 'retire' | null>(null),
  target = shallowRef<CatalogTypedAttributeDefinition | null>(null)
const code = ref(''),
  label = ref(''),
  kind = ref<CatalogTypedAttributeKind>('text'),
  reason = ref(''),
  confirmation = ref(false)
const maxLength = ref<number | string>(500),
  precision = ref<number | string>(0),
  minimum = ref<number | string>(''),
  maximum = ref<number | string>('')
const units = ref<CatalogTypedAttributeUnit[]>(['ud']),
  options = ref<CatalogTypedAttributeOption[]>([])
type Intent = Readonly<{
  action: 'create' | 'update' | 'retire'
  owner: string
  categoryId: number
  categoryUuid: string
  target: CatalogTypedAttributeDefinition | null
  path: string
  method: 'POST' | 'PUT'
  body: string
  key: string
}>
const intent = shallowRef<Intent | null>(null)
let epoch = 0,
  alive = true
const categoryId = computed(() => categories.value.find((entry) => String(entry.id) === selection.value)?.id ?? null)
const authority = computed(() => JSON.stringify([allowed.value, actor.value, categoryId.value]))
watch(
  authority,
  () => {
    epoch++
    view.value = null
    intent.value = null
    mode.value = null
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
function permitted(action: 'create' | 'update' | 'retire') {
  return (
    allowed.value &&
    categoryId.value !== null &&
    view.value?.categoryId === categoryId.value &&
    view.value.capabilities[action] === true
  )
}
const frozen = computed(() => busy.value || loading.value || !!intent.value || blocked.value)
function config() {
  if (kind.value === 'text') return { maxLength: maxLength.value }
  if (kind.value === 'boolean' || kind.value === 'reference') return {}
  if (kind.value === 'list') return { options: options.value.map((option) => ({ ...option })) }
  return {
    precision: precision.value,
    ...(minimum.value === '' ? {} : { min: minimum.value }),
    ...(maximum.value === '' ? {} : { max: maximum.value }),
    ...(kind.value === 'unit' ? { units: [...units.value] } : {})
  }
}
function prepared() {
  if (!mode.value || !permitted(mode.value) || !confirmation.value) return null
  const input =
    mode.value === 'create'
      ? {
          categoryId: categoryId.value,
          code: code.value,
          kind: kind.value,
          label: label.value,
          config: config(),
          expectedVersion: 0,
          reason: reason.value
        }
      : mode.value === 'update'
        ? {
            action: 'update',
            label: label.value,
            config: config(),
            expectedVersion: target.value?.revision,
            reason: reason.value
          }
        : { action: 'retire', expectedVersion: target.value?.revision, reason: reason.value }
  const result = (
    mode.value === 'create'
      ? createCatalogTypedAttributeDefinitionSchema
      : catalogTypedAttributeDefinitionHttpUpdateSchema
  ).safeParse(input)
  return result.success ? result.data : null
}
const canSave = computed(() => !frozen.value && !!prepared())
function begin(action: 'create' | 'update' | 'retire', definition?: CatalogTypedAttributeDefinition) {
  if (frozen.value || !permitted(action) || (action !== 'create' && (!definition || definition.status !== 'active')))
    return
  mode.value = action
  target.value = definition ?? null
  code.value = definition?.code ?? ''
  label.value = definition?.label ?? ''
  kind.value = definition?.kind ?? 'text'
  const settings = definition?.config as Record<string, unknown> | undefined
  maxLength.value = typeof settings?.maxLength === 'number' ? settings.maxLength : 500
  precision.value = typeof settings?.precision === 'number' ? settings.precision : 0
  minimum.value = typeof settings?.min === 'number' ? settings.min : ''
  maximum.value = typeof settings?.max === 'number' ? settings.max : ''
  units.value = definition?.kind === 'unit' ? [...definition.config.units] : ['ud']
  options.value = definition?.kind === 'list' ? definition.config.options.map((option) => ({ ...option })) : []
  reason.value = ''
  confirmation.value = false
  message.value = ''
}
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
  mode.value = null
  target.value = null
  uncertain.value = false
  rejected.value = false
  rejectionRead.value = false
  blocked.value = true
  confirmation.value = false
}
async function load() {
  if (!allowed.value || categoryId.value === null || loading.value || busy.value) return
  const generation = epoch,
    id = categoryId.value,
    owner = actor.value
  loading.value = true
  rejectionRead.value = false
  try {
    const raw = await request('/api/admin/catalog-attributes/definitions', {
      method: 'GET',
      query: { categoryId: id },
      retry: 0,
      cache: 'no-store'
    })
    if (!alive || generation !== epoch || !allowed.value || owner !== actor.value) return
    const parsed = catalogTypedAttributeDefinitionsViewSchema.safeParse(raw)
    if (
      !parsed.success ||
      parsed.data.categoryId !== id ||
      (intent.value && parsed.data.categoryUuid !== intent.value.categoryUuid)
    )
      throw new Error('invalid_view')
    view.value = parsed.data
    rejectionRead.value = rejected.value && !!intent.value && permitted(intent.value.action)
    if (intent.value && !parsed.data.capabilities[intent.value.action]) {
      intent.value = null
      uncertain.value = false
      blocked.value = true
    }
    if (!intent.value) {
      blocked.value = false
      mode.value = null
      target.value = null
    }
    message.value = rejected.value
      ? 'Solicitud rechazada. Puede descartar explícitamente este intento para revisar el borrador con el estado consultado.'
      : uncertain.value
        ? 'Estado consultado. El resultado del comando sigue sin confirmarse; puede repetir la misma solicitud.'
        : 'Definiciones consultadas.'
  } catch (error) {
    if (alive && generation === epoch) {
      if (httpFailure(error) === 'denied') revoke()
      view.value = null
      message.value = 'No se han podido validar las definiciones. No se ha autorizado ninguna escritura.'
    }
  } finally {
    loading.value = false
  }
}
function sameAuthority(command: Intent) {
  return (
    allowed.value &&
    actor.value === command.owner &&
    categoryId.value === command.categoryId &&
    permitted(command.action) &&
    view.value?.categoryUuid === command.categoryUuid
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
    const raw = await request(command.path, {
      method: command.method,
      body: command.body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command.key },
      retry: 0
    })
    if (!alive || generation !== epoch || !sameAuthority(command)) return
    const parsed = catalogTypedAttributeReceiptSchema.safeParse(raw),
      body = JSON.parse(command.body)
    if (!parsed.success) {
      blocked.value = true
      intent.value = null
      message.value = 'Recibo no válido. Consulte el estado antes de continuar.'
      return
    }
    const receipt = parsed.data,
      definition = receipt.definition,
      previous = command.target
    const matches =
      receipt.action === command.action &&
      definition.categoryId === command.categoryId &&
      definition.categoryUuid === command.categoryUuid &&
      definition.revision === (previous?.revision ?? 0) + 1 &&
      definition.status === (command.action === 'retire' ? 'retired' : 'active') &&
      definition.code === (previous?.code ?? body.code) &&
      definition.kind === (previous?.kind ?? body.kind) &&
      definition.label === (body.label ?? previous?.label) &&
      JSON.stringify(definition.config) === JSON.stringify(body.config ?? previous?.config) &&
      (!previous || definition.id === previous.id)
    if (!matches) {
      blocked.value = true
      intent.value = null
      message.value = 'Recibo ajeno a la solicitud. Consulte el estado antes de continuar.'
      return
    }
    emit('completed', receipt)
    intent.value = null
    view.value = null
    mode.value = null
    message.value = 'Comando confirmado. Consulte las definiciones para obtener su estado actual.'
  } catch (error) {
    if (alive && generation === epoch && sameAuthority(command)) {
      const failure = httpFailure(error)
      if (failure === 'denied') {
        revoke()
        message.value = 'Autorización revocada. Consulte de nuevo las definiciones antes de continuar.'
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
    action = mode.value,
    binding = view.value
  if (!canSave.value || !body || !action || !binding || !actor.value) return
  try {
    intent.value = Object.freeze({
      action,
      owner: actor.value,
      categoryId: binding.categoryId,
      categoryUuid: binding.categoryUuid,
      target: target.value,
      path: `/api/admin/catalog-attributes/definitions${action === 'create' ? '' : `/${target.value!.id}`}`,
      method: action === 'create' ? 'POST' : 'PUT',
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
  const command = intent.value
  if (!command || !rejected.value || !rejectionRead.value || busy.value || loading.value || !sameAuthority(command))
    return
  const fresh = command.target
    ? view.value?.definitions.find((definition) => definition.id === command.target!.id)
    : null
  if (command.target && (!fresh || fresh.status !== 'active')) {
    mode.value = null
    target.value = null
  } else target.value = fresh ?? null
  intent.value = null
  rejected.value = false
  rejectionRead.value = false
  confirmation.value = false
  message.value = 'Intento rechazado descartado. Revise y confirme el borrador antes de preparar una solicitud nueva.'
}
</script>
<template>
  <section
    v-if="allowed"
    class="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"
    :aria-labelledby="`${prefix}-title`"
  >
    <h2 :id="`${prefix}-title`" class="text-lg font-semibold">Definiciones de atributos por categoría</h2>
    <p class="mt-1 text-sm text-slate-600">
      Sin herencia entre familias. Los códigos y tipos no cambian; las revisiones anteriores se conservan.
    </p>
    <div class="mt-4 flex flex-wrap items-end gap-3">
      <label class="min-w-0 flex-1 text-sm"
        >Familia
        <select
          v-model="selection"
          data-definition-category
          class="mt-1 block w-full rounded-lg border p-2"
          :disabled="frozen"
        >
          <option value="">Seleccione una familia</option>
          <option v-for="category in categories" :key="category.id" :value="String(category.id)">
            {{ category.name }}
          </option>
        </select>
      </label>
      <button
        data-definitions-load
        type="button"
        class="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
        :disabled="!categoryId || loading || busy"
        @click="load"
      >
        {{ loading ? 'Consultando…' : 'Consultar definiciones' }}
      </button>
    </div>
    <p v-if="message" role="status" class="mt-3 text-sm">{{ message }}</p>
    <ul v-if="view" class="mt-3 space-y-2">
      <li
        v-for="definition in view.definitions"
        :key="definition.id"
        class="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"
      >
        <span class="min-w-0 flex-1 break-words"
          >{{ definition.label }} · {{ definition.code }} · {{ definition.kind }} · revisión {{ definition.revision }} ·
          {{ definition.status === 'retired' ? 'Retirada' : 'Activa' }}</span
        >
        <button
          v-if="definition.status === 'active' && permitted('update')"
          :data-definition-edit="definition.id"
          :disabled="frozen"
          type="button"
          class="rounded border px-2 py-1"
          @click="begin('update', definition)"
        >
          Revisar
        </button>
        <button
          v-if="definition.status === 'active' && permitted('retire')"
          :data-definition-retire="definition.id"
          :disabled="frozen"
          type="button"
          class="rounded border px-2 py-1"
          @click="begin('retire', definition)"
        >
          Retirar
        </button>
      </li>
    </ul>
    <button
      v-if="permitted('create')"
      data-definition-create
      type="button"
      class="mt-3 rounded-lg border px-3 py-2 text-sm"
      :disabled="frozen"
      @click="begin('create')"
    >
      Nueva definición
    </button>
    <form v-if="mode" data-definition-form class="mt-4 space-y-3" @submit.prevent="submit">
      <fieldset :disabled="frozen" class="space-y-3">
        <legend class="font-semibold">
          {{
            mode === 'retire'
              ? 'Retirar definición sin borrar históricos'
              : mode === 'create'
                ? 'Nueva definición'
                : 'Nueva revisión'
          }}
        </legend>
        <label class="block text-sm"
          >Código estable<input
            v-model="code"
            data-definition-code
            class="mt-1 block w-full rounded-lg border p-2"
            maxlength="100"
            :disabled="mode !== 'create'"
        /></label>
        <label class="block text-sm"
          >Etiqueta<input
            v-model="label"
            data-definition-label
            class="mt-1 block w-full rounded-lg border p-2"
            maxlength="200"
            :disabled="mode === 'retire'"
        /></label>
        <label class="block text-sm"
          >Tipo<select
            v-model="kind"
            data-definition-kind
            class="mt-1 block w-full rounded-lg border p-2"
            :disabled="mode !== 'create'"
          >
            <option v-for="type in CATALOG_TYPED_ATTRIBUTE_KINDS" :key="type" :value="type">{{ type }}</option>
          </select></label
        >
        <template v-if="mode !== 'retire'">
          <label v-if="kind === 'text'" class="block text-sm"
            >Longitud máxima (1–500)<input
              v-model.number="maxLength"
              type="number"
              min="1"
              max="500"
              class="mt-1 block w-full rounded-lg border p-2"
          /></label>
          <template v-if="kind === 'number' || kind === 'unit'">
            <label class="block text-sm"
              >Decimales (0–6)<input
                v-model.number="precision"
                type="number"
                min="0"
                max="6"
                class="mt-1 block w-full rounded-lg border p-2"
            /></label>
            <label class="block text-sm"
              >Mínimo opcional<input
                v-model.number="minimum"
                type="number"
                step="any"
                class="mt-1 block w-full rounded-lg border p-2"
            /></label>
            <label class="block text-sm"
              >Máximo opcional<input
                v-model.number="maximum"
                type="number"
                step="any"
                class="mt-1 block w-full rounded-lg border p-2"
            /></label>
          </template>
          <fieldset v-if="kind === 'unit'" class="flex flex-wrap gap-3">
            <legend class="mb-2 text-sm">Unidades admitidas (sin conversión)</legend>
            <label
              v-for="(name, unit) in CATALOG_TYPED_ATTRIBUTE_UNITS"
              :key="unit"
              class="flex items-center gap-2 text-sm"
              ><input v-model="units" type="checkbox" :value="unit" />{{ name }} ({{ unit }})</label
            >
          </fieldset>
          <fieldset v-if="kind === 'list'" class="space-y-2">
            <legend class="text-sm">Opciones por código estable (máximo 100)</legend>
            <div v-for="(option, index) in options" :key="index" class="grid gap-2 sm:grid-cols-3">
              <label class="text-sm"
                >Código<input
                  v-model="option.code"
                  data-definition-option-code
                  class="mt-1 w-full rounded border p-2"
                  :disabled="
                    mode !== 'create' &&
                    !!target &&
                    target.kind === 'list' &&
                    target.config.options.some((item) => item.code === option.code)
                  "
              /></label>
              <label class="text-sm"
                >Etiqueta<input
                  v-model="option.label"
                  data-definition-option-label
                  class="mt-1 w-full rounded border p-2"
              /></label>
              <label class="text-sm"
                >Estado<select v-model="option.status" class="mt-1 w-full rounded border p-2">
                  <option value="active">Activa</option>
                  <option value="retired">Retirada</option>
                </select></label
              >
            </div>
            <button
              data-definition-option-add
              type="button"
              class="rounded border px-3 py-2 text-sm"
              :disabled="options.length >= 100"
              @click="options.push({ code: '', label: '', status: 'active' })"
            >
              Añadir opción
            </button>
          </fieldset>
        </template>
        <label class="block text-sm"
          >Motivo<input
            v-model="reason"
            data-definition-reason
            :disabled="frozen"
            maxlength="500"
            class="mt-1 block w-full rounded-lg border p-2"
        /></label>
        <label class="flex items-start gap-2 text-sm"
          ><input v-model="confirmation" data-definition-confirm type="checkbox" class="mt-1" />Confirmo esta
          {{ mode === 'retire' ? 'retirada' : 'definición' }} y su ámbito de categoría.</label
        >
      </fieldset>
      <button
        type="submit"
        :disabled="!canSave"
        class="rounded-lg bg-neteco-600 px-3 py-2 text-sm text-white disabled:opacity-50"
      >
        {{ busy ? 'Enviando…' : 'Confirmar comando' }}
      </button>
      <button
        v-if="rejected && rejectionRead && intent && !blocked"
        data-definition-discard
        type="button"
        :disabled="busy || loading || !sameAuthority(intent)"
        class="ml-2 rounded-lg border px-3 py-2 text-sm"
        @click="discardRejected"
      >
        Descartar intento rechazado y revisar borrador
      </button>
      <button
        v-if="uncertain && intent && !blocked"
        data-definition-retry
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
