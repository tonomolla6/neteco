<script setup lang="ts">
import type { OrderDetailView } from '~~/shared/types/orders'

useSeoMeta({
  title: 'Devoluciones',
  description:
    'Cómo devolver un producto NETECO: plazos, condiciones y pasos. En zona de reparto propio lo recogemos nosotros.'
})

const route = useRoute()
const orderNumber = computed(() => String(route.query.pedido ?? ''))
const { data: order, error: orderError } = await useFetch<OrderDetailView>(
  () => (orderNumber.value ? `/api/orders/${orderNumber.value}` : '/api/health/live'),
  { key: `return-order-${orderNumber.value}` }
)
const reason = ref('')
const quantities = reactive<Record<string, number>>({})
const submitting = ref(false)
const result = ref<{ id: string; status: string } | null>(null)
const formError = ref('')
let idempotencyKey = crypto.randomUUID()

async function submitReturn() {
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
    idempotencyKey = crypto.randomUUID()
  } catch (error) {
    formError.value = apiErrorMessage(error, 'No se ha podido registrar la devolución.')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-10">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Devoluciones</h1>
    <p class="mt-2 text-slate-600">Si algo no es lo que esperabas, lo arreglamos rápido y sin vueltas.</p>

    <section v-if="orderNumber" class="mt-8 rounded-2xl border border-neteco-200 bg-neteco-50 p-6">
      <h2 class="text-lg font-bold text-slate-900">Solicitud para {{ orderNumber }}</h2>
      <UAlert
        v-if="orderError"
        class="mt-4"
        color="error"
        title="No se puede abrir este pedido"
        description="Accede desde el enlace seguro del pedido o inicia sesión con la cuenta que lo compró."
      />
      <UAlert
        v-else-if="result"
        class="mt-4"
        color="success"
        icon="i-lucide-circle-check"
        title="Devolución registrada"
        :description="`Referencia ${result.id}. Revisaremos la solicitud antes de autorizar el envío o la recogida.`"
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
          Como consumidor tienes <b>14 días naturales</b> desde la entrega para ejercer el desistimiento, con las
          excepciones legales aplicables. Las compras profesionales y los productos restringidos se revisan según sus
          condiciones contractuales.
        </p>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="flex items-center gap-2 font-bold text-slate-900">
          <UIcon name="i-lucide-package-check" class="size-5 text-neteco-600" /> Condiciones
        </h2>
        <ul class="mt-2 list-inside list-disc space-y-1 text-sm text-slate-600">
          <li>El producto debe estar sin abrir y en su embalaje original.</li>
          <li>Por seguridad, los productos químicos abiertos o desprecintados no admiten devolución.</li>
          <li>Si el error es nuestro (producto equivocado o dañado), corremos con todos los gastos, siempre.</li>
        </ul>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="flex items-center gap-2 font-bold text-slate-900">
          <UIcon name="i-lucide-rotate-ccw" class="size-5 text-neteco-600" /> Cómo se hace
        </h2>
        <p class="mt-2 text-sm text-slate-600">
          Llámanos al <a href="tel:600861334" class="font-semibold text-neteco-600 underline">600 861 334</a> o escribe
          a
          <a href="mailto:administracion@neteco.es" class="font-semibold text-neteco-600 underline"
            >administracion@neteco.es</a
          >
          con el número de pedido. En la zona de reparto propio <b>pasamos a recogerlo nosotros</b> en la siguiente
          ruta; para envíos por agencia te mandamos una etiqueta de devolución.
        </p>
        <p class="mt-2 text-sm text-slate-600">
          El abono se hace por el mismo método de pago en un máximo de 14 días desde que recibimos el producto.
        </p>
      </div>
    </div>

    <div class="mt-8 text-center">
      <UButton to="/catalogo" variant="soft" icon="i-lucide-layout-grid">Ver el catálogo</UButton>
    </div>
  </div>
</template>
