<script setup lang="ts">
import { useAdminNavigation } from '../../composables/useAdminNavigation'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Equipo · Admin' })
const runtime = useRuntimeConfig()
const navigation = useAdminNavigation()
const { ready, loggedIn, user, session } = useUserSession()
const pending = ref(false)
const enabled = computed(() => {
  const capability = navigation.capabilities.value
  return (
    runtime.public.serverRuntime === 'cloudflare' &&
    ready.value &&
    loggedIn.value &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true &&
    navigation.status.value === 'ready' &&
    capability?.state === 'ready' &&
    capability.identityId === user.value.id &&
    capability.sessionId === session.value?.sessionId &&
    capability.sessionVersion === session.value?.sessionVersion &&
    capability.permissions.includes('administration.manage')
  )
})
const scopeKey = computed(() =>
  enabled.value
    ? JSON.stringify([user.value?.id, session.value?.sessionId, session.value?.sessionVersion, '/admin/equipo'])
    : ''
)
</script>
<template>
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-semibold">Equipo y accesos</h1>
      <p class="mt-2 text-muted">
        Invita a cuentas verificadas con MFA y asigna únicamente permisos que ya puedes delegar.
      </p>
    </header>
    <p v-if="runtime.public.serverRuntime !== 'cloudflare'" role="status">
      Las invitaciones están disponibles en el entorno Cloudflare, sin modificar los permisos del entorno Node.
    </p>
    <AdminInvitationsPanel :enabled="enabled" :scope-key="scopeKey" :pending="false" @pending="pending = $event" />
    <p v-if="pending" role="status" aria-live="polite">
      Hay una operación pendiente de confirmar. No crees otra invitación hasta consultar su recibo.
    </p>
  </div>
</template>
