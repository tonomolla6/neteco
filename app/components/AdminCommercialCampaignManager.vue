<script setup lang="ts">
import { computed, ref, onMounted, type Ref } from 'vue'
import {
  CAMPAIGN_ASSET_TYPES,
  CAMPAIGN_CHANNEL_TYPES,
  CAMPAIGN_AUDIENCES,
  type CampaignAssetType,
  type CommercialCampaign,
  type CampaignLinkedAsset,
  type CampaignConflict,
  type CommercialCalendarFeed
} from '~~/shared/commercial-campaigns'

const requestFetch = useRequestFetch()

const campaigns = ref<CommercialCampaign[]>([])
const selectedCampaign = ref<
  (CommercialCampaign & { linkedAssets: CampaignLinkedAsset[]; conflicts: CampaignConflict[] }) | null
>(null)
const calendarFeed = ref<CommercialCalendarFeed | null>(null)
const activeMonth = ref('2026-11')

const loading = ref(false)
const errorMessage = ref('')
const activeTab = ref<'campaigns' | 'calendar' | 'conflicts'>('campaigns')

// Create campaign modal
const showCreateModal = ref(false)
const newCode = ref('')
const newName = ref('')
const newDesc = ref('')
const newChannel = ref<'omnichannel' | 'web' | 'email' | 'mobile'>('omnichannel')
const newAudience = ref<'all' | 'b2b' | 'b2c' | 'vip' | 'new_customers'>('all')
const newPriority = ref(50)
const newStartAt = ref('2026-11-01T00:00:00Z')
const newEndAt = ref('2026-11-15T23:59:59Z')

// Link asset modal
const showLinkModal = ref(false)
const linkType = ref<CampaignAssetType>('banner')
const linkAssetId = ref('')
const linkAssetName = ref('')
const linkSlot = ref('home_hero')
const linkStartAt = ref('2026-11-01T00:00:00Z')
const linkEndAt = ref('2026-11-15T23:59:59Z')

function extractErrorCode(err: unknown, fallback: string): string {
  const code = (err as { data?: { error?: { code?: string } } })?.data?.error?.code
  return code ? `${fallback}. Vuelve a intentarlo.` : fallback
}

async function loadCampaigns() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/campaigns')) as { campaigns: CommercialCampaign[] }
    campaigns.value = res.campaigns
  } catch (err: unknown) {
    errorMessage.value = extractErrorCode(err, 'Error al cargar campañas')
  } finally {
    loading.value = false
  }
}

async function loadCampaignDetail(id: string) {
  try {
    const res = (await requestFetch(`/api/admin/campaigns/${id}`)) as CommercialCampaign & {
      linkedAssets: CampaignLinkedAsset[]
      conflicts: CampaignConflict[]
    }
    selectedCampaign.value = res
  } catch (err: unknown) {
    errorMessage.value = extractErrorCode(err, 'Error al cargar detalle')
  }
}

async function loadCalendarFeed() {
  try {
    const res = (await requestFetch(
      `/api/admin/campaigns/calendar?month=${activeMonth.value}`
    )) as CommercialCalendarFeed
    calendarFeed.value = res
  } catch (err: unknown) {
    errorMessage.value = extractErrorCode(err, 'Error al cargar calendario')
  }
}

async function handleCreateCampaign() {
  if (!newCode.value || !newName.value) return
  try {
    await requestFetch('/api/admin/campaigns', {
      method: 'POST',
      body: {
        commandId: crypto.randomUUID(),
        code: newCode.value,
        name: newName.value,
        description: newDesc.value,
        channelType: newChannel.value,
        targetAudience: newAudience.value,
        priority: newPriority.value,
        startAt: newStartAt.value,
        endAt: newEndAt.value
      }
    })
    showCreateModal.value = false
    await loadCampaigns()
    await loadCalendarFeed()
  } catch (err: unknown) {
    errorMessage.value = extractErrorCode(err, 'Error al crear campaña')
  }
}

async function handleLinkAsset() {
  if (!selectedCampaign.value || !linkAssetId.value || !linkAssetName.value) return
  try {
    await requestFetch(`/api/admin/campaigns/${selectedCampaign.value.id}/assets`, {
      method: 'POST',
      body: {
        commandId: crypto.randomUUID(),
        assetType: linkType.value,
        assetId: linkAssetId.value,
        assetName: linkAssetName.value,
        placementOrSlot: linkSlot.value,
        startAt: linkStartAt.value,
        endAt: linkEndAt.value
      }
    })
    showLinkModal.value = false
    await loadCampaignDetail(selectedCampaign.value.id)
    await loadCalendarFeed()
  } catch (err: unknown) {
    errorMessage.value = extractErrorCode(err, 'Error al vincular elemento')
  }
}

