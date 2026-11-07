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
      labelError.value = 'BLOQUEADO: El lote se encuentra en CUARENTENA y no puede ser etiquetado para expedición.'
    } else if (code === 'qa_rejected_blocked') {
      labelError.value = 'BLOQUEADO: El lote ha sido RECHAZADO por el control de calidad.'
    } else if (code === 'not_found') {
      labelError.value = 'No se encontró la variante o el registro del lote especificado.'
    } else {
      labelError.value = 'Error al generar la etiqueta de seguridad química.'
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
    transportError.value = 'Error al generar el documento de transporte ADR. Verifique permisos o referencias de lote.'
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
    handlingError.value = 'No se encontraron instrucciones operativas para la variante seleccionada.'
  } finally {
    handlingLoading.value = false
  }
}
</script>

<template>
  <div class="space-y-8" data-testid="admin-warehouse-adr-panel">
    <!-- Header -->
    <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <span
            class="inline-block rounded-full bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-wider text-amber-800"
          >
            Logística y Seguridad Química (ADR / CLP)
          </span>
          <h1 class="mt-2 text-2xl font-black text-slate-900 sm:text-3xl">
            Assets Operativos de Almacén y Gestión ADR
          </h1>
          <p class="mt-1 text-sm text-slate-600">
            Generación controlada de etiquetas químicas CLP, cartas de porte con cálculo de exención 1.1.3.6 e
            instrucciones de manipulación seguras por variante y lote.
          </p>
        </div>
      </div>
    </div>

    <!-- Tabs/Grid container -->
    <div class="grid grid-cols-1 gap-8 lg:grid-cols-2">
      <!-- 1. CLP Label Generator -->
      <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" data-testid="clp-label-section">
        <div class="border-b border-slate-200 pb-4">
          <h2 class="text-lg font-bold text-slate-900">1. Generador de Etiquetas CLP por Lote</h2>
          <p class="mt-1 text-xs text-slate-500">
            Etiqueta reglamentaria según Reglamento (CE) 1272/2008. Bloqueada si el lote no está aprobado por QA.
          </p>
        </div>

        <form class="mt-4 space-y-4" @submit.prevent="generateLabel">
          <div>
            <label for="clp-variant" class="block text-xs font-bold text-slate-700">ID de Variante</label>
            <input
              id="clp-variant"
              v-model="labelVariantId"
              type="text"
              class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              placeholder="var-cloro-5l"
            />
          </div>

          <div>
            <label for="clp-lot" class="block text-xs font-bold text-slate-700">Número de Lote (Trazabilidad)</label>
            <input
              id="clp-lot"
              v-model="labelLotNumber"
              type="text"
              class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              placeholder="LOT-202610-042"
            />
          </div>

          <button
            type="submit"
            :disabled="labelLoading || !labelVariantId || !labelLotNumber"
            class="w-full rounded-xl bg-slate-900 py-2.5 text-sm font-bold text-white shadow hover:bg-slate-800 disabled:opacity-50"
            data-testid="btn-generate-label"
          >
            {{ labelLoading ? 'Generando etiqueta...' : 'Generar Etiqueta CLP Oficial' }}
          </button>
        </form>

        <div
          v-if="labelError"
          class="mt-4 rounded-xl border border-red-300 bg-red-50 p-4 text-xs font-bold text-red-800"
          role="alert"
          data-testid="label-error"
        >
          {{ labelError }}
        </div>

        <!-- Rendered CLP Label Preview -->
        <div
          v-if="labelResult"
          class="mt-6 rounded-2xl border-2 border-slate-900 bg-white p-6 shadow-md"
          data-testid="clp-label-preview"
        >
          <div class="border-b-2 border-slate-900 pb-3">
            <div class="flex items-start justify-between">
              <div>
                <span class="text-xs font-extrabold uppercase text-slate-500">NETECO PROFESSIONAL</span>
                <h3 class="text-xl font-black text-slate-950">{{ labelResult.productName }}</h3>
                <p class="text-sm font-bold text-slate-700">
                  {{ labelResult.variantLabel }} ({{ labelResult.netQuantity }})
                </p>
              </div>
              <div class="text-right text-xs font-mono font-bold text-slate-800">
                <p>Lote: {{ labelResult.lotNumber }}</p>
                <p>Fab: {{ labelResult.manufacturingDate }}</p>
                <p>Cad: {{ labelResult.expiryDate }}</p>
              </div>
            </div>
          </div>

          <!-- Signal word & pictograms -->
          <div class="my-4 flex items-center justify-between border-b border-slate-200 pb-4">
            <span
              class="rounded-lg px-4 py-1.5 text-sm font-black tracking-wider text-white uppercase"
              :class="labelResult.signalWord === 'PELIGRO' ? 'bg-red-600' : 'bg-amber-600'"
            >
              {{ labelResult.signalWord }}
            </span>

            <div class="flex gap-2">
              <span
                v-for="pic in labelResult.pictograms"
                :key="pic"
                class="flex h-10 w-10 items-center justify-center rounded-lg border-2 border-red-600 font-bold text-xs text-red-700 shadow-sm"
              >
                {{ pic }}
              </span>
            </div>
          </div>

          <!-- Statements -->
          <div class="space-y-2 text-xs text-slate-800">
            <div>
              <p class="font-bold text-slate-900">Indicaciones de peligro (H):</p>
              <ul class="list-disc pl-4 text-slate-700">
                <li v-for="(h, i) in labelResult.hazardStatements" :key="i">{{ h }}</li>
              </ul>
            </div>
            <div>
              <p class="font-bold text-slate-900">Consejos de prudencia (P):</p>
              <ul class="list-disc pl-4 text-slate-700">
                <li v-for="(p, i) in labelResult.precautionaryStatements" :key="i">{{ p }}</li>
              </ul>
            </div>
          </div>

          <!-- Footer details -->
          <div class="mt-4 border-t border-slate-200 pt-3 text-[10px] text-slate-500">
            <p v-if="labelResult.ufiCode">
              <strong>{{ labelResult.ufiCode }}</strong>
            </p>
            <p><strong>Teléfono de Emergencias Toxicológicas (INTCF):</strong> {{ labelResult.emergencyPhone }}</p>
            <p>
              <strong>Proveedor:</strong> {{ labelResult.supplierInfo.name }} | {{ labelResult.supplierInfo.address }}
            </p>
            <p class="mt-1 font-mono text-slate-700">
              <strong>Código de barras GS1:</strong> {{ labelResult.barcodeData }}
            </p>
          </div>
        </div>
      </section>

      <!-- 2. Warehouse Handling & Spill Instructions -->
      <section
        class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
        data-testid="handling-instructions-section"
      >
        <div class="border-b border-slate-200 pb-4">
          <h2 class="text-lg font-bold text-slate-900">2. Ficha de Manipulación y Derrames</h2>
          <p class="mt-1 text-xs text-slate-500">
            Instrucciones operativas directas de la ficha de seguridad SDS para los operarios del almacén.
          </p>
        </div>

        <form class="mt-4 flex gap-3" @submit.prevent="loadHandlingInstructions">
          <input
            v-model="handlingVariantId"
            type="text"
            placeholder="ID de variante..."
            class="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-amber-500 focus:outline-none"
          />
          <button
            type="submit"
            :disabled="handlingLoading || !handlingVariantId"
            class="rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Consultar Ficha
          </button>
        </form>

        <div v-if="handlingError" class="mt-4 rounded-lg bg-red-50 p-4 text-xs font-semibold text-red-700">
          {{ handlingError }}
        </div>

        <div v-if="handlingResult" class="mt-6 space-y-4 text-xs" data-testid="handling-instructions-content">
          <div class="rounded-xl bg-amber-50 border border-amber-200 p-4">
            <h4 class="font-bold text-amber-900 uppercase">Equipos de Protección Individual (EPI Obligatorio)</h4>
            <ul class="mt-2 list-disc pl-4 text-amber-800 space-y-1">
              <li v-for="(ppe, i) in handlingResult.requiredPpe" :key="i">{{ ppe }}</li>
            </ul>
          </div>

          <div class="rounded-xl bg-red-50 border border-red-200 p-4">
            <h4 class="font-bold text-red-900 uppercase">Incompatibilidades Químicas Críticas</h4>
            <ul class="mt-2 list-disc pl-4 text-red-800 space-y-1">
              <li v-for="(inc, i) in handlingResult.incompatibleMaterials" :key="i">{{ inc }}</li>
            </ul>
          </div>

          <div class="rounded-xl bg-slate-50 border border-slate-200 p-4">
            <h4 class="font-bold text-slate-900 uppercase">Protocolo de Actuación ante Derrames</h4>
            <ol class="mt-2 list-decimal pl-4 text-slate-700 space-y-1">
              <li v-for="(step, i) in handlingResult.spillResponseSteps" :key="i">{{ step }}</li>
            </ol>
          </div>
        </div>
      </section>
    </div>

    <!-- 3. ADR Transport Document & 1.1.3.6 Exemption Calculation -->
    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" data-testid="adr-transport-section">
      <div class="border-b border-slate-200 pb-4">
        <h2 class="text-lg font-bold text-slate-900">3. Documento de Transporte ADR y Cálculo de Exención 1.1.3.6</h2>
        <p class="mt-1 text-xs text-slate-500">
          Cálculo ponderado de puntos ADR según categoría de transporte. Generación de declaración obligatoria para la
          carta de porte.
        </p>
      </div>

      <div class="mt-6 space-y-4">
        <div
          v-for="(item, idx) in transportItems"
          :key="idx"
          class="flex flex-col sm:flex-row items-end gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
        >
          <div class="flex-1 w-full sm:w-auto">
            <label class="block text-xs font-semibold text-slate-700">Lote</label>
            <input
              v-model="item.lotNumber"
              type="text"
              class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-mono text-slate-900"
              placeholder="LOT-202610-042"
            />
          </div>

          <div class="w-full sm:w-28">
            <label class="block text-xs font-semibold text-slate-700">Bultos</label>
            <input
              v-model.number="item.packagesCount"
              type="number"
              min="1"
              class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900"
            />
          </div>

          <div class="w-full sm:w-36">
            <label class="block text-xs font-semibold text-slate-700">Tipo Envase</label>
            <input
              v-model="item.packageType"
              type="text"
              class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900"
              placeholder="Garrafas 5L"
            />
          </div>

          <div class="w-full sm:w-28">
            <label class="block text-xs font-semibold text-slate-700">Kg/L por Bulto</label>
            <input
              v-model.number="item.litersOrKgPerPackage"
              type="number"
              min="0.1"
              step="0.1"
              class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900"
            />
          </div>

          <button
            type="button"
            class="text-xs text-red-600 font-bold hover:underline py-1.5"
            @click="removeTransportLine(idx)"
          >
            Eliminar
          </button>
        </div>

        <div class="flex items-center justify-between pt-2">
          <button type="button" class="text-xs font-bold text-blue-600 hover:underline" @click="addTransportLine">
            + Añadir otra línea de expedición
          </button>

          <button
            type="button"
            :disabled="transportLoading"
            class="rounded-xl bg-blue-600 px-6 py-2.5 text-xs font-bold text-white shadow hover:bg-blue-700 disabled:opacity-50"
            @click="generateTransportDoc"
          >
            {{ transportLoading ? 'Calculando...' : 'Calcular ADR y Emitir Documento' }}
          </button>
        </div>
      </div>

      <div v-if="transportError" class="mt-4 rounded-lg bg-red-50 p-4 text-xs font-semibold text-red-700">
        {{ transportError }}
      </div>

      <!-- Result document -->
      <div
        v-if="transportResult"
        class="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-6"
        data-testid="transport-result"
      >
        <div class="flex items-center justify-between border-b border-slate-200 pb-4">
          <div>
            <span
              class="rounded-full px-3 py-1 text-xs font-black uppercase"
              :class="transportResult.isExemptUnder1136 ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'"
            >
              {{
                transportResult.isExemptUnder1136
                  ? 'TRANSPORTE BAJO EXENCIÓN 1.1.3.6'
                  : 'TRANSPORTE COMPLETO ADR REQUERIDO'
              }}
            </span>
          </div>
          <div class="text-right">
            <span
              class="text-2xl font-black"
              :class="transportResult.totalCalculatedPoints <= 1000 ? 'text-emerald-700' : 'text-red-700'"
            >
              {{ transportResult.totalCalculatedPoints }}
            </span>
            <span class="text-xs text-slate-500 font-medium"> / 1000 Puntos Máximos</span>
          </div>
        </div>

        <div class="mt-4">
          <p class="text-xs font-bold text-slate-900">Declaración Legal Obligatoria para la Carta de Porte:</p>
          <p class="mt-1 rounded-lg bg-white p-3 text-xs font-mono font-bold text-slate-800 border border-slate-200">
            {{ transportResult.mandatoryDeclaration }}
          </p>
        </div>

        <div class="mt-4">
          <p class="text-xs font-bold text-slate-900">Instrucciones al Conductor / Transportista:</p>
          <ul class="mt-1 list-disc pl-4 text-xs text-slate-700 space-y-1">
            <li v-for="(inst, i) in transportResult.carrierInstructions" :key="i">{{ inst }}</li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>
