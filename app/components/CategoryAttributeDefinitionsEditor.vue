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
const KIND_LABELS: Record<CatalogTypedAttributeKind, string> = {
  text: 'Texto',
  number: 'Número',
  unit: 'Medida con unidad',
  boolean: 'Sí o no',
  list: 'Lista de opciones',
  reference: 'Enlace a otro producto'
}
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
      ? 'El cambio no se ha aceptado. Puedes descartarlo y corregir los datos del formulario.'
      : uncertain.value
        ? 'Datos actualizados. Seguimos sin poder confirmar si el cambio se guardó: puedes reintentarlo sin riesgo de duplicarlo.'
        : 'Características actualizadas.'
  } catch (error) {
    if (alive && generation === epoch) {
      if (httpFailure(error) === 'denied') revoke()
      view.value = null
      message.value = 'No se han podido cargar las características de esta familia. No se ha cambiado nada.'
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
      message.value = 'No hemos podido confirmar el cambio. Vuelve a cargar las características antes de continuar.'
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
      message.value =
        'La respuesta no corresponde a este cambio. Vuelve a cargar las características antes de continuar.'
      return
    }
    emit('completed', receipt)
    intent.value = null
    view.value = null
    mode.value = null
    message.value = 'Cambio guardado. Vuelve a cargar las características para ver cómo han quedado.'
  } catch (error) {
    if (alive && generation === epoch && sameAuthority(command)) {
      const failure = httpFailure(error)
      if (failure === 'denied') {
        revoke()
        message.value =
          'Tu usuario ya no tiene permiso para este cambio. Vuelve a cargar las características antes de continuar.'
      } else if (failure === 'rejected' && !previouslyUncertain) {
        rejected.value = true
        message.value =
          'El cambio no se ha aceptado. Vuelve a cargar las características; después podrás descartarlo y corregir los datos.'
      } else {
        uncertain.value = true
        message.value =
          'No podemos confirmar si el cambio se guardó. Vuelve a cargar las características o reinténtalo: no se duplicará.'
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
    message.value = 'No se ha podido preparar el cambio. Vuelve a intentarlo.'
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
  message.value = 'Cambio descartado. Revisa los datos y vuelve a confirmarlos antes de guardar.'
}
</script>

<template>
  <AdminCard
    v-if="allowed"
    :aria-labelledby="`${prefix}-title`"
    description="Los datos que se piden al dar de alta un producto de cada familia (material, capacidad, color…). Cada familia tiene los suyos; las subfamilias no los heredan."
  >
    <template #title>
      <span :id="`${prefix}-title`">Características por familia</span>
    </template>
    <template v-if="permitted('create')" #actions>
      <button
        data-definition-create
        type="button"
        class="adm-btn adm-btn--secondary adm-btn--sm"
        :disabled="frozen"
        @click="begin('create')"
      >
        <UIcon name="i-lucide-plus" class="size-4 shrink-0" />Nueva característica
      </button>
    </template>

    <div class="adm-stack">
      <div class="adm-toolbar">
        <label class="adm-field min-w-0 flex-1 sm:max-w-sm">
          <span class="adm-label">Familia</span>
          <select v-model="selection" data-definition-category class="adm-input w-full" :disabled="frozen">
            <option value="">Selecciona una familia</option>
            <option v-for="category in categories" :key="category.id" :value="String(category.id)">
              {{ category.name }}
            </option>
          </select>
        </label>
        <button
          data-definitions-load
          type="button"
          class="adm-btn adm-btn--secondary self-end"
          :disabled="!categoryId || loading || busy"
          @click="load"
        >
          {{ loading ? 'Cargando…' : view ? 'Volver a cargar' : 'Ver características' }}
        </button>
      </div>

      <div v-if="message" role="status">
        <UAlert :color="uncertain || rejected || blocked ? 'warning' : 'neutral'" variant="subtle" :title="message" />
      </div>

      <template v-if="view">
        <AdminEmptyState
          v-if="!view.definitions.length"
          compact
          icon="i-lucide-list-checks"
          title="Esta familia todavía no tiene características"
          description="Añade la primera para que sus productos puedan rellenarla."
        />
        <div v-else class="adm-table-wrap">
          <table class="adm-table">
            <caption class="sr-only">
              Características de la familia seleccionada
            </caption>
            <thead>
              <tr>
                <th scope="col">Característica</th>
                <th scope="col">Tipo de dato</th>
                <th scope="col">Estado</th>
                <th scope="col" data-numeric><span class="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="definition in view.definitions" :key="definition.id">
                <td>
                  <p class="break-words font-medium text-[var(--text-strong)]">{{ definition.label }}</p>
                  <p class="adm-help break-all">
                    {{ definition.code
                    }}<template v-if="definition.revision > 1">
                      · modificada {{ definition.revision - 1 }}
                      {{ definition.revision === 2 ? 'vez' : 'veces' }}</template
                    >
                  </p>
                </td>
                <td>{{ KIND_LABELS[definition.kind] }}</td>
                <td>
                  <AdminBadge :tone="definition.status === 'retired' ? 'neutral' : 'success'">{{
                    definition.status === 'retired' ? 'Retirada' : 'Activa'
                  }}</AdminBadge>
                </td>
                <td data-numeric class="adm-table__actions">
                  <button
                    v-if="definition.status === 'active' && permitted('update')"
                    :data-definition-edit="definition.id"
                    :disabled="frozen"
                    type="button"
                    class="adm-btn adm-btn--secondary adm-btn--sm"
                    @click="begin('update', definition)"
                  >
                    Editar
                  </button>
                  <button
                    v-if="definition.status === 'active' && permitted('retire')"
                    :data-definition-retire="definition.id"
                    :disabled="frozen"
                    type="button"
                    class="adm-btn adm-btn--danger-soft adm-btn--sm"
                    @click="begin('retire', definition)"
                  >
                    Retirar
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <form
        v-if="mode"
        data-definition-form
        class="grid gap-4 border-t border-[var(--border)] pt-4"
        @submit.prevent="submit"
      >
        <fieldset :disabled="frozen" class="grid gap-3">
          <legend class="mb-3 text-sm font-semibold text-[var(--text-strong)]">
            {{
              mode === 'retire'
                ? 'Retirar característica'
                : mode === 'create'
                  ? 'Nueva característica'
                  : 'Editar característica'
            }}
          </legend>
          <p v-if="mode === 'retire'" class="adm-help">
            Dejará de pedirse en los productos nuevos. Los valores ya guardados se conservan.
          </p>
          <div class="adm-form-grid">
            <label class="adm-field">
              <span class="adm-label">Nombre</span>
              <input
                v-model="label"
                data-definition-label
                class="adm-input w-full"
                maxlength="200"
                :disabled="mode === 'retire'"
              />
            </label>
            <label class="adm-field">
              <span class="adm-label">Identificador</span>
              <input
                v-model="code"
                data-definition-code
                class="adm-input w-full"
                maxlength="100"
                :disabled="mode !== 'create'"
              />
              <span class="adm-help">Nombre corto interno, sin espacios. No se puede cambiar después.</span>
            </label>
            <label class="adm-field">
              <span class="adm-label">Tipo de dato</span>
              <select v-model="kind" data-definition-kind class="adm-input w-full" :disabled="mode !== 'create'">
                <option v-for="type in CATALOG_TYPED_ATTRIBUTE_KINDS" :key="type" :value="type">
                  {{ KIND_LABELS[type] }}
                </option>
              </select>
              <span class="adm-help">No se puede cambiar después.</span>
            </label>
          </div>
          <template v-if="mode !== 'retire'">
            <div v-if="kind === 'text' || kind === 'number' || kind === 'unit'" class="adm-form-grid">
              <label v-if="kind === 'text'" class="adm-field">
                <span class="adm-label">Longitud máxima (de 1 a 500 caracteres)</span>
                <input v-model.number="maxLength" type="number" min="1" max="500" class="adm-input w-full" />
              </label>
              <template v-if="kind === 'number' || kind === 'unit'">
                <label class="adm-field">
                  <span class="adm-label">Decimales (de 0 a 6)</span>
                  <input v-model.number="precision" type="number" min="0" max="6" class="adm-input w-full" />
                </label>
                <label class="adm-field">
                  <span class="adm-label">Valor mínimo (opcional)</span>
                  <input v-model.number="minimum" type="number" step="any" class="adm-input w-full" />
                </label>
                <label class="adm-field">
                  <span class="adm-label">Valor máximo (opcional)</span>
                  <input v-model.number="maximum" type="number" step="any" class="adm-input w-full" />
                </label>
              </template>
            </div>
            <fieldset v-if="kind === 'unit'" class="flex flex-wrap gap-x-4 gap-y-2">
              <legend class="adm-label mb-2">Unidades que se pueden elegir</legend>
              <label v-for="(name, unit) in CATALOG_TYPED_ATTRIBUTE_UNITS" :key="unit" class="adm-check"
                ><input v-model="units" type="checkbox" :value="unit" />{{ name }} ({{ unit }})</label
              >
              <p class="adm-help w-full">Los valores no se convierten de una unidad a otra.</p>
            </fieldset>
            <fieldset v-if="kind === 'list'" class="grid gap-2">
              <legend class="adm-label mb-2">Opciones de la lista (máximo 100)</legend>
              <div v-for="(option, index) in options" :key="index" class="grid gap-2 sm:grid-cols-3">
                <label class="adm-field">
                  <span class="adm-label">Nombre</span>
                  <input v-model="option.label" data-definition-option-label class="adm-input w-full" />
                </label>
                <label class="adm-field">
                  <span class="adm-label">Identificador</span>
                  <input
                    v-model="option.code"
                    data-definition-option-code
                    class="adm-input w-full"
                    :disabled="
                      mode !== 'create' &&
                      !!target &&
                      target.kind === 'list' &&
                      target.config.options.some((item) => item.code === option.code)
                    "
                  />
                </label>
                <label class="adm-field">
                  <span class="adm-label">Estado</span>
                  <select v-model="option.status" class="adm-input w-full">
                    <option value="active">Activa</option>
                    <option value="retired">Retirada</option>
                  </select>
                </label>
              </div>
              <div>
                <button
                  data-definition-option-add
                  type="button"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  :disabled="options.length >= 100"
                  @click="options.push({ code: '', label: '', status: 'active' })"
                >
                  <UIcon name="i-lucide-plus" class="size-4 shrink-0" />Añadir opción
                </button>
              </div>
            </fieldset>
          </template>
          <label class="adm-field">
            <span class="adm-label">Motivo del cambio</span>
            <input
              v-model="reason"
              data-definition-reason
              :disabled="frozen"
              maxlength="500"
              class="adm-input w-full"
            />
            <span class="adm-help">Queda guardado en el historial de cambios.</span>
          </label>
          <label class="adm-check items-start"
            ><input v-model="confirmation" data-definition-confirm type="checkbox" class="mt-0.5" /><span
              >Confirmo {{ mode === 'retire' ? 'la retirada de esta característica' : 'esta característica' }} para la
              familia seleccionada.</span
            ></label
          >
        </fieldset>
        <div class="flex flex-wrap justify-end gap-2">
          <button
            v-if="rejected && rejectionRead && intent && !blocked"
            data-definition-discard
            type="button"
            :disabled="busy || loading || !sameAuthority(intent)"
            class="adm-btn adm-btn--secondary"
            @click="discardRejected"
          >
            Descartar y corregir
          </button>
          <button
            v-if="uncertain && intent && !blocked"
            data-definition-retry
            type="button"
            :disabled="busy || loading || !sameAuthority(intent)"
            class="adm-btn adm-btn--secondary"
            @click="retry"
          >
            Reintentar el cambio
          </button>
          <button
            type="submit"
            :disabled="!canSave"
            class="adm-btn"
            :class="mode === 'retire' ? 'adm-btn--danger' : 'adm-btn--primary'"
          >
            {{ busy ? 'Guardando…' : mode === 'retire' ? 'Retirar característica' : 'Guardar' }}
          </button>
        </div>
      </form>
    </div>
  </AdminCard>
</template>
