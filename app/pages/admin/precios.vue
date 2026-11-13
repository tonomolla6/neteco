<script setup lang="ts">
import GovernedPriceEditor from '~/components/GovernedPriceEditor.vue'
import { catalogPriceListSchema } from '~~/shared/catalog-price-commands'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Precios · Admin' })

/**
 * Tarifa y vigencias.
 *
 * La funcionalidad de esta pantalla era buena —vigencias programadas sin despliegue,
 * tramos por volumen, referencia de 30 días para Omnibus e histórico con cancelación—
 * pero se pintaba como una pila de tarjetas a ancho completo, una por variante: **6.766 px
 * de alto en escritorio y 9.631 px en móvil con solo 50 referencias**. Con el catálogo
 * real no se puede abrir.
 *
 * Ahora es una tarifa: una fila por referencia, comparable en vertical, y los dos
 * formularios largos (programar vigencia, ver histórico) en diálogo.
 */
interface VolumeTier {
  minimumQuantity: number
  unitGrossCents: number
}

interface PriceVersion {
  id: string
  grossCents: number
  compareAtGrossCents: number | null
  referenceGrossCents30d: number | null
  volumeTiers: VolumeTier[]
  validFrom: string
  validUntil: string | null
  status: 'approved' | 'cancelled'
  reason: string
}

interface PriceItem {
  variantId: string
  id: number
  sku: string
  format: string
  product: string
  grossCents: number
  compareAtGrossCents: number | null
  referenceGrossCents30d: number | null
  volumeTiers: VolumeTier[]
  pricingVersion: string
  validFrom: string | null
  history: PriceVersion[]
  currency?: string
  scheduled?: PriceVersion | null
  historyPagination?: Pagination
}

interface Pagination {
  page: number
  perPage: number
  total: number
  pages: number
}

interface PricingResponse {
  items: PriceItem[]
  source?: 'cloudflare'
  pricingInstant?: string
  pagination?: Pagination
  capabilities?: {
    pricesRead?: boolean
    priceHistoryRead?: boolean
    priceSchedulesRead?: boolean
    priceWrite?: boolean
    priceSchedule?: boolean
    priceCancel?: boolean
  }
}

const runtime = useRuntimeConfig().public.serverRuntime
const cloudflare = runtime === 'cloudflare'
const node = runtime === 'node'
const { loggedIn } = useUserSession()
const query = ref('')
const page = ref(1)
const perPage = 25
const {
  data,
  refresh,
  status: fetchStatus,
  error: fetchError
} = await useFetch<PricingResponse>('/api/admin/prices', {
  query: computed(() => ({
    q: query.value || undefined,
    ...(cloudflare ? { page: page.value, perPage } : {})
  }))
})
const toast = useToast()
const confirmedD1 = computed(() => {
  if (!cloudflare || loggedIn.value !== true || fetchStatus.value !== 'success' || fetchError.value != null) return null
  const parsed = catalogPriceListSchema.safeParse(data.value)
  return parsed.success ? parsed.data : null
})

const canRead = computed(() => node || !!confirmedD1.value)
const canReadHistory = computed(
  () => canRead.value && (node || confirmedD1.value?.capabilities.priceHistoryRead === true)
)
const canReadSchedules = computed(
  () => canRead.value && (node || confirmedD1.value?.capabilities.priceSchedulesRead === true)
)
const items = computed(() => (cloudflare ? (confirmedD1.value?.items ?? []) : node ? (data.value?.items ?? []) : []))
const total = computed(() =>
  cloudflare ? (canRead.value ? (data.value?.pagination?.total ?? 0) : 0) : items.value.length
)
const paged = computed(() =>
  cloudflare ? items.value : items.value.slice((page.value - 1) * perPage, page.value * perPage)
)
watch(query, () => (page.value = 1))

