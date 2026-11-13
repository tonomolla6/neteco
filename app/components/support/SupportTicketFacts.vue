<script setup lang="ts">
import type { SupportAdminTicket, SupportCustomerTicket } from '~~/shared/support-operations'
import { supportStateLabels } from './labels'
import PublishedProductRelations from '~/components/PublishedProductRelations.vue'
/**
 * Datos de una consulta de soporte. Lo usan el panel de administración (`administrative`) y la
 * cuenta del cliente. Las clases `adm-*` solo existen dentro del panel, así que la ficha del
 * panel y la de la tienda son dos plantillas distintas sobre los mismos datos.
 */
const props = defineProps<{ snapshot: SupportAdminTicket | SupportCustomerTicket; administrative?: boolean }>()
const endpoint = computed(() => (props.administrative ? '/api/admin/support/' : '/api/account/support/'))
type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'
const stateTones: Record<string, Tone> = {
  open: 'info',
  waiting_customer: 'warning',
  waiting_provider: 'warning',
  resolved: 'success',
  closed: 'neutral'
}
const authorLabels: Record<string, string> = { anonymous: 'Visitante sin cuenta', customer: 'Cliente', admin: 'Equipo' }
const eventLabels: Record<string, string> = {
  created: 'abrió la consulta',
  update: 'actualizó la consulta',
  reply: 'respondió',
  note: 'añadió una nota',
  call: 'anotó una llamada',
  attachment: 'adjuntó un archivo'
}
const fileStates: Record<string, [string, Tone]> = {
  staging: ['Subiendo', 'neutral'],
  quarantined: ['Pendiente de revisar', 'warning'],
  clean: ['Revisado', 'success'],
  infected: ['Bloqueado por seguridad', 'danger'],
  expired: ['Caducado', 'neutral']
}
const hiddenLabels: Record<string, string> = { order: 'el pedido', payment: 'el pago', fiscal: 'la factura' }
const shortRef = (id: string) => `#${id.slice(0, 8).toUpperCase()}`
function fileSize(bytes: number) {
  return bytes >= 1048576
    ? `${(bytes / 1048576).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`
    : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('es-ES')} KB`
}
</script>
<template>
  <div v-if="administrative" class="adm-stack">
    <AdminCard :title="snapshot.subject">
      <template #actions>
        <AdminBadge :tone="stateTones[snapshot.state] ?? 'neutral'" class="whitespace-nowrap">
          {{ supportStateLabels[snapshot.state] ?? adminStatusLabel(snapshot.state) }}
        </AdminBadge>
      </template>
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt class="text-[var(--text-muted)]">Referencia</dt>
        <dd class="whitespace-nowrap font-medium text-[var(--text-strong)]">{{ snapshot.publicRef }}</dd>
        <dt class="text-[var(--text-muted)]">Abierta</dt>
        <dd class="whitespace-nowrap">{{ adminDate(snapshot.createdAt, true) }}</dd>
        <dt class="text-[var(--text-muted)]">Última novedad</dt>
        <dd class="whitespace-nowrap">{{ adminDate(snapshot.updatedAt, true) }}</dd>
        <template v-if="snapshot.nextActionAt">
          <dt class="text-[var(--text-muted)]">Siguiente paso</dt>
          <dd class="whitespace-nowrap">{{ adminDate(snapshot.nextActionAt, true) }}</dd>
        </template>
        <template v-if="snapshot.slaDueAt">
          <dt class="text-[var(--text-muted)]">Responder antes de</dt>
          <dd>
            <span class="whitespace-nowrap">{{ adminDate(snapshot.slaDueAt, true) }}</span>
            <span class="adm-help block">Es el objetivo de atención; no indica que ya se haya respondido.</span>
          </dd>
        </template>
        <template v-if="snapshot.policy?.serviceHoursDescription">
          <dt class="text-[var(--text-muted)]">Horario de atención</dt>
          <dd>{{ snapshot.policy.serviceHoursDescription }}</dd>
        </template>
        <template v-if="snapshot.policy && snapshot.retentionUntil">
          <dt class="text-[var(--text-muted)]">Se conserva hasta</dt>
          <dd class="whitespace-nowrap">{{ adminDate(snapshot.retentionUntil) }}</dd>
        </template>
      </dl>
      <div v-if="snapshot.identityStatus === 'unverified_contact' || !snapshot.policy" class="mt-4 space-y-2">
        <UAlert
          v-if="snapshot.identityStatus === 'unverified_contact'"
          color="warning"
          variant="subtle"
          icon="i-lucide-user-round-x"
          title="Contacto sin verificar"
          description="No está comprobado que el correo o el pedido que indica sean suyos. No compartas datos privados de pedidos."
        />
        <p v-if="!snapshot.policy" role="status" class="adm-help">
          Todavía no hay un plazo de respuesta ni de conservación fijado para las consultas.
        </p>
      </div>
    </AdminCard>

    <AdminCard
      v-if="snapshot.productSlug || snapshot.categorySlug"
      title="Producto por el que pregunta"
      description="Lo ha indicado el cliente; no demuestra que lo haya comprado."
      aria-label="Contexto declarado del catálogo"
    >
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <template v-if="snapshot.productSlug">
          <dt class="text-[var(--text-muted)]">Producto</dt>
          <dd>
            <a
              :href="'/producto/' + encodeURIComponent(snapshot.productSlug)"
              target="_blank"
              rel="noopener"
              class="break-words font-medium text-[var(--link)] hover:underline"
              >Ver en la tienda: {{ adminHumanize(snapshot.productSlug) }}</a
            >
          </dd>
        </template>
        <template v-if="snapshot.categorySlug">
          <dt class="text-[var(--text-muted)]">Categoría</dt>
          <dd>
            <a
              :href="'/categoria/' + encodeURIComponent(snapshot.categorySlug)"
              target="_blank"
              rel="noopener"
              class="break-words font-medium text-[var(--link)] hover:underline"
              >Ver en la tienda: {{ adminHumanize(snapshot.categorySlug) }}</a
            >
          </dd>
        </template>
      </dl>
      <PublishedProductRelations v-if="snapshot.productSlug" :product-slugs="[snapshot.productSlug]" class="mt-4" />
    </AdminCard>

    <AdminCard title="Pedido relacionado" aria-label="Contexto autorizado del pedido" :flush="!!snapshot.context.order">
      <template #actions>
        <AdminBadge v-if="snapshot.context.order" :status="snapshot.context.order.status" class="whitespace-nowrap" />
      </template>
      <template v-if="snapshot.context.order">
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-5 py-4">
          <dt class="text-[var(--text-muted)]">Pedido</dt>
          <dd class="whitespace-nowrap font-medium text-[var(--text-strong)]">
            {{ shortRef(snapshot.context.order.id) }}
          </dd>
          <dt class="text-[var(--text-muted)]">Envío</dt>
          <dd>{{ adminHumanize(snapshot.context.order.shippingMethod) }}</dd>
          <dt class="text-[var(--text-muted)]">Total</dt>
          <dd class="whitespace-nowrap tabular-nums">{{ adminMoney(snapshot.context.order.totalGrossCents) }}</dd>
        </dl>
        <div class="adm-table-wrap border-t border-[var(--border)]">
          <table class="adm-table">
            <thead>
              <tr>
                <th scope="col">Producto</th>
                <th scope="col">Referencia</th>
                <th scope="col" data-numeric>Unidades</th>
                <th scope="col" data-numeric>Importe</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="line in snapshot.context.order.lines" :key="line.index">
                <td class="min-w-40">{{ line.name }}</td>
                <td class="whitespace-nowrap">{{ line.sku }}</td>
                <td data-numeric class="whitespace-nowrap tabular-nums">{{ line.quantity }}</td>
                <td data-numeric class="whitespace-nowrap tabular-nums">{{ adminMoney(line.grossCents) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <div :class="snapshot.context.order ? 'space-y-3 border-t border-[var(--border)] px-5 py-4' : 'space-y-3'">
        <AdminEmptyState
          v-if="!snapshot.orderId"
          compact
          icon="i-lucide-receipt-text"
          title="Sin pedido vinculado"
          description="Esta consulta no está asociada a ningún pedido del cliente."
        />
        <dl
          v-if="
            snapshot.context.payment ||
            snapshot.context.fulfillment ||
            snapshot.context.fiscal ||
            snapshot.context.returns.length
          "
          class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2"
        >
          <template v-if="snapshot.context.payment">
            <dt class="text-[var(--text-muted)]">Pago</dt>
            <dd class="flex flex-wrap items-center gap-2">
              <AdminBadge :status="snapshot.context.payment.status" class="whitespace-nowrap" />
              <span class="whitespace-nowrap tabular-nums">
                {{ adminMoney(snapshot.context.payment.paidGrossCents) }} cobrados
              </span>
            </dd>
          </template>
          <template v-if="snapshot.context.fulfillment">
            <dt class="text-[var(--text-muted)]">Entrega</dt>
            <dd class="flex flex-wrap items-center gap-2">
              <AdminBadge :status="snapshot.context.fulfillment.status" class="whitespace-nowrap" />
              <span class="adm-help whitespace-nowrap">
                {{ adminDate(snapshot.context.fulfillment.updatedAt, true) }}
              </span>
            </dd>
          </template>
          <template v-for="item in snapshot.context.returns" :key="item.publicRef">
            <dt class="text-[var(--text-muted)]">Devolución</dt>
            <dd class="flex flex-wrap items-center gap-2">
              <span class="whitespace-nowrap">{{ item.publicRef }}</span>
              <AdminBadge :status="item.state" class="whitespace-nowrap" />
            </dd>
          </template>
          <template v-if="snapshot.context.fiscal">
            <dt class="text-[var(--text-muted)]">Factura</dt>
            <dd>
              <span class="flex flex-wrap items-center gap-2">
                <AdminBadge :status="snapshot.context.fiscal.status" class="whitespace-nowrap" />
                <AdminBadge v-if="snapshot.context.fiscal.validationOnly" class="whitespace-nowrap">
                  De prueba, sin emitir
                </AdminBadge>
              </span>
              <span class="adm-help block">Se consulta desde la sección de facturas, no desde aquí.</span>
            </dd>
          </template>
        </dl>
        <p v-if="snapshot.context.redacted.length" class="adm-help">
          Con tus permisos no puedes ver
          {{ snapshot.context.redacted.map((key) => hiddenLabels[key] ?? key).join(', ') }}.
        </p>
      </div>
    </AdminCard>

    <AdminCard title="Conversación" :flush="snapshot.timeline.length > 0">
      <AdminEmptyState
        v-if="!snapshot.timeline.length"
        compact
        icon="i-lucide-messages-square"
        title="Todavía no hay mensajes"
      />
      <ol v-else aria-label="Historial confirmado" class="adm-list">
        <li v-for="event in snapshot.timeline" :key="event.id">
          <div class="min-w-0 flex-1">
            <p class="adm-list__title">
              <span>
                {{ authorLabels[event.actorType] ?? 'Equipo' }}
                {{ eventLabels[event.type] ?? 'actualizó la consulta' }}
              </span>
              <AdminBadge v-if="event.visibility === 'internal'" tone="warning" class="whitespace-nowrap">
                Interno: el cliente no lo ve
              </AdminBadge>
            </p>
            <p class="adm-help whitespace-nowrap">{{ adminDate(event.createdAt, true) }}</p>
            <p v-if="event.occurredAt" class="adm-help">La llamada fue el {{ adminDate(event.occurredAt, true) }}.</p>
            <p class="mt-1 whitespace-pre-wrap break-words">
              {{ event.body ?? 'El texto ya no está disponible: ha pasado el plazo de conservación.' }}
            </p>
          </div>
        </li>
      </ol>
    </AdminCard>

    <AdminCard
      title="Archivos adjuntos"
      description="Cada archivo se revisa antes de poder descargarlo. No se publican en la tienda."
      aria-label="Adjuntos privados"
      :flush="snapshot.attachments.length > 0"
    >
      <AdminEmptyState
        v-if="!snapshot.attachments.length"
        compact
        icon="i-lucide-paperclip"
        title="Sin archivos adjuntos"
      />
      <ul v-else class="adm-list">
        <li v-for="file in snapshot.attachments" :key="file.id">
          <div class="min-w-0 flex-1">
            <p class="adm-list__title">
              <span class="break-all">{{ file.filename }}</span>
              <AdminBadge :tone="fileStates[file.state]?.[1] ?? 'neutral'" class="whitespace-nowrap">
                {{ fileStates[file.state]?.[0] ?? adminHumanize(file.state) }}
              </AdminBadge>
              <AdminBadge v-if="file.visibility === 'internal'" tone="warning" class="whitespace-nowrap">
                Interno
              </AdminBadge>
            </p>
            <p class="adm-help whitespace-nowrap">
              {{ fileSize(file.byteSize) }} · {{ adminDate(file.createdAt, true) }}
            </p>
          </div>
          <a
            v-if="file.downloadable"
            :href="endpoint + snapshot.publicRef + '/attachments/' + file.id"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            rel="noreferrer"
            >Descargar</a
          >
        </li>
      </ul>
    </AdminCard>

    <p class="adm-help">
      Desde una consulta no se hacen reembolsos, facturas, envíos ni cambios de existencias: usa la sección
      correspondiente.
    </p>
  </div>
  <div v-else class="space-y-4">
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
