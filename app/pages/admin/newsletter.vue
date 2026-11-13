<script setup lang="ts">
import NewsletterCampaignEditor from '../../components/NewsletterCampaignEditor.vue'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Boletín · Admin', robots: 'noindex, nofollow, noarchive' })
const { ready, loggedIn, user } = useUserSession(),
  runtime = useRuntimeConfig().public.serverRuntime
const actor = computed(() => (typeof user.value?.id === 'string' ? user.value.id : ''))
const authorize = () =>
  runtime === 'cloudflare' &&
  ready.value === true &&
  loggedIn.value === true &&
  user.value?.mfaVerified === true &&
  catalogPolicyUuidSchema.safeParse(actor.value).success
</script>
<template>
  <AdminPage>
    <AdminServiceGate v-if="authorize()" service="newsletterEditorial">
      <NewsletterCampaignEditor :actor-id="actor" :authorize="authorize" />
    </AdminServiceGate>
    <AdminEmptyState
      v-else
      icon="i-lucide-lock"
      title="No puedes gestionar el boletín desde esta sesión"
      description="Hace falta iniciar sesión con verificación en dos pasos. Los permisos se comprueban de nuevo en el servidor."
    />
  </AdminPage>
</template>
