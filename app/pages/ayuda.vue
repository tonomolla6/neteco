<script setup lang="ts">
import SupportKnowledgePanel from '../components/SupportKnowledgePanel.vue'
const runtime = useRuntimeConfig().public.serverRuntime
useSeoMeta({
  title: 'Centro de ayuda',
  description: 'Ayuda para comprar, pagar, recibir, facturar y devolver pedidos NETECO.'
})

/**
 * Los textos hablaban del sistema —«RMA», «Redsys alojado», «Beply termina la emisión»— en
 * vez de la pregunta que trae aquí a la gente. Un centro de ayuda se escribe con las
 * preguntas del cliente, no con los nombres de los módulos.
 */
const topics = [
  {
    icon: 'i-lucide-truck',
    title: '¿Cuándo me llega?',
    text: 'Zonas, plazos y coste del reparto propio, del envío por agencia y de la recogida en almacén.',
    to: '/envios'
  },
  {
    icon: 'i-lucide-credit-card',
    title: '¿Cómo puedo pagar?',
    text: 'Tarjeta, Bizum y transferencia. Qué pasa si el pago se queda a medias.',
    to: '/formas-de-pago'
  },
  {
    icon: 'i-lucide-rotate-ccw',
    title: 'Quiero devolver algo',
    text: 'Plazos, qué se puede devolver y cómo pedir la recogida desde tu pedido.',
    to: '/devoluciones'
  },
  {
    icon: 'i-lucide-user-round',
    title: 'Mi cuenta',
    text: 'Direcciones de entrega, contraseña, dispositivos conectados y qué correos recibes.',
    to: '/cuenta'
  },
  {
    icon: 'i-lucide-receipt-text',
    title: 'Mis facturas',
    text: 'Dónde descargarlas y qué hacer si falta alguna o los datos fiscales no son correctos.',
    to: '/cuenta/pedidos'
  },
  {
    icon: 'i-lucide-life-buoy',
    title: 'Hablar con alguien',
    text: 'Escríbenos indicando el pedido o el producto y te damos una referencia para seguirlo.',
    to: '/contacto'
  }
]
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-10">
    <h1 class="text-3xl font-bold text-slate-950">Centro de ayuda</h1>
    <p class="mt-2 max-w-2xl text-slate-600">
      Lo que más nos preguntáis. Si no encuentras tu caso, llámanos al
      <a href="tel:600861334" class="font-medium text-neteco-700 hover:underline">600 861 334</a>: hablas con una
      persona que conoce tu pedido.
    </p>
    <SupportKnowledgePanel v-if="runtime === 'cloudflare'" :runtime="runtime" class="mt-8" />
    <div class="mt-8 grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
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
