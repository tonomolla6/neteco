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
useSeoMeta({ title: 'Políticas de catálogo · Admin' })
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
    'No se puede retirar: hay productos publicados que usan esta política. Ocúltalos mediante su editor de estados antes de volver a revisar la retirada.',
  version_conflict: 'La versión ha cambiado. Consulta de nuevo antes de preparar otro comando.',
  idempotency_conflict:
    'La clave registrada no corresponde a este comando. Consulta de nuevo; no lo repitas con una clave distinta.',
  forbidden: 'No tienes permiso para este cambio. Verifica tu acceso y consulta de nuevo.',
  mfa_required: 'Verifica el segundo factor y consulta de nuevo.',
  unauthenticated: 'Inicia sesión y consulta de nuevo.',
  email_unverified: 'Verifica tu correo y consulta de nuevo.',
  invalid_input: 'Revisa los campos y consulta de nuevo antes de preparar otro comando.',
  conflict: 'El servidor ha rechazado el cambio. Consulta de nuevo.',
  not_found: 'La política no está disponible. Consulta de nuevo.',
  policy_unavailable: 'La política ya no está disponible. Consulta de nuevo.',
  invalid_state: 'El estado actual no permite este cambio. Consulta de nuevo.',
  csrf_rejected: 'El origen no está autorizado. Abre el panel desde su dirección correcta.',
  rate_limited: 'Hay demasiados intentos. Espera antes de consultar de nuevo.',
  body_too_large: 'La petición supera el tamaño permitido. Consulta de nuevo y reduce el texto.'
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
    notice.value = 'Cambio registrado. La consulta actualizada, no el recibo, muestra la política vigente.'
    await reload()
  } catch (cause) {
    if (request !== generation || !authorized(intent)) return
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
        'No se ha podido confirmar el resultado. Puedes reintentar exactamente el mismo comando; no se reenviará automáticamente.'
    }
  } finally {
    saving.value = false
  }
}
async function readList(code = query.code, page = query.page) {
  if (!active || !cloudflare.value || busy.value || (command && !uncertain.value)) return
  if (code && !/^[a-z][a-z0-9_-]{0,63}$/.test(code)) {
    error.value = 'El código del filtro no es válido.'
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
    error.value = 'No se ha podido consultar el catálogo de políticas.'
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
    error.value = 'No se ha podido actualizar la consulta.'
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
    error.value = 'No se ha podido consultar la última versión de este código.'
  } finally {
    reading.value = false
  }
}
async function createPolicy() {
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
    !instant(form.validFrom) ||
    (form.validUntil && (!instant(form.validUntil) || form.validUntil <= form.validFrom)) ||
    form.confirmed !== true
  ) {
    if (writable.value) error.value = 'Revisa los campos, la consulta de versión y la confirmación.'
    return
  }
  const parsed = policyCreateInputSchema.safeParse({
    code: form.code,
    name: form.name,
    expectedVersion: expectedVersion.value,
    requiredFields: [...form.requiredFields],
    requiredMediaRoles: [...form.requiredMediaRoles],
    identifierExceptionsAllowed: form.exceptions === 'true',
    validFrom: form.validFrom,
    validUntil: form.validUntil || null,
    reason: form.reason
  })
  if (!parsed.success) {
    error.value = 'Revisa los campos antes de preparar el comando.'
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
    error.value = 'No se ha podido preparar una clave segura. No se ha enviado ningún cambio.'
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
    error.value = 'No se ha podido preparar una clave segura. No se ha enviado ningún cambio.'
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
  <div class="mx-auto max-w-5xl space-y-6">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">Políticas de publicación</h1>
        <p class="mt-2 text-sm text-[var(--text-muted)]">
          Reglas versionadas y retiradas auditadas. No sustituyen la revisión legal ni autorizan por sí solas una
          publicación.
        </p>
      </div>
      <UButton to="/admin/productos" color="neutral" variant="outline">Volver a productos</UButton>
    </header>
    <p v-if="!cloudflare" role="alert">Esta gestión sólo está disponible en el entorno Cloudflare.</p>
    <p v-else-if="status === 'idle' || status === 'pending' || reading" role="status">Consultando políticas…</p>
    <template v-else-if="snapshot">
      <section class="rounded-xl border border-[var(--border)] bg-white p-5">
        <form class="flex flex-wrap items-end gap-3" @submit.prevent="readList(filter, 1)">
          <div class="flex-1">
            <label for="policy-filter" class="block text-sm font-medium">Filtrar por código exacto</label
            ><input
              id="policy-filter"
              v-model="filter"
              class="mt-1 w-full rounded border p-2"
              maxlength="64"
              placeholder="Sin filtro"
            />
          </div>
          <UButton type="submit" :disabled="busy">Consultar</UButton>
        </form>
        <p class="mt-3 text-sm">
          {{ snapshot.pagination.total }} versiones · página {{ snapshot.pagination.page }} de
          {{ snapshot.pagination.pages || 1 }} ·
          <time :datetime="snapshot.evaluatedAt">{{ snapshot.evaluatedAt }}</time>
        </p>
        <p v-if="!snapshot.items.length" role="status" class="mt-4">No hay políticas en esta consulta.</p>
        <ul v-else class="mt-4 divide-y divide-[var(--border)]">
          <li v-for="item in snapshot.items" :key="item.id" class="py-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h2 class="font-semibold">
                {{ item.name }} <span class="text-sm font-normal">{{ item.code }} · v{{ item.version }}</span>
              </h2>
              <UBadge color="neutral">{{
                item.withdrawn ? 'Retirada' : item.current ? 'Vigente' : 'No vigente'
              }}</UBadge>
            </div>
            <p class="mt-2 text-sm">
              {{ item.assignedProductCount }} productos asignados · {{ item.publishedProductCount }} publicados.
              Vigencia: {{ item.validFrom }} — {{ item.validUntil || 'sin fin definido' }}.
            </p>
            <p class="mt-1 text-sm">
              Campos: {{ item.requiredFields.map((field) => FIELD_LABELS[field]).join(', ') || 'ninguno' }}. Documentos:
              {{ item.requiredMediaRoles.map((role) => ROLE_LABELS[role]).join(', ') || 'ninguno' }}. Excepciones de
              identificador: {{ item.identifierExceptionsAllowed ? 'permitidas con evidencia' : 'no permitidas' }}.
            </p>
            <p v-if="item.publishedProductCount > 0 && !item.withdrawn" class="mt-2 text-sm">
              Retirada bloqueada: oculta primero los productos publicados, mediante su editor de estados.
            </p>
            <UButton
              v-if="snapshot.writable && !item.withdrawn"
              type="button"
              color="neutral"
              variant="outline"
              class="mt-2"
              :aria-label="`Revisar retirada de ${item.name} (${item.code}, versión ${item.version})`"
              :disabled="!writable || item.publishedProductCount > 0"
              @click="reviewWithdrawal(item.id)"
              >Revisar retirada</UButton
            >
          </li>
        </ul>
        <div class="mt-3 flex gap-2">
          <UButton color="neutral" :disabled="busy || query.page <= 1" @click="readList(query.code, query.page - 1)"
            >Anterior</UButton
          ><UButton
            color="neutral"
            :disabled="busy || query.page >= snapshot.pagination.pages"
            @click="readList(query.code, query.page + 1)"
            >Siguiente</UButton
          >
        </div>
      </section>
      <section v-if="snapshot.writable" class="rounded-xl border border-[var(--border)] bg-white p-5">
        <h2 class="text-lg font-semibold">Crear una versión revisada</h2>
        <p class="mt-2 text-sm">
          Cada código identifica una clasificación decidida explícitamente por el responsable. Las versiones existentes
          y su auditoría se conservan.
        </p>
        <form class="mt-4 space-y-4" :aria-busy="saving" @submit.prevent="createPolicy">
          <fieldset :disabled="!writable" class="space-y-4">
            <div class="grid gap-4 sm:grid-cols-2">
              <div>
                <label for="policy-code">Código de clasificación</label
                ><input
                  id="policy-code"
                  v-model="form.code"
                  required
                  maxlength="64"
                  class="mt-1 w-full rounded border p-2"
                /><UButton
                  type="button"
                  color="neutral"
                  class="mt-2"
                  :disabled="!/^[a-z][a-z0-9_-]{0,63}$/.test(form.code)"
                  @click="lookup"
                  >Consultar última versión de este código</UButton
                >
                <p v-if="expectedVersion !== null" role="status" class="mt-2 text-sm">
                  Última versión: {{ expectedVersion }}. Nueva versión: {{ expectedVersion + 1 }}.
                </p>
                <p v-else class="mt-2 text-sm">
                  Consulta el código exacto antes de crear; el listado general no determina la última versión.
                </p>
              </div>
              <div>
                <label for="policy-name">Nombre de la política</label
                ><input
                  id="policy-name"
                  v-model="form.name"
                  required
                  minlength="3"
                  maxlength="160"
                  class="mt-1 w-full rounded border p-2"
                />
              </div>
            </div>
            <fieldset>
              <legend class="font-medium">Campos obligatorios</legend>
              <label v-for="field in FIELDS" :key="field" class="mt-2 flex items-center gap-2 text-sm"
                ><input v-model="form.requiredFields" type="checkbox" :value="field" />{{ FIELD_LABELS[field] }}</label
              >
            </fieldset>
            <fieldset>
              <legend class="font-medium">Roles documentales obligatorios</legend>
              <div class="flex flex-wrap gap-4">
                <label v-for="role in ROLES" :key="role" class="mt-2 flex items-center gap-2 text-sm"
                  ><input v-model="form.requiredMediaRoles" type="checkbox" :value="role" />{{
                    ROLE_LABELS[role]
                  }}</label
                >
              </div>
            </fieldset>
            <div>
              <label for="policy-exceptions">¿Permite excepciones de identificador con evidencia?</label
              ><select id="policy-exceptions" v-model="form.exceptions" required class="mt-1 w-full rounded border p-2">
                <option value="" disabled>Selecciona expresamente</option>
                <option value="false">No</option>
                <option value="true">Sí</option>
              </select>
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <div>
                <label for="policy-from">Vigente desde (UTC, segundos)</label
                ><input
                  id="policy-from"
                  v-model="form.validFrom"
                  required
                  placeholder="2026-09-30T10:00:00Z"
                  class="mt-1 w-full rounded border p-2"
                />
              </div>
              <div>
                <label for="policy-until">Vigente hasta (opcional, UTC)</label
                ><input
                  id="policy-until"
                  v-model="form.validUntil"
                  placeholder="2027-09-30T10:00:00Z"
                  class="mt-1 w-full rounded border p-2"
                />
              </div>
            </div>
            <div>
              <label for="policy-reason">Motivo de la nueva versión</label
              ><input
                id="policy-reason"
                v-model="form.reason"
                required
                minlength="10"
                maxlength="500"
                class="mt-1 w-full rounded border p-2"
              />
            </div>
            <label class="flex items-start gap-2 text-sm"
              ><input v-model="form.confirmed" type="checkbox" required class="mt-1" />He revisado la clasificación, los
              requisitos y la vigencia. Esto no constituye una aprobación legal ni publica productos.</label
            ><UButton type="submit" :disabled="expectedVersion === null || !form.confirmed" :loading="saving"
              >Crear versión de política</UButton
            >
          </fieldset>
        </form>
        <form v-if="selectedWithdrawal" class="mt-6 space-y-3 border-t pt-4" @submit.prevent="withdrawPolicy">
          <fieldset :disabled="!writable" class="space-y-3">
            <legend class="font-semibold">
              Confirmar retirada de {{ selectedWithdrawal.name }} ({{ selectedWithdrawal.code }}, versión
              {{ selectedWithdrawal.version }})
            </legend>
            <label for="policy-withdraw-reason">Motivo de retirada</label
            ><input
              id="policy-withdraw-reason"
              v-model="withdrawReason"
              required
              minlength="10"
              maxlength="500"
              class="w-full rounded border p-2"
            /><label class="flex items-start gap-2 text-sm"
              ><input v-model="withdrawConfirmed" required type="checkbox" class="mt-1" />Confirmo la retirada; se
              conserva el historial y no se ocultan productos automáticamente.</label
            ><UButton type="submit" color="neutral" :disabled="!withdrawConfirmed" :loading="saving"
              >Retirar política</UButton
            >
          </fieldset>
        </form>
      </section>
    </template>
    <p v-else-if="cloudflare" role="alert">
      No se ha podido confirmar una consulta privada válida. Revisa tu permiso catalog.publish y la verificación en dos
      pasos; no se muestran datos guardados.
    </p>
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="notice" role="status" class="text-sm">{{ notice }}</p>
    <p v-if="saving" role="status">Registrando el comando…</p>
    <div v-if="cloudflare" class="flex flex-wrap gap-2">
      <UButton v-if="uncertain" type="button" color="neutral" :disabled="busy || !snapshot?.writable" @click="retry"
        >Reintentar exactamente el mismo comando</UButton
      ><UButton type="button" color="neutral" variant="outline" :disabled="busy" @click="readList()"
        >Consultar de nuevo</UButton
      >
    </div>
  </div>
</template>
