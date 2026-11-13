<script setup lang="ts">
import { useAdminNavigation } from '../../composables/useAdminNavigation'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Estado del sistema · Admin', robots: 'noindex, nofollow' })
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
  <AdminPage>
    <div class="adm-stack">
      <AdminDeveloperPortal />
      <template v-if="enabled">
        <AdminDeveloperOwnership :key="`ownership-${scopeKey}`" />
        <AdminDeveloperMetrics :key="`metrics-${scopeKey}`" />
        <AdminB2bPublicKeys :key="`keys-${scopeKey}`" />
      </template>
      <UAlert
        v-else
        role="status"
        color="warning"
        variant="subtle"
        icon="i-lucide-lock"
        title="Necesitas una sesión de administrador verificada"
        description="Para gestionar responsables, métricas y claves, inicia sesión con verificación en dos pasos."
      />
    </div>
  </AdminPage>
</template>
