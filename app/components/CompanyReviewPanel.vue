<script setup lang="ts">
import {
  companyReviewQuerySchema,
  companyReviewInputSchema,
  companyReviewListSchema,
  companyReviewReceiptSchema,
  companyReviewCommandSchema,
  type CompanyReviewInput,
  type CompanyReviewItem,
  type CompanyReviewReceipt
} from '~~/shared/company-review'
import { COMPANY_STATUSES, companyStatusCanTransition } from '../../server/domain/company'
import { adminCapabilitiesSchema } from '~~/shared/admin-navigation'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
import { useAdminNavigation } from '../composables/useAdminNavigation'
import { randomId } from '../utils/uuid'

const props = defineProps<{ runtime: unknown }>()
const session = useUserSession(),
  request = useRequestFetch(),
  prefix = useId()
const navigation = props.runtime === 'cloudflare' ? useAdminNavigation() : null
const actor = computed(() => {
  if (
    props.runtime !== 'cloudflare' ||
    session.ready.value !== true ||
    !session.loggedIn.value ||
    session.user.value?.emailVerified !== true ||
    session.user.value?.mfaVerified !== true ||
    navigation?.status.value !== 'ready'
  )
    return null
  const result = adminCapabilitiesSchema.safeParse(catalogPolicyOwnJson(navigation.capabilities.value))
  if (
    !result.success ||
    result.data.state !== 'ready' ||
    !result.data.permissions.includes('administration.manage') ||
    result.data.identityId !== session.user.value.id ||
    result.data.sessionId !== session.session.value?.sessionId ||
    result.data.sessionVersion !== session.session.value?.sessionVersion
  )
    return null
  return `${result.data.identityId}:${result.data.sessionId}:${result.data.sessionVersion}`
})
const labels: Record<CompanyReviewItem['status'], string> = {
  pending: 'En revisión',
  approved: 'Aprobada',
  rejected: 'No aprobada',
  suspended: 'Suspendida'
}
const tones: Record<CompanyReviewItem['status'], 'warning' | 'success' | 'danger' | 'neutral'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  suspended: 'neutral'
}
const snapshot = shallowRef<ReturnType<typeof companyReviewListSchema.parse> | null>(null),
  receipt = shallowRef<CompanyReviewReceipt | null>(null)
const query = ref(''),
  filterStatus = ref(''),
  appliedQuery = ref(''),
  appliedStatus = ref(''),
  page = ref(1)
const readStatus = ref<'idle' | 'pending' | 'ready' | 'error'>('idle'),
  busy = ref<'read' | 'put' | 'lookup' | null>(null)
const target = shallowRef<CompanyReviewItem | null>(null),
  selectedStatus = ref<CompanyReviewItem['status']>('pending'),
  reason = ref('')
const unknown = ref(false),
  retryReady = ref(false),
  canDiscard = ref(false),
  message = ref('')
type Intent = Readonly<{
  owner: string
  companyId: string
  key: string
  status: CompanyReviewItem['status']
  body: Readonly<CompanyReviewInput> | null
}>
const intent = shallowRef<Intent | null>(null)
const locked = computed(() => intent.value !== null || busy.value === 'put' || busy.value === 'lookup')
const transitions = computed(() =>
  target.value ? COMPANY_STATUSES.filter((status) => companyStatusCanTransition(target.value!.status, status)) : []
)
let alive = true,
  epoch = 0,
  readSequence = 0
