<script setup lang="ts">
import type { AdminReturnSummary } from '~~/shared/types/admin'
import type { AdminTone } from '~/utils/adminLabels'
import OrderReturnSection from '~/components/OrderReturnSection.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Devoluciones · Admin' })
const runtime = useRuntimeConfig().public.serverRuntime

/**
 * Devoluciones y reembolsos.
 *
 * Antes, cambiar el estado de una devolución encadenaba **cuatro `window.prompt()`**, y el
 * primero pedía al operario que **escribiera a mano** el estado, eligiéndolo de una lista
 * separada por comas dentro del propio mensaje: «requested, approved, rejected, in_transit,
 * received, inspected o resolved». Un error de tecleo y la llamada fallaba; un `Cancelar` a
 * medias dejaba el flujo a la mitad.
 *
 * Ahora es un formulario con los estados como opciones, y los campos de resolución y
 * reembolso solo aparecen cuando la transición los necesita.
 */
const {
  data,
  refresh,
  status: fetchStatus
} = await useFetch<{ items: AdminReturnSummary[] }>('/api/admin/returns', {
  immediate: runtime === 'node',
  watch: false
})
const toast = useToast()

const RETURN_STATUS: Record<string, { label: string; tone: AdminTone }> = {
  requested: { label: 'Solicitada', tone: 'warning' },
  approved: { label: 'Autorizada', tone: 'info' },
  rejected: { label: 'Rechazada', tone: 'danger' },
  in_transit: { label: 'En camino', tone: 'info' },
  received: { label: 'Recibida', tone: 'info' },
  inspected: { label: 'Revisada', tone: 'info' },
  resolved: { label: 'Resuelta', tone: 'success' }
}
const REFUND_STATUS: Record<string, string> = {
  requested: 'Solicitado',
  pending: 'Pendiente',
  processing: 'En proceso',
  completed: 'Abonado',
  failed: 'Fallido'
}
/** Transiciones razonables desde cada estado. Antes no había ninguna guía. */
const TRANSITIONS: Record<string, string[]> = {
  requested: ['approved', 'rejected'],
  approved: ['in_transit', 'rejected'],
  in_transit: ['received'],
  received: ['inspected'],
  inspected: ['resolved', 'rejected'],
  resolved: [],
  rejected: []
}

const query = ref('')
const onlyOpen = ref(true)

const rows = computed(() => {
  const term = query.value.toLowerCase()
  return (data.value?.items ?? []).filter((item) => {
    const open = !['resolved', 'rejected'].includes(item.status)
    if (onlyOpen.value && !open) return false
    return (
      !term ||
      item.id.toLowerCase().includes(term) ||
      item.orderNumber.toLowerCase().includes(term) ||
      item.customerName.toLowerCase().includes(term) ||
      item.email.toLowerCase().includes(term)
    )
  })
})
const openCount = computed(
  () => (data.value?.items ?? []).filter((item) => !['resolved', 'rejected'].includes(item.status)).length
)

const scopeOptions = [
  { value: 'open', label: 'Abiertas' },
  { value: 'all', label: 'Todas' }
]
const scope = computed({
  get: () => (onlyOpen.value ? 'open' : 'all'),
  set: (value: string) => {
    onlyOpen.value = value !== 'all'
  }
})

const columns = [
  { key: 'id', label: 'Devolución' },
  { key: 'customerName', label: 'Cliente' },
  { key: 'reason', label: 'Motivo', hideOnMobile: true },
  { key: 'quantity', label: 'Unidades', numeric: true, hideOnMobile: true },
  { key: 'status', label: 'Estado' },
  { key: 'refund', label: 'Reembolso' }
]

/* --- Cambio de estado --- */
const editing = ref<AdminReturnSummary | null>(null)
const editOpen = computed({
  get: () => editing.value !== null,
  set: (value: boolean) => {
    if (!value) editing.value = null
  }
})
const saving = ref(false)
const form = reactive({ status: '', reason: '', resolution: '', refundEuros: null as number | null })

function startEdit(item: AdminReturnSummary) {
  editing.value = item
  Object.assign(form, {
    status: TRANSITIONS[item.status]?.[0] ?? '',
    reason: '',
    resolution: '',
    refundEuros: item.refundAmountCents ? item.refundAmountCents / 100 : null
  })
}

const statusOptions = computed(() =>
  (TRANSITIONS[editing.value?.status ?? ''] ?? []).map((value) => ({
    label: RETURN_STATUS[value]?.label ?? value,
    value
  }))
)
const needsResolution = computed(() => form.status === 'resolved')

async function save() {
  if (runtime !== 'node') return
  const item = editing.value
  if (!item || !form.status || form.reason.trim().length < 3) return
  saving.value = true
  try {
    await $fetch(`/api/admin/returns/${item.id}`, {
      method: 'PUT',
      body: {
        status: form.status,
        reason: form.reason.trim(),
        resolution: needsResolution.value ? form.resolution.trim() || undefined : undefined,
        refundAmountCents:
          needsResolution.value && form.refundEuros != null ? Math.round(Number(form.refundEuros) * 100) : undefined
      }
    })
    toast.add({ title: `${item.id}: ${RETURN_STATUS[form.status]?.label}`, color: 'success', icon: 'i-lucide-check' })
    editing.value = null
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido cambiar la devolución'), color: 'error' })
  } finally {
    saving.value = false
  }
}

function meta(status: string) {
  return RETURN_STATUS[status] ?? { label: adminHumanize(status), tone: 'neutral' as const }
}
</script>

