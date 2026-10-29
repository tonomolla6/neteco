<script setup lang="ts">
import ProductWatchPanel from '../../components/ProductWatchPanel.vue'
import { productWatchConfirmInputSchema } from '~~/shared/product-watch'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
// Public capability entry. The generic account guard redirects fullPath,
// including the confirmation fragment; private reads remain gated below.
definePageMeta({ layout: 'default' })
useSeoMeta({ title: 'Mis avisos de variantes', robots: 'noindex, nofollow, noarchive' })
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
  <div class="space-y-5">
    <h1 class="text-2xl font-semibold">Mis avisos de variantes</h1>
    <p>
      Gestiona tus solicitudes de reposición y bajada de precio. Cada solicitud requiere consentimiento y confirmación
      por correo. No reserva productos ni garantiza el envío de un aviso.
    </p>
    <p v-if="fragmentError" role="alert">El enlace de confirmación no es válido. No se ha enviado ninguna solicitud.</p>
    <p v-if="pending" role="status">Hay una operación pendiente de confirmar. Consulta su recibo antes de repetirla.</p>
    <ProductWatchPanel
      v-if="enabled"
      :scope-key="scopeKey"
      :enabled="enabled"
      :pending="false"
      :confirmation="confirmation"
      @pending="onPending"
      @confirmed="onConfirmed"
    />
    <p v-else>
      Estos avisos requieren una cuenta con correo verificado y el servicio de avisos disponible.
      <a href="/login?redirect=%2Fcuenta%2Favisos-productos" class="underline">Inicia sesión</a>
      y reabre el enlace original del correo para confirmar el aviso.
    </p>
  </div>
</template>
