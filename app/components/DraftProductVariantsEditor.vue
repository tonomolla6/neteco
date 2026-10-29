<script setup lang="ts">
import {
  assignBrandInputSchema,
  createVariantInputSchema,
  updateVariantInputSchema,
  discontinueVariantInputSchema,
  draftVariantInputSchema,
  catalogDraftAuthoringReceiptSchema
} from '~~/shared/catalog-draft-authoring'
import {
  catalogDraftAuthoringOptionsSchema,
  catalogDraftAuthoringSnapshotSchema,
  type CatalogDraftAuthoringSnapshot
} from '~~/shared/catalog-draft-authoring-options'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
import { randomId } from '../utils/uuid'
import DraftVariantFields from './DraftVariantFields.vue'

type Identity = { id: number; uuid: string; version: number }
type Variant = CatalogDraftAuthoringSnapshot['variants'][number]
const props = defineProps<{
  product: unknown
  productId: string
  readStatus: string
  options: unknown
  optionsStatus: string
  runtime: unknown
  authorize: (identity: Identity) => boolean
  refreshProduct: () => Promise<unknown>
  refreshOptions: () => Promise<unknown>
}>()
const prefix = useId()
function ownRecord(value: unknown): Record<string, unknown> | null {
  try {
    const copied = catalogPolicyOwnJson(value)
    return copied && typeof copied === 'object' && !Array.isArray(copied) ? (copied as Record<string, unknown>) : null
  } catch {
    return null
  }
}
function getConfirmed() {
  if (props.runtime !== 'cloudflare' || props.readStatus !== 'success' || !/^[1-9]\d*$/.test(props.productId))
    return null
  const product = ownRecord(props.product),
    capabilities = ownRecord(product?.capabilities)
  if (!product || product.source !== 'cloudflare' || capabilities?.productDetailRead !== true) return null
  const parsed = catalogDraftAuthoringSnapshotSchema.safeParse(product.authoring)
  if (!parsed.success) return null
  const snapshot = parsed.data
  if (
    String(snapshot.productId) !== props.productId ||
    product.id !== snapshot.productId ||
    product.uuid !== snapshot.productUuid ||
    product.catalogVersion !== snapshot.catalogVersion ||
    product.status !== snapshot.status
  )
    return null
  return {
    snapshot,
    capabilities,
    identity: { id: snapshot.productId, uuid: snapshot.productUuid, version: snapshot.catalogVersion }
  }
}
const confirmed = computed(getConfirmed)
function getReferences() {
  if (props.runtime !== 'cloudflare' || props.optionsStatus !== 'success') return null
  const parsed = catalogDraftAuthoringOptionsSchema.safeParse(props.options)
  return parsed.success ? parsed.data : null
}
const references = computed(getReferences)
function authorized() {
  const current = getConfirmed()
  if (!current) return false
  try {
    return props.authorize({ ...current.identity }) === true
  } catch {
    return false
  }
}
const actionCapability = {
  assign_brand: 'productDraftBrandUpdate',
  create_variant: 'variantDraftCreate',
  update_variant: 'variantDraftUpdate',
  discontinue_variant: 'variantDraftDiscontinue'
} as const
type EditorAction = keyof typeof actionCapability
function permitted(action: EditorAction, newCommand = true) {
  const current = getConfirmed(),
    options = getReferences(),
    key = actionCapability[action]
  return (
    !!current &&
    !!options &&
    (!newCommand || (current.snapshot.status === 'draft' && current.identity.version < Number.MAX_SAFE_INTEGER)) &&
    current.capabilities[key] === true &&
    options.capabilities[key] === true &&
    authorized()
  )
}
const baseline = ref<Identity | null>(null),
  baselineVariant = ref<Variant | null>(null)
const selectedId = ref(''),
  mode = ref<'update' | 'create'>('update')
const variantForm = ref<Record<string, unknown>>({}),
  variantReason = ref(''),
  brandId = ref(''),
  brandReason = ref('')
const discontinueReason = ref(''),
  removalConfirmed = ref(false)
