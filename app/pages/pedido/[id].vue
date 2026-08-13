<script setup lang="ts">
import type { OrderDetailView } from '~~/shared/types/orders'

const route = useRoute()
const { loggedIn } = useUserSession()

const { data: orderData, error } = await useFetch<OrderDetailView>(`/api/orders/${route.params.id}`, {
  params: { token: route.query.token }
})
if (error.value || !orderData.value) {
  throw createError({
    statusCode: error.value?.statusCode ?? 404,
    statusMessage: error.value?.statusMessage ?? 'Pedido no encontrado',
    fatal: true
  })
}
const order = computed(() => orderData.value!)
if (route.query.token) {
  await navigateTo({ path: route.path, query: {} }, { replace: true })
}

useSeoMeta({ title: `Pedido ${order.value.id}` })

const status = computed(() => ORDER_STATUS[order.value.status] ?? ORDER_STATUS.pendiente_pago!)
const shipping = computed(() => SHIPPING_METHODS.find((m) => m.value === order.value.shippingMethod))
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-8">
    <!-- cabecera de estado -->
    <div
      class="rounded-2xl p-6 sm:p-8"
      :class="
        order.status === 'pagado' ? 'bg-emerald-50 border border-emerald-200' : 'bg-neteco-50 border border-neteco-200'
      "
    >
      <div class="flex items-start gap-4">
        <span
          class="rounded-full p-3"
          :class="order.status === 'pagado' ? 'bg-emerald-500 text-white' : 'bg-neteco-500 text-white'"
        >
          <UIcon :name="order.status === 'pagado' ? 'i-lucide-check' : status.icon" class="block size-6" />
        </span>
        <div class="flex-1">
          <h1 class="text-xl font-bold text-slate-900 sm:text-2xl">
            {{ order.status === 'pagado' ? '¡Gracias por tu pedido!' : 'Pedido registrado' }}
          </h1>
          <p class="mt-1 text-slate-600">
            Pedido <b>{{ order.id }}</b> · {{ formatDate(order.createdAt) }}
          </p>
          <UBadge :color="status.color" variant="subtle" class="mt-2" :icon="status.icon">
            {{ status.label }}
          </UBadge>
        </div>
      </div>

      <div
        v-if="order.status === 'pendiente_transferencia'"
        class="mt-5 rounded-xl bg-white p-4 text-sm text-slate-600"
      >
        <p class="font-semibold text-slate-800">Datos para la transferencia</p>
        <p class="mt-1">
          Importe: <b>{{ formatPrice(order.total) }}</b>
        </p>
        <p>IBAN: <b>ES00 0000 0000 0000 0000 0000</b> (demo)</p>
        <p>
          Concepto: <b>{{ order.id }}</b>
        </p>
        <p class="mt-2 text-xs text-slate-400">Prepararemos el pedido en cuanto recibamos el ingreso.</p>
      </div>
    </div>

    <!-- aviso invitado -->
    <div
      v-if="!loggedIn"
      class="mt-4 flex flex-col justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center"
    >
      <p class="text-sm text-slate-600">
        <UIcon name="i-lucide-bookmark" class="inline size-4 text-neteco-600" />
        Este navegador conserva acceso temporal al pedido. Crea una cuenta para consultarlo de forma duradera y desde
        otros dispositivos.
      </p>
      <UButton :to="`/registro?email=${encodeURIComponent(order.email)}`" variant="soft" icon="i-lucide-user-plus">
        Crear cuenta
      </UButton>
    </div>

    <div class="mt-6 grid gap-6 md:grid-cols-3">
      <!-- artículos -->
      <div class="rounded-2xl border border-slate-200 bg-white p-6 md:col-span-2">
        <h2 class="font-bold text-slate-900">Artículos</h2>
        <ul class="mt-3 divide-y divide-slate-100">
          <li v-for="(item, i) in order.items" :key="i" class="flex items-center justify-between gap-3 py-3">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium text-slate-800">{{ item.name }}</p>
              <p class="text-xs text-slate-400">{{ item.format }} · Ref. {{ item.sku }} · × {{ item.qty }}</p>
            </div>
            <p class="shrink-0 text-sm font-semibold">{{ formatPrice(item.price * item.qty) }}</p>
          </li>
        </ul>
        <dl class="mt-2 space-y-1.5 border-t border-slate-100 pt-4 text-sm">
          <div class="flex justify-between">
            <dt class="text-slate-500">Subtotal</dt>
            <dd>{{ formatPrice(order.subtotal) }}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-slate-500">Envío ({{ shipping?.label ?? order.shippingMethod }})</dt>
            <dd>{{ order.shippingCost ? formatPrice(order.shippingCost) : 'Gratis' }}</dd>
          </div>
          <div class="flex justify-between text-xs text-slate-500">
            <dt>IVA incluido (21 %)</dt>
            <dd>{{ formatPrice(order.tax) }}</dd>
          </div>
          <div class="flex justify-between pt-2 text-base">
            <dt class="font-semibold">Total</dt>
            <dd class="text-xl font-bold">{{ formatPrice(order.total) }}</dd>
          </div>
        </dl>
        <p class="mt-3 text-sm text-slate-500">Te enviaremos la factura a {{ order.email }}.</p>
      </div>

      <!-- datos entrega -->
      <div class="h-fit rounded-2xl border border-slate-200 bg-white p-6 text-sm">
        <h2 class="font-bold text-slate-900">Entrega</h2>
        <p class="mt-3 font-medium text-slate-700">{{ order.name }}</p>
        <p v-if="order.company" class="text-slate-500">{{ order.company }} {{ order.nif ? `· ${order.nif}` : '' }}</p>
        <p class="mt-1 text-slate-500">{{ order.address }}</p>
        <p class="text-slate-500">
          {{ order.zip }} {{ order.city }}<template v-if="order.province"> ({{ order.province }})</template>
        </p>
        <p class="mt-2 flex items-center gap-1.5 text-slate-500">
          <UIcon name="i-lucide-phone" class="size-3.5" /> {{ order.phone }}
        </p>
        <p class="flex items-center gap-1.5 text-slate-500">
          <UIcon name="i-lucide-mail" class="size-3.5" /> {{ order.email }}
        </p>
        <p v-if="order.notes" class="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-500">«{{ order.notes }}»</p>
      </div>
    </div>

    <div class="mt-8 text-center">
      <UButton
        v-if="order.fulfillmentStatus === 'delivered'"
        :to="`/devoluciones?pedido=${encodeURIComponent(order.id)}`"
        class="mr-2"
        variant="outline"
        icon="i-lucide-rotate-ccw"
      >
        Solicitar devolución
      </UButton>
      <UButton to="/catalogo" variant="soft" icon="i-lucide-arrow-left">Seguir comprando</UButton>
    </div>
  </div>
</template>
