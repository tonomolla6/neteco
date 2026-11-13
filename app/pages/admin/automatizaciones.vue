<script setup lang="ts">
import { ref } from 'vue'
import AdminMarketingAutomations from '../../components/AdminMarketingAutomations.vue'
import AdminCrmMetricsPanel from '../../components/AdminCrmMetricsPanel.vue'
import AdminMarketingObservabilityPanel from '../../components/AdminMarketingObservabilityPanel.vue'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Automatizaciones de marketing · Admin', robots: 'noindex, nofollow, noarchive' })

const activeTab = ref('policies')
const tabs = [
  { value: 'policies', label: 'Reglas y pruebas' },
  { value: 'metrics', label: 'Resultados' },
  { value: 'observability', label: 'Seguimiento de envíos' }
]
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
  <AdminPage>
    <div v-if="authorize" class="adm-stack">
      <AdminTabs v-model="activeTab" :tabs="tabs" label="Apartados de automatizaciones" />
      <AdminMarketingAutomations v-if="activeTab === 'policies'" />
      <AdminCrmMetricsPanel v-else-if="activeTab === 'metrics'" />
      <AdminMarketingObservabilityPanel v-else-if="activeTab === 'observability'" />
    </div>
    <AdminEmptyState
      v-else
      role="status"
      icon="i-lucide-lock"
      title="No puedes gestionar las automatizaciones desde esta sesión"
      description="Hace falta iniciar sesión con verificación en dos pasos y tener permiso de administración. Los permisos se comprueban de nuevo en el servidor."
    />
  </AdminPage>
</template>
