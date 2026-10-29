<script setup lang="ts">
import type { AdminProductDetail } from '~~/shared/types/admin'
import { randomId } from '~/utils/uuid'

type PrivateProduct = AdminProductDetail & {
  source?: unknown
  uuid?: unknown
  catalogVersion?: unknown
  capabilities?: unknown
}
interface Metadata {
  name: string
  categoryId: number
  shortDesc: string
  description: string
  usage: string | null
  series: string | null
  featured: boolean
  badges: string[]
  visual: { type: string; color: string }
  attrs: Array<{ k: string; v: string }>
}
const props = defineProps<{
  product: PrivateProduct | null
  productId: string
  runtime: unknown
  readStatus: string
  categories: Array<{ label: string; value: number }>
  categoriesReady: boolean
  authorize: (identity: { id: number; uuid: string; version?: number }) => boolean
  refreshProduct: () => Promise<unknown>
}>()
const VISUAL_TYPES = [
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
const BADGE_LABELS = { eco: 'Eco', alimentaria: 'Uso alimentario', concentrado: 'Concentrado' }
const FIELDS = [
  'name',
  'categoryId',
  'shortDesc',
  'description',
  'usage',
  'series',
  'featured',
  'badges',
  'visual',
  'attrs'
] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const canonicalId = computed(
  () => /^[1-9]\d{0,15}$/.test(props.productId) && Number.isSafeInteger(Number(props.productId))
)
function capability(name: string) {
  const map = props.product?.capabilities
  return (
    map !== null &&
    typeof map === 'object' &&
    !Array.isArray(map) &&
    name in map &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(map, name) ?? {}, 'value') &&
    (map as Record<string, unknown>)[name] === true
  )
}
function ownData(value: object, keys: readonly string[]) {
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return key in value && !!descriptor && Object.hasOwn(descriptor, 'value')
  })
}
function text(value: string) {
  return value.replace(/\r\n?/g, '\n').trim()
}
function nullable(value: string | null) {
  return value === null ? null : text(value) || null
}
function validText(value: unknown, minimum: number, maximum: number) {
  return typeof value === 'string' && text(value).length >= minimum && text(value).length <= maximum
}
function validMetadata(value: PrivateProduct | null): value is PrivateProduct {
  return (
    !!value &&
    validText(value.name, 3, 160) &&
    Number.isSafeInteger(value.categoryId) &&
    value.categoryId > 0 &&
    (value.shortDesc === null || typeof value.shortDesc === 'string') &&
    (value.description === null || typeof value.description === 'string') &&
    (value.usage === null || typeof value.usage === 'string') &&
    (value.series === null || typeof value.series === 'string') &&
    typeof value.featured === 'boolean' &&
    Array.isArray(value.badges) &&
    value.badges.length <= 3 &&
    new Set(value.badges).size === value.badges.length &&
    value.badges.every((badge) => typeof badge === 'string' && Object.hasOwn(BADGE_LABELS, badge)) &&
    !!value.visual &&
    typeof value.visual === 'object' &&
    !Array.isArray(value.visual) &&
    Object.keys(value.visual).every((key) => ['type', 'color'].includes(key)) &&
    typeof value.visual.type === 'string' &&
    typeof value.visual.color === 'string' &&
    VISUAL_TYPES.includes(value.visual.type) &&
    /^#[0-9a-f]{6}$/i.test(value.visual.color) &&
    Array.isArray(value.attrs) &&
    value.attrs.length <= 50 &&
    value.attrs.every(
      (attribute) =>
        !!attribute &&
        Object.keys(attribute).every((key) => ['k', 'v'].includes(key)) &&
        validText(attribute.k, 1, 100) &&
        validText(attribute.v, 1, 1000)
    )
  )
}
const readable = computed(
  () =>
    props.runtime === 'cloudflare' &&
    canonicalId.value &&
    props.readStatus === 'success' &&
    !!props.product &&
    ownData(props.product, ['id', 'source', 'uuid', 'catalogVersion', 'status', 'capabilities', ...FIELDS]) &&
    props.product?.source === 'cloudflare' &&
    capability('productDetailRead') &&
    props.product.id === Number(props.productId) &&
    typeof props.product.uuid === 'string' &&
    UUID.test(props.product.uuid) &&
    Number.isSafeInteger(props.product.catalogVersion) &&
    Number(props.product.catalogVersion) >= 1 &&
    ['draft', 'review', 'published', 'hidden', 'discontinued'].includes(props.product.status) &&
    validMetadata(props.product)
)
const authorized = computed(
  () => readable.value && props.product?.status === 'draft' && capability('productMetadataUpdate')
)
const form = reactive<Metadata>({
  name: '',
  categoryId: 0,
  shortDesc: '',
  description: '',
  usage: null,
  series: null,
  featured: false,
  badges: [],
  visual: { type: 'caja', color: '#009ac9' },
  attrs: []
})
const reason = ref('')
const baseline = ref<{ id: number; uuid: string; version: number; metadata: Metadata } | null>(null)
const command = ref<{ id: number; uuid: string; payload: string; key: string; uncertain: boolean } | null>(null)
const saving = ref(false)
const reloading = ref(false)
const blocked = ref(false)
const error = ref('')
const success = ref('')
let generation = 0
function metadata(product: PrivateProduct): Metadata {
  return {
    name: text(product.name),
    categoryId: product.categoryId,
    shortDesc: text(product.shortDesc ?? ''),
    description: text(product.description ?? ''),
    usage: nullable(product.usage),
    series: nullable(product.series),
    featured: product.featured,
    badges: [...product.badges],
    visual: { type: product.visual.type, color: product.visual.color.toLowerCase() },
    attrs: product.attrs.map((attribute) => ({ k: text(attribute.k), v: text(attribute.v) }))
  }
}
function currentMetadata(): Metadata | null {
  if (
    typeof form.name !== 'string' ||
    typeof form.shortDesc !== 'string' ||
    typeof form.description !== 'string' ||
    (form.usage !== null && typeof form.usage !== 'string') ||
    (form.series !== null && typeof form.series !== 'string') ||
    !form.visual ||
    typeof form.visual.type !== 'string' ||
    typeof form.visual.color !== 'string' ||
    !Array.isArray(form.badges) ||
    !Array.isArray(form.attrs) ||
    form.attrs.some((attribute) => !attribute || typeof attribute.k !== 'string' || typeof attribute.v !== 'string')
  )
    return null
  return {
    name: text(form.name),
    categoryId: form.categoryId,
    shortDesc: text(form.shortDesc),
    description: text(form.description),
    usage: nullable(form.usage),
    series: nullable(form.series),
    featured: form.featured,
    badges: [...form.badges],
    visual: { type: form.visual.type, color: form.visual.color.toLowerCase() },
    attrs: form.attrs.map((attribute) => ({ k: text(attribute.k), v: text(attribute.v) }))
  }
}
const dirty = computed(
  () => !baseline.value || JSON.stringify(currentMetadata()) !== JSON.stringify(baseline.value.metadata)
)
const sameProduct = computed(
  () => readable.value && baseline.value?.id === props.product?.id && baseline.value?.uuid === props.product?.uuid
)
const stale = computed(() => sameProduct.value && baseline.value?.version !== props.product?.catalogVersion)
const canPrepare = computed(
  () =>
    authorized.value &&
    sameProduct.value &&
    !stale.value &&
    !blocked.value &&
    !reloading.value &&
    !!baseline.value &&
    props.authorize({ id: baseline.value.id, uuid: baseline.value.uuid, version: baseline.value.version })
)
const canRetry = computed(
  () =>
    authorized.value &&
    sameProduct.value &&
    !!command.value?.uncertain &&
    command.value.id === props.product?.id &&
    command.value.uuid === props.product?.uuid &&
    !blocked.value &&
    !reloading.value &&
    props.authorize({ id: command.value.id, uuid: command.value.uuid })
)
function resetFromProduct() {
  if (!readable.value || !props.product) return false
  const value = metadata(props.product)
  baseline.value = {
    id: props.product.id,
    uuid: props.product.uuid as string,
    version: props.product.catalogVersion as number,
    metadata: structuredClone(value)
  }
  Object.assign(form, value)
  reason.value = ''
  command.value = null
  blocked.value = false
  return true
}
watch(
  () => [props.product, props.readStatus],
  () => {
    if (!baseline.value || (!dirty.value && !command.value && !saving.value)) resetFromProduct()
  },
  { deep: true, immediate: true }
)
function validation(patch: Partial<Metadata>) {
  if (!Object.keys(patch).length) return 'No hay cambios de metadatos para guardar.'
  if (Object.hasOwn(patch, 'name') && !validText(patch.name, 3, 160))
    return 'El nombre debe tener entre 3 y 160 caracteres.'
  if (
    Object.hasOwn(patch, 'categoryId') &&
    (!props.categoriesReady ||
      !Number.isSafeInteger(patch.categoryId) ||
      !props.categories.some((category) => category.value === patch.categoryId))
  )
    return 'Selecciona una familia de la consulta privada autorizada.'
  if (Object.hasOwn(patch, 'shortDesc') && !validText(patch.shortDesc, 5, 500))
    return 'La descripción corta debe tener entre 5 y 500 caracteres.'
  if (Object.hasOwn(patch, 'description') && !validText(patch.description, 5, 10000))
    return 'La descripción completa debe tener entre 5 y 10.000 caracteres.'
  if (Object.hasOwn(patch, 'usage') && patch.usage !== null && !validText(patch.usage, 1, 2000))
    return 'El modo de empleo admite hasta 2.000 caracteres.'
  if (Object.hasOwn(patch, 'series') && patch.series !== null && !validText(patch.series, 1, 160))
    return 'La gama admite hasta 160 caracteres.'
  if (Object.hasOwn(patch, 'featured') && typeof patch.featured !== 'boolean')
    return 'El campo destacado debe ser verdadero o falso.'
  if (
    patch.badges &&
    (patch.badges.length > 3 ||
      new Set(patch.badges).size !== patch.badges.length ||
      patch.badges.some((badge) => typeof badge !== 'string' || !Object.hasOwn(BADGE_LABELS, badge)))
  )
    return 'Revisa los sellos permitidos, sin duplicados.'
  if (
    patch.visual &&
    (Object.keys(patch.visual).some((key) => !['type', 'color'].includes(key)) ||
      !VISUAL_TYPES.includes(patch.visual.type) ||
      !/^#[0-9a-f]{6}$/i.test(patch.visual.color))
  )
    return 'Selecciona un envase válido y un color hexadecimal de seis cifras.'
  if (
    patch.attrs &&
    (patch.attrs.length > 50 ||
      patch.attrs.some(
        (attribute) =>
          Object.keys(attribute).some((key) => !['k', 'v'].includes(key)) ||
          !validText(attribute.k, 1, 100) ||
          !validText(attribute.v, 1, 1000)
      ))
  )
    return 'Las características admiten hasta 50 pares: nombre de 1 a 100 y valor de 1 a 1.000 caracteres.'
  return ''
}
function mutable() {
  return canPrepare.value && !saving.value && !command.value?.uncertain
}
function toggleBadge(badge: string) {
  if (!mutable() || !Object.hasOwn(BADGE_LABELS, badge)) return
  form.badges = form.badges.includes(badge) ? form.badges.filter((value) => value !== badge) : [...form.badges, badge]
}
function addAttribute() {
  if (mutable() && form.attrs.length < 50) form.attrs.push({ k: '', v: '' })
}
function removeAttribute(index: number) {
  if (mutable() && Number.isSafeInteger(index) && index >= 0) form.attrs.splice(index, 1)
}
function moveAttribute(index: number, direction: number) {
  if (!mutable() || !Number.isSafeInteger(index) || ![-1, 1].includes(direction)) return
  const target = index + direction
  if (!form.attrs[index] || !form.attrs[target]) return
  const value = form.attrs[index]!
  form.attrs[index] = form.attrs[target]!
  form.attrs[target] = value
}
const ERROR_MESSAGES: Record<string, string> = {
  conflict: 'No se ha podido aplicar este cambio. Consulta de nuevo antes de preparar otro; no se ha sobrescrito.',
  csrf_rejected: 'El origen de la petición no está autorizado. Recarga el panel desde su dirección correcta.',
  version_conflict: 'El borrador ha cambiado. Consulta de nuevo antes de preparar otro cambio; no se ha sobrescrito.',
  idempotency_conflict:
    'La clave de este cambio no coincide con el comando registrado. Consulta de nuevo; no lo repitas con otra clave.',
  product_not_editable:
    'El producto ya no es un borrador editable. Consulta su estado; este editor no publica productos.',
  forbidden: 'Ya no tienes permiso para editar estos metadatos. Consulta de nuevo o revisa tu acceso.',
  mfa_required: 'Necesitas verificar el segundo factor antes de editar. Después, consulta de nuevo.',
  unauthenticated: 'Tu sesión no permite confirmar este cambio. Inicia sesión y consulta de nuevo.',
  email_unverified: 'Verifica tu correo antes de editar. Después, consulta de nuevo.',
  invalid_input: 'El servidor ha rechazado los datos. Revisa los campos y el motivo del cambio.',
  body_too_large: 'El cambio supera el tamaño permitido. Reduce los textos o las características antes de enviarlo.',
  rate_limited:
    'Hay demasiados intentos. Espera antes de reintentar este mismo cambio; no se ha guardado en este intento.',
  invalid_origin: 'El origen de la petición no está autorizado. Recarga el panel desde su dirección correcta.',
  origin_mismatch: 'El origen de la petición no está autorizado. Recarga el panel desde su dirección correcta.',
  not_found: 'El producto ya no está disponible. Consulta de nuevo antes de editar.',
  category_not_found: 'La familia seleccionada ya no está disponible. Consulta de nuevo antes de cambiarla.'
}
async function dispatch(pending: NonNullable<typeof command.value>) {
  if (saving.value || !authorized.value || !sameProduct.value || typeof window === 'undefined') return
  const body = JSON.parse(pending.payload) as Record<string, unknown>
  if (
    pending.id !== props.product?.id ||
    pending.uuid !== props.product.uuid ||
    Object.keys(body).some(
      (key) => key !== 'expectedVersion' && key !== 'reason' && !FIELDS.includes(key as (typeof FIELDS)[number])
    ) ||
    !Number.isSafeInteger(body.expectedVersion) ||
    Number(body.expectedVersion) < 1 ||
    !validText(body.reason, 3, 500) ||
    !props.authorize({
      id: pending.id,
      uuid: pending.uuid,
      ...(pending.uncertain ? {} : { version: Number(body.expectedVersion) })
    })
  )
    return
  saving.value = true
  error.value = ''
  success.value = ''
  const request = ++generation
  try {
    const result = await $fetch<{
      source: unknown
      productId: unknown
      productUuid: unknown
      catalogVersion: unknown
      updated: unknown
    }>(`/api/admin/products/${pending.id}`, {
      method: 'PUT',
      body,
      headers: { Origin: window.location.origin, 'Idempotency-Key': pending.key }
    })
    if (request !== generation) return
    if (
      !result ||
      !ownData(result, ['source', 'productId', 'productUuid', 'catalogVersion', 'updated']) ||
      result.source !== 'cloudflare' ||
      result.productId !== pending.id ||
      result.productUuid !== pending.uuid ||
      result.updated !== true ||
      !Number.isSafeInteger(result.catalogVersion) ||
      result.catalogVersion !== Number(body.expectedVersion) + 1
    )
      throw new Error('unconfirmed_result')
    success.value = 'Metadatos guardados en el borrador. El producto no se ha publicado.'
    command.value = null
    blocked.value = true
    try {
      await props.refreshProduct()
      await nextTick()
      if (
        request === generation &&
        readable.value &&
        Number(props.product?.catalogVersion) >= Number(result.catalogVersion)
      )
        resetFromProduct()
    } catch {
      error.value =
        'El cambio está guardado, pero no se ha podido actualizar la consulta. Consulta de nuevo antes de otro cambio.'
    }
  } catch (cause) {
    if (request !== generation) return
    const code =
      (cause as { data?: { error?: { code?: unknown } }; error?: { code?: unknown } })?.data?.error?.code ??
      (cause as { error?: { code?: unknown } })?.error?.code
    if (typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code)) {
      error.value = ERROR_MESSAGES[code]!
      pending.uncertain = false
      blocked.value = !['invalid_input', 'body_too_large', 'rate_limited'].includes(code)
    } else {
      pending.uncertain = true
      error.value =
        'No podemos confirmar si el cambio se guardó. Reintenta el mismo cambio con su misma clave o consulta de nuevo.'
    }
  } finally {
    if (request === generation) saving.value = false
  }
}
async function saveMetadata() {
  if (!mutable() || !baseline.value) return
  const value = currentMetadata()
  if (!value) {
    error.value = 'Revisa el formato de los metadatos.'
    return
  }
  const patch: Partial<Metadata> = {}
  for (const field of FIELDS)
    if (JSON.stringify(value[field]) !== JSON.stringify(baseline.value.metadata[field]))
      Object.assign(patch, { [field]: value[field] })
  error.value = validation(patch)
  if (!error.value && !validText(reason.value, 3, 500))
    error.value = 'Explica el motivo del cambio con entre 3 y 500 caracteres.'
  if (error.value) return
  const payload = JSON.stringify({ expectedVersion: baseline.value.version, reason: text(reason.value), ...patch })
  if (command.value?.payload !== payload)
    command.value = { id: baseline.value.id, uuid: baseline.value.uuid, payload, key: randomId(), uncertain: false }
  await dispatch(command.value!)
}
async function retry() {
  if (canRetry.value && command.value) await dispatch(command.value)
}
async function reload() {
  if (saving.value || reloading.value || props.runtime !== 'cloudflare' || !canonicalId.value) return
  reloading.value = true
  try {
    await props.refreshProduct()
    await nextTick()
    if (!resetFromProduct())
      error.value = 'No se ha podido confirmar una consulta privada válida. Tus cambios no se han vuelto a enviar.'
    else {
      error.value = ''
      success.value = ''
    }
  } catch {
    error.value = 'No se ha podido actualizar la consulta. Tus cambios no se han vuelto a enviar.'
  } finally {
    reloading.value = false
  }
}
onBeforeUnmount(() => {
  ++generation
})
</script>

