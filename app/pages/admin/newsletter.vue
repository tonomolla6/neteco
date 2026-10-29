<script setup lang="ts">
import NewsletterCampaignEditor from '../../components/NewsletterCampaignEditor.vue'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Newsletter editorial · Admin', robots: 'noindex, nofollow, noarchive' })
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
  <div class="space-y-6">
    <h1 class="text-2xl font-bold">Newsletter editorial</h1>
    <NewsletterCampaignEditor v-if="authorize()" :actor-id="actor" :authorize="authorize" />
    <p v-else>Requiere servicio D1, una sesión confirmada y MFA. Los permisos se verifican de nuevo en el servidor.</p>
  </div>
</template>