function isUpcoming(version: PriceVersion) {
  const instant = cloudflare ? (historyData.value?.pricingInstant ?? data.value?.pricingInstant) : undefined
  if (cloudflare && !instant) return false
  return version.status === 'approved' && new Date(version.validFrom) > (instant ? new Date(instant) : new Date())
}
function upcoming(item: PriceItem) {
  if (!canReadSchedules.value) return undefined
  if (cloudflare) return item.scheduled ?? undefined
  return item.history.filter(isUpcoming).sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0]
}
const canManage = computed(
  () => confirmedD1.value?.capabilities.priceSchedule === true || confirmedD1.value?.capabilities.priceCancel === true
)
const scheduledCount = computed(() => items.value.filter((item) => upcoming(item)).length)

const columns = computed(() => [
  { key: 'product', label: 'Referencia' },
  { key: 'grossCents', label: 'Precio actual', numeric: true },
  { key: 'referenceGrossCents30d', label: 'Mínimo 30 días', numeric: true, hideOnMobile: !cloudflare },
  { key: 'volumeTiers', label: 'Por cantidad', hideOnMobile: !cloudflare },
  ...(canReadSchedules.value ? [{ key: 'scheduled', label: 'Programado' }] : [])
])

function displayPrice(cents: number, currency?: string) {
  if (!cloudflare) return formatPrice(cents)
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return `${cents} unidades mínimas · moneda no disponible`
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(cents / 100)
}

/* --- Programar nueva vigencia --- */
const editing = ref<PriceItem | null>(null)
const saving = ref(false)
const form = reactive({
  gross: null as number | null,
  compareAt: null as number | null,
  validFrom: '',
  reason: '',
  tiers: [] as Array<{ minimumQuantity: number | null; unitGross: number | null }>
})

