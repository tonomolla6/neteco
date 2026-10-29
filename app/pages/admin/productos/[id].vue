<script setup lang="ts">
import type { AdminProductDetail } from '~~/shared/types/admin'
import type { CategoryResponse } from '~~/shared/types/catalog'
import DraftProductMetadataEditor from '~/components/DraftProductMetadataEditor.vue'
import TypedProductAttributesEditor from '~/components/TypedProductAttributesEditor.vue'
import CatalogPublicationReadiness from '~/components/CatalogPublicationReadiness.vue'
import ProductStatusEditor from '~/components/ProductStatusEditor.vue'
import ProductRelationsEditor from '~/components/ProductRelationsEditor.vue'
import ProductPublicationPolicyEditor from '~/components/ProductPublicationPolicyEditor.vue'
import DraftProductCreate from '~/components/DraftProductCreate.vue'
import DraftProductVariantsEditor from '~/components/DraftProductVariantsEditor.vue'
import { catalogDraftAuthoringOptionsSchema } from '~~/shared/catalog-draft-authoring-options'
import {
  catalogActionAvailable,
  type CatalogAction,
  type CatalogCapabilitiesMetadata
} from '~/utils/catalogCapabilities'

definePageMeta({ layout: 'admin', middleware: 'admin', key: (route) => String(route.params.id) })

const route = useRoute()
const id = String(route.params.id)
const isNew = id === 'nuevo'
const runtimeConfig = useRuntimeConfig()
const runtime = computed(() => runtimeConfig.public.serverRuntime)
const cloudflare = computed(() => runtime.value === 'cloudflare')
const node = computed(() => runtime.value === 'node')
const supportedRuntime = computed(() => cloudflare.value || node.value)
const { ready: sessionReady, loggedIn, user } = useUserSession()
function localDraftAuthority() {
  return (
    sessionReady.value === true &&
    loggedIn.value === true &&
    user.value?.role === 'admin' &&
    user.value.mfaVerified === true
  )
}
const canonicalId = /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id))
type DetailResponse = AdminProductDetail &
  CatalogCapabilitiesMetadata & {
    source?: unknown
    uuid?: unknown
    catalogVersion?: unknown
    authoring?: unknown
  }
type CategoryPayload = CategoryResponse & CatalogCapabilitiesMetadata & { source?: unknown }
function ownCapability(value: { capabilities?: unknown } | null | undefined, key: string) {
  const map = value?.capabilities
  return (
    map !== null &&
    typeof map === 'object' &&
    !Array.isArray(map) &&
    key in map &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(map, key) ?? {}, 'value') &&
    Object.hasOwn(map, key) &&
    (map as Record<string, unknown>)[key] === true
  )
}
function nodeAction(value: DetailResponse | CategoryPayload | null | undefined, action: CatalogAction) {
  if (!node.value || !value || value.source !== undefined) return false
  return 'capabilities' in value ? ownCapability(value, action) : catalogActionAvailable(value, action, false)
}
useSeoMeta({ title: isNew ? 'Nuevo producto · Admin' : 'Editar producto · Admin' })

const { data: catData, status: categoryStatus } = await useFetch<CategoryPayload>(
  node.value ? '/api/categories' : '/api/admin/categories',
  {
    key: node.value ? 'categories' : 'admin-product-category-options',
    immediate: supportedRuntime.value,
    server: supportedRuntime.value
  }
)
const validCategories = computed(() => {
  if (!Array.isArray(catData.value?.roots) || !Array.isArray(catData.value.flat)) return false
  const pending = catData.value.roots.map((entry) => ({ entry, parent: null as number | null }))
  const seen = new Set<number>()
  while (pending.length) {
    const { entry, parent } = pending.pop()!
    if (
      !entry ||
      !Number.isSafeInteger(entry.id) ||
      entry.id < 1 ||
      seen.has(entry.id) ||
      typeof entry.name !== 'string' ||
      !entry.name.trim() ||
      !Array.isArray(entry.children) ||
      (cloudflare.value && entry.parentId !== parent)
    )
      return false
    seen.add(entry.id)
    for (const child of entry.children) pending.push({ entry: child, parent: entry.id })
  }
  return true
})
const canReadCategories = computed(
  () =>
    supportedRuntime.value &&
    categoryStatus.value === 'success' &&
    validCategories.value &&
    (node.value
      ? catData.value?.source === undefined
      : catData.value?.source === 'cloudflare' && ownCapability(catData.value, 'categoriesRead'))
)
const catOptions = computed(() => flattenCategoryTree(canReadCategories.value ? catData.value!.roots : []))
const familiaItems = computed(() => catOptions.value.map((c) => ({ label: c.label, value: c.id })))
const {
  data: authoringOptions,
  status: authoringOptionsStatus,
  refresh: refreshAuthoringOptions
} = await useFetch<unknown>('/api/admin/products/authoring-options', {
  key: 'admin-catalog-draft-authoring-options',
  immediate: cloudflare.value,
  server: cloudflare.value
})
function privateDraftCreateAuthority() {
  if (!cloudflare.value || !isNew || !localDraftAuthority() || authoringOptionsStatus.value !== 'success') return false
  const parsed = catalogDraftAuthoringOptionsSchema.safeParse(authoringOptions.value)
  return parsed.success && parsed.data.capabilities.productDraftCreate
}
async function reloadAuthoringOptions() {
  if (!cloudflare.value || !localDraftAuthority() || authoringOptionsStatus.value === 'pending') return
  await refreshAuthoringOptions()
}
async function openCreatedDraft(identity: { id: number; uuid: string }) {
  if (!privateDraftCreateAuthority() || !Number.isSafeInteger(identity.id) || identity.id < 1)
    throw new Error('draft_creation_authority_unavailable')
  await navigateTo(`/admin/productos/${identity.id}`)
}

