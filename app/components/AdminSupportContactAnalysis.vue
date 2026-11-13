<script setup lang="ts">
import { randomId } from '../utils/uuid'
import { ROOT_CAUSE_LABELS, formatRate } from '../utils/support-insights-labels'
import { supportCategoryLabels } from './support/labels'

/** SUP-014: contact rate by order, product and carrier, with root cause and a backlog fed by evidence. */
interface Group {
  key: string
  contacts: number
  touches?: number
  orders?: number
  ratePer100Orders?: number | null
  estimatedCostCents?: number
}
interface Suggestion {
  dimension: string
  dimensionKey: string
  rootCause: string
  contacts: number
  sharePct: number
  ratePer100Orders: number | null
  priority: 'low' | 'normal' | 'high'
  title: string
}
interface Analysis {
  window: { from: string; to: string }
  totals: {
    orders: number
    contacts: number
    ratePer100Orders: number | null
    touches: number
    estimatedCostCents: number | null
  }
  byCategory: Group[]
  byRootCause: Group[]
  byCarrier: Group[]
  byProduct: Group[]
  byOrder: Group[]
  suggestions: Suggestion[]
}
interface BacklogItem {
  id: string
  dimension: string
  dimensionKey: string
  title: string
  priority: string
  status: string
  version: number
  createdAt: string
}
const request = useRequestFetch()
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const from = ref(day(-30)),
  to = ref(day(1)),
  touchCost = ref('')
const state = ref<'loading' | 'ready' | 'error'>('loading'),
  errorText = ref(''),
  notice = ref(''),
  busy = ref(false)
const analysis = ref<Analysis | null>(null),
  backlog = ref<BacklogItem[]>([])
const dimensionLabels: Record<string, string> = {
  carrier: 'transportista',
  product: 'producto',
  category: 'categoría',
  root_cause: 'motivo',
  order: 'pedido'
}

async function load() {
  state.value = 'loading'
  errorText.value = ''
  try {
    const params = new URLSearchParams({ from: from.value, to: to.value })
    if (touchCost.value.trim() !== '') params.set('touchCostCents', String(Math.round(Number(touchCost.value) * 100)))
    const [a, b] = await Promise.all([
      request(`/api/admin/support/contact-analysis?${params}`) as Promise<Analysis>,
      request('/api/admin/support/contact-analysis/backlog') as Promise<{ items: BacklogItem[] }>
    ])
    analysis.value = a
    backlog.value = b.items
    state.value = 'ready'
  } catch {
    errorText.value = 'No hemos podido cargar el análisis de contactos.'
    state.value = 'error'
  }
}
async function reloadBacklog() {
  backlog.value = ((await request('/api/admin/support/contact-analysis/backlog')) as { items: BacklogItem[] }).items
}
async function addToBacklog(s: Suggestion) {
  busy.value = true
  notice.value = ''
  try {
    await request<unknown, string>('/api/admin/support/contact-analysis/backlog', {
      method: 'POST',
      headers: { 'idempotency-key': randomId() },
      body: {
        dimension: s.dimension,
        dimensionKey: s.dimensionKey,
        rootCause: s.rootCause,
        title: s.title,
        priority: s.priority,
        from: analysis.value!.window.from,
        to: analysis.value!.window.to,
        evidence: { contacts: s.contacts, sharePct: s.sharePct, ratePer100Orders: s.ratePer100Orders }
      }
    })
    notice.value = 'Añadido a las mejoras pendientes.'
    await reloadBacklog()
  } catch (error) {
    const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
    notice.value =
      code === 'duplicate_backlog'
        ? 'Esa mejora ya está en la lista para este periodo.'
        : 'No se ha podido añadir a las mejoras pendientes.'
  } finally {
    busy.value = false
  }
}
async function move(item: BacklogItem, action: 'plan' | 'complete' | 'dismiss') {
  busy.value = true
  notice.value = ''
  try {
    await request<unknown, string>(`/api/admin/support/contact-analysis/backlog/${item.id}/commands`, {
      method: 'POST',
      headers: { 'idempotency-key': randomId() },
      body: { action, expectedVersion: item.version }
    })
    await reloadBacklog()
  } catch {
    notice.value = 'Esta mejora ha cambiado mientras la veías. Actualiza la lista y vuelve a intentarlo.'
  } finally {
    busy.value = false
  }
}
const label = (key: string) => ROOT_CAUSE_LABELS[key] ?? adminHumanize(key)
const priorityLabels: Record<string, string> = { low: 'Baja', normal: 'Normal', high: 'Alta' }
const priorityTones: Record<string, 'neutral' | 'warning' | 'danger'> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'danger'
}
const backlogStatus: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'info' }> = {
  open: { label: 'Pendiente', tone: 'warning' },
  planned: { label: 'Planificada', tone: 'info' },
  completed: { label: 'Hecha', tone: 'success' },
  dismissed: { label: 'Descartada', tone: 'neutral' }
}
const groupColumns = [
  { key: 'key', label: 'Nombre' },
  { key: 'orders', label: 'Pedidos', numeric: true },
  { key: 'contacts', label: 'Contactos', numeric: true },
  { key: 'ratePer100Orders', label: 'Por 100 pedidos', numeric: true }
]
const backlogColumns = [
  { key: 'title', label: 'Mejora' },
  { key: 'priority', label: 'Prioridad' },
  { key: 'status', label: 'Estado' },
  { key: 'createdAt', label: 'Alta', hideOnMobile: true }
]
const shortId = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value) ? `#${value.slice(0, 8).toUpperCase()}` : value
onMounted(load)
</script>

