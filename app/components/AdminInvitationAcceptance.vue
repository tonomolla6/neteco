<script setup lang="ts">
import {
  adminInvitationAcceptInputSchema,
  adminInvitationPreviewSchema,
  adminInvitationReceiptSchema,
  adminInvitationCommandSchema,
  adminInvitationIntentHash,
  type AdminInvitationPreview,
  type AdminInvitationReceipt
} from '~~/shared/admin-invitations'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import { randomId } from '../utils/uuid'

const props = defineProps<{ runtime: unknown }>()
const emit = defineEmits<{ pending: [boolean]; confirmed: [AdminInvitationReceipt] }>()
const auth = useUserSession(),
  request = useRequestFetch(),
  prefix = useId()
const token = ref(''),
  acknowledged = ref(false)
const preview = shallowRef<AdminInvitationPreview | null>(null)
const accepted = shallowRef<AdminInvitationReceipt | null>(null)
// This metadata is not a capability: it cannot replay acceptance or grant access.
type Recovery = Readonly<{
  identityId: string
  key: string
  payloadHash: string
  invitationId: string
  roleCode: AdminInvitationReceipt['roleCode']
}>
const recovery = shallowRef<Recovery | null>(null)
const busy = ref<'preview' | 'accept' | 'lookup' | 'session' | null>(null)
const message = ref(''),
  error = ref(false),
  blockedScope = ref<string | null>(null)
let alive = true,
  epoch = 0,
  writingToken = false
let previewController: AbortController | null = null
let activeJob: object | null = null
const identity = computed(() =>
  catalogPolicyUuidSchema.safeParse(auth.user.value?.id).success ? String(auth.user.value!.id) : null
)
const scope = computed(() =>
  JSON.stringify([
    props.runtime,
    auth.ready.value,
    auth.loggedIn.value,
    identity.value,
    auth.user.value?.email,
    auth.user.value?.emailVerified,
    auth.user.value?.mfaVerified,
    auth.session.value?.sessionId,
    auth.session.value?.sessionVersion
  ])
)
const authority = computed(
  () =>
    props.runtime === 'cloudflare' &&
    auth.ready.value === true &&
    auth.loggedIn.value === true &&
    identity.value !== null &&
    auth.user.value?.emailVerified === true &&
    auth.user.value?.mfaVerified === true &&
    catalogPolicyUuidSchema.safeParse(auth.session.value?.sessionId).success &&
    Number.isSafeInteger(auth.session.value?.sessionVersion) &&
    Number(auth.session.value?.sessionVersion) > 0
)
const allowed = computed(() => authority.value && blockedScope.value !== scope.value)
const canReadReceipt = computed(() => allowed.value && recovery.value?.identityId === identity.value)