const busy = ref(false),
  reloading = ref(false),
  uncertain = ref(false),
  blocked = ref(false),
  message = ref('')
let alive = true,
  pending = false,
  reading = false,
  generation = 0
type Intent = Readonly<{
  action: EditorAction
  payload: string
  key: string
  path: string
  method: 'POST' | 'PUT'
  identity: Readonly<Identity>
  variant: Readonly<{ id: number; uuid: string }> | null
  originalVariantIds: readonly number[]
  originalVariantUuids: readonly string[]
}>
let intent: Intent | null = null
const editableKeys = [
  'format',
  'ean',
  'gtin',
  'mpn',
  'taxClassId',
  'shippingProfileId',
  'unitBase',
  'unitLabel',
  'contentQuantity',
  'unitsPerCase',
  'casesPerPallet',
  'minimumQuantity',
  'quantityIncrement',
  'maximumQuantity',
  'weightGrams',
  'widthMm',
  'heightMm',
  'depthMm',
  'backorderAllowed',
  'leadTimeDays',
  'color'
] as const
const selected = computed(
  () => confirmed.value?.snapshot.variants.find((variant) => String(variant.id) === selectedId.value) ?? null
)
const fresh = computed(
  () =>
    !!baseline.value &&
    !!confirmed.value &&
    baseline.value.id === confirmed.value.identity.id &&
    baseline.value.uuid === confirmed.value.identity.uuid &&
    baseline.value.version === confirmed.value.identity.version
)
const editable = computed(() => !busy.value && !reloading.value && !uncertain.value && !blocked.value && fresh.value)
function copyVariant(variant: Variant): Record<string, unknown> {
  const output: Record<string, unknown> = { sku: variant.sku }
  for (const key of editableKeys) output[key] = variant[key]
  return output
}
function newVariant() {
  return {
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
}
function initialize() {
  const reading = getConfirmed()
  if (!reading || intent) return
  baseline.value = { ...reading.identity }
  brandId.value = reading.snapshot.brandId ?? ''
  brandReason.value = ''
  variantReason.value = ''
  discontinueReason.value = ''
  removalConfirmed.value = false
  const current =
    reading.snapshot.variants.find((variant) => String(variant.id) === selectedId.value) ??
    reading.snapshot.variants.find((variant) => variant.status !== 'discontinued')
  mode.value = 'update'
  selectedId.value = current ? String(current.id) : ''
  baselineVariant.value = current ? { ...current } : null
  variantForm.value = current ? copyVariant(current) : newVariant()
}
watch(
  confirmed,
  (current) => {
    if (!current) {
      generation++
      return
    }
    if (!baseline.value && !intent) initialize()
    else if (
      baseline.value &&
      (current.identity.id !== baseline.value.id || current.identity.uuid !== baseline.value.uuid)
    ) {
      generation++
      if (!intent) initialize()
    }
  },
  { immediate: true }
)
watch(
  () => props.optionsStatus,
  (value) => {
    if (value !== 'success') generation++
  }
)
watch(
  () => authorized(),
  (value) => {
    if (!value) generation++
  }
)
onBeforeUnmount(() => {
  alive = false
  generation++
})

function selectVariant(event: Event) {
  if (!editable.value || !confirmed.value) return
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  const variant = confirmed.value.snapshot.variants.find((entry) => String(entry.id) === target.value)
  if (!variant) return
  selectedId.value = target.value
  mode.value = 'update'
  baselineVariant.value = { ...variant }
  variantForm.value = copyVariant(variant)
  variantReason.value = ''
  discontinueReason.value = ''
  removalConfirmed.value = false
}
function startCreate() {
  if (!editable.value || !permitted('create_variant')) return
  mode.value = 'create'
  baselineVariant.value = null
  variantForm.value = newVariant()
  variantReason.value = ''
  removalConfirmed.value = false
}
function updateVariantForm(value: Record<string, unknown>) {
  if (editable.value) variantForm.value = value
}
function referencesMatch(value: Record<string, unknown>) {
  const options = getReferences()
  return (
    !!options &&
    options.taxClasses.some((entry) => entry.id === value.taxClassId) &&
    options.shippingProfiles.some((entry) => entry.id === value.shippingProfileId)
  )
}
function prepareVariant() {
  const reading = getConfirmed()
  if (
    !baseline.value ||
    !reading ||
    baseline.value.id !== reading.identity.id ||
    baseline.value.uuid !== reading.identity.uuid ||
    baseline.value.version !== reading.identity.version
  )
    return null
  const fields = ownRecord(variantForm.value)
  if (!fields || !referencesMatch(fields)) return null
  if (mode.value === 'create') {
    const parsed = createVariantInputSchema.safeParse({
      ...fields,
      expectedVersion: baseline.value.version,
      reason: variantReason.value
    })
    return parsed.success ? parsed.data : null
  }
  const original = baselineVariant.value,
    current = reading.snapshot.variants.find((entry) => String(entry.id) === selectedId.value)
  if (
    !original ||
    !current ||
    original.id !== current.id ||
    original.uuid !== current.uuid ||
    current.status === 'discontinued' ||
    fields.sku !== original.sku
  )
    return null
  const diff: Record<string, unknown> = { expectedVersion: baseline.value.version, reason: variantReason.value }
  for (const key of editableKeys)
    if (Object.hasOwn(fields, key) && fields[key] !== original[key]) diff[key] = fields[key]
  const parsed = updateVariantInputSchema.safeParse(diff)
  if (!parsed.success) return null
  const merged = copyVariant(original)
  for (const key of editableKeys) if (Object.hasOwn(parsed.data, key)) merged[key] = parsed.data[key]
  return draftVariantInputSchema.safeParse(merged).success ? parsed.data : null
}
const variantPayload = computed(prepareVariant)
function prepareBrand() {
  const current = getConfirmed(),
    options = getReferences()
  if (
    !baseline.value ||
    !current ||
    baseline.value.id !== current.identity.id ||
    baseline.value.uuid !== current.identity.uuid ||
    baseline.value.version !== current.identity.version ||
    brandId.value === current.snapshot.brandId ||
    !options?.brands.some((entry) => entry.id === brandId.value)
  )
    return null
  const parsed = assignBrandInputSchema.safeParse({
    expectedVersion: baseline.value.version,
    reason: brandReason.value,
    brandId: brandId.value
  })
  return parsed.success ? parsed.data : null
}
const brandPayload = computed(prepareBrand)
function prepareRemoval() {
  const current = getConfirmed(),
    selected = current?.snapshot.variants.find((entry) => String(entry.id) === selectedId.value)
  if (
    !baseline.value ||
    !current ||
    baseline.value.id !== current.identity.id ||
    baseline.value.uuid !== current.identity.uuid ||
    baseline.value.version !== current.identity.version ||
    !selected ||
    selected.status === 'discontinued' ||
    !removalConfirmed.value ||
    current.snapshot.variants.filter((entry) => entry.status !== 'discontinued').length < 2
  )
    return null
  const parsed = discontinueVariantInputSchema.safeParse({
    expectedVersion: baseline.value.version,
    reason: discontinueReason.value
  })
  return parsed.success ? parsed.data : null
}
const removalPayload = computed(prepareRemoval)
const canSaveVariant = computed(
  () =>
    editable.value && !!variantPayload.value && permitted(mode.value === 'create' ? 'create_variant' : 'update_variant')
)
const canSaveBrand = computed(() => editable.value && !!brandPayload.value && permitted('assign_brand'))
const canDiscontinue = computed(() => editable.value && !!removalPayload.value && permitted('discontinue_variant'))
function sameTarget(command: Intent) {
  const current = getConfirmed()
  if (
    !current ||
    current.identity.id !== command.identity.id ||
    current.identity.uuid !== command.identity.uuid ||
    !permitted(command.action, false)
  )
    return false
  return true
}
const canRetry = computed(() => uncertain.value && !!intent && !busy.value && !reloading.value && sameTarget(intent))
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
function receiptMatches(response: unknown, command: Intent) {
  const parsed = catalogDraftAuthoringReceiptSchema.safeParse(ownRecord(response))
  if (!parsed.success) return false
  const receipt = parsed.data
  if (
    receipt.action !== command.action ||
    receipt.productId !== command.identity.id ||
    receipt.productUuid !== command.identity.uuid ||
    receipt.catalogVersion !== command.identity.version + 1
  )
    return false
  if (command.variant) return receipt.variantId === command.variant.id && receipt.variantUuid === command.variant.uuid
  return (
    command.action === 'assign_brand' ||
    (receipt.variantId !== null &&
      receipt.variantUuid !== null &&
      !command.originalVariantIds.includes(receipt.variantId) &&
      !command.originalVariantUuids.includes(receipt.variantUuid))
  )
}
async function send(command: Intent) {
  if (pending || reading || !alive || !sameTarget(command)) return
  pending = true
  busy.value = true
  message.value = ''
  const current = generation
  let knownCode: string | null = null,
    acknowledged = false
  try {
    const response: unknown = await $fetch(command.path, {
      method: command.method,
      body: JSON.parse(command.payload),
      retry: 0,
      headers: { Origin: window.location.origin, 'Idempotency-Key': command.key },
      onResponseError({ response }) {
        if (response.status >= 400 && response.status < 500) knownCode = domainCode(response._data)
      }
    })
    if (!alive || current !== generation || !sameTarget(command)) return
    if (!receiptMatches(response, command)) throw new Error('unconfirmed_receipt')
    acknowledged = true
    // A receipt is historical evidence, never a replacement for the current read.
    await props.refreshProduct()
    await nextTick()
    if (!alive || !sameTarget(command)) return
    const identity = getConfirmed()?.identity
    if (!identity || identity.version < command.identity.version + 1) throw new Error('unconfirmed_refresh')
    intent = null
    uncertain.value = false
    blocked.value = false
    initialize()
    message.value = 'Cambio guardado en el borrador. No se ha publicado ni aprobado su precio.'
  } catch (cause) {
    if (!alive || (current !== generation && !acknowledged)) return
    if (!acknowledged && (knownCode || errorCode(cause))) {
      intent = null
      uncertain.value = false
      blocked.value = true
      message.value =
        'No se pudo guardar el cambio. Consulta de nuevo el producto y las referencias antes de preparar otro cambio.'
    } else {
      uncertain.value = true
      message.value =
        'No se ha podido confirmar el resultado y su lectura actual. Conservamos la misma solicitud para un reintento manual.'
    }
  } finally {
    pending = false
    if (alive) {
      busy.value = false
      if (intent) {
        uncertain.value = true
        if (!message.value)
          message.value =
            'La lectura o autorización cambió. La solicitud original se conserva sin reintento automático.'
      }
    }
  }
}
async function begin(action: EditorAction, payload: unknown) {
  const current = getConfirmed()
  if (
    pending ||
    reading ||
    !alive ||
    !editable.value ||
    !current ||
    !baseline.value ||
    baseline.value.id !== current.identity.id ||
    baseline.value.uuid !== current.identity.uuid ||
    baseline.value.version !== current.identity.version ||
    !permitted(action)
  )
    return
  const variant =
    action === 'update_variant' || action === 'discontinue_variant'
      ? current.snapshot.variants.find((entry) => String(entry.id) === selectedId.value)
      : null
  if ((action === 'update_variant' || action === 'discontinue_variant') && !variant) return
  const base = `/api/admin/products/${current.identity.id}`
  const path =
    action === 'assign_brand'
      ? `${base}/brand`
      : action === 'create_variant'
        ? `${base}/variants`
        : `${base}/variants/${variant!.id}${action === 'discontinue_variant' ? '/discontinue' : ''}`
  try {
    intent = Object.freeze({
      action,
      payload: JSON.stringify(payload),
      key: randomId(),
      path,
      method: action === 'assign_brand' || action === 'update_variant' ? 'PUT' : 'POST',
      identity: Object.freeze({ ...baseline.value }),
      variant: variant ? Object.freeze({ id: variant.id, uuid: variant.uuid }) : null,
      originalVariantIds: Object.freeze(current.snapshot.variants.map((entry) => entry.id)),
      originalVariantUuids: Object.freeze(current.snapshot.variants.map((entry) => entry.uuid))
    })
  } catch {
    message.value = 'No se ha podido preparar una solicitud segura.'
    return
  }
  await send(intent)
}
async function saveVariant() {
  const payload = prepareVariant(),
    action = mode.value === 'create' ? 'create_variant' : 'update_variant'
  if (editable.value && payload && permitted(action)) await begin(action, payload)
}
async function saveBrand() {
  const payload = prepareBrand()
  if (editable.value && payload && permitted('assign_brand')) await begin('assign_brand', payload)
}
async function discontinue() {
  const payload = prepareRemoval()
  if (editable.value && payload && permitted('discontinue_variant')) await begin('discontinue_variant', payload)
}
async function retry() {
  if (canRetry.value && intent) await send(intent)
}
async function reload() {
  if (pending || reading || !alive || props.runtime !== 'cloudflare') return
  reading = true
  reloading.value = true
  const target = props.productId
  try {
    await Promise.all([props.refreshProduct(), props.refreshOptions()])
    await nextTick()
    if (!alive || target !== props.productId) return
    if (!getConfirmed() || !getReferences() || !authorized()) {
      message.value = 'El producto o las referencias no están confirmados, o no tienes autorización.'
      return
    }
    if (!intent) {
      blocked.value = false
      initialize()
    }
    message.value = intent
      ? 'Lecturas consultadas. La solicitud original sigue pendiente de confirmación.'
      : 'Lecturas consultadas; revisa los datos antes de guardar.'
  } catch {
    if (alive && target === props.productId)
      message.value = 'No se han podido consultar las lecturas. Inténtalo de nuevo manualmente.'
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
    <h2 :id="`${prefix}-heading`" class="text-lg font-semibold text-[var(--text-strong)]">
      Marca y variantes del borrador
    </h2>
    <p class="mt-1 text-sm text-[var(--text-muted)]">
      SKU y slug permanecen fijos. Las variantes nuevas nacen con precio pendiente de aprobación (0) y stock 0; estos
      cambios no publican, no aprueban precios y no ajustan inventario.
    </p>
    <p v-if="readStatus === 'pending' || optionsStatus === 'pending'" role="status" class="mt-4 text-sm">
      Consultando producto y referencias…
    </p>
    <p v-else-if="!confirmed || !references" role="alert" class="mt-4 text-sm">
      No hay una lectura válida del producto y sus referencias. No se pueden guardar cambios.
    </p>
    <p v-else-if="confirmed.snapshot.status !== 'draft' || !authorized()" role="status" class="mt-4 text-sm">
      Sólo se pueden preparar estos cambios en un borrador autorizado.
    </p>
    <template v-if="confirmed && references && confirmed.snapshot.status === 'draft' && authorized()">
      <p v-if="!fresh && !uncertain" role="alert" class="mt-4 text-sm">
        La versión cambió. Consulta de nuevo antes de preparar otro cambio.
      </p>
      <form
        v-if="permitted('assign_brand')"
        class="mt-5 space-y-3 border-b border-[var(--border)] pb-5"
        :aria-busy="busy"
        @submit.prevent="saveBrand"
      >
        <h3 class="font-semibold">Asignar marca</h3>
        <fieldset :disabled="!editable" class="grid gap-3 sm:grid-cols-2">
          <label :for="`${prefix}-brand`" class="text-sm"
            >Marca<select :id="`${prefix}-brand`" v-model="brandId" data-field="brandId" class="draft-field" required>
              <option value="">Selecciona una referencia</option>
              <option v-for="entry in references.brands" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
            </select></label
          >
          <label :for="`${prefix}-brand-reason`" class="text-sm"
            >Motivo del cambio de marca<input
              :id="`${prefix}-brand-reason`"
              v-model="brandReason"
              data-field="brandReason"
              class="draft-field"
              minlength="3"
              maxlength="500"
              required
          /></label>
        </fieldset>
        <UButton data-action="brand" type="submit" :disabled="!canSaveBrand" :loading="busy">Guardar marca</UButton>
      </form>
      <div class="mt-5 flex flex-wrap items-end gap-3">
        <label :for="`${prefix}-variant`" class="min-w-0 flex-1 text-sm"
          >Variante confirmada<select
            :id="`${prefix}-variant`"
            data-field="selectedVariant"
            class="draft-field"
            :value="selectedId"
            :disabled="!editable"
            @change="selectVariant"
          >
            <option value="">Selecciona una variante</option>
            <option v-for="entry in confirmed.snapshot.variants" :key="entry.id" :value="String(entry.id)">
              {{ entry.sku }} — {{ entry.format }}{{ entry.status === 'discontinued' ? ' (retirada)' : '' }}
            </option>
          </select></label
        >
        <UButton
          v-if="permitted('create_variant')"
          data-action="new-variant"
          type="button"
          color="neutral"
          variant="outline"
          :disabled="!editable"
          @click="startCreate"
          >Añadir variante borrador</UButton
        >
      </div>
      <form
        v-if="
          mode === 'create'
            ? permitted('create_variant')
            : selected && selected.status !== 'discontinued' && permitted('update_variant')
        "
        class="mt-5 space-y-4"
        :aria-busy="busy"
        @submit.prevent="saveVariant"
      >
        <h3 class="font-semibold">{{ mode === 'create' ? 'Nueva variante' : 'Editar variante' }}</h3>
        <DraftVariantFields
          :model-value="variantForm"
          :options="references"
          :prefix="`${prefix}-variant-fields`"
          :disabled="!editable"
          :immutable-sku="mode === 'update'"
          @update:model-value="updateVariantForm"
        />
        <label :for="`${prefix}-variant-reason`" class="block text-sm"
          >Motivo del cambio de variante<input
            :id="`${prefix}-variant-reason`"
            v-model="variantReason"
            data-field="variantReason"
            class="draft-field"
            minlength="3"
            maxlength="500"
            required
            :disabled="!editable"
        /></label>
        <UButton data-action="variant" type="submit" :disabled="!canSaveVariant" :loading="busy">{{
          mode === 'create' ? 'Crear variante borrador' : 'Guardar campos modificados'
        }}</UButton>
      </form>
      <form
        v-if="mode === 'update' && selected && selected.status !== 'discontinued' && permitted('discontinue_variant')"
        class="mt-5 space-y-3 border-t border-[var(--border)] pt-5"
        :aria-busy="busy"
        @submit.prevent="discontinue"
      >
        <h3 class="font-semibold">Retirar variante</h3>
        <p class="text-sm text-[var(--text-muted)]">
          Dejará de estar disponible para nuevas operaciones. Se conserva su historial; no modifica precios ni stock.
          Debe quedar al menos una variante no retirada.
        </p>
        <label :for="`${prefix}-remove-reason`" class="block text-sm"
          >Motivo de retirada<input
            :id="`${prefix}-remove-reason`"
            v-model="discontinueReason"
            data-field="discontinueReason"
            class="draft-field"
            minlength="3"
            maxlength="500"
            required
            :disabled="!editable"
        /></label>
        <label :for="`${prefix}-remove-confirm`" class="flex items-center gap-2 text-sm"
          ><input
            :id="`${prefix}-remove-confirm`"
            v-model="removalConfirmed"
            data-field="removalConfirmed"
            type="checkbox"
            :disabled="!editable"
          />Confirmo la retirada de {{ selected.sku }} y su impacto</label
        >
        <UButton
          data-action="discontinue"
          type="submit"
          color="error"
          variant="outline"
          :disabled="!canDiscontinue"
          :loading="busy"
          >Retirar variante</UButton
        >
      </form>
    </template>
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
        data-action="reload"
        type="button"
        color="neutral"
        variant="outline"
        :disabled="busy || reloading || runtime !== 'cloudflare'"
        :loading="reloading"
        @click="reload"
        >Consultar producto y referencias de nuevo</UButton
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
