<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  evaluateEditorialQuality,
  type CatalogEditorialArticle,
  type EditorialTargetType
} from '~~/shared/catalog-editorial-content'

const props = withDefaults(
  defineProps<{
    targetType?: EditorialTargetType
    targetId?: string
  }>(),
  {
    targetType: 'product',
    targetId: 'prod-001'
  }
)

const requestFetch = useRequestFetch()

const loading = ref(true)
const saving = ref(false)
const loadError = ref<string | null>(null)
const feedbackMessage = ref<string | null>(null)
const feedbackType = ref<'success' | 'error'>('success')

// Form state
const currentArticle = ref<CatalogEditorialArticle | null>(null)
const title = ref('')
const summary = ref('')
const bodyMarkdown = ref('')
const applicationScope = ref('')
const compatibleSurfaces = ref('Acero inoxidable 316, Gres porcelánico, Resina epoxi')
const incompatibleSurfaces = ref('Aluminio no anodizado')
const dilutionDosageGuide = ref('150 ml por cada 10 litros de agua (1.5% v/v) a temperatura ambiente')
const requiredPpe = ref('Guantes de nitrilo UNE-EN 374, Gafas de protección química UNE-EN 166')
const hazardWarnings = ref('Provoca irritación ocular grave. No mezclar con ácidos fuertes.')
const technicalStandards = ref('UNE-EN 13697, Protocolo APPCC')
const supplierReferenceText = ref('Detergente multiusos líquido para todo tipo de suelos y superficies lavables.')

// Quality assessment computed in real-time
const qualityAssessment = computed(() => {
  return evaluateEditorialQuality({
    bodyMarkdown: bodyMarkdown.value,
    applicationScope: applicationScope.value,
    surfaceCompatibility: {
      compatible: compatibleSurfaces.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      incompatible: incompatibleSurfaces.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    },
    dilutionDosageGuide: dilutionDosageGuide.value,
    safetyAndPpe: {
      requiredPpe: requiredPpe.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      hazardWarnings: hazardWarnings.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    },
    supplierReferenceText: supplierReferenceText.value
  })
})

const similarityPercent = computed(() => {
  return (qualityAssessment.value.similarityScore * 100).toFixed(1)
})

async function loadArticle() {
  loading.value = true
  loadError.value = null
  try {
    const res = await requestFetch<CatalogEditorialArticle | null>(
      `/api/admin/catalog-editorial/article?targetType=${props.targetType}&targetId=${encodeURIComponent(props.targetId)}`
    )
    if (res && res.title) {
      currentArticle.value = res
      title.value = res.title
      summary.value = res.summary
      bodyMarkdown.value = res.bodyMarkdown
      applicationScope.value = res.applicationScope
      compatibleSurfaces.value = res.surfaceCompatibility?.compatible?.join(', ') || ''
      incompatibleSurfaces.value = res.surfaceCompatibility?.incompatible?.join(', ') || ''
      dilutionDosageGuide.value = res.dilutionDosageGuide
      requiredPpe.value = res.safetyAndPpe?.requiredPpe?.join(', ') || ''
      hazardWarnings.value = res.safetyAndPpe?.hazardWarnings?.join(', ') || ''
      technicalStandards.value = res.technicalStandards?.join(', ') || ''
      supplierReferenceText.value = res.supplierReferenceText || ''
    }
  } catch {
    // 404 is normal for new article
  } finally {
    loading.value = false
  }
}

async function handleSave() {
  if (!qualityAssessment.value.isValid) {
    feedbackType.value = 'error'
    feedbackMessage.value = qualityAssessment.value.reasons.join(' | ')
    return
  }

  saving.value = true
  feedbackMessage.value = null
  try {
    const payload = {
      targetType: props.targetType,
      targetId: props.targetId,
      title: title.value,
      summary: summary.value,
      bodyMarkdown: bodyMarkdown.value,
      applicationScope: applicationScope.value,
      surfaceCompatibility: {
        compatible: compatibleSurfaces.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        incompatible: incompatibleSurfaces.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      },
      dilutionDosageGuide: dilutionDosageGuide.value,
      safetyAndPpe: {
        requiredPpe: requiredPpe.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        hazardWarnings: hazardWarnings.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      },
      technicalStandards: technicalStandards.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      supplierReferenceText: supplierReferenceText.value || null,
      expectedVersion: currentArticle.value?.version
    }

    const saved = await requestFetch<CatalogEditorialArticle>('/api/admin/catalog-editorial/upsert', {
      method: 'POST',
      body: payload
    })
    currentArticle.value = saved
    feedbackType.value = 'success'
    feedbackMessage.value = 'Contenido editorial profesional guardado correctamente.'
  } catch (err: unknown) {
    feedbackType.value = 'error'
    feedbackMessage.value = err instanceof Error ? err.message : 'Error al guardar el contenido editorial'
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadArticle()
})
</script>