function live(owner: string | null, generation: number) {
  return alive && owner !== null && actor.value === owner && epoch === generation
}
function clearForm() {
  target.value = null
  reason.value = ''
}
function reset() {
  epoch++
  readSequence++
  snapshot.value = null
  receipt.value = null
  clearForm()
  intent.value = null
  unknown.value = false
  retryReady.value = false
  canDiscard.value = false
  busy.value = null
  readStatus.value = 'idle'
  message.value = ''
  query.value = ''
  appliedQuery.value = ''
  filterStatus.value = ''
  appliedStatus.value = ''
  page.value = 1
}
watch(
  actor,
  () => {
    reset()
    if (actor.value) void load()
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  reset()
})
async function load(recover = false): Promise<boolean> {
  const owner = actor.value,
    generation = epoch,
    sequence = ++readSequence,
    requestedPage = page.value
  if (!owner || !alive || busy.value || (intent.value && !recover)) return false
  const parsedQuery = companyReviewQuerySchema.safeParse({
    q: appliedQuery.value,
    ...(appliedStatus.value ? { status: appliedStatus.value } : {}),
    page: requestedPage,
    perPage: 20
  })
  if (!parsedQuery.success) {
    message.value = 'Revisa la búsqueda (máximo 100 caracteres).'
    return false
  }
  busy.value = 'read'
  readStatus.value = 'pending'
  snapshot.value = null
  try {
    const raw = await request<unknown>('/api/admin/companies', {
      method: 'GET',
      query: parsedQuery.data,
      retry: 0,
      cache: 'no-store'
    })
    if (!live(owner, generation) || sequence !== readSequence) return false
    const value = companyReviewListSchema.parse(catalogPolicyOwnJson(raw))
    if (
      value.page !== requestedPage ||
      value.perPage !== 20 ||
      new Set(value.items.map((item) => item.id)).size !== value.items.length
    )
      throw new Error('unconfirmed_company_page')
    snapshot.value = value
    readStatus.value = 'ready'
    return true
  } catch {
    if (live(owner, generation) && sequence === readSequence) {
      snapshot.value = null
      readStatus.value = 'error'
    }
    return false
  } finally {
    if (live(owner, generation) && sequence === readSequence) busy.value = null
  }
}
function filter() {
  if (locked.value || busy.value || !actor.value) return
  appliedQuery.value = query.value.trim()
  appliedStatus.value = filterStatus.value
  page.value = 1
  clearForm()
  void load()
}
function move(delta: number) {
  if (locked.value || busy.value || readStatus.value !== 'ready' || !snapshot.value) return
  const next = page.value + delta
  if (next < 1 || (delta > 0 && page.value * 20 >= snapshot.value.total)) return
  page.value = next
  clearForm()
  void load()
}
function begin(item: CompanyReviewItem) {
  if (!actor.value || !alive || locked.value || busy.value || readStatus.value !== 'ready') return
  const current = snapshot.value?.items.find(
    (row) => row.id === item.id && row.status === item.status && row.currentChangeId === item.currentChangeId
  )
  if (!current) return
  target.value = current
  selectedStatus.value = current.status
  reason.value = ''
  message.value = ''
  receipt.value = null
}
function validReceipt(raw: unknown, command: Intent) {
  const value = companyReviewReceiptSchema.parse(catalogPolicyOwnJson(raw))
  if (value.companyId !== command.companyId || value.commandId !== command.key || value.status !== command.status)
    throw new Error('unconfirmed_review_receipt')
  return value
}
async function finish(value: CompanyReviewReceipt) {
  receipt.value = value
  intent.value = null
  unknown.value = false
  retryReady.value = false
  canDiscard.value = false
  clearForm()
  busy.value = null
  message.value = ''
  await load()
}
async function send(command: Intent) {
  const generation = epoch
  if (!live(command.owner, generation) || busy.value || !command.body) return
  const originalUncertain = unknown.value || retryReady.value
  busy.value = 'put'
  unknown.value = false
  retryReady.value = false
  canDiscard.value = false
  message.value = ''
  try {
    const raw = await request<unknown>(`/api/admin/companies/${command.companyId}`, {
      method: 'PUT',
      body: { ...command.body },
      headers: { 'Idempotency-Key': command.key },
      retry: 0
    })
    if (!live(command.owner, generation)) return
    await finish(validReceipt(raw, command))
  } catch (cause) {
    if (!live(command.owner, generation)) return
    const code = (cause as { data?: { error?: { code?: string } } })?.data?.error?.code
    const failure = cause as { statusCode?: number; status?: number; response?: { status?: number } }
    const httpStatus = failure?.statusCode ?? failure?.status ?? failure?.response?.status
    if (httpStatus === 401 || httpStatus === 403) {
      snapshot.value = null
      receipt.value = null
      clearForm()
      intent.value = Object.freeze({ ...command, body: null })
      readStatus.value = 'error'
      readSequence++
    }
    const noEffect =
      (code === 'invalid_input' && (httpStatus === 400 || httpStatus === 413)) ||
      (code === 'invalid_tax_id' && httpStatus === 409) ||
      (code === 'csrf_rejected' && httpStatus === 403) ||
      (code === 'rate_limited' && httpStatus === 429)
    if (noEffect && !originalUncertain) {
      intent.value = null
      unknown.value = false
      message.value =
        'El servidor ha rechazado esta revisión antes de aplicarla. Revisa los datos o espera antes de confirmar otra vez.'
    } else {
      unknown.value = true
      message.value =
        'No se ha podido confirmar el resultado. Consulta el recibo antes de decidir; no se enviará otra revisión automáticamente.'
    }
  } finally {
    if (live(command.owner, generation) && busy.value === 'put') busy.value = null
  }
}
async function submit() {
  if (!actor.value || !alive || locked.value || busy.value || !target.value) return
  const parsed = companyReviewInputSchema.safeParse({
    expectedChangeId: target.value.currentChangeId,
    expectedStatus: target.value.status,
    status: selectedStatus.value,
    reason: reason.value
  })
  if (!parsed.success || !companyStatusCanTransition(target.value.status, parsed.data.status)) {
    message.value = 'Elige una transición válida y escribe un motivo de 3 a 500 caracteres.'
    return
  }
  const command = Object.freeze({
    owner: actor.value,
    companyId: target.value.id,
    key: randomId(),
    status: parsed.data.status,
    body: Object.freeze({ ...parsed.data })
  })
  intent.value = command
  await send(command)
}
async function check() {
  const command = intent.value,
    generation = epoch
  if (!command || !unknown.value || busy.value || !live(command.owner, generation)) return
  busy.value = 'lookup'
  retryReady.value = false
  canDiscard.value = false
  try {
    const raw = await request<unknown>(`/api/admin/companies/${command.companyId}/commands/${command.key}`, {
      method: 'GET',
      retry: 0,
      cache: 'no-store'
    })
    if (!live(command.owner, generation)) return
    const value = companyReviewCommandSchema.parse(catalogPolicyOwnJson(raw))
    if (value.companyId !== command.companyId || value.commandId !== command.key)
      throw new Error('unconfirmed_review_command')
    if (value.outcome === 'applied') {
      await finish(validReceipt(value.receipt, command))
      return
    }
    busy.value = null
    retryReady.value = command.body !== null
    message.value = command.body
      ? 'El recibo sigue siendo desconocido: esto no acredita que no haya cambios. Puedes repetir sólo la misma intención o revisar el estado actual.'
      : 'El recibo sigue siendo desconocido: esto no acredita que no haya cambios. Los datos privados de la intención se han eliminado; sólo puedes consultar el recibo y el estado actual.'
    canDiscard.value = await load(true)
  } catch (cause) {
    if (live(command.owner, generation)) {
      const failure = cause as { statusCode?: number; status?: number; response?: { status?: number } }
      const httpStatus = failure?.statusCode ?? failure?.status ?? failure?.response?.status
      if (httpStatus === 401 || httpStatus === 403) {
        snapshot.value = null
        receipt.value = null
        clearForm()
        intent.value = Object.freeze({ ...command, body: null })
        readStatus.value = 'error'
        readSequence++
      }
      message.value = 'No se ha podido verificar el recibo. La intención original permanece bloqueada.'
    }
  } finally {
    if (live(command.owner, generation) && busy.value === 'lookup') busy.value = null
  }
}
function replay() {
  if (retryReady.value && intent.value?.body && !busy.value) void send(intent.value)
}
function discard() {
  if (!canDiscard.value || busy.value || !actor.value) return
  intent.value = null
  unknown.value = false
  retryReady.value = false
  canDiscard.value = false
  clearForm()
  message.value =
    'Se ha descartado sólo la intención local; no se ha deshecho ni confirmado ningún cambio del servidor.'
}
/* --- Estado de interfaz: panel lateral de revisión y confirmación del rechazo --- */
const pageCount = computed(() => (snapshot.value ? Math.max(1, Math.ceil(snapshot.value.total / 20)) : 1))
const drawerOpen = computed({
  get: () => target.value !== null && !unknown.value,
  set: (value: boolean) => {
    if (!value && !locked.value && !busy.value) clearForm()
  }
})
const confirmReject = ref(false)
function requestSubmit() {
  if (selectedStatus.value === 'rejected' && target.value?.status !== 'rejected') confirmReject.value = true
  else void submit()
}
function confirmRejection() {
  confirmReject.value = false
  void submit()
}
function clearFilters() {
  query.value = ''
  filterStatus.value = ''
  filter()
}
function customerLink(item: CompanyReviewItem) {
  return { path: '/admin/clientes/contexto', query: { q: item.legalName.slice(0, 80) } }
}
</script>
<template>
  <section aria-label="Revisión de cuentas profesionales" class="adm-stack min-w-0">
    <UAlert
      v-if="!actor"
      role="status"
      color="warning"
      variant="subtle"
      icon="i-lucide-lock"
      title="No puedes revisar empresas con esta sesión"
      description="Hace falta haber iniciado sesión con el correo verificado, la verificación en dos pasos y permiso de administración."
    />
    <template v-else>
      <UAlert
        v-if="message && !drawerOpen"
        role="alert"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        class="break-words"
        :title="message"
      />
      <UAlert
        v-if="receipt"
        data-company-confirmed
        role="status"
        color="success"
        variant="subtle"
        icon="i-lucide-circle-check"
        :title="`Revisión guardada: ${labels[receipt.status].toLowerCase()}`"
      />
      <AdminCard
        v-if="unknown"
        data-company-unknown
        role="alert"
        title="No sabemos si el cambio se ha guardado"
        description="La conexión falló al guardar. Comprueba el resultado antes de volver a intentarlo, para no aplicar el cambio dos veces."
      >
        <div class="flex flex-wrap gap-2">
          <button type="button" data-company-check :disabled="!!busy" class="adm-btn adm-btn--primary" @click="check">
            Comprobar si se guardó
          </button>
          <button
            v-if="retryReady"
            type="button"
            data-company-replay
            :disabled="!!busy"
            class="adm-btn adm-btn--secondary"
            @click="replay"
          >
            Repetir el mismo cambio
          </button>
          <button
            v-if="canDiscard"
            type="button"
            data-company-discard
            :disabled="!!busy"
            class="adm-btn adm-btn--ghost"
            @click="discard"
          >
            Dejarlo como está
          </button>
        </div>
      </AdminCard>

      <div class="adm-card adm-tablecard">
        <div class="adm-tablecard__bar">
          <form data-company-filter class="adm-toolbar" role="search" @submit.prevent="filter">
            <label class="adm-toolbar__search" :for="`${prefix}-query`">
              <span class="sr-only">Buscar por nombre, NIF o correo</span>
              <UIcon name="i-lucide-search" class="size-4" />
              <input
                :id="`${prefix}-query`"
                v-model="query"
                data-company-query
                type="search"
                maxlength="100"
                placeholder="Buscar por nombre, NIF o correo"
                :disabled="locked || !!busy"
              />
            </label>
            <select
              :id="`${prefix}-status`"
              v-model="filterStatus"
              data-company-filter-status
              class="adm-input"
              aria-label="Filtrar por estado"
              :disabled="locked || !!busy"
            >
              <option value="">Todos los estados</option>
              <option v-for="status in COMPANY_STATUSES" :key="status" :value="status">{{ labels[status] }}</option>
            </select>
            <button type="submit" :disabled="locked || !!busy" class="adm-btn adm-btn--secondary">Filtrar</button>
            <button
              v-if="appliedQuery || appliedStatus"
              type="button"
              :disabled="locked || !!busy"
              class="adm-btn adm-btn--ghost"
              @click="clearFilters"
            >
              Quitar filtros
            </button>
          </form>
        </div>

        <AdminEmptyState
          v-if="readStatus === 'error'"
          data-company-read-error
          role="alert"
          variant="error"
          title="No se han podido cargar las empresas"
          description="Puede ser un fallo de conexión o de permisos. Vuelve a intentarlo."
        >
          <button
            type="button"
            data-company-retry
            :disabled="locked || !!busy"
            class="adm-btn adm-btn--secondary"
            @click="load()"
          >
            <UIcon name="i-lucide-rotate-cw" class="size-4" />Reintentar
          </button>
        </AdminEmptyState>
        <div v-else-if="readStatus === 'pending' || !snapshot" class="adm-table-skeleton" aria-busy="true">
          <span class="sr-only" role="status">Cargando empresas…</span>
          <div v-for="row in 6" :key="row"><i /><i /><i /><i /></div>
        </div>
        <AdminEmptyState
          v-else-if="snapshot.items.length === 0"
          data-company-empty
          :variant="appliedQuery || appliedStatus ? 'filtered' : 'empty'"
          icon="i-lucide-building-2"
          :title="
            appliedQuery || appliedStatus ? 'Ninguna empresa con estos filtros' : 'Todavía no hay empresas registradas'
          "
          :description="
            appliedQuery || appliedStatus
              ? 'Prueba con otra búsqueda o quita algún filtro.'
              : 'Cuando un cliente pida cuenta de empresa, aparecerá aquí para que la revises.'
          "
        />
        <template v-else>
          <div class="adm-table-wrap hidden md:block">
            <table class="adm-table">
              <caption class="sr-only">
                Empresas y estado de su validación
              </caption>
              <thead>
                <tr>
                  <th scope="col">Empresa</th>
                  <th scope="col">NIF</th>
                  <th scope="col">Contacto</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Alta</th>
                  <th scope="col" data-numeric><span class="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in snapshot.items" :key="item.id">
                  <td>
                    <p class="font-semibold text-[var(--text-strong)]">{{ item.legalName }}</p>
                    <p v-if="item.tradeName" class="text-xs text-[var(--text-muted)]">{{ item.tradeName }}</p>
                  </td>
                  <td class="tabular-nums">{{ item.taxId ? `${item.countryCode} · ${item.taxId}` : 'Sin NIF' }}</td>
                  <td class="break-all">{{ item.contactEmail || 'Sin correo' }}</td>
                  <td>
                    <AdminBadge :tone="tones[item.status]">{{ labels[item.status] }}</AdminBadge>
                    <p v-if="item.rejectionReason" class="mt-1 max-w-xs text-xs text-[var(--text-muted)]">
                      {{ item.rejectionReason }}
                    </p>
                  </td>
                  <td class="whitespace-nowrap">{{ adminDate(item.createdAt) }}</td>
                  <td data-numeric class="adm-table__actions">
                    <NuxtLink :to="customerLink(item)" class="adm-btn adm-btn--ghost adm-btn--sm">
                      Ficha de cliente
                    </NuxtLink>
                    <button
                      type="button"
                      data-company-review
                      :disabled="locked || !!busy"
                      class="adm-btn adm-btn--secondary adm-btn--sm"
                      @click="begin(item)"
                    >
                      Revisar
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <ul class="adm-table-cards md:hidden">
            <li v-for="item in snapshot.items" :key="item.id">
              <dl>
                <div>
                  <dt>Empresa</dt>
                  <dd>{{ item.legalName }}</dd>
                </div>
                <div>
                  <dt>NIF</dt>
                  <dd>{{ item.taxId ? `${item.countryCode} · ${item.taxId}` : 'Sin NIF' }}</dd>
                </div>
                <div>
                  <dt>Contacto</dt>
                  <dd class="break-all">{{ item.contactEmail || 'Sin correo' }}</dd>
                </div>
                <div>
                  <dt>Estado</dt>
                  <dd>
                    <AdminBadge :tone="tones[item.status]">{{ labels[item.status] }}</AdminBadge>
                  </dd>
                </div>
                <div>
                  <dt>Alta</dt>
                  <dd>{{ adminDate(item.createdAt) }}</dd>
                </div>
              </dl>
              <div class="adm-table-cards__actions">
                <NuxtLink :to="customerLink(item)" class="adm-btn adm-btn--ghost adm-btn--sm">
                  Ficha de cliente
                </NuxtLink>
                <button
                  type="button"
                  :disabled="locked || !!busy"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  @click="begin(item)"
                >
                  Revisar
                </button>
              </div>
            </li>
          </ul>
        </template>
        <div v-if="snapshot" class="adm-pagination">
          <p>
            {{ snapshot.total }} {{ snapshot.total === 1 ? 'empresa' : 'empresas' }}
            <template v-if="pageCount > 1"> · página {{ snapshot.page }} de {{ pageCount }}</template>
          </p>
          <div v-if="pageCount > 1 || page > 1" class="flex items-center gap-2">
            <button
              type="button"
              data-company-prev
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="page <= 1 || locked || !!busy"
              @click="move(-1)"
            >
              <UIcon name="i-lucide-chevron-left" class="size-4" />Anterior
            </button>
            <button
              type="button"
              data-company-next
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="page * 20 >= snapshot.total || locked || !!busy"
              @click="move(1)"
            >
              Siguiente<UIcon name="i-lucide-chevron-right" class="size-4" />
            </button>
          </div>
        </div>
      </div>

      <AdminDrawer
        v-model:open="drawerOpen"
        :title="target ? `Revisar ${target.legalName}` : 'Revisar empresa'"
        description="El motivo queda guardado en el historial con tu usuario."
      >
        <form
          v-if="target"
          :id="`${prefix}-form`"
          data-company-command
          class="adm-stack"
          @submit.prevent="requestSubmit"
        >
          <UAlert
            v-if="message"
            role="alert"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            class="break-words"
            :title="message"
          />
          <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt class="text-[var(--text-muted)]">Estado actual</dt>
            <dd>
              <AdminBadge :tone="tones[target.status]">{{ labels[target.status] }}</AdminBadge>
            </dd>
            <template v-if="target.tradeName">
              <dt class="text-[var(--text-muted)]">Nombre comercial</dt>
              <dd>{{ target.tradeName }}</dd>
            </template>
            <dt class="text-[var(--text-muted)]">NIF</dt>
            <dd class="tabular-nums">
              {{ target.taxId ? `${target.countryCode} · ${target.taxId}` : 'Sin NIF' }}
            </dd>
            <dt class="text-[var(--text-muted)]">Contacto</dt>
            <dd class="break-all">{{ target.contactEmail || 'Sin correo' }}</dd>
            <dt class="text-[var(--text-muted)]">Alta</dt>
            <dd>{{ adminDate(target.createdAt) }}</dd>
            <template v-if="target.reviewedAt">
              <dt class="text-[var(--text-muted)]">Última revisión</dt>
              <dd>{{ adminDate(target.reviewedAt, true) }}</dd>
            </template>
            <template v-if="target.rejectionReason">
              <dt class="text-[var(--text-muted)]">Motivo anterior</dt>
              <dd class="break-words">{{ target.rejectionReason }}</dd>
            </template>
          </dl>
          <div class="adm-field">
            <label :for="`${prefix}-target`" class="adm-label">Nuevo estado</label>
            <select
              :id="`${prefix}-target`"
              v-model="selectedStatus"
              data-company-target-status
              class="adm-input w-full"
              :disabled="locked || !!busy"
            >
              <option v-for="status in transitions" :key="status" :value="status">{{ labels[status] }}</option>
            </select>
          </div>
          <div class="adm-field">
            <label :for="`${prefix}-reason`" class="adm-label">
              Motivo<span class="text-red-700" aria-hidden="true"> *</span>
            </label>
            <textarea
              :id="`${prefix}-reason`"
              v-model="reason"
              data-company-reason
              class="adm-input w-full"
              maxlength="500"
              rows="3"
              placeholder="Por ejemplo: NIF comprobado en el registro mercantil"
              :disabled="locked || !!busy"
            />
            <p class="adm-help">Entre 3 y 500 caracteres. Solo lo ve el equipo.</p>
          </div>
          <p class="adm-help">Si el cliente cambia sus datos mientras revisas, habrá que abrir la revisión de nuevo.</p>
        </form>
        <template #footer>
          <AdminButton :disabled="locked || !!busy" @click="clearForm">Cancelar</AdminButton>
          <button
            type="submit"
            :form="`${prefix}-form`"
            class="adm-btn"
            :class="selectedStatus === 'rejected' ? 'adm-btn--danger' : 'adm-btn--primary'"
            :disabled="locked || !!busy || reason.trim().length < 3"
          >
            {{
              busy === 'put' ? 'Guardando…' : selectedStatus === 'rejected' ? 'Rechazar empresa' : 'Guardar revisión'
            }}
          </button>
        </template>
      </AdminDrawer>

      <AdminConfirm
        v-model:open="confirmReject"
        title="Rechazar empresa"
        :description="`«${target?.legalName ?? ''}» no tendrá condiciones de cliente profesional. Podrás volver a revisarla más adelante.`"
        confirm-label="Rechazar"
        danger
        @confirm="confirmRejection"
      />
    </template>
  </section>
</template>
