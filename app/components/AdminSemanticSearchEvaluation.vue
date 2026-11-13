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
    searchError.value = 'No se ha podido hacer la búsqueda de prueba. Vuelve a intentarlo.'
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
    successMessage.value = 'Valoración guardada.'
    notes.value = ''
    await loadData()
  } catch {
    error.value = 'No se ha podido guardar la valoración. Vuelve a intentarlo.'
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadData()
})

const SCORE_LABELS = ['No tiene nada que ver', 'Poco que ver', 'Relacionado', 'Muy adecuado', 'Justo lo que buscaba']
const percent = (value: number) => (value * 100).toFixed(1) + '%'
</script>

<template>
  <div class="adm-stack">
    <UAlert
      v-if="error"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="error"
      :actions="[{ label: 'Reintentar', color: 'neutral', variant: 'outline', onClick: () => void loadData() }]"
    />
    <UAlert
      v-if="successMessage"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successMessage"
    />

    <div class="adm-grid">
      <AdminStat
        label="Calidad del orden"
        :value="benchmark ? percent(benchmark.ndcgAt5) : null"
        hint="Lo bien ordenados que salen los 5 primeros resultados"
      />
      <AdminStat
        label="Aciertos entre los 5 primeros"
        :value="benchmark ? percent(benchmark.precisionAt5) : null"
        hint="Resultados útiles entre los 5 primeros"
      />
      <AdminStat
        label="Posición del primer acierto"
        :value="benchmark ? benchmark.mrr.toFixed(3) : null"
        hint="1,000 = el mejor resultado sale siempre el primero"
      />
      <AdminStat
        label="Valoraciones"
        :value="benchmark ? benchmark.totalJudgments : 0"
        :hint="`${benchmark ? benchmark.totalQueries : 0} búsquedas distintas`"
      />
    </div>

    <AdminCard
      title="Probar una búsqueda"
      description="Escribe lo que pondría un cliente, mira qué productos salen y valora si el resultado es bueno."
    >
      <div class="adm-stack">
        <form class="adm-toolbar" @submit.prevent="performTestSearch">
          <input
            v-model="testQuery"
            type="text"
            placeholder="Por ejemplo: quitar grasa quemada de la campana"
            class="min-w-0 flex-1 basis-64"
            aria-label="Consulta para prueba de búsqueda semántica"
          />
          <AdminButton type="submit" :loading="searching" :disabled="!testQuery.trim()">Probar búsqueda</AdminButton>
        </form>
        <UAlert
          v-if="searchError"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="searchError"
        />

        <template v-if="testResults.length > 0">
          <fieldset class="adm-field">
            <legend class="adm-label">Elige el producto que quieres valorar</legend>
            <ul class="adm-list rounded-[var(--radius-surface)] border border-[var(--border)]">
              <li v-for="item in testResults" :key="item.uuid">
                <label class="adm-check min-w-0 flex-1">
                  <input v-model="selectedProductId" type="radio" :value="item.uuid" name="evaluated-product" />
                  <span class="min-w-0">
                    <span class="block font-semibold text-[var(--text-strong)]">{{ item.name }}</span>
                    <span class="adm-help block">
                      <template v-if="item.sku">Ref. {{ item.sku }} · </template>{{ adminMoney(item.minPrice) }}
                    </span>
                  </span>
                </label>
                <AdminBadge :tone="item.inStock ? 'success' : 'warning'" plain>
                  {{ item.inStock ? 'En stock' : 'Sin stock' }}
                </AdminBadge>
                <AdminBadge :tone="item.isSemanticMatch ? 'info' : 'neutral'">
                  {{ item.isSemanticMatch ? 'Encontrado por significado' : 'Encontrado por palabras' }}
                </AdminBadge>
              </li>
            </ul>
          </fieldset>

          <fieldset class="adm-field">
            <legend class="adm-label">¿Es un buen resultado para esa búsqueda?</legend>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="score in [0, 1, 2, 3, 4]"
                :key="score"
                type="button"
                class="adm-chip"
                :aria-pressed="selectedScore === score"
                @click="selectedScore = score"
              >
                {{ score }} · {{ SCORE_LABELS[score] }}
              </button>
            </div>
          </fieldset>

          <AdminFormField v-slot="{ id }" label="Notas (opcional)">
            <input :id="id" v-model="notes" type="text" placeholder="Por qué lo valoras así" />
          </AdminFormField>

          <div class="flex justify-end">
            <AdminButton variant="primary" :loading="saving" :disabled="!selectedProductId" @click="submitJudgment">
              Guardar valoración
            </AdminButton>
          </div>
        </template>
      </div>
    </AdminCard>

    <AdminCard title="Valoraciones guardadas" flush>
      <template #actions>
        <AdminButton size="sm" icon="i-lucide-rotate-cw" :loading="loading" @click="loadData">Actualizar</AdminButton>
      </template>
      <div v-if="loading && evaluations.length === 0" class="adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando valoraciones…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
      </div>

      <AdminEmptyState
        v-else-if="evaluations.length === 0"
        icon="i-lucide-clipboard-check"
        title="No hay evaluaciones humanas registradas todavía"
        description="Prueba una búsqueda arriba y valora los resultados."
      />

      <div v-else class="adm-table-wrap">
        <table class="adm-table">
          <thead>
            <tr>
              <th scope="col">Búsqueda</th>
              <th scope="col">Producto</th>
              <th scope="col">Valoración</th>
              <th scope="col">Notas</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in evaluations" :key="item.id">
              <td class="font-semibold text-[var(--text-strong)]">{{ item.queryNormalized }}</td>
              <td>#{{ item.productId.slice(0, 8).toUpperCase() }}</td>
              <td>
                <AdminBadge
                  :tone="item.relevanceScore >= 3 ? 'success' : item.relevanceScore >= 2 ? 'info' : 'warning'"
                >
                  {{ item.relevanceScore }} / 4
                </AdminBadge>
              </td>
              <td>{{ item.notes || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </AdminCard>
  </div>
</template>