function localDateInput(hours = 1) {
  const date = new Date(Date.now() + hours * 60 * 60_000)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

function startSchedule(item: PriceItem) {
  // This Cloudflare cut exposes GET only. A forged future write capability does
  // not manufacture a scheduling/cancellation backend.
  if (!node) return
  editing.value = item
  Object.assign(form, {
    gross: item.grossCents / 100,
    compareAt: item.compareAtGrossCents === null ? null : item.compareAtGrossCents / 100,
    validFrom: localDateInput(),
    reason: '',
    tiers: item.volumeTiers.map((tier) => ({
      minimumQuantity: tier.minimumQuantity,
      unitGross: tier.unitGrossCents / 100
    }))
  })
}

async function schedule() {
  if (!node || !editing.value || saving.value) return
  saving.value = true
  try {
    await $fetch('/api/admin/prices', {
      method: 'POST',
      body: {
        variantId: editing.value.variantId,
        grossCents: Math.round(Number(form.gross) * 100),
        compareAtGrossCents: form.compareAt == null ? null : Math.round(Number(form.compareAt) * 100),
        volumeTiers: form.tiers.map((tier) => ({
          minimumQuantity: Number(tier.minimumQuantity),
          unitGrossCents: Math.round(Number(tier.unitGross) * 100)
        })),
        validFrom: new Date(form.validFrom).toISOString(),
        reason: form.reason
      }
    })
    await refresh()
    editing.value = null
    toast.add({ title: 'Precio programado', color: 'success', icon: 'i-lucide-calendar-check' })
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido programar el precio'), color: 'error' })
  } finally {
    saving.value = false
  }
}

/* --- Histórico y cancelación --- */
const viewing = ref<PriceItem | null>(null)
const historyData = ref<PricingResponse | null>(null)
const historyStatus = ref<'idle' | 'pending' | 'error'>('idle')
const historyPage = ref(1)
const historyPerPage = 20
let historyRequest = 0
const historyItem = computed(() =>
  cloudflare
    ? historyData.value?.items.find(
        (item) => item.variantId === viewing.value?.variantId && item.id === viewing.value?.id
      )
    : viewing.value
)
const history = computed(() => (canReadHistory.value ? (historyItem.value?.history ?? []) : []))
const historyPagination = computed(() => (cloudflare ? historyItem.value?.historyPagination : undefined))

function closeHistory() {
  historyRequest++
  viewing.value = null
  historyData.value = null
  historyStatus.value = 'idle'
}

async function loadHistory(targetPage = historyPage.value) {
  const target = viewing.value
  if (!cloudflare || !target || !canReadHistory.value) return
  const request = ++historyRequest
  historyStatus.value = 'pending'
  historyPage.value = targetPage
  historyData.value = null
  try {
    const result = await $fetch<PricingResponse>('/api/admin/prices', {
      method: 'GET',
      query: { variant: target.id, page: 1, perPage: 1, historyPage: targetPage, historyPerPage }
    })
    if (request !== historyRequest || viewing.value?.variantId !== target.variantId || !canReadHistory.value) return
    const parsed = catalogPriceListSchema.safeParse(result)
    if (
      !parsed.success ||
      parsed.data.capabilities.priceHistoryRead !== true ||
      !parsed.data.items.some((item) => item.variantId === target.variantId && item.id === target.id)
    ) {
      throw new Error('Price history is not available')
    }
    historyData.value = parsed.data
    historyPage.value = targetPage
    historyStatus.value = 'idle'
  } catch {
    if (request === historyRequest && viewing.value?.variantId === target.variantId) historyStatus.value = 'error'
  }
}

async function viewHistory(item: PriceItem) {
  if (!canReadHistory.value) return
  closeHistory()
  viewing.value = item
  historyPage.value = 1
  if (cloudflare) await loadHistory(1)
}

watch(canReadHistory, (available) => {
  if (!available) closeHistory()
})

const cancelling = ref<PriceVersion | null>(null)
const cancelReason = ref('')

async function confirmCancel() {
  const version = cancelling.value
  if (!node || !version || saving.value || cancelReason.value.trim().length < 3) return
  saving.value = true
  try {
    await $fetch(`/api/admin/prices/${version.id}/cancel`, {
      method: 'POST',
      body: { reason: cancelReason.value.trim() }
    })
    await refresh()
    cancelling.value = null
    cancelReason.value = ''
    viewing.value = null
    toast.add({ title: 'Programación cancelada', color: 'success' })
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido cancelar la programación'), color: 'error' })
  } finally {
    saving.value = false
  }
}

function stamp(value: string) {
  return new Date(value).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })
}
const governed = ref<{ id: number; variantId: string; productUuid: string } | null>(null)
function authorizePrice(
  identity: { variantId: string; variantLegacyId: number; productUuid: string },
  action?: 'price_schedule' | 'price_cancel'
) {
  const current = confirmedD1.value
  const selected = governed.value
  if (
    !current ||
    !selected ||
    selected.id !== identity.variantLegacyId ||
    selected.variantId !== identity.variantId ||
    selected.productUuid !== identity.productUuid ||
    (action &&
      (current.capabilities.priceWrite !== false ||
        (action === 'price_schedule'
          ? current.capabilities.priceSchedule !== true
          : current.capabilities.priceCancel !== true)))
  )
    return false
  return current.items.some(
    (item) =>
      item.id === identity.variantLegacyId &&
      item.variantId === identity.variantId &&
      item.productUuid === identity.productUuid
  )
}
function openGoverned(item: PriceItem) {
  const current = confirmedD1.value?.items.find((entry) => entry.id === item.id && entry.variantId === item.variantId)
  if (!current || (!confirmedD1.value?.capabilities.priceSchedule && !confirmedD1.value?.capabilities.priceCancel))
    return
  governed.value = { id: current.id, variantId: current.variantId, productUuid: current.productUuid }
}
const reloadingList = ref(false)
async function reloadList() {
  if (reloadingList.value || fetchStatus.value === 'pending') return
  reloadingList.value = true
  try {
    await refresh()
  } finally {
    reloadingList.value = false
  }
}
</script>

