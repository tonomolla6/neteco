<script setup lang="ts">
import type { AccountSession } from '~/composables/useAccount'
import { z } from 'zod'

definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Acceso y seguridad', robots: 'noindex, nofollow' })

const cloudflare = useRuntimeConfig().public.serverRuntime === 'cloudflare'
const { user, session, ready, loggedIn, fetch: refreshUser } = useUserSession()
const privateScope = computed(() =>
  JSON.stringify([
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified,
    session?.value?.sessionId,
    session?.value?.sessionVersion
  ])
)
const acceptedScope = ref(privateScope.value)
const revoked = ref(false)
let authorityEpoch = 0
let expectedRotation: { identityId: string; sessionId: string; version: number } | null = null
const uncertain = ref(false)
const recovering = ref(false)
const commandPending = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined
const {
  data: sessionData,
  refresh: refreshSessionRead,
  status,
  error: sessionReadError
} = await useFetch<unknown>('/api/account/sessions', { method: 'GET' })
const { notice, errorMessage, busy, run, showNotice, showError } = useAccountFeedback()

function ownRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  const keys = Reflect.ownKeys(value)
  return (
    (prototype === Object.prototype || prototype === null) &&
    keys.length <= 16 &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return typeof key === 'string' && !!descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
    })
  )
}
function sessionDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z')
  )
}
function readSessions(value: unknown): AccountSession[] | null {
  if (
    !ownRecord(value) ||
    !Object.hasOwn(value, 'sessions') ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > 1000 ||
    Object.getPrototypeOf(value.sessions) !== Array.prototype ||
    Reflect.ownKeys(value.sessions).length !== value.sessions.length + 1
  )
    return null
  const sessions: AccountSession[] = []
  const ids = new Set<string>()
  for (let index = 0; index < value.sessions.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.sessions, String(index))
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
    const item: unknown = descriptor.value
    if (
      !ownRecord(item) ||
      !['id', 'current', 'mfaVerified', 'createdAt', 'lastSeenAt', 'expiresAt'].every((key) =>
        Object.hasOwn(item, key)
      ) ||
      typeof item.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.id) ||
      ids.has(item.id) ||
      typeof item.current !== 'boolean' ||
      typeof item.mfaVerified !== 'boolean' ||
      !sessionDate(item.createdAt) ||
      !sessionDate(item.lastSeenAt) ||
      !sessionDate(item.expiresAt)
    )
      return null
    ids.add(item.id)
    sessions.push({
      id: item.id,
      current: item.current,
      mfaVerified: item.mfaVerified,
      createdAt: item.createdAt,
      lastSeenAt: item.lastSeenAt,
      expiresAt: item.expiresAt
    })
  }
  // Both authenticated APIs include the current session. An empty response is
  // not evidence that the account has no other devices, nor a revocation target.
  return sessions.filter((session) => session.current).length === 1 ? sessions : null
}
let active = true
let generation = 0
const pendingRead = ref(false)
const failedRead = ref(false)
const pendingRevocation = ref(false)
function authorized() {
  return (
    active &&
    !revoked.value &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    privateScope.value === acceptedScope.value &&
    z.string().uuid().safeParse(user.value?.id).success &&
    z.string().uuid().safeParse(session?.value?.sessionId).success &&
    Number.isSafeInteger(session?.value?.sessionVersion) &&
    (session?.value?.sessionVersion ?? 0) > 0
  )
}
function readCurrentSessions(value: unknown) {
  const result = readSessions(value)
  return !cloudflare || result?.some((item) => item.current && item.id === session?.value?.sessionId) ? result : null
}
function currentSessions() {
  return active &&
    (!cloudflare || authorized()) &&
    ready.value === true &&
    loggedIn.value === true &&
    !pendingRead.value &&
    !failedRead.value &&
    status.value === 'success' &&
    sessionReadError.value == null
    ? readCurrentSessions(sessionData.value)
    : null
}
const confirmedSessions = computed(currentSessions)
const sessionReadState = computed(() =>
  pendingRead.value || !ready.value || status.value === 'pending' || status.value === 'idle'
    ? 'loading'
    : confirmedSessions.value
      ? 'success'
      : 'error'
)
async function refreshSessions() {
  if (cloudflare && !authorized()) return false
  if (!active || ready.value !== true || loggedIn.value !== true || pendingRead.value) return false
  pendingRead.value = true
  failedRead.value = false
  const request = ++generation
  try {
    await refreshSessionRead()
  } catch {
    if (active && request === generation) failedRead.value = true
  } finally {
    if (active && request === generation) pendingRead.value = false
  }
  return active && request === generation && !!currentSessions()
}
async function retrySessions() {
  if (cloudflare) {
    await recoverSecurity()
    return
  }
  if (!active || pendingRead.value || pendingRevocation.value || busy.value || sessionReadState.value !== 'error')
    return
  showNotice('')
  await refreshSessions()
}
watch(
  [loggedIn, () => user.value?.id],
  () => {
    generation++
    failedRead.value = true
    pendingRead.value = false
    confirmingSession.value = null
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  active = false
  generation++
  if (cloudflare) purgeSecurity()
})

