<script setup lang="ts">
import { ref, onMounted } from 'vue'

const request = useRequestFetch()

interface Market {
  code: string
  name: string
  defaultLocale: string
  currency: string
}

interface MarketConfig {
  id?: string
  productId: string
  marketCode: string
  version: number
  isAvailable: number | boolean
  availabilityStatus: string
  minOrderQuantity: number
  maxOrderQuantity?: number | null
  locale: string
  title: string
  description: string
  slug: string
  metaTitle?: string | null
  metaDescription?: string | null
  usageInstructions?: string | null
  isCompliant: number | boolean
  clpWarnings: string[]
  ufiCode?: string | null
  registrationNumber?: string | null
  sdsUrl?: string | null
  complianceNotes?: string | null
}

interface ShippingPolicy {
  marketCode: string
  version: number
  customsDeclaredValueRequired: number | boolean
  dutyCollectionType: 'exempt' | 'ddp' | 'dap'
  hsTariffCodeRequired: number | boolean
  deMinimisThresholdCents: number
  estimatedDutyRateBps: number
  customsHandlingFeeCents: number
  requiredDocuments: string[]
  adrAllowed: number | boolean
  maxHazardClass: string
  prohibitedUnNumbers: string[]
  maxDangerousGoodsVolumeLiters: number
  returnsPermitted: number | boolean
  returnWindowDays: number
  hazardousReturnsAllowed: number | boolean
  customerReturnFeeCents: number
}

const markets = ref<Market[]>([])
const selectedMarket = ref('ES')
const productId = ref('')
const configs = ref<MarketConfig[]>([])
const shippingPolicy = ref<ShippingPolicy | null>(null)
const loading = ref(false)
const error = ref('')
const successMessage = ref('')
const activeTab = ref<'catalog' | 'shipping'>('catalog')

// Form model for editing
const form = ref<MarketConfig>({
  productId: '',
  marketCode: 'ES',
  version: 0,
  isAvailable: true,
  availabilityStatus: 'available',
  minOrderQuantity: 1,
  maxOrderQuantity: null,
  locale: 'es-ES',
  title: '',
  description: '',
  slug: '',
  isCompliant: true,
  clpWarnings: []
})

const shippingForm = ref<ShippingPolicy>({
  marketCode: 'ES',
  version: 0,
  customsDeclaredValueRequired: false,
  dutyCollectionType: 'exempt',
  hsTariffCodeRequired: false,
  deMinimisThresholdCents: 15000,
  estimatedDutyRateBps: 0,
  customsHandlingFeeCents: 0,
  requiredDocuments: [],
  adrAllowed: true,
  maxHazardClass: 'unrestricted',
  prohibitedUnNumbers: [],
  maxDangerousGoodsVolumeLiters: 50,
  returnsPermitted: true,
  returnWindowDays: 14,
  hazardousReturnsAllowed: false,
  customerReturnFeeCents: 0
})

async function loadMarkets() {
  try {
    const data = await request<Market[]>('/api/storefront/markets')
    markets.value = data
    if (data.length > 0 && !selectedMarket.value) {
      selectedMarket.value = data[0]!.code
    }
  } catch {
    error.value = 'No se han podido cargar los mercados disponibles.'
  }
}

async function loadProductConfigs() {
  const pid = productId.value.trim()
  if (!pid) return
  loading.value = true
  error.value = ''
  successMessage.value = ''
  try {
    const data = await request<MarketConfig[]>(`/api/admin/market-catalog/products/${pid}`)
    configs.value = data

    // Match selected market config if exists
    const match = data.find((c) => c.marketCode === selectedMarket.value)
    if (match) {
      form.value = { ...match, isAvailable: Boolean(match.isAvailable), isCompliant: Boolean(match.isCompliant) }
    } else {
      const marketObj = markets.value.find((m) => m.code === selectedMarket.value)
      form.value = {
        productId: pid,
        marketCode: selectedMarket.value,
        version: 0,
        isAvailable: true,
        availabilityStatus: 'available',
        minOrderQuantity: 1,
        maxOrderQuantity: null,
        locale: marketObj?.defaultLocale ?? 'es-ES',
        title: '',
        description: '',
        slug: '',
        isCompliant: true,
        clpWarnings: []
      }
    }
  } catch {
    error.value = 'Error al cargar las configuraciones de mercado del producto.'
  } finally {
    loading.value = false
  }
}

