<script setup lang="ts">
import SupportContactPanel from './SupportContactPanel.vue'
import SupportChallengeWidget from './SupportChallengeWidget.vue'
import { supportOptionsSchema, supportUuid, type SupportReceipt } from '~~/shared/support-operations'
import { useSupportRead } from './support/state'
const props = defineProps<{
  runtime: unknown
  orderId?: string
  orderReference?: string
  productSlug?: string
  categorySlug?: string
}>()
const emit = defineEmits<{ confirmed: [receipt: SupportReceipt] }>()
const { ready, loggedIn, user } = useUserSession(),
  requestFetch = useRequestFetch()
// Browser GET must receive the HttpOnly intake Set-Cookie itself; an internal
// SSR fetch would not forward that response cookie to the browser.
const browserReady = ref(false)
onMounted(() => {
  browserReady.value = true
})
const actorId = computed(() =>
  loggedIn.value === true && supportUuid.safeParse(user.value?.id).success ? user.value!.id : 'anonymous-contact'
)
const contextKey = computed(
  () => actorId.value + ':' + (props.orderId ?? '') + ':' + (props.productSlug ?? '') + ':' + (props.categorySlug ?? '')
)
const authorize = () =>
  browserReady.value === true &&
  props.runtime === 'cloudflare' &&
  ready.value === true &&
  (loggedIn.value === false ||
    (loggedIn.value === true && supportUuid.safeParse(user.value?.id).success && user.value?.emailVerified === true))
const read = useSupportRead({
  authorize,
  owner: () => contextKey.value,
  endpoint: () => '/api/support/options',
  query: () => ({}),
  request: (endpoint, query) => requestFetch<unknown>(endpoint, { method: 'GET', query, retry: 0, cache: 'no-store' }),
  decode: (raw) => {
    const parsed = supportOptionsSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }
})
const { snapshot, loading, failed } = read
watch(
  () => [
    browserReady.value,
    props.runtime,
    props.orderId,
    props.productSlug,
    props.categorySlug,
    ready.value,
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified
  ],
  () => {
    read.reset()
    read.refresh()
  },
  { immediate: true, flush: 'sync' }
)
</script>
<template>
  <section aria-label="Contacto nativo y privacidad" class="space-y-4">
    <p v-if="!authorize()" role="status">
      Confirma tu sesión o verifica el correo antes de registrar una consulta. El formulario no reclama pedidos de
      invitado por correo o referencia.
    </p>
    <template v-else>
      <p v-if="loading" data-testid="support-options-loading" role="status">
        Confirmando política y controles de contacto…
      </p>
      <p v-if="failed" data-testid="support-options-error" role="alert">
        No se ha confirmado la configuración de contacto. El formulario permanece bloqueado.
      </p>
      <button
        data-testid="support-options-refresh"
        :disabled="loading"
        class="rounded border p-2"
        @click="read.refresh()"
      >
        Actualizar configuración
      </button>
    </template>
    <SupportContactPanel
      :key="contextKey"
      :snapshot="snapshot"
      :actor-id="actorId"
      :runtime="runtime"
      :authorize="authorize"
      :reload="read.reload"
      :order-id="orderId"
      :order-reference="orderReference"
      :product-slug="productSlug"
      :category-slug="categorySlug"
      @confirmed="emit('confirmed', $event)"
    >
      <template #challenge="slotProps">
        <slot v-if="$slots.challenge" name="challenge" v-bind="slotProps" />
        <SupportChallengeWidget
          v-else-if="slotProps.configuration"
          :configuration="slotProps.configuration"
          :runtime="runtime"
          :authorized="authorize()"
          @token="slotProps.setToken($event)"
        />
        <p v-else>
          El desafío no tiene configuración pública confirmada. Si se exige, el registro quedará bloqueado hasta
          disponer de un verificador real.
        </p>
      </template>
    </SupportContactPanel>
    <a v-if="loggedIn && user?.emailVerified" href="/cuenta/soporte" class="underline"
      >Abrir mi portal privado de soporte</a
    >
  </section>
</template>