// `useFetch` y no `useAsyncData(() => $fetch(...))`: el `$fetch` crudo no reenvía la
// cookie de sesión durante el SSR, así que la API respondía 401 y esta página convertía
// ese 401 en un 404 fatal. Efecto: ningún producto se podía abrir desde el panel.
const {
  data: existing,
  error: existingError,
  status: existingStatus,
  refresh: refreshExisting
} = isNew
  ? { data: ref<DetailResponse | null>(null), error: ref(null), status: ref('idle'), refresh: async () => undefined }
  : await useFetch<DetailResponse>(`/api/admin/products/${id}`, {
      key: `admin-product-${id}`,
      immediate: supportedRuntime.value && (node.value || canonicalId),
      server: supportedRuntime.value && (node.value || canonicalId)
    })
const validDetail = computed(() => {
  const product = existing.value
  return (
    !!product &&
    typeof product.name === 'string' &&
    typeof product.brand === 'string' &&
    typeof product.slug === 'string' &&
    !!product.visual &&
    typeof product.visual.type === 'string' &&
    typeof product.visual.color === 'string' &&
    Array.isArray(product.badges) &&
    product.badges.every((badge) => typeof badge === 'string') &&
    Array.isArray(product.attrs) &&
    product.attrs.every(
      (attribute) => !!attribute && typeof attribute.k === 'string' && typeof attribute.v === 'string'
    ) &&
    Array.isArray(product.variants) &&
    product.variants.every((variant) => !!variant && Number.isSafeInteger(variant.id) && variant.id > 0)
  )
})
const canReadDetail = computed(
  () =>
    supportedRuntime.value &&
    existingStatus.value === 'success' &&
    validDetail.value &&
    (node.value
      ? existing.value?.source === undefined
      : canonicalId &&
        existing.value?.id === Number(id) &&
        existing.value.source === 'cloudflare' &&
        ownCapability(existing.value, 'productDetailRead'))
)
const canWrite = computed(
  () =>
    (isNew ? canReadCategories.value : canReadDetail.value) &&
    nodeAction(isNew ? catData.value : existing.value, isNew ? 'productCreate' : 'productUpdate')
)
const canDelete = computed(() => !isNew && canReadDetail.value && nodeAction(existing.value, 'productDelete'))

if (node.value && !isNew && !existing.value) {
  const statusCode = (existingError.value as { statusCode?: number } | null)?.statusCode ?? 404
  throw createError({
    statusCode,
    statusMessage:
      statusCode === 403 ? 'Necesitas la verificación en dos pasos para gestionar productos' : 'Producto no encontrado',
    fatal: true
  })
}

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

// El desplegable enseñaba el valor crudo —«capsulas», «rollo»—; `ENVASE_LABELS` ya
// tiene el nombre que se usa en los filtros de la tienda.
const envaseItems = VISUAL_TYPES.map((tipo) => ({ label: ENVASE_LABELS[tipo] ?? tipo, value: tipo }))

const product = canReadDetail.value ? existing.value : null
const form = reactive({
  name: product?.name ?? '',
  brand: product?.brand ?? '',
  categoryId: product?.categoryId ?? null,
  shortDesc: product?.shortDesc ?? '',
  description: product?.description ?? '',
  usage: product?.usage ?? '',
  badges: [...(product?.badges ?? [])] as string[],
  visual: { type: product?.visual.type ?? 'caja', color: product?.visual.color ?? '#009ac9' },
  featured: !!product?.featured,
  active: product?.status === 'published',
  series: product?.series ?? '',
  image: product?.image ?? '',
  imageAlt: product?.imageAlt ?? '',
  imageRightsOwner: product?.imageRightsOwner ?? '',
  imageRightsLicense: product?.imageRightsLicense ?? '',
  imageAuthorizedAt: product?.imageAuthorizedAt ?? '',
  attrs: (product?.attrs ?? []).map((attribute) => ({ k: attribute.k, v: attribute.v })),
  variants: (product?.variants ?? []).map((variant) => ({
    id: variant.id,
    format: variant.format,
    sku: variant.sku,
    ean: variant.ean ?? '',
    gtin: variant.gtin ?? '',
    mpn: variant.mpn ?? '',
    identifierExceptionReason: variant.identifierExceptionReason ?? '',
    price: variant.price / 100,
    stock: variant.stock,
    color: variant.color ?? '',
    image: variant.image ?? '',
    unitBase: variant.unitBase,
    unitLabel: variant.unitLabel,
    contentQuantity: variant.units,
    unitsPerCase: variant.unitsPerCase,
    casesPerPallet: variant.casesPerPallet,
    minimumQuantity: variant.minimumQuantity,
    quantityIncrement: variant.quantityIncrement,
    maximumQuantity: variant.maximumQuantity,
    weightGrams: variant.weightGrams,
    widthMm: variant.widthMm,
    heightMm: variant.heightMm,
    depthMm: variant.depthMm,
    safetyStock: variant.safetyStock,
    backorderAllowed: variant.backorderAllowed,
    leadTimeDays: variant.leadTimeDays
  })) as Array<{
    id?: number
    format: string
    sku: string
    ean: string
    gtin: string
    mpn: string
    identifierExceptionReason: string
    price: number | null
    stock: number
    color: string
    image: string
    unitBase: string
    unitLabel: string
    contentQuantity: number
    unitsPerCase: number
    casesPerPallet: number | null
    minimumQuantity: number
    quantityIncrement: number
    maximumQuantity: number | null
    weightGrams: number
    widthMm: number
    heightMm: number
    depthMm: number
    safetyStock: number
    backorderAllowed: boolean
    leadTimeDays: number | null
  }>
})
const emptyVariant = () => ({
  format: '',
  sku: '',
  ean: '',
  gtin: '',
  mpn: '',
  identifierExceptionReason: '',
  price: null,
  stock: 100,
  color: '',
  image: '',
  unitBase: 'unit',
  unitLabel: 'unidad',
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
  safetyStock: 0,
  backorderAllowed: false,
  leadTimeDays: null
})
if (!form.variants.length && canWrite.value) form.variants.push(emptyVariant())

