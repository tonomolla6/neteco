<script setup lang="ts">
import type { AccountProfile } from '~/composables/useAccount'
import { z } from 'zod'
import { normalizeCustomerTaxId, customerTaxIdIsValid } from '~~/shared/customer-tax-validation'

definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Mis datos', robots: 'noindex, nofollow' })

/**
 * Datos personales y de empresa.
 *
 * En la versión anterior estos tres formularios compartían tarjeta con el cambio de
 * email y convivían en la misma página con el cambio de contraseña: cinco campos de
 * tipo `password` a la vez, que ningún gestor de contraseñas sabe rellenar. Ahora
 * cada formulario tiene su bloque, su explicación y su único motivo para pedir la
 * contraseña actual.
 */
const cloudflare = useRuntimeConfig().public.serverRuntime === 'cloudflare'
const { fetch: refreshUser, loggedIn, user, session } = useUserSession()
const privateScope = computed(() =>
  JSON.stringify([
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified,
    session.value?.sessionId,
    session.value?.sessionVersion
  ])
)
const originalScope = privateScope.value
const revoked = ref(false)
let authorityEpoch = 0
const { data, refresh, status, error } = await useFetch<unknown>('/api/account', { method: 'GET' })
const { notice, errorMessage, busy, run, showNotice } = useAccountFeedback()

