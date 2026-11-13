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

function selectMarketAndLoad(code: string) {
  selectedMarket.value = code
  loadProductConfigs()
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
    const match = data.find((c) => c.marketCode === selectedMarket.value) ?? (data.length > 0 ? data[0] : undefined)
    if (match) {
      selectedMarket.value = match.marketCode
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
    error.value = 'No se ha podido cargar la ficha del producto en los mercados. Vuelve a intentarlo.'
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
    error.value = 'Escribe una referencia de producto válida.'
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
    successMessage.value = `Ficha guardada para el mercado ${selectedMarket.value}.`
    await loadProductConfigs()
  } catch {
    error.value = 'No se ha podido guardar la ficha del mercado. Vuelve a intentarlo.'
  } finally {
    loading.value = false
  }
}

const TABS = [
  { value: 'catalog', label: 'Ficha por mercado' },
  { value: 'shipping', label: 'Envío internacional' }
]
function setTab(value: string) {
  activeTab.value = value === 'shipping' ? 'shipping' : 'catalog'
  if (activeTab.value === 'shipping') loadShippingPolicy()
}
const DUTY_LABELS: Record<ShippingPolicy['dutyCollectionType'], string> = {
  exempt: 'Sin aranceles',
  ddp: 'Aranceles incluidos: los paga la tienda',
  dap: 'Aranceles a cargo del cliente en la entrega'
}

onMounted(() => {
  loadMarkets()
})
</script>

