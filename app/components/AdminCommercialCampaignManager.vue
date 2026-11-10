<script setup lang="ts">
import { ref, onMounted } from 'vue'
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
  return code ? `Error: ${code}` : fallback
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

onMounted(() => {
  void loadCampaigns()
  void loadCalendarFeed()
})
</script>

<template>
  <div class="admin-commercial-campaigns p-4 space-y-6 max-w-7xl mx-auto" aria-label="Gestor de Campañas Comerciales">
    <!-- Header -->
    <header class="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">Gestor de Campañas y Calendario Comercial</h1>
        <p class="text-sm text-gray-600">
          ADM-026: Banners, promociones, modales, emails y landings vinculados; conflictos de fechas visibles.
        </p>
      </div>

      <nav class="flex gap-2" aria-label="Pestañas de campañas">
        <button
          type="button"
          :class="[
            'px-3 py-1.5 rounded font-medium text-sm transition',
            activeTab === 'campaigns' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          ]"
          @click="activeTab = 'campaigns'"
        >
          Campañas y Canales
        </button>
        <button
          type="button"
          :class="[
            'px-3 py-1.5 rounded font-medium text-sm transition',
            activeTab === 'calendar' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          ]"
          @click="activeTab = 'calendar'"
        >
          Calendario Comercial
        </button>
      </nav>
    </header>

    <!-- Error message banner -->
    <div v-if="errorMessage" role="alert" class="p-3 bg-red-50 border border-red-300 text-red-800 rounded text-sm">
      {{ errorMessage }}
    </div>

    <!-- Active Conflicts Alert (If Any) -->
    <section
      v-if="calendarFeed?.activeConflicts?.length"
      class="p-4 bg-amber-50 border-2 border-amber-400 rounded-lg space-y-2"
    >
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-bold text-amber-900">
          Conflictos Comerciales y Colisiones de Fechas Detectados ({{ calendarFeed.activeConflicts.length }})
        </h2>
      </div>
      <ul class="divide-y divide-amber-200 text-xs">
        <li v-for="c in calendarFeed.activeConflicts" :key="c.conflictId" class="py-2 flex items-start justify-between">
          <div>
            <span class="font-bold text-red-700 mr-2">[{{ c.type.toUpperCase() }}]</span>
            <span class="text-gray-900">{{ c.message }}</span>
          </div>
          <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-200 text-amber-900 uppercase">
            {{ c.severity }}
          </span>
        </li>
      </ul>
    </section>

    <!-- TAB 1: Campaigns List & Details -->
    <div v-if="activeTab === 'campaigns'" class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- Left: Campaigns List -->
      <section class="lg:col-span-1 space-y-4 border-r pr-4" aria-label="Lista de Campañas">
        <div class="flex items-center justify-between">
          <h2 class="text-base font-bold text-gray-900">Campañas Registradas</h2>
          <button
            type="button"
            class="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium transition"
            @click="showCreateModal = true"
          >
            + Nueva Campaña
          </button>
        </div>

        <div v-if="loading" class="text-center py-4 text-xs text-gray-500">Cargando campañas…</div>

        <ul v-else class="space-y-2" role="list">
          <li
            v-for="c in campaigns"
            :key="c.id"
            class="p-3 border rounded-lg cursor-pointer transition"
            :class="
              selectedCampaign?.id === c.id
                ? 'border-blue-500 bg-blue-50/30 ring-1 ring-blue-500'
                : 'bg-white hover:bg-gray-50'
            "
            @click="loadCampaignDetail(c.id)"
          >
            <div class="flex items-center justify-between">
              <span class="text-xs font-mono font-bold text-gray-500">{{ c.code }}</span>
              <span class="px-2 py-0.5 text-[10px] font-semibold rounded bg-gray-100 text-gray-700 uppercase">{{
                c.status
              }}</span>
            </div>
            <h3 class="font-bold text-sm text-gray-900 mt-1">{{ c.name }}</h3>
            <p class="text-xs text-gray-500 mt-1">
              {{ c.startAt.slice(0, 10) }} al {{ c.endAt.slice(0, 10) }} · Prioridad: {{ c.priority }}
            </p>
          </li>
        </ul>
      </section>

      <!-- Right: Campaign Details & Linked Touchpoints -->
      <section class="lg:col-span-2 space-y-4" aria-label="Detalle de Campaña y Elementos Vinculados">
        <div v-if="selectedCampaign" class="bg-white p-5 border rounded-lg space-y-4">
          <div class="flex items-start justify-between border-b pb-3">
            <div>
              <span class="text-xs font-mono text-gray-400">{{ selectedCampaign.code }}</span>
              <h2 class="text-xl font-bold text-gray-900">{{ selectedCampaign.name }}</h2>
              <p class="text-xs text-gray-600 mt-1">{{ selectedCampaign.description }}</p>
            </div>
            <button
              type="button"
              class="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded text-xs font-medium transition"
              @click="showLinkModal = true"
            >
              + Vincular Elemento
            </button>
          </div>

          <!-- Linked Assets Categories -->
          <div>
            <h3 class="text-sm font-bold text-gray-800 mb-2">
              Canales y Elementos Vinculados ({{ selectedCampaign.linkedAssets.length }})
            </h3>
            <div
              v-if="selectedCampaign.linkedAssets.length === 0"
              class="text-xs text-gray-400 p-4 border border-dashed rounded text-center"
            >
              No hay elementos vinculados. Añade banners, promociones, modales, emails o landings.
            </div>

            <ul v-else class="divide-y border rounded-lg text-xs" role="list">
              <li v-for="a in selectedCampaign.linkedAssets" :key="a.id" class="p-3 flex items-center justify-between">
                <div>
                  <span
                    class="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-blue-100 text-blue-800 mr-2"
                  >
                    {{ a.assetType }}
                  </span>
                  <span class="font-semibold text-gray-900">{{ a.assetName }}</span>
                  <span v-if="a.placementOrSlot" class="text-gray-500 font-mono ml-2">({{ a.placementOrSlot }})</span>
                  <p class="text-gray-400 text-[10px] mt-0.5">
                    Fechas: {{ a.startAt.slice(0, 10) }} — {{ a.endAt.slice(0, 10) }}
                  </p>
                </div>

                <button
                  type="button"
                  class="text-red-600 hover:text-red-800 p-1"
                  title="Desvincular"
                  @click="handleUnlinkAsset(a.id)"
                >
                  Desvincular
                </button>
              </li>
            </ul>
          </div>
        </div>

        <div v-else class="text-center py-12 text-sm text-gray-400 border border-dashed rounded-lg">
          Selecciona una campaña para ver sus elementos vinculados (banners, promociones, modales, emails, landings).
        </div>
      </section>
    </div>

    <!-- TAB 2: Commercial Calendar View -->
    <section v-if="activeTab === 'calendar'" class="space-y-4" aria-label="Calendario Comercial">
      <div class="flex items-center justify-between bg-gray-50 p-3 rounded-lg border">
        <h2 class="text-sm font-bold text-gray-800">Calendario comercial mensual</h2>
        <div class="flex items-center gap-2">
          <label class="text-xs font-semibold text-gray-600">Mes:</label>
          <input
            v-model="activeMonth"
            type="month"
            class="px-2 py-1 border rounded text-xs bg-white font-medium"
            @change="loadCalendarFeed"
          />
        </div>
      </div>

      <!-- Calendar Grid -->
      <div class="grid grid-cols-7 gap-2">
        <div
          v-for="d in calendarFeed?.days"
          :key="d.date"
          class="p-2 border rounded min-h-[90px] flex flex-col justify-between text-xs transition"
          :class="{
            'bg-amber-50/50 border-amber-300': d.conflicts.length > 0,
            'bg-white': d.conflicts.length === 0,
            'border-blue-400 bg-blue-50/20': d.campaignsCount > 0
          }"
        >
          <div class="flex items-center justify-between">
            <span class="font-bold text-gray-700">{{ d.date.slice(8, 10) }}</span>
            <span v-if="d.conflicts.length" class="text-amber-600 font-bold text-[10px]" title="Conflicto detectado"
              >Conflicto</span
            >
          </div>

          <div class="space-y-1 mt-1">
            <div
              v-for="c in d.campaigns"
              :key="c.id"
              class="truncate px-1 py-0.5 rounded bg-blue-100 text-blue-900 text-[10px]"
            >
              {{ c.name }}
            </div>
          </div>

          <div class="text-[9px] text-gray-400 mt-1">{{ d.assets.length }} elementos</div>
        </div>
      </div>
    </section>

    <!-- Modal Create Campaign -->
    <div v-if="showCreateModal" class="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div class="bg-white rounded-lg p-6 max-w-md w-full space-y-4">
        <h3 class="text-lg font-bold text-gray-900">Crear Campaña Comercial</h3>
        <div>
          <label class="block text-xs font-semibold text-gray-700 mb-1">Código (slug):</label>
          <input
            v-model="newCode"
            type="text"
            class="w-full px-3 py-1.5 border rounded text-sm font-mono"
            placeholder="camp-quimicos-2026"
          />
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-700 mb-1">Nombre:</label>
          <input
            v-model="newName"
            type="text"
            class="w-full px-3 py-1.5 border rounded text-sm"
            placeholder="Campaña Descuento Hostelería"
          />
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-700 mb-1">Descripción:</label>
          <textarea
            v-model="newDesc"
            class="w-full px-3 py-1.5 border rounded text-sm"
            rows="2"
            placeholder="Detalle comercial"
          ></textarea>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-xs font-semibold text-gray-700 mb-1">Canal:</label>
            <select v-model="newChannel" class="w-full px-2 py-1.5 border rounded text-xs bg-white">
              <option v-for="ch in CAMPAIGN_CHANNEL_TYPES" :key="ch" :value="ch">{{ ch }}</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-700 mb-1">Audiencia:</label>
            <select v-model="newAudience" class="w-full px-2 py-1.5 border rounded text-xs bg-white">
              <option v-for="aud in CAMPAIGN_AUDIENCES" :key="aud" :value="aud">{{ aud }}</option>
            </select>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-xs font-semibold text-gray-700 mb-1">Fecha Inicio:</label>
            <input v-model="newStartAt" type="text" class="w-full px-2 py-1 border rounded text-xs" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-700 mb-1">Fecha Fin:</label>
            <input v-model="newEndAt" type="text" class="w-full px-2 py-1 border rounded text-xs" />
          </div>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" class="px-3 py-1.5 border rounded text-sm" @click="showCreateModal = false">
            Cancelar
          </button>
          <button
            type="button"
            class="px-3 py-1.5 bg-blue-600 text-white rounded text-sm font-medium"
            @click="handleCreateCampaign"
          >
            Crear Campaña
          </button>
        </div>
      </div>
    </div>

    <!-- Modal Link Asset -->
    <div v-if="showLinkModal" class="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div class="bg-white rounded-lg p-6 max-w-md w-full space-y-4">
        <h3 class="text-lg font-bold text-gray-900">Vincular Elemento a Campaña</h3>
        <div>
          <label class="block text-xs font-semibold text-gray-700 mb-1">Tipo de Elemento:</label>
          <select v-model="linkType" class="w-full px-3 py-1.5 border rounded text-sm bg-white uppercase">
            <option v-for="t in CAMPAIGN_ASSET_TYPES" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-700 mb-1">Identificador / Ref:</label>
          <input
            v-model="linkAssetId"
            type="text"
            class="w-full px-3 py-1.5 border rounded text-sm font-mono"
            placeholder="banner-hero-5l"
          />
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-700 mb-1">Nombre Descriptivo:</label>
          <input
            v-model="linkAssetName"
            type="text"
            class="w-full px-3 py-1.5 border rounded text-sm"
            placeholder="Banner Principal Portada"
          />
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-700 mb-1">Slot / Ubicación / URL:</label>
          <input
            v-model="linkSlot"
            type="text"
            class="w-full px-3 py-1.5 border rounded text-sm"
            placeholder="home_hero o /landing-quimicos"
          />
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-xs font-semibold text-gray-700 mb-1">Inicio:</label>
            <input v-model="linkStartAt" type="text" class="w-full px-2 py-1 border rounded text-xs" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-700 mb-1">Fin:</label>
            <input v-model="linkEndAt" type="text" class="w-full px-2 py-1 border rounded text-xs" />
          </div>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" class="px-3 py-1.5 border rounded text-sm" @click="showLinkModal = false">
            Cancelar
          </button>
          <button
            type="button"
            class="px-3 py-1.5 bg-green-600 text-white rounded text-sm font-medium"
            @click="handleLinkAsset"
          >
            Vincular Elemento
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
