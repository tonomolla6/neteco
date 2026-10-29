<script setup lang="ts">
import type { Column } from '~/components/ui/DataTable.vue'
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
const scheduledCount = computed(() => items.value.filter((item) => upcoming(item)).length)

const columns = computed<Column<PriceItem>[]>(() => [
  { key: 'product', label: 'Referencia' },
  { key: 'grossCents', label: 'Precio actual', numeric: true },
  { key: 'referenceGrossCents30d', label: 'Ref. 30 días', numeric: true, hideOnMobile: !cloudflare },
  { key: 'volumeTiers', label: 'Tramos', hideOnMobile: !cloudflare },
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
  <div>
    <UiPageHeader
      title="Tarifa"
      :count="total"
      :count-label="total === 1 ? 'referencia' : 'referencias'"
      :description="
        cloudflare
          ? 'Consulta la tarifa vigente, las referencias de 30 días y el histórico disponible.'
          : 'Programa vigencias sin despliegue, conserva la referencia de 30 días y define tramos por volumen.'
      "
    />

    <UAlert
      v-if="cloudflare"
      class="mb-4"
      color="info"
      variant="subtle"
      icon="i-lucide-info"
      :title="canRead ? 'Tarifa D1 gobernada' : 'Consulta de precios no disponible'"
      :description="
        confirmedD1?.capabilities.priceSchedule || confirmedD1?.capabilities.priceCancel
          ? 'La programación y cancelación requieren permiso administrativo vigente, segundo factor y auditoría. No modifican existencias ni publican productos.'
          : 'Sólo consulta: tu sesión no dispone de permisos administrativos vigentes para modificar precios.'
      "
    />
    <p v-if="cloudflare && canRead && data?.pricingInstant" class="mb-4 text-xs text-[var(--text-muted)]">
      Tarifa evaluada el {{ stamp(data.pricingInstant) }}.
    </p>

    <UAlert
      v-if="scheduledCount"
      class="mb-4"
      color="info"
      variant="subtle"
      icon="i-lucide-calendar-clock"
      :title="`${scheduledCount} ${scheduledCount === 1 ? 'referencia tiene' : 'referencias tienen'} un cambio de precio programado${cloudflare ? ' en esta página' : ''}`"
      :description="
        cloudflare
          ? 'Cambios aprobados existentes, según el instante del servidor. La gestión requiere permiso administrativo vigente.'
          : 'Entrarán en vigor solas, sin desplegar nada.'
      "
    />

    <UiDataTable
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
      :page="page"
      :per-page="perPage"
      search-placeholder="Buscar por producto o referencia"
      empty-title="No hay referencias con precio"
      :empty-description="
        cloudflare
          ? 'Las referencias no descatalogadas con un precio vigente aparecerán aquí cuando la consulta esté disponible.'
          : 'Las referencias publicadas con precio vigente aparecerán aquí.'
      "
      error-message="No hemos podido cargar la tarifa."
      @search="(value) => (query = value)"
      @update:page="(value) => (page = value)"
      @retry="reloadList"
    >
      <template #cell-product="{ row }">
        <p class="font-medium text-[var(--text-strong)]">{{ row.product }}</p>
        <p class="text-xs text-[var(--text-muted)]">
          {{ row.format }} · <span class="font-mono">{{ row.sku }}</span>
        </p>
      </template>

      <template #cell-grossCents="{ row }">
        <span class="font-semibold">{{ displayPrice(row.grossCents, row.currency) }}</span>
        <p v-if="cloudflare" class="text-xs text-[var(--text-muted)]">
          {{ row.validFrom ? `Desde ${stamp(row.validFrom)}` : 'Precio base sin fecha de vigencia registrada' }}
        </p>
        <p v-if="row.compareAtGrossCents" class="text-xs text-[var(--text-muted)]">
          antes <s>{{ displayPrice(row.compareAtGrossCents, row.currency) }}</s>
        </p>
      </template>

      <template #cell-referenceGrossCents30d="{ row }">
        <span class="text-[var(--text-muted)]">
          {{ row.referenceGrossCents30d ? displayPrice(row.referenceGrossCents30d, row.currency) : '—' }}
        </span>
      </template>

      <template #cell-volumeTiers="{ row }">
        <span v-if="!row.volumeTiers.length" class="text-[var(--text-muted)]">—</span>
        <UBadge v-else color="success" variant="subtle">
          {{ row.volumeTiers.length }} {{ row.volumeTiers.length === 1 ? 'tramo' : 'tramos' }}
        </UBadge>
        <ul v-if="cloudflare && row.volumeTiers.length" class="mt-1 text-xs text-[var(--text-muted)]">
          <li v-for="tier in row.volumeTiers" :key="tier.minimumQuantity">
            ≥ {{ tier.minimumQuantity }}: {{ displayPrice(tier.unitGrossCents, row.currency) }}/ud
          </li>
        </ul>
      </template>

      <template #cell-scheduled="{ row }">
        <template v-if="upcoming(row)">
          <UBadge color="warning" variant="subtle">{{ displayPrice(upcoming(row)!.grossCents, row.currency) }}</UBadge>
          <p class="mt-0.5 text-xs text-[var(--text-muted)]">{{ stamp(upcoming(row)!.validFrom) }}</p>
        </template>
        <span v-else class="text-[var(--text-muted)]">—</span>
      </template>

      <template #row-actions="{ row }">
        <div class="flex justify-end gap-1">
          <UButton
            v-if="canReadHistory"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-history"
            @click="viewHistory(row)"
          >
            <span class="sr-only">Ver histórico de {{ row.sku }}</span>
          </UButton>
          <UButton
            v-if="node"
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-calendar-plus"
            @click="startSchedule(row)"
          >
            Programar
          </UButton>
          <UButton
            v-if="cloudflare && (confirmedD1?.capabilities.priceSchedule || confirmedD1?.capabilities.priceCancel)"
            size="xs"
            color="neutral"
            variant="outline"
            @click="openGoverned(row)"
            >Gestionar vigencias</UButton
          >
        </div>
      </template>
    </UiDataTable>

    <!-- Programar vigencia -->
    <UModal
      v-if="node"
      :open="Boolean(editing)"
      title="Programar un precio"
      @update:open="(value) => !value && (editing = null)"
    >
      <template #body>
        <form v-if="editing" id="price-form" class="space-y-5" @submit.prevent="schedule">
          <div>
            <p class="font-semibold text-[var(--text-strong)]">{{ editing.product }}</p>
            <p class="text-sm text-[var(--text-muted)]">
              {{ editing.format }} · <span class="font-mono">{{ editing.sku }}</span> · ahora
              <span class="tabular font-semibold">{{ formatPrice(editing.grossCents) }}</span>
            </p>
          </div>

          <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
            <UFormField label="Nuevo precio (IVA incluido)" required>
              <UInput v-model.number="form.gross" type="number" min="0.01" step="0.01" required class="w-full" />
            </UFormField>
            <UFormField label="Precio anterior" hint="Para mostrar el tachado. Opcional.">
              <UInput v-model.number="form.compareAt" type="number" min="0.01" step="0.01" class="w-full" />
            </UFormField>
            <UFormField label="Vigente desde" required>
              <UInput v-model="form.validFrom" type="datetime-local" required class="w-full" />
            </UFormField>
            <UFormField label="Motivo" required hint="Queda en la auditoría">
              <UInput v-model="form.reason" required placeholder="Campaña, tarifa de proveedor…" class="w-full" />
            </UFormField>
          </div>

          <div>
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-semibold text-[var(--text-strong)]">Tramos por volumen</h3>
              <UButton
                type="button"
                size="xs"
                color="neutral"
                variant="outline"
                icon="i-lucide-plus"
                @click="form.tiers.push({ minimumQuantity: null, unitGross: null })"
              >
                Añadir tramo
              </UButton>
            </div>
            <p class="mt-1 text-xs text-[var(--text-muted)]">
              «A partir de N unidades, X €/ud». Es el argumento de venta en B2B y hoy no hay ninguna referencia que lo
              use.
            </p>
            <div v-for="(tier, index) in form.tiers" :key="index" class="mt-2 flex items-end gap-2">
              <UFormField label="Desde unidades" class="flex-1">
                <UInput v-model.number="tier.minimumQuantity" type="number" min="1" required class="w-full" />
              </UFormField>
              <UFormField label="Precio unitario" class="flex-1">
                <UInput v-model.number="tier.unitGross" type="number" min="0.01" step="0.01" required class="w-full" />
              </UFormField>
              <UButton
                type="button"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                :aria-label="`Quitar el tramo ${index + 1}`"
                @click="form.tiers.splice(index, 1)"
              />
            </div>
          </div>

          <div class="rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] p-3 text-sm">
            <span class="text-[var(--text-muted)]">Quedará en</span>
            <strong class="tabular ml-1">{{ formatPrice(Math.round(Number(form.gross || 0) * 100)) }}</strong>
            <span class="text-[var(--text-muted)]">
              desde {{ form.validFrom ? stamp(form.validFrom) : '—' }}
              <template v-if="form.tiers.length">
                · {{ form.tiers.length }} {{ form.tiers.length === 1 ? 'tramo' : 'tramos' }}
              </template>
            </span>
          </div>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="editing = null">Cancelar</UButton>
          <UButton type="submit" form="price-form" :loading="saving" icon="i-lucide-calendar-check">
            Programar precio
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- Histórico -->
    <UModal
      :open="Boolean(viewing) && canReadHistory"
      title="Histórico de precios"
      @update:open="(value) => !value && closeHistory()"
    >
      <template #body>
        <div v-if="viewing">
          <p class="font-semibold text-[var(--text-strong)]">{{ viewing.product }}</p>
          <p class="text-sm text-[var(--text-muted)]">
            {{ viewing.format }} · <span class="font-mono">{{ viewing.sku }}</span>
          </p>

          <p
            v-if="cloudflare && historyStatus === 'pending'"
            role="status"
            class="mt-4 text-sm text-[var(--text-muted)]"
          >
            Cargando el histórico…
          </p>
          <div v-else-if="cloudflare && historyStatus === 'error'" role="alert" class="mt-4 space-y-3">
            <p class="text-sm text-[var(--text-muted)]">No hemos podido cargar el histórico.</p>
            <UButton color="neutral" variant="outline" icon="i-lucide-rotate-cw" @click="loadHistory()">
              Reintentar histórico
            </UButton>
          </div>
          <ul v-else-if="history.length" class="mt-4 divide-y divide-[var(--border)]">
            <li v-for="version in history" :key="version.id" class="py-3">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class="tabular font-semibold text-[var(--text-strong)]">
                  {{ displayPrice(version.grossCents, historyItem?.currency) }}
                </span>
                <UBadge
                  variant="subtle"
                  :color="version.status === 'cancelled' ? 'neutral' : isUpcoming(version) ? 'warning' : 'success'"
                >
                  {{ version.status === 'cancelled' ? 'Cancelado' : isUpcoming(version) ? 'Programado' : 'Aplicado' }}
                </UBadge>
                <UButton
                  v-if="node && isUpcoming(version)"
                  size="xs"
                  color="error"
                  variant="ghost"
                  @click="cancelling = version"
                >
                  Cancelar
                </UButton>
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
          <p v-else class="mt-4 text-sm text-[var(--text-muted)]">
            Esta referencia no tiene cambios de precio todavía.
          </p>

          <div v-if="cloudflare && historyPagination" class="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p class="text-xs text-[var(--text-muted)]">
              {{ historyPagination.total }} {{ historyPagination.total === 1 ? 'versión' : 'versiones' }} · página
              {{ historyPagination.page }} de
              {{ historyPagination.pages || 1 }}
            </p>
            <div class="flex gap-2">
              <UButton
                color="neutral"
                variant="outline"
                :disabled="historyStatus === 'pending' || historyPagination.page <= 1"
                @click="loadHistory(historyPagination!.page - 1)"
              >
                Histórico anterior
              </UButton>
              <UButton
                color="neutral"
                variant="outline"
                :disabled="historyStatus === 'pending' || historyPagination.page >= historyPagination.pages"
                @click="loadHistory(historyPagination!.page + 1)"
              >
                Histórico siguiente
              </UButton>
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="closeHistory()">Cerrar histórico</UButton>
      </template>
    </UModal>

    <!-- Cancelar programación -->
    <UModal
      v-if="node"
      :open="Boolean(cancelling)"
      title="Cancelar el precio programado"
      @update:open="(value) => !value && (cancelling = null)"
    >
      <template #body>
        <div v-if="cancelling" class="space-y-4">
          <p class="text-[var(--text)]">
            No llegará a aplicarse el precio de
            <strong class="tabular">{{ formatPrice(cancelling.grossCents) }}</strong> previsto para
            {{ stamp(cancelling.validFrom) }}. El precio vigente se mantiene.
          </p>
          <UFormField
            label="Motivo"
            required
            :error="cancelReason.trim().length && cancelReason.trim().length < 3 ? 'Al menos 3 caracteres.' : ''"
          >
            <UInput v-model="cancelReason" class="w-full" placeholder="Por ejemplo: la campaña se ha aplazado" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="cancelling = null">Volver</UButton>
          <UButton color="error" :disabled="cancelReason.trim().length < 3" :loading="saving" @click="confirmCancel">
            Cancelar programación
          </UButton>
        </div>
      </template>
    </UModal>
    <UModal
      v-if="cloudflare"
      :open="!!governed"
      title="Gestionar vigencias de precio"
      @update:open="(value) => !value && (governed = null)"
    >
      <template #body>
        <GovernedPriceEditor
          v-if="governed"
          :key="governed.id"
          :variant-legacy-id="governed.id"
          :runtime="runtime"
          :authorize="authorizePrice"
          :refresh-list="reloadList"
        />
      </template>
      <template #footer
        ><UButton type="button" color="neutral" variant="ghost" @click="governed = null"
          >Cerrar gestión de vigencias</UButton
        ></template
      >
    </UModal>
  </div>
</template>