<template>
  <div class="adm-stack">
    <UAlert v-if="error" role="alert" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />
    <UAlert
      v-if="successMessage"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successMessage"
    />

    <AdminCard>
      <div class="adm-toolbar">
        <label for="marketCode" class="adm-label">Mercado</label>
        <select
          id="marketCode"
          v-model="selectedMarket"
          name="marketCode"
          class="adm-input"
          @change="loadProductConfigs"
        >
          <option v-for="m in markets" :key="m.code" :value="m.code">{{ m.name }} ({{ m.code }})</option>
        </select>
        <label for="productId" class="adm-label">Producto</label>
        <input
          id="productId"
          v-model="productId"
          name="productId"
          type="text"
          class="adm-input w-48"
          placeholder="Referencia del producto"
        />
        <button
          type="button"
          class="adm-btn adm-btn--secondary"
          data-action="load-product"
          :disabled="loading || !productId"
          @click="loadProductConfigs"
        >
          Cargar
        </button>
      </div>
    </AdminCard>

    <AdminTabs :model-value="activeTab" :tabs="TABS" label="Apartados del mercado" @update:model-value="setTab" />

    <!-- Ficha por mercado -->
    <template v-if="activeTab === 'catalog'">
      <AdminCard v-if="!productId" flush>
        <AdminEmptyState
          icon="i-lucide-globe"
          title="Elige un producto"
          description="Escribe la referencia de un producto y pulsa «Cargar» para ver y editar cómo se vende en cada mercado."
        />
      </AdminCard>

      <template v-else>
        <AdminCard v-if="configs.length > 0" title="Mercados configurados">
          <div class="flex flex-wrap gap-2">
            <button
              v-for="c in configs"
              :key="c.marketCode"
              type="button"
              class="adm-chip"
              :aria-pressed="c.marketCode === selectedMarket"
              @click="selectMarketAndLoad(c.marketCode)"
            >
              <strong>{{ c.marketCode }}</strong>
              <span>{{ c.title }}</span>
              <span v-if="c.ufiCode" class="adm-help">(UFI: {{ c.ufiCode }})</span>
              <AdminBadge :tone="c.isAvailable ? 'success' : 'neutral'" plain>
                {{ c.isAvailable ? 'Disponible' : 'No disponible' }}
              </AdminBadge>
            </button>
          </div>
        </AdminCard>

        <form class="adm-stack" @submit.prevent="saveMarketConfig">
          <AdminCard :title="`Disponibilidad en ${selectedMarket}`">
            <div class="adm-stack">
              <label class="adm-check">
                <input v-model="form.isAvailable" type="checkbox" name="isAvailable" />
                Disponible para la venta en este mercado
              </label>
              <div class="adm-form-grid">
                <AdminFormField v-slot="{ id }" label="Estado en el catálogo" for="availabilityStatus">
                  <select :id="id" v-model="form.availabilityStatus">
                    <option value="available">Disponible</option>
                    <option value="preorder">Preventa</option>
                    <option value="restricted">Distribución restringida</option>
                    <option value="b2b_only">Solo empresas</option>
                    <option value="discontinued">Descatalogado</option>
                  </select>
                </AdminFormField>
                <AdminFormField v-slot="{ id }" label="Cantidad mínima por pedido" for="minOrderQuantity">
                  <input :id="id" v-model.number="form.minOrderQuantity" type="number" min="1" />
                </AdminFormField>
              </div>
            </div>
          </AdminCard>

          <AdminCard title="Textos en el idioma del mercado" description="Se adapta la ficha sin duplicar el producto.">
            <div class="adm-stack">
              <div class="adm-form-grid">
                <AdminFormField v-slot="{ id }" label="Idioma" help="Por ejemplo es-ES o fr-FR." for="locale">
                  <input :id="id" v-model="form.locale" type="text" />
                </AdminFormField>
                <AdminFormField
                  v-slot="{ id }"
                  label="Dirección web"
                  help="Texto de la dirección de la ficha, en minúsculas y con guiones."
                  for="slug"
                >
                  <input :id="id" v-model="form.slug" type="text" />
                </AdminFormField>
              </div>
              <AdminFormField v-slot="{ id }" label="Título" for="title">
                <input :id="id" v-model="form.title" type="text" />
              </AdminFormField>
              <AdminFormField v-slot="{ id }" label="Descripción" for="description">
                <textarea :id="id" v-model="form.description" rows="3"></textarea>
              </AdminFormField>
            </div>
          </AdminCard>

          <AdminCard title="Normativa química del país">
            <div class="adm-stack">
              <label class="adm-check">
                <input v-model="form.isCompliant" type="checkbox" name="isCompliant" />
                Cumple la normativa del país
              </label>
              <div class="adm-form-grid">
                <AdminFormField
                  v-slot="{ id }"
                  label="Código UFI"
                  help="Identificador de la fórmula para el centro de toxicología."
                  for="ufiCode"
                >
                  <input :id="id" v-model="form.ufiCode" type="text" placeholder="UFI-XXXX-XXXX" />
                </AdminFormField>
                <AdminFormField v-slot="{ id }" label="N.º de registro (biocidas o REACH)" for="registrationNumber">
                  <input :id="id" v-model="form.registrationNumber" type="text" />
                </AdminFormField>
                <AdminFormField
                  v-slot="{ id }"
                  label="Ficha de datos de seguridad"
                  help="Enlace a la ficha en el idioma del mercado."
                  for="sdsUrl"
                >
                  <input :id="id" v-model="form.sdsUrl" type="url" placeholder="https://..." />
                </AdminFormField>
              </div>
            </div>
          </AdminCard>

          <div class="flex justify-end">
            <button type="submit" data-action="save-market-config" :disabled="loading" class="adm-btn adm-btn--primary">
              {{ loading ? 'Guardando…' : 'Guardar ficha del mercado' }}
            </button>
          </div>
        </form>
      </template>
    </template>

    <!-- Envío internacional -->
    <AdminCard
      v-if="activeTab === 'shipping'"
      :title="`Aduanas, mercancías peligrosas y devoluciones en ${selectedMarket}`"
    >
      <p v-if="shippingPolicy">
        {{ DUTY_LABELS[shippingPolicy.dutyCollectionType] ?? 'Aranceles sin definir' }} · configuración n.º
        {{ shippingPolicy.version }}
      </p>
      <p v-else class="adm-help">
        Este mercado no tiene reglas de aduana propias: se aplican las normas generales de la Unión Europea.
      </p>
    </AdminCard>
  </div>
</template>