function toggleBadge(b: string) {
  if (!canWrite.value || saving.value) return
  form.badges = form.badges.includes(b) ? form.badges.filter((x) => x !== b) : [...form.badges, b]
}
function addVariant() {
  if (!canWrite.value || saving.value) return
  form.variants.push(emptyVariant())
  // Una variante recién añadida se abre: si no, se añade una fila plegada y vacía que
  // parece que no ha pasado nada.
  openVariants.value = new Set([...openVariants.value, form.variants.length - 1])
}
function removeVariant(i: number) {
  if (!canWrite.value || saving.value) return
  form.variants.splice(i, 1)
}
function addAttr() {
  if (!canWrite.value || saving.value) return
  form.attrs.push({ k: '', v: '' })
}
function removeAttr(index: number) {
  if (!canWrite.value || saving.value) return
  form.attrs.splice(index, 1)
}
function moveAttr(i: number, dir: number) {
  if (!canWrite.value || saving.value) return
  const j = i + dir
  if (j < 0 || j >= form.attrs.length) return
  const current = form.attrs[i]
  const target = form.attrs[j]
  if (!current || !target) return
  form.attrs[i] = target
  form.attrs[j] = current
}

const toast = useToast()
/** El estado editorial se mostraba con el valor crudo de la base (`draft`, `published`). */
const STATUS_LABELS: Record<string, { label: string; color: 'neutral' | 'warning' | 'success' | 'error' }> = {
  draft: { label: 'Borrador', color: 'neutral' },
  review: { label: 'En revisión', color: 'warning' },
  published: { label: 'Publicado', color: 'success' },
  hidden: { label: 'Oculto', color: 'neutral' },
  discontinued: { label: 'Descatalogado', color: 'error' }
}
const STATUS_META = computed(() =>
  isNew && node.value
    ? STATUS_LABELS.draft!
    : canReadDetail.value && Object.hasOwn(STATUS_LABELS, existing.value?.status ?? '')
      ? STATUS_LABELS[existing.value!.status]!
      : { label: 'Estado no disponible', color: 'neutral' as const }
)

/** En un producto nuevo la única variante se abre sola; al editar, todas empiezan plegadas. */
const openVariants = ref(new Set<number>(!canWrite.value ? form.variants.map((_, index) => index) : isNew ? [0] : []))
function toggleVariant(index: number) {
  const next = new Set(openVariants.value)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  openVariants.value = next
}

const saving = ref(false)
watch(
  [existing, existingStatus],
  () => {
    if (!cloudflare.value || !canReadDetail.value || !existing.value) return
    const product = existing.value
    Object.assign(form, {
      name: product.name,
      categoryId: product.categoryId,
      shortDesc: product.shortDesc ?? '',
      description: product.description ?? '',
      usage: product.usage ?? '',
      series: product.series ?? '',
      badges: [...product.badges],
      visual: { ...product.visual },
      featured: product.featured,
      active: product.status === 'published',
      attrs: product.attrs.map((attribute) => ({ k: attribute.k, v: attribute.v }))
    })
  },
  { deep: true }
)
async function reloadPrivateProduct() {
  if (!cloudflare.value || isNew || !canonicalId || existingStatus.value === 'pending') return
  await refreshExisting()
}
async function reloadDraftProduct() {
  if (!localDraftAuthority()) return
  await reloadPrivateProduct()
}
function privateMetadataAuthority(identity: { id: number; uuid: string; version?: number }) {
  const product = existing.value
  return (
    cloudflare.value &&
    canReadDetail.value &&
    !!product &&
    product.id === identity.id &&
    product.uuid === identity.uuid &&
    product.status === 'draft' &&
    ownCapability(product, 'productMetadataUpdate') &&
    ['id', 'uuid', 'source', 'status', 'catalogVersion'].every(
      (key) => key in product && Object.hasOwn(Object.getOwnPropertyDescriptor(product, key) ?? {}, 'value')
    ) &&
    Number.isSafeInteger(product.catalogVersion) &&
    Number(product.catalogVersion) >= 1 &&
    (identity.version === undefined || product.catalogVersion === identity.version)
  )
}

