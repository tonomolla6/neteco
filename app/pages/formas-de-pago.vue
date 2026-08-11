<script setup lang="ts">
useSeoMeta({
  title: 'Formas de pago',
  description: 'Paga tus pedidos NETECO con tarjeta, Bizum o transferencia bancaria. Factura con NIF en todos los pedidos.'
})

const methods = [
  {
    icon: 'i-lucide-credit-card',
    title: 'Tarjeta de crédito o débito',
    desc: 'Pago seguro a través de TPV virtual. El cargo se realiza al confirmar el pedido y empezamos a prepararlo al momento.'
  },
  {
    icon: 'i-lucide-smartphone',
    title: 'Bizum',
    desc: 'Paga desde tu móvil con el teléfono asociado a tu cuenta Bizum. Confirmación inmediata.'
  },
  {
    icon: 'i-lucide-landmark',
    title: 'Transferencia bancaria',
    desc: 'Al confirmar el pedido te damos el IBAN y el concepto. Preparamos el pedido en cuanto recibimos el ingreso (1-2 días laborables según banco).'
  }
]
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-10">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Formas de pago</h1>
    <p class="mt-2 text-slate-600">Todas las opciones incluyen factura con tu NIF/CIF, la necesites para tu negocio o no.</p>

    <div class="mt-8 grid gap-4 sm:grid-cols-3">
      <div v-for="m in methods" :key="m.title" class="rounded-2xl border border-slate-200 bg-white p-6">
        <span class="inline-block rounded-xl bg-neteco-50 p-3 text-neteco-600">
          <UIcon :name="m.icon" class="block size-6" />
        </span>
        <h2 class="mt-3 font-bold text-slate-900">{{ m.title }}</h2>
        <p class="mt-2 text-sm text-slate-500">{{ m.desc }}</p>
      </div>
    </div>

    <p class="mt-6 rounded-xl bg-slate-100 p-4 text-sm text-slate-600">
      <UIcon name="i-lucide-info" class="inline size-4 text-neteco-600" />
      En esta demo la pasarela de pago es simulada: no se realiza ningún cargo real.
    </p>

    <div class="mt-8 text-center">
      <UButton to="/catalogo" variant="soft" icon="i-lucide-layout-grid">Ver el catálogo</UButton>
    </div>
  </div>
</template>
