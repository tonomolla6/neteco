<script setup lang="ts">
import type { AdminServiceKey } from '~~/shared/admin-settings'

/**
 * Envuelve una pantalla que depende de un servicio opcional de la tienda. Si el servicio
 * está apagado en este entorno, en vez de dejar que la pantalla falle y enseñe un error,
 * explica qué es, que no está activado y dónde se ve su estado.
 */
const props = defineProps<{
  service: AdminServiceKey
  /** Sustituyen al texto por defecto del servicio. */
  title?: string
  description?: string
  icon?: string
}>()
const COPY: Record<AdminServiceKey, { title: string; description: string; icon: string }> = {
  support: {
    title: 'La atención al cliente no está activada',
    description:
      'Cuando se active, aquí llegarán las consultas que los clientes envían desde la tienda y podrás responderlas, asignarlas y seguir su estado.',
    icon: 'i-lucide-life-buoy'
  },
  supportAttachments: {
    title: 'Los adjuntos de las consultas no están activados',
    description: 'Cuando se activen, los clientes podrán enviar fotos y documentos con sus consultas.',
    icon: 'i-lucide-paperclip'
  },
  analytics: {
    title: 'La analítica no está activada',
    description:
      'Cuando se active, aquí verás visitas, conversión, ventas y búsquedas de la tienda. Mientras tanto, las ventas y los pedidos recientes están en Inicio.',
    icon: 'i-lucide-chart-no-axes-combined'
  },
  newsletter: {
    title: 'El boletín no está activado',
    description:
      'Cuando se active, los clientes podrán suscribirse desde la tienda y aquí podrás preparar y enviar campañas.',
    icon: 'i-lucide-mail'
  },
  newsletterEditorial: {
    title: 'La redacción de campañas no está activada',
    description: 'Cuando se active, aquí podrás preparar y revisar las campañas del boletín antes de enviarlas.',
    icon: 'i-lucide-mail'
  },
  quotes: {
    title: 'Los presupuestos no están activados',
    description: 'Cuando se activen, aquí podrás preparar ofertas para clientes y convertirlas en pedido.',
    icon: 'i-lucide-file-check-2'
  },
  reviews: {
    title: 'Las reseñas y preguntas no están activadas',
    description: 'Cuando se activen, aquí podrás moderar las reseñas y responder a las preguntas de los clientes.',
    icon: 'i-lucide-message-square-text'
  },
  media: {
    title: 'La biblioteca de imágenes no está activada',
    description: 'Cuando se active, aquí podrás subir y publicar imágenes y documentos del catálogo.',
    icon: 'i-lucide-images'
  },
  content: {
    title: 'La publicación de contenido no está activada',
    description: 'Cuando se active, aquí podrás publicar páginas y artículos en la tienda.',
    icon: 'i-lucide-file-text'
  },
  publicApi: {
    title: 'La API para clientes no está activada',
    description:
      'Cuando se active, aquí podrás crear y revocar las claves con las que otros sistemas consultan la tienda.',
    icon: 'i-lucide-key-round'
  }
}
const { available, status, settings, serviceOff } = useAdminSettings()
const waiting = computed(() => available && (status.value === 'idle' || status.value === 'pending'))
const off = computed(() => serviceOff(props.service))
const copy = computed(() => COPY[props.service])
</script>

<template>
  <div v-if="waiting" class="adm-card" aria-busy="true">
    <div class="adm-table-skeleton">
      <span class="sr-only">Cargando…</span>
      <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
    </div>
  </div>
  <AdminCard v-else-if="off" data-admin-service-off>
    <AdminEmptyState
      :icon="icon ?? copy.icon"
      :title="title ?? copy.title"
      :description="description ?? copy.description"
    >
      <AdminButton to="/admin/ajustes#funciones" icon="i-lucide-settings">Ver funciones de la tienda</AdminButton>
    </AdminEmptyState>
    <p class="adm-help mx-auto max-w-xl pb-2 text-center">
      {{
        settings?.demo
          ? 'En esta demostración pública la función está apagada a propósito: no se envían correos ni se guardan datos reales.'
          : 'Se activa en la configuración del entorno de la tienda.'
      }}
    </p>
  </AdminCard>
  <slot v-else />
</template>