const readinessIdentity = computed(() => {
  const product = existing.value
  if (
    !cloudflare.value ||
    isNew ||
    !canonicalId ||
    !canReadDetail.value ||
    !product ||
    !['id', 'uuid', 'source', 'catalogVersion', 'capabilities'].every(
      (key) => key in product && Object.hasOwn(Object.getOwnPropertyDescriptor(product, key) ?? {}, 'value')
    ) ||
    !ownCapability(product, 'productReadinessRead') ||
    typeof product.uuid !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(product.uuid) ||
    typeof product.catalogVersion !== 'number' ||
    !Number.isSafeInteger(product.catalogVersion) ||
    product.catalogVersion < 1
  )
    return null
  return { id: product.id, uuid: product.uuid, version: product.catalogVersion }
})
function privateReadinessAuthority(identity: { id: number; uuid: string; version: number }) {
  const current = readinessIdentity.value
  return (
    !!current && current.id === identity.id && current.uuid === identity.uuid && current.version === identity.version
  )
}
function privateDraftAuthority(identity: { id: number; uuid: string; version: number }) {
  const product = existing.value
  return (
    cloudflare.value &&
    localDraftAuthority() &&
    !isNew &&
    canonicalId &&
    canReadDetail.value &&
    !!product &&
    ['id', 'uuid', 'source', 'status', 'catalogVersion', 'capabilities', 'authoring'].every((key) =>
      Object.hasOwn(Object.getOwnPropertyDescriptor(product, key) ?? {}, 'value')
    ) &&
    product.source === 'cloudflare' &&
    ownCapability(product, 'productDetailRead') &&
    ['draft', 'review', 'published', 'hidden', 'discontinued'].includes(product.status) &&
    typeof product.uuid === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(product.uuid) &&
    typeof product.catalogVersion === 'number' &&
    Number.isSafeInteger(product.catalogVersion) &&
    product.catalogVersion >= 1 &&
    product.id === identity.id &&
    product.id === Number(id) &&
    product.uuid === identity.uuid &&
    product.catalogVersion === identity.version
  )
}

function privateStatusAuthority(identity: { id: number; uuid: string; version?: number; status?: string }) {
  const product = existing.value
  return (
    cloudflare.value &&
    canReadDetail.value &&
    !!product &&
    ['id', 'uuid', 'source', 'status', 'catalogVersion', 'capabilities'].every(
      (key) => key in product && Object.hasOwn(Object.getOwnPropertyDescriptor(product, key) ?? {}, 'value')
    ) &&
    ownCapability(product, 'productStatusTransition') &&
    product.id === identity.id &&
    product.uuid === identity.uuid &&
    typeof product.uuid === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(product.uuid) &&
    typeof product.catalogVersion === 'number' &&
    Number.isSafeInteger(product.catalogVersion) &&
    product.catalogVersion >= 1 &&
    ['draft', 'review', 'published', 'hidden', 'discontinued'].includes(product.status) &&
    (identity.version === undefined || product.catalogVersion === identity.version) &&
    (identity.status === undefined || product.status === identity.status)
  )
}
async function reloadStatusReadiness() {
  const identity = readinessIdentity.value
  if (!identity || !privateReadinessAuthority(identity)) return
  await refreshNuxtData(`admin-product-publication-readiness-${id}-${identity.uuid}-${identity.version}`)
}

const publicationPolicyIdentity = computed(() => {
  const product = existing.value
  if (
    !cloudflare.value ||
    isNew ||
    !canonicalId ||
    existingStatus.value !== 'success' ||
    !product ||
    !['id', 'uuid', 'source', 'status', 'catalogVersion', 'capabilities'].every((key) =>
      Object.hasOwn(Object.getOwnPropertyDescriptor(product, key) ?? {}, 'value')
    ) ||
    !canReadDetail.value ||
    product.source !== 'cloudflare' ||
    product.id !== Number(id) ||
    !ownCapability(product, 'productDetailRead') ||
    !ownCapability(product, 'productPublicationPolicyRead') ||
    typeof product.uuid !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(product.uuid) ||
    typeof product.catalogVersion !== 'number' ||
    !Number.isSafeInteger(product.catalogVersion) ||
    product.catalogVersion < 1 ||
    !['draft', 'review', 'published', 'hidden', 'discontinued'].includes(product.status)
  )
    return null
  return { id: product.id, uuid: product.uuid, version: product.catalogVersion, status: product.status }
})
function privatePublicationPolicyAuthority(identity: { id: number; uuid: string; version?: number; status?: string }) {
  const current = publicationPolicyIdentity.value
  return (
    !!current &&
    current.id === identity.id &&
    current.uuid === identity.uuid &&
    (identity.version === undefined || current.version === identity.version) &&
    (identity.status === undefined || current.status === identity.status)
  )
}
// Retain only the mounted identity across a GET, never its read/write authority.
// Otherwise an explicit refresh would discard an unresolved idempotent command.
const publicationPolicyMountIdentity = ref<{ id: number; uuid: string } | null>(null)
watch(
  [publicationPolicyIdentity, runtime, existing],
  () => {
    const current = publicationPolicyIdentity.value
    if (current) publicationPolicyMountIdentity.value = { id: current.id, uuid: current.uuid }
    else if (
      !cloudflare.value ||
      !existing.value ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(existing.value, 'uuid') ?? {}, 'value') ||
      existing.value.uuid !== publicationPolicyMountIdentity.value?.uuid
    )
      publicationPolicyMountIdentity.value = null
  },
  { immediate: true, deep: true }
)

