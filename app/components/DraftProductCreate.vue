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
    backorderAllowed: true,
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
const badgeLabels: Record<(typeof badges)[number], string> = {
  eco: 'eco',
  alimentaria: 'de uso alimentario',
  concentrado: 'de concentrado'
}
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
  <AdminCard
    :aria-labelledby="`${prefix}-heading`"
    description="Se crea con una variante, precio pendiente de aprobación (0) y stock 0. No publica: antes de vender hay que aprobar el precio, completar las imágenes y dar de alta el stock."
  >
    <template #title>
      <span :id="`${prefix}-heading`">Crear producto en borrador</span>
    </template>
    <div class="adm-stack">
      <p v-if="optionsStatus === 'pending'" role="status" class="adm-help">Cargando familias, marcas e impuestos…</p>
      <UAlert
        v-else-if="!references"
        role="alert"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="No se han podido cargar las familias, marcas e impuestos"
        description="Sin esos datos no se puede crear el producto. Vuelve a cargarlos con el botón de abajo."
      />
      <UAlert
        v-else-if="!allowed"
        role="status"
        color="neutral"
        variant="subtle"
        icon="i-lucide-lock"
        title="Tu usuario no puede crear productos"
      />
      <form
        v-if="references && allowed && safeForm && !completed"
        class="adm-stack"
        :aria-busy="busy"
        @submit.prevent="submit"
      >
        <fieldset :disabled="busy || reloading || uncertain || blocked" class="min-w-0 space-y-4">
          <legend class="adm-section__title">Identidad y metadatos</legend>
          <div class="adm-form-grid">
            <div
              v-for="field in [
                { key: 'name', label: 'Nombre', max: 160 },
                { key: 'shortDesc', label: 'Descripción breve', max: 500 },
                { key: 'series', label: 'Gama (opcional)', max: 160 }
              ]"
              :key="field.key"
              class="adm-field"
            >
              <label :for="`${prefix}-${field.key}`" class="adm-label">{{ field.label }}</label>
              <input
                :id="`${prefix}-${field.key}`"
                :data-field="field.key"
                class="adm-input w-full"
                :value="safeForm[field.key] ?? ''"
                :maxlength="field.max"
                :required="field.key !== 'series'"
                @input="update(field.key, $event)"
              />
            </div>
            <div class="adm-field">
              <label :for="`${prefix}-categoryId`" class="adm-label">Familia</label>
              <select
                :id="`${prefix}-categoryId`"
                data-field="categoryId"
                class="adm-input w-full"
                :value="safeForm.categoryId"
                required
                @change="update('categoryId', $event, true)"
              >
                <option value="">Elige una familia</option>
                <option v-for="entry in references.categories" :key="entry.id" :value="entry.id">
                  {{ entry.name }}
                </option>
              </select>
            </div>
            <div class="adm-field">
              <label :for="`${prefix}-brandId`" class="adm-label">Marca</label>
              <select
                :id="`${prefix}-brandId`"
                data-field="brandId"
                class="adm-input w-full"
                :value="safeForm.brandId"
                required
                @change="update('brandId', $event)"
              >
                <option value="">Elige una marca</option>
                <option v-for="entry in references.brands" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
              </select>
            </div>
          </div>
          <div
            v-for="field in [
              { key: 'description', label: 'Descripción', max: 10000, rows: 5 },
              { key: 'usage', label: 'Modo de empleo (opcional)', max: 2000, rows: 3 }
            ]"
            :key="field.key"
            class="adm-field"
          >
            <label :for="`${prefix}-${field.key}`" class="adm-label">{{ field.label }}</label>
            <textarea
              :id="`${prefix}-${field.key}`"
              :data-field="field.key"
              class="adm-input w-full"
              :rows="field.rows"
              :value="typeof safeForm[field.key] === 'string' ? String(safeForm[field.key]) : ''"
              :maxlength="field.max"
              :required="field.key === 'description'"
              @input="update(field.key, $event)"
            />
          </div>
          <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
            <label :for="`${prefix}-featured`" class="adm-check"
              ><input
                :id="`${prefix}-featured`"
                data-field="featured"
                type="checkbox"
                :checked="safeForm.featured === true"
                @change="update('featured', $event)"
              />
              Destacado en la tienda</label
            >
            <label v-for="badge in badges" :key="badge" :for="`${prefix}-badge-${badge}`" class="adm-check"
              ><input
                :id="`${prefix}-badge-${badge}`"
                type="checkbox"
                :checked="Array.isArray(safeForm.badges) && safeForm.badges.includes(badge)"
                @change="toggleBadge(badge, $event)"
              />Sello {{ badgeLabels[badge] }}</label
            >
          </div>
          <div class="adm-form-grid">
            <div class="adm-field">
              <label :for="`${prefix}-visual-type`" class="adm-label">Tipo de envase</label>
              <select
                :id="`${prefix}-visual-type`"
                data-field="visual-type"
                class="adm-input w-full"
                :value="visual?.type"
                @change="updateVisual('type', $event)"
              >
                <option v-for="type in visualTypes" :key="type" :value="type">{{ ENVASE_LABELS[type] ?? type }}</option>
              </select>
            </div>
            <div class="adm-field">
              <label :for="`${prefix}-visual-color`" class="adm-label">Color del envase</label>
              <input
                :id="`${prefix}-visual-color`"
                data-field="visual-color"
                class="adm-input w-full"
                :value="visual?.color"
                maxlength="7"
                required
                :aria-describedby="`${prefix}-visual-color-help`"
                @input="updateVisual('color', $event)"
              />
              <p :id="`${prefix}-visual-color-help`" class="adm-help">Código de color, por ejemplo #52665B.</p>
            </div>
          </div>
          <div class="space-y-3">
            <p class="adm-label">Características</p>
            <div
              v-for="(attribute, index) in attrs"
              :key="index"
              class="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]"
            >
              <div class="adm-field">
                <label :for="`${prefix}-attr-${index}-k`" class="adm-label">Característica</label>
                <input
                  :id="`${prefix}-attr-${index}-k`"
                  class="adm-input w-full"
                  :value="attribute.k"
                  maxlength="100"
                  required
                  @input="changeAttribute(index, 'k', $event)"
                />
              </div>
              <div class="adm-field">
                <label :for="`${prefix}-attr-${index}-v`" class="adm-label">Valor</label>
                <input
                  :id="`${prefix}-attr-${index}-v`"
                  class="adm-input w-full"
                  :value="attribute.v"
                  maxlength="1000"
                  required
                  @input="changeAttribute(index, 'v', $event)"
                />
              </div>
              <AdminButton variant="ghost" icon="i-lucide-x" @click="removeAttribute(index)">Quitar</AdminButton>
            </div>
            <AdminButton icon="i-lucide-plus" size="sm" :disabled="attrs.length >= 50" @click="addAttribute"
              >Añadir característica</AdminButton
            >
          </div>
        </fieldset>
        <DraftVariantFields
          :model-value="safeForm.initialVariant"
          :options="references"
          :prefix="`${prefix}-initial`"
          :disabled="busy || reloading || uncertain || blocked"
          @update:model-value="updateVariant"
        />
        <div class="adm-field">
          <label :for="`${prefix}-reason`" class="adm-label">Motivo del alta</label>
          <input
            :id="`${prefix}-reason`"
            data-field="reason"
            class="adm-input w-full"
            :value="safeForm.reason"
            minlength="3"
            maxlength="500"
            required
            :disabled="busy || reloading || uncertain || blocked"
            :aria-describedby="`${prefix}-reason-help`"
            @input="update('reason', $event)"
          />
          <p :id="`${prefix}-reason-help`" class="adm-help">Queda guardado en el historial del producto.</p>
        </div>
        <div class="flex justify-end">
          <AdminButton data-action="create" type="submit" variant="primary" :disabled="!canSubmit" :loading="busy"
            >Crear borrador</AdminButton
          >
        </div>
      </form>
      <p v-if="message" class="text-sm text-[var(--text)]" role="status" aria-live="polite">{{ message }}</p>
    </div>
    <template #footer>
      <div class="flex flex-wrap gap-2">
        <AdminButton
          v-if="uncertain"
          data-action="retry"
          icon="i-lucide-rotate-cw"
          :disabled="!canRetry"
          :loading="busy"
          @click="retry"
          >Reintentar la misma solicitud</AdminButton
        >
        <AdminButton
          data-action="reload-options"
          variant="ghost"
          icon="i-lucide-refresh-cw"
          :disabled="busy || reloading || runtime !== 'cloudflare'"
          :loading="reloading"
          @click="reloadOptions"
          >Volver a cargar familias y marcas</AdminButton
        >
      </div>
    </template>
  </AdminCard>
</template>
