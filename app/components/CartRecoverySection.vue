<script setup lang="ts">
import { useCartStore } from '~/stores/cart'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import CartRecoveryPanel from './CartRecoveryPanel.vue'

const props = defineProps<{ stage: 'cart' | 'checkout' }>()
const runtime = useRuntimeConfig(),
  cart = useCartStore(),
  auth = useUserSession()
const pending = ref(false)
const enabled = computed(
  () =>
    runtime.public.serverRuntime === 'cloudflare' &&
    auth.ready?.value === true &&
    auth.loggedIn?.value === true &&
    auth.user?.value?.emailVerified === true &&
    catalogPolicyUuidSchema.safeParse(auth.user?.value?.id).success &&
    catalogPolicyUuidSchema.safeParse(auth.session?.value?.sessionId).success &&
    Number.isSafeInteger(auth.session?.value?.sessionVersion) &&
    Number(auth.session?.value?.sessionVersion) > 0 &&
    cart.ready &&
    !cart.loading &&
    !cart.error &&
    !cart.pendingMutation &&
    cart.items.length > 0 &&
    catalogPolicyUuidSchema.safeParse(cart.id).success &&
    Number.isSafeInteger(cart.version) &&
    cart.version > 0
)
const scopeKey = computed(() =>
  JSON.stringify([
    auth.user?.value?.id,
    auth.session?.value?.sessionId,
    auth.session?.value?.sessionVersion,
    cart.id,
    cart.version,
    props.stage
  ])
)
watch(
  [enabled, scopeKey],
  () => {
    pending.value = false
  },
  { flush: 'sync' }
)
onBeforeRouteLeave(
  () =>
    !pending.value ||
    window.confirm(
      'Hay una operación de recuperación pendiente de confirmar. Salir descarta la intención local, pero no deshace un cambio ya registrado. ¿Quieres salir?'
    )
)
function beforeUnload(event: BeforeUnloadEvent) {
  if (!pending.value) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
</script>
<template>
  <details v-if="enabled" class="my-6 rounded-xl border border-slate-200 p-4">
    <summary class="cursor-pointer font-semibold">Recordatorios para retomar esta compra</summary>
    <CartRecoveryPanel
      class="mt-4"
      :scope-key="scopeKey"
      :enabled="enabled"
      :cart-id="cart.id!"
      :cart-version="cart.version"
      :stage="stage"
      @pending="pending = $event"
    />
  </details>
</template>
