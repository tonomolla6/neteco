<script setup lang="ts">
import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

type DemoRole = 'customer' | 'admin'
const props = defineProps<{ runtime: unknown; enabled: unknown }>(),
  { ready, loggedIn, user, fetch: refreshSession } = useUserSession(),
  requestFetch = useRequestFetch(),
  visible = computed(() => props.runtime === 'cloudflare' && props.enabled === true),
  loading = ref(false),
  error = ref('')
const receiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    demo: z.literal(true),
    role: z.enum(['customer', 'admin']),
    identityId: catalogPolicyUuidSchema
  })
  .strict()
let active = true,
  generation = 0
const available = () => active && visible.value && ready.value === true
function current(epoch: number) {
  return available() && generation === epoch
}
watch(
  () => [props.runtime, props.enabled],
  () => {
    generation++
    error.value = ''
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  active = false
  generation++
})

async function enter(role: DemoRole) {
  if (!available() || loading.value || typeof window === 'undefined') return
  loading.value = true
  error.value = ''
  const epoch = ++generation,
    endpoint: string = '/api/demo/login'
  try {
    if (!('raw' in requestFetch) || typeof requestFetch.raw !== 'function')
      throw Error('demo_client_transport_unavailable')
    const response = await requestFetch.raw<unknown>(endpoint, {
      method: 'POST',
      body: { role },
      retry: 0,
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
      cache: 'no-store'
    })
    if (!current(epoch)) return
    if (response.status !== 200) throw Error('demo_login_unconfirmed')
    const receipt = receiptSchema.parse(catalogPolicyOwnJson(response._data))
    if (receipt.role !== role) throw Error('demo_role_unconfirmed')
    await refreshSession()
    if (!current(epoch)) return
    const session = catalogPolicyOwnJson(user.value)
    if (
      !session ||
      typeof session !== 'object' ||
      Array.isArray(session) ||
      loggedIn.value !== true ||
      Reflect.get(session, 'id') !== receipt.identityId ||
      Reflect.get(session, 'role') !== role ||
      Reflect.get(session, 'emailVerified') !== true ||
      (role === 'admin' && Reflect.get(session, 'mfaVerified') !== true)
    )
      throw Error('demo_session_unconfirmed')
    await navigateTo(role === 'admin' ? '/admin' : '/cuenta')
  } catch {
    if (current(epoch))
      error.value = 'No se ha podido confirmar el acceso a la demo. Puedes volver a intentarlo explícitamente.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <aside
    v-if="visible"
    class="demo-login-shortcuts rounded-2xl border border-neteco-200 bg-white p-4 text-slate-900 shadow-xl"
    aria-labelledby="demo-login-title"
    :aria-busy="loading"
    data-testid="demo-login-shortcuts"
  >
    <p id="demo-login-title" class="text-sm font-bold">DEMO · sintética y aislada</p>
    <p id="demo-login-description" class="mt-1 text-xs text-slate-600">Accesos de demostración. Sin pagos reales.</p>
    <div class="mt-3 flex flex-wrap gap-2">
      <button
        type="button"
        class="demo-login-button flex-1 rounded-lg border border-neteco-600 px-3 py-2 text-sm font-semibold text-neteco-700 disabled:cursor-wait disabled:opacity-60"
        :disabled="loading || ready !== true"
        aria-describedby="demo-login-description"
        data-testid="demo-login-customer"
        @click="enter('customer')"
      >
        Entrar cliente
      </button>
      <button
        type="button"
        class="demo-login-button flex-1 rounded-lg bg-neteco-600 px-3 py-2 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60"
        :disabled="loading || ready !== true"
        aria-describedby="demo-login-description"
        data-testid="demo-login-admin"
        @click="enter('admin')"
      >
        Entrar admin
      </button>
    </div>
    <p v-if="loading" class="mt-2 text-xs text-slate-600" role="status" aria-live="polite">
      Confirmando sesión de demo…
    </p>
    <p v-if="error" class="mt-2 text-sm text-red-700" role="alert" data-testid="demo-login-error">{{ error }}</p>
  </aside>
</template>

<style scoped>
.demo-login-shortcuts {
  position: fixed;
  right: max(1rem, env(safe-area-inset-right));
  bottom: max(1rem, env(safe-area-inset-bottom));
  width: min(22rem, calc(100vw - 2rem));
  z-index: 50;
}
.demo-login-button {
  min-height: 44px;
}
.demo-login-button:focus-visible {
  outline: 3px solid #0369a1;
  outline-offset: 3px;
}
</style>
