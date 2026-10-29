<script setup lang="ts">
import type { SupportAdminTicket, SupportCustomerTicket } from '~~/shared/support-operations'
import { supportStateLabels } from './labels'
import PublishedProductRelations from '~/components/PublishedProductRelations.vue'
const props = defineProps<{ snapshot: SupportAdminTicket | SupportCustomerTicket; administrative?: boolean }>()
const endpoint = computed(() => (props.administrative ? '/api/admin/support/' : '/api/account/support/'))
</script>
<template>
  <div class="space-y-4">
    <p>{{ snapshot.publicRef }} · {{ supportStateLabels[snapshot.state] }} · Versión {{ snapshot.version }}</p>
    <h3 class="font-semibold">{{ snapshot.subject }}</h3>
    <p v-if="snapshot.identityStatus === 'unverified_contact'" class="rounded border p-3">
      Contacto no verificado: el correo y la referencia declarada no acreditan pedidos ni identidad. No compartas datos
      privados de pedidos.
    </p>
    <p v-if="!snapshot.policy" role="status">
      Política de atención y conservación pendiente de revisión; no se ha fijado un SLA ni un plazo de retención.
    </p>
    <p v-else>
      Política {{ snapshot.policy.reference }} v{{ snapshot.policy.version }} · Límite de acceso operativo
      {{ snapshot.retentionUntil
      }}<span v-if="snapshot.policy.serviceHoursDescription"> · {{ snapshot.policy.serviceHoursDescription }}</span>
    </p>
    <p v-if="snapshot.nextActionAt">Siguiente acción: {{ snapshot.nextActionAt }}</p>
    <p v-if="snapshot.slaDueAt">
      Objetivo de atención documentado: {{ snapshot.slaDueAt }}. No confirma una respuesta enviada.
    </p>
    <section
      v-if="snapshot.productSlug || snapshot.categorySlug"
      aria-label="Contexto declarado del catálogo"
      class="rounded border p-3"
    >
      <p>Referencias de catálogo declaradas en la consulta; no acreditan una compra ni asesoramiento técnico.</p>
      <p v-if="snapshot.productSlug">
        Producto:
        <a :href="'/producto/' + encodeURIComponent(snapshot.productSlug)" class="break-words underline">{{
          snapshot.productSlug
        }}</a>
      </p>
      <p v-if="snapshot.categorySlug">
        Categoría:
        <a :href="'/categoria/' + encodeURIComponent(snapshot.categorySlug)" class="break-words underline">{{
          snapshot.categorySlug
        }}</a>
      </p>
    </section>
    <PublishedProductRelations v-if="snapshot.productSlug" :product-slugs="[snapshot.productSlug]" />
    <section aria-label="Contexto autorizado del pedido" class="rounded border p-3">
      <p v-if="snapshot.context.redacted.length">
        Contexto restringido por permisos: {{ snapshot.context.redacted.join(', ') }}.
      </p>
      <template v-if="snapshot.context.order">
        <p>
          Pedido {{ snapshot.context.order.id }} · {{ snapshot.context.order.status }} ·
          {{ snapshot.context.order.shippingMethod }}
        </p>
        <ul>
          <li v-for="line in snapshot.context.order.lines" :key="line.index">
            {{ line.name }} · {{ line.sku }} · {{ line.quantity }} unidades
          </li>
        </ul>
      </template>
      <p v-if="snapshot.context.payment">
        Pago histórico: {{ snapshot.context.payment.status }} · {{ snapshot.context.payment.paidGrossCents }} céntimos
        {{ snapshot.context.order?.currency }}
      </p>
      <p v-if="snapshot.context.fulfillment">
        Entrega: {{ snapshot.context.fulfillment.status }} · {{ snapshot.context.fulfillment.updatedAt }}
      </p>
      <ul v-if="snapshot.context.returns.length">
        <li v-for="item in snapshot.context.returns" :key="item.publicRef">
          Devolución {{ item.publicRef }} · {{ item.state }}
        </li>
      </ul>
      <p v-if="snapshot.context.fiscal">
        Documento fiscal: {{ snapshot.context.fiscal.status
        }}<span v-if="snapshot.context.fiscal.validationOnly"> · Validación, no emisión real</span>. Acceso mediante el
        portal fiscal autorizado, no desde este ticket.
      </p>
      <p v-if="!snapshot.orderId">Consulta sin vínculo de propiedad a un pedido.</p>
    </section>
    <ol aria-label="Historial confirmado" class="space-y-2">
      <li v-for="event in snapshot.timeline" :key="event.id" class="rounded border p-3">
        <p>
          {{ event.createdAt }} · {{ event.actorType }} · {{ event.type }}
          <span v-if="event.visibility === 'internal'"> · INTERNO — no visible para el cliente</span>
        </p>
        <p v-if="event.occurredAt">Llamada anotada: {{ event.occurredAt }} (no realiza una llamada).</p>
        <p class="whitespace-pre-wrap">
          {{ event.body ?? 'Contenido no disponible según la política de conservación.' }}
        </p>
      </li>
    </ol>
    <section aria-label="Adjuntos privados">
      <p>Los archivos requieren cuarentena y recibo de un escáner autorizado. No se publican en el catálogo.</p>
      <ul>
        <li v-for="file in snapshot.attachments" :key="file.id">
          {{ file.filename }} · {{ file.byteSize }} bytes · {{ file.state
          }}<span v-if="file.visibility === 'internal'"> · interno</span>
          <a
            v-if="file.downloadable"
            :href="endpoint + snapshot.publicRef + '/attachments/' + file.id"
            class="underline"
            rel="noreferrer"
            >Descargar por acceso privado</a
          >
        </li>
      </ul>
    </section>
    <p class="text-sm">Esta atención no autoriza reembolsos, facturas, transportistas ni movimientos de stock.</p>
  </div>
</template>