async function save() {
  if (!canWrite.value || saving.value) return
  saving.value = true
  try {
    const payload = {
      name: form.name,
      brand: form.brand,
      categoryId: Number(form.categoryId),
      shortDesc: form.shortDesc,
      description: form.description,
      usage: form.usage || null,
      badges: form.badges,
      visual: form.visual,
      featured: form.featured,
      active: form.active,
      image: form.image || null,
      imageAlt: form.imageAlt || null,
      imageRightsOwner: form.imageRightsOwner || null,
      imageRightsLicense: form.imageRightsLicense || null,
      imageAuthorizedAt: form.imageAuthorizedAt || null,
      series: form.series || null,
      attrs: form.attrs.filter((a) => a.k.trim() && a.v.trim()),
      variants: form.variants.map((v) => ({
        ...(v.id != null ? { id: v.id } : {}),
        format: v.format,
        sku: v.sku || null,
        ean: v.ean || null,
        gtin: v.gtin || null,
        mpn: v.mpn || null,
        identifierExceptionReason: v.identifierExceptionReason || null,
        price: Number(v.price),
        stock: Number(v.stock),
        color: v.color || null,
        image: v.image || null,
        unitBase: v.unitBase,
        unitLabel: v.unitLabel,
        contentQuantity: Number(v.contentQuantity),
        unitsPerCase: Number(v.unitsPerCase),
        casesPerPallet: v.casesPerPallet == null ? null : Number(v.casesPerPallet),
        minimumQuantity: Number(v.minimumQuantity),
        quantityIncrement: Number(v.quantityIncrement),
        maximumQuantity: v.maximumQuantity == null ? null : Number(v.maximumQuantity),
        weightGrams: Number(v.weightGrams),
        widthMm: Number(v.widthMm),
        heightMm: Number(v.heightMm),
        depthMm: Number(v.depthMm),
        safetyStock: Number(v.safetyStock),
        backorderAllowed: v.backorderAllowed,
        leadTimeDays: v.leadTimeDays == null ? null : Number(v.leadTimeDays)
      }))
    }
    if (isNew) await $fetch('/api/admin/products', { method: 'POST', body: payload })
    else await $fetch(`/api/admin/products/${id}`, { method: 'PUT', body: payload })
    toast.add({ title: isNew ? 'Producto creado' : 'Cambios guardados', icon: 'i-lucide-check', color: 'success' })
    refreshNuxtData('categories')
    navigateTo('/admin/productos')
  } catch (error) {
    toast.add({
      title: apiErrorMessage(error, 'No se ha podido guardar'),
      color: 'error',
      icon: 'i-lucide-alert-circle'
    })
  } finally {
    saving.value = false
  }
}

