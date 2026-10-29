<script setup lang="ts">
import type { Column } from '~/components/ui/DataTable.vue'
import CompanyReviewPanel from '../../components/CompanyReviewPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Clientes profesionales · Admin', robots: 'noindex, nofollow' })

/**
 * Altas de cuenta profesional.
 *
 * Antes: tabla de 980 px de ancho mínimo sin búsqueda, filtros ni recuento; el estado se
 * mostraba con el valor crudo de la base (`pending`, `suspended`) y los cambios de estado
 * pedían el motivo con `window.prompt()`. El motivo queda en la auditoría, así que merece
 * un campo de verdad y no un diálogo del navegador.
 */
interface Company {
  id: string
  legalName: string
  tradeName: string | null
  taxId: string | null
  countryCode: string
  status: 'pending' | 'approved' | 'rejected' | 'suspended'
  rejectionReason: string | null
  createdAt: string
  reviewedAt: string | null
  reviewedBy: string | null
  locations: number
  members: number
  contactEmail: string | null
}

const cloudflare = useRuntimeConfig().public.serverRuntime === 'cloudflare'
const {
  data,
  refresh,
  status: fetchStatus
} = cloudflare
  ? { data: ref<{ companies: Company[] } | null>(null), refresh: async () => {}, status: ref('idle') }
  : await useFetch<{ companies: Company[] }>('/api/admin/companies')
const toast = useToast()

const query = ref('')
const statusFilter = ref<'todos' | Company['status']>('todos')

const STATUS_OPTIONS = [
  { label: 'Todos los estados', value: 'todos' },
  { label: 'En revisión', value: 'pending' },
  { label: 'Aprobadas', value: 'approved' },
  { label: 'No aprobadas', value: 'rejected' },
  { label: 'Suspendidas', value: 'suspended' }
]

const rows = computed(() => {
  const term = query.value.toLowerCase()
  return (data.value?.companies ?? []).filter((company) => {
    const matchesStatus = statusFilter.value === 'todos' || company.status === statusFilter.value
    const matchesTerm =
      !term ||
      company.legalName.toLowerCase().includes(term) ||
      (company.tradeName ?? '').toLowerCase().includes(term) ||
      (company.taxId ?? '').toLowerCase().includes(term) ||
      (company.contactEmail ?? '').toLowerCase().includes(term)
    return matchesStatus && matchesTerm
  })
})

const pending = computed(() => (data.value?.companies ?? []).filter((c) => c.status === 'pending').length)

const columns: Column<Company>[] = [
  { key: 'legalName', label: 'Empresa' },
  { key: 'taxId', label: 'Identidad fiscal' },
  { key: 'structure', label: 'Estructura', hideOnMobile: true },
  { key: 'status', label: 'Estado' },
  { key: 'reviewedAt', label: 'Revisión', hideOnMobile: true }
]

/* --- Cambio de estado, con motivo auditado --- */
const TRANSITIONS: Record<
  Company['status'],
  Array<{ to: Company['status']; label: string; color: 'primary' | 'error' | 'warning' | 'neutral' }>
> = {
  pending: [
    { to: 'approved', label: 'Aprobar', color: 'primary' },
    { to: 'rejected', label: 'No aprobar', color: 'error' }
  ],
  approved: [{ to: 'suspended', label: 'Suspender', color: 'warning' }],
  rejected: [{ to: 'pending', label: 'Volver a revisar', color: 'neutral' }],
  suspended: [
    { to: 'approved', label: 'Reactivar', color: 'primary' },
    { to: 'pending', label: 'Volver a revisar', color: 'neutral' }
  ]
}

const changing = ref<{ company: Company; to: Company['status']; label: string } | null>(null)
const reason = ref('')
const saving = ref(false)

function startChange(company: Company, to: Company['status'], label: string) {
  changing.value = { company, to, label }
  reason.value = ''
}

async function confirmChange() {
  const target = changing.value
  if (!target || reason.value.trim().length < 3) return
  saving.value = true
  try {
    await $fetch(`/api/admin/companies/${target.company.id}`, {
      method: 'PUT',
      body: { status: target.to, reason: reason.value.trim() }
    })
    await refresh()
    toast.add({
      title: `${target.company.legalName}: ${COMPANY_STATUS[target.to]?.label ?? target.to}`,
      color: 'success',
      icon: 'i-lucide-check'
    })
    changing.value = null
  } catch (error) {
    toast.add({
      title: apiErrorMessage(error, 'No se ha podido actualizar la empresa'),
      color: 'error',
      icon: 'i-lucide-triangle-alert'
    })
  } finally {
    saving.value = false
  }
}

function meta(status: Company['status']) {
  return COMPANY_STATUS[status] ?? { label: status, color: 'neutral' as const }
}
</script>

