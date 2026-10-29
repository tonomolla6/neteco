<script setup lang="ts">
import {
  customer360ListSchema,
  customer360Schema,
  type Customer360,
  type Customer360List
} from '~~/shared/customer-360'
const props = defineProps<{ scopeKey: string; enabled: boolean }>()
const request = useRequestFetch()
const query = ref(''),
  picker = ref<Customer360List | null>(null),
  context = ref<Customer360 | null>(null),
  selectedId = ref<string | null>(null)
const loading = ref(false),
  revoked = ref(false),
  message = ref('')
const ordersPage = ref(1),
  ticketsPage = ref(1),
  invoicesPage = ref(1)
let epoch = 0,
  alive = true,
  controller: AbortController | null = null
const active = computed(() => props.enabled && !revoked.value)
function purge() {
  epoch++
  controller?.abort()
  controller = null
  query.value = ''
  picker.value = null
  context.value = null
  selectedId.value = null
  loading.value = false
  ordersPage.value = 1
  ticketsPage.value = 1
  invoicesPage.value = 1
  message.value = ''
}
watch(
  () => [props.scopeKey, props.enabled],
  () => {
    purge()
    revoked.value = false
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  purge()
})
function current(generation: number) {
  return alive && generation === epoch && active.value
}
function begin() {
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  message.value = ''
  return epoch
}
function failure(error: unknown, generation: number) {
  if (!current(generation)) return
  const e = error as { statusCode?: number; status?: number; response?: { status?: number } }
  const code = e?.statusCode ?? e?.status ?? e?.response?.status
  if (code === 401 || code === 403) {
    purge()
    revoked.value = true
    message.value = 'La autorización ha cambiado. Se han retirado los datos privados.'
  } else message.value = 'No se ha podido confirmar la consulta. No se muestran datos anteriores.'
}
async function search(targetPage = 1) {
  if (!active.value || loading.value) return
  const generation = begin()
  picker.value = null
  context.value = null
  selectedId.value = null
  try {
    const dto = customer360ListSchema.parse(
      await request('/api/admin/customer-context', {
        query: { q: query.value.trim(), page: targetPage, perPage: 25 },
        signal: controller!.signal
      })
    )
    if (current(generation)) picker.value = dto
  } catch (error) {
    failure(error, generation)
  } finally {
    if (current(generation)) loading.value = false
  }
}
async function load(customerId: string, reset = false) {
  if (!active.value || loading.value) return
  if (reset) {
    ordersPage.value = 1
    ticketsPage.value = 1
    invoicesPage.value = 1
  }
  const generation = begin()
  context.value = null
  selectedId.value = customerId
  try {
    const dto = customer360Schema.parse(
      await request(`/api/admin/customer-context/${customerId}`, {
        query: {
          ordersPage: ordersPage.value,
          ticketsPage: ticketsPage.value,
          invoicesPage: invoicesPage.value,
          perPage: 25
        },
        signal: controller!.signal
      })
    )
    if (dto.customer.id !== customerId) throw new Error('identity')
    if (current(generation)) context.value = dto
  } catch (error) {
    failure(error, generation)
  } finally {
    if (current(generation)) loading.value = false
  }
}
function sectionPage(section: 'orders' | 'tickets' | 'invoices', delta: number) {
  if (!context.value || !selectedId.value || loading.value) return
  const data = context.value[section]
  if (data.visibility !== 'visible') return
  const next = data.data.page + delta
  if (next < 1 || next > data.data.pages) return
  if (section === 'orders') ordersPage.value = next
  else if (section === 'tickets') ticketsPage.value = next
  else invoicesPage.value = next
  return load(selectedId.value)
}
const money = (value: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value / 100)
function date(value: string) {
  return (
    new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value)
    ) + ' UTC'
  )
}
const choices = computed(() =>
  context.value?.consent.visibility === 'visible'
    ? [
        { label: 'Avisos de productos', ...context.value.consent.data.productUpdates },
        { label: 'Reposición', ...context.value.consent.data.replenishment },
        { label: 'Preparación y entrega', ...context.value.consent.data.deliveryUpdates }
      ]
    : []
)
</script>
<template>
  <section aria-label="Vista cliente 360" class="min-w-0 space-y-5 rounded-lg border p-4">
    <h2 class="text-xl font-semibold">Contexto de cliente 360</h2>
    <p>Consulta de fuentes actuales. No modifica pedidos, cobros, facturas, consentimientos ni incidencias.</p>
    <p v-if="!active" role="status">No hay autorización vigente para consultar datos privados.</p>
    <template v-else>
      <form data-customer-search class="flex flex-wrap items-end gap-3" @submit.prevent="search(1)">
        <label class="min-w-0 flex-1"
          >Nombre o referencia de cliente
          <input
            v-model="query"
            data-customer-query
            maxlength="80"
            :disabled="loading"
            class="block w-full"
            autocomplete="off" /></label
        ><button type="submit" :disabled="loading">Buscar clientes</button>
      </form>
      <div v-if="picker" class="space-y-3">
        <p v-if="!picker.items.length">No hay clientes coincidentes.</p>
        <ul class="space-y-2">
          <li v-for="item in picker.items" :key="item.id">
            <button
              type="button"
              :data-customer-select="item.id"
              :disabled="loading"
              class="max-w-full break-words text-left underline"
              @click="load(item.id, true)"
            >
              {{ item.name ?? 'Cliente sin nombre registrado' }} · {{ item.id }} ·
              {{ item.status === 'blocked' ? 'Bloqueado' : 'Activo' }}
            </button>
          </li>
        </ul>
        <nav v-if="picker.pages > 1" aria-label="Páginas de clientes" class="flex flex-wrap gap-3">
          <button type="button" :disabled="loading || picker.page <= 1" @click="search(picker.page - 1)">
            Clientes anteriores</button
          ><span>{{ picker.page }} / {{ picker.pages }}</span
          ><button type="button" :disabled="loading || picker.page >= picker.pages" @click="search(picker.page + 1)">
            Clientes siguientes
          </button>
        </nav>
      </div>
      <button v-if="selectedId" data-customer-refresh type="button" :disabled="loading" @click="load(selectedId)">
        Actualizar contexto del cliente
      </button>
      <div v-if="context" class="space-y-5 break-words" aria-live="polite">
        <header>
          <h3 class="text-lg font-semibold">{{ context.customer.name ?? 'Cliente sin nombre registrado' }}</h3>
          <p>
            {{ context.customer.id }} ·
            {{ context.customer.status === 'blocked' ? 'Cuenta bloqueada' : 'Cuenta activa' }}
          </p>
          <p>
            Consulta confirmada: <time :datetime="context.evaluatedAt">{{ date(context.evaluatedAt) }}</time>
          </p>
        </header>
        <section aria-label="Pedidos del cliente">
          <h4 class="font-semibold">Pedidos</h4>
          <p v-if="context.orders.visibility === 'redacted'">Pedidos: ocultos por permisos</p>
          <template v-else
            ><p>Pedidos: {{ context.orders.data.total }}</p>
            <ul class="space-y-2">
              <li v-for="order in context.orders.data.items" :key="order.id">
                {{ order.id }} · {{ order.status }} · {{ order.shippingMethod ?? 'Sin método registrado' }} ·
                <time :datetime="order.createdAt">{{ date(order.createdAt) }}</time>
              </li>
            </ul>
            <nav v-if="context.orders.data.pages > 1" aria-label="Páginas de pedidos" class="flex flex-wrap gap-3">
              <button
                type="button"
                :disabled="loading || context.orders.data.page <= 1"
                @click="sectionPage('orders', -1)"
              >
                Pedidos anteriores</button
              ><span>{{ context.orders.data.page }} / {{ context.orders.data.pages }}</span
              ><button
                type="button"
                :disabled="loading || context.orders.data.page >= context.orders.data.pages"
                @click="sectionPage('orders', 1)"
              >
                Pedidos siguientes
              </button>
            </nav></template
          >
        </section>
        <section aria-label="Incidencias del cliente">
          <h4 class="font-semibold">Incidencias</h4>
          <p v-if="context.tickets.visibility === 'redacted'">Incidencias: ocultas por permisos</p>
          <template v-else
            ><p>Incidencias: {{ context.tickets.data.total }}</p>
            <ul class="space-y-2">
              <li v-for="ticket in context.tickets.data.items" :key="ticket.publicRef">
                {{ ticket.publicRef }} · {{ ticket.category }} · {{ ticket.state }} · Prioridad {{ ticket.priority }} ·
                {{ ticket.ownerAssigned ? 'Responsable asignado' : 'Sin responsable asignado'
                }}<span v-if="ticket.nextActionAt"> · Seguimiento: {{ date(ticket.nextActionAt) }}</span>
              </li>
            </ul>
            <nav v-if="context.tickets.data.pages > 1" aria-label="Páginas de incidencias" class="flex flex-wrap gap-3">
              <button
                type="button"
                :disabled="loading || context.tickets.data.page <= 1"
                @click="sectionPage('tickets', -1)"
              >
                Incidencias anteriores</button
              ><span>{{ context.tickets.data.page }} / {{ context.tickets.data.pages }}</span
              ><button
                type="button"
                :disabled="loading || context.tickets.data.page >= context.tickets.data.pages"
                @click="sectionPage('tickets', 1)"
              >
                Incidencias siguientes
              </button>
            </nav></template
          >
        </section>
        <section aria-label="Facturas del cliente">
          <h4 class="font-semibold">Facturas</h4>
          <p v-if="context.invoices.visibility === 'redacted'">Facturas: ocultas por permisos</p>
          <template v-else
            ><p>Facturas: {{ context.invoices.data.total }}</p>
            <ul class="space-y-2">
              <li v-for="invoice in context.invoices.data.items" :key="invoice.orderId">
                Pedido {{ invoice.orderId }} · {{ invoice.status }} · {{ money(invoice.grossCents)
                }}<strong v-if="invoice.validationOnly"> · Validación local, no factura real emitida</strong>
              </li>
            </ul>
            <nav v-if="context.invoices.data.pages > 1" aria-label="Páginas de facturas" class="flex flex-wrap gap-3">
              <button
                type="button"
                :disabled="loading || context.invoices.data.page <= 1"
                @click="sectionPage('invoices', -1)"
              >
                Facturas anteriores</button
              ><span>{{ context.invoices.data.page }} / {{ context.invoices.data.pages }}</span
              ><button
                type="button"
                :disabled="loading || context.invoices.data.page >= context.invoices.data.pages"
                @click="sectionPage('invoices', 1)"
              >
                Facturas siguientes
              </button>
            </nav></template
          >
        </section>
        <section aria-label="Valor financiero del cliente">
          <h4 class="font-semibold">Valor financiero</h4>
          <p v-if="context.value.visibility === 'redacted'">Valor financiero: oculto por permisos</p>
          <dl v-else class="grid gap-2 sm:grid-cols-2">
            <dt>Cobros canónicos confirmados</dt>
            <dd>{{ money(context.value.data.paidGrossCents) }} · {{ context.value.data.paidOrderCount }} pedidos</dd>
            <dt>Devoluciones monetarias confirmadas</dt>
            <dd>{{ money(context.value.data.settledRefundGrossCents) }}</dd>
            <dt>Neto cobrado tras devoluciones</dt>
            <dd>{{ money(context.value.data.netCollectedGrossCents) }}</dd>
            <dt>Devoluciones de validación local (no descontadas como reales)</dt>
            <dd>{{ money(context.value.data.validationRefundGrossCents) }}</dd>
          </dl>
        </section>
        <section aria-label="Consentimientos y preferencias">
          <h4 class="font-semibold">Consentimientos y preferencias</h4>
          <p v-if="context.consent.visibility === 'redacted'">Consentimientos: ocultos por permisos</p>
          <template v-else
            ><ul>
              <li v-for="choice in choices" :key="choice.label">
                {{ choice.label }}: {{ choice.value ? 'Activado' : 'Desactivado' }} ·
                {{
                  choice.basis === 'default'
                    ? 'Valor por defecto, sin elección registrada'
                    : `Elección registrada v${choice.version}`
                }}<span v-if="choice.updatedAt"> · {{ date(choice.updatedAt) }}</span>
              </li>
            </ul>
            <p>
              Newsletter: desconocido; no hay vínculo de identidad verificable. No se infiere consentimiento por el
              correo.
            </p></template
          >
        </section>
        <section aria-label="Próxima acción">
          <h4 class="font-semibold">Próxima acción</h4>
          <p v-if="context.nextAction.visibility === 'redacted'">Próxima acción: oculta por permisos</p>
          <p v-else-if="context.nextAction.data">
            Seguimiento de {{ context.nextAction.data.ticketRef }}: {{ date(context.nextAction.data.dueAt) }} ·
            {{ context.nextAction.data.ownerAssigned ? 'Responsable asignado' : 'Sin responsable asignado' }}
          </p>
          <p v-else>Sin próxima acción registrada</p>
        </section>
      </div>
    </template>
    <p v-if="loading" role="status">Comprobando contexto…</p>
    <p v-if="message" role="status" aria-live="polite">{{ message }}</p>
  </section>
</template>
