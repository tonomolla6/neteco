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
</script>
<template>
  <section aria-label="Revisión de cuentas profesionales" class="space-y-4 min-w-0">
    <UiPageHeader
      title="Clientes profesionales"
      description="Revisión administrativa del perfil de empresa. No concede crédito ni acredita validación fiscal externa."
    />
    <p v-if="!actor" role="status">
      Se necesita una sesión vigente, correo verificado, MFA y permiso de administración.
    </p>
    <template v-else>
      <form data-company-filter class="flex flex-wrap items-end gap-3" @submit.prevent="filter">
        <label :for="`${prefix}-query`"
          >Empresa o NIF<input
            :id="`${prefix}-query`"
            v-model="query"
            data-company-query
            maxlength="100"
            class="block w-full rounded border p-2"
            :disabled="locked || !!busy"
        /></label>
        <label :for="`${prefix}-status`"
          >Estado<select
            :id="`${prefix}-status`"
            v-model="filterStatus"
            data-company-filter-status
            class="block rounded border p-2"
            :disabled="locked || !!busy"
          >
            <option value="">Todos</option>
            <option v-for="status in COMPANY_STATUSES" :key="status" :value="status">{{ labels[status] }}</option>
          </select></label
        >
        <button type="submit" :disabled="locked || !!busy" class="rounded border px-3 py-2">Aplicar filtros</button>
      </form>
      <p v-if="message" role="alert" class="break-words">{{ message }}</p>
      <p v-if="receipt" data-company-confirmed role="status">
        Revisión registrada: {{ labels[receipt.status] }}. El estado actual se consulta por separado.
      </p>
      <div v-if="unknown" data-company-unknown role="alert" class="space-y-2 rounded border p-3">
        <p>Resultado pendiente de verificar. La ausencia de recibo no demuestra ausencia de cambios.</p>
        <button type="button" data-company-check :disabled="!!busy" class="rounded border p-2" @click="check">
          Consultar recibo
        </button>
        <button
          v-if="retryReady"
          type="button"
          data-company-replay
          :disabled="!!busy"
          class="rounded border p-2"
          @click="replay"
        >
          Repetir exactamente la misma revisión
        </button>
        <button
          v-if="canDiscard"
          type="button"
          data-company-discard
          :disabled="!!busy"
          class="rounded border p-2"
          @click="discard"
        >
          Descartar intención local (no deshace cambios)
        </button>
      </div>
      <div v-if="readStatus === 'error'" data-company-read-error role="alert">
        <p>No se han podido verificar las empresas. No es una lista vacía confirmada.</p>
        <button type="button" data-company-retry :disabled="locked || !!busy" @click="load()">
          Volver a consultar
        </button>
      </div>
      <p v-else-if="readStatus === 'pending'" role="status">Consultando empresas…</p>
      <p v-else-if="snapshot && snapshot.items.length === 0" data-company-empty>
        No hay empresas en esta página para los filtros aplicados.
      </p>
      <div v-if="snapshot" class="space-y-3">
        <p>{{ snapshot.total }} empresas · Página {{ snapshot.page }}</p>
        <article v-for="item in snapshot.items" :key="item.id" class="min-w-0 rounded border p-3 break-words">
          <h2 class="font-semibold">{{ item.legalName }}</h2>
          <p v-if="item.tradeName">{{ item.tradeName }}</p>
          <p>{{ item.countryCode }} · {{ item.taxId || 'Sin identificador fiscal' }}</p>
          <p v-if="item.contactEmail">{{ item.contactEmail }}</p>
          <p>{{ labels[item.status] }}</p>
          <p v-if="item.reviewedAt">Revisión administrativa: {{ item.reviewedAt }}</p>
          <p v-if="item.rejectionReason">{{ item.rejectionReason }}</p>
          <button
            type="button"
            data-company-review
            :disabled="locked || !!busy"
            class="rounded border p-2"
            @click="begin(item)"
          >
            Revisar cuenta
          </button>
        </article>
        <div class="flex flex-wrap gap-3">
          <button type="button" data-company-prev :disabled="page <= 1 || locked || !!busy" @click="move(-1)">
            Anterior</button
          ><button
            type="button"
            data-company-next
            :disabled="page * 20 >= snapshot.total || locked || !!busy"
            @click="move(1)"
          >
            Siguiente
          </button>
        </div>
      </div>
      <form v-if="target" data-company-command class="space-y-3 rounded border p-3" @submit.prevent="submit">
        <h2>Revisar {{ target.legalName }}</h2>
        <p>
          Estado leído: {{ labels[target.status] }}. Si el cliente modifica el perfil, esta revisión debe volver a
          prepararse.
        </p>
        <label :for="`${prefix}-target`"
          >Nuevo estado<select
            :id="`${prefix}-target`"
            v-model="selectedStatus"
            data-company-target-status
            :disabled="locked || !!busy"
            class="block rounded border p-2"
          >
            <option v-for="status in transitions" :key="status" :value="status">{{ labels[status] }}</option>
          </select></label
        >
        <label :for="`${prefix}-reason`"
          >Motivo privado auditado<textarea
            :id="`${prefix}-reason`"
            v-model="reason"
            data-company-reason
            maxlength="500"
            rows="3"
            :disabled="locked || !!busy"
            class="block w-full rounded border p-2"
          />
        </label>
        <button type="submit" :disabled="locked || !!busy || reason.trim().length < 3" class="rounded border p-2">
          Confirmar revisión administrativa
        </button>
        <button type="button" :disabled="locked || !!busy" @click="clearForm">Cerrar sin enviar</button>
      </form>
    </template>
  </section>
</template>
