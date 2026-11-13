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
  <AdminPage>
    <div class="adm-stack">
      <UAlert
        v-if="runtime.public.serverRuntime !== 'cloudflare'"
        role="status"
        color="warning"
        variant="subtle"
        icon="i-lucide-info"
        title="Las invitaciones no están disponibles en esta instalación"
      />
      <UAlert
        v-if="pending"
        role="status"
        aria-live="polite"
        color="warning"
        variant="subtle"
        icon="i-lucide-hourglass"
        title="Hay una invitación a medio confirmar"
        description="Termina de confirmarla o cancélala antes de crear otra."
      />
      <AdminInvitationsPanel :enabled="enabled" :scope-key="scopeKey" :pending="false" @pending="pending = $event" />
    </div>
  </AdminPage>
</template>
