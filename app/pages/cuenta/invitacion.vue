<script setup lang="ts">
import AdminInvitationAcceptance from '../../components/AdminInvitationAcceptance.vue'

// Public entry only: the generic account auth redirect serializes fullPath,
// including fragments. The component gates every private request itself.
definePageMeta({ layout: 'cuenta' })
useSeoMeta({ title: 'Aceptar invitación administrativa', robots: 'noindex, nofollow, noarchive' })
useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
const runtime = useRuntimeConfig().public.serverRuntime
</script>

<template>
  <div class="account-card account-own-title">
    <AdminInvitationAcceptance :runtime="runtime" />
  </div>
</template>
