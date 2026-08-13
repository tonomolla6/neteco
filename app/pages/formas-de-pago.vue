<script setup lang="ts">
const runtime = useRuntimeConfig()
const isProduction = runtime.public.appEnv === 'production'
useSeoMeta({
  title: 'Formas de pago',
  description: runtime.public.bankTransferEnabled
    ? 'Paga tus pedidos NETECO con tarjeta, Bizum o transferencia bancaria mediante flujos trazables.'
    : 'Paga tus pedidos NETECO con tarjeta o Bizum mediante el flujo alojado y validado de Redsys.'
})

const methods = computed(() => [
  {
    icon: 'i-lucide-credit-card',
    title: 'Tarjeta de crédito o débito',
    desc: 'Redirección al TPV alojado: NETECO no recibe PAN ni CVC. Solo la notificación bancaria validada confirma el pago.'
  },
  {
    icon: 'i-lucide-smartphone',
    title: 'Bizum',
    desc: 'Autorización en el flujo alojado de Redsys. Volver al navegador no basta: el pedido espera la confirmación bancaria.'
  },
  ...(runtime.public.bankTransferEnabled
    ? [
        {
          icon: 'i-lucide-landmark',
          title: 'Transferencia bancaria',
          desc: 'El pedido queda pendiente con una referencia trazable y la reserva tiene caducidad. La preparación comienza tras conciliar el ingreso.'
        }
      ]
    : [])
])
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-10">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Formas de pago</h1>
    <p class="mt-2 text-slate-600">
      Los documentos fiscales se emiten con los datos validados del pedido cuando el estado de pago y la regla fiscal lo
      permiten.
    </p>

    <div class="mt-8 grid gap-4 sm:grid-cols-3">
      <div v-for="m in methods" :key="m.title" class="rounded-2xl border border-slate-200 bg-white p-6">
        <span class="inline-block rounded-xl bg-neteco-50 p-3 text-neteco-600">
          <UIcon :name="m.icon" class="block size-6" />
        </span>
        <h2 class="mt-3 font-bold text-slate-900">{{ m.title }}</h2>
        <p class="mt-2 text-sm text-slate-500">{{ m.desc }}</p>
      </div>
    </div>

    <p v-if="!isProduction" class="mt-6 rounded-xl bg-slate-100 p-4 text-sm text-slate-600">
      <UIcon name="i-lucide-info" class="inline size-4 text-neteco-600" />
      En esta demo la pasarela de pago es simulada: no se realiza ningún cargo real.
    </p>

    <div class="mt-8 text-center">
      <UButton to="/catalogo" variant="soft" icon="i-lucide-layout-grid">Ver el catálogo</UButton>
    </div>
  </div>
</template>