function setToken(value: string) {
  writingToken = true
  token.value = value
  writingToken = false
}
function purgeSecret() {
  setToken('')
  preview.value = null
  acknowledged.value = false
}
function clearAll() {
  epoch++
  previewController?.abort()
  previewController = null
  purgeSecret()
  recovery.value = null
  accepted.value = null
  busy.value = null
  activeJob = null
  message.value = ''
  error.value = false
  emit('pending', false)
}
watch(
  token,
  () => {
    if (writingToken) return
    epoch++
    preview.value = null
    acknowledged.value = false
    message.value = ''
    error.value = false
  },
  { flush: 'sync' }
)
watch(
  scope,
  () => {
    epoch++
    previewController?.abort()
    previewController = null
    purgeSecret()
    blockedScope.value = null
    const owner = recovery.value?.identityId
    if (
      (owner && identity.value && owner !== identity.value) ||
      (accepted.value && identity.value && confirmedIdentity !== identity.value)
    ) {
      clearAll()
      return
    }
    if (accepted.value) return // A confirmed acceptance intentionally revokes its own sessions.
    if (recovery.value) {
      message.value =
        'El resultado sigue pendiente de comprobar. Vuelve a autenticar la misma cuenta con MFA para consultar el recibo.'
      error.value = false
      if (busy.value !== 'accept') busy.value = null
    } else {
      busy.value = null
      message.value = ''
      error.value = false
    }
  },
  { flush: 'sync' }
)
let confirmedIdentity: string | null = null
function failureStatus(cause: unknown) {
  const value = cause as { statusCode?: number; status?: number; response?: { status?: number } } | null
  return Number(value?.statusCode ?? value?.status ?? value?.response?.status)
}
function revokeRead(cause: unknown) {
  const status = failureStatus(cause)
  if (status !== 401 && status !== 403) return
  blockedScope.value = scope.value
  purgeSecret()
}
function currentRecovery(value: Recovery) {
  return alive && recovery.value === value && (!identity.value || identity.value === value.identityId)
}
function confirm(raw: unknown, intent: Recovery) {
  const parsed = adminInvitationReceiptSchema.safeParse(raw)
  if (
    !parsed.success ||
    parsed.data.commandId !== intent.key ||
    parsed.data.payloadHash !== intent.payloadHash ||
    parsed.data.invitationId !== intent.invitationId ||
    parsed.data.roleCode !== intent.roleCode ||
    parsed.data.action !== 'accept' ||
    parsed.data.sessionRevoked !== true
  )
    throw new Error('Unconfirmed invitation receipt')
  if (!currentRecovery(intent)) return
  confirmedIdentity = intent.identityId
  accepted.value = parsed.data
  recovery.value = null
  purgeSecret()
  error.value = false
  message.value = ''
  emit('pending', false)
  emit('confirmed', parsed.data)
}
async function inspect() {
  if (!allowed.value || busy.value || recovery.value || accepted.value) return
  const parsed = adminInvitationAcceptInputSchema.safeParse({ token: token.value })
  if (!parsed.success) {
    message.value = 'Introduce el código completo de la invitación, sin espacios.'
    error.value = true
    return
  }
  const turn = epoch,
    owner = scope.value
  busy.value = 'preview'
  error.value = false
  message.value = ''
  preview.value = null
  acknowledged.value = false
  const controller = new AbortController()
  previewController = controller
  try {
    const value = await request<unknown>('/api/account/invitations/preview', {
      method: 'POST',
      body: parsed.data,
      retry: 0,
      signal: controller.signal,
      referrerPolicy: 'no-referrer'
    })
    if (!alive || epoch !== turn || scope.value !== owner || !allowed.value) return
    preview.value = adminInvitationPreviewSchema.parse(value)
  } catch (cause) {
    if (!alive || epoch !== turn || scope.value !== owner) return
    revokeRead(cause)
    message.value =
      'No se ha podido revisar esta invitación. Comprueba tu sesión y el código antes de intentarlo de nuevo.'
    error.value = true
  } finally {
    if (previewController === controller) {
      previewController = null
      busy.value = null
    }
  }
}
async function acceptInvitation() {
  if (!allowed.value || busy.value || recovery.value || accepted.value || !preview.value || !acknowledged.value) return
  let body = adminInvitationAcceptInputSchema.parse({ token: token.value })
  const proposal = preview.value,
    owner = scope.value,
    ownerId = identity.value!,
    turn = epoch
  const job = {}
  activeJob = job
  busy.value = 'accept'
  error.value = false
  message.value = ''
  try {
    const hash = await adminInvitationIntentHash('accept', null, body)
    if (
      !alive ||
      epoch !== turn ||
      scope.value !== owner ||
      !allowed.value ||
      preview.value !== proposal ||
      !acknowledged.value ||
      token.value !== body.token
    )
      return
    const intent: Recovery = Object.freeze({
      identityId: ownerId,
      key: randomId(),
      payloadHash: hash,
      invitationId: proposal.invitationId,
      roleCode: proposal.roleCode
    })
    recovery.value = intent
    purgeSecret()
    emit('pending', true)
    try {
      const response = request<unknown>('/api/account/invitations/accept', {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': intent.key },
        retry: 0,
        referrerPolicy: 'no-referrer'
      })
      body = { token: '' }
      const value = await response
      if (currentRecovery(intent)) confirm(value, intent)
    } catch (cause) {
      if (!currentRecovery(intent)) return
      revokeRead(cause)
      message.value =
        'No se ha podido confirmar el resultado. No vuelvas a aceptar: consulta el recibo de este intento.'
      error.value = false
    }
  } catch {
    if (alive && epoch === turn && scope.value === owner) {
      message.value = 'No se ha podido preparar la aceptación. No se ha enviado la solicitud.'
      error.value = true
    }
  } finally {
    body = { token: '' }
    if (activeJob === job && busy.value === 'accept') busy.value = null
  }
}
async function checkReceipt() {
  const intent = recovery.value
  if (!intent || !canReadReceipt.value || busy.value) return
  const turn = epoch,
    owner = scope.value
  const job = {}
  activeJob = job
  busy.value = 'lookup'
  message.value = ''
  try {
    const value = await request<unknown>(`/api/account/invitations/commands/${intent.key}`, {
      method: 'GET',
      query: { payloadHash: intent.payloadHash },
      retry: 0,
      referrerPolicy: 'no-referrer'
    })
    if (!currentRecovery(intent) || epoch !== turn || scope.value !== owner || !canReadReceipt.value) return
    const parsed = adminInvitationCommandSchema.parse(value)
    if (parsed.outcome === 'applied') confirm(parsed.receipt, intent)
    else
      message.value =
        'El recibo todavía no confirma el resultado. Esto no demuestra que la invitación no se haya aceptado. No se reenviará la solicitud.'
  } catch (cause) {
    if (!currentRecovery(intent) || epoch !== turn || scope.value !== owner) return
    revokeRead(cause)
    message.value =
      'No se ha podido comprobar el recibo. El resultado sigue siendo incierto; no se ha repetido la aceptación.'
  } finally {
    if (activeJob === job && busy.value === 'lookup') busy.value = null
  }
}
async function refreshSession() {
  const intent = recovery.value
  if (!intent || busy.value) return
  const job = {}
  activeJob = job
  busy.value = 'session'
  try {
    await auth.fetch()
    if (activeJob === job && currentRecovery(intent))
      message.value = canReadReceipt.value
        ? 'Sesión comprobada. Consulta ahora el recibo de la aceptación.'
        : 'Inicia sesión con la misma cuenta y verifica MFA antes de comprobar el recibo.'
  } catch {
    if (activeJob === job && currentRecovery(intent))
      message.value = 'No se ha podido comprobar la sesión. El resultado de la aceptación sigue pendiente.'
  } finally {
    if (activeJob === job && busy.value === 'session') busy.value = null
  }
}
onMounted(() => {
  const fragment = window.location.hash
  if (fragment) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  if (!allowed.value || !fragment.startsWith('#token=')) return
  const parsed = adminInvitationAcceptInputSchema.safeParse({ token: fragment.slice(7) })
  if (parsed.success) setToken(parsed.data.token)
})
onBeforeUnmount(() => {
  alive = false
  clearAll()
  confirmedIdentity = null
})
</script>

