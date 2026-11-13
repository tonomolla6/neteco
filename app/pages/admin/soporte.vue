<script setup lang="ts">
import type { AdminSupportTicket, AdminSupportTicketDetail } from '~~/shared/types/admin'
import AdminSupportSection from '~/components/AdminSupportSection.vue'

definePageMeta({ layout: 'admin', middleware: 'support-access' })
useSeoMeta({ title: 'Soporte · Admin' })
const supportRuntime = useRuntimeConfig()
const nativeSupport = supportRuntime.public.serverRuntime === 'cloudflare'

const q = ref('')
/**
 * `TODOS` en vez de cadena vacía: `USelect` reserva `''` para «sin selección», y una
 * opción con ese valor rompía el render en servidor — la pantalla entera devolvía un
 * 500 antes de pintar nada. Al construir la consulta se traduce a «sin filtro», que
 * es distinto de «filtra por la cadena vacía»: eso último lo rechaza el esquema del
 * servidor, y era el segundo motivo del mismo 500.
 */
const TODOS = 'todos'
const status = ref(TODOS)
const category = ref(TODOS)
const selectedId = ref<string | null>(null)
const { data, refresh } = await useFetch<{ items: AdminSupportTicket[] }>('/api/admin/support', {
  immediate: !nativeSupport,
  query: computed(() => ({
    q: q.value.trim() || undefined,
    status: status.value === TODOS ? undefined : status.value,
    category: category.value === TODOS ? undefined : category.value
  }))
})
const items = computed(() => data.value?.items ?? [])
const { data: detail, refresh: refreshDetail } = await useFetch<AdminSupportTicketDetail>(
  () => `/api/admin/support/${selectedId.value ?? 'none'}`,
  { immediate: false }
)
const form = reactive({
  status: 'open' as AdminSupportTicket['status'],
  priority: 'normal' as AdminSupportTicket['priority'],
  message: '',
  private: false,
  reason: ''
})
const saving = ref(false)
const toast = useToast()

async function select(ticket: AdminSupportTicket) {
  selectedId.value = ticket.id
  await refreshDetail()
  if (!detail.value) return
  form.status = detail.value.status
  form.priority = detail.value.priority
  form.message = ''
  form.private = false
  form.reason = ''
}

async function save() {
  if (!selectedId.value) return
  saving.value = true
  try {
    await $fetch(`/api/admin/support/${selectedId.value}`, {
      method: 'PUT',
      body: form
    })
    toast.add({ title: 'Consulta actualizada', icon: 'i-lucide-check', color: 'success' })
    form.message = ''
    form.reason = ''
    await Promise.all([refresh(), refreshDetail()])
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido actualizar'), color: 'error' })
  } finally {
    saving.value = false
  }
}

function overdue(ticket: AdminSupportTicket) {
  return !['resolved', 'closed'].includes(ticket.status) && new Date(ticket.slaDueAt).getTime() < Date.now()
}

/**
 * Etiquetas de los enumerados. La pantalla mostraba los valores crudos de la base
 * (`open`, `waiting_provider`, `normal`, `product`) tanto en la tabla como en los propios
 * desplegables de filtro, donde el operario tenía que elegir entre «product» y «shipping».
 */
const TICKET_STATUS: Record<string, { label: string; color: 'neutral' | 'warning' | 'success' | 'info' }> = {
  open: { label: 'Abierto', color: 'warning' },
  waiting_customer: { label: 'Esperando al cliente', color: 'info' },
  waiting_provider: { label: 'Esperando al proveedor', color: 'info' },
  resolved: { label: 'Resuelto', color: 'success' },
  closed: { label: 'Cerrado', color: 'neutral' }
}
const TICKET_PRIORITY: Record<string, string> = {
  low: 'Prioridad baja',
  normal: 'Prioridad normal',
  high: 'Prioridad alta',
  urgent: 'Urgente'
}
const TICKET_CATEGORY: Record<string, string> = {
  product: 'Producto',
  order: 'Pedido',
  shipping: 'Envío',
  payment: 'Pago',
  invoice: 'Factura',
  return: 'Devolución',
  account: 'Cuenta',
  other: 'Otros'
}
const statusOptions = [
  { label: 'Todos los estados', value: TODOS },
  ...Object.entries(TICKET_STATUS).map(([value, meta]) => ({ label: meta.label, value }))
]
const categoryOptions = [
  { label: 'Todos los motivos', value: TODOS },
  ...Object.entries(TICKET_CATEGORY).map(([value, label]) => ({ label, value }))
]
const overdueCount = computed(() => items.value.filter(overdue).length)

function ticketStatus(value: string) {
  return TICKET_STATUS[value] ?? { label: value, color: 'neutral' as const }
}
</script>

