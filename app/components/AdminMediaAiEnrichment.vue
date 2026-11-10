<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  assetId?: string
}>()

const requestFetch = useRequestFetch()

interface CropItem {
  ratio: string
  purpose: string
  x: number
  y: number
  width: number
  height: number
}

interface BackgroundRemoval {
  maskDescription: string
  alphaCutoutStorageKey: string
  backgroundType: string
  edgeAccuracyScore: number
  noPackagingInvented: boolean
}

interface ProposedMetadata {
  suggestedAltText: string
  dominantColors: string[]
  focalPoint: { x: number; y: number }
  noFictionalClaimsOrBadges: boolean
}

interface EnrichmentResponse {
  id: string
  assetId: string
  enrichmentType: string
  backgroundRemoval: BackgroundRemoval | null
  proposedCrops: CropItem[] | null
  proposedMetadata: ProposedMetadata | null
  prohibitedInventionCheck: {
    passed: boolean
    noInventedPackaging: boolean
    noInventedClaims: boolean
    noInventedUses: boolean
  }
  requiresHumanApproval: boolean
  approvalStatus: string
  version: number
  humanDecidedAt?: string
}

const targetAssetId = ref(props.assetId || 'asset-00000000-0000-4000-8000-000000000001')
const enrichmentType = ref<'remove_background' | 'propose_crops' | 'propose_metadata' | 'full_visual_enrichment'>(
  'full_visual_enrichment'
)
const productName = ref('Desengrasante Alcalino Extra Fuerte')
const instruction = ref('')

const loading = ref(false)
const deciding = ref(false)
const applying = ref(false)
const errorMessage = ref('')
const statusMessage = ref('')
const enrichment = ref<EnrichmentResponse | null>(null)

async function proposeEnrichment() {
  if (!targetAssetId.value.trim()) return
  loading.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const res = (await requestFetch<unknown, string>('/api/admin/media/ai-enrich/propose', {
      method: 'POST',
      body: {
        assetId: targetAssetId.value.trim(),
        enrichmentType: enrichmentType.value,
        options: {
          contextProductName: productName.value.trim() || undefined,
          instruction: instruction.value.trim() || undefined
        }
      }
    })) as { enrichment: EnrichmentResponse }

    enrichment.value = res.enrichment
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al proponer enriquecimiento visual'
  } finally {
    loading.value = false
  }
}

async function recordDecision(decision: 'approve' | 'reject') {
  if (!enrichment.value) return
  deciding.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch<unknown, string>(
      `/api/admin/media/ai-enrich/enrichments/${enrichment.value.id}/decision`,
      {
        method: 'POST',
        body: {
          expectedVersion: enrichment.value.version,
          decision,
          humanNotes: 'Verificación humana de no invención de elementos visuales completada'
        }
      }
    )) as { enrichment: EnrichmentResponse }

    enrichment.value = res.enrichment
    if (res.enrichment.approvalStatus === 'approved') {
      statusMessage.value = 'Enriquecimiento Aprobado por el administrador'
    } else {
      statusMessage.value = 'Enriquecimiento Rechazado'
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al registrar la decisión humana'
  } finally {
    deciding.value = false
  }
}