function plainOwn(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  const keys = Reflect.ownKeys(value)
  return (
    (prototype === Object.prototype || prototype === null) &&
    keys.length <= 24 &&
    keys.every((key) => {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !!descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
    })
  )
}
const PROFILE_FIELDS = [
  'name',
  'phone',
  'email',
  'company',
  'tradeName',
  'taxId',
  'countryCode',
  'companyStatus',
  'companyRole'
] as const
function nullableText(value: unknown): value is string | null {
  // Read bounds deliberately exceed both write schemas: historical account
  // values need not satisfy today's input rules, and are never normalized here.
  return value === null || (typeof value === 'string' && value.length <= 4096)
}
type ReadProfile = AccountProfile & { companyId?: string | null }
function readProfile(value: unknown): ReadProfile | null {
  if (!plainOwn(value) || !Object.hasOwn(value, 'profile') || !plainOwn(value.profile)) return null
  const profile = value.profile
  if (
    !PROFILE_FIELDS.every((key) => Object.hasOwn(profile, key)) ||
    !nullableText(profile.name) ||
    !nullableText(profile.phone) ||
    typeof profile.email !== 'string' ||
    !profile.email ||
    profile.email.length > 4096 ||
    !nullableText(profile.company) ||
    !nullableText(profile.tradeName) ||
    !nullableText(profile.taxId) ||
    !nullableText(profile.countryCode) ||
    !nullableText(profile.companyStatus) ||
    !nullableText(profile.companyRole)
  )
    return null
  if (
    cloudflare &&
    Object.hasOwn(profile, 'companyId') &&
    profile.companyId !== null &&
    !z.string().uuid().safeParse(profile.companyId).success
  )
    return null
  return {
    ...(cloudflare && Object.hasOwn(profile, 'companyId') ? { companyId: profile.companyId as string | null } : {}),
    name: profile.name,
    phone: profile.phone,
    email: profile.email,
    company: profile.company,
    tradeName: profile.tradeName,
    taxId: profile.taxId,
    countryCode: profile.countryCode,
    companyStatus: profile.companyStatus,
    companyRole: profile.companyRole
  }
}
const retryingRead = ref(false)
const failedRead = ref(false)
const pendingAction = ref(false)
let active = true
const pendingRead = ref(false)
let generation = 0
let readRevision = 0
function authorized() {
  return (
    active &&
    !revoked.value &&
    privateScope.value === originalScope &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    z.string().uuid().safeParse(user.value?.id).success &&
    z.string().uuid().safeParse(session.value?.sessionId).success &&
    Number.isSafeInteger(session.value?.sessionVersion) &&
    (session.value?.sessionVersion ?? 0) > 0
  )
}
function currentProfile() {
  return active &&
    (!cloudflare || authorized()) &&
    loggedIn.value === true &&
    !pendingRead.value &&
    !retryingRead.value &&
    !failedRead.value &&
    status.value === 'success' &&
    error.value == null
    ? readProfile(data.value)
    : null
}
const confirmedProfile = computed(currentProfile)
const readState = computed(() =>
  retryingRead.value || status.value === 'idle' || status.value === 'pending'
    ? 'loading'
    : confirmedProfile.value
      ? 'success'
      : 'error'
)
function canActNow() {
  return !!currentProfile() && !pendingAction.value && !busy.value
}
const canSubmit = computed(canActNow)
const profileForm = reactive({ name: '', phone: '' })
const emailForm = reactive({ email: '', currentPassword: '' })
const companyForm = reactive({
  legalName: '',
  tradeName: '',
  taxId: '',
  countryCode: '',
  currentPassword: ''
})
let baseline: AccountProfile | null = null
function purgePrivate() {
  generation++
  authorityEpoch++
  data.value = null
  baseline = null
  Object.assign(profileForm, { name: '', phone: '' })
  Object.assign(emailForm, { email: '', currentPassword: '' })
  Object.assign(companyForm, { legalName: '', tradeName: '', taxId: '', countryCode: '', currentPassword: '' })
  notice.value = ''
  errorMessage.value = ''
  busy.value = false
  pendingAction.value = false
  pendingRead.value = false
  retryingRead.value = false
}
if (cloudflare) {
  watch(
    privateScope,
    () => {
      if (!authorized()) {
        revoked.value = true
        purgePrivate()
      }
    },
    { immediate: true, flush: 'sync' }
  )
  watch(
    data,
    () => {
      if (!authorized()) data.value = null
    },
    { flush: 'sync' }
  )
}
watch(
  confirmedProfile,
  (profile) => {
    readRevision++
    if (!profile) return
    const contact = { name: profile.name ?? '', phone: profile.phone ?? '' }
    const previousContact = baseline ? { name: baseline.name ?? '', phone: baseline.phone ?? '' } : null
    for (const key of ['name', 'phone'] as const) {
      if (!previousContact || profileForm[key] === previousContact[key]) profileForm[key] = contact[key]
    }
    const company = {
      legalName: profile.company ?? '',
      tradeName: profile.tradeName ?? '',
      taxId: profile.taxId ?? '',
      countryCode: profile.countryCode ?? ''
    }
    const previousCompany = baseline
      ? {
          legalName: baseline.company ?? '',
          tradeName: baseline.tradeName ?? '',
          taxId: baseline.taxId ?? '',
          countryCode: baseline.countryCode ?? ''
        }
      : null
    for (const key of ['legalName', 'tradeName', 'taxId', 'countryCode'] as const) {
      if (!previousCompany || companyForm[key] === previousCompany[key]) companyForm[key] = company[key]
    }
    baseline = profile
  },
  { immediate: true, flush: 'sync' }
)
function sameProfile(left: AccountProfile | null, right: AccountProfile) {
  return !!left && PROFILE_FIELDS.every((key) => left[key] === right[key])
}
async function readAgain(withSession: boolean) {
  pendingRead.value = true
  retryingRead.value = true
  failedRead.value = false
  const request = ++generation
  try {
    await refresh()
  } catch {
    if (active && request === generation) failedRead.value = true
  } finally {
    if (active && request === generation) {
      pendingRead.value = false
      retryingRead.value = false
    }
  }
  const profile = currentProfile()
  if (!active || request !== generation || !profile) return false
  if (withSession) {
    const revision = readRevision
    try {
      await refreshUser()
    } catch (failure) {
      if (active && request === generation && revision === readRevision && sameProfile(currentProfile(), profile))
        throw failure
      return false
    }
    return active && request === generation && revision === readRevision && sameProfile(currentProfile(), profile)
  }
  return true
}
async function retryRead() {
  if (cloudflare && !authorized()) return
  if (!active || pendingRead.value || pendingAction.value || busy.value || readState.value !== 'error') return
  showNotice('')
  await readAgain(false)
}
onBeforeUnmount(() => {
  active = false
  generation++
  if (cloudflare) purgePrivate()
})

const COUNTRIES = [
  { label: 'España', value: 'ES' },
  { label: 'Portugal', value: 'PT' },
  { label: 'Francia', value: 'FR' },
  { label: 'Andorra', value: 'AD' }
]

const companyStatus = computed(() => {
  const raw = confirmedProfile.value?.companyStatus
  return raw
    ? Object.hasOwn(COMPANY_STATUS, raw)
      ? COMPANY_STATUS[raw]
      : { label: raw, color: 'neutral' as const }
    : null
})