<template>
  <section class="adm-stack">
    <AdminCard>
      <form class="adm-toolbar" @submit.prevent="load">
        <label class="adm-label flex items-center gap-2"
          >Desde<input v-model="from" type="date" required class="adm-input w-auto"
        /></label>
        <label class="adm-label flex items-center gap-2"
          >Hasta<input v-model="to" type="date" required class="adm-input w-auto"
        /></label>
        <label class="adm-label flex items-center gap-2"
          >Coste por gestión (€)<input
            v-model="touchCost"
            type="number"
            min="0"
            step="0.01"
            class="adm-input w-28"
            placeholder="Opcional"
        /></label>
        <div class="adm-toolbar__end">
          <button type="submit" class="adm-btn adm-btn--secondary" :disabled="state === 'loading'">Actualizar</button>
        </div>
      </form>
    </AdminCard>

    <UAlert
      v-if="state === 'error'"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorText"
    >
      <template #actions>
        <AdminButton size="sm" icon="i-lucide-rotate-cw" @click="load">Reintentar</AdminButton>
      </template>
    </UAlert>
    <UAlert v-else-if="notice" role="status" color="neutral" variant="subtle" icon="i-lucide-info" :title="notice" />
    <div v-if="state === 'loading'" class="adm-card">
      <div class="adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Calculando…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /></div>
      </div>
    </div>

    <template v-if="state === 'ready' && analysis">
      <AdminEmptyState
        v-if="analysis.totals.orders === 0 && analysis.totals.contacts === 0"
        compact
        icon="i-lucide-calendar-x"
        title="Sin pedidos ni contactos en estas fechas"
        description="Prueba con un periodo más amplio."
      />
      <div class="grid grid-cols-2 gap-5 lg:grid-cols-4">
        <AdminStat label="Pedidos" :value="analysis.totals.orders" />
        <AdminStat label="Contactos" :value="analysis.totals.contacts" />
        <AdminStat label="Contactos por 100 pedidos" :value="formatRate(analysis.totals.ratePer100Orders)" />
        <AdminStat
          label="Coste estimado"
          :value="analysis.totals.estimatedCostCents === null ? '—' : adminMoney(analysis.totals.estimatedCostCents)"
          :hint="analysis.totals.estimatedCostCents === null ? 'Indica el coste por gestión' : undefined"
        />
      </div>

      <div class="grid gap-5 lg:grid-cols-2">
        <AdminSection
          v-for="[title, rows] in [
            ['Por transportista', analysis.byCarrier],
            ['Por producto', analysis.byProduct]
          ] as const"
          :key="title"
          :title="title"
        >
          <AdminTable
            :rows="rows"
            :columns="groupColumns"
            :row-key="(row) => row.key"
            :per-page="10"
            empty-title="Sin contactos asociados"
          >
            <template #cell-ratePer100Orders="{ row }">{{ formatRate(row.ratePer100Orders) }}</template>
          </AdminTable>
        </AdminSection>
        <AdminCard title="Por motivo">
          <p v-if="analysis.byRootCause.length === 0" class="adm-help">Sin contactos en estas fechas.</p>
          <ul v-else class="space-y-2">
            <li v-for="row in analysis.byRootCause" :key="row.key" class="flex flex-wrap justify-between gap-2">
              <span class="text-[var(--text-strong)]">{{ label(row.key) }}</span>
              <span class="text-[var(--text-muted)]">{{ row.contacts }} contactos, {{ row.touches }} gestiones</span>
            </li>
          </ul>
        </AdminCard>
        <AdminCard title="Por tipo de consulta y pedidos con varios contactos">
          <p v-if="analysis.byCategory.length === 0 && analysis.byOrder.length === 0" class="adm-help">
            Sin contactos en estas fechas.
          </p>
          <ul v-else class="space-y-2">
            <li v-for="row in analysis.byCategory" :key="row.key" class="flex flex-wrap justify-between gap-2">
              <span class="text-[var(--text-strong)]">{{
                supportCategoryLabels[row.key] ?? adminHumanize(row.key)
              }}</span>
              <span class="text-[var(--text-muted)]">{{ row.contacts }} contactos</span>
            </li>
            <li v-for="row in analysis.byOrder" :key="row.key" class="flex flex-wrap justify-between gap-2">
              <span class="text-[var(--text-strong)]">Pedido {{ shortId(row.key) }}</span>
              <span class="text-[var(--text-muted)]">{{ row.contacts }} contactos</span>
            </li>
          </ul>
        </AdminCard>
      </div>

      <AdminCard
        title="Mejoras sugeridas"
        description="Grupos que concentran muchos contactos y que merece la pena revisar."
        flush
      >
        <AdminEmptyState
          v-if="analysis.suggestions.length === 0"
          compact
          icon="i-lucide-thumbs-up"
          title="Nada destacable"
          description="Ningún grupo concentra suficientes contactos en estas fechas."
        />
        <ul v-else class="adm-list">
          <li v-for="s in analysis.suggestions" :key="s.dimension + s.dimensionKey">
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">
                {{ s.title }}
                <AdminBadge v-if="s.priority === 'high'" tone="danger" plain>Prioridad alta</AdminBadge>
              </p>
              <p class="adm-help">
                {{ s.contacts }} contactos ({{ formatRate(s.sharePct) }} %) · por {{ dimensionLabels[s.dimension] }}
              </p>
            </div>
            <button
              type="button"
              data-test="suggestion-add"
              :disabled="busy"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              @click="addToBacklog(s)"
            >
              Añadir a mejoras pendientes
            </button>
          </li>
        </ul>
      </AdminCard>

      <AdminSection title="Mejoras pendientes">
        <AdminTable
          :rows="backlog"
          :columns="backlogColumns"
          :row-key="(item) => item.id"
          empty-icon="i-lucide-list-checks"
          empty-title="No hay mejoras pendientes"
          empty-description="Añade aquí las mejoras sugeridas que quieras seguir."
        >
          <template #cell-title="{ row }">
            <span class="font-medium text-[var(--text-strong)]">{{ row.title }}</span>
          </template>
          <template #cell-priority="{ row }">
            <AdminBadge :tone="priorityTones[row.priority] ?? 'neutral'" plain>
              {{ priorityLabels[row.priority] ?? 'Normal' }}
            </AdminBadge>
          </template>
          <template #cell-status="{ row }">
            <AdminBadge :tone="backlogStatus[row.status]?.tone ?? 'neutral'">
              {{ backlogStatus[row.status]?.label ?? adminHumanize(row.status) }}
            </AdminBadge>
          </template>
          <template #cell-createdAt="{ row }">{{ adminDate(row.createdAt) }}</template>
          <template #actions="{ row }">
            <button
              v-if="row.status === 'open'"
              type="button"
              data-test="backlog-plan"
              :disabled="busy"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              @click="move(row, 'plan')"
            >
              Planificar
            </button>
            <button
              v-if="row.status === 'planned'"
              type="button"
              data-test="backlog-complete"
              :disabled="busy"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              @click="move(row, 'complete')"
            >
              Marcar como hecha
            </button>
            <button
              v-if="row.status === 'open' || row.status === 'planned'"
              type="button"
              data-test="backlog-dismiss"
              :disabled="busy"
              class="adm-btn adm-btn--ghost adm-btn--sm"
              @click="move(row, 'dismiss')"
            >
              Descartar
            </button>
          </template>
        </AdminTable>
      </AdminSection>
    </template>
  </section>
</template>
