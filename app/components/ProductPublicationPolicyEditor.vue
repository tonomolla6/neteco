<script setup lang="ts">
import { randomId } from '~/utils/uuid'
import {
  REQUIRED_PUBLICATION_FIELDS,
  PUBLICATION_DOCUMENT_ROLES,
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema,
  catalogPolicyInstantSchema,
  catalogPolicyCodeSchema,
  catalogPolicyStatusSchema,
  catalogPolicyReceiptSchema,
  policyAssignInputSchema,
  exceptionCreateInputSchema,
  exceptionWithdrawInputSchema,
  type CatalogPublicationPolicyView,
  type ProductPublicationPolicyView
} from '~~/shared/catalog-publication-policy'

type Status = 'draft' | 'review' | 'published' | 'hidden' | 'discontinued'
type Identity = { id: number; uuid: string; version: number; status: Status }
type Action = 'policy_assign' | 'exception_create' | 'exception_withdraw'
type Command = Readonly<{
  action: Action
  identity: Identity
  path: string
  payload: string
  key: string
  resource: string
  policyVersion: number | null
}>
const props = defineProps<{
  product: unknown
  productId: string
  runtime: unknown
  readStatus: string
  authorize: (identity: { id: number; uuid: string; version?: number; status?: string }) => boolean
  refreshProduct: () => Promise<unknown>
}>()
const FIELDS = REQUIRED_PUBLICATION_FIELDS
const ROLES = PUBLICATION_DOCUMENT_ROLES
const REGULATORY_LABELS = {
  productType: 'Clasificación del producto',
  requiresSds: 'Requiere ficha de seguridad',
  safetyInstructions: 'Instrucciones de seguridad',
  hazardStatements: 'Indicaciones de peligro',
  precautionaryStatements: 'Consejos de prudencia',
  manufacturer: 'Fabricante'
}
const STATUSES = ['draft', 'review', 'published', 'hidden', 'discontinued']
function own(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    fields.every((field) => Object.hasOwn(Object.getOwnPropertyDescriptor(value, field) ?? {}, 'value'))
  )
}
function uuid(value: unknown): value is string {
  return catalogPolicyUuidSchema.safeParse(value).success
}
function integer(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
}
function instant(value: unknown): value is string {
  return catalogPolicyInstantSchema.safeParse(value).success
}
function json(value: unknown): unknown {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
function text(value: unknown, min: number, max: number, multiline = false): value is string {
  return (
    typeof value === 'string' &&
    [...value].every(
      (c) => (c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127) || (multiline && ['\n', '\r', '\t'].includes(c))
    ) &&
    value.trim().length >= min &&
    value.trim().length <= max
  )
}
function unique(value: unknown, allowed: readonly string[]): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && allowed.includes(entry)) &&
    new Set(value).size === value.length
  )
}
function capability(value: unknown, key: string) {
  return own(value, [key]) && value[key] === true
}
function policy(value: unknown): value is CatalogPublicationPolicyView {
  return (
    own(value, [
      'id',
      'code',
      'version',
      'name',
      'requiredFields',
      'requiredMediaRoles',
      'identifierExceptionsAllowed',
      'validFrom',
      'validUntil',
      'current',
      'withdrawn',
      'assignedProductCount',
      'publishedProductCount'
    ]) &&
    uuid(value.id) &&
    typeof value.code === 'string' &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(value.code) &&
    integer(value.version, 1) &&
    text(value.name, 3, 160) &&
    unique(value.requiredFields, FIELDS) &&
    unique(value.requiredMediaRoles, ROLES) &&
    typeof value.identifierExceptionsAllowed === 'boolean' &&
    instant(value.validFrom) &&
    (value.validUntil === null || (instant(value.validUntil) && value.validUntil > value.validFrom)) &&
    typeof value.current === 'boolean' &&
    typeof value.withdrawn === 'boolean' &&
    !(value.current && value.withdrawn) &&
    integer(value.assignedProductCount) &&
    integer(value.publishedProductCount) &&
    value.publishedProductCount <= value.assignedProductCount
  )
}
function currentWindow(item: CatalogPublicationPolicyView, evaluatedAt: unknown) {
  return (
    !item.current ||
    (instant(evaluatedAt) &&
      item.validFrom <= evaluatedAt &&
      (item.validUntil === null || item.validUntil > evaluatedAt))
  )
}
function identity(): Identity | null {
  const value = props.product
  if (
    props.runtime !== 'cloudflare' ||
    props.readStatus !== 'success' ||
    !/^[1-9]\d{0,15}$/.test(props.productId) ||
    !integer(Number(props.productId), 1) ||
    !own(value, ['source', 'id', 'uuid', 'catalogVersion', 'status', 'capabilities']) ||
    value.source !== 'cloudflare' ||
    value.id !== Number(props.productId) ||
    !uuid(value.uuid) ||
    !integer(value.catalogVersion, 1) ||
    typeof value.status !== 'string' ||
    !STATUSES.includes(value.status) ||
    !capability(value.capabilities, 'productDetailRead') ||
    !capability(value.capabilities, 'productPublicationPolicyRead')
  )
    return null
  const parsedStatus = catalogPolicyStatusSchema.safeParse(value.status)
  if (!parsedStatus.success) return null
  const result = {
    id: Number(props.productId),
    uuid: value.uuid,
    version: value.catalogVersion,
    status: parsedStatus.data
  }
  return props.authorize(result) ? result : null
}
const origin = {
  id: Number(props.productId),
  uuid: own(props.product, ['uuid']) && uuid(props.product.uuid) ? props.product.uuid : ''
}
function originAuthorized() {
  const value = identity()
  return (
    !!value &&
    value.id === origin.id &&
    value.uuid === origin.uuid &&
    props.authorize({ id: origin.id, uuid: origin.uuid })
  )
}
const { data, status, refresh } = await useFetch<unknown>(`/api/admin/products/${props.productId}/publication-policy`, {
  key: `admin-product-publication-policy-${props.productId}-${origin.uuid}`,
  method: 'GET',
  immediate: originAuthorized(),
  server: originAuthorized(),
  watch: false
})
function validProduct(value: unknown): value is ProductPublicationPolicyView {
  const current = identity()
  if (
    !current ||
    !originAuthorized() ||
    !own(value, [
      'source',
      'capabilities',
      'productId',
      'productUuid',
      'catalogVersion',
      'status',
      'regulatory',
      'policy',
      'variants',
      'evaluatedAt'
    ]) ||
    value.source !== 'cloudflare' ||
    value.productId !== current.id ||
    value.productUuid !== current.uuid ||
    value.catalogVersion !== current.version ||
    value.status !== current.status ||
    !capability(value.capabilities, 'productPublicationPolicyRead') ||
    !instant(value.evaluatedAt) ||
    !(value.policy === null || policy(value.policy)) ||
    !own(value.regulatory, [
      'productType',
      'requiresSds',
      'safetyInstructions',
      'hazardStatements',
      'precautionaryStatements',
      'manufacturer'
    ]) ||
    !Array.isArray(value.variants) ||
    value.variants.length > 500 ||
    (value.policy !== null && !currentWindow(value.policy, value.evaluatedAt))
  )
    return false
  const r = value.regulatory
  if (
    !(r.productType === null || catalogPolicyCodeSchema.safeParse(r.productType).success) ||
    !(r.requiresSds === null || typeof r.requiresSds === 'boolean') ||
    !['safetyInstructions', 'hazardStatements', 'precautionaryStatements'].every(
      (key) => r[key] === null || text(r[key], 0, 2000, true)
    ) ||
    !(r.manufacturer === null || text(r.manufacturer, 1, 160))
  )
    return false
  const ids = new Set<string>()
  const exceptionIds = new Set<string>()
  return value.variants.every((variant) => {
    if (
      !own(variant, ['id', 'legacyId', 'status', 'ean', 'gtin', 'mpn', 'identifierException']) ||
      !uuid(variant.id) ||
      ids.has(variant.id) ||
      !(variant.legacyId === null || integer(variant.legacyId, 1)) ||
      typeof variant.status !== 'string' ||
      !STATUSES.includes(variant.status) ||
      !['ean', 'gtin', 'mpn'].every((key) => variant[key] === null || typeof variant[key] === 'string')
    )
      return false
    ids.add(variant.id)
    const exception = variant.identifierException
    if (exception === null) return true
    if (
      !own(exception, ['id', 'reason', 'evidenceReference', 'validFrom', 'validUntil']) ||
      !uuid(exception.id) ||
      exceptionIds.has(exception.id) ||
      !text(exception.reason, 10, 500) ||
      !text(exception.evidenceReference, 3, 200) ||
      !instant(exception.validFrom) ||
      !(exception.validUntil === null || (instant(exception.validUntil) && exception.validUntil > exception.validFrom))
    )
      return false
    exceptionIds.add(exception.id)
    return true
  })
}
const committedVersion = ref(1)
const snapshot = computed(() => {
  const value = json(data.value)
  return status.value === 'success' && validProduct(value) && value.catalogVersion >= committedVersion.value
    ? value
    : null
})
const page = ref(1)
const {
  data: policiesData,
  status: policiesStatus,
  refresh: refreshPolicies
} = await useFetch<unknown>(
  computed(() => `/api/admin/catalog/policies?page=${page.value}&perPage=20`),
  {
    key: computed(() => `admin-product-policy-options-${origin.uuid}-${page.value}`),
    method: 'GET',
    immediate: originAuthorized(),
    server: originAuthorized(),
    watch: false
  }
)
const options = computed(() => {
  const value = json(policiesData.value)
  if (
    !originAuthorized() ||
    policiesStatus.value !== 'success' ||
    !own(value, ['source', 'capabilities', 'items', 'pagination', 'evaluatedAt']) ||
    value.source !== 'cloudflare' ||
    !capability(value.capabilities, 'publicationPoliciesRead') ||
    !instant(value.evaluatedAt) ||
    !Array.isArray(value.items) ||
    !value.items.every(policy) ||
    value.items.some((item) => !currentWindow(item, value.evaluatedAt)) ||
    new Set(value.items.map((item) => item.id)).size !== value.items.length ||
    !own(value.pagination, ['page', 'perPage', 'total', 'pages']) ||
    value.pagination.page !== page.value ||
    value.pagination.perPage !== 20 ||
    !integer(value.pagination.total) ||
    !integer(value.pagination.pages) ||
    value.pagination.pages !== Math.ceil(value.pagination.total / 20) ||
    value.items.length > 20 ||
    value.items.length > value.pagination.total
  )
    return null
  return {
    items: value.items.filter((item) => item.current && !item.withdrawn),
    pages: value.pagination.pages,
    total: value.pagination.total
  }
})
const editable = computed(() => !!snapshot.value && ['draft', 'review', 'hidden'].includes(snapshot.value.status))
const form = reactive({
  policyId: '',
  requiresSds: '',
  safetyInstructions: '',
  hazardStatements: '',
  precautionaryStatements: '',
  manufacturer: '',
  reason: '',
  confirmed: false
})
const exceptionForm = reactive({
  variantId: '',
  reason: '',
  evidenceReference: '',
  validFrom: '',
  validUntil: '',
  confirmed: false
})
const withdrawal = reactive({ variantId: '', reason: '', confirmed: false })
const baseline = ref<Identity | null>(null)
const saving = ref(false)
const reading = ref(false)
const blocked = ref(false)
const uncertain = ref(false)
const error = ref('')
const notice = ref('')
let command: Command | null = null
let active = true
let generation = 0
const busy = computed(
  () => saving.value || reading.value || status.value === 'pending' || policiesStatus.value === 'pending'
)
const stale = computed(
  () =>
    !!baseline.value &&
    (!snapshot.value ||
      snapshot.value.catalogVersion !== baseline.value.version ||
      snapshot.value.status !== baseline.value.status)
)
function writable(cap: string) {
  return (
    active &&
    editable.value &&
    !!snapshot.value &&
    capability(snapshot.value.capabilities, cap) &&
    !!baseline.value &&
    !stale.value &&
    !blocked.value &&
    !busy.value &&
    !command &&
    baseline.value.version < Number.MAX_SAFE_INTEGER &&
    props.authorize(baseline.value)
  )
}
function reset() {
  const current = identity()
  if (!snapshot.value || !current) return
  baseline.value = { ...current }
  Object.assign(form, {
    policyId: '',
    requiresSds: '',
    safetyInstructions: '',
    hazardStatements: '',
    precautionaryStatements: '',
    manufacturer: '',
    reason: '',
    confirmed: false
  })
  Object.assign(exceptionForm, {
    variantId: '',
    reason: '',
    evidenceReference: '',
    validFrom: '',
    validUntil: '',
    confirmed: false
  })
  Object.assign(withdrawal, { variantId: '', reason: '', confirmed: false })
  blocked.value = false
}
watch(
  snapshot,
  () => {
    if (!baseline.value && snapshot.value && !command) reset()
  },
  { immediate: true }
)
function missingIdentifier(variant: ProductPublicationPolicyView['variants'][number]) {
  return !variant.ean?.trim() && !variant.gtin?.trim() && !variant.mpn?.trim()
}
const exceptionCandidates = computed(() =>
  snapshot.value?.policy?.current && snapshot.value.policy.identifierExceptionsAllowed
    ? snapshot.value.variants.filter(
        (variant) => variant.status !== 'discontinued' && missingIdentifier(variant) && !variant.identifierException
      )
    : []
)
const withdrawCandidates = computed(
  () => snapshot.value?.variants.filter((variant) => !!variant.identifierException) ?? []
)
const errors: Record<string, string> = {
  version_conflict: 'El producto ha cambiado. Consulta de nuevo antes de preparar otro comando; no se ha sobrescrito.',
  idempotency_conflict:
    'El comando no coincide con la clave registrada. Consulta de nuevo; no lo repitas con otra clave.',
  invalid_state:
    'Este estado no permite editar la política. Oculta el producto mediante su editor de estados y consulta de nuevo.',
  policy_unavailable:
    'La política ya no está disponible. Consulta de nuevo y selecciona otra política vigente expresamente.',
  policy_in_use: 'La política tiene productos publicados y no se puede retirar.',
  invalid_input: 'El servidor ha rechazado los datos. Consulta de nuevo y revisa los campos y el motivo.',
  conflict: 'El servidor ha rechazado el cambio. Consulta de nuevo.',
  forbidden: 'No tienes permiso para este cambio. Verifica tu acceso y consulta de nuevo.',
  mfa_required: 'Verifica el segundo factor y consulta de nuevo.',
  unauthenticated: 'Inicia sesión y consulta de nuevo.',
  email_unverified: 'Verifica tu correo y consulta de nuevo.',
  not_found: 'El recurso no está disponible. Consulta de nuevo.',
  csrf_rejected: 'El origen no está autorizado. Abre el panel desde su dirección correcta.',
  body_too_large: 'Los textos superan el tamaño permitido. Consulta de nuevo y reduce el contenido.',
  rate_limited: 'Hay demasiados intentos. Espera antes de consultar de nuevo.'
}
function commandAuthorized(intent: Command) {
  return (
    active &&
    originAuthorized() &&
    !!snapshot.value &&
    capability(
      snapshot.value.capabilities,
      intent.action === 'policy_assign' ? 'productPublicationPolicyWrite' : 'productIdentifierExceptionsWrite'
    ) &&
    props.authorize({ id: intent.identity.id, uuid: intent.identity.uuid })
  )
}
function receipt(value: unknown, intent: Command) {
  const parsed = catalogPolicyReceiptSchema.safeParse(json(value))
  if (!parsed.success) return false
  const result = parsed.data
  return (
    result.action === intent.action &&
    result.resourceId === intent.resource &&
    result.policyVersion === intent.policyVersion &&
    result.productId === intent.identity.id &&
    result.productUuid === intent.identity.uuid &&
    result.catalogVersion === intent.identity.version + 1
  )
}
async function dispatch(intent: Command, replay: boolean) {
  if (busy.value || !commandAuthorized(intent) || typeof window === 'undefined') return
  if (!replay && (!editable.value || blocked.value || stale.value || !props.authorize(intent.identity))) return
  saving.value = true
  error.value = ''
  notice.value = ''
  const request = ++generation
  try {
    const result: unknown = await $fetch(intent.path, {
      method: intent.action === 'policy_assign' ? 'PUT' : 'POST',
      body: JSON.parse(intent.payload),
      headers: { Origin: window.location.origin, 'Idempotency-Key': intent.key }
    })
    if (request !== generation || !commandAuthorized(intent)) return
    if (!receipt(result, intent)) throw new Error('unconfirmed_receipt')
    committedVersion.value = Math.max(committedVersion.value, intent.identity.version + 1)
    command = null
    uncertain.value = false
    blocked.value = true
    notice.value =
      'Cambio registrado. No publica el producto ni acredita aprobación legal; consulta los datos vigentes.'
    await refreshAll(true, intent.identity.version + 1)
  } catch (cause) {
    if (request !== generation || !commandAuthorized(intent)) return
    if (!command) {
      error.value = 'El cambio está registrado, pero falta actualizar la consulta. Consulta de nuevo.'
      return
    }
    const code = (cause as { data?: { error?: { code?: unknown } } } | null)?.data?.error?.code
    if (typeof code === 'string' && Object.hasOwn(errors, code)) {
      command = null
      uncertain.value = false
      blocked.value = true
      error.value = errors[code]!
    } else {
      uncertain.value = true
      error.value =
        'No se ha podido confirmar el resultado. Reintenta exactamente el mismo comando si lo deseas; no se reenviará automáticamente.'
    }
  } finally {
    saving.value = false
  }
}
async function prepare(
  action: Action,
  path: string,
  body: Record<string, unknown>,
  resource: string,
  policyVersion: number | null
) {
  const current = identity()
  if (
    !current ||
    !baseline.value ||
    command ||
    !writable(action === 'policy_assign' ? 'productPublicationPolicyWrite' : 'productIdentifierExceptionsWrite')
  )
    return
  const parsed = (
    action === 'policy_assign'
      ? policyAssignInputSchema
      : action === 'exception_create'
        ? exceptionCreateInputSchema
        : exceptionWithdrawInputSchema
  ).safeParse(body)
  if (!parsed.success) {
    error.value = 'Revisa los campos antes de preparar el comando.'
    return
  }
  try {
    command = Object.freeze({
      action,
      identity: Object.freeze({ ...baseline.value }),
      path,
      payload: JSON.stringify(parsed.data),
      resource,
      policyVersion,
      key: randomId()
    })
  } catch {
    error.value = 'No se ha podido preparar una clave segura. No se ha enviado ningún cambio.'
    return
  }
  await dispatch(command, false)
}
async function assignPolicy() {
  const selected = options.value?.items.find((item) => item.id === form.policyId)
  if (
    !writable('productPublicationPolicyWrite') ||
    !selected ||
    !['true', 'false'].includes(form.requiresSds) ||
    !text(form.reason, 10, 500) ||
    form.confirmed !== true
  )
    return
  const regulatory: Record<string, unknown> = { productType: selected.code, requiresSds: form.requiresSds === 'true' }
  for (const key of ['safetyInstructions', 'hazardStatements', 'precautionaryStatements', 'manufacturer'] as const) {
    if (!form[key]) continue
    if (!text(form[key], 1, key === 'manufacturer' ? 160 : 2000, key !== 'manufacturer')) {
      error.value = 'Revisa los textos regulatorios antes de guardar.'
      return
    }
    regulatory[key] = form[key]
  }
  await prepare(
    'policy_assign',
    `/api/admin/products/${origin.id}/publication-policy`,
    { expectedVersion: baseline.value!.version, policyId: selected.id, regulatory, reason: form.reason },
    selected.id,
    selected.version
  )
}
async function createException() {
  const selected = exceptionCandidates.value.find((variant) => variant.id === exceptionForm.variantId)
  if (
    !writable('productIdentifierExceptionsWrite') ||
    !selected ||
    !snapshot.value?.policy ||
    !text(exceptionForm.reason, 10, 500) ||
    !text(exceptionForm.evidenceReference, 3, 200) ||
    !instant(exceptionForm.validFrom) ||
    (exceptionForm.validUntil &&
      (!instant(exceptionForm.validUntil) || exceptionForm.validUntil <= exceptionForm.validFrom)) ||
    exceptionForm.confirmed !== true
  )
    return
  await prepare(
    'exception_create',
    `/api/admin/products/${origin.id}/identifier-exceptions`,
    {
      expectedVersion: baseline.value!.version,
      variantId: selected.id,
      reason: exceptionForm.reason,
      evidenceReference: exceptionForm.evidenceReference,
      validFrom: exceptionForm.validFrom,
      validUntil: exceptionForm.validUntil || null
    },
    selected.id,
    snapshot.value.policy.version
  )
}
async function withdrawException() {
  const selected = withdrawCandidates.value.find((variant) => variant.id === withdrawal.variantId)
  if (
    !writable('productIdentifierExceptionsWrite') ||
    !selected?.identifierException ||
    !text(withdrawal.reason, 10, 500) ||
    withdrawal.confirmed !== true
  )
    return
  await prepare(
    'exception_withdraw',
    `/api/admin/products/${origin.id}/identifier-exceptions/${selected.identifierException.id}/withdraw`,
    { expectedVersion: baseline.value!.version, reason: withdrawal.reason },
    selected.identifierException.id,
    null
  )
}
async function retry() {
  if (uncertain.value && command) await dispatch(command, true)
}
async function refreshAll(afterSuccess = false, minimumVersion = 1) {
  if (!active || !originAuthorized() || reading.value || (!afterSuccess && busy.value)) return
  reading.value = true
  const request = generation
  try {
    await props.refreshProduct()
    await nextTick()
    if (!active || request !== generation || !originAuthorized()) return
    await refresh()
    await refreshPolicies()
    await nextTick()
    if (!active || request !== generation || !originAuthorized()) return
    if (snapshot.value && !command && snapshot.value.catalogVersion >= minimumVersion) reset()
    else if (command)
      error.value = 'Consulta actualizada. El intento pendiente conserva su clave y sus datos; no se ha reenviado.'
    else
      error.value =
        'No se ha confirmado una consulta actual válida para la versión registrada. Consulta de nuevo antes de otro comando.'
  } catch {
    if (active) error.value = 'No se ha podido actualizar la consulta. No se ha reenviado ningún cambio.'
  } finally {
    reading.value = false
  }
}
async function policyPage(next: number) {
  if (
    !active ||
    !originAuthorized() ||
    busy.value ||
    command ||
    !integer(next, 1) ||
    !options.value ||
    next > options.value.pages
  )
    return
  reading.value = true
  page.value = next
  form.policyId = ''
  form.confirmed = false
  try {
    await refreshPolicies()
  } catch {
    error.value = 'No se han podido consultar las opciones de política.'
  } finally {
    reading.value = false
  }
}
watch(
  () => [props.productId, own(props.product, ['uuid']) ? props.product.uuid : null],
  () => {
    if (Number(props.productId) !== origin.id || !own(props.product, ['uuid']) || props.product.uuid !== origin.uuid) {
      ++generation
      command = null
      uncertain.value = false
      baseline.value = null
      blocked.value = true
    }
  }
)
onBeforeUnmount(() => {
  active = false
  ++generation
  command = null
})
</script>

