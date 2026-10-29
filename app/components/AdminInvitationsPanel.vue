<script setup lang="ts">
import { useAdminNavigation } from '../composables/useAdminNavigation'
import { supportUuid } from '~~/shared/support-operations'
import {
  adminInvitationCreateInputSchema,
  adminInvitationRevokeInputSchema,
  adminInvitationSchema,
  adminInvitationListSchema,
  adminInvitationReceiptSchema,
  adminInvitationCommandSchema,
  adminInvitationIntentHash,
  adminInvitationTokenHash,
  type AdminInvitationCreateInput,
  type AdminInvitationRevokeInput,
  type AdminInvitationList,
  type AdminInvitationReceipt,
  type AdminInvitation
} from '~~/shared/admin-invitations'
const props = defineProps<{ scopeKey: string; enabled: boolean; pending?: boolean }>()
const emit = defineEmits<{ pending: [boolean]; confirmed: [AdminInvitationReceipt] }>()
const auth = useUserSession(),
  navigation = useAdminNavigation(),
  request = useRequestFetch(),
  runtime = useRuntimeConfig(),
  prefix = useId()
const owner = computed(() => {
  const identity = auth.user.value?.id,
    session = auth.session.value?.sessionId,
    version = auth.session.value?.sessionVersion,
    caps = navigation.capabilities.value
  if (
    runtime.public.serverRuntime !== 'cloudflare' ||
    !props.enabled ||
    !props.scopeKey ||
    props.scopeKey.length > 1000 ||
    !auth.ready.value ||
    !auth.loggedIn.value ||
    auth.user.value?.emailVerified !== true ||
    auth.user.value?.mfaVerified !== true ||
    !supportUuid.safeParse(identity).success ||
    !supportUuid.safeParse(session).success ||
    !Number.isSafeInteger(version) ||
    Number(version) < 1 ||
    navigation.status.value !== 'ready' ||
    caps?.state !== 'ready' ||
    caps.identityId !== identity ||
    caps.sessionId !== session ||
    caps.sessionVersion !== version ||
    !caps.permissions.includes('administration.manage')
  )
    return null
  return JSON.stringify([props.scopeKey, identity, session, version])
})
type Intent = {
  owner: string
  key: string
  hash: string
  secret: string | null
  attempted: boolean
} & (
  | { action: 'create'; targetId: null; body: AdminInvitationCreateInput }
  | { action: 'revoke'; targetId: string; body: AdminInvitationRevokeInput }
)
const endpoint = '/api/admin/invitations'
const snapshot = shallowRef<AdminInvitationList | null>(null),
  intent = shallowRef<Intent | null>(null),
  deliverySecret = shallowRef<{ owner: string; invitationId: string; token: string; href: string | null } | null>(null),
  recipientEmail = ref(''),
  roleCode = ref(''),
  expiresInHours = ref<string | number>('24'),
  reason = ref(''),
  revokeReason = ref(''),
  revokeTarget = shallowRef<AdminInvitation | null>(null),
  message = ref(''),
  busy = ref(false),
  blocked = ref<string | null>(null),
  phase = ref<'idle' | 'review' | 'unknown' | 'confirmed' | 'error'>('idle')
let alive = true,
  epoch = 0,
  pendingCommand = false