async function loadShippingPolicy() {
  if (!selectedMarket.value) return
  loading.value = true
  error.value = ''
  try {
    const policy = await request<ShippingPolicy>(`/api/admin/international-shipping/${selectedMarket.value}`)
    shippingPolicy.value = policy
    shippingForm.value = {
      ...policy,
      customsDeclaredValueRequired: Boolean(policy.customsDeclaredValueRequired),
      hsTariffCodeRequired: Boolean(policy.hsTariffCodeRequired),
      adrAllowed: Boolean(policy.adrAllowed),
      returnsPermitted: Boolean(policy.returnsPermitted),
      hazardousReturnsAllowed: Boolean(policy.hazardousReturnsAllowed)
    }
  } catch {
    // 404 is normal if not configured yet
    shippingPolicy.value = null
  } finally {
    loading.value = false
  }
}

async function saveMarketConfig() {
  const pid = productId.value.trim()
  if (!pid) {
    error.value = 'Indique un ID de producto válido.'
    return
  }
  loading.value = true
  error.value = ''
  successMessage.value = ''

  try {
    await request(`/api/admin/market-catalog/products/${pid}`, {
      method: 'POST',
      body: {
        action: 'configure',
        expectedVersion: form.value.version,
        marketCode: selectedMarket.value,
        locale: form.value.locale,
        isAvailable: Boolean(form.value.isAvailable),
        availabilityStatus: form.value.availabilityStatus,
        minOrderQuantity: Number(form.value.minOrderQuantity),
        maxOrderQuantity: form.value.maxOrderQuantity ? Number(form.value.maxOrderQuantity) : undefined,
        title: form.value.title,
        description: form.value.description,
        slug: form.value.slug,
        isCompliant: Boolean(form.value.isCompliant),
        clpWarnings: form.value.clpWarnings,
        ufiCode: form.value.ufiCode || undefined,
        registrationNumber: form.value.registrationNumber || undefined,
        sdsUrl: form.value.sdsUrl || undefined,
        complianceNotes: form.value.complianceNotes || undefined
      }
    })
    successMessage.value = `Configuración guardada para mercado ${selectedMarket.value}.`
    await loadProductConfigs()
  } catch {
    error.value = 'Error al guardar la configuración de mercado.'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadMarkets()
})
</script>

