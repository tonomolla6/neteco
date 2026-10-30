<script setup lang="ts">
import { ref } from 'vue'

const requestFetch = useRequestFetch()

interface VerifiableClaim {
  claimText: string
  sourceRef: string
  verified: boolean
  hazardClpCompliant: boolean
  category: string
}

interface DuplicateCheck {
  maxSimilarityScore: number
  duplicateRisk: string
  matchedProducts: Array<{ productId: string; name: string; similarityScore: number }>
}

interface GenerationResponse {
  id: string
  productId: string | null
  targetScope: string
  prompt: string
  generatedTitle: string | null
  generatedShortDescription: string | null
  generatedDescription: string | null
  generatedUsage: string | null
  generatedAttributes: Record<string, unknown> | null
  verifiableClaims: VerifiableClaim[]
  duplicateCheck: DuplicateCheck
  isAiGenerated: boolean
  aiModelName: string
  approvalStatus: string
  version: number
  humanReviewedAt?: string
}

const productName = ref('')
const targetScope = ref<'description' | 'attributes' | 'full_editorial'>('full_editorial')
const sourceTitle = ref('Ficha Técnica FDS-Oficial')
const sourceSnippet = ref('Limpiador concentrado biodegradable conforme norma OECD 301 con pH neutro 7.0.')
const sourceClaims = ref('Biodegradable OECD 301, pH 7.0, Secado rápido')
const prompt = ref('Generar descripción y atributos para producto químico')
const targetProductId = ref('prod-desengrasante-1')

const loading = ref(false)
const reviewing = ref(false)
const applying = ref(false)
const errorMessage = ref('')
const statusMessage = ref('')
const generation = ref<GenerationResponse | null>(null)

async function generateContent() {
  if (!productName.value.trim()) return
  loading.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const claimsArray = sourceClaims.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const res = (await requestFetch('/api/admin/catalog/ai-generate/propose', {
      method: 'POST',
      body: {
        productName: productName.value.trim(),
        targetScope: targetScope.value,
        prompt: prompt.value.trim(),
        sources: [
          {
            id: 'src-1',
            title: sourceTitle.value.trim(),
            type: 'fds',
            verifiedClaims: claimsArray.length ? claimsArray : ['Formula estandar'],
            textSnippet: sourceSnippet.value.trim()
          }
        ]
      }
    })) as { generation: GenerationResponse }

    generation.value = res.generation
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al generar contenido asistido'
  } finally {
    loading.value = false
  }
}

async function reviewContent(decision: 'approve' | 'reject') {
  if (!generation.value) return
  reviewing.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch(`/api/admin/catalog/ai-generate/generations/${generation.value.id}/review`, {
      method: 'POST',
      body: {
        expectedVersion: generation.value.version,
        decision,
        reviewNotes: 'Revisión técnica de claims y seguridad completada'
      }
    })) as { generation: GenerationResponse }

    generation.value = res.generation
    if (res.generation.approvalStatus === 'approved') {
      statusMessage.value = 'Revisión Aprobada por el administrador'
    } else {
      statusMessage.value = 'Contenido Rechazado'
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al revisar el contenido'
  } finally {
    reviewing.value = false
  }
}

