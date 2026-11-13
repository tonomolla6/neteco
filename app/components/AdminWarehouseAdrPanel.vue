<script setup lang="ts">
import { ref } from 'vue'
import type {
  GeneratedClpLabel,
  AdrTransportDocument,
  WarehouseHandlingInstructions
} from '~~/shared/warehouse-adr-assets'

const request = useRequestFetch()

// 1. CLP Label state
const labelVariantId = ref('var-cloro-5l')
const labelLotNumber = ref('LOT-202610-042')
const labelLoading = ref(false)
const labelResult = ref<GeneratedClpLabel | null>(null)
const labelError = ref<string | null>(null)

// 2. ADR Transport Document state
const transportItems = ref<
  Array<{ lotNumber: string; packagesCount: number; packageType: string; litersOrKgPerPackage: number }>
>([{ lotNumber: 'LOT-202610-042', packagesCount: 20, packageType: 'Jerricanes 5L (3H1)', litersOrKgPerPackage: 5 }])
const transportLoading = ref(false)
const transportResult = ref<AdrTransportDocument | null>(null)
const transportError = ref<string | null>(null)

// 3. Handling Instructions state
const handlingVariantId = ref('var-cloro-5l')
const handlingLoading = ref(false)
const handlingResult = ref<WarehouseHandlingInstructions | null>(null)
const handlingError = ref<string | null>(null)

async function generateLabel() {
  if (!labelVariantId.value || !labelLotNumber.value) return
  labelLoading.value = true
  labelResult.value = null
  labelError.value = null
  try {
    const res = await request<GeneratedClpLabel>('/api/warehouse/operational-assets/generate-label', {
      method: 'POST',
      body: {
        variantId: labelVariantId.value.trim(),
        lotNumber: labelLotNumber.value.trim()
      }
    })
    labelResult.value = res
  } catch (err: unknown) {
    const errorObj = err as { data?: { error?: { code?: string } } }
    const code = errorObj?.data?.error?.code
    if (code === 'qa_quarantine_blocked') {
      labelError.value =
        'Este lote está en cuarentena: no se puede etiquetar para enviarlo hasta que calidad lo libere.'
    } else if (code === 'qa_rejected_blocked') {
      labelError.value = 'Este lote fue rechazado en el control de calidad y no se puede etiquetar.'
    } else if (code === 'not_found') {
      labelError.value = 'No encontramos ese producto o ese lote. Revisa los dos códigos.'
    } else {
      labelError.value = 'No se ha podido generar la etiqueta. Vuelve a intentarlo.'
    }
  } finally {
    labelLoading.value = false
  }
}

async function generateTransportDoc() {
  if (transportItems.value.length === 0) return
  transportLoading.value = true
  transportResult.value = null
  transportError.value = null
  try {
    const res = await request<AdrTransportDocument>('/api/warehouse/operational-assets/transport-document', {
      method: 'POST',
      body: {
        commandId: crypto.randomUUID(),
        shipmentItems: transportItems.value
      }
    })
    transportResult.value = res
  } catch {
    transportError.value =
      'No se ha podido generar el documento de transporte. Revisa los números de lote y vuelve a intentarlo.'
  } finally {
    transportLoading.value = false
  }
}

function addTransportLine() {
  transportItems.value.push({
    lotNumber: '',
    packagesCount: 1,
    packageType: 'Caja',
    litersOrKgPerPackage: 5
  })
}

function removeTransportLine(index: number) {
  transportItems.value.splice(index, 1)
}

async function loadHandlingInstructions() {
  if (!handlingVariantId.value) return
  handlingLoading.value = true
  handlingResult.value = null
  handlingError.value = null
  try {
    const res = await request<{ instructions: WarehouseHandlingInstructions }>(
      `/api/warehouse/operational-assets/variant/${encodeURIComponent(handlingVariantId.value.trim())}`,
      { method: 'GET' }
    )
    handlingResult.value = res.instructions
  } catch {
    handlingError.value = 'No hay ficha de manipulación para ese producto. Revisa el código.'
  } finally {
    handlingLoading.value = false
  }
}
</script>

