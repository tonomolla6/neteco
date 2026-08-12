<script setup lang="ts">
const route = useRoute()
const order = computed(() => String(route.query.order ?? ''))

useSeoMeta({ title: 'Comprobando pago', robots: 'noindex, nofollow' })

onMounted(async () => {
  if (order.value) await navigateTo(`/pedido/${encodeURIComponent(order.value)}`, { replace: true })
})
</script>

<template>
  <main class="mx-auto max-w-xl px-4 py-20 text-center">
    <UIcon name="i-lucide-loader-circle" class="mx-auto size-10 animate-spin text-neteco-600" />
    <h1 class="mt-5 text-2xl font-bold text-slate-900">Comprobando el pago…</h1>
    <p class="mt-2 text-slate-600">
      La confirmación llega directamente desde el banco. No cierres esta ventana mientras consultamos tu pedido.
    </p>
  </main>
</template>