const passwordForm = reactive({ currentPassword: '', newPassword: '', confirmation: '' })

async function changePassword() {
  if (cloudflare) {
    await changeCloudflarePassword()
    return
  }
  if (passwordForm.newPassword !== passwordForm.confirmation) {
    showError({ data: { statusMessage: 'Las contraseñas nuevas no coinciden.' } }, '')
    return
  }
  await run(async () => {
    await $fetch('/api/account/password', {
      method: 'PUT',
      body: { currentPassword: passwordForm.currentPassword, newPassword: passwordForm.newPassword }
    })
    Object.assign(passwordForm, { currentPassword: '', newPassword: '', confirmation: '' })
    if (!(await refreshSessions())) throw new Error('sessions_read_unconfirmed')
    showNotice('Contraseña actualizada. Hemos cerrado el resto de sesiones por seguridad.')
  }, 'No se ha podido cambiar la contraseña.')
}

/* --- MFA ---------------------------------------------------------------
 * Los códigos de recuperación se enseñaban como un párrafo de 12 px en ámbar,
 * unidos por `·`, sin copiar, sin descargar y sin confirmación. Son el dato que
 * evita perder la cuenta: aquí van en su propio paso, monoespaciados, con copia,
 * descarga y una confirmación explícita antes de poder continuar.
 * --------------------------------------------------------------------- */
const enrollment = ref<{ setupId: string; manualKey: string; recoveryCodes: string[] } | null>(null)
const mfaCurrentPassword = ref('')
const mfaCode = ref('')
const codesSaved = ref(false)
const copied = ref(false)

async function beginMfa() {
  if (cloudflare) {
    await beginCloudflareMfa()
    return
  }
  await run(async () => {
    enrollment.value = await $fetch('/api/auth/mfa/setup', {
      method: 'POST',
      body: { currentPassword: mfaCurrentPassword.value }
    })
    mfaCurrentPassword.value = ''
    codesSaved.value = false
    copied.value = false
  }, 'No se ha podido iniciar la configuración.')
}

async function copyCodes() {
  if (cloudflare) {
    if (!canReadSecrets() || !enrollment.value) return
    const request = authorityEpoch
    const enrolled = enrollment.value
    try {
      await navigator.clipboard.writeText(enrolled.recoveryCodes.join('\n'))
      if (!live(request) || enrollment.value !== enrolled) return
      copied.value = true
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        if (live(request)) copied.value = false
      }, 2500)
    } catch {
      if (live(request))
        errorMessage.value = 'No se han podido copiar los códigos. Puedes guardarlos manualmente o descargarlos.'
    }
    return
  }
  if (!enrollment.value) return
  await navigator.clipboard.writeText(enrollment.value.recoveryCodes.join('\n'))
  copied.value = true
  setTimeout(() => (copied.value = false), 2500)
}

