<script setup lang="ts">
import CartRecoveryPanel from '../../components/CartRecoveryPanel.vue'
import { cartRecoveryResolveInputSchema } from '~~/shared/cart-recovery'
// This capability entry must not use the account middleware: it redirects
// fullPath and would move the secret fragment into a login query.
definePageMeta({ layout: 'cuenta' })
useSeoMeta({ title: 'Recordatorios de carrito', robots: 'noindex, nofollow, noarchive' })
useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
const auth = useUserSession(),
  runtime = useRuntimeConfig()
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
const recovery = shallowRef<{ id: string; token: string } | null>(null),
  fragmentError = ref(false),
  pending = ref(false),
  confirmedAction = ref<'preferences' | 'associate' | 'resume' | null>(null)
function onConfirmed(action: 'preferences' | 'associate' | 'resume') {
  recovery.value = null
  confirmedAction.value = action
}
watch(
  pending,
  (value) => {
    if (value) confirmedAction.value = null
  },
  { flush: 'sync' }
)
function consumeFragment() {
  const fragment = window.location.hash
  if (!fragment) return
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  // Scrub every arrival, but never replace a reviewed or uncertain command.
  if (!enabled.value || pending.value) return
  recovery.value = null
  confirmedAction.value = null
  fragmentError.value = false
  const values = new URLSearchParams(fragment.slice(1)),
    parsed = cartRecoveryResolveInputSchema.safeParse({ id: values.get('id'), token: values.get('token') })
  if (
    fragment.length > 300 ||
    [...values.keys()].some((key) => !['id', 'token'].includes(key)) ||
    values.getAll('id').length !== 1 ||
    values.getAll('token').length !== 1 ||
    !parsed.success
  ) {
    fragmentError.value = true
    return
  }
  recovery.value = parsed.data
}
onMounted(() => {
  consumeFragment()
  window.addEventListener('hashchange', consumeFragment)
})
watch(
  scopeKey,
  () => {
    recovery.value = null
    pending.value = false
    confirmedAction.value = null
  },
  { flush: 'sync' }
)
watch(
  enabled,
  (value) => {
    if (!value) {
      recovery.value = null
      pending.value = false
      confirmedAction.value = null
    }
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  window.removeEventListener('hashchange', consumeFragment)
  recovery.value = null
  confirmedAction.value = null
})
</script>
<template>
  <div class="space-y-6">
    <UiPageHeader
      title="Recordatorios de carrito"
      description="Si dejas una compra a medias, podemos enviarte un correo para que la retomes. Antes de recuperarla verás los productos y precios actuales."
    />
    <p v-if="fragmentError" role="alert">El enlace no es válido. No se ha cambiado nada.</p>
    <p v-if="pending" role="status">
      Hay un cambio pendiente de confirmar. Espera a ver el resultado antes de repetirlo.
    </p>
    <p v-if="confirmedAction" role="status">
      {{
        confirmedAction === 'resume'
          ? 'Hemos recuperado tu carrito. Revisa el envío antes de hacer el pedido.'
          : 'Cambio guardado.'
      }}
    </p>
    <div v-if="enabled" class="account-card account-embedded">
      <CartRecoveryPanel
        :enabled="enabled"
        :scope-key="scopeKey"
        :pending="false"
        :recovery="recovery"
        @pending="pending = $event"
        @confirmed="onConfirmed"
      />
    </div>
    <UiSurface v-else padding="none">
      <UiEmptyState
        icon="i-lucide-shopping-cart"
        title="Inicia sesión para gestionar tus recordatorios"
        description="Necesitas una cuenta con el correo confirmado. Si vienes de un correo nuestro, vuelve a abrir su enlace después de entrar."
      >
        <UButton to="/login?redirect=%2Fcuenta%2Frecuperar-carrito" external>Iniciar sesión</UButton>
      </UiEmptyState>
    </UiSurface>
    <div>
      <UButton to="/carrito" color="neutral" variant="outline" icon="i-lucide-shopping-cart">Ir a mi carrito</UButton>
    </div>
  </div>
</template>
