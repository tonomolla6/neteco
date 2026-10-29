<script setup lang="ts">
import AdminProductContributionsPanel from '~/components/AdminProductContributionsPanel.vue'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Aportaciones de productos · Admin', robots: 'noindex, nofollow' })
const runtime = useRuntimeConfig(),
  navigation = useAdminNavigation()
const { ready, loggedIn, user, session } = useUserSession()
const pending = ref(false)
const enabled = computed(() => {
  const caps = navigation.capabilities.value
  return (
    runtime.public.serverRuntime === 'cloudflare' &&
    ready.value &&
    loggedIn.value &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true &&
    navigation.status.value === 'ready' &&
    caps?.state === 'ready' &&
    caps.identityId === user.value.id &&
    caps.sessionId === session.value?.sessionId &&
    caps.sessionVersion === session.value?.sessionVersion &&
    caps.permissions.includes('support.manage')
  )
})
const scope = computed(() =>
  JSON.stringify([enabled.value, user.value?.id, session.value?.sessionId, session.value?.sessionVersion])
)
</script>
<template>
  <main class="space-y-5">
    <h1 class="text-2xl font-semibold">Aportaciones de productos</h1>
    <p>Modera reseñas y responde preguntas con contexto y revisión auditada. No se envían comunicaciones externas.</p>
    <AdminProductContributionsPanel
      :enabled="enabled"
      :scope-key="scope"
      :pending="false"
      @pending="pending = $event"
    />
    <p v-if="pending" role="status">
      Hay una intención pendiente de confirmar. Comprueba su recibo antes de continuar.
    </p>
  </main>
</template>
