<script setup lang="ts">
import { randomId } from '~/utils/uuid'
import {
  REQUIRED_PUBLICATION_FIELDS,
  PUBLICATION_DOCUMENT_ROLES,
  catalogPolicyCodeSchema,
  catalogPolicyInstantSchema,
  catalogPolicyUuidSchema,
  catalogPolicyOwnJson,
  catalogPolicyReceiptSchema,
  policyCreateInputSchema,
  policyWithdrawInputSchema,
  type CatalogPublicationPolicyView
} from '~~/shared/catalog-publication-policy'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Reglas de publicación · Admin' })
const runtime = useRuntimeConfig()
const cloudflare = computed(() => runtime.public.serverRuntime === 'cloudflare')
const FIELDS = REQUIRED_PUBLICATION_FIELDS
const ROLES = PUBLICATION_DOCUMENT_ROLES
const FIELD_LABELS = {
  usage: 'Modo de empleo',
  series: 'Gama',
  'regulatory.requiresSds': 'Requiere ficha de seguridad',
  'regulatory.safetyInstructions': 'Instrucciones de seguridad',
  'regulatory.hazardStatements': 'Indicaciones de peligro',
  'regulatory.precautionaryStatements': 'Consejos de prudencia',
  'regulatory.manufacturer': 'Fabricante'
}
const ROLE_LABELS = {
  datasheet: 'Ficha técnica',
  sds: 'Ficha de seguridad',
  certificate: 'Certificado',
  label: 'Etiqueta'
}
type Policy = CatalogPublicationPolicyView
type List = {
  items: Policy[]
  pagination: { page: number; perPage: number; total: number; pages: number }
  evaluatedAt: string
  writable: boolean
}
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
function text(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === 'string' &&
    [...value].every((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127) &&
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
function policy(value: unknown): value is Policy {
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
function currentWindow(item: Policy, evaluatedAt: unknown) {
  return (
    !item.current ||
    (instant(evaluatedAt) &&
      item.validFrom <= evaluatedAt &&
      (item.validUntil === null || item.validUntil > evaluatedAt))
  )
}
function list(value: unknown, page: number, perPage: number, code: string): List | null {
  try {
    value = catalogPolicyOwnJson(value)
  } catch {
    return null
  }
  if (
    !own(value, ['source', 'capabilities', 'items', 'pagination', 'evaluatedAt']) ||
    value.source !== 'cloudflare' ||
    !own(value.capabilities, ['publicationPoliciesRead']) ||
    value.capabilities.publicationPoliciesRead !== true ||
    !Array.isArray(value.items) ||
    !value.items.every(policy) ||
    new Set(value.items.map((item) => item.id)).size !== value.items.length ||
    !instant(value.evaluatedAt) ||
    value.items.some((item) => !currentWindow(item, value.evaluatedAt)) ||
    !own(value.pagination, ['page', 'perPage', 'total', 'pages'])
  )
    return null
  const p = value.pagination
  if (
    p.page !== page ||
    p.perPage !== perPage ||
    !integer(p.total) ||
    !integer(p.pages) ||
    p.pages !== Math.ceil(p.total / perPage) ||
    value.items.length > perPage ||
    value.items.length > p.total ||
    (code && value.items.some((item) => item.code !== code))
  )
    return null
  return {
    items: value.items,
    pagination: { page, perPage, total: p.total, pages: p.pages },
    evaluatedAt: value.evaluatedAt,
    writable:
      own(value.capabilities, ['publicationPoliciesWrite']) && value.capabilities.publicationPoliciesWrite === true
  }
}
const view = ref('list')
const filter = ref('')
const query = reactive({ code: '', page: 1 })
const queryUrl = computed(
  () =>
    `/api/admin/catalog/policies?page=${query.page}&perPage=20${query.code ? `&code=${encodeURIComponent(query.code)}` : ''}`
)
const { data, status, refresh } = await useFetch<unknown>(queryUrl, {
  key: computed(() => `admin-catalog-policies-${query.code}-${query.page}-20`),
  method: 'GET',
  immediate: cloudflare.value,
  server: cloudflare.value,
  watch: false
})
const snapshot = computed(() =>
  cloudflare.value && status.value === 'success' ? list(data.value, query.page, 20, query.code) : null
)
const form = reactive({
  code: '',
  name: '',
  requiredFields: [] as string[],
  requiredMediaRoles: [] as string[],
  exceptions: '',
  validFrom: '',
  validUntil: '',
  reason: '',
  confirmed: false
})
const lookupCode = ref('')
const {
  data: latestData,
  status: latestStatus,
  refresh: refreshLatest
} = await useFetch<unknown>(
  computed(() => `/api/admin/catalog/policies?page=1&perPage=1&code=${encodeURIComponent(lookupCode.value)}`),
  {
    key: computed(() => `admin-catalog-policy-latest-${lookupCode.value}`),
    method: 'GET',
    immediate: false,
    watch: false
  }
)
const latest = computed(() =>
  cloudflare.value && latestStatus.value === 'success' && lookupCode.value === form.code
    ? list(latestData.value, 1, 1, lookupCode.value)
    : null
)
const expectedVersion = computed(() =>
  latest.value ? (latest.value.items[0]?.version ?? (latest.value.pagination.total === 0 ? 0 : null)) : null
)
const withdrawal = ref('')
const selectedWithdrawal = computed(() => snapshot.value?.items.find((item) => item.id === withdrawal.value))
const withdrawReason = ref('')
const withdrawConfirmed = ref(false)
const saving = ref(false)
const reading = ref(false)
const blocked = ref(false)
const uncertain = ref(false)
const error = ref('')
const notice = ref('')
type Command = Readonly<{
  action: 'policy_create' | 'policy_withdraw'
  path: string
  payload: string
  key: string
  resource: string | null
  version: number
  code: string
}>
let command: Command | null = null
let active = true
let generation = 0
const busy = computed(
  () => saving.value || reading.value || status.value === 'pending' || latestStatus.value === 'pending'
)
const writable = computed(() => !!snapshot.value?.writable && !blocked.value && !busy.value && !command)
const errors: Record<string, string> = {
  policy_in_use:
    'No se puede retirar: hay productos publicados que usan esta regla. Ocúltalos desde su ficha antes de volver a intentarlo.',
  version_conflict: 'Alguien ha cambiado esta regla mientras tanto. Pulsa «Actualizar» antes de volver a intentarlo.',
  idempotency_conflict:
    'Este cambio ya se había enviado con otros datos. Pulsa «Actualizar» y revisa la lista antes de repetirlo.',
  forbidden: 'No tienes permiso para este cambio.',
  mfa_required: 'Completa la verificación en dos pasos y vuelve a intentarlo.',
  unauthenticated: 'Inicia sesión y vuelve a intentarlo.',
  email_unverified: 'Verifica tu correo y vuelve a intentarlo.',
  invalid_input: 'Revisa los campos y vuelve a intentarlo.',
  conflict: 'No se ha podido guardar el cambio. Pulsa «Actualizar» y vuelve a intentarlo.',
  not_found: 'Esta regla ya no está disponible. Pulsa «Actualizar».',
  policy_unavailable: 'Esta regla ya no está disponible. Pulsa «Actualizar».',
  invalid_state: 'La regla ya no admite este cambio. Pulsa «Actualizar».',
  csrf_rejected: 'Abre el panel desde su dirección habitual y vuelve a intentarlo.',
  rate_limited: 'Hay demasiados intentos. Espera un momento antes de volver a probar.',
  body_too_large: 'El texto es demasiado largo. Acórtalo y vuelve a intentarlo.'
}
function authorized(value: Command) {
  return (
    active &&
    cloudflare.value &&
    status.value === 'success' &&
    !!list(data.value, query.page, 20, query.code)?.writable &&
    (value.action === 'policy_create' || snapshot.value!.items.some((item) => item.id === value.resource))
  )
}
function validReceipt(value: unknown, intent: Command) {
  let parsed
  try {
    parsed = catalogPolicyReceiptSchema.safeParse(catalogPolicyOwnJson(value))
  } catch {
    return false
  }
  if (!parsed.success) return false
  const result = parsed.data
  return (
    result.action === intent.action &&
    (intent.action === 'policy_create'
      ? result.entityId === result.resourceId
      : result.resourceId === intent.resource) &&
    result.policyVersion === intent.version + (intent.action === 'policy_create' ? 1 : 0) &&
    result.productId === null &&
    result.productUuid === null &&
    result.catalogVersion === null
  )
}
async function dispatch(intent: Command, replay: boolean) {
  if (busy.value || !authorized(intent) || typeof window === 'undefined') return
  if (
    !replay &&
    (blocked.value ||
      (intent.action === 'policy_create' && expectedVersion.value !== intent.version) ||
      (intent.action === 'policy_withdraw' &&
        !snapshot.value!.items.some(
          (item) =>
            item.id === intent.resource &&
            item.version === intent.version &&
            !item.withdrawn &&
            item.publishedProductCount === 0
        )))
  )
    return
  saving.value = true
  error.value = ''
  notice.value = ''
  const request = ++generation
  try {
    const result: unknown = await $fetch(intent.path, {
      method: 'POST',
      body: JSON.parse(intent.payload),
      headers: { Origin: window.location.origin, 'Idempotency-Key': intent.key }
    })
    if (request !== generation || !authorized(intent)) return
    if (!validReceipt(result, intent)) throw new Error('unconfirmed_receipt')
    command = null
    uncertain.value = false
    blocked.value = true
    notice.value = 'Cambio registrado. La lista ya muestra las reglas actualizadas.'
    await reload()
  } catch (cause) {
    if (request !== generation || !authorized(intent)) return
    if (!command) {
      error.value = 'El cambio está registrado, pero la lista no se ha actualizado. Pulsa «Actualizar».'
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
        'No sabemos si el cambio se ha guardado. Puedes reintentar exactamente el mismo cambio; no se reenviará solo.'
    }
  } finally {
    saving.value = false
  }
}
async function readList(code = query.code, page = query.page) {
  if (!active || !cloudflare.value || busy.value || (command && !uncertain.value)) return
  if (code && !/^[a-z][a-z0-9_-]{0,63}$/.test(code)) {
    error.value = 'La clave buscada no es válida: usa minúsculas, números y guiones.'
    return
  }
  reading.value = true
  query.code = code
  query.page = page
  try {
    await refresh()
    if (snapshot.value && !command) {
      blocked.value = false
      lookupCode.value = ''
      form.confirmed = false
      withdrawConfirmed.value = false
    }
  } catch {
    error.value = 'No se han podido cargar las reglas.'
  } finally {
    reading.value = false
  }
}
async function reload() {
  // Successful commands may refresh while saving; user retries remain guarded separately.
  if (!active || !cloudflare.value || reading.value || status.value === 'pending') return
  reading.value = true
  try {
    await refresh()
    if (snapshot.value && !command) {
      blocked.value = false
      form.confirmed = false
      withdrawConfirmed.value = false
      lookupCode.value = ''
    }
  } catch {
    error.value = 'No se ha podido actualizar la lista.'
  } finally {
    reading.value = false
  }
}
async function lookup() {
  if (!writable.value || !catalogPolicyCodeSchema.safeParse(form.code).success) return
  reading.value = true
  lookupCode.value = form.code
  try {
    await refreshLatest()
  } catch {
    error.value = 'No se ha podido comprobar la última versión de esta clave.'
  } finally {
    reading.value = false
  }
}
async function createPolicy() {
  // Las fechas se eligen en hora local; la API recibe el instante en UTC.
  const validFrom = adminLocalToIso(form.validFrom),
    validUntil = adminLocalToIso(form.validUntil)
  if (
    !writable.value ||
    expectedVersion.value === null ||
    !latest.value?.writable ||
    expectedVersion.value >= Number.MAX_SAFE_INTEGER ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(form.code) ||
    !text(form.name, 3, 160) ||
    !text(form.reason, 10, 500) ||
    !unique(form.requiredFields, FIELDS) ||
    !unique(form.requiredMediaRoles, ROLES) ||
    !['true', 'false'].includes(form.exceptions) ||
    !instant(validFrom) ||
    (form.validUntil && (!instant(validUntil) || validUntil <= validFrom)) ||
    form.confirmed !== true
  ) {
    if (writable.value) error.value = 'Revisa los campos, comprueba la clave y marca la confirmación.'
    return
  }
  const parsed = policyCreateInputSchema.safeParse({
    code: form.code,
    name: form.name,
    expectedVersion: expectedVersion.value,
    requiredFields: [...form.requiredFields],
    requiredMediaRoles: [...form.requiredMediaRoles],
    identifierExceptionsAllowed: form.exceptions === 'true',
    validFrom,
    validUntil,
    reason: form.reason
  })
  if (!parsed.success) {
    error.value = 'Revisa los campos antes de guardar.'
    return
  }
  try {
    command = Object.freeze({
      action: 'policy_create',
      path: '/api/admin/catalog/policies',
      key: randomId(),
      resource: null,
      version: expectedVersion.value,
      code: form.code,
      payload: JSON.stringify(parsed.data)
    })
  } catch {
    error.value = 'No se ha podido preparar el envío. No se ha guardado ningún cambio.'
    return
  }
  await dispatch(command, false)
}
async function withdrawPolicy() {
  const selected = selectedWithdrawal.value
  if (
    !writable.value ||
    !selected ||
    selected.withdrawn ||
    selected.publishedProductCount > 0 ||
    !text(withdrawReason.value, 10, 500) ||
    withdrawConfirmed.value !== true
  )
    return
  const parsed = policyWithdrawInputSchema.safeParse({
    expectedVersion: selected.version,
    reason: withdrawReason.value
  })
  if (!parsed.success) return
  try {
    command = Object.freeze({
      action: 'policy_withdraw',
      path: `/api/admin/catalog/policies/${selected.id}/withdraw`,
      key: randomId(),
      resource: selected.id,
      version: selected.version,
      code: selected.code,
      payload: JSON.stringify(parsed.data)
    })
  } catch {
    error.value = 'No se ha podido preparar el envío. No se ha guardado ningún cambio.'
    return
  }
  await dispatch(command, false)
}
function reviewWithdrawal(id: string) {
  if (
    !writable.value ||
    !snapshot.value?.items.some((item) => item.id === id && !item.withdrawn && item.publishedProductCount === 0)
  )
    return
  withdrawal.value = id
  withdrawReason.value = ''
  withdrawConfirmed.value = false
}
async function retry() {
  if (uncertain.value && command) await dispatch(command, true)
}
watch(
  () => form.code,
  () => {
    lookupCode.value = ''
    form.confirmed = false
  }
)
onBeforeUnmount(() => {
  active = false
  ++generation
  command = null
})
</script>

<template>
  <AdminPage>
    <template #actions>
      <button v-if="cloudflare" type="button" class="adm-btn adm-btn--secondary" :disabled="busy" @click="readList()">
        <UIcon name="i-lucide-rotate-cw" class="size-4" />Actualizar
      </button>
      <button v-if="snapshot?.writable" type="button" class="adm-btn adm-btn--primary" @click="view = 'create'">
        <UIcon name="i-lucide-plus" class="size-4" />Nueva regla
      </button>
    </template>
    <div class="adm-stack">
      <div v-if="error" role="alert">
        <UAlert color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />
      </div>
      <div v-if="notice" role="status">
        <UAlert color="success" variant="subtle" icon="i-lucide-circle-check" :description="notice" />
      </div>
      <p v-if="saving" role="status" class="adm-help">Guardando el cambio…</p>
      <div v-if="cloudflare && uncertain">
        <button type="button" class="adm-btn adm-btn--secondary" :disabled="busy || !snapshot?.writable" @click="retry">
          Reintentar exactamente el mismo cambio
        </button>
      </div>

      <div v-if="!cloudflare" role="alert">
        <AdminEmptyState
          icon="i-lucide-shield-check"
          title="Las reglas de publicación no están disponibles"
          description="Esta instalación de la tienda no permite gestionarlas desde el panel."
        />
      </div>
      <div
        v-else-if="status === 'idle' || status === 'pending' || reading"
        role="status"
        class="adm-card adm-table-skeleton"
        aria-busy="true"
      >
        <span class="sr-only">Cargando las reglas…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
      </div>
      <template v-else-if="snapshot">
        <AdminTabs
          v-if="snapshot.writable"
          v-model="view"
          :tabs="[
            { value: 'list', label: 'Reglas', count: snapshot.pagination.total },
            { value: 'create', label: 'Nueva regla o versión' }
          ]"
          label="Apartados de las reglas de publicación"
        />

        <div v-show="view === 'list' || !snapshot.writable" class="adm-stack">
          <div class="adm-card adm-tablecard">
            <div class="adm-tablecard__bar">
              <form class="adm-toolbar" role="search" @submit.prevent="readList(filter, 1)">
                <label for="policy-filter" class="adm-toolbar__search">
                  <span class="sr-only">Buscar por clave exacta</span>
                  <UIcon name="i-lucide-search" class="size-4" />
                  <input
                    id="policy-filter"
                    v-model="filter"
                    type="search"
                    maxlength="64"
                    placeholder="Buscar por clave exacta…"
                  />
                </label>
                <button type="submit" class="adm-btn adm-btn--secondary adm-btn--sm" :disabled="busy">Buscar</button>
              </form>
            </div>
            <div v-if="!snapshot.items.length" role="status">
              <AdminEmptyState
                :variant="query.code ? 'filtered' : 'empty'"
                icon="i-lucide-shield-check"
                title="No hay reglas en esta consulta"
                :description="
                  query.code
                    ? 'Ninguna regla tiene exactamente esa clave. Borra la búsqueda para verlas todas.'
                    : 'Crea la primera regla para decidir qué debe tener una ficha antes de publicarse.'
                "
              />
            </div>
            <div v-else class="adm-table-wrap">
              <table class="adm-table">
                <caption class="sr-only">
                  Reglas de publicación
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Regla</th>
                    <th scope="col">Qué exige</th>
                    <th scope="col">Validez</th>
                    <th scope="col" data-numeric>Productos</th>
                    <th scope="col">Estado</th>
                    <th v-if="snapshot.writable" scope="col" data-numeric><span class="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in snapshot.items" :key="item.id">
                    <td class="align-top">
                      <h2 class="text-sm font-semibold text-[var(--text-strong)]">{{ item.name }}</h2>
                      <p class="adm-help">Clave {{ item.code }} · versión {{ item.version }}</p>
                    </td>
                    <td class="min-w-56 align-top text-[0.8125rem] whitespace-normal">
                      <p>
                        <span class="text-[var(--text-muted)]">Datos:</span>
                        {{ item.requiredFields.map((field) => FIELD_LABELS[field]).join(', ') || 'ninguno' }}
                      </p>
                      <p>
                        <span class="text-[var(--text-muted)]">Documentos:</span>
                        {{ item.requiredMediaRoles.map((role) => ROLE_LABELS[role]).join(', ') || 'ninguno' }}
                      </p>
                      <p class="adm-help">
                        {{
                          item.identifierExceptionsAllowed
                            ? 'Admite productos sin código de barras si se justifica'
                            : 'No admite productos sin código de barras'
                        }}
                      </p>
                    </td>
                    <td class="align-top text-[0.8125rem]">
                      <time :datetime="item.validFrom">{{ adminDate(item.validFrom, true) }}</time>
                      <p class="adm-help">
                        <template v-if="item.validUntil">
                          hasta <time :datetime="item.validUntil">{{ adminDate(item.validUntil, true) }}</time>
                        </template>
                        <template v-else>sin fecha de fin</template>
                      </p>
                    </td>
                    <td data-numeric class="align-top">
                      {{ item.assignedProductCount }}
                      <p class="adm-help">{{ item.publishedProductCount }} publicados</p>
                    </td>
                    <td class="align-top">
                      <AdminBadge :tone="item.withdrawn ? 'neutral' : item.current ? 'success' : 'warning'">{{
                        item.withdrawn ? 'Retirada' : item.current ? 'Vigente' : 'No vigente'
                      }}</AdminBadge>
                    </td>
                    <td v-if="snapshot.writable" data-numeric class="adm-table__actions align-top">
                      <button
                        v-if="!item.withdrawn"
                        type="button"
                        class="adm-btn adm-btn--danger-soft adm-btn--sm"
                        :aria-label="`Revisar retirada de ${item.name} (${item.code}, versión ${item.version})`"
                        :disabled="!writable || item.publishedProductCount > 0"
                        @click="reviewWithdrawal(item.id)"
                      >
                        Revisar retirada
                      </button>
                      <p
                        v-if="item.publishedProductCount > 0 && !item.withdrawn"
                        class="adm-help mt-1 max-w-56 text-right whitespace-normal"
                      >
                        Retirada bloqueada: oculta antes los productos publicados que la usan.
                      </p>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="adm-pagination">
              <p>
                {{ snapshot.pagination.total }} {{ snapshot.pagination.total === 1 ? 'versión' : 'versiones' }} · página
                {{ snapshot.pagination.page }} de {{ snapshot.pagination.pages || 1 }} · actualizado
                <time :datetime="snapshot.evaluatedAt">{{ adminDate(snapshot.evaluatedAt, true) }}</time>
              </p>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  :disabled="busy || query.page <= 1"
                  @click="readList(query.code, query.page - 1)"
                >
                  <UIcon name="i-lucide-chevron-left" class="size-4" />Anterior
                </button>
                <button
                  type="button"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  :disabled="busy || query.page >= snapshot.pagination.pages"
                  @click="readList(query.code, query.page + 1)"
                >
                  Siguiente<UIcon name="i-lucide-chevron-right" class="size-4" />
                </button>
              </div>
            </div>
          </div>

          <AdminCard v-if="snapshot.writable && selectedWithdrawal" title="Retirar una regla">
            <form class="adm-stack" @submit.prevent="withdrawPolicy">
              <fieldset :disabled="!writable" class="adm-stack">
                <legend class="mb-3 text-sm font-semibold text-[var(--text-strong)]">
                  Confirmar retirada de {{ selectedWithdrawal.name }} ({{ selectedWithdrawal.code }}, versión
                  {{ selectedWithdrawal.version }})
                </legend>
                <div class="adm-field">
                  <label for="policy-withdraw-reason" class="adm-label">Motivo de la retirada</label>
                  <input
                    id="policy-withdraw-reason"
                    v-model="withdrawReason"
                    required
                    minlength="10"
                    maxlength="500"
                    class="adm-input w-full"
                  />
                  <p class="adm-help">Entre 10 y 500 caracteres. Queda guardado en el historial.</p>
                </div>
                <label class="adm-check"
                  ><input v-model="withdrawConfirmed" required type="checkbox" />Confirmo la retirada. Se conserva el
                  historial y no se oculta ningún producto automáticamente.</label
                >
                <div class="flex flex-wrap justify-end gap-2">
                  <button type="button" class="adm-btn adm-btn--secondary" @click="withdrawal = ''">Cancelar</button>
                  <button
                    type="submit"
                    class="adm-btn adm-btn--danger"
                    :disabled="!withdrawConfirmed || saving"
                    :aria-busy="saving"
                  >
                    Retirar regla
                  </button>
                </div>
              </fieldset>
            </form>
          </AdminCard>
        </div>

        <AdminCard
          v-if="snapshot.writable"
          v-show="view === 'create'"
          title="Nueva regla o nueva versión"
          description="Usa una clave nueva para crear una regla, o la clave de una existente para sustituirla por una versión nueva. Las versiones anteriores se conservan."
        >
          <form id="policy-create-form" class="adm-stack" :aria-busy="saving" @submit.prevent="createPolicy">
            <fieldset :disabled="!writable" class="adm-stack">
              <div class="adm-form-grid">
                <div class="adm-field">
                  <label for="policy-code" class="adm-label">Clave de la regla</label>
                  <div class="flex flex-wrap gap-2">
                    <input
                      id="policy-code"
                      v-model="form.code"
                      required
                      maxlength="64"
                      class="adm-input min-w-0 flex-1"
                    />
                    <button
                      type="button"
                      class="adm-btn adm-btn--secondary"
                      :disabled="!/^[a-z][a-z0-9_-]{0,63}$/.test(form.code)"
                      @click="lookup"
                    >
                      Comprobar clave
                    </button>
                  </div>
                  <p v-if="expectedVersion !== null" role="status" class="adm-help">
                    Última versión: {{ expectedVersion }}. Nueva versión: {{ expectedVersion + 1 }}.
                  </p>
                  <p v-else class="adm-help">
                    Solo minúsculas, números y guiones. Consulta el código exacto antes de crear: así sabremos qué
                    versión toca.
                  </p>
                </div>
                <div class="adm-field">
                  <label for="policy-name" class="adm-label">Nombre de la regla</label>
                  <input
                    id="policy-name"
                    v-model="form.name"
                    required
                    minlength="3"
                    maxlength="160"
                    class="adm-input w-full"
                  />
                </div>
              </div>
              <fieldset>
                <legend class="adm-label">Datos obligatorios en la ficha</legend>
                <div class="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                  <label v-for="field in FIELDS" :key="field" class="adm-check"
                    ><input v-model="form.requiredFields" type="checkbox" :value="field" />{{
                      FIELD_LABELS[field]
                    }}</label
                  >
                </div>
              </fieldset>
              <fieldset>
                <legend class="adm-label">Documentos obligatorios</legend>
                <div class="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                  <label v-for="role in ROLES" :key="role" class="adm-check"
                    ><input v-model="form.requiredMediaRoles" type="checkbox" :value="role" />{{
                      ROLE_LABELS[role]
                    }}</label
                  >
                </div>
              </fieldset>
              <div class="adm-form-grid">
                <div class="adm-field">
                  <label for="policy-exceptions" class="adm-label"
                    >¿Admite productos sin código de barras si se justifica?</label
                  >
                  <select id="policy-exceptions" v-model="form.exceptions" required class="adm-input w-full">
                    <option value="" disabled>Elige una opción</option>
                    <option value="false">No</option>
                    <option value="true">Sí</option>
                  </select>
                </div>
                <div class="adm-field">
                  <label for="policy-from" class="adm-label">Válida desde</label>
                  <input
                    id="policy-from"
                    v-model="form.validFrom"
                    type="datetime-local"
                    required
                    class="adm-input w-full"
                  />
                </div>
                <div class="adm-field">
                  <label for="policy-until" class="adm-label">Válida hasta (opcional)</label>
                  <input id="policy-until" v-model="form.validUntil" type="datetime-local" class="adm-input w-full" />
                  <p class="adm-help">Déjalo vacío si no tiene fecha de fin.</p>
                </div>
              </div>
              <div class="adm-field">
                <label for="policy-reason" class="adm-label">Motivo del cambio</label>
                <input
                  id="policy-reason"
                  v-model="form.reason"
                  required
                  minlength="10"
                  maxlength="500"
                  class="adm-input w-full"
                />
                <p class="adm-help">Entre 10 y 500 caracteres. Queda guardado en el historial.</p>
              </div>
              <label class="adm-check"
                ><input v-model="form.confirmed" type="checkbox" required />He revisado los requisitos y las fechas.
                Guardar la regla no publica ningún producto ni sustituye la revisión legal.</label
              >
              <div class="flex flex-wrap justify-end gap-2">
                <button type="button" class="adm-btn adm-btn--secondary" @click="view = 'list'">Cancelar</button>
                <button
                  type="submit"
                  class="adm-btn adm-btn--primary"
                  :disabled="expectedVersion === null || !form.confirmed || saving"
                  :aria-busy="saving"
                >
                  Guardar regla
                </button>
              </div>
            </fieldset>
          </form>
        </AdminCard>
      </template>
      <div v-else-if="cloudflare" role="alert">
        <AdminEmptyState
          variant="error"
          title="No se han podido cargar las reglas"
          description="Comprueba que tu usuario puede publicar el catálogo y que has pasado la verificación en dos pasos, y pulsa «Actualizar»."
        />
      </div>
    </div>
  </AdminPage>
</template>