<template>
  <AdminPage
    :count="runtime === 'node' ? rows.length : undefined"
    :count-label="rows.length === 1 ? 'devolución' : 'devoluciones'"
  >
    <OrderReturnSection v-if="runtime === 'cloudflare'" :runtime="runtime" />
    <div v-else-if="runtime === 'node'" class="adm-stack">
      <AdminTable
        :rows="rows"
        :columns="columns"
        :row-key="(row) => row.id"
        :status="fetchStatus === 'pending' ? 'pending' : fetchStatus === 'error' ? 'error' : 'idle'"
        :filtered="Boolean(query)"
        empty-icon="i-lucide-rotate-ccw"
        :empty-title="onlyOpen && openCount === 0 ? 'No hay devoluciones abiertas' : 'Aún no hay devoluciones'"
        :empty-description="
          onlyOpen && openCount === 0
            ? 'Todo lo pendiente está resuelto. Cambia a «Todas» para ver el histórico.'
            : 'Cuando un cliente pida devolver un pedido, la solicitud aparecerá aquí para que la autorices.'
        "
        error-message="No hemos podido cargar las devoluciones."
        caption="Devoluciones"
        @retry="refresh()"
        @clear-filters="query = ''"
      >
        <template #toolbar>
          <AdminToolbar v-model:search="query" placeholder="Buscar por referencia, pedido o cliente">
            <AdminFilters v-model="scope" :options="scopeOptions" label="Filtrar por estado" />
          </AdminToolbar>
        </template>

        <template #empty-action>
          <AdminButton v-if="onlyOpen && openCount === 0" @click="onlyOpen = false">Ver el histórico</AdminButton>
        </template>

        <template #cell-id="{ row }">
          <p class="font-semibold text-[var(--text-strong)]">{{ row.id }}</p>
          <NuxtLink :to="`/pedido/${row.orderNumber}`" target="_blank" class="adm-help hover:underline">
            Pedido {{ row.orderNumber }}
          </NuxtLink>
        </template>

        <template #cell-customerName="{ row }">
          <p class="font-medium text-[var(--text-strong)]">{{ row.customerName }}</p>
          <p class="adm-help max-w-[16rem] truncate">{{ row.email }}</p>
        </template>

        <template #cell-reason="{ row }">
          <span class="line-clamp-2 max-w-xs text-[var(--text-muted)]">{{ row.reason }}</span>
        </template>

        <template #cell-status="{ row }">
          <AdminBadge :tone="meta(row.status).tone">{{ meta(row.status).label }}</AdminBadge>
        </template>

        <template #cell-refund="{ row }">
          <template v-if="row.refundAmountCents">
            <span class="font-semibold tabular-nums">{{ adminMoney(row.refundAmountCents) }}</span>
            <p class="adm-help">
              {{ REFUND_STATUS[row.refundStatus ?? ''] ?? adminHumanize(row.refundStatus ?? '') }}
            </p>
          </template>
          <span v-else class="text-[var(--text-muted)]">—</span>
        </template>

        <template #actions="{ row }">
          <AdminButton v-if="TRANSITIONS[row.status]?.length" size="sm" @click="startEdit(row)">Gestionar</AdminButton>
          <span v-else class="adm-help">Cerrada</span>
        </template>
      </AdminTable>

      <AdminDrawer v-model:open="editOpen" title="Gestionar la devolución">
        <form v-if="editing" id="return-form" class="adm-stack" @submit.prevent="save">
          <div>
            <p class="font-semibold text-[var(--text-strong)]">{{ editing.id }}</p>
            <p class="adm-help">
              {{ editing.customerName }} · pedido {{ editing.orderNumber }} · {{ editing.quantity }}
              {{ editing.quantity === 1 ? 'unidad' : 'unidades' }}
            </p>
          </div>

          <div class="flex items-center gap-3 rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] p-3">
            <AdminBadge :tone="meta(editing.status).tone">{{ meta(editing.status).label }}</AdminBadge>
            <UIcon name="i-lucide-arrow-right" class="size-4 text-[var(--text-muted)]" />
            <AdminBadge v-if="form.status" :tone="meta(form.status).tone">{{ meta(form.status).label }}</AdminBadge>
          </div>

          <AdminFormField v-slot="{ id }" label="Nuevo estado" required>
            <select :id="id" v-model="form.status" required>
              <option v-for="option in statusOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </AdminFormField>

          <AdminFormField
            v-slot="{ id }"
            label="Motivo"
            required
            help="Queda guardado en el historial de la devolución."
            :error="form.reason.trim().length && form.reason.trim().length < 3 ? 'Al menos 3 caracteres.' : undefined"
          >
            <textarea
              :id="id"
              v-model="form.reason"
              rows="2"
              placeholder="Por ejemplo: producto recibido en buen estado"
            />
          </AdminFormField>

          <template v-if="needsResolution">
            <AdminFormField v-slot="{ id }" label="Cómo se resuelve">
              <input
                :id="id"
                v-model="form.resolution"
                type="text"
                placeholder="Abono íntegro, cambio por otro producto…"
              />
            </AdminFormField>
            <AdminFormField
              v-slot="{ id }"
              label="Importe a reembolsar (€)"
              help="Déjalo vacío si no corresponde reembolso."
            >
              <input :id="id" v-model.number="form.refundEuros" type="number" min="0" step="0.01" />
            </AdminFormField>
          </template>
        </form>
        <template #footer>
          <AdminButton @click="editing = null">Cancelar</AdminButton>
          <AdminButton
            variant="primary"
            :disabled="!form.status || form.reason.trim().length < 3"
            :loading="saving"
            @click="save"
          >
            Guardar
          </AdminButton>
        </template>
      </AdminDrawer>
    </div>
    <UAlert
      v-else
      role="status"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Las devoluciones no están disponibles en esta instalación"
    />
  </AdminPage>
</template>
