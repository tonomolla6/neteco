<script setup lang="ts">
import {
  customer360ListSchema,
  customer360Schema,
  type Customer360,
  type Customer360List
} from '~~/shared/customer-360'
import { supportCategoryLabels, supportPriorityLabels, supportStateLabels } from './support/labels'
import type { AdminTone } from '~/utils/adminLabels'
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
    message.value = 'Tu sesión o tus permisos han cambiado. Se han ocultado los datos del cliente.'
  } else message.value = 'No se ha podido cargar la información del cliente. Vuelve a intentarlo.'
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
const choices = computed(() =>
  context.value?.consent.visibility === 'visible'
    ? [
        { label: 'Avisos de productos', ...context.value.consent.data.productUpdates },
        { label: 'Avisos de reposición', ...context.value.consent.data.replenishment },
        { label: 'Preparación y entrega', ...context.value.consent.data.deliveryUpdates }
      ]
    : []
)
/* --- Estado de interfaz y etiquetas --- */
const pickerOpen = ref(false)
watch(picker, (value) => {
  if (value) pickerOpen.value = true
})
function choose(customerId: string) {
  pickerOpen.value = false
  void load(customerId, true)
}
const shortId = (id: string) => `#${id.slice(0, 8).toUpperCase()}`
const shippingLabels: Record<string, string> = {
  pickup: 'Recogida en tienda',
  own_delivery: 'Reparto propio',
  parcel: 'Paquetería'
}
const shippingLabel = (method: string | null) => (method ? (shippingLabels[method] ?? adminHumanize(method)) : '—')
const ticketTones: Record<string, AdminTone> = {
  open: 'warning',
  waiting_customer: 'info',
  waiting_provider: 'info',
  resolved: 'success',
  closed: 'neutral'
}
/** Permite llegar desde el listado de empresas con la búsqueda ya escrita; no consulta nada por sí sola. */
const route = useRoute()
onMounted(() => {
  const preset = route.query.q
  if (typeof preset === 'string' && active.value && !query.value) query.value = preset.slice(0, 80)
})
</script>
<template>
  <section aria-label="Vista cliente 360" class="adm-stack min-w-0">
    <UAlert
      v-if="!active"
      role="status"
      color="warning"
      variant="subtle"
      icon="i-lucide-lock"
      title="No puedes consultar fichas de cliente con esta sesión"
      description="Hace falta el correo verificado, la verificación en dos pasos y permiso de atención al cliente o de administración."
    />
    <template v-else>
      <div class="adm-card adm-tablecard">
        <div class="adm-tablecard__bar">
          <form data-customer-search class="adm-toolbar" role="search" @submit.prevent="search(1)">
            <label class="adm-toolbar__search">
              <span class="sr-only">Nombre o referencia de cliente</span>
              <UIcon name="i-lucide-search" class="size-4" />
              <input
                v-model="query"
                data-customer-query
                type="search"
                maxlength="80"
                placeholder="Nombre o referencia de cliente"
                :disabled="loading"
                autocomplete="off"
              />
            </label>
            <button type="submit" :disabled="loading" class="adm-btn adm-btn--secondary">Buscar clientes</button>
            <button
              v-if="picker && selectedId && !pickerOpen"
              type="button"
              class="adm-btn adm-btn--ghost"
              @click="pickerOpen = true"
            >
              Cambiar de cliente
            </button>
            <div v-if="selectedId" class="adm-toolbar__end">
              <button
                data-customer-refresh
                type="button"
                :disabled="loading"
                class="adm-btn adm-btn--secondary"
                @click="load(selectedId)"
              >
                <UIcon name="i-lucide-rotate-cw" class="size-4" />Actualizar
              </button>
            </div>
          </form>
        </div>
        <template v-if="picker && pickerOpen">
          <AdminEmptyState
            v-if="!picker.items.length"
            variant="filtered"
            compact
            title="Ningún cliente coincide"
            description="Prueba con otro nombre o con la referencia del cliente."
          />
          <ul v-else class="adm-list">
            <li v-for="item in picker.items" :key="item.id">
              <button
                type="button"
                :data-customer-select="item.id"
                :disabled="loading"
                class="min-w-0 flex-1 break-words text-left font-semibold text-[var(--text-strong)] hover:underline"
                @click="choose(item.id)"
              >
                {{ item.name ?? 'Cliente sin nombre' }}
                <span class="ml-1 text-xs font-normal text-[var(--text-muted)]">{{ shortId(item.id) }}</span>
              </button>
              <AdminBadge :tone="item.status === 'blocked' ? 'danger' : 'success'">
                {{ item.status === 'blocked' ? 'Bloqueado' : 'Activo' }}
              </AdminBadge>
            </li>
          </ul>
          <nav v-if="picker.pages > 1" aria-label="Páginas de clientes" class="adm-pagination">
            <p>Página {{ picker.page }} de {{ picker.pages }}</p>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="loading || picker.page <= 1"
                @click="search(picker.page - 1)"
              >
                Anteriores
              </button>
              <button
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="loading || picker.page >= picker.pages"
                @click="search(picker.page + 1)"
              >
                Siguientes
              </button>
            </div>
          </nav>
        </template>
        <AdminEmptyState
          v-else-if="!selectedId && !loading && !message"
          compact
          icon="i-lucide-user-search"
          title="Busca un cliente para ver su ficha"
          description="Verás sus pedidos, incidencias, facturas y preferencias. Desde aquí no se modifica nada."
        />
      </div>

      <div v-if="context" class="adm-stack break-words" aria-live="polite">
        <header class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 class="text-lg font-semibold text-[var(--text-strong)]">
            {{ context.customer.name ?? 'Cliente sin nombre' }}
          </h2>
          <AdminBadge :tone="context.customer.status === 'blocked' ? 'danger' : 'success'">
            {{ context.customer.status === 'blocked' ? 'Cuenta bloqueada' : 'Cuenta activa' }}
          </AdminBadge>
          <span class="adm-help">
            {{ shortId(context.customer.id) }} · Datos de
            <time :datetime="context.evaluatedAt">{{ adminDate(context.evaluatedAt, true) }}</time>
          </span>
        </header>

        <section aria-label="Valor financiero del cliente">
          <p v-if="context.value.visibility === 'redacted'" class="adm-help">Valor financiero: oculto por permisos</p>
          <div v-else class="adm-grid">
            <AdminStat
              label="Cobrado"
              :value="adminMoney(context.value.data.paidGrossCents)"
              :hint="`${context.value.data.paidOrderCount} ${context.value.data.paidOrderCount === 1 ? 'pedido pagado' : 'pedidos pagados'}`"
            />
            <AdminStat label="Devuelto" :value="adminMoney(context.value.data.settledRefundGrossCents)" />
            <AdminStat
              label="Neto cobrado"
              :value="adminMoney(context.value.data.netCollectedGrossCents)"
              hint="Cobros menos devoluciones"
            />
            <AdminStat
              v-if="context.value.data.validationRefundGrossCents"
              label="Devoluciones de prueba"
              :value="adminMoney(context.value.data.validationRefundGrossCents)"
              hint="No se descuentan: no son reales"
            />
          </div>
        </section>

        <div class="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div class="adm-stack min-w-0">
            <AdminCard
              title="Pedidos recientes"
              :description="
                context.orders.visibility === 'visible' ? `${context.orders.data.total} en total` : undefined
              "
              flush
              aria-label="Pedidos del cliente"
            >
              <p v-if="context.orders.visibility === 'redacted'" class="adm-help p-5">Pedidos: ocultos por permisos</p>
              <AdminEmptyState
                v-else-if="!context.orders.data.items.length"
                compact
                icon="i-lucide-package"
                title="Sin pedidos"
              />
              <template v-else>
                <div class="adm-table-wrap">
                  <table class="adm-table">
                    <thead>
                      <tr>
                        <th scope="col">Pedido</th>
                        <th scope="col">Fecha</th>
                        <th scope="col">Estado</th>
                        <th scope="col">Entrega</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="order in context.orders.data.items" :key="order.id">
                        <td class="font-semibold tabular-nums text-[var(--text-strong)]">{{ shortId(order.id) }}</td>
                        <td class="whitespace-nowrap">
                          <time :datetime="order.createdAt">{{ adminDate(order.createdAt, true) }}</time>
                        </td>
                        <td><AdminBadge :status="order.status" /></td>
                        <td>{{ shippingLabel(order.shippingMethod) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <nav v-if="context.orders.data.pages > 1" aria-label="Páginas de pedidos" class="adm-pagination">
                  <p>Página {{ context.orders.data.page }} de {{ context.orders.data.pages }}</p>
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="adm-btn adm-btn--secondary adm-btn--sm"
                      :disabled="loading || context.orders.data.page <= 1"
                      @click="sectionPage('orders', -1)"
                    >
                      Anteriores
                    </button>
                    <button
                      type="button"
                      class="adm-btn adm-btn--secondary adm-btn--sm"
                      :disabled="loading || context.orders.data.page >= context.orders.data.pages"
                      @click="sectionPage('orders', 1)"
                    >
                      Siguientes
                    </button>
                  </div>
                </nav>
              </template>
            </AdminCard>

            <AdminCard
              title="Incidencias"
              :description="
                context.tickets.visibility === 'visible' ? `${context.tickets.data.total} en total` : undefined
              "
              flush
              aria-label="Incidencias del cliente"
            >
              <p v-if="context.tickets.visibility === 'redacted'" class="adm-help p-5">
                Incidencias: ocultas por permisos
              </p>
              <AdminEmptyState
                v-else-if="!context.tickets.data.items.length"
                compact
                icon="i-lucide-life-buoy"
                title="Sin incidencias"
              />
              <template v-else>
                <div class="adm-table-wrap">
                  <table class="adm-table">
                    <thead>
                      <tr>
                        <th scope="col">Consulta</th>
                        <th scope="col">Estado</th>
                        <th scope="col">Prioridad</th>
                        <th scope="col">Seguimiento</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="ticket in context.tickets.data.items" :key="ticket.publicRef">
                        <td>
                          <p class="font-semibold text-[var(--text-strong)]">{{ ticket.publicRef }}</p>
                          <p class="text-xs text-[var(--text-muted)]">
                            {{ supportCategoryLabels[ticket.category] ?? adminHumanize(ticket.category) }}
                          </p>
                        </td>
                        <td>
                          <AdminBadge :tone="ticketTones[ticket.state] ?? 'neutral'">
                            {{ supportStateLabels[ticket.state] ?? adminStatusLabel(ticket.state) }}
                          </AdminBadge>
                        </td>
                        <td>{{ supportPriorityLabels[ticket.priority] ?? adminStatusLabel(ticket.priority) }}</td>
                        <td>
                          <template v-if="ticket.nextActionAt">{{ adminDate(ticket.nextActionAt, true) }} · </template
                          >{{ ticket.ownerAssigned ? 'Con responsable' : 'Sin responsable' }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <nav v-if="context.tickets.data.pages > 1" aria-label="Páginas de incidencias" class="adm-pagination">
                  <p>Página {{ context.tickets.data.page }} de {{ context.tickets.data.pages }}</p>
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="adm-btn adm-btn--secondary adm-btn--sm"
                      :disabled="loading || context.tickets.data.page <= 1"
                      @click="sectionPage('tickets', -1)"
                    >
                      Anteriores
                    </button>
                    <button
                      type="button"
                      class="adm-btn adm-btn--secondary adm-btn--sm"
                      :disabled="loading || context.tickets.data.page >= context.tickets.data.pages"
                      @click="sectionPage('tickets', 1)"
                    >
                      Siguientes
                    </button>
                  </div>
                </nav>
              </template>
            </AdminCard>

            <AdminCard
              title="Facturas"
              :description="
                context.invoices.visibility === 'visible' ? `${context.invoices.data.total} en total` : undefined
              "
              flush
              aria-label="Facturas del cliente"
            >
              <p v-if="context.invoices.visibility === 'redacted'" class="adm-help p-5">
                Facturas: ocultas por permisos
              </p>
              <AdminEmptyState
                v-else-if="!context.invoices.data.items.length"
                compact
                icon="i-lucide-receipt-text"
                title="Sin facturas"
              />
              <template v-else>
                <div class="adm-table-wrap">
                  <table class="adm-table">
                    <thead>
                      <tr>
                        <th scope="col">Pedido</th>
                        <th scope="col">Estado</th>
                        <th scope="col" data-numeric>Importe</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="invoice in context.invoices.data.items" :key="invoice.orderId">
                        <td class="font-semibold tabular-nums text-[var(--text-strong)]">
                          {{ shortId(invoice.orderId) }}
                        </td>
                        <td>
                          <AdminBadge :status="invoice.status" />
                          <AdminBadge v-if="invoice.validationOnly" tone="warning" plain class="ml-1">
                            De prueba, no emitida
                          </AdminBadge>
                        </td>
                        <td data-numeric>{{ adminMoney(invoice.grossCents) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <nav v-if="context.invoices.data.pages > 1" aria-label="Páginas de facturas" class="adm-pagination">
                  <p>Página {{ context.invoices.data.page }} de {{ context.invoices.data.pages }}</p>
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="adm-btn adm-btn--secondary adm-btn--sm"
                      :disabled="loading || context.invoices.data.page <= 1"
                      @click="sectionPage('invoices', -1)"
                    >
                      Anteriores
                    </button>
                    <button
                      type="button"
                      class="adm-btn adm-btn--secondary adm-btn--sm"
                      :disabled="loading || context.invoices.data.page >= context.invoices.data.pages"
                      @click="sectionPage('invoices', 1)"
                    >
                      Siguientes
                    </button>
                  </div>
                </nav>
              </template>
            </AdminCard>
          </div>

          <div class="adm-stack min-w-0">
            <AdminCard title="Próximo seguimiento" aria-label="Próxima acción">
              <p v-if="context.nextAction.visibility === 'redacted'" class="adm-help">
                Próxima acción: oculta por permisos
              </p>
              <template v-else-if="context.nextAction.data">
                <p class="font-semibold text-[var(--text-strong)]">
                  {{ adminDate(context.nextAction.data.dueAt, true) }}
                </p>
                <p class="adm-help">
                  Consulta {{ context.nextAction.data.ticketRef }} ·
                  {{ context.nextAction.data.ownerAssigned ? 'con responsable' : 'sin responsable' }}
                </p>
              </template>
              <p v-else class="adm-help">Sin próxima acción registrada</p>
            </AdminCard>

            <AdminCard
              title="Avisos que acepta recibir"
              description="Lo que el cliente ha elegido en su cuenta."
              aria-label="Consentimientos y preferencias"
            >
              <p v-if="context.consent.visibility === 'redacted'" class="adm-help">
                Consentimientos: ocultos por permisos
              </p>
              <template v-else>
                <ul class="space-y-3">
                  <li v-for="choice in choices" :key="choice.label" class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="font-medium text-[var(--text-strong)]">{{ choice.label }}</p>
                      <p class="adm-help">
                        {{ choice.basis === 'default' ? 'Valor inicial: no ha elegido' : 'Elegido por el cliente'
                        }}<template v-if="choice.updatedAt"> · {{ adminDate(choice.updatedAt) }}</template>
                      </p>
                    </div>
                    <AdminBadge :tone="choice.value ? 'success' : 'neutral'" plain>
                      {{ choice.value ? 'Activado' : 'Desactivado' }}
                    </AdminBadge>
                  </li>
                  <li class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="font-medium text-[var(--text-strong)]">Boletín de novedades</p>
                      <p class="adm-help">No se puede saber: la suscripción no está vinculada a la cuenta.</p>
                    </div>
                    <AdminBadge tone="neutral" plain>Desconocido</AdminBadge>
                  </li>
                </ul>
              </template>
            </AdminCard>
          </div>
        </div>
      </div>
    </template>
    <div v-if="loading" class="adm-card adm-table-skeleton" aria-busy="true">
      <span class="sr-only" role="status">Cargando…</span>
      <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
    </div>
    <UAlert
      v-if="message"
      role="status"
      aria-live="polite"
      :color="revoked ? 'warning' : 'error'"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="message"
      :actions="
        revoked || !active
          ? undefined
          : [
              {
                label: 'Reintentar',
                color: 'neutral',
                variant: 'outline',
                onClick: () => (selectedId ? load(selectedId) : search(1))
              }
            ]
      "
    />
  </section>
</template>
