<script setup lang="ts">
import type { OrderDetailView } from '~~/shared/types/orders'
import CustomerReturnSection from '~/components/CustomerReturnSection.vue'

const runtime = useRuntimeConfig().public.serverRuntime

useSeoMeta({
  title: 'Devoluciones',
  description:
    runtime === 'cloudflare'
      ? 'Solicitud y seguimiento de devoluciones del pedido: revisión documentada, custodia e inspección.'
      : 'Cómo devolver un producto NETECO: plazos, condiciones y pasos. En zona de reparto propio lo recogemos nosotros.'
})

const route = useRoute()
const orderNumber = computed(() => String(route.query.pedido ?? ''))
const { data: order, error: orderError } = await useFetch<OrderDetailView>(
  () => (orderNumber.value ? `/api/orders/${orderNumber.value}` : '/api/health/live'),
  {
    key: `return-order-${orderNumber.value}`,
    immediate: runtime === 'node',
    watch: runtime === 'node' ? undefined : false
  }
)
const reason = ref('')
const quantities = reactive<Record<string, number>>({})
const submitting = ref(false)
const result = ref<{ id: string; status: string } | null>(null)
const formError = ref('')
let idempotencyKey = randomId()

async function submitReturn() {
  if (runtime !== 'node') return
  formError.value = ''
  const lines = (order.value?.items ?? [])
    .map((item) => ({ orderLineId: item.id, quantity: Number(quantities[item.id] ?? 0) }))
    .filter((line: { quantity: number }) => line.quantity > 0)
  if (!lines.length) {
    formError.value = 'Selecciona al menos una unidad para devolver.'
    return
  }
  if (reason.value.trim().length < 5) {
    formError.value = 'Describe brevemente el motivo.'
    return
  }
  submitting.value = true
  try {
    result.value = await $fetch(`/api/orders/${orderNumber.value}/returns`, {
      method: 'POST',
      body: { reason: reason.value.trim(), lines, idempotencyKey }
    })
    idempotencyKey = randomId()
  } catch (error) {
    formError.value = apiErrorMessage(error, 'No se ha podido registrar la devolución.')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div v-if="runtime === 'cloudflare'" class="mx-auto max-w-4xl space-y-6 px-4 py-10">
    <h1 class="text-2xl font-bold">Devoluciones</h1>
    <CustomerReturnSection v-if="orderNumber" :order-id="orderNumber" :runtime="runtime" />
    <p v-else role="status">
      Abre la devolución desde tu pedido para consultar sus cantidades e historial con tu cuenta verificada.
    </p>
    <NuxtLink to="/cuenta/pedidos" class="underline">Ver mis pedidos</NuxtLink>
  </div>
  <div v-else-if="runtime === 'node'" class="mx-auto max-w-4xl px-4 py-10">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Devoluciones</h1>
    <p class="mt-2 text-slate-600">Si algo no es lo que esperabas, lo arreglamos rápido y sin vueltas.</p>

    <section v-if="orderNumber" class="mt-8 rounded-2xl border border-neteco-200 bg-neteco-50 p-6">
      <h2 class="text-lg font-bold text-slate-900">Solicitud para {{ orderNumber }}</h2>
      <UAlert
        v-if="orderError"
        class="mt-4"
        color="error"
        title="No se puede abrir este pedido"
        description="Entra con la cuenta con la que hiciste el pedido, o usa el enlace que te llegó por email."
      />
      <UAlert
        v-else-if="result"
        class="mt-4"
        color="success"
        icon="i-lucide-circle-check"
        title="Devolución registrada"
        :description="`Guarda esta referencia: ${result.id}. La revisamos y te decimos cómo devolverlo antes de que muevas nada.`"
      />
      <form v-else-if="order?.items" class="mt-4 space-y-4" @submit.prevent="submitReturn">
        <fieldset>
          <legend class="text-sm font-semibold text-slate-800">Unidades que quieres devolver</legend>
          <div class="mt-2 space-y-2">
            <label
              v-for="item in order.items"
              :key="item.id"
              class="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-3"
            >
              <span class="text-sm text-slate-700">{{ item.name }} · {{ item.format }} · {{ item.sku }}</span>
              <input
                v-model.number="quantities[item.id]"
                type="number"
                min="0"
                :max="item.qty"
                step="1"
                class="w-20 rounded-lg border border-slate-300 px-3 py-2"
                :aria-label="`Cantidad a devolver de ${item.name}`"
              />
            </label>
          </div>
        </fieldset>
        <UFormField label="Motivo" required>
          <UTextarea
            v-model="reason"
            :maxlength="500"
            class="w-full"
            placeholder="Indica qué ha ocurrido y el estado del producto"
          />
        </UFormField>
        <UAlert v-if="formError" color="error" :description="formError" />
        <UButton type="submit" :loading="submitting" icon="i-lucide-rotate-ccw">Enviar solicitud</UButton>
      </form>
    </section>

    <div class="mt-8 space-y-4">
      <div class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="flex items-center gap-2 font-bold text-slate-900">
          <UIcon name="i-lucide-calendar-days" class="size-5 text-neteco-600" /> Plazo
        </h2>
        <p class="mt-2 text-sm text-slate-600">
          Escríbenos en cuanto veas el problema. El plazo depende del producto y de las condiciones que aceptaste al
          comprar; si tienes dudas, pregúntanos y lo miramos contigo. Al enviar la solicitud te damos una referencia con
          la fecha, para que quede constancia desde el primer momento.
        </p>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="flex items-center gap-2 font-bold text-slate-900">
          <UIcon name="i-lucide-package-check" class="size-5 text-neteco-600" /> Condiciones
        </h2>
        <ul class="mt-2 list-inside list-disc space-y-1 text-sm text-slate-600">
          <li>El producto debe estar sin abrir y en su embalaje original.</li>
          <li>Por seguridad, los productos químicos abiertos o desprecintados no admiten devolución.</li>
          <li>Si el fallo es nuestro, la recogida corre de nuestra cuenta. Te lo confirmamos al autorizar.</li>
        </ul>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="flex items-center gap-2 font-bold text-slate-900">
          <UIcon name="i-lucide-rotate-ccw" class="size-5 text-neteco-600" /> Cómo se hace
        </h2>
        <p class="mt-2 text-sm text-slate-600">
          <ContactAction capitalize link-class="font-semibold text-neteco-600 underline" /> con el número de pedido.
          Cuando la autoricemos te diremos cómo devolverlo: si pasamos a recogerlo, si te mandamos una etiqueta, o cómo
          tratarlo si es un producto químico.
        </p>
        <p class="mt-2 text-sm text-slate-600">
          El abono se hace por el mismo medio con el que pagaste, y recibirás la factura rectificativa. Mientras tanto
          puedes seguir el estado de la solicitud: que esté registrada no significa todavía que el reembolso esté
          aprobado.
        </p>
      </div>
    </div>

    <div class="mt-8 text-center">
      <UButton to="/catalogo" variant="soft" icon="i-lucide-layout-grid">Ver el catálogo</UButton>
    </div>
  </div>
  <p v-else role="status">
    Ahora mismo no puedes solicitar devoluciones desde la web. Escríbenos desde Contacto y te ayudamos.
  </p>
</template>