<template>
  <div class="adm-stack" data-testid="admin-warehouse-adr-panel">
    <div class="grid gap-5 lg:grid-cols-2">
      <!-- Etiqueta de peligro por lote -->
      <AdminCard
        title="Etiqueta de peligro por lote"
        description="Etiqueta reglamentaria (CLP). Solo se genera si calidad ha aprobado el lote."
        data-testid="clp-label-section"
      >
        <form class="adm-stack" @submit.prevent="generateLabel">
          <div class="adm-form-grid">
            <AdminFormField label="Código del producto" for="clp-variant">
              <input
                id="clp-variant"
                v-model="labelVariantId"
                type="text"
                class="adm-input w-full font-mono"
                placeholder="var-cloro-5l"
              />
            </AdminFormField>
            <AdminFormField label="Número de lote" for="clp-lot">
              <input
                id="clp-lot"
                v-model="labelLotNumber"
                type="text"
                class="adm-input w-full font-mono"
                placeholder="LOT-202610-042"
              />
            </AdminFormField>
          </div>
          <div>
            <button
              type="submit"
              :disabled="labelLoading || !labelVariantId || !labelLotNumber"
              class="adm-btn adm-btn--secondary"
              data-testid="btn-generate-label"
            >
              <UIcon
                :name="labelLoading ? 'i-lucide-loader-circle' : 'i-lucide-tag'"
                class="size-4 shrink-0"
                :class="labelLoading && 'animate-spin'"
              />
              {{ labelLoading ? 'Generando etiqueta…' : 'Generar etiqueta' }}
            </button>
          </div>
        </form>

        <UAlert
          v-if="labelError"
          class="mt-4"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="labelError"
          role="alert"
          data-testid="label-error"
        />

        <!-- Vista previa de la etiqueta -->
        <div
          v-if="labelResult"
          class="mt-5 rounded-[var(--radius-surface)] border border-[var(--border)] p-4"
          data-testid="clp-label-preview"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="adm-help">NETECO Professional</p>
              <h3 class="text-base font-semibold text-[var(--text-strong)]">{{ labelResult.productName }}</h3>
              <p>{{ labelResult.variantLabel }} ({{ labelResult.netQuantity }})</p>
            </div>
            <div class="adm-help text-right">
              <p>Lote: {{ labelResult.lotNumber }}</p>
              <p>Fabricación: {{ adminDate(labelResult.manufacturingDate) }}</p>
              <p>Caducidad: {{ adminDate(labelResult.expiryDate) }}</p>
            </div>
          </div>

          <div class="my-4 flex flex-wrap items-center justify-between gap-3 border-y border-[var(--border)] py-3">
            <AdminBadge :tone="labelResult.signalWord === 'PELIGRO' ? 'danger' : 'warning'">
              {{ labelResult.signalWord }}
            </AdminBadge>
            <ul class="flex flex-wrap gap-2" aria-label="Pictogramas de peligro">
              <li v-for="pic in labelResult.pictograms" :key="pic" class="adm-chip">{{ pic }}</li>
            </ul>
          </div>

          <div class="adm-stack">
            <div>
              <p class="font-semibold text-[var(--text-strong)]">Indicaciones de peligro</p>
              <ul class="mt-1 list-disc pl-5">
                <li v-for="(h, i) in labelResult.hazardStatements" :key="i">{{ h }}</li>
              </ul>
            </div>
            <div>
              <p class="font-semibold text-[var(--text-strong)]">Consejos de prudencia</p>
              <ul class="mt-1 list-disc pl-5">
                <li v-for="(p, i) in labelResult.precautionaryStatements" :key="i">{{ p }}</li>
              </ul>
            </div>
          </div>

          <div class="adm-help mt-4 border-t border-[var(--border)] pt-3">
            <p v-if="labelResult.ufiCode">{{ labelResult.ufiCode }}</p>
            <p>Teléfono de emergencias toxicológicas: {{ labelResult.emergencyPhone }}</p>
            <p>Proveedor: {{ labelResult.supplierInfo.name }} · {{ labelResult.supplierInfo.address }}</p>
            <p class="break-all">Código de barras: {{ labelResult.barcodeData }}</p>
          </div>
        </div>
      </AdminCard>

      <!-- Ficha de manipulación y derrames -->
      <AdminCard
        title="Manipulación y derrames"
        description="Instrucciones de la ficha de seguridad para quien mueve el producto en el almacén."
        data-testid="handling-instructions-section"
      >
        <form class="flex flex-wrap items-end gap-3" @submit.prevent="loadHandlingInstructions">
          <div class="adm-field min-w-0 flex-1">
            <label for="handling-variant" class="adm-label">Código del producto</label>
            <input
              id="handling-variant"
              v-model="handlingVariantId"
              type="text"
              placeholder="var-cloro-5l"
              class="adm-input w-full font-mono"
            />
          </div>
          <button type="submit" :disabled="handlingLoading || !handlingVariantId" class="adm-btn adm-btn--secondary">
            <UIcon
              :name="handlingLoading ? 'i-lucide-loader-circle' : 'i-lucide-search'"
              class="size-4 shrink-0"
              :class="handlingLoading && 'animate-spin'"
            />
            Consultar ficha
          </button>
        </form>

        <UAlert
          v-if="handlingError"
          class="mt-4"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="handlingError"
          role="alert"
        />

        <div v-if="handlingResult" class="adm-stack mt-5" data-testid="handling-instructions-content">
          <div>
            <h3 class="font-semibold text-[var(--text-strong)]">Equipo de protección obligatorio</h3>
            <ul class="mt-1 list-disc space-y-1 pl-5">
              <li v-for="(ppe, i) in handlingResult.requiredPpe" :key="i">{{ ppe }}</li>
            </ul>
          </div>
          <div class="border-t border-[var(--border)] pt-4">
            <h3 class="font-semibold text-[var(--text-strong)]">No almacenar ni mezclar con</h3>
            <ul class="mt-1 list-disc space-y-1 pl-5">
              <li v-for="(inc, i) in handlingResult.incompatibleMaterials" :key="i">{{ inc }}</li>
            </ul>
          </div>
          <div class="border-t border-[var(--border)] pt-4">
            <h3 class="font-semibold text-[var(--text-strong)]">Qué hacer si hay un derrame</h3>
            <ol class="mt-1 list-decimal space-y-1 pl-5">
              <li v-for="(step, i) in handlingResult.spillResponseSteps" :key="i">{{ step }}</li>
            </ol>
          </div>
        </div>
        <AdminEmptyState
          v-else-if="!handlingError"
          compact
          icon="i-lucide-shield-alert"
          title="Consulta un producto"
          description="Verás la protección necesaria, las incompatibilidades y los pasos ante un derrame."
        />
      </AdminCard>
    </div>

    <!-- Documento de transporte -->
    <AdminCard
      title="Documento de transporte de mercancías peligrosas"
      description="Indica qué lotes salen en el envío. Se calculan los puntos y si el envío queda exento (límite de 1.000 puntos)."
      data-testid="adr-transport-section"
    >
      <template #actions>
        <AdminButton size="sm" icon="i-lucide-plus" @click="addTransportLine">Añadir línea</AdminButton>
      </template>

      <div class="adm-stack">
        <div
          v-for="(item, idx) in transportItems"
          :key="idx"
          class="grid grid-cols-2 items-end gap-3 sm:grid-cols-[minmax(0,2fr)_6rem_minmax(0,1.5fr)_7rem_auto]"
        >
          <AdminFormField v-slot="{ id }" label="Lote" class="col-span-2 sm:col-span-1">
            <input
              :id="id"
              v-model="item.lotNumber"
              type="text"
              class="adm-input w-full font-mono"
              placeholder="LOT-202610-042"
            />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Bultos">
            <input :id="id" v-model.number="item.packagesCount" type="number" min="1" class="adm-input w-full" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Tipo de envase">
            <input
              :id="id"
              v-model="item.packageType"
              type="text"
              class="adm-input w-full"
              placeholder="Garrafas 5 L"
            />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Kg o L por bulto">
            <input
              :id="id"
              v-model.number="item.litersOrKgPerPackage"
              type="number"
              min="0.1"
              step="0.1"
              class="adm-input w-full"
            />
          </AdminFormField>
          <AdminButton
            variant="ghost"
            icon="i-lucide-trash-2"
            :label="`Quitar la línea ${idx + 1}`"
            @click="removeTransportLine(idx)"
          />
        </div>
        <AdminEmptyState
          v-if="!transportItems.length"
          compact
          icon="i-lucide-package"
          title="Añade al menos una línea"
          description="Cada línea es un lote que sale en el envío."
        />

        <UAlert
          v-if="transportError"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="transportError"
          role="alert"
        />

        <!-- Resultado -->
        <div
          v-if="transportResult"
          class="adm-stack rounded-[var(--radius-surface)] border border-[var(--border)] p-4"
          data-testid="transport-result"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <AdminBadge :tone="transportResult.isExemptUnder1136 ? 'success' : 'danger'">
              {{
                transportResult.isExemptUnder1136
                  ? 'Envío exento por cantidad limitada'
                  : 'Requiere transporte completo de mercancías peligrosas'
              }}
            </AdminBadge>
            <p>
              <strong class="text-base text-[var(--text-strong)]">{{ transportResult.totalCalculatedPoints }}</strong>
              de 1.000 puntos
            </p>
          </div>
          <div>
            <p class="font-semibold text-[var(--text-strong)]">Texto obligatorio para la carta de porte</p>
            <p class="mt-1 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3">
              {{ transportResult.mandatoryDeclaration }}
            </p>
          </div>
          <div>
            <p class="font-semibold text-[var(--text-strong)]">Instrucciones para el transportista</p>
            <ul class="mt-1 list-disc space-y-1 pl-5">
              <li v-for="(inst, i) in transportResult.carrierInstructions" :key="i">{{ inst }}</li>
            </ul>
          </div>
        </div>
      </div>

      <template #footer>
        <AdminButton
          variant="primary"
          icon="i-lucide-file-text"
          :loading="transportLoading"
          :disabled="!transportItems.length"
          @click="generateTransportDoc"
        >
          {{ transportLoading ? 'Calculando…' : 'Calcular y generar documento' }}
        </AdminButton>
      </template>
    </AdminCard>
  </div>
</template>
