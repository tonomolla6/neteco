<script setup lang="ts">
import { useAdminNavigation } from '../composables/useAdminNavigation'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import {
  shippingCalendarInputSchema,
  shippingCalendarSnapshotSchema,
  shippingCalendarReceiptSchema,
  shippingCalendarCommandSchema,
  shippingCalendarIntentHash,
  shippingCalendarConfigurationHash,
  type ShippingCalendarInput,
  type ShippingCalendarSnapshot,
  type ShippingCalendarReceipt,
  type ShippingCalendarConfiguration
} from '~~/shared/shipping-calendar'
const props = defineProps<{ scopeKey: string; enabled: boolean; pending: boolean }>()
const emit = defineEmits<{ pending: [boolean]; confirmed: [ShippingCalendarReceipt] }>()
const auth = useUserSession(),
  navigation = useAdminNavigation(),
  request = useRequestFetch(),
  prefix = useId()
const owner = computed(() => {
  const caps = navigation.capabilities.value,
    identity = auth.user.value?.id,
    sid = auth.session.value?.sessionId,
    version = auth.session.value?.sessionVersion
  if (
    !props.enabled ||
    !props.scopeKey ||
    props.scopeKey.length > 1000 ||
    !auth.ready.value ||
    !auth.loggedIn.value ||
    auth.user.value?.emailVerified !== true ||
    auth.user.value?.mfaVerified !== true ||
    !catalogPolicyUuidSchema.safeParse(identity).success ||
    !catalogPolicyUuidSchema.safeParse(sid).success ||
    !Number.isSafeInteger(version) ||
    Number(version) < 1 ||
    navigation.status.value !== 'ready' ||
    caps?.state !== 'ready' ||
    caps.identityId !== identity ||
    caps.sessionId !== sid ||
    caps.sessionVersion !== version ||
    !caps.permissions.includes('administration.manage')
  )
    return null
  return JSON.stringify([props.scopeKey, identity, sid, version])
})
type CalendarDraft = {
  code: string
  name: string
  scope: 'national' | 'local' | 'carrier'
  stage: 'preparation' | 'transit' | 'both'
  days: number[]
  dates: string
  postalPrefixes: string
  methodCodes: Array<'pickup' | 'own_delivery' | 'parcel'>
  serviceProfiles: Array<'parcel' | 'pallet' | 'adr'>
  zoneCodes: string
}
type Intent = {
  owner: string
  key: string
  body: ShippingCalendarInput
  hash: string
  configurationHash: string
  attempted: boolean
}
const snapshot = shallowRef<ShippingCalendarSnapshot | null>(null),
  intent = shallowRef<Intent | null>(null),
  calendars = ref<CalendarDraft[]>([])
const preparation = ref<string | number>(''),
  cutoff = ref(''),
  reason = ref(''),
  reference = ref(''),
  message = ref(''),
  busy = ref(false),
  blocked = ref<string | null>(null)
const phase = ref<'idle' | 'ready' | 'review' | 'unknown' | 'confirmed' | 'error'>('idle')
const weekdays = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']
const methods = ['pickup', 'own_delivery', 'parcel'] as const,
  profiles = ['parcel', 'pallet', 'adr'] as const
const endpoint = '/api/admin/shipping/calendars'
let alive = true,
  epoch = 0,
  commandPending = false,
  sequence = 0
