<script setup lang="ts">
import type { Preference, PrivacyRequest } from '~/composables/useAccount'
import { z } from 'zod'
import AccountPrivacyPanel from '../../components/AccountPrivacyPanel.vue'
import AccountPreferencesPanel from '../../components/AccountPreferencesPanel.vue'
import DeliveryPreferencesPanel from '../../components/DeliveryPreferencesPanel.vue'

definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Avisos y privacidad', robots: 'noindex, nofollow' })

const runtime = useRuntimeConfig().public.serverRuntime
const cloudflare = runtime === 'cloudflare',
  node = runtime === 'node'
const { ready, loggedIn, user, session } = useUserSession()
const settingsEnabled = computed(
  () =>
    cloudflare &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    z.string().uuid().safeParse(user.value?.id).success &&
    z.string().email().safeParse(user.value?.email).success &&
    z.string().uuid().safeParse(session.value?.sessionId).success &&
    Number.isSafeInteger(session.value?.sessionVersion) &&
    Number(session.value?.sessionVersion) > 0
)
const settingsScope = computed(() =>
  JSON.stringify([
    loggedIn.value,
    user.value?.id,
    user.value?.email,
    user.value?.emailVerified,
    session.value?.sessionId,
    session.value?.sessionVersion
  ])
)
const privacyPending = ref(false),
  preferencesPending = ref(false),
  deliveryPending = ref(false),
  settingsEpoch = ref(0)
