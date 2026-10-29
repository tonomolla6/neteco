<script setup lang="ts">
import AdminInvitationAcceptance from '../../components/AdminInvitationAcceptance.vue'

// Public entry only: the generic account auth redirect serializes fullPath,
// including fragments. The component gates every private request itself.
definePageMeta({ layout: 'default' })
useSeoMeta({ title: 'Aceptar invitación administrativa', robots: 'noindex, nofollow, noarchive' })
useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
const runtime = useRuntimeConfig().public.serverRuntime
</script>

<template>
  <AdminInvitationAcceptance :runtime="runtime" />
</template>