<template>
  <section
    class="mb-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
    aria-labelledby="draft-metadata-title"
    data-draft-metadata-editor
  >
    <h2 id="draft-metadata-title" class="font-bold text-[var(--text-strong)]">Editar metadatos del borrador</h2>
    <p class="mt-1 text-sm text-[var(--text-muted)]">
      Esta edición no publica el producto ni cambia marca, imágenes, variantes, precios, stock o datos regulatorios.
    </p>
    <p v-if="!authorized" role="status" class="mt-3 text-sm">
      Edición de metadatos no disponible: se necesita un borrador, una consulta privada válida y permiso explícito.
    </p>
    <p v-if="stale" role="alert" class="mt-3 text-sm">
      Hay una versión más reciente. Consulta de nuevo antes de preparar otro cambio.
    </p>
    <p v-if="error" id="draft-metadata-error" role="alert" class="mt-3 text-sm text-red-700">{{ error }}</p>
    <p v-if="success" role="status" class="mt-3 text-sm text-green-700">{{ success }}</p>
    <form
      v-if="readable && authorized"
      id="draft-metadata-form"
      class="mt-4 space-y-4"
      :aria-busy="saving || reloading"
      @submit.prevent="saveMetadata"
    >
      <fieldset :disabled="!canPrepare || saving || command?.uncertain" class="grid min-w-0 gap-4 sm:grid-cols-2">
        <label class="sm:col-span-2" for="draft-name"
          >Nombre<input id="draft-name" v-model="form.name" class="draft-field" minlength="3" maxlength="160" required
        /></label>
        <label for="draft-category"
          >Familia<select
            id="draft-category"
            v-model.number="form.categoryId"
            class="draft-field"
            :disabled="!categoriesReady"
          >
            <option v-if="!categories.some((category) => category.value === form.categoryId)" :value="form.categoryId">
              Familia actual (consulta no disponible)
            </option>
            <option v-for="category in categories" :key="category.value" :value="category.value">
              {{ category.label }}
            </option></select
          ><span v-if="!categoriesReady" class="text-xs"
            >No se pueden cambiar familias sin su consulta privada autorizada.</span
          ></label
        >
        <label for="draft-series"
          >Gama (opcional)<input id="draft-series" v-model="form.series" class="draft-field" maxlength="160"
        /></label>
        <label class="sm:col-span-2" for="draft-short"
          >Descripción corta<textarea
            id="draft-short"
            v-model="form.shortDesc"
            class="draft-field"
            rows="2"
            minlength="5"
            maxlength="500"
          />
        </label>
        <label class="sm:col-span-2" for="draft-description"
          >Descripción completa<textarea
            id="draft-description"
            v-model="form.description"
            class="draft-field"
            rows="5"
            minlength="5"
            maxlength="10000"
          />
        </label>
        <label class="sm:col-span-2" for="draft-usage"
          >Modo de empleo (opcional)<textarea
            id="draft-usage"
            v-model="form.usage"
            class="draft-field"
            rows="3"
            maxlength="2000"
          />
        </label>
        <label class="flex items-center gap-2"><input v-model="form.featured" type="checkbox" /> Destacado</label>
        <div>
          <p>Sellos</p>
          <label v-for="(label, badge) in BADGE_LABELS" :key="badge" class="mr-3 inline-flex items-center gap-1"
            ><input type="checkbox" :checked="form.badges.includes(badge)" @change="toggleBadge(badge)" />{{
              label
            }}</label
          >
        </div>
        <label for="draft-visual-type"
          >Envase provisional<select id="draft-visual-type" v-model="form.visual.type" class="draft-field">
            <option v-for="type in VISUAL_TYPES" :key="type" :value="type">{{ ENVASE_LABELS[type] ?? type }}</option>
          </select></label
        >
        <label for="draft-visual-color"
          >Color hexadecimal<input
            id="draft-visual-color"
            v-model="form.visual.color"
            class="draft-field"
            pattern="#[0-9a-fA-F]{6}"
            maxlength="7"
        /></label>
        <div class="space-y-2 sm:col-span-2">
          <p>Características técnicas (hasta 50, en este orden)</p>
          <div
            v-for="(attribute, index) in form.attrs"
            :key="index"
            class="flex flex-wrap items-end gap-2"
            data-draft-attribute
          >
            <label :for="`draft-attribute-name-${index}`" class="min-w-0 flex-1"
              >Nombre {{ index + 1
              }}<input
                :id="`draft-attribute-name-${index}`"
                v-model="attribute.k"
                class="draft-field"
                minlength="1"
                maxlength="100"
                required
            /></label>
            <label :for="`draft-attribute-value-${index}`" class="min-w-0 flex-1"
              >Valor {{ index + 1
              }}<input
                :id="`draft-attribute-value-${index}`"
                v-model="attribute.v"
                class="draft-field"
                minlength="1"
                maxlength="1000"
                required
            /></label>
            <UButton
              type="button"
              :disabled="index === 0"
              :aria-label="`Subir característica ${index + 1}`"
              @click="moveAttribute(index, -1)"
              >Subir</UButton
            >
            <UButton
              type="button"
              :disabled="index === form.attrs.length - 1"
              :aria-label="`Bajar característica ${index + 1}`"
              @click="moveAttribute(index, 1)"
              >Bajar</UButton
            >
            <UButton type="button" :aria-label="`Quitar característica ${index + 1}`" @click="removeAttribute(index)"
              >Quitar</UButton
            >
          </div>
          <UButton type="button" :disabled="form.attrs.length >= 50" @click="addAttribute"
            >Añadir característica</UButton
          >
        </div>
        <label class="sm:col-span-2" for="draft-reason"
          >Motivo del cambio<textarea
            id="draft-reason"
            v-model="reason"
            class="draft-field"
            minlength="3"
            maxlength="500"
            rows="2"
            required
          />
        </label>
      </fieldset>
      <UButton
        v-if="!command?.uncertain"
        type="submit"
        :disabled="!canPrepare || !dirty"
        :loading="saving"
        :aria-describedby="error ? 'draft-metadata-error' : undefined"
        >Guardar metadatos del borrador</UButton
      >
    </form>
    <div class="mt-4 flex flex-wrap gap-2">
      <UButton v-if="command?.uncertain" :disabled="!canRetry" :loading="saving" @click="retry"
        >Reintentar el mismo cambio</UButton
      >
      <UButton
        :disabled="saving || props.runtime !== 'cloudflare' || !canonicalId"
        :loading="reloading"
        color="neutral"
        variant="outline"
        @click="reload"
        >Consultar de nuevo y descartar cambios</UButton
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
