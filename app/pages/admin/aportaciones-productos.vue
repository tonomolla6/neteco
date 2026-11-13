<script setup lang="ts">
import AdminProductContributionsPanel from '~/components/AdminProductContributionsPanel.vue'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Reseñas y preguntas · Admin', robots: 'noindex, nofollow' })
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
  <AdminPage>
    <div class="adm-stack">
      <UAlert
        v-if="pending"
        role="status"
        color="warning"
        variant="subtle"
        icon="i-lucide-hourglass"
        title="Hay un cambio pendiente de confirmar"
        description="Comprueba que se ha guardado antes de continuar con otra aportación."
      />
      <AdminCard v-if="runtime.public.serverRuntime !== 'cloudflare'">
        <AdminEmptyState
          icon="i-lucide-message-square-text"
          title="Las reseñas y preguntas no se gestionan desde esta instalación"
          description="Solo están disponibles en la tienda publicada."
        />
      </AdminCard>
      <AdminCard v-else-if="ready && loggedIn && user?.mfaVerified !== true">
        <AdminEmptyState
          icon="i-lucide-shield-check"
          title="Hace falta la verificación en dos pasos"
          description="Por seguridad, las reseñas y preguntas de clientes solo se pueden consultar con la verificación en dos pasos activada en tu cuenta. En la demostración pública no está disponible."
        />
      </AdminCard>
      <AdminProductContributionsPanel
        v-else
        :enabled="enabled"
        :scope-key="scope"
        :pending="false"
        @pending="pending = $event"
      />
    </div>
  </AdminPage>
</template>