<template>
  <div class="admin-market-catalog">
    <header class="header">
      <h2>Catálogo por Mercado y Cumplimiento Químico</h2>
      <p class="subtitle">
        Configure disponibilidad, contenido localizado y cumplimiento químico por país/mercado sin clonar productos.
      </p>
    </header>

    <div v-if="error" class="alert alert-error" role="alert">
      {{ error }}
    </div>

    <div v-if="successMessage" class="alert alert-success" role="status">
      {{ successMessage }}
    </div>

    <div class="controls-bar">
      <div class="field-group">
        <label for="marketCode">Mercado de destino:</label>
        <select id="marketCode" v-model="selectedMarket" name="marketCode" @change="loadProductConfigs">
          <option v-for="m in markets" :key="m.code" :value="m.code">
            {{ m.name }} ({{ m.code }} - {{ m.defaultLocale }})
          </option>
        </select>
      </div>

      <div class="field-group">
        <label for="productId">ID de Producto:</label>
        <div class="input-with-button">
          <input
            id="productId"
            v-model="productId"
            name="productId"
            type="text"
            placeholder="ej. p-1"
          />
          <button
            type="button"
            data-action="load-product"
            :disabled="loading || !productId"
            @click="loadProductConfigs"
          >
            Cargar
          </button>
        </div>
      </div>
    </div>

    <div class="tabs">
      <button
        type="button"
        :class="{ active: activeTab === 'catalog' }"
        @click="activeTab = 'catalog'"
      >
        Catálogo Localizado
      </button>
      <button
        type="button"
        :class="{ active: activeTab === 'shipping' }"
        @click="() => { activeTab = 'shipping'; loadShippingPolicy(); }"
      >
        Política de Envío Internacional
      </button>
    </div>

    <!-- Tab 1: Catálogo y Cumplimiento -->
    <section v-if="activeTab === 'catalog'" class="tab-content">
      <div v-if="!productId" class="empty-state">
        <p>Seleccione o introduzca un ID de producto para ver y editar su adaptación por mercado.</p>
      </div>

      <form v-else class="market-form" @submit.prevent="saveMarketConfig">
        <fieldset class="section-box">
          <legend>1. Disponibilidad en Mercado ({{ selectedMarket }})</legend>
          <div class="grid-2">
            <label class="checkbox-label">
              <input v-model="form.isAvailable" type="checkbox" name="isAvailable" />
              Disponible para venta en este mercado
            </label>
            <div>
              <label for="availabilityStatus">Estado de catálogo:</label>
              <select id="availabilityStatus" v-model="form.availabilityStatus">
                <option value="available">Disponible</option>
                <option value="preorder">Preventa</option>
                <option value="restricted">Distribución restringida</option>
                <option value="b2b_only">Exclusivo B2B</option>
                <option value="discontinued">Descatalogado</option>
              </select>
            </div>
            <div>
              <label for="minOrderQuantity">Cantidad mínima de pedido:</label>
              <input id="minOrderQuantity" v-model.number="form.minOrderQuantity" type="number" min="1" />
            </div>
          </div>
        </fieldset>

        <fieldset class="section-box">
          <legend>2. Contenido Localizado (Sin clonar producto)</legend>
          <div class="grid-2">
            <div>
              <label for="locale">Idioma / Locale:</label>
              <input id="locale" v-model="form.locale" type="text" />
            </div>
            <div>
              <label for="slug">Slug / URL amigable:</label>
              <input id="slug" v-model="form.slug" type="text" />
            </div>
            <div class="full-width">
              <label for="title">Título localizado:</label>
              <input id="title" v-model="form.title" type="text" />
            </div>
            <div class="full-width">
              <label for="description">Descripción detallada:</label>
              <textarea id="description" v-model="form.description" rows="3"></textarea>
            </div>
          </div>
        </fieldset>

        <fieldset class="section-box">
          <legend>3. Cumplimiento Químico y Regulatorio</legend>
          <div class="grid-2">
            <label class="checkbox-label">
              <input v-model="form.isCompliant" type="checkbox" name="isCompliant" />
              Homologado / Conforme a normativa del país
            </label>
            <div>
              <label for="ufiCode">Código UFI (Centro Toxicológico):</label>
              <input id="ufiCode" v-model="form.ufiCode" type="text" placeholder="UFI-XXXX-XXXX" />
            </div>
            <div>
              <label for="registrationNumber">Nº Registro Biocidas / REACH:</label>
              <input id="registrationNumber" v-model="form.registrationNumber" type="text" />
            </div>
            <div>
              <label for="sdsUrl">Ficha de Seguridad (FDS en idioma local):</label>
              <input id="sdsUrl" v-model="form.sdsUrl" type="url" placeholder="https://..." />
            </div>
          </div>
        </fieldset>

        <div class="actions">
          <button
            type="submit"
            data-action="save-market-config"
            :disabled="loading"
            class="primary-btn"
          >
            {{ loading ? 'Guardando...' : 'Guardar Configuración de Mercado' }}
          </button>
        </div>
      </form>
    </section>

    <!-- Tab 2: Política de Envíos Internacionales -->
    <section v-if="activeTab === 'shipping'" class="tab-content">
      <div class="section-box">
        <h3>Reglas Aduaneras, ADR y Devoluciones para {{ selectedMarket }}</h3>
        <p v-if="shippingPolicy">
          Versión de política: {{ shippingPolicy.version }} | Incoterm: {{ shippingPolicy.dutyCollectionType.toUpperCase() }}
        </p>
        <p v-else class="muted">
          No hay política aduanera específica configurada para este mercado (se aplican normas generales UE).
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.admin-market-catalog {
  padding: 1.5rem;
  font-family: inherit;
}
.header {
  margin-bottom: 1.5rem;
}
.subtitle {
  color: #64748b;
  font-size: 0.95rem;
}
.alert {
  padding: 0.75rem 1rem;
  border-radius: 4px;
  margin-bottom: 1rem;
}
.alert-error {
  background-color: #fee2e2;
  color: #991b1b;
  border: 1px solid #f87171;
}
.alert-success {
  background-color: #dcfce7;
  color: #166534;
  border: 1px solid #86efac;
}
.controls-bar {
  display: flex;
  gap: 1.5rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}
.field-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.input-with-button {
  display: flex;
  gap: 0.5rem;
}
.tabs {
  display: flex;
  gap: 0.5rem;
  border-bottom: 2px solid #e2e8f0;
  margin-bottom: 1.5rem;
}
.tabs button {
  background: none;
  border: none;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-weight: 500;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
}
.tabs button.active {
  border-bottom-color: #2563eb;
  color: #2563eb;
}
.section-box {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 1rem;
  margin-bottom: 1.5rem;
}
.section-box legend {
  font-weight: 600;
  padding: 0 0.5rem;
}
.grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1rem;
}
.full-width {
  grid-column: 1 / -1;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.empty-state {
  padding: 3rem;
  text-align: center;
  background-color: #f8fafc;
  border-radius: 6px;
  color: #64748b;
}
.actions {
  display: flex;
  justify-content: flex-end;
}
.primary-btn {
  background-color: #2563eb;
  color: white;
  padding: 0.6rem 1.2rem;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
}
.primary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
