<script setup lang="ts">
import { useAdminNavigation } from '../../composables/useAdminNavigation'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Plataforma · Admin', robots: 'noindex, nofollow' })
const runtime = useRuntimeConfig()
const navigation = useAdminNavigation()
const { ready, loggedIn, user, session } = useUserSession()
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
  JSON.stringify([user.value?.id, session.value?.sessionId, session.value?.sessionVersion])
)
</script>

<template>
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-semibold">Portal de plataforma</h1>
      <p class="mt-2">Referencias de servicios, operaciones y plantillas para el equipo.</p>
    </header>
    <AdminDeveloperPortal />
    <template v-if="enabled">
      <AdminDeveloperOwnership :key="`ownership-${scopeKey}`" />
      <AdminDeveloperMetrics :key="`metrics-${scopeKey}`" />
      <AdminB2bPublicKeys :key="`keys-${scopeKey}`" />
    </template>
    <p v-else role="status">Las operaciones de plataforma requieren una sesión administrativa verificada con MFA.</p>
  </div>
</template>
