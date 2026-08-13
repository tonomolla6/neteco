<script setup lang="ts">
definePageMeta({ middleware: 'auth' })
useSeoMeta({ title: 'Mi cuenta', robots: 'noindex, nofollow' })

interface OrderSummary {
  id: string
  status: string
  total: number
  createdAt: string
  lines: number
}

interface AccountProfile {
  name: string | null
  phone: string | null
  email: string
  company: string | null
  tradeName: string | null
  taxId: string | null
  countryCode: string | null
  companyStatus: string | null
  companyRole: string | null
}

interface Address {
  id: string
  kind: 'shipping' | 'billing' | 'both'
  label: string
  recipientName: string
  companyName: string | null
  taxId: string | null
  line1: string
  line2: string | null
  postalCode: string
  city: string
  region: string
  countryCode: string
  phone: string | null
  instructions: string | null
  isDefault: boolean
}

interface AccountSession {
  id: string
  mfaVerified: boolean
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  current: boolean
}

interface Preference {
  purpose: 'newsletter' | 'product_updates' | 'replenishment' | 'transactional'
  channel: 'email' | 'sms' | 'whatsapp'
  enabled: boolean
  frequency: 'immediate' | 'weekly' | 'monthly'
  topics: string[]
}

interface PrivacyRequest {
  id: string
  requestType: 'export' | 'anonymize'
  status: string
  requestedAt: string
  dueAt: string
  completedAt: string | null
}

interface FavoriteList {
  id: string
  name: string
  items: Array<{ variantId: string; sku: string; quantity: string; name: string; slug: string; available: boolean }>
}

const { user, clear, fetch: refreshUser } = useUserSession()
const { data: accountData, refresh: refreshAccount } = await useFetch<{ profile: AccountProfile }>('/api/account')
const { data: orderData } = await useFetch<{ orders: OrderSummary[] }>('/api/orders')
const { data: addressData, refresh: refreshAddresses } = await useFetch<{ addresses: Address[] }>(
  '/api/account/addresses'
)
const { data: sessionData, refresh: refreshSessions } = await useFetch<{ sessions: AccountSession[] }>(
  '/api/account/sessions'
)
const { data: preferenceData, refresh: refreshPreferences } = await useFetch<{ preferences: Preference[] }>(
  '/api/account/preferences'
)
const { data: privacyData, refresh: refreshPrivacy } = await useFetch<{ requests: PrivacyRequest[] }>(
  '/api/account/privacy'
)
const { data: favoriteData, refresh: refreshFavorites } = await useFetch<{ lists: FavoriteList[] }>(
  '/api/account/favorites'
)

const profileForm = reactive({
  name: accountData.value?.profile.name ?? '',
  phone: accountData.value?.profile.phone ?? ''
})
const addressForm = reactive({
  kind: 'both' as Address['kind'],
  label: '',
  recipientName: accountData.value?.profile.name ?? '',
  companyName: accountData.value?.profile.company ?? '',
  taxId: accountData.value?.profile.taxId ?? '',
  line1: '',
  line2: '',
  postalCode: '',
  city: '',
  region: '',
  countryCode: 'ES',
  phone: accountData.value?.profile.phone ?? '',
  instructions: '',
  isDefault: false
})
const communication = reactive<Record<'newsletter' | 'product_updates' | 'replenishment', boolean>>({
  newsletter: preferenceData.value?.preferences.some((item) => item.purpose === 'newsletter' && item.enabled) ?? false,
  product_updates:
    preferenceData.value?.preferences.some((item) => item.purpose === 'product_updates' && item.enabled) ?? false,
  replenishment:
    preferenceData.value?.preferences.some((item) => item.purpose === 'replenishment' && item.enabled) ?? false
})
const notice = ref('')
const errorMessage = ref('')
const busy = ref(false)
const mfaEnrollment = ref<{ manualKey: string; recoveryCodes: string[] } | null>(null)
const mfaCode = ref('')
const emailChangeForm = reactive({ email: '', currentPassword: '' })
const passwordForm = reactive({ currentPassword: '', newPassword: '', confirmation: '' })
const companyForm = reactive({
  legalName: accountData.value?.profile.company ?? '',
  tradeName: accountData.value?.profile.tradeName ?? '',
  taxId: accountData.value?.profile.taxId ?? '',
  countryCode: accountData.value?.profile.countryCode ?? 'ES',
  currentPassword: ''
})

