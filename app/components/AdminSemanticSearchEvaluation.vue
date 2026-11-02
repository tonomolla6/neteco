<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type {
  HumanEvaluationItem,
  EvaluationBenchmarkResult,
  SemanticSearchSuggestion
} from '~~/shared/semantic-search'

defineProps<{
  runtime?: unknown
}>()

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const benchmark = ref<EvaluationBenchmarkResult | null>(null)
const evaluations = ref<HumanEvaluationItem[]>([])

const testQuery = ref('')
const searching = ref(false)
const testResults = ref<SemanticSearchSuggestion[]>([])
const searchError = ref<string | null>(null)

const selectedProductId = ref('')
const selectedScore = ref<number>(4)
const notes = ref('')
const saving = ref(false)
const successMessage = ref('')

async function loadData() {
  loading.value = true
  error.value = null
  try {
    const [bmRes, listRes] = await Promise.all([
      requestFetch<EvaluationBenchmarkResult>('/api/admin/search-evaluations/benchmark'),
      requestFetch<{ items: HumanEvaluationItem[]; total: number }>('/api/admin/search-evaluations')
    ])
    benchmark.value = bmRes
    evaluations.value = listRes.items
  } catch {
    error.value = 'No se ha podido cargar el panel de evaluación humana de búsqueda semántica.'
  } finally {
    loading.value = false
  }
}

async function performTestSearch() {
  if (!testQuery.value.trim()) return
  searching.value = true
  searchError.value = null
  try {
    const res = await requestFetch<{
      items: SemanticSearchSuggestion[]
      isSemantic: boolean
      lexicalFallback: boolean
    }>('/api/search/semantic', { query: { q: testQuery.value.trim() } })
    testResults.value = res.items
    if (res.items.length > 0 && !selectedProductId.value) {
      selectedProductId.value = res.items[0]?.uuid ?? ''
    }
  } catch {
    searchError.value = 'Error al ejecutar la búsqueda semántica de prueba.'
    testResults.value = []
  } finally {
    searching.value = false
  }
}

async function submitJudgment() {
  if (!testQuery.value.trim() || !selectedProductId.value) return
  saving.value = true
  error.value = null
  successMessage.value = ''
  try {
    const idempotencyKey = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await requestFetch('/api/admin/search-evaluations', {
      method: 'POST',
      headers: {
        'idempotency-key': idempotencyKey
      },
      body: {
        action: 'save',
        id: null,
        expectedVersion: 0,
        query: testQuery.value.trim(),
        productId: selectedProductId.value,
        relevanceScore: selectedScore.value,
        notes: notes.value.trim() || null
      }
    })
    successMessage.value = 'Evaluación de relevancia guardada correctamente.'
    notes.value = ''
    await loadData()
  } catch {
    error.value = 'No se ha podido guardar la evaluación de relevancia.'
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadData()
})
</script>