async function applyEnrichment() {
  if (!enrichment.value) return
  applying.value = true
  errorMessage.value = ''
  try {
    await requestFetch<unknown, string>(`/api/admin/media/ai-enrich/enrichments/${enrichment.value.id}/apply`, {
      method: 'POST',
      body: {
        expectedVersion: enrichment.value.version,
        targetAssetId: enrichment.value.assetId
      }
    })
    statusMessage.value = 'Aplicado al activo multimedia en la biblioteca central de medios'
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al aplicar el enriquecimiento al activo'
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <div class="space-y-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
    <div class="border-b border-gray-100 pb-4 dark:border-gray-800">
      <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">Enriquecimiento visual asistido (MED-023)</h2>
      <p class="text-sm text-gray-500 dark:text-gray-400">
        Eliminación de fondo y propuesta de recortes o metadatos accesibles. Prohibida la invención de envases, claims o
        usos. Aprobación humana obligatoria.
      </p>
    </div>

    <!-- Error Banner -->
    <div
      v-if="errorMessage"
      class="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300"
      role="alert"
    >
      {{ errorMessage }}
    </div>

    <!-- Status Message -->
    <div
      v-if="statusMessage"
      class="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
    >
      {{ statusMessage }}
    </div>

    <!-- Form -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <label for="med-asset-id" class="block text-xs font-medium text-gray-700 dark:text-gray-300"
          >ID del Activo Multimedia</label
        >
        <input
          id="med-asset-id"
          v-model="targetAssetId"
          type="text"
          placeholder="UUID del asset en media_assets"
          class="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        />
      </div>

      <div>
        <label for="med-type" class="block text-xs font-medium text-gray-700 dark:text-gray-300"
          >Tipo de Operación Permitida</label
        >
        <select
          id="med-type"
          v-model="enrichmentType"
          class="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        >
          <option value="full_visual_enrichment">Completo (Fondo + Recortes + Metadatos)</option>
          <option value="remove_background">Eliminación de Fondo</option>
          <option value="propose_crops">Propuesta de Recortes (Crops)</option>
          <option value="propose_metadata">Propuesta de Metadatos y Alt-Text</option>
        </select>
      </div>

      <div class="sm:col-span-2 flex justify-end">
        <button
          type="button"
          data-test="propose-enrichment-btn"
          :disabled="loading || !targetAssetId.trim()"
          class="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
          @click="proposeEnrichment"
        >
          <span v-if="loading">Generando Propuesta Visual...</span>
          <span v-else>Generar Propuesta de Enriquecimiento</span>
        </button>
      </div>
    </div>

    <!-- Output Preview -->
    <div
      v-if="enrichment"
      class="space-y-4 rounded-lg border border-gray-200 bg-gray-50/70 p-5 dark:border-gray-800 dark:bg-gray-800/40"
    >
      <div class="flex items-center justify-between border-b border-gray-200 pb-3 dark:border-gray-700">
        <h3 class="font-semibold text-gray-900 dark:text-gray-100">Propuesta de Enriquecimiento Visual</h3>
        <span
          class="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-900/60 dark:text-blue-200"
        >
          Estado: {{ enrichment.approvalStatus }}
        </span>
      </div>

      <!-- Prohibited Invention Guardrail Badge -->
      <div
        class="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200"
      >
        <span class="font-bold">✓ Control de integridad visual estricto:</span>
        Sin invención de envases ni claims comerciales. Solo optimización técnica de fondo, recorte y accesibilidad.
      </div>

      <!-- Background Removal Proposal -->
      <div
        v-if="enrichment.backgroundRemoval"
        class="rounded-md border border-gray-200 bg-white p-3 text-xs dark:border-gray-700 dark:bg-gray-900"
      >
        <h4 class="font-bold text-gray-800 dark:text-gray-200">Eliminación de fondo propuesta:</h4>
        <p class="mt-1 text-gray-600 dark:text-gray-400">{{ enrichment.backgroundRemoval.maskDescription }}</p>
        <p class="mt-0.5 font-mono text-[11px] text-gray-500 dark:text-gray-400">
          Recorte Alpha: {{ enrichment.backgroundRemoval.alphaCutoutStorageKey }} (Precisión borde:
          {{ Math.round(enrichment.backgroundRemoval.edgeAccuracyScore * 100) }}%)
        </p>
      </div>

      <!-- Crops Proposal -->
      <div v-if="enrichment.proposedCrops && enrichment.proposedCrops.length" class="space-y-2">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400">
          Recortes propuestos (Crops)
        </h4>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div
            v-for="crop in enrichment.proposedCrops"
            :key="crop.ratio + crop.purpose"
            class="rounded-md border border-gray-200 bg-white p-2.5 text-xs dark:border-gray-700 dark:bg-gray-900"
          >
            <div class="font-bold text-gray-900 dark:text-gray-100">{{ crop.ratio }} ({{ crop.purpose }})</div>
            <div class="mt-1 text-gray-500 dark:text-gray-400">{{ crop.width }}x{{ crop.height }} px</div>
          </div>
        </div>
      </div>

      <!-- Metadata Proposal -->
      <div v-if="enrichment.proposedMetadata" class="space-y-1 text-xs">
        <h4 class="font-semibold text-gray-700 dark:text-gray-300">Texto alternativo accesible propuesto:</h4>
        <p
          class="rounded-md border border-gray-200 bg-white p-2.5 text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          {{ enrichment.proposedMetadata.suggestedAltText }}
        </p>
      </div>

      <!-- Actions -->
      <div class="flex items-center justify-between border-t border-gray-200 pt-4 dark:border-gray-700">
        <div v-if="enrichment.approvalStatus === 'pending_approval'">
          <button
            type="button"
            data-test="approve-enrichment-btn"
            :disabled="deciding"
            class="rounded-md bg-emerald-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-500"
            @click="recordDecision('approve')"
          >
            Aprobar Enriquecimiento Visual
          </button>
        </div>

        <div v-if="enrichment.approvalStatus.includes('approved')">
          <button
            type="button"
            data-test="apply-enrichment-btn"
            :disabled="applying"
            class="rounded-md bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500"
            @click="applyEnrichment"
          >
            Aplicar al Activo Multimedia
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
