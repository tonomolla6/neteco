<script setup lang="ts">
import type { AdminReturnSummary } from '~~/shared/types/admin'
import type { Column } from '~/components/ui/DataTable.vue'
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

const RETURN_STATUS: Record<string, { label: string; color: 'neutral' | 'warning' | 'success' | 'error' | 'info' }> = {
  requested: { label: 'Solicitada', color: 'warning' },
  approved: { label: 'Autorizada', color: 'info' },
  rejected: { label: 'Rechazada', color: 'error' },
  in_transit: { label: 'En camino', color: 'info' },
  received: { label: 'Recibida', color: 'info' },
  inspected: { label: 'Inspeccionada', color: 'info' },
  resolved: { label: 'Resuelta', color: 'success' }
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

const columns: Column<AdminReturnSummary>[] = [
  { key: 'id', label: 'RMA / pedido' },
  { key: 'customerName', label: 'Cliente' },
  { key: 'reason', label: 'Motivo', hideOnMobile: true },
  { key: 'quantity', label: 'Uds.', numeric: true, hideOnMobile: true },
  { key: 'status', label: 'Estado' },
  { key: 'refund', label: 'Reembolso' }
]

/* --- Cambio de estado --- */
const editing = ref<AdminReturnSummary | null>(null)
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
  return RETURN_STATUS[status] ?? { label: status, color: 'neutral' as const }
}
</script>

<template>
  <OrderReturnSection v-if="runtime === 'cloudflare'" :runtime="runtime" />
  <div v-else-if="runtime === 'node'">
    <UiPageHeader
      title="Devoluciones y reembolsos"
      :count="rows.length"
      :count-label="rows.length === 1 ? 'devolución' : 'devoluciones'"
      description="Autoriza, recibe, inspecciona y resuelve cada devolución. Cada paso queda trazado con su motivo."
    />

    <UiDataTable
      :rows="rows"
      :columns="columns"
      :row-key="(row) => row.id"
      :status="fetchStatus === 'pending' ? 'pending' : fetchStatus === 'error' ? 'error' : 'idle'"
      :total="rows.length"
      :per-page="rows.length || 1"
      search-placeholder="Buscar por RMA, pedido o cliente"
      :empty-title="onlyOpen && openCount === 0 ? 'No hay devoluciones abiertas' : 'Todavía no hay devoluciones'"
      :empty-description="
        onlyOpen && openCount === 0
          ? 'Todo lo pendiente está resuelto. Quita el filtro para ver el histórico.'
          : 'Cuando un cliente solicite una devolución desde su pedido, aparecerá aquí para autorizarla.'
      "
      error-message="No hemos podido cargar las devoluciones."
      @search="(value) => (query = value)"
      @retry="refresh()"
    >
      <template #filters>
        <UCheckbox v-model="onlyOpen" label="Solo las abiertas" />
      </template>

      <template #empty-action>
        <UButton v-if="onlyOpen && openCount === 0" color="neutral" variant="outline" @click="onlyOpen = false">
          Ver el histórico
        </UButton>
      </template>

      <template #cell-id="{ row }">
        <p class="font-mono text-xs font-semibold text-[var(--text-strong)]">{{ row.id }}</p>
        <NuxtLink
          :to="`/pedido/${row.orderNumber}`"
          target="_blank"
          class="tabular text-xs text-neteco-700 hover:underline"
        >
          {{ row.orderNumber }}
        </NuxtLink>
      </template>

      <template #cell-customerName="{ row }">
        <p class="font-medium text-[var(--text-strong)]">{{ row.customerName }}</p>
        <p class="max-w-[16rem] truncate text-xs text-[var(--text-muted)]">{{ row.email }}</p>
      </template>

      <template #cell-reason="{ row }">
        <span class="line-clamp-2 max-w-xs text-[var(--text-muted)]">{{ row.reason }}</span>
      </template>

      <template #cell-status="{ row }">
        <UBadge :color="meta(row.status).color" variant="subtle">{{ meta(row.status).label }}</UBadge>
      </template>

      <template #cell-refund="{ row }">
        <template v-if="row.refundAmountCents">
          <span class="tabular font-semibold">{{ formatPrice(row.refundAmountCents) }}</span>
          <p class="text-xs text-[var(--text-muted)]">
            {{ REFUND_STATUS[row.refundStatus ?? ''] ?? row.refundStatus }}
          </p>
        </template>
        <span v-else class="text-[var(--text-muted)]">—</span>
      </template>

      <template #row-actions="{ row }">
        <UButton
          v-if="TRANSITIONS[row.status]?.length"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-right-left"
          @click="startEdit(row)"
        >
          Avanzar
        </UButton>
        <span v-else class="text-xs text-[var(--text-muted)]">Cerrada</span>
      </template>
    </UiDataTable>

    <UModal :open="Boolean(editing)" title="Avanzar la devolución" @update:open="(value) => !value && (editing = null)">
      <template #body>
        <form v-if="editing" id="return-form" class="space-y-4" @submit.prevent="save">
          <div>
            <p class="font-mono text-sm font-semibold text-[var(--text-strong)]">{{ editing.id }}</p>
            <p class="text-sm text-[var(--text-muted)]">
              {{ editing.customerName }} · pedido {{ editing.orderNumber }} · {{ editing.quantity }}
              {{ editing.quantity === 1 ? 'unidad' : 'unidades' }}
            </p>
          </div>

          <div class="flex items-center gap-3 rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] p-3">
            <UBadge :color="meta(editing.status).color" variant="subtle">{{ meta(editing.status).label }}</UBadge>
            <UIcon name="i-lucide-arrow-right" class="size-4 text-[var(--text-muted)]" />
            <UBadge v-if="form.status" :color="meta(form.status).color" variant="subtle">
              {{ meta(form.status).label }}
            </UBadge>
          </div>

          <UFormField label="Nuevo estado" required>
            <USelect v-model="form.status" :items="statusOptions" class="w-full" />
          </UFormField>

          <UFormField
            label="Motivo"
            required
            hint="Queda en la trazabilidad de la devolución"
            :error="form.reason.trim().length && form.reason.trim().length < 3 ? 'Al menos 3 caracteres.' : ''"
          >
            <UTextarea
              v-model="form.reason"
              class="w-full"
              :rows="2"
              placeholder="Por ejemplo: producto recibido en buen estado"
            />
          </UFormField>

          <template v-if="needsResolution">
            <UFormField label="Resolución aplicada">
              <UInput
                v-model="form.resolution"
                class="w-full"
                placeholder="Abono íntegro, cambio por otra referencia…"
              />
            </UFormField>
            <UFormField label="Importe a reembolsar" hint="Déjalo vacío si no corresponde reembolso">
              <UInput v-model.number="form.refundEuros" type="number" min="0" step="0.01" class="w-full" />
            </UFormField>
          </template>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="editing = null">Cancelar</UButton>
          <UButton
            type="submit"
            form="return-form"
            :disabled="!form.status || form.reason.trim().length < 3"
            :loading="saving"
          >
            Guardar
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
  <p v-else role="status">No se ha confirmado el adaptador operativo. No se habilita ningún flujo de devolución.</p>
</template>