<template>
  <div
    class="editorial-editor-panel p-6 bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-zinc-200 dark:border-zinc-800"
  >
    <header class="mb-6 flex flex-wrap justify-between items-center gap-4">
      <div>
        <h2 class="text-xl font-bold text-zinc-900 dark:text-zinc-100">Contenido editorial propio (CAT-019)</h2>
        <p class="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
          Objetivo: <span class="font-semibold">{{ targetType.toUpperCase() }}</span> (ID: {{ targetId }})
          <span v-if="currentArticle" class="ml-2 px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded text-xs">
            Estado: {{ currentArticle.status }} (v{{ currentArticle.version }})
          </span>
        </p>
      </div>

      <button
        type="button"
        class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg text-sm transition disabled:opacity-50"
        :disabled="saving"
        @click="handleSave"
      >
        {{ saving ? 'Guardando...' : 'Guardar Editorial' }}
      </button>
    </header>

    <!-- Feedback Message -->
    <div
      v-if="feedbackMessage"
      class="mb-6 p-4 rounded-lg text-sm"
      :class="{
        'bg-emerald-50 text-emerald-800 border border-emerald-200': feedbackType === 'success',
        'bg-rose-50 text-rose-800 border border-rose-200': feedbackType === 'error'
      }"
      role="alert"
    >
      {{ feedbackMessage }}
    </div>

    <!-- Live Anti-Duplication & Quality Indicator -->
    <div
      class="mb-6 p-4 rounded-lg border flex flex-wrap items-center justify-between gap-4"
      :class="qualityAssessment.isValid ? 'bg-emerald-50/50 border-emerald-200' : 'bg-amber-50/60 border-amber-300'"
    >
      <div>
        <h4 class="font-semibold text-sm flex items-center gap-2">
          <span>Control Anti-Duplicación y Calidad Profesional:</span>
          <span
            class="px-2 py-0.5 rounded text-xs font-bold"
            :class="qualityAssessment.isValid ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'"
          >
            {{ qualityAssessment.isValid ? 'CUMPLE REQUISITOS' : 'REQUIERE AJUSTES' }}
          </span>
        </h4>
        <div class="text-xs text-zinc-600 dark:text-zinc-400 mt-1 space-x-3">
          <span
            >Coincidencia con proveedor: <strong>{{ similarityPercent }}%</strong> (Tope: 35.0%)</span
          >
          <span
            >Supera contenido proveedor: <strong>{{ qualityAssessment.surpassesSupplier ? 'SÍ' : 'NO' }}</strong></span
          >
        </div>
      </div>
      <div v-if="!qualityAssessment.isValid" class="text-xs text-rose-700 font-medium">
        {{ qualityAssessment.reasons[0] }}
      </div>
    </div>

    <!-- Form -->
    <div class="space-y-4">
      <div>
        <label for="editorial-title" class="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
          Título Editorial Profesional:
        </label>
        <input
          id="editorial-title"
          v-model="title"
          type="text"
          placeholder="Ej: Protocolo de Limpieza y Desengrase Pesado en Cocinas Colectivas"
          class="w-full px-3 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800"
        />
      </div>

      <div>
        <label for="editorial-summary" class="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
          Resumen Ejecutivo B2B:
        </label>
        <input
          id="editorial-summary"
          v-model="summary"
          type="text"
          placeholder="Breve introducción para compradores y técnicos"
          class="w-full px-3 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800"
        />
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label for="editorial-scope" class="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
            Ámbito de Aplicación Profesional:
          </label>
          <input
            id="editorial-scope"
            v-model="applicationScope"
            type="text"
            placeholder="Hostelería, Industrias cárnicas, Hospitalario"
            class="w-full px-3 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800"
          />
        </div>
        <div>
          <label for="editorial-dilution" class="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
            Guía de Dosificación / Dilución Técnica:
          </label>
          <input
            id="editorial-dilution"
            v-model="dilutionDosageGuide"
            type="text"
            placeholder="50 ml / 10L (0.5%), aplicación con fregadora automática"
            class="w-full px-3 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800"
          />
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label for="compatible-surfaces" class="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
            Superficies Compatibles (separadas por coma):
          </label>
          <input
            id="compatible-surfaces"
            v-model="compatibleSurfaces"
            type="text"
            class="w-full px-3 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800"
          />
        </div>
        <div>
          <label for="incompatible-surfaces" class="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
            Superficies Incompatibles / Prohibidas:
          </label>
          <input
            id="incompatible-surfaces"
            v-model="incompatibleSurfaces"
            type="text"
            class="w-full px-3 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800"
          />
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label for="required-ppe" class="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
            EPIs de Seguridad Química Obligatorios:
          </label>
          <input
            id="required-ppe"
            v-model="requiredPpe"
            type="text"
            class="w-full px-3 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800"
          />
        </div>
        <div>
          <label for="hazard-warnings" class="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
            Advertencias de Peligro y Normativa:
          </label>
          <input
            id="hazard-warnings"
            v-model="hazardWarnings"
            type="text"
            class="w-full px-3 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800"
          />
        </div>
      </div>

      <div>
        <label for="supplier-ref-text" class="block text-xs font-semibold text-zinc-500 mb-1">
          Texto Original de Referencia del Proveedor (para control de similitud):
        </label>
        <textarea
          id="supplier-ref-text"
          v-model="supplierReferenceText"
          rows="2"
          class="w-full px-3 py-2 text-xs rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 font-mono text-zinc-500"
        ></textarea>
      </div>

      <div>
        <label for="editorial-body" class="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
          Cuerpo Editorial Propio (Markdown técnico profesional):
        </label>
        <textarea
          id="editorial-body"
          v-model="bodyMarkdown"
          rows="6"
          placeholder="Redacta la guía técnica detallada, procedimientos de aplicación, advertencias químicas y ventajas profesionales..."
          class="w-full px-3 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono"
        ></textarea>
      </div>
    </div>
  </div>
</template>