async function removeProduct() {
  if (!canDelete.value || saving.value) return
  if (!confirm(`¿Eliminar «${form.name}»? Esta acción no se puede deshacer.`)) return
  if (!canDelete.value) return
  await $fetch(`/api/admin/products/${id}`, { method: 'DELETE' })
  toast.add({ title: 'Producto eliminado', icon: 'i-lucide-trash-2', color: 'success' })
  refreshNuxtData('categories')
  navigateTo('/admin/productos')
}
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <!-- Barra de acción fija: el formulario mide más de 4.000 px y para guardar había que
         bajar hasta el final. Guardar es la acción que se repite, así que vive arriba. -->
    <div
      class="sticky top-0 z-30 -mx-4 mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--border)] bg-[var(--canvas)]/95 px-4 py-3 backdrop-blur"
    >
      <NuxtLink
        to="/admin/productos"
        class="flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-neteco-700"
      >
        <UIcon name="i-lucide-arrow-left" class="size-4" /> Productos
      </NuxtLink>

      <div class="min-w-0 flex-1">
        <h1 class="truncate text-lg font-bold text-[var(--text-strong)]">
          {{ isNew ? 'Nuevo producto' : form.name || 'Editar producto' }}
        </h1>
      </div>

      <UBadge v-if="!isNew" :color="STATUS_META.color" variant="subtle">{{ STATUS_META.label }}</UBadge>

      <div class="flex shrink-0 gap-2">
        <UButton to="/admin/productos" color="neutral" variant="ghost" size="sm">Cancelar</UButton>
        <UButton v-if="canWrite" type="submit" form="product-form" size="sm" icon="i-lucide-save" :loading="saving">
          {{ isNew ? 'Crear' : 'Guardar' }}
        </UButton>
      </div>
    </div>
    <p v-if="cloudflare" role="status" class="mb-6 text-sm text-[var(--text-muted)]">
      Catálogo D1. Las altas, marcas, variantes y metadatos de borradores se gestionan en editores separados con motivo
      y control de versión. Los precios y el stock siguen siendo de consulta aquí; un alta deja precio pendiente y stock
      cero. Ninguna edición de borrador publica ni aprueba el producto.
    </p>
    <p v-if="!supportedRuntime" role="alert" class="mb-6 text-sm">
      Este entorno no permite consultar ni editar productos.
    </p>
    <p v-else-if="!isNew && !canReadDetail" role="alert" class="mb-6 text-sm">
      {{
        existingStatus === 'pending'
          ? 'Consultando el producto…'
          : 'No se ha podido confirmar una consulta autorizada del producto.'
      }}
      <UButton v-if="cloudflare && canonicalId" :loading="existingStatus === 'pending'" @click="reloadPrivateProduct"
        >Consultar de nuevo</UButton
      >
    </p>
    <CatalogPublicationReadiness
      v-if="readinessIdentity"
      :key="`${readinessIdentity.id}:${readinessIdentity.uuid}:${readinessIdentity.version}`"
      :product-id="id"
      :product-uuid="readinessIdentity.uuid"
      :catalog-version="readinessIdentity.version"
      :runtime="runtime"
      :authorize="privateReadinessAuthority"
    />

    <ProductStatusEditor
      v-if="cloudflare && !isNew && canonicalId"
      :key="typeof existing?.uuid === 'string' ? `${id}:${existing.uuid}` : id"
      :product="existing ?? null"
      :product-id="id"
      :runtime="runtime"
      :read-status="existingStatus"
      :authorize="privateStatusAuthority"
      :refresh-product="reloadPrivateProduct"
      :readiness-available="!!readinessIdentity"
      :refresh-readiness="reloadStatusReadiness"
    />

    <ProductRelationsEditor
      v-if="cloudflare && !isNew && canonicalId && canReadDetail"
      :key="id"
      :product-id="Number(id)"
      :runtime="runtime"
    />

    <TypedProductAttributesEditor
      v-if="cloudflare && !isNew && canonicalId"
      :runtime="runtime"
      :available="canReadDetail && localDraftAuthority()"
      :product="existing"
      class="mb-5"
    />
    <DraftProductMetadataEditor
      v-if="cloudflare && !isNew && canonicalId"
      :product="existing ?? null"
      :product-id="id"
      :runtime="runtime"
      :read-status="existingStatus"
      :categories="familiaItems"
      :categories-ready="canReadCategories"
      :authorize="privateMetadataAuthority"
      :refresh-product="reloadPrivateProduct"
    />

    <ProductPublicationPolicyEditor
      v-if="publicationPolicyMountIdentity"
      :key="`${publicationPolicyMountIdentity.id}:${publicationPolicyMountIdentity.uuid}`"
      :product="existing ?? null"
      :product-id="id"
      :runtime="runtime"
      :read-status="existingStatus"
      :authorize="privatePublicationPolicyAuthority"
      :refresh-product="reloadPrivateProduct"
    />

    <DraftProductCreate
      v-if="cloudflare && isNew"
      :options="authoringOptions"
      :options-status="authoringOptionsStatus"
      :runtime="runtime"
      :refresh-options="reloadAuthoringOptions"
      :authorize="privateDraftCreateAuthority"
      :on-created="openCreatedDraft"
    />
    <DraftProductVariantsEditor
      v-if="cloudflare && !isNew && canonicalId"
      :product="existing"
      :product-id="id"
      :read-status="existingStatus"
      :options="authoringOptions"
      :options-status="authoringOptionsStatus"
      :runtime="runtime"
      :authorize="privateDraftAuthority"
      :refresh-product="reloadDraftProduct"
      :refresh-options="reloadAuthoringOptions"
    />
    <form v-if="node || (!isNew && canReadDetail)" id="product-form" class="space-y-6" @submit.prevent="save">
      <fieldset :disabled="!canWrite" class="min-w-0 space-y-6">
        <!-- datos principales -->
        <section class="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 class="font-bold text-slate-900">Datos principales</h2>
          <div class="mt-4 grid gap-4 grid-cols-1 sm:grid-cols-2">
            <UFormField label="Nombre (con el envase entre paréntesis)" class="sm:col-span-2">
              <UInput
                v-model="form.name"
                class="w-full"
                placeholder="Guante de nitrilo Nitriflex Blue (caja 100 uds)"
              />
            </UFormField>
            <UFormField label="Marca" hint="Opcional">
              <UInput v-model="form.brand" class="w-full" />
            </UFormField>
            <UFormField label="Familia">
              <USelect
                :model-value="form.categoryId ?? undefined"
                :items="familiaItems"
                class="w-full"
                placeholder="Elige una familia…"
                @update:model-value="(value) => (form.categoryId = value ?? null)"
              />
            </UFormField>
            <UFormField label="Gama (enlaza colores/versiones hermanas)" hint="Opcional">
              <UInput v-model="form.series" class="w-full" placeholder="guantes-nitriflex" />
            </UFormField>
            <div class="flex flex-wrap items-end gap-6 pb-1">
              <label class="flex items-center gap-2 text-sm text-slate-700">
                <input v-model="form.featured" type="checkbox" class="size-4 accent-neteco-600" /> Destacado en portada
              </label>
              <p class="text-sm text-[var(--text-muted)]">
                Estado editorial: <strong class="text-[var(--text-strong)]">{{ STATUS_META.label }}</strong
                >. Se cambia desde el listado, donde queda auditado con su motivo.
              </p>
            </div>
          </div>

          <div class="mt-4 flex flex-wrap gap-4">
            <span class="text-sm font-medium text-slate-700">Sellos:</span>
            <label v-for="(b, key) in BADGES" :key="key" class="flex items-center gap-1.5 text-sm text-slate-600">
              <input
                type="checkbox"
                :checked="form.badges.includes(String(key))"
                class="size-4 accent-neteco-600"
                @change="toggleBadge(String(key))"
              />
              {{ b.label }}
            </label>
          </div>
        </section>

        <!-- textos -->
        <section class="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 class="font-bold text-slate-900">Textos</h2>
          <div class="mt-4 space-y-4">
            <UFormField label="Descripción corta (tarjetas y buscador)">
              <UTextarea v-model="form.shortDesc" :rows="2" class="w-full" />
            </UFormField>
            <UFormField label="Descripción completa">
              <UTextarea v-model="form.description" :rows="4" class="w-full" />
            </UFormField>
            <UFormField label="Modo de empleo y dosificación" hint="Opcional">
              <UTextarea v-model="form.usage" :rows="2" class="w-full" />
            </UFormField>
          </div>
        </section>

        <section class="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 class="font-bold text-slate-900">Imagen principal y derechos</h2>
          <p class="mt-1 text-sm text-slate-500">
            La publicación exige correspondencia exacta, texto alternativo y evidencia de licencia o autorización.
          </p>
          <div class="mt-4 grid gap-4 grid-cols-1 sm:grid-cols-2">
            <UFormField label="Ruta de la imagen" class="sm:col-span-2">
              <UInput v-model="form.image" class="w-full" placeholder="/media/uuid-del-asset-aprobado" />
            </UFormField>
            <UFormField label="Texto alternativo" class="sm:col-span-2">
              <UInput v-model="form.imageAlt" class="w-full" placeholder="Envase exacto y formato mostrado" />
            </UFormField>
            <UFormField label="Propietario / licenciante">
              <UInput v-model="form.imageRightsOwner" class="w-full" />
            </UFormField>
            <UFormField label="Licencia o autorización">
              <UInput v-model="form.imageRightsLicense" class="w-full" placeholder="Autorización proveedor, propia…" />
            </UFormField>
            <UFormField label="Fecha de autorización">
              <UInput v-model="form.imageAuthorizedAt" type="date" class="w-full" />
            </UFormField>
          </div>
        </section>

        <!-- características técnicas -->
        <section class="rounded-2xl border border-slate-200 bg-white p-6">
          <div class="flex items-center justify-between">
            <h2 class="font-bold text-slate-900">Características técnicas</h2>
            <UButton size="sm" variant="soft" icon="i-lucide-plus" @click="addAttr">Añadir</UButton>
          </div>
          <p class="mt-1 text-sm text-slate-500">
            Salen en la tabla «Características» de la ficha, en este mismo orden: Material, Gramaje, Unidades/caja,
            Certificaciones, EAN…
          </p>
          <div v-if="form.attrs.length" class="mt-4 space-y-2">
            <div v-for="(a, i) in form.attrs" :key="i" class="grid grid-cols-[1fr_2fr_auto] items-center gap-2">
              <UInput v-model="a.k" placeholder="Material" />
              <UInput v-model="a.v" placeholder="Tejido sin tejer 55 g/m²" />
              <div class="flex gap-0.5">
                <UButton
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  icon="i-lucide-chevron-up"
                  :disabled="i === 0"
                  aria-label="Subir"
                  @click="moveAttr(i, -1)"
                />
                <UButton
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  icon="i-lucide-chevron-down"
                  :disabled="i === form.attrs.length - 1"
                  aria-label="Bajar"
                  @click="moveAttr(i, 1)"
                />
                <UButton
                  size="xs"
                  color="error"
                  variant="ghost"
                  icon="i-lucide-trash-2"
                  aria-label="Quitar"
                  @click="removeAttr(i)"
                />
              </div>
            </div>
          </div>
        </section>

        <!-- visual -->
        <section class="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 class="font-bold text-slate-900">Ilustración provisional</h2>
          <p class="mt-1 text-sm text-slate-500">
            Hasta que haya fotos reales, cada producto usa un envase dibujado con un color identificativo.
          </p>
          <div class="mt-4 flex flex-wrap items-center gap-6">
            <div class="w-28"><ProductVisual :visual="form.visual" /></div>
            <UFormField label="Tipo de envase">
              <USelect v-model="form.visual.type" :items="envaseItems" class="w-44" />
            </UFormField>
            <UFormField label="Color">
              <input
                v-model="form.visual.color"
                type="color"
                aria-label="Color de la ilustración de envase"
                class="h-9 w-16 cursor-pointer rounded border border-slate-300"
              />
            </UFormField>
          </div>
        </section>

        <!-- variantes -->
        <section class="rounded-2xl border border-slate-200 bg-white p-6">
          <div class="flex items-center justify-between">
            <h2 class="font-bold text-slate-900">Variantes (formatos / tallas)</h2>
            <UButton size="sm" variant="soft" icon="i-lucide-plus" @click="addVariant">Añadir variante</UButton>
          </div>
          <p class="mt-1 text-sm text-slate-500">
            La <strong>referencia</strong> debe ser el código de artículo del ERP. El precio va en euros,
            <strong>IVA incluido</strong>; el €/ud–€/L se calcula solo a partir del formato.
          </p>
          <div class="mt-4 space-y-2">
            <div
              v-for="(v, i) in form.variants"
              :key="i"
              class="rounded-[var(--radius-surface)] border border-[var(--border)]"
            >
              <!-- Cada variante tiene veinte campos. Con cinco tallas eran cien campos abiertos
                 a la vez, imposible de repasar. Se abre la que se va a tocar. -->
              <button
                type="button"
                class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--canvas)]"
                :aria-expanded="openVariants.has(i)"
                @click="toggleVariant(i)"
              >
                <UIcon
                  name="i-lucide-chevron-down"
                  class="size-4 shrink-0 text-[var(--text-muted)] transition-transform"
                  :class="!openVariants.has(i) && '-rotate-90'"
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium text-[var(--text-strong)]">
                    {{ v.format || `Variante ${i + 1}` }}
                  </span>
                  <span class="block truncate text-xs text-[var(--text-muted)]">
                    <template v-if="v.sku">Ref. {{ v.sku }}</template>
                    <template v-else>Sin referencia del ERP</template>
                    <template v-if="v.price"> · {{ formatPrice(Math.round(Number(v.price) * 100)) }}</template>
                    <template v-if="v.stock !== undefined && v.stock !== null"> · {{ v.stock }} en stock</template>
                  </span>
                </span>
              </button>

              <div v-show="openVariants.has(i)" class="border-t border-[var(--border)] p-4">
                <div class="grid items-end gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-6">
                  <UFormField label="Formato"
                    ><UInput v-model="v.format" placeholder="Talla M · Garrafa 5 L…"
                  /></UFormField>
                  <UFormField label="Referencia ERP"><UInput v-model="v.sku" placeholder="1133" /></UFormField>
                  <UFormField label="EAN"><UInput v-model="v.ean" inputmode="numeric" /></UFormField>
                  <UFormField label="GTIN"><UInput v-model="v.gtin" inputmode="numeric" /></UFormField>
                  <UFormField label="MPN fabricante"><UInput v-model="v.mpn" /></UFormField>
                  <UButton
                    size="sm"
                    color="error"
                    variant="ghost"
                    icon="i-lucide-trash-2"
                    :disabled="form.variants.length <= 1"
                    @click="removeVariant(i)"
                    >Quitar</UButton
                  >
                </div>
                <UFormField
                  label="Excepción de identificador"
                  hint="Obligatoria y motivada si no hay EAN, GTIN ni MPN"
                  class="mt-3"
                >
                  <UInput v-model="v.identifierExceptionReason" class="w-full" />
                </UFormField>
                <div class="mt-3 grid items-end gap-3 grid-cols-1 sm:grid-cols-3 lg:grid-cols-6">
                  <UFormField label="Precio € IVA inc."
                    ><input v-model.number="v.price" type="number" step="0.01" min="0" class="admin-number"
                  /></UFormField>
                  <UFormField label="Stock"
                    ><input v-model.number="v.stock" type="number" min="0" class="admin-number"
                  /></UFormField>
                  <UFormField label="Stock seguridad"
                    ><input v-model.number="v.safetyStock" type="number" min="0" class="admin-number"
                  /></UFormField>
                  <UFormField label="Unidad base"><UInput v-model="v.unitBase" placeholder="unit, l, kg" /></UFormField>
                  <UFormField label="Etiqueta unidad"><UInput v-model="v.unitLabel" placeholder="unidad" /></UFormField>
                  <UFormField label="Contenido"
                    ><input
                      v-model.number="v.contentQuantity"
                      type="number"
                      min="0.0001"
                      step="0.0001"
                      class="admin-number"
                  /></UFormField>
                </div>
                <div class="mt-3 grid items-end gap-3 grid-cols-1 sm:grid-cols-3 lg:grid-cols-6">
                  <UFormField label="MOQ"
                    ><input v-model.number="v.minimumQuantity" type="number" min="1" class="admin-number"
                  /></UFormField>
                  <UFormField label="Incremento"
                    ><input v-model.number="v.quantityIncrement" type="number" min="1" class="admin-number"
                  /></UFormField>
                  <UFormField label="Máximo"
                    ><input v-model.number="v.maximumQuantity" type="number" min="1" class="admin-number"
                  /></UFormField>
                  <UFormField label="Uds./caja"
                    ><input v-model.number="v.unitsPerCase" type="number" min="1" class="admin-number"
                  /></UFormField>
                  <UFormField label="Cajas/palé"
                    ><input v-model.number="v.casesPerPallet" type="number" min="1" class="admin-number"
                  /></UFormField>
                  <UFormField label="Imagen variante"><UInput v-model="v.image" /></UFormField>
                </div>
                <div class="mt-3 grid items-end gap-3 grid-cols-1 sm:grid-cols-3 lg:grid-cols-6">
                  <UFormField label="Peso g"
                    ><input v-model.number="v.weightGrams" type="number" min="0" class="admin-number"
                  /></UFormField>
                  <UFormField label="Ancho mm"
                    ><input v-model.number="v.widthMm" type="number" min="0" class="admin-number"
                  /></UFormField>
                  <UFormField label="Alto mm"
                    ><input v-model.number="v.heightMm" type="number" min="0" class="admin-number"
                  /></UFormField>
                  <UFormField label="Fondo mm"
                    ><input v-model.number="v.depthMm" type="number" min="0" class="admin-number"
                  /></UFormField>
                  <UFormField label="Color"><UInput v-model="v.color" placeholder="#f7c600" /></UFormField>
                  <UFormField label="Lead time días"
                    ><input v-model.number="v.leadTimeDays" type="number" min="0" class="admin-number"
                  /></UFormField>
                </div>
                <label class="mt-3 flex items-center gap-2 text-sm text-slate-700"
                  ><input v-model="v.backorderAllowed" type="checkbox" class="size-4" /> Permitir bajo pedido (requiere
                  lead time)</label
                >
              </div>
            </div>
          </div>
        </section>

        <div
          v-if="!isNew && canDelete"
          class="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-6 pb-10"
        >
          <div>
            <p class="font-semibold text-[var(--text-strong)]">Eliminar este producto</p>
            <p class="mt-0.5 text-sm text-[var(--text-muted)]">
              No se puede deshacer. Si solo quieres retirarlo de la tienda, cámbialo a «Descatalogado» desde el listado.
            </p>
          </div>
          <UButton color="error" variant="outline" icon="i-lucide-trash-2" @click="removeProduct">
            Eliminar producto
          </UButton>
        </div>
        <div v-else class="pb-10" />
      </fieldset>
    </form>
  </div>
</template>

<style scoped>
/* El foco de estos campos era `#169f62`, un verde que no pertenece a ninguna escala del
   sistema ni a la marca: en la misma pantalla, un campo enfocado se veía verde y el de al
   lado azul. Ahora usan los tokens. */
.admin-number {
  width: 100%;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  padding: 0.375rem 0.75rem;
  font-size: 0.875rem;
  line-height: 1.25rem;
  font-variant-numeric: tabular-nums;
}

.admin-number:focus-visible {
  border-color: var(--color-neteco-600);
  outline: 2px solid var(--color-neteco-600);
  outline-offset: 1px;
}
</style>