<template>
  <section aria-label="Aceptar invitación administrativa" class="max-w-2xl space-y-5">
    <h1 class="text-2xl font-bold text-slate-900">Aceptar invitación administrativa</h1>
    <p class="text-sm text-slate-600">
      Revisa el rol y los permisos antes de aceptar. Esta operación no envía correos ni inicia sesión automáticamente.
    </p>
    <p v-if="runtime !== 'cloudflare'" role="status">
      La aceptación de invitaciones no está disponible en este entorno.
    </p>
    <div v-else-if="accepted" role="status" class="rounded-xl border border-green-200 bg-green-50 p-4">
      <p class="font-semibold">Invitación aceptada y confirmada.</p>
      <p>
        Las sesiones anteriores se han revocado. Vuelve a iniciar sesión y verifica MFA para usar los permisos de tu
        cuenta.
      </p>
      <a href="/login" class="mt-3 inline-block underline">Iniciar sesión de nuevo</a>
    </div>
    <div v-else-if="recovery" class="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <p role="status">La aceptación está pendiente de comprobar. No se enviará otra aceptación automáticamente.</p>
      <p class="text-sm">
        Si tu sesión se cerró, inicia sesión con la misma cuenta en otra pestaña y verifica MFA. Después vuelve aquí
        para comprobar la sesión y consultar el recibo.
      </p>
      <a href="/login" target="_blank" rel="noopener noreferrer" class="underline">Iniciar sesión en otra pestaña</a>
      <div class="flex flex-wrap gap-3">
        <button
          data-invitation-refresh-session
          type="button"
          :disabled="!!busy"
          class="rounded-lg border px-3 py-2 disabled:opacity-50"
          @click="refreshSession"
        >
          Comprobar sesión
        </button>
        <button
          data-invitation-check
          type="button"
          :disabled="!!busy || !canReadReceipt"
          class="rounded-lg border px-3 py-2 disabled:opacity-50"
          @click="checkReceipt"
        >
          Comprobar aceptación
        </button>
      </div>
      <p class="text-sm">
        Salir o cerrar esta pestaña borra los datos locales de recuperación, pero no deshace una aceptación. Si no
        puedes recuperarla, consulta con un administrador de Neteco.
      </p>
    </div>
    <div v-else-if="!allowed" role="status" class="space-y-3">
      <p v-if="!auth.ready.value">Comprobando la sesión…</p>
      <p v-else-if="!auth.loggedIn.value">Inicia sesión con la cuenta destinataria para revisar la invitación.</p>
      <p v-else-if="auth.user.value?.emailVerified !== true">
        Verifica el correo de tu cuenta antes de revisar la invitación.
      </p>
      <p v-else>Necesitas una sesión vigente con MFA verificado para revisar y aceptar la invitación.</p>
      <p>
        Después de autenticarte y verificar MFA, reabre el enlace original o introduce el código de nuevo. El código no
        se conserva durante el inicio de sesión.
      </p>
      <a href="/login?redirect=%2Fcuenta%2Finvitacion" class="mr-4 inline-block underline"
        >Iniciar sesión con la cuenta destinataria</a
      >
      <a href="/cuenta/seguridad" class="inline-block underline">Configurar y verificar MFA en Acceso y seguridad</a>
    </div>
    <div v-else class="space-y-4">
      <div>
        <label :for="`${prefix}-token`" class="block font-medium">Código privado de la invitación</label>
        <input
          :id="`${prefix}-token`"
          v-model="token"
          data-invitation-token
          type="password"
          autocomplete="off"
          autocapitalize="none"
          :spellcheck="false"
          maxlength="43"
          :disabled="!!busy"
          class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
        />
        <p class="mt-1 text-sm text-slate-600">
          Pega sólo el código. No lo compartas ni lo incluyas en búsquedas o mensajes.
        </p>
      </div>
      <button
        data-invitation-preview
        type="button"
        :disabled="!!busy"
        class="rounded-lg border px-3 py-2 disabled:opacity-50"
        @click="inspect"
      >
        Revisar invitación
      </button>
      <div v-if="preview" class="space-y-3 rounded-xl border border-slate-200 p-4">
        <p data-invitation-role class="font-semibold">Rol propuesto: {{ preview.roleCode }}</p>
        <ul class="list-inside list-disc break-words text-sm">
          <li v-for="permission in preview.permissions" :key="permission">{{ permission }}</li>
        </ul>
        <p class="text-sm">
          Caduca:
          <time :datetime="preview.expiresAt"
            >{{ new Date(preview.expiresAt).toLocaleString('es-ES', { timeZone: 'UTC' }) }} UTC</time
          >
        </p>
        <label class="flex items-start gap-2"
          ><input v-model="acknowledged" data-invitation-confirm type="checkbox" :disabled="!!busy" class="mt-1" /><span
            >He revisado estos permisos y quiero aceptar. Entiendo que se cerrarán mis sesiones y tendré que iniciar
            sesión de nuevo.</span
          ></label
        >
        <button
          data-invitation-accept
          type="button"
          :disabled="!!busy || !acknowledged"
          class="rounded-lg bg-neteco-700 px-3 py-2 text-white disabled:opacity-50"
          @click="acceptInvitation"
        >
          Aceptar invitación
        </button>
      </div>
    </div>
    <p v-if="busy" role="status" aria-live="polite">
      {{
        busy === 'preview' ? 'Revisando invitación…' : busy === 'accept' ? 'Confirmando aceptación…' : 'Comprobando…'
      }}
    </p>
    <p
      v-if="message"
      :role="error ? 'alert' : 'status'"
      :data-invitation-error="error ? '' : undefined"
      class="break-words text-sm"
    >
      {{ message }}
    </p>
  </section>
</template>
