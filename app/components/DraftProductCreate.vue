<script setup lang="ts">
import { createDraftInputSchema, catalogDraftAuthoringReceiptSchema } from '~~/shared/catalog-draft-authoring'
import { catalogDraftAuthoringOptionsSchema } from '~~/shared/catalog-draft-authoring-options'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
import { randomId } from '../utils/uuid'
import DraftVariantFields from './DraftVariantFields.vue'

const props = defineProps<{
  options: unknown
  optionsStatus: string
  runtime: unknown
  refreshOptions: () => Promise<unknown>
  authorize: () => boolean
  onCreated: (identity: { id: number; uuid: string }) => Promise<unknown>
}>()
const prefix = useId()
const form = ref<Record<string, unknown>>({
  expectedVersion: 0,
  reason: '',
  name: '',
  categoryId: '',
  brandId: '',
  shortDesc: '',
  description: '',
  usage: null,
  series: null,
  featured: false,
  badges: [],
  visual: { type: 'caja', color: '#52665B' },
  attrs: [],
  initialVariant: {
    sku: '',
    format: '',
    ean: null,
    gtin: null,
    mpn: null,
    taxClassId: '',
    shippingProfileId: '',
    unitBase: '',
    unitLabel: '',
    contentQuantity: 1,
    unitsPerCase: 1,
    casesPerPallet: null,
    minimumQuantity: 1,
    quantityIncrement: 1,
    maximumQuantity: null,
    weightGrams: 0,
    widthMm: 0,
    heightMm: 0,
    depthMm: 0,
    backorderAllowed: false,
    leadTimeDays: null,
    color: null
  }
})
function ownRecord(value: unknown): Record<string, unknown> | null {
  try {
    const copied = catalogPolicyOwnJson(value)
    return copied && typeof copied === 'object' && !Array.isArray(copied) ? (copied as Record<string, unknown>) : null
  } catch {
    return null
  }
}
function getReferences() {
  if (props.optionsStatus !== 'success' || props.runtime !== 'cloudflare') return null
  const parsed = catalogDraftAuthoringOptionsSchema.safeParse(props.options)
  return parsed.success ? parsed.data : null
}
const references = computed(getReferences)
function authorized() {
  try {
    return props.authorize() === true
  } catch {
    return false
  }
}
function allowedNow() {
  return getReferences()?.capabilities.productDraftCreate === true && authorized()
}
const allowed = computed(allowedNow)
const busy = ref(false),
  reloading = ref(false),
  uncertain = ref(false),
  blocked = ref(false),
  completed = ref(false)
const message = ref('')
let alive = true,
  pending = false,
  reading = false,
  generation = 0
type Intent = Readonly<{ payload: string; key: string }>
let intent: Intent | null = null
watch(allowed, (value) => {
  if (!value) generation++
})
watch(
  () => props.optionsStatus,
  (value) => {
    if (value !== 'success') generation++
  }
)
onBeforeUnmount(() => {
  alive = false
  generation++
})

