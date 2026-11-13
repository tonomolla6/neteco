<script setup lang="ts">
import ProductWatchPanel from '../../components/ProductWatchPanel.vue'
import { productWatchConfirmInputSchema } from '~~/shared/product-watch'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
// Public capability entry. The generic account guard redirects fullPath,
// including the confirmation fragment; private reads remain gated below.
definePageMeta({ layout: 'cuenta' })
useSeoMeta({ title: 'Avisos de productos', robots: 'noindex, nofollow, noarchive' })
useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
const runtime = useRuntimeConfig(),
  auth = useUserSession()
const enabled = computed(
  () =>
    runtime.public.serverRuntime === 'cloudflare' &&
    auth.ready.value &&
    auth.loggedIn.value &&
    auth.user.value?.emailVerified === true
)
const scopeKey = computed(() =>
  JSON.stringify([auth.user.value?.id, auth.session.value?.sessionId, auth.session.value?.sessionVersion])
)
const confirmation = shallowRef<{ watchId: string; token: string } | null>(null),
  pending = ref(false),
  fragmentError = ref(false)
let alive = true
onMounted(() => {
  // A credential is read only in the browser, removed from the visible URL
  // immediately, and never placed in a query, request URL or persistent store.
  const fragment = window.location.hash
  if (!fragment) return
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  // Anonymous credentials are discarded rather than transferred through login.
  // The user must reopen the original email after signing in.
  if (!enabled.value) return
  const values = new URLSearchParams(fragment.slice(1)),
    watchId = values.get('watchId'),
    token = values.get('token')
  if (
    fragment.length > 300 ||
    [...values.keys()].some((key) => !['watchId', 'token'].includes(key)) ||
    values.getAll('watchId').length !== 1 ||
    values.getAll('token').length !== 1 ||
    !catalogPolicyUuidSchema.safeParse(watchId).success ||
    !productWatchConfirmInputSchema.safeParse({ expectedVersion: 1, token }).success
  ) {
    fragmentError.value = true
    return
  }
  confirmation.value = { watchId: watchId!, token: token! }
})
watch(
  scopeKey,
  () => {
    confirmation.value = null
    pending.value = false
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  confirmation.value = null
})
function onPending(value: boolean) {
  if (alive && enabled.value) pending.value = value
}
function onConfirmed() {
  confirmation.value = null
}
</script>
<template>
  <div class="space-y-6">
    <UiPageHeader
      title="Avisos de productos"
      description="Te escribimos cuando un producto vuelve a estar disponible o baja de precio. Los pides desde la ficha de cada producto y los cancelas aquí cuando quieras."
    />
    <p v-if="fragmentError" role="alert">El enlace de confirmación no es válido. No se ha cambiado nada.</p>
    <p v-if="pending" role="status">
      Hay un cambio pendiente de confirmar. Espera a ver el resultado antes de repetirlo.
    </p>
    <div v-if="enabled" class="account-card account-embedded">
      <ProductWatchPanel
        :scope-key="scopeKey"
        :enabled="enabled"
        :pending="false"
        :confirmation="confirmation"
        @pending="onPending"
        @confirmed="onConfirmed"
      />
    </div>
    <UiSurface v-else padding="none">
      <UiEmptyState
        icon="i-lucide-bell-ring"
        title="Inicia sesión para ver tus avisos"
        description="Necesitas una cuenta con el correo confirmado. Si vienes de un correo nuestro, vuelve a abrir su enlace después de entrar."
      >
        <UButton to="/login?redirect=%2Fcuenta%2Favisos-productos" external>Iniciar sesión</UButton>
      </UiEmptyState>
    </UiSurface>
    <UiSurface tone="sunken" padding="sm">
      <p class="text-sm text-[var(--text)]">
        Para pedir un aviso nuevo, abre el producto en el <NuxtLink to="/catalogo">catálogo</NuxtLink> y pulsa
        «Avisarme».
      </p>
    </UiSurface>
  </div>
</template>