const controllers = new Set<AbortController>()
const allowed = computed(() => !!owner.value && blocked.value !== owner.value)
function setLocalPending(value: boolean) {
  if (commandPending !== value) {
    commandPending = value
    emit('pending', value)
  }
}
function reset() {
  epoch++
  for (const controller of controllers) controller.abort()
  controllers.clear()
  snapshot.value = null
  intent.value = null
  calendars.value = []
  preparation.value = ''
  cutoff.value = ''
  reason.value = ''
  reference.value = ''
  message.value = ''
  phase.value = 'idle'
  busy.value = false
  setLocalPending(false)
}
function live(turn: number, actor: string) {
  return alive && epoch === turn && allowed.value && owner.value === actor
}
function revoked(cause: unknown, actor: string) {
  const error = cause as { statusCode?: number; status?: number; response?: { status?: number } }
  if ([401, 403].includes(error?.statusCode ?? error?.status ?? error?.response?.status ?? 0)) {
    reset()
    blocked.value = actor
    message.value = 'La autorización ha cambiado. Los datos privados se han borrado.'
    return true
  }
  return false
}
function controller() {
  const value = new AbortController()
  controllers.add(value)
  return value
}
function draft(configuration: ShippingCalendarConfiguration | null) {
  preparation.value = configuration ? String(configuration.preparationBusinessDays) : ''
  cutoff.value = configuration?.cutoffLocalTime ?? ''
  calendars.value = (configuration?.calendars ?? []).map((calendar) => ({
    code: calendar.code,
    name: calendar.name,
    scope: calendar.scope,
    stage: calendar.stage,
    days: [...calendar.operatingWeekdays],
    dates: calendar.closedDates.join('\n'),
    postalPrefixes: calendar.postalPrefixes.join(', '),
    methodCodes: [...calendar.methodCodes],
    serviceProfiles: [...calendar.serviceProfiles],
    zoneCodes: calendar.zoneCodes.join(', ')
  }))
}
async function current(turn: number, actor: string, abort: AbortController) {
  const value = shippingCalendarSnapshotSchema.parse(
    await request<unknown>(endpoint, { method: 'GET', retry: 0, cache: 'no-store', signal: abort.signal })
  )
  if (value.configuration && (await shippingCalendarConfigurationHash(value.configuration)) !== value.configurationHash)
    throw Error('invalid_configuration_proof')
  if (!live(turn, actor)) throw Error('scope_changed')
  return value
}
async function load() {
  const actor = owner.value
  if (!actor || !allowed.value || busy.value || intent.value || props.pending) return
  const turn = epoch,
    abort = controller()
  busy.value = true
  message.value = ''
  try {
    const value = await current(turn, actor, abort)
    if (live(turn, actor)) {
      snapshot.value = value
      draft(value.configuration)
      phase.value = 'ready'
    }
  } catch (cause) {
    if (live(turn, actor) && !revoked(cause, actor)) {
      snapshot.value = null
      phase.value = 'error'
      message.value = 'No se pudo leer el calendario. No se ha supuesto una configuración vacía.'
    }
  } finally {
    controllers.delete(abort)
    if (live(turn, actor)) busy.value = false
  }
}
function add() {
  if (busy.value || intent.value || props.pending || !allowed.value || calendars.value.length >= 20) return
  let code: string
  do {
    code = `calendar-${++sequence}`
  } while (calendars.value.some((calendar) => calendar.code === code))
  calendars.value.push({
    code,
    name: '',
    scope: 'national',
    stage: 'both',
    days: [],
    dates: '',
    postalPrefixes: '',
    methodCodes: [],
    serviceProfiles: [],
    zoneCodes: ''
  })
}
function scopeChanged(calendar: CalendarDraft) {
  if (calendar.scope === 'national') {
    calendar.postalPrefixes = ''
    calendar.methodCodes = []
    calendar.serviceProfiles = []
    calendar.zoneCodes = ''
  }
}
const comma = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
async function review() {
  const actor = owner.value
  if (!actor || !allowed.value || busy.value || intent.value || props.pending || !snapshot.value) return
  const parsed = shippingCalendarInputSchema.safeParse({
    expectedVersion: snapshot.value.version,
    reason: reason.value,
    reviewReference: reference.value,
    configuration: {
      timeZone: 'Europe/Madrid',
      preparationBusinessDays:
        typeof preparation.value === 'number'
          ? preparation.value
          : /^[0-9]+$/.test(preparation.value.trim())
            ? Number(preparation.value.trim())
            : null,
      cutoffLocalTime: cutoff.value,
      calendars: calendars.value.map((calendar) => ({
        code: calendar.code,
        name: calendar.name,
        scope: calendar.scope,
        stage: calendar.stage,
        operatingWeekdays: [...calendar.days].sort((a, b) => a - b),
        closedDates: calendar.dates
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean),
        postalPrefixes: comma(calendar.postalPrefixes),
        methodCodes: calendar.methodCodes,
        serviceProfiles: calendar.serviceProfiles,
        zoneCodes: comma(calendar.zoneCodes)
      }))
    }
  })
  if (!parsed.success) {
    message.value =
      'Revisa preparación, corte, días, fechas y los datos de la revisión. No se ha enviado ningún cambio.'
    return
  }
  const turn = epoch
  busy.value = true
  try {
    const hash = await shippingCalendarIntentHash(parsed.data),
      configurationHash = await shippingCalendarConfigurationHash(parsed.data.configuration)
    if (live(turn, actor)) {
      intent.value = {
        owner: actor,
        key: crypto.randomUUID(),
        body: structuredClone(parsed.data),
        hash,
        configurationHash,
        attempted: false
      }
      phase.value = 'review'
      message.value = 'Revisa los calendarios antes de confirmar. No se ha guardado todavía.'
      setLocalPending(true)
    }
  } finally {
    if (live(turn, actor)) busy.value = false
  }
}
async function acknowledge(raw: unknown, expected: Intent, turn: number, abort: AbortController) {
  const receipt = shippingCalendarReceiptSchema.parse(raw)
  if (
    receipt.commandId !== expected.key ||
    receipt.payloadHash !== expected.hash ||
    receipt.expectedVersion !== expected.body.expectedVersion ||
    receipt.configurationHash !== expected.configurationHash
  )
    throw Error('receipt_mismatch')
  const value = await current(turn, expected.owner, abort)
  if (
    value.version < receipt.version ||
    !value.updatedAt ||
    value.updatedAt < receipt.recordedAt ||
    (value.version === receipt.version && value.configurationHash !== receipt.configurationHash)
  )
    throw Error('current_configuration_mismatch')
  if (!live(turn, expected.owner) || intent.value?.key !== expected.key) return
  snapshot.value = value
  draft(value.configuration)
  reason.value = ''
  reference.value = ''
  intent.value = null
  phase.value = 'confirmed'
  message.value =
    value.version === receipt.version
      ? 'Calendario guardado y verificado. Las fechas siguen siendo estimadas, no garantizadas.'
      : 'La revisión se aplicó; existe una configuración posterior que se muestra ahora. Las fechas no están garantizadas.'
  setLocalPending(false)
  emit('confirmed', receipt)
}
async function send() {
  const expected = intent.value
  if (!expected || !allowed.value || owner.value !== expected.owner || busy.value || props.pending) return
  const turn = epoch,
    abort = controller(),
    first = !expected.attempted
  expected.attempted = true
  busy.value = true
  let received = false
  try {
    const receipt = await request<unknown>(`${endpoint}/commands`, {
      method: 'POST',
      retry: 0,
      signal: abort.signal,
      headers: { 'Idempotency-Key': expected.key },
      body: expected.body
    })
    received = true
    await acknowledge(receipt, expected, turn, abort)
  } catch (cause) {
    if (live(turn, expected.owner) && !revoked(cause, expected.owner)) {
      const error = cause as { data?: { error?: { code?: string } }; statusCode?: number; status?: number }
      if (
        first &&
        !received &&
        (error.statusCode ?? error.status) === 409 &&
        error.data?.error?.code === 'version_conflict'
      ) {
        intent.value = null
        snapshot.value = null
        calendars.value = []
        phase.value = 'error'
        message.value = 'El calendario cambió. Esta revisión no se aplicó; vuelve a leer antes de revisar.'
        setLocalPending(false)
      } else {
        phase.value = 'unknown'
        message.value = 'Resultado sin confirmar. Consulta el recibo; no vuelvas a crear otra revisión.'
      }
    }
  } finally {
    controllers.delete(abort)
    if (live(turn, expected.owner)) busy.value = false
  }
}
async function check() {
  const expected = intent.value
  if (!expected || !allowed.value || busy.value || props.pending) return
  const turn = epoch,
    abort = controller()
  busy.value = true
  try {
    const result = shippingCalendarCommandSchema.parse(
      await request<unknown>(`${endpoint}/commands/${expected.key}`, {
        method: 'GET',
        retry: 0,
        cache: 'no-store',
        signal: abort.signal,
        headers: { 'X-Neteco-Command-Payload-Hash': expected.hash }
      })
    )
    if (result.outcome === 'unknown') {
      if (live(turn, expected.owner))
        message.value = 'No hay un recibo propio confirmado. El resultado sigue sin confirmar.'
      return
    }
    await acknowledge(result.receipt, expected, turn, abort)
  } catch (cause) {
    if (live(turn, expected.owner) && !revoked(cause, expected.owner)) {
      phase.value = 'unknown'
      message.value = 'No se pudo verificar el recibo y el calendario vigente.'
    }
  } finally {
    controllers.delete(abort)
    if (live(turn, expected.owner)) busy.value = false
  }
}
function cancel() {
  if (intent.value?.attempted || busy.value) return
  intent.value = null
  phase.value = 'ready'
  message.value = ''
  setLocalPending(false)
}
watch(
  owner,
  () => {
    reset()
    blocked.value = null
    if (owner.value && !props.pending) void load()
  },
  { immediate: true, flush: 'sync' }
)
watch(
  () => props.pending,
  (value) => {
    if (!value && allowed.value && !snapshot.value && !intent.value) void load()
  }
)
onBeforeUnmount(() => {
  alive = false
  reset()
})
</script>
<template>
  <section
    aria-label="Calendarios operativos de envío"
    class="space-y-4 rounded-xl border border-slate-200 bg-white p-4"
  >
    <h2 class="text-lg font-semibold">Calendarios operativos de envío</h2>
    <p class="text-sm text-slate-600">
      Preparación y tránsito en Europe/Madrid. Las fechas son estimadas, no garantizadas. No se consultan ni activan
      servicios de transportistas.
    </p>
    <p v-if="!allowed" role="status">Se requiere una sesión vigente, MFA y permiso de administración.</p>
    <template v-else>
      <p v-if="message" :role="phase === 'unknown' || phase === 'error' ? 'alert' : 'status'">{{ message }}</p>
      <button
        v-if="!snapshot && !intent"
        type="button"
        data-calendar-load
        :disabled="busy || pending"
        class="rounded border px-3 py-2"
        @click="load"
      >
        Leer calendario vigente
      </button>
      <template v-if="snapshot">
        <p v-if="snapshot.version === 0">Sin calendario configurado: ETA pendiente, sin fecha prometida.</p>
        <p v-else>Revisión {{ snapshot.version }} · última actualización {{ snapshot.updatedAt }}</p>
        <fieldset :disabled="busy || pending || !!intent" class="space-y-4">
          <div class="grid gap-3 sm:grid-cols-2">
            <label :for="`${prefix}-preparation`"
              >Días operativos de preparación<input
                :id="`${prefix}-preparation`"
                v-model="preparation"
                data-calendar-preparation
                type="number"
                min="0"
                max="60"
                step="1"
                class="block w-full rounded border p-2"
            /></label>
            <label :for="`${prefix}-cutoff`"
              >Hora de corte (Madrid)<input
                :id="`${prefix}-cutoff`"
                v-model="cutoff"
                data-calendar-cutoff
                type="time"
                class="block w-full rounded border p-2"
            /></label>
          </div>
          <fieldset
            v-for="(calendar, index) in calendars"
            :key="calendar.code"
            class="min-w-0 space-y-3 rounded border p-3"
          >
            <legend>Calendario {{ index + 1 }}</legend>
            <label :for="`${prefix}-name-${index}`"
              >Nombre<input
                :id="`${prefix}-name-${index}`"
                v-model="calendar.name"
                :data-calendar-name="index"
                maxlength="100"
                class="block w-full rounded border p-2"
            /></label>
            <div class="grid gap-3 sm:grid-cols-2">
              <label :for="`${prefix}-scope-${index}`"
                >Ámbito<select
                  :id="`${prefix}-scope-${index}`"
                  v-model="calendar.scope"
                  class="block w-full rounded border p-2"
                  @change="scopeChanged(calendar)"
                >
                  <option value="national">Nacional</option>
                  <option value="local">Local / destino</option>
                  <option value="carrier">Ruta / transportista configurado</option>
                </select></label
              >
              <label :for="`${prefix}-stage-${index}`"
                >Se aplica a<select
                  :id="`${prefix}-stage-${index}`"
                  v-model="calendar.stage"
                  class="block w-full rounded border p-2"
                >
                  <option value="both">Preparación y tránsito</option>
                  <option value="preparation">Preparación</option>
                  <option value="transit">Tránsito</option>
                </select></label
              >
            </div>
            <fieldset>
              <legend>Días operativos explícitos</legend>
              <div class="flex flex-wrap gap-3">
                <label v-for="(day, offset) in weekdays" :key="day"
                  ><input
                    v-model="calendar.days"
                    :data-calendar-weekday="`${index}-${offset + 1}`"
                    type="checkbox"
                    :value="offset + 1"
                  />
                  {{ day }}</label
                >
              </div>
            </fieldset>
            <label :for="`${prefix}-dates-${index}`"
              >Festivos / cierres (AAAA-MM-DD, uno por línea)<textarea
                :id="`${prefix}-dates-${index}`"
                v-model="calendar.dates"
                :data-calendar-dates="index"
                rows="4"
                class="block w-full rounded border p-2"
              />
            </label>
            <label v-if="calendar.scope !== 'national'" :for="`${prefix}-prefix-${index}`"
              >Prefijos postales separados por comas<input
                :id="`${prefix}-prefix-${index}`"
                v-model="calendar.postalPrefixes"
                class="block w-full rounded border p-2"
            /></label>
            <template v-if="calendar.scope !== 'national'">
              <fieldset>
                <legend>Métodos (vacío: todos; obligatorio para transportista)</legend>
                <div class="flex flex-wrap gap-3">
                  <label v-for="method in methods" :key="method"
                    ><input v-model="calendar.methodCodes" type="checkbox" :value="method" />
                    {{
                      method === 'pickup' ? 'Recogida' : method === 'own_delivery' ? 'Reparto propio' : 'Paquetería'
                    }}</label
                  >
                </div>
              </fieldset>
              <fieldset>
                <legend>Perfiles (vacío: todos)</legend>
                <div class="flex flex-wrap gap-3">
                  <label v-for="profile in profiles" :key="profile"
                    ><input v-model="calendar.serviceProfiles" type="checkbox" :value="profile" /> {{ profile }}</label
                  >
                </div>
              </fieldset>
              <label :for="`${prefix}-zones-${index}`"
                >Códigos de zona configurados (comas; vacío: todas)<input
                  :id="`${prefix}-zones-${index}`"
                  v-model="calendar.zoneCodes"
                  class="block w-full rounded border p-2"
              /></label>
            </template>
            <button type="button" class="rounded border px-3 py-2" @click="calendars.splice(index, 1)">
              Quitar este calendario
            </button>
          </fieldset>
          <button
            type="button"
            data-calendar-add
            :disabled="calendars.length >= 20"
            class="rounded border px-3 py-2"
            @click="add"
          >
            Añadir calendario
          </button>
          <label :for="`${prefix}-reason`" class="block"
            >Motivo de la revisión<textarea
              :id="`${prefix}-reason`"
              v-model="reason"
              data-calendar-reason
              maxlength="500"
              class="block w-full rounded border p-2"
            />
          </label>
          <label :for="`${prefix}-reference`" class="block"
            >Referencia de comprobación<input
              :id="`${prefix}-reference`"
              v-model="reference"
              data-calendar-reference
              maxlength="200"
              class="block w-full rounded border p-2"
          /></label>
          <button type="button" data-calendar-review class="rounded border px-3 py-2" @click="review">
            Revisar cambios
          </button>
        </fieldset>
      </template>
      <div v-if="phase === 'review' && intent" class="space-y-2 rounded border p-3">
        <p>
          Aplicar {{ intent.body.configuration.calendars.length }} calendarios, preparación
          {{ intent.body.configuration.preparationBusinessDays }} días operativos y corte
          {{ intent.body.configuration.cutoffLocalTime }}. Sustituye la configuración completa, no los pedidos
          históricos.
        </p>
        <button
          type="button"
          data-calendar-confirm
          :disabled="busy || pending"
          class="rounded border px-3 py-2"
          @click="send"
        >
          Confirmar revisión
        </button>
        <button type="button" :disabled="busy" class="rounded border px-3 py-2" @click="cancel">
          Volver a editar sin guardar
        </button>
      </div>
      <div v-if="phase === 'unknown' && intent" class="flex flex-wrap gap-3">
        <button
          type="button"
          data-calendar-check
          :disabled="busy || pending"
          class="rounded border px-3 py-2"
          @click="check"
        >
          Consultar recibo y calendario
        </button>
        <button
          type="button"
          data-calendar-replay
          :disabled="busy || pending"
          class="rounded border px-3 py-2"
          @click="send"
        >
          Reenviar exactamente la misma revisión
        </button>
      </div>
    </template>
  </section>
</template>
