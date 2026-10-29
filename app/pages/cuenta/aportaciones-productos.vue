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
  <main class="space-y-5">
    <h1 class="text-2xl font-semibold">Mis reseñas y preguntas</h1>
    <p>Puedes proponer contenido desde la ficha del producto y consultar aquí su revisión o aportar una réplica.</p>
    <ProductContributionsPanel :enabled="enabled" :customer-enabled="enabled" :scope-key="scope" />
  </main>
</template>