function showError(error: unknown, fallback: string) {
  const candidate = error as { data?: { statusMessage?: string } }
  errorMessage.value = candidate.data?.statusMessage ?? fallback
  notice.value = ''
}

async function saveProfile() {
  busy.value = true
  errorMessage.value = ''
  try {
    await $fetch('/api/account/profile', { method: 'PUT', body: profileForm })
    await Promise.all([refreshAccount(), refreshUser()])
    notice.value = 'Perfil actualizado.'
  } catch (error) {
    showError(error, 'No se ha podido actualizar el perfil.')
  } finally {
    busy.value = false
  }
}

async function requestEmailChange() {
  busy.value = true
  errorMessage.value = ''
  try {
    const result = await $fetch<{ message: string }>('/api/account/email-change', {
      method: 'POST',
      body: emailChangeForm
    })
    emailChangeForm.currentPassword = ''
    notice.value = result.message
  } catch (error) {
    showError(error, 'No se ha podido solicitar el cambio de email.')
  } finally {
    busy.value = false
  }
}

async function changePassword() {
  if (passwordForm.newPassword !== passwordForm.confirmation) {
    errorMessage.value = 'Las contraseñas nuevas no coinciden.'
    return
  }
  busy.value = true
  errorMessage.value = ''
  try {
    await $fetch('/api/account/password', {
      method: 'PUT',
      body: { currentPassword: passwordForm.currentPassword, newPassword: passwordForm.newPassword }
    })
    Object.assign(passwordForm, { currentPassword: '', newPassword: '', confirmation: '' })
    await refreshSessions()
    notice.value = 'Contraseña actualizada y demás sesiones revocadas.'
  } catch (error) {
    showError(error, 'No se ha podido cambiar la contraseña.')
  } finally {
    busy.value = false
  }
}

async function saveCompany() {
  busy.value = true
  errorMessage.value = ''
  try {
    await $fetch('/api/account/company', { method: 'PUT', body: companyForm })
    companyForm.currentPassword = ''
    await Promise.all([refreshAccount(), refreshUser()])
    notice.value = 'Datos profesionales enviados a revisión.'
  } catch (error) {
    showError(error, 'No se han podido guardar los datos profesionales.')
  } finally {
    busy.value = false
  }
}

async function addAddress() {
  busy.value = true
  errorMessage.value = ''
  try {
    await $fetch('/api/account/addresses', { method: 'POST', body: addressForm })
    await refreshAddresses()
    Object.assign(addressForm, {
      label: '',
      line1: '',
      line2: '',
      postalCode: '',
      city: '',
      region: '',
      instructions: '',
      isDefault: false
    })
    notice.value = 'Dirección guardada.'
  } catch (error) {
    showError(error, 'No se ha podido guardar la dirección.')
  } finally {
    busy.value = false
  }
}

async function deleteAddress(id: string) {
  if (!confirm('¿Eliminar esta dirección? Los pedidos históricos conservarán su copia.')) return
  await $fetch(`/api/account/addresses/${id}`, { method: 'DELETE' })
  await refreshAddresses()
}

async function savePreferences() {
  const preferences = (Object.keys(communication) as Array<keyof typeof communication>).map((purpose) => ({
    purpose,
    channel: 'email' as const,
    enabled: communication[purpose],
    frequency: 'immediate' as const,
    topics: []
  }))
  await $fetch('/api/account/preferences', { method: 'PUT', body: { preferences } })
  await refreshPreferences()
  notice.value = 'Preferencias actualizadas.'
}

async function revokeSession(id: string) {
  await $fetch(`/api/account/sessions/${id}`, { method: 'DELETE' })
  await refreshSessions()
}

async function requestPrivacy(requestType: 'export' | 'anonymize') {
  if (
    requestType === 'anonymize' &&
    !confirm('¿Solicitar la anonimización? Se revisarán las obligaciones fiscales vigentes.')
  ) {
    return
  }
  const request = await $fetch<PrivacyRequest>('/api/account/privacy', {
    method: 'POST',
    body: { requestType, idempotencyKey: crypto.randomUUID() }
  })
  await refreshPrivacy()
  if (requestType === 'export') {
    window.location.assign(`/api/account/privacy/${request.id}/download`)
  } else {
    notice.value = 'Solicitud registrada. El plazo y estado aparecen en esta página.'
  }
}

async function removeFavorite(variantId: string) {
  await $fetch(`/api/account/favorites/${variantId}`, { method: 'DELETE' })
  await refreshFavorites()
}