async function executeCommand(
  endpoint: '/api/account/profile' | '/api/account/company' | '/api/account/email-change',
  method: 'PUT' | 'POST',
  body: Record<string, string>,
  afterRead: boolean,
  completed: (result: unknown) => void,
  fallback: string
) {
  if (cloudflare) {
    await executeCloudflare(endpoint, method, body, afterRead, completed, fallback)
    return
  }
  const authority = currentProfile()
  if (!authority || pendingAction.value || busy.value) return
  pendingAction.value = true
  showNotice('')
  const revision = readRevision
  const current = () => active && revision === readRevision && sameProfile(currentProfile(), authority)
  try {
    await run(async () => {
      let result: unknown
      try {
        result = await $fetch(endpoint, { method, body })
      } catch (failure) {
        if (!current()) return
        // A rejected PUT may already have committed. Keep every input, but
        // require an explicit fresh GET before permitting another command.
        if (method === 'PUT') failedRead.value = true
        throw failure
      }
      if (!current()) return
      if (afterRead && !(await readAgain(true))) return
      if (active && currentProfile()) completed(result)
    }, fallback)
  } finally {
    pendingAction.value = false
  }
}
const receiptUserSchema = z
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
const profileReceiptSchema = z.object({ user: receiptUserSchema }).strict()
const companyReceiptSchema = z
  .object({
    companyId: z.string().uuid(),
    status: z.enum(['pending', 'approved', 'rejected', 'suspended']),
    user: receiptUserSchema
  })
  .strict()
async function executeCloudflare(
  endpoint: '/api/account/profile' | '/api/account/company' | '/api/account/email-change',
  method: 'PUT' | 'POST',
  body: Record<string, string>,
  afterRead: boolean,
  completed: (result: unknown) => void,
  fallback: string
) {
  if (!canActNow() || !authorized()) return
  pendingAction.value = true
  busy.value = true
  showNotice('')
  const request = authorityEpoch
  const revision = readRevision
  const authority = currentProfile()!
  const command = Object.freeze({ ...body })
  const current = () => authorized() && request === authorityEpoch
  try {
    // ofetch does not retry PUT/POST by default; retain the existing transport contract.
    const result = await $fetch<unknown>(endpoint, { method, body: command })
    if (!current() || revision !== readRevision || !sameProfile(currentProfile(), authority)) return
    let companyReceipt: z.infer<typeof companyReceiptSchema> | null = null
    if (endpoint === '/api/account/profile') {
      if (profileReceiptSchema.parse(result).user.id !== user.value?.id) throw new Error('wrong_owner')
    } else if (endpoint === '/api/account/company') {
      companyReceipt = companyReceiptSchema.parse(result)
      if (companyReceipt.user.id !== user.value?.id) throw new Error('wrong_owner')
    }
    if (afterRead) {
      if (!(await readAgain(true)) || !current()) throw new Error('unconfirmed_profile')
      const fresh = currentProfile()
      if (!fresh) throw new Error('unconfirmed_profile')
      if (endpoint === '/api/account/profile' && (fresh.name !== command.name || (fresh.phone ?? '') !== command.phone))
        throw new Error('unconfirmed_contact')
      if (
        companyReceipt &&
        (fresh.companyId !== companyReceipt.companyId ||
          fresh.companyStatus !== companyReceipt.status ||
          fresh.company !== command.legalName ||
          (fresh.tradeName ?? '') !== command.tradeName ||
          fresh.taxId !== command.taxId ||
          fresh.countryCode !== command.countryCode)
      )
        throw new Error('unconfirmed_company')
    }
    if (current()) completed(result)
  } catch {
    if (!current()) return
    if (method === 'PUT') failedRead.value = true
    errorMessage.value =
      fallback +
      ' No podemos confirmar el resultado. Revisa tus datos con Reintentar antes de volver a guardar; no se ha reenviado la operación.'
  } finally {
    if (current()) {
      pendingAction.value = false
      busy.value = false
    }
  }
}
async function saveProfile() {
  if (!canActNow()) return
  if (typeof profileForm.name !== 'string' || typeof profileForm.phone !== 'string') return
  const command = { name: profileForm.name, phone: profileForm.phone }
  if (cloudflare) {
    const parsed = z
      .object({
        name: z.string().trim().min(2).max(160),
        phone: z
          .string()
          .trim()
          .max(32)
          .refine((value) => !value || value.length >= 6)
      })
      .safeParse(command)
    if (!parsed.success) {
      errorMessage.value = 'Revisa el nombre y el teléfono.'
      return
    }
    Object.assign(command, parsed.data)
    Object.assign(profileForm, parsed.data)
  }
  await executeCommand(
    '/api/account/profile',
    'PUT',
    command,
    true,
    () => {
      if (profileForm.name === command.name && profileForm.phone === command.phone) showNotice('Datos actualizados.')
    },
    'No se han podido actualizar tus datos.'
  )
}
async function requestEmailChange() {
  if (!canActNow()) return
  if (typeof emailForm.email !== 'string' || typeof emailForm.currentPassword !== 'string') return
  const command = { email: emailForm.email, currentPassword: emailForm.currentPassword }
  await executeCommand(
    '/api/account/email-change',
    'POST',
    command,
    false,
    (result) => {
      if (
        !plainOwn(result) ||
        !Object.hasOwn(result, 'message') ||
        typeof result.message !== 'string' ||
        result.message.length > 4096
      )
        throw new Error('Invalid email-change response')
      const unchanged = emailForm.currentPassword === command.currentPassword && emailForm.email === command.email
      if (emailForm.currentPassword === command.currentPassword) emailForm.currentPassword = ''
      if (emailForm.email === command.email) emailForm.email = ''
      if (unchanged) showNotice(result.message)
    },
    'No se ha podido solicitar el cambio de email.'
  )
}
async function saveCompany() {
  if (!canActNow()) return
  const command = {
    legalName: companyForm.legalName,
    tradeName: companyForm.tradeName,
    taxId: companyForm.taxId,
    countryCode: companyForm.countryCode,
    currentPassword: companyForm.currentPassword
  }
  if (Object.values(command).some((value) => typeof value !== 'string')) return
  if (cloudflare) {
    const parsed = z
      .object({
        legalName: z.string().trim().min(2).max(200),
        tradeName: z.string().trim().max(200),
        taxId: z.string().trim().min(3).max(32),
        countryCode: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{2}$/),
        currentPassword: z.string().min(1).max(128)
      })
      .safeParse(command)
    if (!parsed.success || !customerTaxIdIsValid(parsed.data.countryCode, parsed.data.taxId, { required: true })) {
      errorMessage.value = 'Revisa los datos profesionales y el identificador fiscal.'
      return
    }
    Object.assign(command, parsed.data, { taxId: normalizeCustomerTaxId(parsed.data.taxId) })
    Object.assign(companyForm, command)
  }
  await executeCommand(
    '/api/account/company',
    'PUT',
    command,
    true,
    () => {
      const unchanged = (Object.keys(command) as Array<keyof typeof command>).every(
        (key) => companyForm[key] === command[key]
      )
      if (companyForm.currentPassword === command.currentPassword) companyForm.currentPassword = ''
      if (unchanged)
        showNotice(
          cloudflare && currentProfile()?.companyStatus !== 'pending'
            ? 'Datos profesionales actualizados.'
            : 'Datos profesionales enviados a revisión.'
        )
    },
    'No se han podido guardar los datos profesionales.'
  )
}
</script>

