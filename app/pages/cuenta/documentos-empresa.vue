<script setup lang="ts">
import { z } from 'zod'
import CompanyDocumentsPanel from '../../components/CompanyDocumentsPanel.vue'

definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Documentos de empresa', robots: 'noindex, nofollow' })

const { ready, loggedIn, user } = useUserSession()
const enabled = computed(
  () =>
    useRuntimeConfig().public.serverRuntime === 'cloudflare' &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    z.string().uuid().safeParse(user.value?.id).success
)
</script>

<template>
  <div class="space-y-6">
    <UiPageHeader
      title="Documentos de empresa"
      description="Adjunta, si quieres, documentación para tu cuenta profesional."
    />
    <UiSurface>
      <CompanyDocumentsPanel :enabled="enabled" />
    </UiSurface>
  </div>
</template>