async function beginMfa() {
  mfaEnrollment.value = await $fetch('/api/auth/mfa/setup', { method: 'POST' })
}

async function verifyMfa() {
  await $fetch('/api/auth/mfa/verify-setup', { method: 'POST', body: { code: mfaCode.value } })
  await refreshUser()
  mfaEnrollment.value = null
  mfaCode.value = ''
  notice.value = 'Autenticación multifactor activada.'
}

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  await navigateTo('/')
}
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-8">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Hola, {{ user?.name }}</h1>
        <p class="mt-1 text-sm text-slate-500">
          {{ user?.email }}<template v-if="user?.company"> · {{ user.company }}</template>
        </p>
      </div>
      <UButton color="neutral" variant="soft" icon="i-lucide-log-out" @click="logout">Cerrar sesión</UButton>
    </div>

    <UAlert v-if="notice" class="mt-5" color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />
    <UAlert
      v-if="errorMessage"
      class="mt-5"
      color="error"
      variant="subtle"
      icon="i-lucide-alert-circle"
      :title="errorMessage"
    />

    <div class="mt-8 grid gap-6 lg:grid-cols-2">
      <section class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="text-lg font-bold text-slate-900">Datos personales</h2>
        <form class="mt-4 space-y-4" @submit.prevent="saveProfile">
          <UFormField label="Nombre y apellidos" required
            ><UInput v-model="profileForm.name" class="w-full"
          /></UFormField>
          <UFormField label="Email"
            ><UInput :model-value="accountData?.profile.email" class="w-full" disabled
          /></UFormField>
          <UFormField label="Teléfono"><UInput v-model="profileForm.phone" class="w-full" type="tel" /></UFormField>
          <UButton type="submit" :loading="busy">Guardar perfil</UButton>
        </form>
        <form class="mt-6 space-y-3 border-t border-slate-100 pt-5" @submit.prevent="requestEmailChange">
          <h3 class="font-semibold text-slate-800">Cambiar email</h3>
          <UFormField label="Nuevo email" required
            ><UInput v-model="emailChangeForm.email" class="w-full" type="email" autocomplete="email"
          /></UFormField>
          <UFormField label="Contraseña actual" required
            ><UInput
              v-model="emailChangeForm.currentPassword"
              class="w-full"
              type="password"
              autocomplete="current-password"
          /></UFormField>
          <UButton type="submit" variant="soft" :loading="busy">Enviar confirmación</UButton>
        </form>
        <form class="mt-6 space-y-3 border-t border-slate-100 pt-5" @submit.prevent="saveCompany">
          <h3 class="font-semibold text-slate-800">
            {{ accountData?.profile.company ? 'Datos profesionales' : 'Solicitar cuenta profesional' }}
          </h3>
          <p v-if="accountData?.profile.companyStatus" class="text-sm text-slate-500">
            Estado: {{ accountData.profile.companyStatus }} · {{ accountData.profile.companyRole }}
          </p>
          <UFormField label="Razón social" required
            ><UInput v-model="companyForm.legalName" class="w-full" autocomplete="organization"
          /></UFormField>
          <UFormField label="Nombre comercial"><UInput v-model="companyForm.tradeName" class="w-full" /></UFormField>
          <div class="grid grid-cols-3 gap-3">
            <UFormField label="País" required
              ><UInput v-model="companyForm.countryCode" maxlength="2" class="w-full"
            /></UFormField>
            <UFormField label="NIF/CIF/VAT" required class="col-span-2"
              ><UInput v-model="companyForm.taxId" class="w-full"
            /></UFormField>
          </div>
          <UFormField label="Contraseña actual" required
            ><UInput
              v-model="companyForm.currentPassword"
              type="password"
              autocomplete="current-password"
              class="w-full"
          /></UFormField>
          <UButton type="submit" variant="soft" :loading="busy">Enviar a revisión</UButton>
        </form>
      </section>

      <section class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="text-lg font-bold text-slate-900">Seguridad</h2>
        <p class="mt-2 text-sm text-slate-500">MFA protege tu cuenta con un segundo código de acceso.</p>
        <UBadge v-if="user?.mfaVerified" class="mt-3" color="success" variant="subtle"
          >MFA activo en esta sesión</UBadge
        >
        <UButton v-else-if="!mfaEnrollment" class="mt-4" variant="soft" @click="beginMfa">Activar MFA</UButton>
        <div v-else class="mt-4 space-y-3">
          <p class="text-sm">
            Clave manual: <code class="break-all">{{ mfaEnrollment.manualKey }}</code>
          </p>
          <p class="text-xs text-amber-700">
            Guarda estos códigos una sola vez: {{ mfaEnrollment.recoveryCodes.join(' · ') }}
          </p>
          <div class="flex gap-2">
            <UInput v-model="mfaCode" maxlength="6" inputmode="numeric" placeholder="Código de 6 cifras" />
            <UButton @click="verifyMfa">Confirmar</UButton>
          </div>
        </div>
        <h3 class="mt-6 font-semibold text-slate-800">Sesiones activas</h3>
        <div
          v-for="session in sessionData?.sessions"
          :key="session.id"
          class="mt-3 flex items-center justify-between gap-3 text-sm"
        >
          <span>{{ formatDate(session.lastSeenAt) }} <strong v-if="session.current">(actual)</strong></span>
          <UButton v-if="!session.current" size="xs" color="error" variant="ghost" @click="revokeSession(session.id)"
            >Revocar</UButton
          >
        </div>
        <form class="mt-6 space-y-3 border-t border-slate-100 pt-5" @submit.prevent="changePassword">
          <h3 class="font-semibold text-slate-800">Cambiar contraseña</h3>
          <UFormField label="Contraseña actual" required
            ><UInput
              v-model="passwordForm.currentPassword"
              class="w-full"
              type="password"
              autocomplete="current-password"
          /></UFormField>
          <UFormField label="Nueva contraseña" required hint="mínimo 12 caracteres, con letras y números"
            ><UInput v-model="passwordForm.newPassword" class="w-full" type="password" autocomplete="new-password"
          /></UFormField>
          <UFormField label="Repite la nueva contraseña" required
            ><UInput v-model="passwordForm.confirmation" class="w-full" type="password" autocomplete="new-password"
          /></UFormField>
          <UButton type="submit" variant="soft" :loading="busy">Cambiar contraseña</UButton>
        </form>
      </section>
    </div>

    <section class="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
      <h2 class="text-lg font-bold text-slate-900">Agenda de direcciones</h2>
      <div v-if="addressData?.addresses.length" class="mt-4 grid gap-3 md:grid-cols-2">
        <article
          v-for="address in addressData.addresses"
          :key="address.id"
          class="rounded-xl border border-slate-200 p-4 text-sm"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <strong>{{ address.label }}</strong> <UBadge v-if="address.isDefault" size="xs">Predeterminada</UBadge>
            </div>
            <UButton
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              aria-label="Eliminar dirección"
              @click="deleteAddress(address.id)"
            />
          </div>
          <p class="mt-2">{{ address.recipientName }} · {{ address.line1 }}</p>
          <p>{{ address.postalCode }} {{ address.city }}, {{ address.region }} ({{ address.countryCode }})</p>
        </article>
      </div>
      <form class="mt-6 grid gap-4 md:grid-cols-3" @submit.prevent="addAddress">
        <UFormField label="Etiqueta" required
          ><UInput v-model="addressForm.label" class="w-full" placeholder="Casa, oficina…"
        /></UFormField>
        <UFormField label="Uso" required>
          <USelect
            v-model="addressForm.kind"
            class="w-full"
            :items="[
              { label: 'Envío y facturación', value: 'both' },
              { label: 'Envío', value: 'shipping' },
              { label: 'Facturación', value: 'billing' }
            ]"
          />
        </UFormField>
        <UFormField label="Destinatario" required
          ><UInput v-model="addressForm.recipientName" class="w-full"
        /></UFormField>
        <UFormField label="Empresa"><UInput v-model="addressForm.companyName" class="w-full" /></UFormField>
        <UFormField label="NIF/CIF/VAT"><UInput v-model="addressForm.taxId" class="w-full" /></UFormField>
        <UFormField label="Teléfono"><UInput v-model="addressForm.phone" class="w-full" type="tel" /></UFormField>
        <UFormField class="md:col-span-2" label="Dirección" required
          ><UInput v-model="addressForm.line1" class="w-full"
        /></UFormField>
        <UFormField label="Complemento"><UInput v-model="addressForm.line2" class="w-full" /></UFormField>
        <UFormField label="Código postal" required
          ><UInput v-model="addressForm.postalCode" class="w-full"
        /></UFormField>
        <UFormField label="Ciudad" required><UInput v-model="addressForm.city" class="w-full" /></UFormField>
        <UFormField label="Provincia/región" required
          ><UInput v-model="addressForm.region" class="w-full"
        /></UFormField>
        <UFormField label="País ISO" required
          ><UInput v-model="addressForm.countryCode" class="w-full" maxlength="2"
        /></UFormField>
        <UFormField class="md:col-span-2" label="Instrucciones"
          ><UInput v-model="addressForm.instructions" class="w-full"
        /></UFormField>
        <div class="flex items-end"><UCheckbox v-model="addressForm.isDefault" label="Predeterminada" /></div>
        <UButton type="submit" class="md:col-span-3 md:w-fit" :loading="busy">Añadir dirección</UButton>
      </form>
    </section>

    <div class="mt-6 grid gap-6 lg:grid-cols-2">
      <section class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="text-lg font-bold text-slate-900">Comunicaciones</h2>
        <p class="mt-1 text-sm text-slate-500">
          Los mensajes operativos de pedidos y seguridad siempre permanecen activos.
        </p>
        <div class="mt-4 space-y-3">
          <UCheckbox v-model="communication.newsletter" label="Newsletter por email" />
          <UCheckbox v-model="communication.product_updates" label="Novedades de producto por email" />
          <UCheckbox v-model="communication.replenishment" label="Recordatorios de reposición por email" />
        </div>
        <UButton class="mt-4" variant="soft" @click="savePreferences">Guardar preferencias</UButton>
      </section>

      <section class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="text-lg font-bold text-slate-900">Privacidad</h2>
        <p class="mt-1 text-sm text-slate-500">
          Exporta tus datos o solicita anonimización con seguimiento y plazo registrado.
        </p>
        <div class="mt-4 flex flex-wrap gap-2">
          <UButton variant="soft" icon="i-lucide-download" @click="requestPrivacy('export')"
            >Exportar mis datos</UButton
          >
          <UButton color="error" variant="soft" @click="requestPrivacy('anonymize')">Solicitar anonimización</UButton>
        </div>
        <p v-for="request in privacyData?.requests" :key="request.id" class="mt-3 text-xs text-slate-500">
          {{ request.requestType }} · {{ request.status }} · solicitada {{ formatDate(request.requestedAt) }}
        </p>
      </section>
    </div>

    <section
      v-if="favoriteData?.lists.some((list) => list.items.length)"
      class="mt-6 rounded-2xl border border-slate-200 bg-white p-6"
    >
      <h2 class="text-lg font-bold text-slate-900">Favoritos</h2>
      <div v-for="list in favoriteData.lists" :key="list.id" class="mt-3 space-y-2">
        <div
          v-for="item in list.items"
          :key="item.variantId"
          class="flex items-center justify-between gap-3 rounded-lg bg-slate-50 p-3"
        >
          <NuxtLink :to="`/producto/${item.slug}?sku=${encodeURIComponent(item.sku)}`" class="font-medium">
            {{ item.name }} · {{ item.sku }}
          </NuxtLink>
          <UButton size="xs" color="error" variant="ghost" @click="removeFavorite(item.variantId)">Quitar</UButton>
        </div>
      </div>
    </section>

    <section class="mt-6">
      <h2 class="text-lg font-bold text-slate-900">Mis pedidos</h2>
      <div v-if="orderData?.orders.length" class="mt-4 space-y-3">
        <NuxtLink
          v-for="order in orderData.orders"
          :key="order.id"
          :to="`/pedido/${order.id}`"
          class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-neteco-300 hover:shadow-md"
        >
          <div>
            <p class="font-semibold text-slate-800">{{ order.id }}</p>
            <p class="text-xs text-slate-400">{{ formatDate(order.createdAt) }} · {{ order.lines }} artículos</p>
          </div>
          <div class="flex items-center gap-4">
            <UBadge :color="(ORDER_STATUS[order.status] ?? ORDER_STATUS.pendiente_pago!).color" variant="subtle">{{
              (ORDER_STATUS[order.status] ?? ORDER_STATUS.pendiente_pago!).label
            }}</UBadge>
            <p class="font-bold text-slate-900">{{ formatPrice(order.total) }}</p>
          </div>
        </NuxtLink>
      </div>
      <div v-else class="mt-4 rounded-2xl border border-dashed border-slate-300 py-10 text-center">
        <p class="font-medium text-slate-600">Todavía no tienes pedidos</p>
        <UButton to="/catalogo" class="mt-4">Empezar a comprar</UButton>
      </div>
    </section>
  </div>
</template>
