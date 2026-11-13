<script setup lang="ts">
import { z } from 'zod'
import AdminB2BPricing from '~/components/AdminB2BPricing.vue'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Tarifas y crédito de empresas · Admin', robots: 'noindex, nofollow' })
const runtime = useRuntimeConfig(),
  navigation = useAdminNavigation()
const { ready, loggedIn, user, session } = useUserSession()
const enabled = computed(() => {
  const caps = navigation.capabilities.value
  return (
    runtime.public.serverRuntime === 'cloudflare' &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true &&
    z.string().uuid().safeParse(user.value?.id).success &&
    z.string().uuid().safeParse(session.value?.sessionId).success &&
    Number.isSafeInteger(session.value?.sessionVersion) &&
    Number(session.value?.sessionVersion) > 0 &&
    navigation.status.value === 'ready' &&
    caps?.state === 'ready' &&
    caps.identityId === user.value?.id &&
    caps.sessionId === session.value?.sessionId &&
    caps.sessionVersion === session.value?.sessionVersion &&
    caps.permissions.includes('administration.manage')
  )
})
const scope = computed(() =>
  JSON.stringify([
    enabled.value,
    user.value?.id,
    session.value?.sessionId,
    session.value?.sessionVersion,
    navigation.capabilities.value
  ])
)
</script>
<template>
  <AdminPage>
    <AdminB2BPricing :enabled="enabled" :scope-key="scope" />
  </AdminPage>
</template>