<template>
  <AdminPage
    :count="nativeSupport ? undefined : items.length"
    :count-label="items.length === 1 ? 'consulta' : 'consultas'"
  >
    <AdminServiceGate v-if="nativeSupport" service="support">
      <AdminSupportSection :runtime="supportRuntime.public.serverRuntime" />
    </AdminServiceGate>
    <div v-else class="adm-stack">
      <UAlert
        v-if="overdueCount"
        role="alert"
        color="error"
        variant="subtle"
        icon="i-lucide-alarm-clock"
        :title="`${overdueCount} ${overdueCount === 1 ? 'consulta ha superado' : 'consultas han superado'} su plazo de respuesta`"
        description="Son los primeros que hay que atender: el compromiso con el cliente ya está incumplido."
      />

      <div class="flex flex-wrap gap-3">
        <UInput v-model="q" icon="i-lucide-search" placeholder="Referencia o asunto" class="w-full sm:w-72" />
        <USelect v-model="status" :items="statusOptions" class="w-full sm:w-52" aria-label="Filtrar por estado" />
        <USelect v-model="category" :items="categoryOptions" class="w-full sm:w-48" aria-label="Filtrar por motivo" />
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.8fr)]">
        <div class="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table class="w-full min-w-[760px] text-sm">
            <thead>
              <tr class="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th class="px-4 py-3">Consulta</th>
                <th class="px-4 py-3">Cliente</th>
                <th class="px-4 py-3">Estado</th>
                <th class="px-4 py-3">Plazo de respuesta</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="ticket in items"
                :key="ticket.id"
                class="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                :class="{ 'bg-neteco-50': selectedId === ticket.id }"
                @click="select(ticket)"
              >
                <td class="px-4 py-3">
                  <p class="font-mono text-xs font-semibold">{{ ticket.id }}</p>
                  <p class="mt-1 max-w-xs font-medium text-slate-800">{{ ticket.subject }}</p>
                  <p class="text-xs text-slate-500">
                    {{ TICKET_CATEGORY[ticket.category] ?? ticket.category }} · {{ ticket.messages }}
                    {{ ticket.messages === 1 ? 'mensaje' : 'mensajes' }}
                  </p>
                </td>
                <td class="px-4 py-3">
                  <p>{{ ticket.requesterName }}</p>
                  <p class="text-xs text-slate-500">{{ ticket.requesterEmail }}</p>
                  <p v-if="ticket.orderNumber" class="mt-1 font-mono text-xs">Pedido {{ ticket.orderNumber }}</p>
                </td>
                <td class="px-4 py-3">
                  <UBadge :color="ticketStatus(ticket.status).color" variant="subtle">
                    {{ ticketStatus(ticket.status).label }}
                  </UBadge>
                  <p class="mt-1 text-xs text-slate-500">
                    {{ TICKET_PRIORITY[ticket.priority] ?? ticket.priority }}
                  </p>
                </td>
                <td class="px-4 py-3" :class="overdue(ticket) ? 'font-semibold text-red-700' : 'text-slate-600'">
                  {{ adminDate(ticket.slaDueAt, true) }}
                </td>
              </tr>
              <tr v-if="!items.length">
                <td colspan="4" class="p-0">
                  <UiEmptyState
                    :variant="q || status || category ? 'filtered' : 'empty'"
                    icon="i-lucide-life-buoy"
                    :title="
                      q || status || category
                        ? 'Ninguna consulta coincide con los filtros'
                        : 'No hay consultas abiertas'
                    "
                    :description="
                      q || status || category
                        ? 'Prueba con otra referencia o quita algún filtro.'
                        : 'Cuando un cliente escriba desde su pedido o desde contacto, su consulta aparecerá aquí.'
                    "
                  >
                    <UButton
                      v-if="q || status || category"
                      color="neutral"
                      variant="outline"
                      @click="
                        () => {
                          q = ''
                          status = ''
                          category = ''
                        }
                      "
                    >
                      Quitar filtros
                    </UButton>
                  </UiEmptyState>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <aside v-if="detail" class="rounded-2xl border border-slate-200 bg-white p-5">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="font-mono text-xs text-slate-500">{{ detail.id }}</p>
              <h2 class="font-bold text-slate-900">{{ detail.subject }}</h2>
              <p class="mt-1 text-sm text-slate-600">{{ detail.requesterName }} · {{ detail.requesterEmail }}</p>
            </div>
            <UButton v-if="detail.orderId" :to="`/pedido/${detail.orderId}`" target="_blank" size="xs" variant="soft"
              >Pedido</UButton
            >
          </div>

          <ol class="mt-5 max-h-96 space-y-3 overflow-y-auto" aria-label="Conversación de la consulta">
            <li v-for="message in detail.timeline" :key="message.id" class="rounded-xl border border-slate-200 p-3">
              <div class="flex justify-between gap-2 text-xs text-slate-500">
                <span
                  >{{ message.authorName || message.authorType }}
                  <strong v-if="message.private">· nota privada</strong></span
                >
                <time>{{ adminDate(message.createdAt, true) }}</time>
              </div>
              <p class="mt-1 whitespace-pre-wrap text-sm text-slate-700">{{ message.body }}</p>
            </li>
          </ol>

          <form class="mt-5 space-y-3 border-t border-slate-200 pt-4" @submit.prevent="save">
            <div class="grid grid-cols-2 gap-3">
              <UFormField label="Estado">
                <select v-model="form.status" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  <option value="open">Abierto</option>
                  <option value="waiting_customer">Esperando cliente</option>
                  <option value="waiting_provider">Esperando proveedor</option>
                  <option value="resolved">Resuelto</option>
                  <option value="closed">Cerrado</option>
                </select>
              </UFormField>
              <UFormField label="Prioridad">
                <select v-model="form.priority" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  <option value="low">Baja</option>
                  <option value="normal">Normal</option>
                  <option value="high">Alta</option>
                  <option value="urgent">Urgente</option>
                </select>
              </UFormField>
            </div>
            <UFormField label="Respuesta o nota" hint="La respuesta pública se envía por correo">
              <UTextarea v-model="form.message" :rows="4" class="w-full" />
            </UFormField>
            <label class="flex items-center gap-2 text-sm text-slate-700">
              <input v-model="form.private" type="checkbox" class="size-4" /> Nota interna: no enviar al cliente
            </label>
            <UFormField label="Motivo" required>
              <UInput v-model="form.reason" class="w-full" placeholder="Acción realizada y siguiente paso" required />
            </UFormField>
            <UButton type="submit" icon="i-lucide-send" :loading="saving">Guardar y enviar</UButton>
          </form>
        </aside>
        <aside v-else class="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          Selecciona una consulta para ver su conversación.
        </aside>
      </div>
    </div>
  </AdminPage>
</template>