<template>
  <div class="space-y-6" :aria-busy="readState === 'loading' || pendingAction || busy">
    <UiPageHeader title="Datos y empresa" description="Tus datos de contacto y los de facturación de tu negocio." />

    <AccountFeedback :notice="confirmedProfile ? notice : ''" :error="errorMessage" />

    <UiSurface v-if="readState === 'loading'">
      <p role="status">Cargando tus datos…</p>
    </UiSurface>
    <UiSurface v-else-if="readState === 'error'">
      <p role="alert">No hemos podido cargar tus datos. Vuelve a intentarlo antes de hacer cambios.</p>
      <UButton class="mt-4" type="button" :disabled="pendingAction || busy" @click="retryRead">Reintentar</UButton>
    </UiSurface>

    <template v-else-if="confirmedProfile">
      <UiSurface>
        <h2 id="account-contact-title" class="text-lg font-bold text-[var(--text-strong)]">Datos de contacto</h2>
        <p class="mt-1 text-sm text-[var(--text-muted)]">
          Los usamos para avisarte del estado de tus pedidos y para el reparto.
        </p>
        <form class="mt-5" aria-labelledby="account-contact-title" @submit.prevent="saveProfile">
          <fieldset
            class="grid min-w-0 gap-4 grid-cols-1 sm:grid-cols-2"
            aria-labelledby="account-contact-title"
            :disabled="!canSubmit"
          >
            <UFormField label="Nombre y apellidos" required>
              <UInput v-model="profileForm.name" class="w-full" autocomplete="name" />
            </UFormField>
            <UFormField label="Teléfono">
              <UInput v-model="profileForm.phone" type="tel" class="w-full" autocomplete="tel" />
            </UFormField>
            <div class="sm:col-span-2">
              <UButton type="submit" :disabled="!canSubmit" :loading="busy">Guardar datos</UButton>
            </div>
          </fieldset>
        </form>
      </UiSurface>

      <UiSurface>
        <h2 id="account-email-title" class="text-lg font-bold text-[var(--text-strong)]">Correo electrónico</h2>
        <div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <UIcon name="i-lucide-mail" class="size-4 text-[var(--text-muted)]" />
          <span class="font-medium text-[var(--text-strong)]">{{ confirmedProfile.email }}</span>
        </div>
        <p class="mt-3 text-sm text-[var(--text-muted)]">
          Para cambiarlo te enviamos un enlace de confirmación a la dirección nueva. El correo actual sigue activo hasta
          que confirmes.
        </p>
        <form class="mt-4" aria-labelledby="account-email-title" @submit.prevent="requestEmailChange">
          <fieldset
            class="grid min-w-0 gap-4 grid-cols-1 sm:grid-cols-2"
            aria-labelledby="account-email-title"
            :disabled="!canSubmit"
          >
            <UFormField label="Nuevo correo electrónico" required>
              <UInput v-model="emailForm.email" type="email" class="w-full" autocomplete="email" />
            </UFormField>
            <UFormField label="Tu contraseña actual" required hint="Para confirmar que eres tú">
              <UInput
                v-model="emailForm.currentPassword"
                type="password"
                class="w-full"
                autocomplete="current-password"
              />
            </UFormField>
            <div class="sm:col-span-2">
              <UButton type="submit" color="neutral" variant="outline" :disabled="!canSubmit" :loading="busy"
                >Enviar confirmación</UButton
              >
            </div>
          </fieldset>
        </form>
      </UiSurface>

      <UiSurface>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 id="account-company-title" class="text-lg font-bold text-[var(--text-strong)]">
            {{ confirmedProfile.company ? 'Datos de facturación' : 'Solicitar cuenta profesional' }}
          </h2>
          <UBadge v-if="companyStatus" :color="companyStatus.color" variant="subtle">{{ companyStatus.label }}</UBadge>
        </div>
        <p class="mt-1 text-sm text-[var(--text-muted)]">
          <template v-if="confirmedProfile.company">
            <template v-if="cloudflare"
              >Aparecen en tus facturas. Los cambios fiscales pueden requerir revisión; consulta el estado
              indicado.</template
            >
            <template v-else>Aparecen en tus facturas. Cualquier cambio pasa por revisión antes de aplicarse.</template>
          </template>
          <template v-else>
            Con la cuenta profesional facturamos a nombre de tu empresa y accedes a las condiciones de cliente.
          </template>
        </p>
        <p v-if="confirmedProfile.companyRole" class="mt-2 text-sm text-[var(--text-muted)]">
          Tu papel en la cuenta:
          {{
            Object.hasOwn(COMPANY_ROLE, confirmedProfile.companyRole)
              ? COMPANY_ROLE[confirmedProfile.companyRole]
              : confirmedProfile.companyRole
          }}
        </p>

        <form class="mt-5" aria-labelledby="account-company-title" @submit.prevent="saveCompany">
          <fieldset
            class="grid min-w-0 gap-4 grid-cols-1 sm:grid-cols-2"
            aria-labelledby="account-company-title"
            :disabled="!canSubmit"
          >
            <UFormField label="Razón social" required>
              <UInput v-model="companyForm.legalName" class="w-full" autocomplete="organization" />
            </UFormField>
            <UFormField label="Nombre comercial" hint="Si es distinto de la razón social">
              <UInput v-model="companyForm.tradeName" class="w-full" />
            </UFormField>
            <UFormField label="NIF / CIF / VAT" required>
              <UInput v-model="companyForm.taxId" class="w-full" />
            </UFormField>
            <UFormField label="País" required>
              <USelect v-model="companyForm.countryCode" :items="COUNTRIES" class="w-full" />
            </UFormField>
            <UFormField class="sm:col-span-2" label="Tu contraseña actual" required hint="Para confirmar que eres tú">
              <UInput
                v-model="companyForm.currentPassword"
                type="password"
                class="w-full"
                autocomplete="current-password"
              />
            </UFormField>
            <div class="sm:col-span-2">
              <UButton type="submit" color="neutral" variant="outline" :disabled="!canSubmit" :loading="busy"
                >Enviar a revisión</UButton
              >
            </div>
          </fieldset>
        </form>
      </UiSurface>
    </template>
  </div>
</template>
