<script setup lang="ts">
import { z } from 'zod'
import PreferenceCenterPanel from '../../components/PreferenceCenterPanel.vue'
import ReplenishmentRemindersPanel from '../../components/ReplenishmentRemindersPanel.vue'

definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Centro de preferencias', robots: 'noindex, nofollow' })

const { ready, loggedIn, user, session } = useUserSession()
const cloudflare = useRuntimeConfig().public.serverRuntime === 'cloudflare'
const enabled = computed(
  () =>
    cloudflare &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    z.string().uuid().safeParse(user.value?.id).success &&
    z.string().uuid().safeParse(session.value?.sessionId).success
)
const scope = computed(() => `${user.value?.id}:${session.value?.sessionId}:${session.value?.sessionVersion}`)
</script>

<template>
  <div class="space-y-6">
    <UiPageHeader
      title="Centro de preferencias"
      description="Frecuencia, temas, sectores y canales, y tus recordatorios de reposición."
    />
    <p v-if="!cloudflare" role="alert">Este servicio no ofrece el centro de preferencias.</p>
    <template v-else>
      <UiSurface><PreferenceCenterPanel :key="`center:${scope}`" :enabled="enabled" /></UiSurface>
      <UiSurface><ReplenishmentRemindersPanel :key="`replenishment:${scope}`" :enabled="enabled" /></UiSurface>
    </template>
  </div>
</template>