<template>
  <section
    class="adm-stack"
    aria-labelledby="product-policy-heading"
    :aria-busy="busy"
    data-product-publication-policy-editor
  >
    <AdminCard
      description="Clasificación del producto y datos de seguridad que deben estar revisados. Guardar aquí no publica productos ni acredita aprobación legal: la tienda lo valida al publicar."
    >
      <template #title><span id="product-policy-heading">Regla de publicación y revisión regulatoria</span></template>
      <template #actions>
        <NuxtLink to="/admin/politicas-catalogo" class="adm-btn adm-btn--secondary adm-btn--sm"
          >Gestionar reglas</NuxtLink
        >
      </template>
      <p
        v-if="originAuthorized() && (status === 'idle' || status === 'pending' || reading)"
        role="status"
        class="adm-help"
      >
        Cargando la regla y las excepciones…
      </p>
      <div v-else-if="snapshot" class="adm-stack">
        <div>
          <p v-if="snapshot.policy" class="font-medium text-[var(--text-strong)]">
            {{ snapshot.policy.name }} · versión {{ snapshot.policy.version }}
            <AdminBadge :tone="snapshot.policy.current ? 'success' : 'warning'" class="ml-1">{{
              snapshot.policy.current ? 'Vigente' : 'No vigente'
            }}</AdminBadge>
          </p>
          <p v-else>Sin regla asignada. No se presupone ninguna clasificación.</p>
          <p class="adm-help mt-1">
            Datos consultados el
            <time :datetime="snapshot.evaluatedAt">{{ adminDate(snapshot.evaluatedAt, true) }}</time>
          </p>
        </div>
        <dl class="grid gap-3 sm:grid-cols-2">
          <div v-for="(value, key) in snapshot.regulatory" :key="key">
            <dt class="adm-label">{{ REGULATORY_LABELS[key] }}</dt>
            <dd class="whitespace-pre-wrap">
              {{ value === null ? 'Sin revisar' : value === true ? 'Sí' : value === false ? 'No' : value }}
            </dd>
          </div>
        </dl>
        <UAlert
          v-if="!editable"
          role="status"
          color="neutral"
          variant="subtle"
          title="Sólo lectura en productos publicados o descatalogados."
          description="Para editar, oculta antes el producto desde «Cambiar estado editorial» y vuelve a cargar esta sección. Aquí no se cambia su estado."
        />
        <UAlert
          v-if="stale"
          role="alert"
          color="warning"
          variant="subtle"
          title="El producto ha cambiado desde que lo abriste. Vuelve a cargar antes de preparar otro cambio."
        />
        <form
          v-if="editable && capability(snapshot.capabilities, 'productPublicationPolicyWrite')"
          class="border-t border-[var(--border)] pt-4"
          @submit.prevent="assignPolicy"
        >
          <fieldset :disabled="!writable('productPublicationPolicyWrite')" class="adm-stack">
            <legend class="adm-label">Asignar una regla vigente</legend>
            <p v-if="policiesStatus === 'idle' || policiesStatus === 'pending'" role="status" class="adm-help">
              Cargando opciones…
            </p>
            <UAlert
              v-else-if="!options"
              role="alert"
              color="error"
              variant="subtle"
              title="No se han podido cargar las reglas disponibles. Vuelve a cargar para intentarlo de nuevo."
            />
            <div v-else class="adm-field">
              <label for="product-policy-choice" class="adm-label">Regla revisada</label
              ><select id="product-policy-choice" v-model="form.policyId" required class="adm-input">
                <option value="" disabled>Selecciona una regla</option>
                <option v-for="item in options.items" :key="item.id" :value="item.id">
                  {{ item.name }} · versión {{ item.version }}
                </option>
              </select>
              <p v-if="!options.items.length" class="adm-help">
                No hay reglas vigentes en esta página ({{ options.total }} en total).
              </p>
            </div>
            <div class="adm-field">
              <label for="product-policy-sds" class="adm-label">¿Requiere ficha de datos de seguridad?</label
              ><select id="product-policy-sds" v-model="form.requiresSds" required class="adm-input">
                <option value="" disabled>Selecciona una respuesta</option>
                <option value="true">Sí</option>
                <option value="false">No</option>
              </select>
            </div>
            <p class="adm-help">Los textos que dejes vacíos no se tocan: se conservan los datos que ya había.</p>
            <div
              v-for="key in [
                'safetyInstructions',
                'hazardStatements',
                'precautionaryStatements',
                'manufacturer'
              ] as const"
              :key="key"
              class="adm-field"
            >
              <label :for="`product-policy-${key}`" class="adm-label">{{ REGULATORY_LABELS[key] }}</label
              ><textarea
                :id="`product-policy-${key}`"
                v-model="form[key]"
                :maxlength="key === 'manufacturer' ? 160 : 2000"
                :rows="key === 'manufacturer' ? 1 : 3"
                class="adm-input"
              />
            </div>
            <div class="adm-field">
              <label for="product-policy-reason" class="adm-label">Motivo de la asignación</label
              ><input
                id="product-policy-reason"
                v-model="form.reason"
                required
                minlength="10"
                maxlength="500"
                class="adm-input"
              />
            </div>
            <label class="adm-check"
              ><input v-model="form.confirmed" type="checkbox" required /><span
                >He revisado la regla seleccionada, la clasificación y los requisitos de seguridad. No constituye
                aprobación legal.</span
              ></label
            >
            <div>
              <button
                type="submit"
                class="adm-btn adm-btn--secondary"
                :disabled="!options || !form.confirmed || saving"
              >
                Guardar asignación revisada
              </button>
            </div>
          </fieldset>
        </form>
        <div v-if="editable && options" class="flex flex-wrap items-center gap-2">
          <span class="adm-help">Reglas disponibles: página {{ page }} de {{ options.pages || 1 }}</span
          ><button
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="busy || !!command || page <= 1"
            @click="policyPage(page - 1)"
          >
            Anterior</button
          ><button
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="busy || !!command || page >= options.pages"
            @click="policyPage(page + 1)"
          >
            Siguiente
          </button>
        </div>
      </div>
      <UAlert
        v-else
        role="alert"
        color="error"
        variant="subtle"
        title="No se ha podido confirmar una consulta privada vigente."
        description="Comprueba que tienes permiso para publicar el catálogo y la verificación en dos pasos activa. Mientras tanto no se muestran formularios ni datos antiguos."
      />
    </AdminCard>

    <AdminCard
      v-if="snapshot && !(originAuthorized() && (status === 'idle' || status === 'pending' || reading))"
      title="Variantes sin código de barras"
      description="Excepciones documentadas para variantes sin EAN, GTIN ni referencia del fabricante. Se muestra solo la excepción vigente más reciente de cada variante; el historial auditado se conserva. Una excepción con fecha de inicio futura no aparece hasta ese día."
    >
      <div class="adm-stack">
        <ul v-if="snapshot.variants.length" class="adm-list">
          <li v-for="variant in snapshot.variants" :key="variant.id">
            <p class="font-medium text-[var(--text-strong)]">
              Variante {{ variant.legacyId ?? variant.id }}
              <AdminBadge :status="variant.status" class="ml-1" />
            </p>
            <template v-if="variant.identifierException"
              ><p>{{ variant.identifierException.reason }}</p>
              <p class="adm-help">Justificante: {{ variant.identifierException.evidenceReference }}</p>
              <p class="adm-help">
                {{ adminDate(variant.identifierException.validFrom, true) }} —
                {{
                  variant.identifierException.validUntil
                    ? adminDate(variant.identifierException.validUntil, true)
                    : 'sin fecha de fin'
                }}
              </p></template
            >
            <p v-else class="adm-help">Sin excepción vigente.</p>
          </li>
        </ul>
        <p v-else class="adm-help">Este producto no tiene variantes.</p>
        <form
          v-if="
            editable &&
            capability(snapshot.capabilities, 'productIdentifierExceptionsWrite') &&
            exceptionCandidates.length
          "
          class="border-t border-[var(--border)] pt-4"
          @submit.prevent="createException"
        >
          <fieldset :disabled="!writable('productIdentifierExceptionsWrite')" class="adm-stack">
            <legend class="adm-label">Crear una excepción documentada</legend>
            <div class="adm-field">
              <label for="identifier-exception-variant" class="adm-label">Variante sin EAN, GTIN ni MPN</label
              ><select id="identifier-exception-variant" v-model="exceptionForm.variantId" required class="adm-input">
                <option value="" disabled>Selecciona una variante</option>
                <option v-for="variant in exceptionCandidates" :key="variant.id" :value="variant.id">
                  {{ variant.legacyId ?? variant.id }}
                </option>
              </select>
            </div>
            <div class="adm-form-grid">
              <div class="adm-field">
                <label for="identifier-exception-reason" class="adm-label">Motivo de la excepción</label
                ><input
                  id="identifier-exception-reason"
                  v-model="exceptionForm.reason"
                  required
                  minlength="10"
                  maxlength="500"
                  class="adm-input"
                />
              </div>
              <div class="adm-field">
                <label for="identifier-exception-evidence" class="adm-label">Justificante (documento o nota)</label
                ><input
                  id="identifier-exception-evidence"
                  v-model="exceptionForm.evidenceReference"
                  required
                  minlength="3"
                  maxlength="200"
                  class="adm-input"
                />
              </div>
              <div class="adm-field">
                <label for="identifier-exception-from" class="adm-label">Válida desde (fecha y hora UTC)</label
                ><input
                  id="identifier-exception-from"
                  v-model="exceptionForm.validFrom"
                  required
                  placeholder="2026-09-30T10:00:00Z"
                  class="adm-input"
                />
              </div>
              <div class="adm-field">
                <label for="identifier-exception-until" class="adm-label">Válida hasta (opcional, UTC)</label
                ><input
                  id="identifier-exception-until"
                  v-model="exceptionForm.validUntil"
                  placeholder="2027-09-30T10:00:00Z"
                  class="adm-input"
                />
              </div>
            </div>
            <label class="adm-check"
              ><input v-model="exceptionForm.confirmed" type="checkbox" required /><span
                >He revisado que la variante no tiene códigos, el justificante y las fechas. Esto no aprueba legalmente
                el producto ni lo publica.</span
              ></label
            >
            <div>
              <button type="submit" class="adm-btn adm-btn--secondary" :disabled="!exceptionForm.confirmed || saving">
                Registrar excepción
              </button>
            </div>
          </fieldset>
        </form>
        <form
          v-if="
            editable &&
            capability(snapshot.capabilities, 'productIdentifierExceptionsWrite') &&
            withdrawCandidates.length
          "
          class="border-t border-[var(--border)] pt-4"
          @submit.prevent="withdrawException"
        >
          <fieldset :disabled="!writable('productIdentifierExceptionsWrite')" class="adm-stack">
            <legend class="adm-label">Retirar una excepción vigente</legend>
            <div class="adm-form-grid">
              <div class="adm-field">
                <label for="identifier-withdraw-variant" class="adm-label">Excepción de variante</label
                ><select id="identifier-withdraw-variant" v-model="withdrawal.variantId" required class="adm-input">
                  <option value="" disabled>Selecciona una excepción</option>
                  <option v-for="variant in withdrawCandidates" :key="variant.id" :value="variant.id">
                    {{ variant.legacyId ?? variant.id }}
                  </option>
                </select>
              </div>
              <div class="adm-field">
                <label for="identifier-withdraw-reason" class="adm-label">Motivo de retirada</label
                ><input
                  id="identifier-withdraw-reason"
                  v-model="withdrawal.reason"
                  required
                  minlength="10"
                  maxlength="500"
                  class="adm-input"
                />
              </div>
            </div>
            <label class="adm-check"
              ><input v-model="withdrawal.confirmed" type="checkbox" required /><span
                >Confirmo la retirada; el historial se conserva.</span
              ></label
            >
            <div>
              <button type="submit" class="adm-btn adm-btn--danger" :disabled="!withdrawal.confirmed || saving">
                Retirar excepción
              </button>
            </div>
          </fieldset>
        </form>
      </div>
    </AdminCard>

    <UAlert v-if="error" role="alert" color="error" variant="subtle" :title="error" />
    <UAlert v-if="notice" role="status" color="success" variant="subtle" :title="notice" />
    <p v-if="saving" role="status" class="adm-help">Guardando el cambio…</p>
    <div v-if="originAuthorized()" class="flex flex-wrap gap-2">
      <button
        v-if="uncertain"
        type="button"
        class="adm-btn adm-btn--secondary adm-btn--sm"
        :disabled="busy || !command || !commandAuthorized(command)"
        @click="retry"
      >
        Reintentar exactamente el mismo comando</button
      ><button type="button" class="adm-btn adm-btn--ghost adm-btn--sm" :disabled="busy" @click="refreshAll()">
        Volver a cargar
      </button>
    </div>
  </section>
</template>