function matched(value: Record<string, unknown>) {
  const options = getReferences(),
    variant = ownRecord(value.initialVariant)
  return (
    !!options &&
    !!variant &&
    options.categories.some((entry) => entry.id === value.categoryId) &&
    options.brands.some((entry) => entry.id === value.brandId) &&
    options.taxClasses.some((entry) => entry.id === variant.taxClassId) &&
    options.shippingProfiles.some((entry) => entry.id === variant.shippingProfileId)
  )
}
function preparePayload() {
  const parsed = createDraftInputSchema.safeParse(form.value)
  return parsed.success && matched(parsed.data) ? parsed.data : null
}
const prepared = computed(preparePayload)
const canSubmit = computed(
  () =>
    allowed.value &&
    !!prepared.value &&
    !busy.value &&
    !reloading.value &&
    !uncertain.value &&
    !blocked.value &&
    !completed.value
)
const canRetry = computed(() => {
  if (!uncertain.value || !intent || !allowed.value || busy.value || reloading.value) return false
  return authorized()
})
const safeForm = computed(() => ownRecord(form.value))
const visual = computed(() => ownRecord(safeForm.value?.visual))
const attrs = computed(() => {
  const items = safeForm.value?.attrs
  return Array.isArray(items) ? items.map(ownRecord).filter((item) => item !== null) : []
})
const badges = ['eco', 'alimentaria', 'concentrado'] as const
const visualTypes = [
  'garrafa',
  'botella',
  'spray',
  'caja',
  'saco',
  'capsulas',
  'difusor',
  'cubo',
  'rollo',
  'vaso',
  'guante'
]
function update(key: string, event: Event, numeric = false) {
  if (!allowed.value || busy.value || uncertain.value || blocked.value || !safeForm.value) return
  const target = event.target
  if (!(
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  ))
    return
  let value: unknown = target.value
  if (target instanceof HTMLInputElement && target.type === 'checkbox') value = target.checked
  else if (numeric) value = target.value === '' ? '' : Number(target.value)
  form.value = { ...safeForm.value, [key]: value }
}
function updateVisual(key: string, event: Event) {
  if (!allowed.value || busy.value || uncertain.value || blocked.value || !safeForm.value || !visual.value) return
  const target = event.target
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return
  form.value = { ...safeForm.value, visual: { ...visual.value, [key]: target.value } }
}
function toggleBadge(badge: (typeof badges)[number], event: Event) {
  if (
    !allowed.value ||
    busy.value ||
    uncertain.value ||
    blocked.value ||
    !safeForm.value ||
    !Array.isArray(safeForm.value.badges)
  )
    return
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  const current = safeForm.value.badges
  form.value = {
    ...safeForm.value,
    badges: target.checked
      ? [...current.filter((entry) => entry !== badge), badge]
      : current.filter((entry) => entry !== badge)
  }
}
function changeAttribute(index: number, key: 'k' | 'v', event: Event) {
  if (!canEditAttributes()) return
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  form.value = {
    ...safeForm.value,
    attrs: attrs.value.map((item, i) => (i === index ? { ...item, [key]: target.value } : item))
  }
}
function canEditAttributes() {
  return allowed.value && !busy.value && !uncertain.value && !blocked.value && !!safeForm.value
}
function addAttribute() {
  if (canEditAttributes() && attrs.value.length < 50)
    form.value = { ...safeForm.value, attrs: [...attrs.value, { k: '', v: '' }] }
}
function removeAttribute(index: number) {
  if (canEditAttributes()) form.value = { ...safeForm.value, attrs: attrs.value.filter((_, i) => i !== index) }
}
function updateVariant(value: Record<string, unknown>) {
  if (canEditAttributes()) form.value = { ...safeForm.value, initialVariant: value }
}

const deterministicCodes = new Set([
  'invalid_input',
  'unauthenticated',
  'email_unverified',
  'mfa_required',
  'forbidden',
  'not_found',
  'version_conflict',
  'idempotency_conflict',
  'invalid_state',
  'conflict',
  'reference_unavailable',
  'product_not_editable',
  'variant_not_editable',
  'quantity_conflict',
  'variant_limit',
  'rate_limited'
])
function domainCode(value: unknown) {
  const data = ownRecord(value),
    error = ownRecord(data?.error)
  return typeof error?.code === 'string' && deterministicCodes.has(error.code) ? error.code : null
}
function errorCode(cause: unknown) {
  if (!cause || typeof cause !== 'object') return null
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cause, 'data')
    return descriptor && Object.hasOwn(descriptor, 'value') ? domainCode(descriptor.value) : null
  } catch {
    return null
  }
}
async function send(command: Intent) {
  if (pending || reading || !alive || !allowedNow()) return
  pending = true
  busy.value = true
  message.value = ''
  const current = generation
  let knownCode: string | null = null,
    acknowledged = false
  try {
    const response: unknown = await $fetch('/api/admin/products', {
      method: 'POST',
      body: JSON.parse(command.payload),
      retry: 0,
      headers: { Origin: window.location.origin, 'Idempotency-Key': command.key },
      onResponseError({ response }) {
        if (response.status >= 400 && response.status < 500) knownCode = domainCode(response._data)
      }
    })
    if (!alive || current !== generation || !allowedNow()) return
    const parsed = catalogDraftAuthoringReceiptSchema.safeParse(ownRecord(response))
    if (!parsed.success || parsed.data.action !== 'create_draft' || parsed.data.catalogVersion !== 1)
      throw new Error('unconfirmed_receipt')
    acknowledged = true
    await props.onCreated({ id: parsed.data.productId, uuid: parsed.data.productUuid })
    if (!alive || current !== generation || !allowedNow()) return
    intent = null
    uncertain.value = false
    completed.value = true
    message.value = 'Borrador creado. No se ha publicado ni aprobado su precio.'
  } catch (cause) {
    if (!alive || current !== generation) return
    if (!acknowledged && (knownCode || errorCode(cause))) {
      intent = null
      uncertain.value = false
      blocked.value = true
      message.value = 'No se pudo crear el borrador. Consulta de nuevo las referencias antes de preparar otro cambio.'
    } else {
      uncertain.value = true
      message.value =
        'No se ha podido confirmar el resultado. Conservamos la misma solicitud; puedes reintentarla manualmente sin crear otra intención.'
    }
  } finally {
    pending = false
    if (alive) {
      busy.value = false
      if (intent && !completed.value) {
        uncertain.value = true
        if (!message.value)
          message.value =
            'La lectura o autorización cambió. La solicitud original se conserva sin reintento automático.'
      }
    }
  }
}
async function submit() {
  const payload = preparePayload()
  if (
    pending ||
    reading ||
    !alive ||
    !allowedNow() ||
    !payload ||
    busy.value ||
    reloading.value ||
    uncertain.value ||
    blocked.value ||
    completed.value
  )
    return
  try {
    intent = Object.freeze({ payload: JSON.stringify(payload), key: randomId() })
  } catch {
    message.value = 'No se ha podido preparar una solicitud segura.'
    return
  }
  await send(intent)
}
async function retry() {
  if (canRetry.value && intent) await send(intent)
}
async function reloadOptions() {
  if (pending || reading || !alive || props.runtime !== 'cloudflare') return
  reading = true
  reloading.value = true
  const current = generation
  try {
    await props.refreshOptions()
    await nextTick()
    if (!alive || (current !== generation && !references.value)) return
    if (!getReferences() || !allowedNow()) {
      message.value = 'Las referencias no están confirmadas o no tienes autorización.'
      return
    }
    if (!intent) blocked.value = false
    message.value = intent
      ? 'Referencias consultadas. La solicitud original sigue pendiente de confirmación.'
      : 'Referencias consultadas; revisa los datos antes de guardar.'
  } catch {
    if (alive) message.value = 'No se han podido consultar las referencias. Inténtalo de nuevo manualmente.'
  } finally {
    reading = false
    if (alive) reloading.value = false
  }
}
</script>