let settingsAlive = true
watch(
  [settingsScope, settingsEnabled],
  () => {
    settingsEpoch.value++
    privacyPending.value = false
    preferencesPending.value = false
    deliveryPending.value = false
  },
  { flush: 'sync' }
)
const pendingHandlers = computed(() => {
  const scope = settingsScope.value,
    epoch = settingsEpoch.value
  const current = () =>
    settingsAlive && settingsEnabled.value && scope === settingsScope.value && epoch === settingsEpoch.value
  return {
    privacy: (value: boolean) => {
      if (current()) privacyPending.value = value === true
    },
    preferences: (value: boolean) => {
      if (current()) preferencesPending.value = value === true
    },
    delivery: (value: boolean) => {
      if (current()) deliveryPending.value = value === true
    }
  }
})
const settingsBusy = computed(
  () => settingsEnabled.value && (privacyPending.value || preferencesPending.value || deliveryPending.value)
)
function confirmSettingsNavigation() {
  return (
    !settingsBusy.value ||
    window.confirm(
      'Hay un resultado pendiente de verificar. Salir elimina la intención local, pero no deshace una solicitud o preferencia ya registrada. ¿Quieres salir?'
    )
  )
}
onBeforeRouteLeave(confirmSettingsNavigation)
function beforeSettingsUnload(event: BeforeUnloadEvent) {
  if (!settingsBusy.value) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', beforeSettingsUnload))
onBeforeUnmount(() => {
  settingsAlive = false
  settingsEpoch.value++
  privacyPending.value = false
  preferencesPending.value = false
  deliveryPending.value = false
  window.removeEventListener('beforeunload', beforeSettingsUnload)
})
const { data: preferenceData, refresh: refreshPreferences } = node
  ? await useFetch<{ preferences: Preference[] }>('/api/account/preferences')
  : { data: ref<{ preferences: Preference[] } | null>(null), refresh: async () => undefined }
const { data: privacyData, refresh: refreshPrivacy } = node
  ? await useFetch<{ requests: PrivacyRequest[] }>('/api/account/privacy')
  : { data: ref<{ requests: PrivacyRequest[] } | null>(null), refresh: async () => undefined }
const { notice, errorMessage, busy, run, showNotice } = useAccountFeedback()

const communication = reactive({
  newsletter: preferenceData.value?.preferences.some((p) => p.purpose === 'newsletter' && p.enabled) ?? false,
  product_updates: preferenceData.value?.preferences.some((p) => p.purpose === 'product_updates' && p.enabled) ?? false,
  replenishment: preferenceData.value?.preferences.some((p) => p.purpose === 'replenishment' && p.enabled) ?? false
})

const CHANNELS = [
  {
    key: 'replenishment' as const,
    label: 'Recordatorios de reposición',
    hint: 'Te avisamos cuando toca reponer lo que sueles pedir, según tu histórico.'
  },
  {
    key: 'product_updates' as const,
    label: 'Novedades de producto',
    hint: 'Nuevas referencias y cambios de formato en las familias que compras.'
  },
  {
    key: 'newsletter' as const,
    label: 'Newsletter comercial',
    hint: 'Ofertas y contenidos de NETECO. Puedes darte de baja cuando quieras.'
  }
]

async function savePreferences() {
  if (!node) return
  await run(async () => {
    const preferences = (Object.keys(communication) as Array<keyof typeof communication>).map((purpose) => ({
      purpose,
      channel: 'email' as const,
      enabled: communication[purpose],
      frequency: 'immediate' as const,
      topics: []
    }))
    await $fetch('/api/account/preferences', { method: 'PUT', body: { preferences } })
    await refreshPreferences()
    showNotice(
      communication.newsletter
        ? 'Preferencias guardadas. Si acabas de activar la newsletter, confirma desde el email que te hemos enviado.'
        : 'Preferencias guardadas.'
    )
  }, 'No se han podido guardar las preferencias.')
}

const confirmingAnonymize = ref(false)

async function requestExport() {
  if (!node) return
  await run(async () => {
    const request = await $fetch<PrivacyRequest>('/api/account/privacy', {
      method: 'POST',
      body: { requestType: 'export', idempotencyKey: randomId() }
    })
    await refreshPrivacy()
    window.location.assign(`/api/account/privacy/${request.id}/download`)
  }, 'No se ha podido preparar la exportación.')
}

async function requestAnonymize() {
  if (!node) return
  await run(async () => {
    await $fetch('/api/account/privacy', {
      method: 'POST',
      body: { requestType: 'anonymize', idempotencyKey: randomId() }
    })
    await refreshPrivacy()
    confirmingAnonymize.value = false
    showNotice('Solicitud registrada. Verás su estado y su plazo en esta misma página.')
  }, 'No se ha podido registrar la solicitud.')
}
</script>

<template>
  <div class="space-y-6">
    <UiPageHeader
      title="Avisos y privacidad"
      description="Qué te enviamos por email y qué puedes hacer con tus datos."
    />

    <template v-if="cloudflare">
      <UiSurface>
        <h2 class="text-lg font-bold">Tus comunicaciones y solicitudes de privacidad</h2>
        <p class="mt-3">
          Guardar preferencias no envía mensajes ni activa campañas de marketing. El envío externo por ESP o SMS no está
          habilitado aquí.
        </p>
        <p class="mt-3">La anonimización registra una solicitud: no confirma que tus datos se hayan anonimizado.</p>
        <NuxtLink to="/cuenta/newsletter" class="mt-4 inline-block underline"
          >Gestionar temas y frecuencia newsletter</NuxtLink
        >
        <NuxtLink to="/cuenta/centro-preferencias" class="mt-4 block underline"
          >Centro de preferencias y recordatorios de reposición</NuxtLink
        >
        <p class="mt-3 text-sm">Guardar preferencias newsletter no crea consentimiento ni sustituye el doble opt-in.</p>
      </UiSurface>
      <template v-if="settingsEnabled">
        <AccountPreferencesPanel
          :key="`preferences:${settingsScope}:${settingsEpoch}`"
          runtime="cloudflare"
          :scope-key="settingsScope"
          :enabled="settingsEnabled"
          :pending="privacyPending || deliveryPending"
          @pending="pendingHandlers.preferences"
        />
        <AccountPrivacyPanel
          :key="`privacy:${settingsScope}:${settingsEpoch}`"
          :scope-key="settingsScope"
          :enabled="settingsEnabled"
          :pending="preferencesPending || deliveryPending"
          @pending="pendingHandlers.privacy"
        />
        <DeliveryPreferencesPanel
          :key="`delivery:${settingsScope}:${settingsEpoch}`"
          :scope-key="settingsScope"
          :enabled="settingsEnabled"
          :pending="privacyPending || preferencesPending"
          @pending="pendingHandlers.delivery"
        />
      </template>
      <p v-else role="status">Verifica tu sesión y tu correo para gestionar tus preferencias y solicitudes privadas.</p>
    </template>
    <template v-else-if="node">
      <AccountFeedback :notice="notice" :error="errorMessage" />

      <UiSurface>
        <h2 class="text-lg font-bold text-[var(--text-strong)]">Avisos por email</h2>
        <p class="mt-1 text-sm text-[var(--text-muted)]">
          Los mensajes sobre tus pedidos y la seguridad de la cuenta se envían siempre y no se pueden desactivar.
        </p>
        <div class="mt-5 divide-y divide-[var(--border)]">
          <div v-for="channel in CHANNELS" :key="channel.key" class="flex items-start justify-between gap-6 py-4">
            <div class="min-w-0">
              <p class="font-medium text-[var(--text-strong)]">{{ channel.label }}</p>
              <p class="mt-0.5 text-sm text-[var(--text-muted)]">{{ channel.hint }}</p>
            </div>
            <USwitch v-model="communication[channel.key]" :aria-label="channel.label" class="mt-0.5 shrink-0" />
          </div>
        </div>
        <UButton class="mt-5" :loading="busy" @click="savePreferences">Guardar preferencias</UButton>
      </UiSurface>

      <UiSurface>
        <h2 class="text-lg font-bold text-[var(--text-strong)]">Tus datos</h2>
        <p class="mt-1 text-sm text-[var(--text-muted)]">
          Puedes descargar todo lo que guardamos sobre ti, o pedir que lo anonimicemos.
        </p>

        <div class="mt-5 grid gap-4 grid-cols-1 sm:grid-cols-2">
          <div class="rounded-[var(--radius-surface)] border border-[var(--border)] p-4">
            <p class="font-medium text-[var(--text-strong)]">Descargar mis datos</p>
            <p class="mt-1 text-sm text-[var(--text-muted)]">
              Un archivo con tu perfil, direcciones, pedidos y preferencias.
            </p>
            <UButton
              class="mt-3"
              size="sm"
              color="neutral"
              variant="outline"
              icon="i-lucide-download"
              :loading="busy"
              @click="requestExport"
            >
              Descargar
            </UButton>
          </div>
          <div class="rounded-[var(--radius-surface)] border border-[var(--border)] p-4">
            <p class="font-medium text-[var(--text-strong)]">Anonimizar mi cuenta</p>
            <p class="mt-1 text-sm text-[var(--text-muted)]">
              Borramos tus datos personales. Las facturas se conservan por obligación fiscal.
            </p>
            <UButton class="mt-3" size="sm" color="error" variant="outline" @click="confirmingAnonymize = true">
              Solicitar anonimización
            </UButton>
          </div>
        </div>

        <div v-if="privacyData?.requests.length" class="mt-6 border-t border-[var(--border)] pt-5">
          <h3 class="font-semibold text-[var(--text-strong)]">Solicitudes en curso</h3>
          <ul class="mt-3 divide-y divide-[var(--border)]">
            <li
              v-for="request in privacyData.requests"
              :key="request.id"
              class="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
            >
              <div>
                <p class="font-medium text-[var(--text-strong)]">
                  {{ PRIVACY_REQUEST_TYPE[request.requestType] ?? request.requestType }}
                </p>
                <p class="mt-0.5 text-[var(--text-muted)]">
                  Solicitada el {{ formatAccountDate(request.requestedAt) }} · respuesta antes del
                  {{ formatAccountDate(request.dueAt) }}
                </p>
              </div>
              <UBadge variant="subtle" :color="(PRIVACY_REQUEST_STATUS[request.status] ?? { color: 'neutral' }).color">
                {{ (PRIVACY_REQUEST_STATUS[request.status] ?? { label: request.status }).label }}
              </UBadge>
            </li>
          </ul>
        </div>
      </UiSurface>

      <UModal v-model:open="confirmingAnonymize" title="Solicitar la anonimización">
        <template #body>
          <p class="text-[var(--text)]">
            Eliminaremos tus datos personales de la tienda. Tus facturas se conservan el tiempo que exige la normativa
            fiscal, y perderás el acceso al histórico de pedidos y a las condiciones de tu cuenta profesional.
          </p>
          <p class="mt-3 text-[var(--text)]">Te confirmaremos por email cuando esté hecho.</p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="confirmingAnonymize = false">Cancelar</UButton>
            <UButton color="error" :loading="busy" @click="requestAnonymize">Solicitar anonimización</UButton>
          </div>
        </template>
      </UModal>
    </template>
    <p v-else role="alert">Este servicio no permite gestionar las comunicaciones o solicitudes de privacidad.</p>
  </div>
</template>