async function applyContent() {
  if (!generation.value) return
  applying.value = true
  errorMessage.value = ''
  try {
    await requestFetch(`/api/admin/catalog/ai-generate/generations/${generation.value.id}/apply`, {
      method: 'POST',
      body: {
        expectedVersion: generation.value.version,
        targetProductId: targetProductId.value || 'prod-desengrasante-1'
      }
    })
    statusMessage.value = 'Contenido Aplicado al Catálogo con marcado de autoría IA y trazabilidad'
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al aplicar contenido al catálogo'
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <div class="space-y-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
    <div class="border-b border-gray-100 pb-4 dark:border-gray-800">
      <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">Generación Asistida de Catálogo (ADM-033)</h2>
      <p class="text-sm text-gray-500 dark:text-gray-400">
        Descripciones y atributos respaldados por fuentes verificadas (FDS/SDS), detección de duplicados y revisión
        humana obligatoria.
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
        <label for="cat-name" class="block text-xs font-medium text-gray-700 dark:text-gray-300"
          >Nombre del Producto</label
        >
        <input
          id="cat-name"
          v-model="productName"
          data-test="product-name-input"
          type="text"
          placeholder="Ej: Desengrasante Alcalino Extra Fuerte"
          class="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        />
      </div>

      <div>
        <label for="cat-scope" class="block text-xs font-medium text-gray-700 dark:text-gray-300"
          >Alcance de Generación</label
        >
        <select
          id="cat-scope"
          v-model="targetScope"
          class="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        >
          <option value="full_editorial">Editorial Completo (Descripción, Uso, Atributos)</option>
          <option value="description">Solo Descripciones</option>
          <option value="attributes">Solo Atributos Técnicos</option>
        </select>
      </div>

      <div class="sm:col-span-2">
        <label for="cat-claims" class="block text-xs font-medium text-gray-700 dark:text-gray-300"
          >Claims Verificables en FDS / Especificaciones (separados por comas)</label
        >
        <input
          id="cat-claims"
          v-model="sourceClaims"
          type="text"
          placeholder="Ej: Biodegradable OECD 301, pH 7.0, Exento de fosfatos"
          class="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        />
      </div>

      <div class="sm:col-span-2 flex justify-end">
        <button
          type="button"
          data-test="generate-content-btn"
          :disabled="loading || !productName.trim()"
          class="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
          @click="generateContent"
        >
          <span v-if="loading">Verificando Claims y Analizando Duplicados...</span>
          <span v-else>Generar Contenido Asistido</span>
        </button>
      </div>
    </div>

    <!-- Generation Output -->
    <div
      v-if="generation"
      class="space-y-4 rounded-lg border border-gray-200 bg-gray-50/70 p-5 dark:border-gray-800 dark:bg-gray-800/40"
    >
      <div class="flex items-center justify-between border-b border-gray-200 pb-3 dark:border-gray-700">
        <div class="flex items-center gap-2">
          <span
            class="inline-flex items-center rounded bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-800 dark:bg-purple-900/50 dark:text-purple-300"
          >
            Contenido Generado por IA
          </span>
          <span class="text-xs text-gray-500 dark:text-gray-400">Modelo: {{ generation.aiModelName }}</span>
        </div>
        <span class="text-xs font-medium uppercase tracking-wider text-gray-700 dark:text-gray-300">
          Estado: {{ generation.approvalStatus }}
        </span>
      </div>

      <!-- Verifiable Claims -->
      <div v-if="generation.verifiableClaims && generation.verifiableClaims.length">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400">
          Claims técnicos verificados
        </h4>
        <div class="mt-2 flex flex-wrap gap-2">
          <span
            v-for="claim in generation.verifiableClaims"
            :key="claim.claimText"
            class="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
          >
            ✓ {{ claim.claimText }}
          </span>
        </div>
      </div>

      <!-- Duplicate Check -->
      <div class="rounded-md border border-gray-200 bg-white p-3 text-xs dark:border-gray-700 dark:bg-gray-900">
        <div class="flex items-center justify-between">
          <span class="font-semibold text-gray-700 dark:text-gray-300">Control de Duplicados en Catálogo:</span>
          <span
            class="font-bold uppercase"
            :class="{
              'text-emerald-600 dark:text-emerald-400':
                generation.duplicateCheck.duplicateRisk === 'none' || generation.duplicateCheck.duplicateRisk === 'low',
              'text-amber-600 dark:text-amber-400': generation.duplicateCheck.duplicateRisk === 'medium',
              'text-red-600 dark:text-red-400': generation.duplicateCheck.duplicateRisk === 'high'
            }"
          >
            Riesgo: {{ generation.duplicateCheck.duplicateRisk }} (Similitud:
            {{ Math.round(generation.duplicateCheck.maxSimilarityScore * 100) }}%)
          </span>
        </div>
      </div>

      <!-- Content Preview -->
      <div class="space-y-2 text-xs">
        <div>
          <span class="font-semibold text-gray-700 dark:text-gray-300">Título Sugerido:</span>
          <p class="mt-0.5 text-gray-900 dark:text-gray-100">{{ generation.generatedTitle }}</p>
        </div>
        <div>
          <span class="font-semibold text-gray-700 dark:text-gray-300">Descripción:</span>
          <p class="mt-0.5 text-gray-900 dark:text-gray-100">{{ generation.generatedDescription }}</p>
        </div>
        <div>
          <span class="font-semibold text-gray-700 dark:text-gray-300">Modo de Empleo:</span>
          <p class="mt-0.5 text-gray-900 dark:text-gray-100">{{ generation.generatedUsage }}</p>
        </div>
      </div>

      <!-- Actions -->
      <div class="flex items-center justify-between border-t border-gray-200 pt-4 dark:border-gray-700">
        <div v-if="generation.approvalStatus === 'pending_review'" class="flex gap-2">
          <button
            type="button"
            data-test="approve-content-btn"
            :disabled="reviewing"
            class="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-500"
            @click="reviewContent('approve')"
          >
            Aprobar Revisión Humana
          </button>
        </div>

        <div v-if="generation.approvalStatus.includes('approved')" class="flex items-center gap-3">
          <input
            v-model="targetProductId"
            type="text"
            placeholder="ID de producto destino"
            class="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
          <button
            type="button"
            data-test="apply-content-btn"
            :disabled="applying"
            class="rounded-md bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500"
            @click="applyContent"
          >
            Aplicar Contenido al Catálogo
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