function downloadCodes() {
  if (cloudflare && !canReadSecrets()) return
  if (!enrollment.value) return
  const body = [
    'NETECO · códigos de recuperación de acceso',
    `Cuenta: ${user.value?.email ?? ''}`,
    `Generados: ${new Date().toLocaleString('es-ES')}`,
    '',
    'Cada código sirve una sola vez. Guárdalos fuera de tu gestor de contraseñas.',
    '',
    ...enrollment.value.recoveryCodes
  ].join('\n')
  const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'neteco-codigos-recuperacion.txt'
  try {
    link.click()
    codesSaved.value = true
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function verifyMfa() {
  if (cloudflare) {
    await verifyCloudflareMfa()
    return
  }
  if (!enrollment.value) return
  await run(async () => {
    await $fetch('/api/auth/mfa/verify-setup', {
      method: 'POST',
      body: { setupId: enrollment.value!.setupId, code: mfaCode.value }
    })
    const [, sessionsConfirmed] = await Promise.all([refreshUser(), refreshSessions()])
    if (!sessionsConfirmed) throw new Error('sessions_read_unconfirmed')
    enrollment.value = null
    mfaCode.value = ''
    showNotice('Verificación en dos pasos activada.')
  }, 'El código no es correcto o ha caducado.')
}

const confirmingSession = ref<AccountSession | null>(null)

async function revokeSession() {
  if (cloudflare) {
    await revokeCloudflareSession()
    return
  }
  const target = confirmingSession.value
  const sessions = currentSessions()
  if (
    !target ||
    !sessions ||
    pendingRevocation.value ||
    busy.value ||
    !sessions.some((session) => session.id === target.id && !session.current)
  )
    return
  const request = generation
  pendingRevocation.value = true
  showNotice('')
  // A lost DELETE response may already have revoked the device. Invalidate the
  // old list; recovery is a deliberate GET, never an automatic DELETE replay.
  failedRead.value = true
  try {
    await run(async () => {
      try {
        await $fetch(`/api/account/sessions/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
      } catch {
        throw new Error('session_revocation_unconfirmed')
      }
      if (!active || request !== generation || loggedIn.value !== true) return
      confirmingSession.value = null
      if (!(await refreshSessions())) {
        if (active && loggedIn.value === true) throw new Error('sessions_read_unconfirmed')
        return
      }
      if (currentSessions()?.some((session) => session.id === target.id)) {
        failedRead.value = true
        throw new Error('session_revocation_unconfirmed')
      }
      if (active && loggedIn.value === true) showNotice('Sesión cerrada.')
    }, 'No se ha podido confirmar el cierre. Recarga la lista de sesiones antes de intentarlo de nuevo.')
  } finally {
    pendingRevocation.value = false
    if (active) confirmingSession.value = null
  }
}

const otherSessions = computed(() => confirmedSessions.value?.filter((session) => !session.current) ?? [])
const currentSession = computed(() => confirmedSessions.value?.find((session) => session.current))
const canMutate = computed(
  () =>
    authorized() &&
    !!currentSessions() &&
    !busy.value &&
    !commandPending.value &&
    !pendingRevocation.value &&
    !pendingRead.value &&
    !recovering.value &&
    !uncertain.value
)
function live(request: number) {
  return authorized() && request === authorityEpoch
}
function canReadSecrets() {
  return authorized() && !!currentSessions() && !uncertain.value && !recovering.value
}
function clearSecrets() {
  Object.assign(passwordForm, { currentPassword: '', newPassword: '', confirmation: '' })
  mfaCurrentPassword.value = ''
  mfaCode.value = ''
  enrollment.value = null
  confirmingSession.value = null
  codesSaved.value = false
  copied.value = false
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = undefined
}
function purgeSecurity() {
  authorityEpoch++
  generation++
  expectedRotation = null
  clearSecrets()
  sessionData.value = null
  pendingRead.value = false
  pendingRevocation.value = false
  commandPending.value = false
  recovering.value = false
  uncertain.value = false
  busy.value = false
  failedRead.value = true
  notice.value = ''
  errorMessage.value = ''
}
if (cloudflare) {
  watch(
    privateScope,
    () => {
      if (privateScope.value === acceptedScope.value && authorized()) return
      if (
        expectedRotation &&
        active &&
        ready.value === true &&
        loggedIn.value === true &&
        user.value?.id === expectedRotation.identityId &&
        user.value?.emailVerified === true &&
        session?.value?.sessionId === expectedRotation.sessionId &&
        session?.value?.sessionVersion === expectedRotation.version
      ) {
        acceptedScope.value = privateScope.value
        expectedRotation = null
        clearSecrets()
        sessionData.value = null
        failedRead.value = true
        return
      }
      revoked.value = true
      purgeSecurity()
    },
    { immediate: true, flush: 'sync' }
  )
  watch(
    sessionData,
    () => {
      if (!authorized()) sessionData.value = null
    },
    { flush: 'sync' }
  )
}
const userReceiptSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    name: z.string().max(4096).nullable(),
    phone: z.string().max(4096).nullable(),
    company: z.string().max(4096).nullable(),
    role: z.string().min(1).max(80),
    roles: z.array(z.string().min(1).max(80)).max(32),
    emailVerified: z.boolean(),
    mfaVerified: z.boolean()
  })
  .strict()
const enrollmentSchema = z
  .object({
    setupId: z.string().uuid(),
    manualKey: z.string().regex(/^[A-Z2-7]{32}$/),
    uri: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          const uri = new URL(value)
          return uri.protocol === 'otpauth:' && uri.hostname === 'totp' && uri.searchParams.get('issuer') === 'NETECO'
        } catch {
          return false
        }
      }),
    recoveryCodes: z.array(z.string().regex(/^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/)).length(8)
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.recoveryCodes).size === 8 && new URL(value.uri).searchParams.get('secret') === value.manualKey
  )
const okSchema = z.object({ ok: z.literal(true) }).strict()
function serverRevokedAuthority(failure: unknown) {
  const parsed = z
    .object({
      statusCode: z.number().optional(),
      status: z.number().optional(),
      response: z.object({ status: z.number() }).optional(),
      data: z.object({ error: z.object({ code: z.enum(['unauthenticated', 'email_unverified']) }) })
    })
    .safeParse(failure)
  if (!parsed.success) return false
  const status = parsed.data.statusCode ?? parsed.data.status ?? parsed.data.response?.status
  return status === (parsed.data.data.error.code === 'unauthenticated' ? 401 : 403)
}
async function securityCommand(action: (request: number) => Promise<void>) {
  if (!canMutate.value) return
  commandPending.value = true
  busy.value = true
  showNotice('')
  const request = authorityEpoch
  try {
    await action(request)
  } catch (failure) {
    if (!live(request)) return
    if (serverRevokedAuthority(failure)) {
      revoked.value = true
      purgeSecurity()
      errorMessage.value =
        'El acceso de esta sesión ya no está confirmado. Vuelve a cargar la página para verificar tu acceso.'
      return
    }
    uncertain.value = true
    failedRead.value = true
    confirmingSession.value = null
    expectedRotation = null
    errorMessage.value =
      'No podemos confirmar el resultado. Reintenta únicamente la lectura de seguridad antes de realizar otra operación. No se reenviará automáticamente.'
  } finally {
    if (live(request)) {
      commandPending.value = false
      busy.value = false
      expectedRotation = null
    }
  }
}
async function recoverSecurity() {
  if (
    !authorized() ||
    busy.value ||
    commandPending.value ||
    recovering.value ||
    pendingRead.value ||
    (!uncertain.value && sessionReadState.value !== 'error')
  )
    return
  const request = authorityEpoch
  recovering.value = true
  showNotice('')
  try {
    await refreshUser()
    if (!live(request)) return
    if (!(await refreshSessions()) || !live(request)) throw new Error('unconfirmed_sessions')
    uncertain.value = false
    errorMessage.value = ''
    if (user.value?.mfaVerified === true && currentSessions()?.find((item) => item.current)?.mfaVerified === true) {
      enrollment.value = null
      mfaCode.value = ''
      codesSaved.value = false
    }
  } catch {
    if (live(request)) {
      failedRead.value = true
      errorMessage.value = 'No hemos podido confirmar la lectura de seguridad. No se ha reenviado ninguna operación.'
    }
  } finally {
    if (live(request)) recovering.value = false
  }
}
async function changeCloudflarePassword() {
  if (!canMutate.value) return
  const parsed = z
    .object({
      currentPassword: z.string().min(1).max(128),
      newPassword: z
        .string()
        .min(12)
        .max(128)
        .regex(/[a-záéíóúñ]/i)
        .regex(/\d/)
    })
    .safeParse({ currentPassword: passwordForm.currentPassword, newPassword: passwordForm.newPassword })
  if (!parsed.success || passwordForm.newPassword !== passwordForm.confirmation) {
    errorMessage.value = 'Revisa la contraseña actual, los requisitos de la nueva contraseña y su confirmación.'
    return
  }
  const version = session.value!.sessionVersion!
  const identityId = user.value!.id
  const sessionId = session.value!.sessionId!
  const body = Object.freeze(parsed.data)
  await securityCommand(async (request) => {
    const raw = await $fetch<unknown>('/api/account/password', { method: 'PUT', body, retry: 0 })
    if (!live(request)) return
    const receipt = z
      .object({ ok: z.literal(true), sessionVersion: z.number().int().positive(), user: userReceiptSchema })
      .strict()
      .parse(raw)
    if (receipt.user.id !== identityId || receipt.user.emailVerified !== true || receipt.sessionVersion !== version + 1)
      throw new Error('invalid_rotation')
    expectedRotation = { identityId, sessionId, version: receipt.sessionVersion }
    await refreshUser()
    if (!live(request)) return
    expectedRotation = null
    if (session.value?.sessionVersion !== receipt.sessionVersion) throw new Error('unconfirmed_rotation')
    if (!(await refreshSessions()) || !live(request)) throw new Error('unconfirmed_sessions')
    if (currentSessions()?.some((item) => !item.current)) throw new Error('other_sessions_not_closed')
    Object.assign(passwordForm, { currentPassword: '', newPassword: '', confirmation: '' })
    showNotice('Contraseña actualizada. Hemos cerrado el resto de sesiones por seguridad.')
  })
}
async function beginCloudflareMfa() {
  if (!canMutate.value || enrollment.value) return
  if (!z.string().min(1).max(128).safeParse(mfaCurrentPassword.value).success) {
    errorMessage.value = 'Revisa tu contraseña actual.'
    return
  }
  const body = Object.freeze({ currentPassword: mfaCurrentPassword.value })
  await securityCommand(async (request) => {
    const raw = await $fetch<unknown>('/api/auth/mfa/setup', { method: 'POST', body, retry: 0 })
    if (!live(request)) return
    enrollment.value = enrollmentSchema.parse(raw)
    mfaCurrentPassword.value = ''
    codesSaved.value = false
    copied.value = false
  })
}
async function verifyCloudflareMfa() {
  if (!canMutate.value || !enrollment.value || !codesSaved.value || !/^\d{6}$/.test(mfaCode.value)) return
  const body = Object.freeze({ setupId: enrollment.value.setupId, code: mfaCode.value })
  if (!z.string().uuid().safeParse(body.setupId).success) return
  await securityCommand(async (request) => {
    const raw = await $fetch<unknown>('/api/auth/mfa/verify-setup', { method: 'POST', body, retry: 0 })
    if (!live(request)) return
    okSchema.parse(raw)
    await refreshUser()
    if (!live(request)) return
    if (!(await refreshSessions()) || !live(request)) throw new Error('unconfirmed_sessions')
    if (user.value?.mfaVerified !== true || currentSessions()?.find((item) => item.current)?.mfaVerified !== true)
      throw new Error('unconfirmed_mfa')
    enrollment.value = null
    mfaCode.value = ''
    codesSaved.value = false
    showNotice('Verificación en dos pasos activada.')
  })
}
async function revokeCloudflareSession() {
  const target = confirmingSession.value
  if (!target || !canMutate.value || !currentSessions()?.some((item) => item.id === target.id && !item.current)) return
  await securityCommand(async (request) => {
    const raw = await $fetch<unknown>('/api/account/sessions/' + encodeURIComponent(target.id), {
      method: 'DELETE',
      retry: 0
    })
    if (!live(request)) return
    okSchema.parse(raw)
    if (!(await refreshSessions()) || !live(request)) throw new Error('unconfirmed_sessions')
    if (currentSessions()?.some((item) => item.id === target.id)) throw new Error('unconfirmed_revocation')
    confirmingSession.value = null
    showNotice('Sesión cerrada.')
  })
}
</script>

<template>
  <div
    class="min-w-0 space-y-6 break-words"
    :aria-busy="cloudflare ? commandPending || recovering || sessionReadState === 'loading' : undefined"
  >
    <UiPageHeader
      title="Acceso y seguridad"
      description="Tu contraseña, la verificación en dos pasos y los dispositivos con la sesión abierta."
    />

    <AccountFeedback :notice="notice" :error="errorMessage" />

    <UiSurface v-if="!cloudflare || authorized()">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-bold text-[var(--text-strong)]">Verificación en dos pasos</h2>
          <p class="mt-1 max-w-xl text-sm text-[var(--text-muted)]">
            Añade un código de un solo uso desde tu móvil al iniciar sesión. Si administras la tienda, es obligatoria
            para entrar al panel.
          </p>
        </div>
        <UBadge v-if="user?.mfaVerified" color="success" variant="subtle" icon="i-lucide-shield-check">Activada</UBadge>
        <UBadge v-else color="neutral" variant="subtle">Desactivada</UBadge>
      </div>

      <form v-if="!user?.mfaVerified && !enrollment" class="mt-4 max-w-sm space-y-3" @submit.prevent="beginMfa">
        <fieldset class="contents" :disabled="cloudflare && !canMutate">
          <PasswordField
            id="account-mfa-current-password"
            v-model="mfaCurrentPassword"
            label="Contraseña actual"
            autocomplete="current-password"
            required
          />
          <UButton type="submit" :disabled="!mfaCurrentPassword || (cloudflare && !canMutate)" :loading="busy">
            Activar verificación en dos pasos
          </UButton>
        </fieldset>
      </form>

      <div v-if="enrollment" class="mt-5 space-y-5 border-t border-[var(--border)] pt-5">
        <div>
          <h3 class="font-semibold text-[var(--text-strong)]">1 · Añade la cuenta a tu aplicación</h3>
          <p class="mt-1 text-sm text-[var(--text-muted)]">
            En Google Authenticator, 1Password, Authy o similar, elige «añadir cuenta manualmente» e introduce esta
            clave:
          </p>
          <p
            class="mt-2 select-all break-all rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3 font-mono text-sm"
          >
            {{ enrollment.manualKey }}
          </p>
        </div>

        <div>
          <h3 class="font-semibold text-[var(--text-strong)]">2 · Guarda tus códigos de recuperación</h3>
          <p class="mt-1 text-sm text-[var(--text-muted)]">
            Son tu única forma de entrar si pierdes el móvil. Cada uno sirve una sola vez y no volverás a verlos.
          </p>
          <ul
            class="mt-3 grid grid-cols-2 gap-2 rounded-[var(--radius-surface)] border border-[var(--border)] p-3 sm:grid-cols-3"
          >
            <li v-for="code in enrollment.recoveryCodes" :key="code" class="select-all break-all font-mono text-sm">
              {{ code }}
            </li>
          </ul>
          <div class="mt-3 flex flex-wrap gap-2">
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
              :disabled="cloudflare && !canReadSecrets()"
              @click="copyCodes"
            >
              {{ copied ? 'Copiados' : 'Copiar códigos' }}
            </UButton>
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              icon="i-lucide-download"
              :disabled="cloudflare && !canReadSecrets()"
              @click="downloadCodes"
            >
              Descargar
            </UButton>
          </div>
          <UCheckbox
            v-model="codesSaved"
            :disabled="cloudflare && !canMutate"
            class="mt-4"
            label="He guardado los códigos en un sitio seguro"
          />
        </div>

        <div>
          <h3 class="font-semibold text-[var(--text-strong)]">3 · Confirma con un código</h3>
          <p class="mt-1 text-sm text-[var(--text-muted)]">
            Escribe el código de seis cifras que muestra tu aplicación.
          </p>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <UInput
              v-model="mfaCode"
              :disabled="cloudflare && !canMutate"
              maxlength="6"
              inputmode="numeric"
              autocomplete="one-time-code"
              placeholder="000000"
              class="w-36 font-mono"
            />
            <UButton
              :disabled="
                !codesSaved || mfaCode.length !== 6 || (cloudflare && (!canMutate || !/^\d{6}$/.test(mfaCode)))
              "
              :loading="busy"
              @click="verifyMfa"
            >
              Activar
            </UButton>
          </div>
          <p v-if="!codesSaved" class="mt-2 text-sm text-[var(--text-muted)]">
            Confirma antes que has guardado los códigos de recuperación.
          </p>
        </div>
      </div>
    </UiSurface>

    <UiSurface v-if="!cloudflare || authorized()">
      <h2 class="text-lg font-bold text-[var(--text-strong)]">Contraseña</h2>
      <p class="mt-1 text-sm text-[var(--text-muted)]">
        Al cambiarla cerramos el resto de sesiones abiertas. La actual se mantiene.
      </p>
      <form class="mt-5 grid max-w-xl gap-4" @submit.prevent="changePassword">
        <fieldset class="contents" :disabled="cloudflare && !canMutate">
          <PasswordField
            id="account-current-password"
            v-model="passwordForm.currentPassword"
            label="Contraseña actual"
            autocomplete="current-password"
            required
          />
          <PasswordField
            id="account-new-password"
            v-model="passwordForm.newPassword"
            label="Nueva contraseña"
            required
            show-rules
          />
          <PasswordField
            id="account-confirm-password"
            v-model="passwordForm.confirmation"
            label="Repite la nueva contraseña"
            required
            :matches="passwordForm.newPassword"
          />
          <div>
            <UButton type="submit" :disabled="cloudflare && !canMutate" :loading="busy">Cambiar contraseña</UButton>
          </div>
        </fieldset>
      </form>
    </UiSurface>

    <UiSurface>
      <h2 class="text-lg font-bold text-[var(--text-strong)]">Sesiones abiertas</h2>
      <p class="mt-1 text-sm text-[var(--text-muted)]">Si no reconoces alguna, ciérrala y cambia la contraseña.</p>

      <div v-if="sessionReadState === 'loading'" class="mt-4 space-y-2" aria-busy="true" role="status">
        <p class="text-sm text-[var(--text-muted)]">Cargando tus sesiones…</p>
        <div
          v-for="row in 2"
          :key="row"
          class="h-14 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        />
      </div>

      <div v-else-if="sessionReadState === 'error'" class="mt-4 space-y-3">
        <p role="alert" class="text-sm text-[var(--text-muted)]">
          No se han podido cargar tus sesiones. Recarga la lista para comprobar qué dispositivos siguen conectados.
        </p>
        <UButton
          color="neutral"
          variant="outline"
          :disabled="busy || pendingRevocation || !loggedIn || (cloudflare && (!authorized() || recovering))"
          @click="retrySessions"
          >Reintentar</UButton
        >
      </div>
      <ul v-else class="mt-4 divide-y divide-[var(--border)]">
        <li v-if="currentSession" class="flex flex-wrap items-center justify-between gap-3 py-3">
          <div>
            <p class="font-medium text-[var(--text-strong)]">
              Este dispositivo
              <UBadge class="ml-1" color="success" variant="subtle">Sesión actual</UBadge>
            </p>
            <p class="mt-0.5 text-sm text-[var(--text-muted)]">
              Iniciada el {{ formatAccountDateTime(currentSession.createdAt) }}
              <template v-if="currentSession.mfaVerified"> · verificada en dos pasos</template>
            </p>
          </div>
        </li>
        <li
          v-for="device in otherSessions"
          :key="device.id"
          class="flex flex-wrap items-center justify-between gap-3 py-3"
        >
          <div>
            <p class="font-medium text-[var(--text-strong)]">Otro dispositivo</p>
            <p class="mt-0.5 text-sm text-[var(--text-muted)]">
              Última actividad {{ formatAccountDateTime(device.lastSeenAt) }} · iniciada el
              {{ formatAccountDateTime(device.createdAt) }}
            </p>
          </div>
          <UButton
            size="sm"
            color="error"
            variant="outline"
            :disabled="busy || pendingRevocation || (cloudflare && !canMutate)"
            @click="confirmingSession = device"
          >
            Cerrar sesión
          </UButton>
        </li>
        <li v-if="!otherSessions.length" class="py-3 text-sm text-[var(--text-muted)]">
          No hay ninguna otra sesión abierta.
        </li>
      </ul>
    </UiSurface>

    <UModal
      :open="Boolean(confirmingSession)"
      :dismissible="!cloudflare || !commandPending"
      title="Cerrar esta sesión"
      @update:open="(value) => !value && (!cloudflare || !commandPending) && (confirmingSession = null)"
    >
      <template #body>
        <p class="text-[var(--text)]">
          El dispositivo tendrá que volver a iniciar sesión con la contraseña. Si crees que alguien ha entrado en tu
          cuenta, cambia también la contraseña después.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="cloudflare && commandPending"
            @click="confirmingSession = null"
            >Cancelar</UButton
          >
          <UButton
            color="error"
            :loading="busy"
            :disabled="sessionReadState !== 'success' || pendingRevocation || (cloudflare && !canMutate)"
            @click="revokeSession"
            >Cerrar sesión</UButton
          >
        </div>
      </template>
    </UModal>
  </div>
</template>
