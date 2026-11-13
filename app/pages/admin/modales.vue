<script setup lang="ts">
import AdminMarketingModals from '../../components/AdminMarketingModals.vue'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Ventanas emergentes · Admin', robots: 'noindex, nofollow, noarchive' })

const { ready, loggedIn, user } = useUserSession()
const runtime = useRuntimeConfig().public.serverRuntime
const navigation = useAdminNavigation()

const actor = computed(() => (typeof user.value?.id === 'string' ? user.value.id : ''))
// Visual gate only: every marketing modal endpoint re-checks session, MFA and permission on the server.
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
  <AdminPage>
    <AdminMarketingModals v-if="authorize" />
    <AdminEmptyState
      v-else
      icon="i-lucide-lock"
      title="No puedes gestionar las ventanas emergentes"
      description="Requiere sesión verificada con MFA y permiso de administración de marketing. Los permisos se verifican de nuevo en el servidor."
    />
  </AdminPage>
</template>
