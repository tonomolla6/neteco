<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import {
  CMS_PREVIEW_BREAKPOINTS,
  type CmsPreviewBreakpoint,
  type ContentDiffResult,
  type ContentDocumentSnapshot
} from '~~/shared/cms-preview-comparison'

const props = withDefaults(
  defineProps<{
    pageId?: string
    initialBaseVersion?: number
    initialCompareVersion?: number
  }>(),
  {
    pageId: '40000000-0000-4000-8000-000000000001',
    initialBaseVersion: 1,
    initialCompareVersion: 2
  }
)

const requestFetch = useRequestFetch()
const loading = ref(false)
const errorMessage = ref('')

const activeBreakpoint = ref<CmsPreviewBreakpoint>('desktop')
const activeMode = ref<'side_by_side' | 'overlay' | 'diff_only'>('side_by_side')

const baseVersion = ref(props.initialBaseVersion)
const compareVersion = ref(props.initialCompareVersion)
const diffResult = ref<ContentDiffResult | null>(null)
const baseDoc = ref<ContentDocumentSnapshot | null>(null)
const compareDoc = ref<ContentDocumentSnapshot | null>(null)

// Template regression testing
const activeTab = ref<'preview_diff' | 'template_regression'>('preview_diff')
const selectedTemplate = ref<
  'home' | 'catalog' | 'search' | 'product' | 'cart_empty' | 'login' | 'promotional_landing'
>('home')
const regressionLoading = ref(false)
const regressionResult = ref<{ passed: boolean; missingCriticalSelectors: string[] } | null>(null)

const currentViewportWidth = computed(() => {
  return `${CMS_PREVIEW_BREAKPOINTS[activeBreakpoint.value].width}px`
})

function extractErrorCode(err: unknown, fallback: string): string {
  const code = (err as { data?: { error?: { code?: string } } })?.data?.error?.code
  return code ? `Error: ${code}` : fallback
}

async function fetchDiff() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch(
      `/api/admin/content/preview-comparison?pageId=${props.pageId}&baseVersion=${baseVersion.value}&compareVersion=${compareVersion.value}&breakpoint=${activeBreakpoint.value}`
    )) as {
      diff: ContentDiffResult
      baseDocument: ContentDocumentSnapshot
      compareDocument: ContentDocumentSnapshot
    }
    diffResult.value = res.diff
    baseDoc.value = res.baseDocument
    compareDoc.value = res.compareDocument
  } catch (err: unknown) {
    errorMessage.value = extractErrorCode(err, 'Error al obtener la comparación de preview')
  } finally {
    loading.value = false
  }
}

async function runRegressionCheck() {
  regressionLoading.value = true
  try {
    const res = (await requestFetch('/api/admin/content/templates/critical-regression', {
      method: 'POST',
      body: {
        templateName: selectedTemplate.value,
        breakpoint: activeBreakpoint.value,
        renderedSelectors: ['header', 'nav.main', 'section.hero', 'section.featured-products', 'footer']
      }
    })) as { passed: boolean; missingCriticalSelectors: string[] }
    regressionResult.value = res
  } catch (err: unknown) {
    errorMessage.value = extractErrorCode(err, 'Error al ejecutar regresión visual')
  } finally {
    regressionLoading.value = false
  }
}

onMounted(() => {
  void fetchDiff()
})
</script>

