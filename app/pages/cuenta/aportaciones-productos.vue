<script setup lang="ts">
import ProductContributionsPanel from '~/components/ProductContributionsPanel.vue'
definePageMeta({ layout: 'cuenta', middleware: 'auth' })
useSeoMeta({ title: 'Mis reseñas y preguntas', robots: 'noindex, nofollow' })
const runtime = useRuntimeConfig()
const { ready, loggedIn, user, session } = useUserSession()
const enabled = computed(
  () =>
    runtime.public.serverRuntime === 'cloudflare' &&
    ready.value &&
    loggedIn.value &&
    user.value?.emailVerified === true &&
    typeof session.value?.sessionId === 'string' &&
    Number(session.value?.sessionVersion) > 0
)
const scope = computed(() =>
  JSON.stringify([enabled.value, user.value?.id, session.value?.sessionId, session.value?.sessionVersion])
)
</script>
<template>
  <div class="space-y-6">
    <UiPageHeader
      title="Reseñas y preguntas"
      description="Lo que has opinado o preguntado sobre los productos. Las reseñas se escriben desde la ficha de cada producto; aquí ves su revisión y puedes responder."
    />
    <div class="account-card account-embedded">
      <ProductContributionsPanel :enabled="enabled" :customer-enabled="enabled" :scope-key="scope" />
    </div>
  </div>
</template>