<template>
  <div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
    <div class="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-900 dark:text-slate-100">
          Evaluación humana de búsqueda semántica (SEA-019)
        </h2>
        <p class="text-sm text-slate-500 dark:text-slate-400">
          Supervisión de calidad basada en juicios humanos (ground truth), nDCG@5, Precision@5 y fallback léxico
          garantizado.
        </p>
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
        :disabled="loading"
        @click="loadData"
      >
        <span v-if="loading">Actualizando…</span>
        <span v-else>Actualizar</span>
      </button>
    </div>

    <!-- Error Alert -->
    <div
      v-if="error"
      role="alert"
      class="mb-6 rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-400"
    >
      {{ error }}
    </div>

    <!-- Success Alert -->
    <div
      v-if="successMessage"
      role="status"
      class="mb-6 rounded-lg bg-emerald-50 p-4 text-sm text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
    >
      {{ successMessage }}
    </div>

    <!-- Benchmark Cards -->
    <div class="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
      <div class="rounded-lg bg-slate-50 p-4 dark:bg-slate-800/60">
        <div class="text-xs font-medium text-slate-500 dark:text-slate-400">nDCG @ 5</div>
        <div class="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
          {{ benchmark ? (benchmark.ndcgAt5 * 100).toFixed(1) + '%' : '—' }}
        </div>
        <div class="mt-1 text-xs text-slate-400">Ganancia acumulada descontada</div>
      </div>

      <div class="rounded-lg bg-slate-50 p-4 dark:bg-slate-800/60">
        <div class="text-xs font-medium text-slate-500 dark:text-slate-400">Precision @ 5</div>
        <div class="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
          {{ benchmark ? (benchmark.precisionAt5 * 100).toFixed(1) + '%' : '—' }}
        </div>
        <div class="mt-1 text-xs text-slate-400">Aciertos relevantes top 5</div>
      </div>

      <div class="rounded-lg bg-slate-50 p-4 dark:bg-slate-800/60">
        <div class="text-xs font-medium text-slate-500 dark:text-slate-400">MRR</div>
        <div class="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
          {{ benchmark ? benchmark.mrr.toFixed(3) : '—' }}
        </div>
        <div class="mt-1 text-xs text-slate-400">Rango recíproco medio</div>
      </div>

      <div class="rounded-lg bg-slate-50 p-4 dark:bg-slate-800/60">
        <div class="text-xs font-medium text-slate-500 dark:text-slate-400">Juicios evaluados</div>
        <div class="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
          {{ benchmark ? benchmark.totalJudgments : 0 }}
        </div>
        <div class="mt-1 text-xs text-slate-400">{{ benchmark ? benchmark.totalQueries : 0 }} consultas únicas</div>
      </div>
    </div>

    <!-- Evaluation Workbench Section -->
    <div class="mb-8 rounded-lg border border-slate-200 p-5 dark:border-slate-800">
      <h3 class="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">
        Banco de pruebas y calificación humana
      </h3>
      <p class="mb-4 text-xs text-slate-500 dark:text-slate-400">
        Introduce una consulta natural o técnica, examina los resultados emparejados por el modelo semántico y emite un
        juicio de relevancia (0 a 4).
      </p>

      <form class="flex flex-col gap-3 sm:flex-row" @submit.prevent="performTestSearch">
        <input
          v-model="testQuery"
          type="text"
          placeholder="Ej: quitar grasa quemada campana cocina..."
          class="flex-1 rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-primary-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          aria-label="Consulta para prueba de búsqueda semántica"
        />
        <button
          type="submit"
          class="inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
          :disabled="searching || !testQuery.trim()"
        >
          <span v-if="searching">Buscando…</span>
          <span v-else>Probar búsqueda</span>
        </button>
      </form>

      <!-- Search Results Area -->
      <div v-if="testResults.length > 0" class="mt-6 space-y-4">
        <div class="text-xs font-medium uppercase tracking-wider text-slate-500">
          Resultados devueltos (anclados al catálogo)
        </div>

        <div class="space-y-2">
          <label
            v-for="item in testResults"
            :key="item.uuid"
            class="flex cursor-pointer items-center justify-between rounded-lg border p-3 text-sm transition"
            :class="
              selectedProductId === item.uuid
                ? 'border-primary-500 bg-primary-50/30 dark:border-primary-400 dark:bg-primary-950/20'
                : 'border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40'
            "
          >
            <div class="flex items-center gap-3">
              <input
                v-model="selectedProductId"
                type="radio"
                :value="item.uuid"
                name="evaluated-product"
                class="text-primary-600 focus:ring-primary-500"
              />
              <div>
                <div class="font-medium text-slate-900 dark:text-slate-100">{{ item.name }}</div>
                <div class="text-xs text-slate-500">
                  SKU: {{ item.sku || 'N/A' }} | {{ (item.minPrice / 100).toFixed(2) }}€ |
                  <span :class="item.inStock ? 'text-emerald-600 font-medium' : 'text-amber-600 font-medium'">
                    {{ item.inStock ? 'En stock' : 'Sin stock' }}
                  </span>
                </div>
              </div>
            </div>
            <div class="text-right">
              <span
                class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
                :class="
                  item.isSemanticMatch
                    ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300'
                    : 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300'
                "
              >
                {{ item.isSemanticMatch ? `Semántico (${item.semanticScore})` : 'Fallback léxico' }}
              </span>
            </div>
          </label>
        </div>

        <!-- Judgment form -->
        <div class="mt-4 rounded-lg bg-slate-50 p-4 dark:bg-slate-800/50">
          <div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Emitir juicio de relevancia</div>
          <div class="mt-2 flex flex-wrap gap-2">
            <button
              v-for="score in [0, 1, 2, 3, 4]"
              :key="score"
              type="button"
              class="rounded-lg px-3 py-1.5 text-xs font-medium transition"
              :class="
                selectedScore === score
                  ? 'bg-primary-600 text-white shadow-sm'
                  : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
              "
              @click="selectedScore = score"
            >
              {{ score }} -
              {{
                ['0: Irrelevante', '1: Apenas relevante', '2: Relevante', '3: Muy relevante', '4: Coincidencia exacta'][
                  score
                ]
              }}
            </button>
          </div>

          <div class="mt-3">
            <input
              v-model="notes"
              type="text"
              placeholder="Notas de justificación para auditoría (opcional)..."
              class="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-primary-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </div>

          <div class="mt-3 flex justify-end">
            <button
              type="button"
              class="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              :disabled="saving || !selectedProductId"
              @click="submitJudgment"
            >
              <span v-if="saving">Guardando juicio…</span>
              <span v-else>Registrar juicio de evaluación</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Existing Human Judgments Table -->
    <div>
      <h3 class="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">
        Historial de juicios humanos activos
      </h3>

      <div v-if="loading && evaluations.length === 0" class="py-8 text-center text-sm text-slate-400">
        Cargando evaluaciones…
      </div>

      <div
        v-else-if="evaluations.length === 0"
        class="rounded-lg border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400"
      >
        No hay evaluaciones humanas registradas todavía. Prueba una consulta arriba y califica los resultados.
      </div>

      <div v-else class="overflow-x-auto">
        <table class="w-full text-left text-sm text-slate-600 dark:text-slate-300">
          <thead class="border-b border-slate-200 text-xs uppercase text-slate-400 dark:border-slate-800">
            <tr>
              <th scope="col" class="py-2.5">Consulta</th>
              <th scope="col" class="py-2.5">Producto ID</th>
              <th scope="col" class="py-2.5">Puntuación</th>
              <th scope="col" class="py-2.5">Notas</th>
              <th scope="col" class="py-2.5">Versión</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
            <tr v-for="item in evaluations" :key="item.id">
              <td class="py-3 font-medium text-slate-900 dark:text-slate-100">{{ item.queryNormalized }}</td>
              <td class="py-3 font-mono text-xs text-slate-500">{{ item.productId.slice(0, 8) }}…</td>
              <td class="py-3">
                <span
                  class="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold"
                  :class="
                    item.relevanceScore >= 3
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                      : item.relevanceScore >= 2
                        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                        : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                  "
                >
                  {{ item.relevanceScore }} / 4
                </span>
              </td>
              <td class="py-3 text-xs text-slate-500">{{ item.notes || '—' }}</td>
              <td class="py-3 font-mono text-xs text-slate-400">v{{ item.version }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
