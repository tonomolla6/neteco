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
const STATUS: Record<AdminInvitation['status'], [string, 'warning' | 'success' | 'danger' | 'neutral']> = {
  pending: ['Pendiente de aceptar', 'warning'],
  accepted: ['Aceptada', 'success'],
  revoked: ['Anulada', 'danger'],
  expired: ['Caducada', 'neutral']
}
const PERMISSION_AREAS: Record<string, string> = {
  administration: 'Administración',
  support: 'Atención al cliente',
  inventory: 'Inventario',
  orders: 'Pedidos',
  catalog: 'Catálogo',
  customers: 'Clientes',
  marketing: 'Marketing',
  content: 'Contenido',
  pricing: 'Precios',
  returns: 'Devoluciones',
  shipping: 'Envíos',
  reports: 'Informes',
  finance: 'Finanzas'
}
const PERMISSION_ACTIONS: Record<string, string> = {
  manage: 'gestionar',
  read: 'consultar',
  write: 'editar',
  export: 'exportar',
  approve: 'aprobar'
}
function permissionLabel(code: string) {
  const [area = '', action = ''] = code.split('.')
  const name = PERMISSION_AREAS[area] ?? adminHumanize(area)
  return action ? `${name} (${PERMISSION_ACTIONS[action] ?? adminHumanize(action).toLowerCase()})` : name
}
const columns = [
  { key: 'recipientEmail', label: 'Correo' },
  { key: 'roleCode', label: 'Perfil' },
  { key: 'status', label: 'Estado' },
  { key: 'expiresAt', label: 'Caduca', hideOnMobile: true }
]
const statusOptions = [
  { value: 'all', label: 'Todas' },
  { value: 'pending', label: 'Pendientes' },
  { value: 'accepted', label: 'Aceptadas' },
  { value: 'revoked', label: 'Anuladas' },
  { value: 'expired', label: 'Caducadas' }
]
const search = ref(''),
  statusFilter = ref('all')
