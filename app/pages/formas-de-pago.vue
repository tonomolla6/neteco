<script setup lang="ts">
const runtime = useRuntimeConfig()
const isProduction = runtime.public.appEnv === 'production'
useSeoMeta({
  title: 'Formas de pago',
  description: runtime.public.bankTransferEnabled
    ? 'Paga tus pedidos NETECO con tarjeta, Bizum o transferencia bancaria mediante flujos trazables.'
    : 'Paga tus pedidos NETECO con tarjeta o Bizum mediante el flujo alojado y validado de Redsys.'
})

/**
 * La copia venía del lado del sistema: «no recibe PAN ni CVC», «flujo alojado», «referencia
 * trazable», «conciliar el ingreso». Todo es cierto y todo importa, pero dicho así no
 * tranquiliza a nadie: se explica el mecanismo en vez de la consecuencia para quien paga.
 */
const methods = computed(() => [
  {
    icon: 'i-lucide-credit-card',
    title: 'Tarjeta',
    desc: 'Pagas en la pasarela de tu banco, no aquí. NETECO nunca ve ni guarda el número de tu tarjeta. El pedido se confirma cuando el banco nos avisa de que el cobro ha salido bien.'
  },
  {
    icon: 'i-lucide-smartphone',
    title: 'Bizum',
    desc: 'Igual que con tarjeta: autorizas el pago en tu banco. Si cierras el navegador a mitad, no pasa nada: el pedido espera a la confirmación del banco, nunca se cobra dos veces.'
  },
  ...(runtime.public.bankTransferEnabled
    ? [
        {
          icon: 'i-lucide-landmark',
          title: 'Transferencia',
          desc: 'Te damos una referencia para poner en el concepto. Guardamos tu pedido y el stock mientras llega el ingreso; en cuanto lo vemos en cuenta, empezamos a prepararlo.'
        }
      ]
    : [])
])
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-10">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Formas de pago</h1>
    <p class="mt-2 text-slate-600">
      Elige cómo pagar. Recibirás la factura con los datos fiscales de tu empresa en cuanto el pedido esté cobrado.
    </p>

    <div class="mt-8 grid gap-4 grid-cols-1 sm:grid-cols-3">
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
