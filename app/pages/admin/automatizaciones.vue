<script setup lang="ts">
import { ref } from 'vue'
import AdminMarketingAutomations from '../../components/AdminMarketingAutomations.vue'
import AdminCrmMetricsPanel from '../../components/AdminCrmMetricsPanel.vue'
import AdminMarketingObservabilityPanel from '../../components/AdminMarketingObservabilityPanel.vue'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Automatizaciones de marketing · Admin', robots: 'noindex, nofollow, noarchive' })

const activeTab = ref<'policies' | 'metrics' | 'observability'>('policies')
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
    <div v-if="authorize" class="space-y-6">
      <div class="flex rounded-lg border border-neutral-200 bg-neutral-100 p-1 text-xs font-semibold w-fit">
        <button
          class="rounded-md px-3 py-1.5 transition-colors"
          :class="
            activeTab === 'policies' ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-600 hover:text-neutral-900'
          "
          @click="activeTab = 'policies'"
        >
          Políticas y Despacho
        </button>
        <button
          class="rounded-md px-3 py-1.5 transition-colors"
          :class="
            activeTab === 'metrics' ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-600 hover:text-neutral-900'
          "
          @click="activeTab = 'metrics'"
        >
          Medición e Incrementales (DAT-016)
        </button>
        <button
          class="rounded-md px-3 py-1.5 transition-colors"
          :class="
            activeTab === 'observability'
              ? 'bg-white text-neutral-900 shadow-sm'
              : 'text-neutral-600 hover:text-neutral-900'
          "
          @click="activeTab = 'observability'"
        >
          Observabilidad Flujos (OBS-027)
        </button>
      </div>

      <AdminMarketingAutomations v-if="activeTab === 'policies'" />
      <AdminCrmMetricsPanel v-else-if="activeTab === 'metrics'" />
      <AdminMarketingObservabilityPanel v-else-if="activeTab === 'observability'" />
    </div>
    <p v-else role="status" class="rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
      Requiere sesión verificada con MFA y permiso de administración. Los permisos se verifican de nuevo en el servidor.
    </p>
  </div>
</template>
