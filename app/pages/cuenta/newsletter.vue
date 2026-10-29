<script setup lang="ts">
import NewsletterPreferencesPanel from '../../components/NewsletterPreferencesPanel.vue'
import { z } from 'zod'
definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Temas y frecuencia newsletter', robots: 'noindex, nofollow, noarchive' })
const { ready, loggedIn, user, session } = useUserSession(),
  runtime = useRuntimeConfig().public.serverRuntime
const actor = computed(() => (typeof user.value?.id === 'string' ? user.value.id : ''))
const authorize = () =>
  runtime === 'cloudflare' &&
  ready.value === true &&
  loggedIn.value === true &&
  user.value?.emailVerified === true &&
  z.string().uuid().safeParse(actor.value).success &&
  z.string().email().safeParse(user.value?.email).success &&
  z.string().uuid().safeParse(session.value?.sessionId).success &&
  Number.isSafeInteger(session.value?.sessionVersion) &&
  Number(session.value?.sessionVersion) > 0
const privateScope = computed(() =>
  JSON.stringify([
    ready.value,
    loggedIn.value,
    actor.value,
    user.value?.email,
    user.value?.emailVerified,
    user.value?.mfaVerified,
    session.value?.sessionId,
    session.value?.sessionVersion
  ])
)
</script>
<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-bold">Temas y frecuencia</h1>
    <NewsletterPreferencesPanel
      v-if="authorize()"
      :key="privateScope"
      endpoint="/api/account/newsletter/preferences"
      :actor-id="actor"
      :authorize="authorize"
    />
    <p v-else>Esta gestión requiere una sesión confirmada y el servicio D1 habilitado.</p>
  </div>
</template>
