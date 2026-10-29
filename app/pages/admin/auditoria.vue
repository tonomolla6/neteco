<script setup lang="ts">
import { useAdminNavigation } from '../../composables/useAdminNavigation'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Auditoría · Admin', robots: 'noindex, nofollow' })
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
    ? JSON.stringify([user.value?.id, session.value?.sessionId, session.value?.sessionVersion, '/admin/auditoria'])
    : ''
)
</script>
<template>
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-semibold">Auditoría administrativa</h1>
      <p class="mt-2 text-muted">Revisa acciones sensibles y exporta únicamente su proyección segura y trazable.</p>
    </header>
    <p v-if="runtime.public.serverRuntime !== 'cloudflare'" role="status">
      La auditoría está disponible en Cloudflare. No se consultan registros del entorno Node.
    </p>
    <AdminAuditPanel :enabled="enabled" :scope-key="scopeKey" :pending="false" @pending="pending = $event" />
    <p v-if="pending" role="status" aria-live="polite">
      Hay una operación sin confirmar. Consulta su recibo antes de crear otra revisión o exportación.
    </p>
  </div>
</template>