<template>
  <AdminPage :count="total" :count-label="total === 1 ? 'referencia' : 'referencias'">
    <div class="adm-stack">
      <UAlert
        v-if="cloudflare && !canRead && fetchStatus !== 'pending' && fetchStatus !== 'idle'"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="No se pueden consultar los precios"
        description="Tu sesión no tiene acceso a la tarifa en este momento. Vuelve a iniciar sesión o pide acceso a un administrador."
      />
      <UAlert
        v-else-if="cloudflare && canRead && !canManage"
        color="info"
        variant="subtle"
        icon="i-lucide-eye"
        title="Solo consulta"
        description="Tu usuario puede ver la tarifa, pero no programar ni cancelar cambios de precio."
      />

      <UAlert
        v-if="scheduledCount"
        color="info"
        variant="subtle"
        icon="i-lucide-calendar-clock"
        :title="`${scheduledCount} ${scheduledCount === 1 ? 'referencia tiene' : 'referencias tienen'} un cambio de precio programado${cloudflare ? ' en esta página' : ''}`"
        description="El nuevo precio se aplicará solo en la fecha indicada."
      />

      <AdminTable
        v-model:page="page"
        :rows="paged"
        :columns="columns"
        :row-key="(row) => row.variantId"
        :status="
          fetchStatus === 'pending' || fetchStatus === 'idle'
            ? 'pending'
            : fetchStatus === 'error' || (cloudflare && !canRead)
              ? 'error'
              : 'idle'
        "
        :total="total"
        :per-page="perPage"
        :filtered="Boolean(query)"
        empty-title="No hay referencias con precio"
        empty-description="Las referencias con un precio en vigor aparecerán aquí."
        empty-icon="i-lucide-tag"
        error-message="No hemos podido cargar la tarifa."
        caption="Tarifa de precios por referencia"
        @retry="reloadList"
        @clear-filters="query = ''"
      >
        <template #toolbar>
          <AdminToolbar
            v-model:search="query"
            placeholder="Buscar por producto o referencia"
            search-label="Buscar en la tarifa"
          >
            <template v-if="cloudflare && canRead && data?.pricingInstant" #actions>
              <span class="text-xs text-[var(--text-muted)]">Precios a {{ stamp(data.pricingInstant) }}</span>
            </template>
          </AdminToolbar>
        </template>

        <template #cell-product="{ row }">
          <p class="font-medium text-[var(--text-strong)]">{{ row.product }}</p>
          <p class="text-xs text-[var(--text-muted)]">
            {{ row.format }} · <span class="font-mono">{{ row.sku }}</span>
          </p>
        </template>

        <template #cell-grossCents="{ row }">
          <span class="font-semibold text-[var(--text-strong)]">{{ displayPrice(row.grossCents, row.currency) }}</span>
          <p v-if="row.compareAtGrossCents" class="text-xs text-[var(--text-muted)]">
            antes <s>{{ displayPrice(row.compareAtGrossCents, row.currency) }}</s>
          </p>
          <p v-if="cloudflare" class="text-xs text-[var(--text-muted)]">
            {{ row.validFrom ? `Desde ${stamp(row.validFrom)}` : 'Precio base sin fecha de vigencia registrada' }}
          </p>
        </template>

        <template #cell-referenceGrossCents30d="{ row }">
          <span class="text-[var(--text-muted)]">
            {{ row.referenceGrossCents30d ? displayPrice(row.referenceGrossCents30d, row.currency) : '—' }}
          </span>
        </template>

        <template #cell-volumeTiers="{ row }">
          <span v-if="!row.volumeTiers.length" class="text-[var(--text-muted)]">—</span>
          <AdminBadge v-else tone="success">
            {{ row.volumeTiers.length }} {{ row.volumeTiers.length === 1 ? 'tramo' : 'tramos' }}
          </AdminBadge>
          <ul v-if="cloudflare && row.volumeTiers.length" class="mt-1 text-xs text-[var(--text-muted)]">
            <li v-for="tier in row.volumeTiers" :key="tier.minimumQuantity">
              ≥ {{ tier.minimumQuantity }}: {{ displayPrice(tier.unitGrossCents, row.currency) }}/ud
            </li>
          </ul>
        </template>

        <template #cell-scheduled="{ row }">
          <template v-if="upcoming(row)">
            <AdminBadge tone="warning">{{ displayPrice(upcoming(row)!.grossCents, row.currency) }}</AdminBadge>
            <p class="mt-0.5 text-xs text-[var(--text-muted)]">{{ stamp(upcoming(row)!.validFrom) }}</p>
          </template>
          <span v-else class="text-[var(--text-muted)]">—</span>
        </template>

        <template #actions="{ row }">
          <div class="flex justify-end gap-1">
            <AdminButton
              v-if="canReadHistory"
              variant="ghost"
              size="sm"
              icon="i-lucide-history"
              :label="`Ver histórico de ${row.sku}`"
              @click="viewHistory(row)"
            />
            <AdminButton v-if="node" size="sm" icon="i-lucide-calendar-plus" @click="startSchedule(row)">
              Programar
            </AdminButton>
            <AdminButton v-if="cloudflare && canManage" size="sm" @click="openGoverned(row)">
              Gestionar vigencias
            </AdminButton>
          </div>
        </template>
      </AdminTable>

      <!-- Programar un precio -->
      <AdminDrawer
        v-if="node"
        :open="Boolean(editing)"
        title="Programar un precio"
        :description="editing ? `${editing.product} · ${editing.format}` : undefined"
        @update:open="(value) => !value && (editing = null)"
      >
        <form v-if="editing" id="price-form" class="adm-stack" @submit.prevent="schedule">
          <p class="text-sm text-[var(--text-muted)]">
            Referencia <span class="font-mono">{{ editing.sku }}</span> · precio actual
            <strong class="tabular-nums text-[var(--text-strong)]">{{ formatPrice(editing.grossCents) }}</strong>
          </p>

          <div class="adm-form-grid">
            <AdminFormField
              v-slot="{ id }"
              label="Nuevo precio (IVA incluido)"
              data-field="Nuevo precio (IVA incluido)"
              required
            >
              <input :id="id" v-model.number="form.gross" type="number" min="0.01" step="0.01" required />
            </AdminFormField>
            <AdminFormField
              v-slot="{ id }"
              label="Precio anterior"
              data-field="Precio anterior"
              help="Para mostrarlo tachado. Opcional."
            >
              <input :id="id" v-model.number="form.compareAt" type="number" min="0.01" step="0.01" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Vigente desde" data-field="Vigente desde" required>
              <input :id="id" v-model="form.validFrom" type="datetime-local" required />
            </AdminFormField>
            <AdminFormField
              v-slot="{ id }"
              label="Motivo"
              data-field="Motivo"
              required
              help="Queda anotado en el historial."
            >
              <input :id="id" v-model="form.reason" type="text" required placeholder="Campaña, tarifa de proveedor…" />
            </AdminFormField>
          </div>

          <AdminCard title="Precios por cantidad" description="«A partir de N unidades, X € por unidad».">
            <template #actions>
              <AdminButton
                size="sm"
                icon="i-lucide-plus"
                @click="form.tiers.push({ minimumQuantity: null, unitGross: null })"
              >
                Añadir tramo
              </AdminButton>
            </template>
            <p v-if="!form.tiers.length" class="adm-help">
              Sin tramos: se cobra el mismo precio para cualquier cantidad.
            </p>
            <div v-for="(tier, index) in form.tiers" :key="index" class="mb-2 flex items-end gap-2">
              <AdminFormField v-slot="{ id }" label="Desde unidades" class="flex-1">
                <input :id="id" v-model.number="tier.minimumQuantity" type="number" min="1" required />
              </AdminFormField>
              <AdminFormField v-slot="{ id }" label="Precio por unidad" class="flex-1">
                <input :id="id" v-model.number="tier.unitGross" type="number" min="0.01" step="0.01" required />
              </AdminFormField>
              <AdminButton
                variant="ghost"
                icon="i-lucide-trash-2"
                :label="`Quitar el tramo ${index + 1}`"
                @click="form.tiers.splice(index, 1)"
              />
            </div>
          </AdminCard>

          <p class="rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] p-3 text-sm text-[var(--text-muted)]">
            Quedará en
            <strong class="tabular-nums text-[var(--text-strong)]">{{
              formatPrice(Math.round(Number(form.gross || 0) * 100))
            }}</strong>
            desde {{ form.validFrom ? stamp(form.validFrom) : '—' }}
            <template v-if="form.tiers.length">
              · {{ form.tiers.length }} {{ form.tiers.length === 1 ? 'tramo' : 'tramos' }}
            </template>
          </p>
        </form>
        <template #footer>
          <AdminButton @click="editing = null">Cancelar</AdminButton>
          <AdminButton
            variant="primary"
            type="submit"
            form="price-form"
            :loading="saving"
            icon="i-lucide-calendar-check"
          >
            Programar precio
          </AdminButton>
        </template>
      </AdminDrawer>

      <!-- Histórico -->
      <AdminDrawer
        :open="Boolean(viewing) && canReadHistory"
        title="Histórico de precios"
        :description="viewing ? `${viewing.product} · ${viewing.format}` : undefined"
        @update:open="(value) => !value && closeHistory()"
      >
        <div v-if="viewing" class="adm-stack">
          <p class="text-sm text-[var(--text-muted)]">
            Referencia <span class="font-mono">{{ viewing.sku }}</span>
          </p>

          <p v-if="cloudflare && historyStatus === 'pending'" role="status" class="text-sm text-[var(--text-muted)]">
            Cargando el histórico…
          </p>
          <div v-else-if="cloudflare && historyStatus === 'error'" role="alert">
            <AdminEmptyState variant="error" compact title="No hemos podido cargar el histórico">
              <AdminButton icon="i-lucide-rotate-cw" @click="loadHistory()">Reintentar histórico</AdminButton>
            </AdminEmptyState>
          </div>
          <ul v-else-if="history.length" class="divide-y divide-[var(--border)]">
            <li v-for="version in history" :key="version.id" class="py-3 first:pt-0">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class="font-semibold tabular-nums text-[var(--text-strong)]">
                  {{ displayPrice(version.grossCents, historyItem?.currency) }}
                </span>
                <AdminBadge
                  :tone="version.status === 'cancelled' ? 'neutral' : isUpcoming(version) ? 'warning' : 'success'"
                >
                  {{ version.status === 'cancelled' ? 'Cancelado' : isUpcoming(version) ? 'Programado' : 'Aplicado' }}
                </AdminBadge>
                <AdminButton
                  v-if="node && isUpcoming(version)"
                  variant="danger-soft"
                  size="sm"
                  class="ml-auto"
                  @click="cancelling = version"
                >
                  Cancelar
                </AdminButton>
              </div>
              <p class="mt-0.5 text-sm text-[var(--text-muted)]">
                {{ stamp(version.validFrom) }}
                <template v-if="version.validUntil"> → {{ stamp(version.validUntil) }}</template>
                <template v-else> → sin fecha de fin</template>
              </p>
              <p v-if="version.reason" class="mt-0.5 text-sm text-[var(--text-muted)]">{{ version.reason }}</p>
              <p
                v-if="cloudflare && (version.compareAtGrossCents !== null || version.referenceGrossCents30d !== null)"
                class="mt-1 text-xs text-[var(--text-muted)]"
              >
                <template v-if="version.compareAtGrossCents !== null">
                  Anterior: {{ displayPrice(version.compareAtGrossCents, historyItem?.currency) }}.
                </template>
                <template v-if="version.referenceGrossCents30d !== null">
                  Ref. 30 días: {{ displayPrice(version.referenceGrossCents30d, historyItem?.currency) }}.
                </template>
              </p>
              <ul v-if="cloudflare && version.volumeTiers.length" class="mt-1 text-xs text-[var(--text-muted)]">
                <li v-for="tier in version.volumeTiers" :key="tier.minimumQuantity">
                  ≥ {{ tier.minimumQuantity }}: {{ displayPrice(tier.unitGrossCents, historyItem?.currency) }}/ud
                </li>
              </ul>
            </li>
          </ul>
          <AdminEmptyState
            v-else
            compact
            icon="i-lucide-history"
            title="Esta referencia no tiene cambios de precio todavía"
          />

          <div v-if="cloudflare && historyPagination" class="flex flex-wrap items-center justify-between gap-3">
            <p class="text-xs text-[var(--text-muted)]">
              {{ historyPagination.total }} {{ historyPagination.total === 1 ? 'versión' : 'versiones' }} · página
              {{ historyPagination.page }} de
              {{ historyPagination.pages || 1 }}
            </p>
            <div class="flex gap-2">
              <AdminButton
                size="sm"
                :disabled="historyStatus === 'pending' || historyPagination.page <= 1"
                @click="loadHistory(historyPagination!.page - 1)"
              >
                Histórico anterior
              </AdminButton>
              <AdminButton
                size="sm"
                :disabled="historyStatus === 'pending' || historyPagination.page >= historyPagination.pages"
                @click="loadHistory(historyPagination!.page + 1)"
              >
                Histórico siguiente
              </AdminButton>
            </div>
          </div>
        </div>
        <template #footer>
          <AdminButton @click="closeHistory()">Cerrar histórico</AdminButton>
        </template>
      </AdminDrawer>

      <!-- Cancelar un precio programado -->
      <AdminConfirm
        v-if="node"
        :open="Boolean(cancelling)"
        title="Cancelar el precio programado"
        confirm-label="Cancelar programación"
        cancel-label="Volver"
        danger
        :loading="saving"
        @update:open="(value) => !value && (cancelling = null)"
        @confirm="confirmCancel"
      >
        <div v-if="cancelling" class="adm-stack">
          <p>
            No llegará a aplicarse el precio de
            <strong class="tabular-nums">{{ formatPrice(cancelling.grossCents) }}</strong> previsto para
            {{ stamp(cancelling.validFrom) }}. El precio actual se mantiene.
          </p>
          <AdminFormField
            v-slot="{ id }"
            label="Motivo"
            required
            :error="cancelReason.trim().length && cancelReason.trim().length < 3 ? 'Al menos 3 caracteres.' : undefined"
          >
            <input
              :id="id"
              v-model="cancelReason"
              type="text"
              class="adm-input"
              placeholder="Por ejemplo: la campaña se ha aplazado"
            />
          </AdminFormField>
        </div>
      </AdminConfirm>

      <!-- Cambiar precio (programar o cancelar) -->
      <AdminDrawer
        v-if="cloudflare"
        :open="!!governed"
        title="Gestionar vigencias de precio"
        description="Programa un precio nuevo o cancela uno que aún no ha entrado en vigor."
        wide
        @update:open="(value) => !value && (governed = null)"
      >
        <GovernedPriceEditor
          v-if="governed"
          :key="governed.id"
          :variant-legacy-id="governed.id"
          :runtime="runtime"
          :authorize="authorizePrice"
          :refresh-list="reloadList"
        />
        <template #footer>
          <AdminButton @click="governed = null">Cerrar</AdminButton>
        </template>
      </AdminDrawer>
    </div>
  </AdminPage>
</template>
