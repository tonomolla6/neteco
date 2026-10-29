<script setup lang="ts">
import AdminMarketingAutomations from '../../components/AdminMarketingAutomations.vue'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Automatizaciones de marketing · Admin', robots: 'noindex, nofollow, noarchive' })

const { ready, loggedIn, user } = useUserSession()
const runtime = useRuntimeConfig().public.serverRuntime
const navigation = useAdminNavigation()

const actor = computed(() => (typeof user.value?.id === 'string' ? user.value.id : ''))
// Visual gate only: every marketing automation endpoint re-checks session, MFA and permission on the server.
const authorize = computed(
  () =>
    runtime === 'cloudflare' &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.mfaVerified === true &&
    navigation.capabilities.value?.state === 'ready' &&
    (navigation.capabilities.value?.permissions ?? []).includes('administration.manage') &&
    catalogPolicyUuidSchema.safeParse(actor.value).success
)
</script>

<template>
  <div class="space-y-6">
    <AdminMarketingAutomations v-if="authorize" />
    <p v-else role="status" class="rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
      Requiere sesión verificada con MFA y permiso de administración. Los permisos se verifican de nuevo en el servidor.
    </p>
  </div>
</template>
