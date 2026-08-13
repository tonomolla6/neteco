<script setup lang="ts">
useSeoMeta({
  title: 'Centro de ayuda',
  description: 'Ayuda para comprar, pagar, recibir, facturar y devolver pedidos NETECO.'
})

const topics = [
  {
    icon: 'i-lucide-truck',
    title: 'Envíos y recogida',
    text: 'Cómo se calculan métodos, coste y fecha con el destino y la mercancía.',
    to: '/envios'
  },
  {
    icon: 'i-lucide-credit-card',
    title: 'Pago',
    text: 'Redsys alojado, Bizum, transferencia y estados pendientes.',
    to: '/formas-de-pago'
  },
  {
    icon: 'i-lucide-rotate-ccw',
    title: 'Devoluciones',
    text: 'Solicita una RMA desde el enlace seguro de tu pedido y sigue su estado.',
    to: '/devoluciones'
  },
  {
    icon: 'i-lucide-user-round',
    title: 'Cuenta y privacidad',
    text: 'Direcciones, sesiones, MFA, preferencias, descarga y solicitudes de privacidad.',
    to: '/cuenta'
  },
  {
    icon: 'i-lucide-receipt-text',
    title: 'Factura',
    text: 'El PDF aparece en el pedido cuando Beply termina la emisión; una incidencia fiscal no borra el pedido.',
    to: '/cuenta'
  },
  {
    icon: 'i-lucide-life-buoy',
    title: 'Contacto',
    text: 'Abre un ticket con producto o pedido contextual y recibe una referencia de seguimiento.',
    to: '/contacto'
  }
]
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-10">
    <h1 class="text-3xl font-bold text-slate-950">Centro de ayuda</h1>
    <p class="mt-2 max-w-2xl text-slate-600">
      Respuestas sobre el ciclo completo del pedido. Si necesitas que revisemos datos privados, usa el acceso seguro del
      pedido o inicia sesión; una referencia por sí sola no autoriza cambios.
    </p>
    <div class="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <NuxtLink
        v-for="topic in topics"
        :key="topic.title"
        :to="topic.to"
        class="rounded-2xl border border-slate-200 bg-white p-5 hover:border-neteco-300"
      >
        <UIcon :name="topic.icon" class="size-6 text-neteco-600" />
        <h2 class="mt-3 font-bold text-slate-900">{{ topic.title }}</h2>
        <p class="mt-1 text-sm text-slate-600">{{ topic.text }}</p>
      </NuxtLink>
    </div>
  </div>
</template>