const controllers = new Set<AbortController>()
const allowed = computed(() => !!owner.value && blocked.value !== owner.value)
function setCommandPending(value: boolean) {
  if (pendingCommand !== value) {
    pendingCommand = value
    emit('pending', value)
  }
}
function reset() {
  epoch++
  controllers.forEach((item) => item.abort())
  controllers.clear()
  snapshot.value = null
  intent.value = null
  deliverySecret.value = null
  recipientEmail.value = ''
  roleCode.value = ''
  expiresInHours.value = '24'
  reason.value = ''
  revokeReason.value = ''
  revokeTarget.value = null
  message.value = ''
  phase.value = 'idle'
  busy.value = false
  setCommandPending(false)
}
function live(turn: number, actor: string) {
  return alive && epoch === turn && allowed.value && owner.value === actor
}
function revokeAuthority(cause: unknown, actor: string) {
  const error = cause as { statusCode?: number; status?: number; response?: { status?: number } }
  if (![401, 403].includes(error?.statusCode ?? error?.status ?? error?.response?.status ?? 0)) return false
  reset()
  blocked.value = actor
  message.value = 'La autorización ha cambiado. Los datos privados y secretos se han borrado.'
  return true
}
function controller() {
  const value = new AbortController()
  controllers.add(value)
  return value
}
async function load(page = 1) {
  const actor = owner.value
  if (!actor || !allowed.value || busy.value || intent.value || props.pending) return
  const turn = epoch,
    abort = controller()
  busy.value = true
  message.value = ''
  deliverySecret.value = null
  revokeTarget.value = null
  try {
    const value = adminInvitationListSchema.parse(
      await request<unknown>(endpoint, {
        method: 'GET',
        query: { page, perPage: 25 },
        retry: 0,
        cache: 'no-store',
        signal: abort.signal
      })
    )
    if (value.page !== page || value.perPage !== 25) throw Error('list_mismatch')
    if (live(turn, actor)) {
      snapshot.value = value
      phase.value = 'idle'
    }
  } catch (cause) {
    if (live(turn, actor) && !revokeAuthority(cause, actor)) {
      snapshot.value = null
      phase.value = 'error'
      message.value = 'No se pudo leer la lista vigente. No se ha supuesto que esté vacía.'
    }
  } finally {
    controllers.delete(abort)
    if (live(turn, actor)) busy.value = false
  }
}
async function review() {
  const actor = owner.value
  if (!actor || !allowed.value || busy.value || props.pending || intent.value || !snapshot.value) return
  const parsed = adminInvitationCreateInputSchema.safeParse({
    recipientEmail: recipientEmail.value,
    roleCode: roleCode.value,
    expiresInHours:
      typeof expiresInHours.value === 'number'
        ? expiresInHours.value
        : /^[0-9]+$/.test(expiresInHours.value.trim())
          ? Number(expiresInHours.value.trim())
          : null,
    reason: reason.value,
    tokenHash: '0'.repeat(64)
  })
  if (!parsed.success || !snapshot.value.roles.some((item) => item.code === parsed.data.roleCode)) {
    message.value = 'Revisa correo, rol autorizado, plazo de 1 a 168 horas y motivo de 10 a 500 caracteres.'
    return
  }
  const turn = epoch
  busy.value = true
  deliverySecret.value = null
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(32)),
      secret = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    bytes.fill(0)
    const body = adminInvitationCreateInputSchema.parse({
        ...parsed.data,
        tokenHash: await adminInvitationTokenHash(secret)
      }),
      hash = await adminInvitationIntentHash('create', null, body)
    if (live(turn, actor)) {
      intent.value = {
        owner: actor,
        key: crypto.randomUUID(),
        hash,
        secret,
        attempted: false,
        action: 'create',
        targetId: null,
        body
      }
      phase.value = 'review'
      message.value = 'Revisa destinatario, permisos y plazo. Todavía no se ha creado ni enviado nada.'
      setCommandPending(true)
    }
  } catch {
    if (live(turn, actor)) message.value = 'No se pudo preparar un secreto seguro. No se ha enviado ningún cambio.'
  } finally {
    if (live(turn, actor)) busy.value = false
  }
}
function chooseRevoke(item: AdminInvitation) {
  if (!allowed.value || busy.value || props.pending || intent.value || item.status !== 'pending') return
  revokeTarget.value = item
  revokeReason.value = ''
  deliverySecret.value = null
  phase.value = 'idle'
  message.value = ''
}
async function reviewRevoke() {
  const actor = owner.value,
    target = revokeTarget.value
  if (!actor || !allowed.value || busy.value || props.pending || intent.value || !target) return
  const parsed = adminInvitationRevokeInputSchema.safeParse({
    expectedVersion: target.version,
    reason: revokeReason.value
  })
  if (!parsed.success) {
    message.value = 'Explica el motivo de la revocación (10 a 500 caracteres).'
    return
  }
  const turn = epoch
  busy.value = true
  try {
    const hash = await adminInvitationIntentHash('revoke', target.id, parsed.data)
    if (live(turn, actor)) {
      intent.value = {
        owner: actor,
        key: crypto.randomUUID(),
        hash,
        secret: null,
        attempted: false,
        action: 'revoke',
        targetId: target.id,
        body: parsed.data
      }
      phase.value = 'review'
      message.value =
        'Confirma la revocación de esta invitación pendiente. No modifica permisos ya aceptados ni cuentas.'
      setCommandPending(true)
    }
  } finally {
    if (live(turn, actor)) busy.value = false
  }
}
function shareHref(secret: string) {
  try {
    const value = new URL(String(runtime.public.baseUrl))
    if (
      value.protocol !== 'https:' ||
      value.username ||
      value.password ||
      value.search ||
      value.hash ||
      value.pathname !== '/'
    )
      return null
    return `${value.origin}/cuenta/invitacion#token=${secret}`
  } catch {
    return null
  }
}
async function acknowledge(raw: unknown, expected: Intent, turn: number, abort: AbortController) {
  const receipt = adminInvitationReceiptSchema.parse(raw)
  if (
    receipt.commandId !== expected.key ||
    receipt.action !== expected.action ||
    receipt.payloadHash !== expected.hash ||
    (expected.action === 'create' &&
      (receipt.version !== 1 || receipt.roleCode !== expected.body.roleCode || receipt.sessionRevoked)) ||
    (expected.action === 'revoke' &&
      (receipt.invitationId !== expected.targetId ||
        receipt.version !== expected.body.expectedVersion + 1 ||
        receipt.sessionRevoked))
  )
    throw Error('receipt_mismatch')
  if (!live(turn, expected.owner) || intent.value?.key !== expected.key) return
  const page = snapshot.value?.page ?? 1
  const freshList = adminInvitationListSchema.parse(
    await request<unknown>(endpoint, {
      method: 'GET',
      query: { page, perPage: 25 },
      retry: 0,
      cache: 'no-store',
      signal: abort.signal
    })
  )
  if (freshList.page !== page || freshList.perPage !== 25) throw Error('list_mismatch')
  if (!live(turn, expected.owner) || intent.value?.key !== expected.key) return
  const current = adminInvitationSchema.parse(
    await request<unknown>(`${endpoint}/${receipt.invitationId}`, {
      method: 'GET',
      retry: 0,
      cache: 'no-store',
      signal: abort.signal
    })
  )
  if (
    current.id !== receipt.invitationId ||
    current.version < receipt.version ||
    current.roleCode !== receipt.roleCode ||
    (expected.action === 'create' &&
      (current.recipientEmail !== expected.body.recipientEmail || current.createdAt !== receipt.recordedAt)) ||
    (expected.action === 'revoke' && (current.status !== 'revoked' || !current.revokedAt)) ||
    (expected.action === 'create' && current.version === receipt.version && current.status !== 'pending')
  )
    throw Error('current_mismatch')
  if (!live(turn, expected.owner) || intent.value?.key !== expected.key) return
  snapshot.value = freshList
  deliverySecret.value =
    expected.action === 'create' &&
    expected.secret &&
    current.status === 'pending' &&
    current.version === receipt.version
      ? { owner: expected.owner, invitationId: current.id, token: expected.secret, href: shareHref(expected.secret) }
      : null
  intent.value = null
  reason.value = ''
  recipientEmail.value = ''
  revokeReason.value = ''
  revokeTarget.value = null
  phase.value = 'confirmed'
  setCommandPending(false)
  message.value =
    expected.action === 'create'
      ? 'Invitación creada y verificada. Compártela manualmente; no se ha enviado ningún correo. Si pierdes el secreto, revoca y crea otra invitación.'
      : 'Revocación verificada. No se han modificado cuentas ni permisos ya aceptados.'
  emit('confirmed', receipt)
}
async function send() {
  const expected = intent.value
  if (
    !expected ||
    !allowed.value ||
    owner.value !== expected.owner ||
    busy.value ||
    props.pending ||
    expected.attempted
  )
    return
  const turn = epoch,
    abort = controller()
  expected.attempted = true
  busy.value = true
  try {
    const value = await request<unknown>(
      expected.action === 'create' ? endpoint : `${endpoint}/${expected.targetId}/revoke`,
      {
        method: 'POST',
        body: expected.body,
        headers: { 'Idempotency-Key': expected.key },
        retry: 0,
        signal: abort.signal
      }
    )
    await acknowledge(value, expected, turn, abort)
  } catch (cause) {
    if (live(turn, expected.owner) && !revokeAuthority(cause, expected.owner)) {
      phase.value = 'unknown'
      message.value =
        'Resultado sin confirmar. Consulta el recibo; no se repetirá ni creará otra invitación automáticamente.'
    }
  } finally {
    controllers.delete(abort)
    if (live(turn, expected.owner)) busy.value = false
  }
}
async function check() {
  const expected = intent.value
  if (!expected || !expected.attempted || !allowed.value || busy.value || props.pending) return
  const turn = epoch,
    abort = controller()
  busy.value = true
  try {
    const result = adminInvitationCommandSchema.parse(
      await request<unknown>(`${endpoint}/commands/${expected.key}`, {
        method: 'GET',
        query: { payloadHash: expected.hash },
        retry: 0,
        cache: 'no-store',
        signal: abort.signal
      })
    )
    if (!live(turn, expected.owner)) return
    if (result.outcome === 'unknown') {
      message.value = 'No hay un recibo confirmado de esta intención. El resultado sigue sin confirmar.'
      return
    }
    await acknowledge(result.receipt, expected, turn, abort)
  } catch (cause) {
    if (live(turn, expected.owner) && !revokeAuthority(cause, expected.owner)) {
      phase.value = 'unknown'
      message.value = 'No se pudo verificar el recibo y la invitación vigente.'
    }
  } finally {
    controllers.delete(abort)
    if (live(turn, expected.owner)) busy.value = false
  }
}
function cancel() {
  if (busy.value || intent.value?.attempted) return
  intent.value = null
  revokeTarget.value = null
  revokeReason.value = ''
  phase.value = 'idle'
  message.value = ''
  setCommandPending(false)
}
async function copy() {
  const value = deliverySecret.value,
    actor = owner.value,
    turn = epoch
  if (!value || !actor || value.owner !== actor || !allowed.value || busy.value || props.pending) return
  try {
    await navigator.clipboard.writeText(value.href ?? value.token)
    if (live(turn, actor)) message.value = 'Copiado para compartir manualmente. No se ha enviado correo.'
  } catch {
    if (live(turn, actor)) message.value = 'No se pudo copiar. Comparte manualmente el enlace o secreto visible.'
  }
}
watch(
  owner,
  () => {
    reset()
    blocked.value = null
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  reset()
})
</script>
<template>
  <section aria-label="Invitaciones de administración" class="min-w-0 space-y-4 rounded-xl border bg-white p-4">
    <h2 class="text-lg font-semibold">Invitaciones de administración</h2>
    <p class="text-sm">
      Invitaciones privadas con rol y caducidad. El enlace se comparte manualmente; no se envía correo.
    </p>
    <p class="text-sm">
      La persona invitada debe tener una cuenta activa con ese correo verificado. No puedes invitarte a ti mismo.
    </p>
    <p v-if="!allowed" role="status">
      Se requiere una sesión vigente, correo verificado, MFA y permiso de administración.
    </p>
    <template v-else>
      <p v-if="message" :role="phase === 'unknown' || phase === 'error' ? 'alert' : 'status'">{{ message }}</p>
      <button
        type="button"
        data-invitations-load
        :disabled="busy || pending || !!intent"
        class="rounded border px-3 py-2"
        @click="load()"
      >
        Leer invitaciones vigentes
      </button>
      <template v-if="snapshot">
        <form class="space-y-3" @submit.prevent="review">
          <fieldset :disabled="busy || pending || !!intent" class="grid gap-3 sm:grid-cols-2">
            <label :for="`${prefix}-email`"
              >Correo de la persona invitada<input
                :id="`${prefix}-email`"
                v-model="recipientEmail"
                data-invitations-email
                type="email"
                maxlength="254"
                autocomplete="off"
                class="block w-full rounded border p-2"
            /></label>
            <label :for="`${prefix}-role`"
              >Rol autorizado<select
                :id="`${prefix}-role`"
                v-model="roleCode"
                data-invitations-role
                class="block w-full rounded border p-2"
              >
                <option value="">Selecciona un rol</option>
                <option v-for="role in snapshot.roles" :key="role.code" :value="role.code">{{ role.code }}</option>
              </select></label
            >
            <p v-if="roleCode" class="break-words text-sm sm:col-span-2">
              Permisos: {{ snapshot.roles.find((role) => role.code === roleCode)?.permissions.join(', ') }}
            </p>
            <label :for="`${prefix}-hours`"
              >Caducidad en horas (1–168)<input
                :id="`${prefix}-hours`"
                v-model="expiresInHours"
                data-invitations-hours
                type="number"
                min="1"
                max="168"
                step="1"
                class="block w-full rounded border p-2"
            /></label>
            <label :for="`${prefix}-reason`" class="sm:col-span-2"
              >Motivo de la invitación<textarea
                :id="`${prefix}-reason`"
                v-model="reason"
                data-invitations-reason
                minlength="10"
                maxlength="500"
                class="block w-full rounded border p-2"
              />
            </label>
            <button data-invitations-review type="submit" class="rounded border px-3 py-2">Revisar invitación</button>
          </fieldset>
        </form>
        <ul class="space-y-3">
          <li v-for="item in snapshot.items" :key="item.id" class="min-w-0 rounded border p-3">
            <p class="break-words">{{ item.recipientEmail }} · {{ item.roleCode }} · {{ item.status }}</p>
            <p class="text-sm">Versión {{ item.version }} · caduca {{ item.expiresAt }}</p>
            <button
              v-if="item.status === 'pending'"
              :data-invitations-revoke="item.id"
              type="button"
              :disabled="busy || pending || !!intent"
              class="rounded border px-3 py-2"
              @click="chooseRevoke(item)"
            >
              Revisar revocación
            </button>
          </li>
        </ul>
        <nav aria-label="Páginas de invitaciones" class="flex flex-wrap gap-2">
          <button
            type="button"
            :disabled="snapshot.page <= 1 || busy || pending || !!intent"
            @click="load(snapshot.page - 1)"
          >
            Anterior
          </button>
          <span>Página {{ snapshot.page }} · {{ snapshot.total }} invitaciones</span>
          <button
            type="button"
            :disabled="snapshot.page * snapshot.perPage >= snapshot.total || busy || pending || !!intent"
            @click="load(snapshot.page + 1)"
          >
            Siguiente
          </button>
        </nav>
      </template>
      <form v-if="revokeTarget && !intent" class="space-y-3" @submit.prevent="reviewRevoke">
        <p class="break-words">
          Revocar invitación para {{ revokeTarget.recipientEmail }} ({{ revokeTarget.roleCode }}).
        </p>
        <label :for="`${prefix}-revoke-reason`"
          >Motivo de revocación<textarea
            :id="`${prefix}-revoke-reason`"
            v-model="revokeReason"
            data-invitations-revoke-reason
            minlength="10"
            maxlength="500"
            :disabled="busy || pending"
            class="block w-full rounded border p-2"
          />
        </label>
        <button
          data-invitations-review-revoke
          type="submit"
          :disabled="busy || pending"
          class="rounded border px-3 py-2"
        >
          Revisar revocación
        </button>
      </form>
      <div v-if="intent && !intent.attempted" class="space-y-3 rounded border p-3">
        <p v-if="intent.action === 'create'" class="break-words">
          Crear invitación para {{ intent.body.recipientEmail }} · rol {{ intent.body.roleCode }} ·
          {{ intent.body.expiresInHours }} horas.
        </p>
        <p v-else>Revocar la invitación revisada en versión {{ intent.body.expectedVersion }}.</p>
        <p class="break-words">{{ intent.body.reason }}</p>
        <button
          data-invitations-confirm
          type="button"
          :disabled="busy || pending"
          class="rounded border px-3 py-2"
          @click="send"
        >
          Confirmar {{ intent.action === 'create' ? 'invitación' : 'revocación' }}
        </button>
        <button type="button" :disabled="busy" @click="cancel">Cancelar revisión</button>
      </div>
      <button
        v-if="intent?.attempted && phase === 'unknown'"
        data-invitations-check
        type="button"
        :disabled="busy || pending"
        class="rounded border px-3 py-2"
        @click="check"
      >
        Consultar recibo y estado vigente
      </button>
      <p v-if="phase === 'confirmed'" data-invitations-confirmed role="status">{{ message }}</p>
      <div v-if="deliverySecret" class="min-w-0 space-y-2 rounded border p-3">
        <p>Guarda este enlace o secreto en un lugar seguro. Sólo está disponible en esta sesión de la pantalla.</p>
        <a
          v-if="deliverySecret.href"
          :href="deliverySecret.href"
          data-invitations-share-link
          referrerpolicy="no-referrer"
          class="block break-all"
          >Enlace privado de aceptación</a
        >
        <p v-else>Origen público HTTPS no válido: comparte el secreto manualmente para la ruta /cuenta/invitacion.</p>
        <code data-invitations-secret class="block break-all">{{ deliverySecret.token }}</code>
        <button
          data-invitations-copy
          type="button"
          :disabled="busy || pending"
          class="rounded border px-3 py-2"
          @click="copy"
        >
          Copiar para compartir manualmente
        </button>
      </div>
    </template>
  </section>
</template>