<template>
  <CompanyReviewPanel v-if="cloudflare" runtime="cloudflare" />
  <div v-else>
    <UiPageHeader
      title="Clientes profesionales"
      :count="rows.length"
      :count-label="rows.length === 1 ? 'empresa' : 'empresas'"
      description="Altas de cuenta de empresa, identidad fiscal y estado operativo. Cada cambio queda auditado con su motivo."
    />

    <UAlert
      v-if="pending"
      class="mb-4"
      color="warning"
      variant="subtle"
      icon="i-lucide-clock"
      :title="`${pending} ${pending === 1 ? 'solicitud espera' : 'solicitudes esperan'} revisión`"
      description="Hasta que se aprueben, esas empresas no tienen condiciones de cliente profesional."
    />

    <UiDataTable
      :rows="rows"
      :columns="columns"
      :row-key="(row) => row.id"
      :status="fetchStatus === 'pending' ? 'pending' : fetchStatus === 'error' ? 'error' : 'idle'"
      :total="rows.length"
      :per-page="rows.length || 1"
      search-placeholder="Buscar por empresa, NIF o email"
      empty-title="Todavía no hay solicitudes de cuenta profesional"
      empty-description="Cuando un cliente pida cuenta de empresa desde su área personal, aparecerá aquí para que la revises."
      error-message="No hemos podido cargar las empresas."
      @search="(value) => (query = value)"
      @retry="refresh()"
    >
      <template #filters>
        <USelect v-model="statusFilter" :items="STATUS_OPTIONS" class="w-52" aria-label="Filtrar por estado" />
      </template>

      <template #cell-legalName="{ row }">
        <p class="font-medium text-[var(--text-strong)]">{{ row.legalName }}</p>
        <p class="truncate text-xs text-[var(--text-muted)]">
          {{ row.contactEmail || 'Sin email de contacto' }}
        </p>
      </template>

      <template #cell-taxId="{ row }">
        <p class="tabular">{{ row.countryCode }} · {{ row.taxId || 'Pendiente' }}</p>
        <p v-if="row.tradeName" class="truncate text-xs text-[var(--text-muted)]">{{ row.tradeName }}</p>
      </template>

      <template #cell-structure="{ row }">
        <span class="text-[var(--text-muted)]">
          {{ row.locations }} {{ row.locations === 1 ? 'sede' : 'sedes' }} · {{ row.members }}
          {{ row.members === 1 ? 'persona' : 'personas' }}
        </span>
      </template>

      <template #cell-status="{ row }">
        <UBadge :color="meta(row.status).color" variant="subtle">{{ meta(row.status).label }}</UBadge>
        <p v-if="row.rejectionReason" class="mt-1 max-w-xs text-xs text-red-700">{{ row.rejectionReason }}</p>
      </template>

      <template #cell-reviewedAt="{ row }">
        <template v-if="row.reviewedAt">
          <p class="text-xs text-[var(--text-muted)]">{{ formatDate(row.reviewedAt) }}</p>
          <p class="truncate text-xs text-[var(--text-muted)]">{{ row.reviewedBy }}</p>
        </template>
        <span v-else class="text-xs text-[var(--text-muted)]">Sin revisar</span>
      </template>

      <template #row-actions="{ row }">
        <div class="flex justify-end gap-1">
          <UButton
            v-for="action in TRANSITIONS[row.status]"
            :key="action.to"
            size="xs"
            :color="action.color"
            variant="outline"
            @click="startChange(row, action.to, action.label)"
          >
            {{ action.label }}
          </UButton>
        </div>
      </template>
    </UiDataTable>

    <UModal
      :open="Boolean(changing)"
      :title="changing ? `${changing.label} la cuenta` : ''"
      @update:open="(value) => !value && (changing = null)"
    >
      <template #body>
        <div v-if="changing" class="space-y-4">
          <p class="text-[var(--text)]">
            <strong>{{ changing.company.legalName }}</strong>
            <template v-if="changing.company.taxId"> · {{ changing.company.taxId }}</template>
          </p>
          <div class="flex items-center gap-3 rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] p-3">
            <UBadge :color="meta(changing.company.status).color" variant="subtle">
              {{ meta(changing.company.status).label }}
            </UBadge>
            <UIcon name="i-lucide-arrow-right" class="size-4 text-[var(--text-muted)]" />
            <UBadge :color="meta(changing.to).color" variant="subtle">{{ meta(changing.to).label }}</UBadge>
          </div>
          <UFormField
            label="Motivo"
            required
            hint="Queda en el registro de auditoría con tu usuario"
            :error="reason.trim().length && reason.trim().length < 3 ? 'Al menos 3 caracteres.' : ''"
          >
            <UTextarea
              v-model="reason"
              class="w-full"
              :rows="2"
              placeholder="Por ejemplo: NIF verificado en el registro mercantil"
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="changing = null">Cancelar</UButton>
          <UButton :disabled="reason.trim().length < 3" :loading="saving" @click="confirmChange">
            {{ changing?.label }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
