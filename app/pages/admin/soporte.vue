<script setup lang="ts">
import type { AdminSupportTicket, AdminSupportTicketDetail } from '~~/shared/types/admin'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Soporte · Admin' })

const q = ref('')
const status = ref('')
const category = ref('')
const selectedId = ref<string | null>(null)
const { data, refresh } = await useFetch<{ items: AdminSupportTicket[] }>('/api/admin/support', {
  query: { q, status, category }
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
    toast.add({ title: 'Ticket actualizado', icon: 'i-lucide-check', color: 'success' })
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
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-slate-900">Soporte e incidencias</h1>
    <p class="mt-1 text-sm text-slate-500">Cola única, SLA, contexto y conversación auditada.</p>

    <div class="mt-4 flex flex-wrap gap-3">
      <UInput v-model="q" icon="i-lucide-search" placeholder="Referencia o asunto…" class="w-72" />
      <select v-model="status" aria-label="Filtrar por estado" class="rounded-lg border border-slate-300 px-3 text-sm">
        <option value="">Todos los estados</option>
        <option value="open">Abierto</option>
        <option value="waiting_customer">Esperando cliente</option>
        <option value="waiting_provider">Esperando proveedor</option>
        <option value="resolved">Resuelto</option>
        <option value="closed">Cerrado</option>
      </select>
      <select
        v-model="category"
        aria-label="Filtrar por motivo"
        class="rounded-lg border border-slate-300 px-3 text-sm"
      >
        <option value="">Todos los motivos</option>
        <option
          v-for="value in ['product', 'order', 'shipping', 'payment', 'invoice', 'return', 'account', 'other']"
          :key="value"
          :value="value"
        >
          {{ value }}
        </option>
      </select>
      <span class="self-center text-sm text-slate-500">{{ items.length }} tickets</span>
    </div>

    <div class="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.8fr)]">
      <div class="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table class="w-full min-w-[760px] text-sm">
          <thead>
            <tr class="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th class="px-4 py-3">Ticket</th>
              <th class="px-4 py-3">Cliente / contexto</th>
              <th class="px-4 py-3">Estado</th>
              <th class="px-4 py-3">SLA</th>
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
                <p class="text-xs text-slate-500">{{ ticket.category }} · {{ ticket.messages }} mensajes</p>
              </td>
              <td class="px-4 py-3">
                <p>{{ ticket.requesterName }}</p>
                <p class="text-xs text-slate-500">{{ ticket.requesterEmail }}</p>
                <p v-if="ticket.orderNumber" class="mt-1 font-mono text-xs">Pedido {{ ticket.orderNumber }}</p>
              </td>
              <td class="px-4 py-3">
                <UBadge variant="subtle">{{ ticket.status }}</UBadge>
                <p class="mt-1 text-xs text-slate-500">{{ ticket.priority }}</p>
              </td>
              <td class="px-4 py-3" :class="overdue(ticket) ? 'font-semibold text-red-700' : 'text-slate-600'">
                {{ new Date(ticket.slaDueAt).toLocaleString('es-ES') }}
              </td>
            </tr>
            <tr v-if="!items.length">
              <td colspan="4" class="px-4 py-10 text-center text-slate-500">No hay tickets con estos filtros.</td>
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

        <ol class="mt-5 max-h-96 space-y-3 overflow-y-auto" aria-label="Conversación del ticket">
          <li v-for="message in detail.timeline" :key="message.id" class="rounded-xl border border-slate-200 p-3">
            <div class="flex justify-between gap-2 text-xs text-slate-500">
              <span
                >{{ message.authorName || message.authorType }}
                <strong v-if="message.private">· nota privada</strong></span
              >
              <time>{{ new Date(message.createdAt).toLocaleString('es-ES') }}</time>
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
          <UFormField label="Motivo operativo" required>
            <UInput v-model="form.reason" class="w-full" placeholder="Acción realizada y siguiente paso" required />
          </UFormField>
          <UButton type="submit" icon="i-lucide-send" :loading="saving">Guardar y enviar</UButton>
        </form>
      </aside>
      <aside v-else class="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
        Selecciona un ticket para ver su conversación y contexto.
      </aside>
    </div>
  </div>
</template>