async function handleUnlinkAsset(assetId: string) {
  if (!selectedCampaign.value) return
  try {
    await requestFetch(`/api/admin/campaigns/${selectedCampaign.value.id}/assets/${assetId}`, {
      method: 'DELETE'
    })
    await loadCampaignDetail(selectedCampaign.value.id)
    await loadCalendarFeed()
  } catch (err: unknown) {
    errorMessage.value = extractErrorCode(err, 'Error al desvincular elemento')
  }
}

const CHANNEL_LABELS: Record<string, string> = {
  omnichannel: 'Todos los canales',
  web: 'Web',
  email: 'Correo',
  mobile: 'Móvil'
}
const AUDIENCE_LABELS: Record<string, string> = {
  all: 'Todos los clientes',
  b2b: 'Empresas',
  b2c: 'Particulares',
  vip: 'Clientes VIP',
  new_customers: 'Clientes nuevos'
}
const ASSET_LABELS: Record<string, string> = {
  banner: 'Banner',
  promotion: 'Promoción',
  modal: 'Ventana emergente',
  email: 'Correo',
  landing: 'Página de campaña'
}
const CONFLICT_LABELS: Record<string, string> = {
  banner_slot_overlap: 'Banners en el mismo espacio',
  modal_collision: 'Ventanas emergentes coincidentes',
  promotion_clash: 'Promociones incompatibles',
  email_schedule_fatigue: 'Demasiados correos seguidos',
  date_inconsistency: 'Fechas incoherentes'
}
const STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  scheduled: 'Programada',
  active: 'Activa',
  paused: 'En pausa',
  completed: 'Finalizada',
  cancelled: 'Cancelada'
}
const label = (map: Record<string, string>, code: string) => map[code] ?? adminHumanize(code)

// Estado de interfaz: búsqueda, filtro, panel de detalle y confirmación.
const search = ref('')
const statusFilter = ref('all')
const statusOptions = computed(() => [
  { value: 'all', label: 'Todas', count: campaigns.value.length },
  ...['active', 'scheduled', 'draft', 'completed'].map((value) => ({
    value,
    label: `${STATUS_LABELS[value]}s`.replace('Borradors', 'Borradores'),
    count: campaigns.value.filter((entry) => entry.status === value).length
  }))
])
const filteredCampaigns = computed(() => {
  const term = search.value.toLowerCase()
  return campaigns.value.filter(
    (entry) =>
      (statusFilter.value === 'all' || entry.status === statusFilter.value) &&
      (!term || entry.name.toLowerCase().includes(term) || entry.code.toLowerCase().includes(term))
  )
})
const sortKey = ref('')
function clearFilters() {
  search.value = ''
  statusFilter.value = 'all'
}
const columns = [
  { key: 'name', label: 'Campaña', sortable: true },
  { key: 'channelType', label: 'Canal', hideOnMobile: true },
  { key: 'targetAudience', label: 'Público', hideOnMobile: true },
  { key: 'startAt', label: 'Vigencia', sortable: true },
  { key: 'priority', label: 'Prioridad', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'status', label: 'Estado' }
]
const tabs = computed(() => [
  { value: 'campaigns', label: 'Campañas', count: campaigns.value.length },
  { value: 'calendar', label: 'Calendario comercial' }
])
const tabModel = computed({
  get: (): string => activeTab.value,
  set: (value: string) => {
    activeTab.value = value === 'calendar' ? 'calendar' : 'campaigns'
  }
})
const activeConflicts = computed(() => calendarFeed.value?.activeConflicts ?? [])
const calendarDays = computed(() => calendarFeed.value?.days ?? [])
const detailOpen = computed({
  get: () => selectedCampaign.value !== null,
  set: (open: boolean) => {
    if (!open) {
      selectedCampaign.value = null
      showLinkModal.value = false
    }
  }
})
const assetToUnlink = ref<CampaignLinkedAsset | null>(null)
const confirmUnlink = computed({
  get: () => assetToUnlink.value !== null,
  set: (open: boolean) => {
    if (!open) assetToUnlink.value = null
  }
})
async function confirmUnlinkAsset() {
  const asset = assetToUnlink.value
  assetToUnlink.value = null
  if (asset) await handleUnlinkAsset(asset.id)
}
/** Los campos de fecha editan solo el día; el valor enviado conserva el formato ISO original. */
function dayModel(target: Ref<string>, endOfDay: boolean) {
  return computed({
    get: () => target.value.slice(0, 10),
    set: (day: string) => {
      if (day) target.value = `${day}T${endOfDay ? '23:59:59' : '00:00:00'}Z`
    }
  })
}
const newStartDay = dayModel(newStartAt, false)
const newEndDay = dayModel(newEndAt, true)
const linkStartDay = dayModel(linkStartAt, false)
const linkEndDay = dayModel(linkEndAt, true)