const filtering = computed(() => !!search.value || statusFilter.value !== 'all')
const rows = computed(() => {
  const term = search.value.toLowerCase()
  return (snapshot.value?.items ?? []).filter(
    (item) =>
      (statusFilter.value === 'all' || item.status === statusFilter.value) &&
      (!term || item.recipientEmail.toLowerCase().includes(term))
  )
})
const selectedRole = computed(() => snapshot.value?.roles.find((role) => role.code === roleCode.value))
function clearFilters() {
  search.value = ''
  statusFilter.value = 'all'
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
  <section aria-label="Invitaciones de administración" class="adm-stack min-w-0">
    <UAlert
      v-if="!allowed"
      role="status"
      color="warning"
      variant="subtle"
      icon="i-lucide-lock"
      title="No puedes gestionar invitaciones ahora mismo"
      description="Hace falta una sesión activa, el correo verificado, la verificación en dos pasos y permiso de administración."
    />
    <template v-else>
      <UAlert
        v-if="message"
        :role="phase === 'unknown' || phase === 'error' ? 'alert' : 'status'"
        :data-invitations-confirmed="phase === 'confirmed' ? '' : undefined"
        :color="phase === 'unknown' || phase === 'error' ? 'error' : phase === 'confirmed' ? 'success' : 'neutral'"
        variant="subtle"
        :icon="
          phase === 'unknown' || phase === 'error'
            ? 'i-lucide-triangle-alert'
            : phase === 'confirmed'
              ? 'i-lucide-circle-check'
              : 'i-lucide-info'
        "
        :title="message"
      />

      <AdminCard v-if="intent && !intent.attempted" title="Revisa antes de confirmar">
        <p v-if="intent.action === 'create'" class="break-words">
          Vas a invitar a <strong>{{ intent.body.recipientEmail }}</strong> con el perfil
          <strong>{{ adminRoleLabel(intent.body.roleCode) }}</strong
          >. La invitación caduca en {{ intent.body.expiresInHours }} horas.
        </p>
        <p v-else>Vas a anular la invitación seleccionada. Quien ya la haya aceptado conserva su acceso.</p>
        <p class="adm-help mt-2 break-words">Motivo: {{ intent.body.reason }}</p>
        <template #footer>
          <button type="button" class="adm-btn adm-btn--secondary" :disabled="busy" @click="cancel">Cancelar</button>
          <button
            data-invitations-confirm
            type="button"
            :disabled="busy || pending"
            class="adm-btn"
            :class="intent.action === 'create' ? 'adm-btn--primary' : 'adm-btn--danger'"
            @click="send"
          >
            Confirmar {{ intent.action === 'create' ? 'invitación' : 'anulación' }}
          </button>
        </template>
      </AdminCard>

      <div v-if="intent?.attempted && phase === 'unknown'">
        <button
          data-invitations-check
          type="button"
          :disabled="busy || pending"
          class="adm-btn adm-btn--secondary"
          @click="check"
        >
          Comprobar si se ha guardado
        </button>
      </div>

      <AdminCard
        v-if="deliverySecret"
        title="Enlace de la invitación"
        description="Guárdalo ahora: solo se muestra una vez. Envíaselo tú a la persona invitada; la tienda no manda ningún correo."
      >
        <div class="adm-stack min-w-0">
          <a
            v-if="deliverySecret.href"
            :href="deliverySecret.href"
            data-invitations-share-link
            referrerpolicy="no-referrer"
            class="block break-all font-semibold text-[var(--color-neteco-700)] underline"
            >Enlace privado de aceptación</a
          >
          <p v-else>
            No se ha podido generar el enlace porque la dirección pública de la tienda no es válida. Comparte esta clave
            para usarla en la página /cuenta/invitacion.
          </p>
          <code
            data-invitations-secret
            class="block break-all rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3 text-xs"
            >{{ deliverySecret.token }}</code
          >
        </div>
        <template #footer>
          <button
            data-invitations-copy
            type="button"
            :disabled="busy || pending"
            class="adm-btn adm-btn--secondary"
            @click="copy"
          >
            <UIcon name="i-lucide-copy" class="size-4" />Copiar enlace
          </button>
        </template>
      </AdminCard>

      <AdminCard v-if="revokeTarget && !intent" title="Anular invitación">
        <form class="adm-stack" @submit.prevent="reviewRevoke">
          <p class="break-words">
            Invitación para <strong>{{ revokeTarget.recipientEmail }}</strong> ({{
              adminRoleLabel(revokeTarget.roleCode)
            }}).
          </p>
          <div class="adm-field">
            <label :for="`${prefix}-revoke-reason`" class="adm-label">Motivo de la anulación</label>
            <textarea
              :id="`${prefix}-revoke-reason`"
              v-model="revokeReason"
              data-invitations-revoke-reason
              minlength="10"
              maxlength="500"
              :disabled="busy || pending"
              class="adm-input"
            />
            <p class="adm-help">Entre 10 y 500 caracteres.</p>
          </div>
          <div class="flex flex-wrap justify-end gap-2">
            <button type="button" class="adm-btn adm-btn--secondary" :disabled="busy" @click="cancel">Cancelar</button>
            <button
              data-invitations-review-revoke
              type="submit"
              :disabled="busy || pending"
              class="adm-btn adm-btn--danger"
            >
              Anular invitación
            </button>
          </div>
        </form>
      </AdminCard>

      <AdminCard v-if="!snapshot">
        <AdminEmptyState
          :variant="phase === 'error' ? 'error' : 'empty'"
          icon="i-lucide-users"
          :title="phase === 'error' ? 'No se han podido cargar las invitaciones' : 'Invitaciones del equipo'"
          description="Por seguridad, la lista solo se consulta cuando la pides."
        >
          <button
            type="button"
            data-invitations-load
            :disabled="busy || pending || !!intent"
            class="adm-btn adm-btn--primary"
            @click="load()"
          >
            {{ phase === 'error' ? 'Reintentar' : 'Ver invitaciones' }}
          </button>
        </AdminEmptyState>
      </AdminCard>

      <div v-else class="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <AdminTable
          :rows="rows"
          :columns="columns"
          :row-key="(row) => row.id"
          :status="busy ? 'pending' : 'success'"
          :total="filtering ? undefined : snapshot.total"
          :per-page="snapshot.perPage"
          :page="filtering ? 1 : snapshot.page"
          :filtered="filtering"
          empty-title="Todavía no has invitado a nadie"
          empty-description="Usa el formulario para dar acceso al panel a otra persona."
          empty-icon="i-lucide-user-plus"
          caption="Invitaciones al panel"
          @update:page="load($event)"
          @clear-filters="clearFilters"
        >
          <template #toolbar>
            <AdminToolbar v-model:search="search" placeholder="Buscar por correo…">
              <AdminFilters v-model="statusFilter" :options="statusOptions" label="Filtrar por estado" />
              <template #actions>
                <button
                  type="button"
                  data-invitations-load
                  :disabled="busy || pending || !!intent"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  @click="load()"
                >
                  <UIcon name="i-lucide-rotate-cw" class="size-4" />Actualizar
                </button>
              </template>
            </AdminToolbar>
          </template>
          <template #cell-recipientEmail="{ row }">
            <span class="break-all font-semibold text-[var(--text-strong)]">{{ row.recipientEmail }}</span>
          </template>
          <template #cell-roleCode="{ row }">{{ adminRoleLabel(row.roleCode) }}</template>
          <template #cell-status="{ row }">
            <AdminBadge :tone="STATUS[row.status][1]">{{ STATUS[row.status][0] }}</AdminBadge>
          </template>
          <template #cell-expiresAt="{ row }">{{ adminDate(row.expiresAt, true) }}</template>
          <template #actions="{ row }">
            <button
              v-if="row.status === 'pending'"
              :data-invitations-revoke="row.id"
              type="button"
              :disabled="busy || pending || !!intent"
              class="adm-btn adm-btn--danger-soft adm-btn--sm"
              @click="chooseRevoke(row)"
            >
              Anular
            </button>
          </template>
        </AdminTable>

        <AdminCard
          title="Invitar a una persona"
          description="Debe tener ya una cuenta en la tienda con ese correo verificado. No puedes invitarte a ti mismo."
        >
          <form @submit.prevent="review">
            <fieldset :disabled="busy || pending || !!intent" class="adm-stack">
              <div class="adm-field">
                <label :for="`${prefix}-email`" class="adm-label">Correo electrónico</label>
                <input
                  :id="`${prefix}-email`"
                  v-model="recipientEmail"
                  data-invitations-email
                  type="email"
                  maxlength="254"
                  autocomplete="off"
                  class="adm-input"
                />
              </div>
              <div class="adm-field">
                <label :for="`${prefix}-role`" class="adm-label">Perfil</label>
                <select :id="`${prefix}-role`" v-model="roleCode" data-invitations-role class="adm-input">
                  <option value="">Elige un perfil</option>
                  <option v-for="role in snapshot.roles" :key="role.code" :value="role.code">
                    {{ adminRoleLabel(role.code) }}
                  </option>
                </select>
                <p v-if="selectedRole" class="adm-help break-words">
                  Podrá: {{ selectedRole.permissions.map(permissionLabel).join(' · ') }}
                </p>
              </div>
              <div class="adm-field">
                <label :for="`${prefix}-hours`" class="adm-label">Válida durante (horas)</label>
                <input
                  :id="`${prefix}-hours`"
                  v-model="expiresInHours"
                  data-invitations-hours
                  type="number"
                  min="1"
                  max="168"
                  step="1"
                  class="adm-input"
                />
                <p class="adm-help">Entre 1 y 168 horas (7 días).</p>
              </div>
              <div class="adm-field">
                <label :for="`${prefix}-reason`" class="adm-label">Motivo</label>
                <textarea
                  :id="`${prefix}-reason`"
                  v-model="reason"
                  data-invitations-reason
                  minlength="10"
                  maxlength="500"
                  class="adm-input"
                />
                <p class="adm-help">Queda guardado en el registro de actividad.</p>
              </div>
              <button data-invitations-review type="submit" class="adm-btn adm-btn--primary w-full justify-center">
                Revisar invitación
              </button>
            </fieldset>
          </form>
        </AdminCard>
      </div>
    </template>
  </section>
</template>