<template>
  <div class="admin-preview-comparison p-4 space-y-6 max-w-7xl mx-auto" aria-label="Comparación Visual de Preview">
    <!-- Header Controls -->
    <header class="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">Comparación Visual de Preview y Regresión</h1>
        <p class="text-sm text-gray-600">
          ADM-024: Breakpoints, diff de contenido y regresión visual de plantillas críticas.
        </p>
      </div>

      <!-- Navigation Tabs -->
      <nav class="flex gap-2" aria-label="Modos de vista">
        <button
          type="button"
          :class="[
            'px-3 py-1.5 rounded font-medium text-sm transition',
            activeTab === 'preview_diff' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          ]"
          @click="activeTab = 'preview_diff'"
        >
          Comparación de Contenido & Viewports
        </button>
        <button
          type="button"
          :class="[
            'px-3 py-1.5 rounded font-medium text-sm transition',
            activeTab === 'template_regression'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          ]"
          @click="activeTab = 'template_regression'"
        >
          Regresión Visual de Plantillas
        </button>
      </nav>
    </header>

    <!-- Error message banner -->
    <div v-if="errorMessage" role="alert" class="p-3 bg-red-50 border border-red-300 text-red-800 rounded text-sm">
      {{ errorMessage }}
    </div>

    <!-- TAB 1: Preview Diff & Responsive Breakpoints -->
    <section v-if="activeTab === 'preview_diff'" class="space-y-4">
      <!-- Toolbar -->
      <div class="flex flex-wrap items-center justify-between gap-4 bg-gray-50 p-3 rounded-lg border">
        <!-- Versions Picker -->
        <div class="flex items-center gap-2">
          <label class="text-sm font-medium text-gray-700">Versión Base:</label>
          <input
            v-model.number="baseVersion"
            type="number"
            min="0"
            class="w-16 px-2 py-1 border rounded text-sm"
            @change="fetchDiff"
          />
          <span class="text-gray-400">vs</span>
          <label class="text-sm font-medium text-gray-700">Versión Borrador:</label>
          <input
            v-model.number="compareVersion"
            type="number"
            min="1"
            class="w-16 px-2 py-1 border rounded text-sm"
            @change="fetchDiff"
          />
          <button
            type="button"
            class="px-3 py-1 bg-gray-200 hover:bg-gray-300 rounded text-sm font-medium"
            :disabled="loading"
            @click="fetchDiff"
          >
            Actualizar
          </button>
        </div>

        <!-- Breakpoint Switcher -->
        <div class="flex items-center gap-1" role="group" aria-label="Selector de breakpoints">
          <button
            v-for="(spec, bp) in CMS_PREVIEW_BREAKPOINTS"
            :key="bp"
            type="button"
            :class="[
              'px-2.5 py-1 text-xs font-medium rounded',
              activeBreakpoint === bp ? 'bg-blue-600 text-white' : 'bg-white border text-gray-700 hover:bg-gray-100'
            ]"
            :aria-pressed="activeBreakpoint === bp"
            @click="activeBreakpoint = bp"
          >
            {{ spec.label }}
          </button>
        </div>

        <!-- Mode Switcher -->
        <div class="flex items-center gap-1" role="group" aria-label="Modo de visualización">
          <button
            type="button"
            :class="[
              'px-2.5 py-1 text-xs font-medium rounded',
              activeMode === 'side_by_side'
                ? 'bg-gray-900 text-white'
                : 'bg-white border text-gray-700 hover:bg-gray-100'
            ]"
            @click="activeMode = 'side_by_side'"
          >
            Lado a Lado
          </button>
          <button
            type="button"
            :class="[
              'px-2.5 py-1 text-xs font-medium rounded',
              activeMode === 'diff_only' ? 'bg-gray-900 text-white' : 'bg-white border text-gray-700 hover:bg-gray-100'
            ]"
            @click="activeMode = 'diff_only'"
          >
            Solo Diff
          </button>
        </div>
      </div>

      <!-- Loading State -->
      <div v-if="loading" role="status" class="p-8 text-center text-gray-500">
        Calculando diff de contenido y renderizando vista previa…
      </div>

      <!-- Diff Summary Metrics -->
      <div v-else-if="diffResult" class="space-y-4">
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          <div class="p-3 bg-green-50 border border-green-200 rounded">
            <span class="text-xl font-bold text-green-700">+{{ diffResult.summary.addedBlocksCount }}</span>
            <p class="text-xs text-green-800">Bloques Añadidos</p>
          </div>
          <div class="p-3 bg-amber-50 border border-amber-200 rounded">
            <span class="text-xl font-bold text-amber-700">~{{ diffResult.summary.modifiedBlocksCount }}</span>
            <p class="text-xs text-amber-800">Bloques Modificados</p>
          </div>
          <div class="p-3 bg-red-50 border border-red-200 rounded">
            <span class="text-xl font-bold text-red-700">-{{ diffResult.summary.removedBlocksCount }}</span>
            <p class="text-xs text-red-800">Bloques Eliminados</p>
          </div>
          <div class="p-3 bg-gray-50 border border-gray-200 rounded">
            <span class="text-xl font-bold text-gray-700">{{ diffResult.summary.unchangedBlocksCount }}</span>
            <p class="text-xs text-gray-800">Sin Cambios</p>
          </div>
        </div>

        <!-- Metadata & SEO Diff Card -->
        <div
          v-if="diffResult.metadataDiff.titleChanged || diffResult.metadataDiff.seoChanged"
          class="p-4 bg-yellow-50 border border-yellow-200 rounded-lg"
        >
          <h2 class="text-sm font-bold text-yellow-900 mb-2">Cambios en Metadatos y SEO</h2>
          <div v-if="diffResult.metadataDiff.titleChanged" class="text-sm">
            <span class="text-gray-500 line-through mr-2">{{ diffResult.metadataDiff.oldTitle }}</span>
            <span class="text-green-700 font-semibold">{{ diffResult.metadataDiff.newTitle }}</span>
          </div>
          <div v-if="diffResult.metadataDiff.seoChanged" class="text-xs text-yellow-800 mt-1">
            SEO Title / Descripción / Indexación actualizados.
          </div>
        </div>

        <!-- Diff List -->
        <div class="border rounded-lg overflow-hidden bg-white">
          <div class="bg-gray-100 px-4 py-2 text-xs font-semibold uppercase text-gray-600 border-b">
            Detalle de Bloques de Contenido
          </div>
          <ul class="divide-y text-sm" role="list">
            <li
              v-for="b in diffResult.blockDiffs"
              :key="b.id"
              class="p-3 flex items-start justify-between gap-4"
              :class="{
                'bg-green-50/50': b.changeType === 'added',
                'bg-red-50/50': b.changeType === 'removed',
                'bg-amber-50/50': b.changeType === 'modified'
              }"
            >
              <div>
                <span
                  :class="[
                    'inline-block px-2 py-0.5 rounded text-xs font-bold mr-2',
                    b.changeType === 'added'
                      ? 'bg-green-200 text-green-800'
                      : b.changeType === 'removed'
                        ? 'bg-red-200 text-red-800'
                        : b.changeType === 'modified'
                          ? 'bg-amber-200 text-amber-800'
                          : 'bg-gray-200 text-gray-700'
                  ]"
                >
                  {{ b.changeType.toUpperCase() }}
                </span>
                <span class="font-mono text-xs text-gray-500">{{ b.id }}</span>
                <p v-if="b.newBlock" class="mt-1 text-gray-900 font-medium">
                  Tipo: {{ b.newBlock.type }} — {{ b.newBlock.text || b.newBlock.label || b.newBlock.title || '' }}
                </p>
                <p v-else-if="b.oldBlock" class="mt-1 text-gray-500 line-through">
                  Tipo: {{ b.oldBlock.type }} — {{ b.oldBlock.text || b.oldBlock.label || '' }}
                </p>
                <div v-if="b.fieldDifferences?.length" class="mt-1 text-xs text-amber-700">
                  Campos modificados: {{ b.fieldDifferences.join(', ') }}
                </div>
              </div>
            </li>
          </ul>
        </div>

        <!-- Viewport Preview Simulation (Side by Side) -->
        <div v-if="activeMode === 'side_by_side'" class="space-y-2 mt-6">
          <h3 class="text-sm font-bold text-gray-700">
            Simulador de Viewport ({{ CMS_PREVIEW_BREAKPOINTS[activeBreakpoint].label }})
          </h3>
          <div class="flex justify-center bg-gray-200 p-4 rounded-lg overflow-x-auto">
            <div
              class="bg-white shadow-lg border rounded transition-all duration-300 p-4"
              :style="{ width: currentViewportWidth }"
            >
              <div class="text-xs text-gray-400 border-b pb-1 mb-3 flex justify-between">
                <span>Vista Previa del Borrador (v{{ compareVersion }})</span>
                <span>Ancho: {{ currentViewportWidth }}</span>
              </div>
              <h1 class="text-xl font-bold mb-2">{{ compareDoc?.title }}</h1>
              <div class="space-y-3">
                <div v-for="block in compareDoc?.blocks" :key="block.id" class="p-2 border rounded text-sm">
                  <p class="font-semibold text-xs text-gray-400 uppercase">{{ block.type }}</p>
                  <p>{{ block.text || block.title || block.label }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 2: Critical Templates Visual Regression -->
    <section v-if="activeTab === 'template_regression'" class="space-y-4">
      <div class="bg-gray-50 p-4 rounded-lg border space-y-4">
        <div>
          <h2 class="text-lg font-bold text-gray-900">Regresión visual automatizada para plantillas críticas</h2>
          <p class="text-sm text-gray-600">
            Verifica la integridad visual y estructural del DOM en los breakpoints para evitar roturas.
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-4">
          <label class="text-sm font-medium text-gray-700">Plantilla Crítica:</label>
          <select v-model="selectedTemplate" class="px-3 py-1.5 border rounded text-sm bg-white">
            <option value="home">Portada (Home)</option>
            <option value="catalog">Catálogo de Productos</option>
            <option value="search">Búsqueda</option>
            <option value="product">Ficha de Producto</option>
            <option value="cart_empty">Carrito Vacío</option>
            <option value="login">Acceso Clientes</option>
            <option value="promotional_landing">Landing Promocional</option>
          </select>

          <button
            type="button"
            class="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-sm transition"
            :disabled="regressionLoading"
            @click="runRegressionCheck"
          >
            {{ regressionLoading ? 'Verificando…' : 'Ejecutar Comprobación' }}
          </button>
        </div>
      </div>

      <!-- Regression Result Banner -->
      <div
        v-if="regressionResult"
        class="p-4 rounded-lg border"
        :class="
          regressionResult.passed
            ? 'bg-green-50 border-green-300 text-green-900'
            : 'bg-red-50 border-red-300 text-red-900'
        "
      >
        <div class="flex items-center gap-2">
          <span class="font-bold text-lg">{{
            regressionResult.passed ? '✓ Regresión Visual Aprobada' : '✗ Fallo de Regresión Visual Detectado'
          }}</span>
        </div>
        <p class="text-sm mt-1">
          {{
            regressionResult.passed
              ? `Todos los selectores y elementos estructurales críticos coinciden con la línea base para ${selectedTemplate} en ${activeBreakpoint}.`
              : `Faltan ${regressionResult.missingCriticalSelectors.length} elementos críticos en la plantilla ${selectedTemplate}: ${regressionResult.missingCriticalSelectors.join(', ')}`
          }}
        </p>
      </div>
    </section>
  </div>
</template>
