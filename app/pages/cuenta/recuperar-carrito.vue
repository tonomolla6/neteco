<script setup lang="ts">
import CartRecoveryPanel from '../../components/CartRecoveryPanel.vue'
import { cartRecoveryResolveInputSchema } from '~~/shared/cart-recovery'
// This capability entry must not use the account middleware: it redirects
// fullPath and would move the secret fragment into a login query.
definePageMeta({ layout: 'default' })
useSeoMeta({ title: 'Recuperar carrito', robots: 'noindex, nofollow, noarchive' })
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
  <main class="space-y-5">
    <h1 class="text-2xl font-semibold">Recuperar carrito</h1>
    <p>
      Revisa los productos, precios y disponibilidad actuales antes de retomar el carrito. El enlace no reserva stock,
      no crea un pedido ni confirma un pago.
    </p>
    <p v-if="fragmentError" role="alert">El enlace no es válido. No se ha enviado ninguna solicitud.</p>
    <p v-if="pending" role="status">Hay una operación sin confirmar. Consulta su recibo antes de repetirla.</p>
    <p v-if="confirmedAction" role="status">
      {{
        confirmedAction === 'resume'
          ? 'El carrito se ha retomado y comprobado. Revisa el envío antes de realizar un pedido.'
          : 'La operación está confirmada.'
      }}
    </p>
    <CartRecoveryPanel
      v-if="enabled"
      :enabled="enabled"
      :scope-key="scopeKey"
      :pending="false"
      :recovery="recovery"
      @pending="pending = $event"
      @confirmed="onConfirmed"
    />
    <p v-else>
      Necesitas una cuenta con correo verificado.
      <a href="/login?redirect=%2Fcuenta%2Frecuperar-carrito" class="underline">Inicia sesión</a> y reabre el enlace
      original del correo. No se conserva el secreto durante el acceso.
    </p>
    <a href="/carrito" class="underline">Ir al carrito</a>
  </main>
</template>