onMounted(() => {
  void loadCampaigns()
  void loadCalendarFeed()
})
</script>

<template>
  <div class="admin-commercial-campaigns adm-stack" aria-label="Gestor de campañas comerciales">
    <AdminPageActions>
      <AdminButton variant="primary" icon="i-lucide-plus" @click="showCreateModal = true">Nueva campaña</AdminButton>
    </AdminPageActions>

    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
    />

    <UAlert
      v-if="activeConflicts.length"
      color="warning"
      variant="subtle"
      icon="i-lucide-calendar-x"
      :title="`Hay ${activeConflicts.length} ${activeConflicts.length === 1 ? 'coincidencia' : 'coincidencias'} entre campañas este mes`"
    >
      <template #description>
        <ul class="space-y-1">
          <li v-for="c in activeConflicts" :key="c.conflictId" class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <AdminBadge :tone="c.severity === 'critical' ? 'danger' : 'warning'">
              {{ c.severity === 'critical' ? 'Grave' : 'Aviso' }}
            </AdminBadge>
            <span class="font-semibold">{{ label(CONFLICT_LABELS, c.type) }}:</span>
            <span>{{ c.message }}</span>
          </li>
        </ul>
      </template>
    </UAlert>

    <AdminTabs v-model="tabModel" :tabs="tabs" label="Pestañas de campañas" />

    <section v-if="activeTab === 'campaigns'" aria-label="Lista de campañas">
      <AdminTable
        v-model:sort-key="sortKey"
        :rows="filteredCampaigns"
        :columns="columns"
        :row-key="(row) => row.id"
        :status="loading ? 'pending' : 'idle'"
        :filtered="Boolean(search) || statusFilter !== 'all'"
        empty-title="Todavía no hay campañas"
        empty-description="Crea la primera campaña para coordinar banners, promociones y correos en unas mismas fechas."
        empty-icon="i-lucide-megaphone"
        class="[&_tbody_tr]:cursor-pointer"
        @row-click="(row) => loadCampaignDetail(row.id)"
        @clear-filters="clearFilters"
      >
        <template #toolbar>
          <AdminToolbar v-model:search="search" placeholder="Buscar por nombre o código…">
            <AdminFilters v-model="statusFilter" :options="statusOptions" label="Filtrar por estado" />
          </AdminToolbar>
        </template>
        <template #cell-name="{ row }">
          <p class="font-semibold text-[var(--text-strong)]">{{ row.name }}</p>
          <p class="adm-help">{{ row.code }}</p>
        </template>
        <template #cell-channelType="{ row }">{{ label(CHANNEL_LABELS, row.channelType) }}</template>
        <template #cell-targetAudience="{ row }">{{ label(AUDIENCE_LABELS, row.targetAudience) }}</template>
        <template #cell-startAt="{ row }">{{ adminDate(row.startAt) }} – {{ adminDate(row.endAt) }}</template>
        <template #cell-status="{ row }">
          <AdminBadge :tone="adminStatusTone(row.status)">{{ label(STATUS_LABELS, row.status) }}</AdminBadge>
        </template>
        <template #actions="{ row }">
          <AdminButton size="sm" variant="ghost" @click="loadCampaignDetail(row.id)">Ver elementos</AdminButton>
        </template>
        <template #empty-action>
          <AdminButton variant="primary" icon="i-lucide-plus" @click="showCreateModal = true">
            Nueva campaña
          </AdminButton>
        </template>
      </AdminTable>
    </section>

    <section v-if="activeTab === 'calendar'" aria-label="Calendario comercial">
      <AdminCard title="Calendario comercial mensual" description="Campañas y elementos activos cada día del mes.">
        <template #actions>
          <label for="commercial-calendar-month" class="adm-label">Mes</label>
          <input
            id="commercial-calendar-month"
            v-model="activeMonth"
            type="month"
            class="adm-input w-auto"
            @change="loadCalendarFeed"
          />
        </template>
        <AdminEmptyState
          v-if="!calendarDays.length"
          compact
          icon="i-lucide-calendar"
          title="No hay datos de este mes"
        />
        <div v-else class="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <div
            v-for="d in calendarDays"
            :key="d.date"
            class="flex min-h-[5.5rem] flex-col gap-1 rounded-[var(--radius-control)] border border-[var(--border)] p-2 text-xs"
            :class="d.campaignsCount > 0 ? 'bg-[var(--surface)]' : 'bg-[var(--surface-sunken)]'"
          >
            <div class="flex items-center justify-between gap-1">
              <span class="font-semibold text-[var(--text-strong)]">{{ d.date.slice(8, 10) }}</span>
              <AdminBadge v-if="d.conflicts.length" tone="warning" title="Coincidencia detectada"
                >Coincidencia</AdminBadge
              >
            </div>
            <div class="flex-1 space-y-1">
              <div
                v-for="c in d.campaigns"
                :key="c.id"
                class="truncate rounded bg-neteco-50 px-1.5 py-0.5 text-neteco-900"
                :title="c.name"
              >
                {{ c.name }}
              </div>
            </div>
            <p v-if="d.assets.length" class="text-[var(--text-muted)]">
              {{ d.assets.length }} {{ d.assets.length === 1 ? 'elemento' : 'elementos' }}
            </p>
          </div>
        </div>
      </AdminCard>
    </section>

    <!-- Detalle de la campaña y elementos vinculados -->
    <AdminDrawer
      v-model:open="detailOpen"
      wide
      :title="selectedCampaign?.name ?? 'Campaña'"
      :description="selectedCampaign?.description || undefined"
    >
      <div v-if="selectedCampaign" class="adm-stack" aria-label="Detalle de campaña y elementos vinculados">
        <dl class="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <div>
            <dt class="adm-help">Estado</dt>
            <dd>
              <AdminBadge :tone="adminStatusTone(selectedCampaign.status)">
                {{ label(STATUS_LABELS, selectedCampaign.status) }}
              </AdminBadge>
            </dd>
          </div>
          <div>
            <dt class="adm-help">Canal</dt>
            <dd>{{ label(CHANNEL_LABELS, selectedCampaign.channelType) }}</dd>
          </div>
          <div>
            <dt class="adm-help">Público</dt>
            <dd>{{ label(AUDIENCE_LABELS, selectedCampaign.targetAudience) }}</dd>
          </div>
          <div>
            <dt class="adm-help">Vigencia</dt>
            <dd>{{ adminDate(selectedCampaign.startAt) }} – {{ adminDate(selectedCampaign.endAt) }}</dd>
          </div>
        </dl>

        <AdminCard
          :title="`Elementos vinculados (${selectedCampaign.linkedAssets.length})`"
          description="Banners, promociones, ventanas emergentes, correos y páginas que forman la campaña."
          flush
        >
          <template #actions>
            <AdminButton v-if="!showLinkModal" size="sm" icon="i-lucide-link" @click="showLinkModal = true">
              Vincular elemento
            </AdminButton>
          </template>
          <AdminEmptyState
            v-if="selectedCampaign.linkedAssets.length === 0"
            compact
            icon="i-lucide-link"
            title="Sin elementos vinculados"
            description="Añade los banners, promociones, ventanas emergentes, correos o páginas de esta campaña."
          />
          <ul v-else class="adm-list" role="list">
            <li v-for="a in selectedCampaign.linkedAssets" :key="a.id">
              <div class="min-w-0 flex-1">
                <p class="adm-list__title">
                  {{ a.assetName }}
                  <AdminBadge tone="info" plain>{{ label(ASSET_LABELS, a.assetType) }}</AdminBadge>
                </p>
                <p class="adm-help">
                  <template v-if="a.placementOrSlot">{{ a.placementOrSlot }} · </template>
                  {{ adminDate(a.startAt) }} – {{ adminDate(a.endAt) }}
                </p>
              </div>
              <AdminButton size="sm" variant="danger-soft" @click="assetToUnlink = a">Desvincular</AdminButton>
            </li>
          </ul>
        </AdminCard>

        <AdminCard v-if="showLinkModal" title="Vincular elemento a la campaña">
          <div class="adm-stack">
            <AdminFormField v-slot="{ id }" label="Tipo de elemento">
              <select :id="id" v-model="linkType">
                <option v-for="t in CAMPAIGN_ASSET_TYPES" :key="t" :value="t">{{ label(ASSET_LABELS, t) }}</option>
              </select>
            </AdminFormField>
            <div class="adm-form-grid">
              <AdminFormField
                v-slot="{ id }"
                label="Referencia"
                help="Identificador del elemento, por ejemplo banner-hero-5l."
                required
              >
                <input :id="id" v-model="linkAssetId" type="text" placeholder="banner-hero-5l" />
              </AdminFormField>
              <AdminFormField v-slot="{ id }" label="Nombre descriptivo" required>
                <input :id="id" v-model="linkAssetName" type="text" placeholder="Banner principal de portada" />
              </AdminFormField>
            </div>
            <AdminFormField
              v-slot="{ id }"
              label="Ubicación o dirección"
              help="Espacio de la web donde aparece o dirección de la página."
            >
              <input :id="id" v-model="linkSlot" type="text" placeholder="home_hero o /landing-quimicos" />
            </AdminFormField>
            <div class="adm-form-grid">
              <AdminFormField v-slot="{ id }" label="Desde">
                <input :id="id" v-model="linkStartDay" type="date" />
              </AdminFormField>
              <AdminFormField v-slot="{ id }" label="Hasta">
                <input :id="id" v-model="linkEndDay" type="date" />
              </AdminFormField>
            </div>
          </div>
          <template #footer>
            <AdminButton @click="showLinkModal = false">Cancelar</AdminButton>
            <AdminButton variant="primary" :disabled="!linkAssetId || !linkAssetName" @click="handleLinkAsset">
              Vincular elemento
            </AdminButton>
          </template>
        </AdminCard>
      </div>
      <template #footer>
        <AdminButton @click="detailOpen = false">Cerrar</AdminButton>
      </template>
    </AdminDrawer>

    <!-- Nueva campaña -->
    <AdminDrawer v-model:open="showCreateModal" title="Nueva campaña comercial">
      <div class="adm-stack">
        <AdminFormField v-slot="{ id }" label="Nombre" required>
          <input :id="id" v-model="newName" type="text" placeholder="Campaña descuento hostelería" />
        </AdminFormField>
        <AdminFormField
          v-slot="{ id }"
          label="Código"
          help="Identificador corto en minúsculas y con guiones, sin espacios."
          required
        >
          <input :id="id" v-model="newCode" type="text" placeholder="camp-quimicos-2026" />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Descripción">
          <textarea :id="id" v-model="newDesc" rows="2" placeholder="Objetivo y detalle comercial"></textarea>
        </AdminFormField>
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Canal">
            <select :id="id" v-model="newChannel">
              <option v-for="ch in CAMPAIGN_CHANNEL_TYPES" :key="ch" :value="ch">
                {{ label(CHANNEL_LABELS, ch) }}
              </option>
            </select>
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Público">
            <select :id="id" v-model="newAudience">
              <option v-for="aud in CAMPAIGN_AUDIENCES" :key="aud" :value="aud">
                {{ label(AUDIENCE_LABELS, aud) }}
              </option>
            </select>
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Fecha de inicio">
            <input :id="id" v-model="newStartDay" type="date" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Fecha de fin">
            <input :id="id" v-model="newEndDay" type="date" />
          </AdminFormField>
        </div>
        <AdminFormField
          v-slot="{ id }"
          label="Prioridad"
          help="De 1 a 100. Si dos campañas coinciden, se muestra antes la de mayor prioridad."
        >
          <input :id="id" v-model.number="newPriority" type="number" min="1" max="100" />
        </AdminFormField>
      </div>
      <template #footer>
        <AdminButton @click="showCreateModal = false">Cancelar</AdminButton>
        <AdminButton variant="primary" :disabled="!newCode || !newName" @click="handleCreateCampaign">
          Crear campaña
        </AdminButton>
      </template>
    </AdminDrawer>

    <AdminConfirm
      v-model:open="confirmUnlink"
      title="Desvincular elemento"
      :description="`«${assetToUnlink?.assetName ?? ''}» dejará de formar parte de esta campaña.`"
      confirm-label="Desvincular"
      danger
      @confirm="confirmUnlinkAsset"
    />
  </div>
</template>