<template>
  <section
    class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
    :aria-labelledby="`${prefix}-heading`"
  >
    <h2 :id="`${prefix}-heading`" class="text-lg font-semibold text-[var(--text-strong)]">Crear producto borrador</h2>
    <p class="mt-1 text-sm text-[var(--text-muted)]">
      Se crea con una variante, precio pendiente de aprobación (0) y stock 0. No publica: requiere precio, política y
      medios válidos, y stock gestionado antes de vender.
    </p>
    <p v-if="optionsStatus === 'pending'" role="status" class="mt-4 text-sm">Consultando referencias…</p>
    <p v-else-if="!references" role="alert" class="mt-4 text-sm">
      No hay una lectura válida de referencias. No se puede crear un borrador.
    </p>
    <p v-else-if="!allowed" role="status" class="mt-4 text-sm">No tienes autorización para crear borradores.</p>
    <form
      v-if="references && allowed && safeForm && !completed"
      class="mt-5 space-y-5"
      :aria-busy="busy"
      @submit.prevent="submit"
    >
      <fieldset :disabled="busy || reloading || uncertain || blocked" class="space-y-3">
        <legend class="font-semibold">Identidad y metadatos</legend>
        <div class="grid gap-3 sm:grid-cols-2">
          <label
            v-for="field in [
              { key: 'name', label: 'Nombre', max: 160 },
              { key: 'shortDesc', label: 'Descripción breve', max: 500 },
              { key: 'series', label: 'Serie (opcional)', max: 160 }
            ]"
            :key="field.key"
            :for="`${prefix}-${field.key}`"
            class="text-sm"
          >
            {{ field.label
            }}<input
              :id="`${prefix}-${field.key}`"
              :data-field="field.key"
              class="draft-field"
              :value="safeForm[field.key] ?? ''"
              :maxlength="field.max"
              :required="field.key !== 'series'"
              @input="update(field.key, $event)"
            />
          </label>
          <label :for="`${prefix}-categoryId`" class="text-sm"
            >Categoría<select
              :id="`${prefix}-categoryId`"
              data-field="categoryId"
              class="draft-field"
              :value="safeForm.categoryId"
              required
              @change="update('categoryId', $event, true)"
            >
              <option value="">Selecciona una referencia</option>
              <option v-for="entry in references.categories" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
            </select></label
          >
          <label :for="`${prefix}-brandId`" class="text-sm"
            >Marca<select
              :id="`${prefix}-brandId`"
              data-field="brandId"
              class="draft-field"
              :value="safeForm.brandId"
              required
              @change="update('brandId', $event)"
            >
              <option value="">Selecciona una referencia</option>
              <option v-for="entry in references.brands" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
            </select></label
          >
          <label :for="`${prefix}-featured`" class="flex items-center gap-2 text-sm"
            ><input
              :id="`${prefix}-featured`"
              data-field="featured"
              type="checkbox"
              :checked="safeForm.featured === true"
              @change="update('featured', $event)"
            />
            Destacado editorial</label
          >
        </div>
        <label
          v-for="field in [
            { key: 'description', label: 'Descripción', max: 10000 },
            { key: 'usage', label: 'Uso (opcional)', max: 2000 }
          ]"
          :key="field.key"
          :for="`${prefix}-${field.key}`"
          class="block text-sm"
          >{{ field.label
          }}<textarea
            :id="`${prefix}-${field.key}`"
            :data-field="field.key"
            class="draft-field"
            :value="typeof safeForm[field.key] === 'string' ? String(safeForm[field.key]) : ''"
            :maxlength="field.max"
            :required="field.key === 'description'"
            @input="update(field.key, $event)"
          />
        </label>
        <div class="flex flex-wrap gap-4">
          <label
            v-for="badge in badges"
            :key="badge"
            :for="`${prefix}-badge-${badge}`"
            class="flex items-center gap-2 text-sm"
            ><input
              :id="`${prefix}-badge-${badge}`"
              type="checkbox"
              :checked="Array.isArray(safeForm.badges) && safeForm.badges.includes(badge)"
              @change="toggleBadge(badge, $event)"
            />{{ badge }}</label
          >
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <label :for="`${prefix}-visual-type`" class="text-sm"
            >Tipo visual<select
              :id="`${prefix}-visual-type`"
              data-field="visual-type"
              class="draft-field"
              :value="visual?.type"
              @change="updateVisual('type', $event)"
            >
              <option v-for="type in visualTypes" :key="type" :value="type">{{ type }}</option>
            </select></label
          ><label :for="`${prefix}-visual-color`" class="text-sm"
            >Color visual<input
              :id="`${prefix}-visual-color`"
              data-field="visual-color"
              class="draft-field"
              :value="visual?.color"
              maxlength="7"
              required
              @input="updateVisual('color', $event)"
          /></label>
        </div>
        <div v-for="(attribute, index) in attrs" :key="index" class="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <label :for="`${prefix}-attr-${index}-k`" class="text-sm"
            >Atributo<input
              :id="`${prefix}-attr-${index}-k`"
              class="draft-field"
              :value="attribute.k"
              maxlength="100"
              required
              @input="changeAttribute(index, 'k', $event)"
          /></label>
          <label :for="`${prefix}-attr-${index}-v`" class="text-sm"
            >Valor<input
              :id="`${prefix}-attr-${index}-v`"
              class="draft-field"
              :value="attribute.v"
              maxlength="1000"
              required
              @input="changeAttribute(index, 'v', $event)"
          /></label>
          <UButton type="button" color="neutral" variant="outline" @click="removeAttribute(index)"
            >Quitar atributo</UButton
          >
        </div>
        <UButton type="button" color="neutral" variant="outline" :disabled="attrs.length >= 50" @click="addAttribute"
          >Añadir atributo</UButton
        >
      </fieldset>
      <DraftVariantFields
        :model-value="safeForm.initialVariant"
        :options="references"
        :prefix="`${prefix}-initial`"
        :disabled="busy || reloading || uncertain || blocked"
        @update:model-value="updateVariant"
      />
      <label :for="`${prefix}-reason`" class="block text-sm"
        >Motivo de creación<input
          :id="`${prefix}-reason`"
          data-field="reason"
          class="draft-field"
          :value="safeForm.reason"
          minlength="3"
          maxlength="500"
          required
          :disabled="busy || reloading || uncertain || blocked"
          @input="update('reason', $event)"
      /></label>
      <UButton data-action="create" type="submit" :disabled="!canSubmit" :loading="busy">Crear borrador</UButton>
    </form>
    <p v-if="message" class="mt-4 text-sm" role="status" aria-live="polite">{{ message }}</p>
    <div class="mt-4 flex flex-wrap gap-2">
      <UButton
        v-if="uncertain"
        data-action="retry"
        type="button"
        color="neutral"
        variant="outline"
        :disabled="!canRetry"
        :loading="busy"
        @click="retry"
        >Reintentar la misma solicitud</UButton
      >
      <UButton
        data-action="reload-options"
        type="button"
        color="neutral"
        variant="outline"
        :disabled="busy || reloading || runtime !== 'cloudflare'"
        :loading="reloading"
        @click="reloadOptions"
        >Consultar referencias de nuevo</UButton
      >
    </div>
  </section>
</template>

<style scoped>
.draft-field {
  display: block;
  width: 100%;
  min-width: 0;
  margin-top: 0.25rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  padding: 0.5rem;
  background: var(--surface);
  color: var(--text-strong);
}
.draft-field:focus-visible {
  outline: 2px solid var(--color-neteco-600);
  outline-offset: 1px;
}
</style>
