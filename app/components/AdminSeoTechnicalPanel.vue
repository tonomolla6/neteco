<script setup lang="ts">
import { ref, onMounted } from 'vue'

const requestFetch = useRequestFetch()

interface CrawlRun {
  id: string
  status: string
  triggerType: string
  totalUrlsScanned: number
  status2xxCount: number
  status4xxCount: number
  status5xxCount: number
  canonicalIssuesCount: number
  noindexCount: number
  missingSchemaCount: number
  orphanCount: number
  maxDepthReached: number
  accidentalChangesCount: number
  startedAt: string
  completedAt?: string | null
}

interface SeoIssue {
  id: string
  url: string
  issueType: string
  severity: 'critical' | 'warning' | 'info'
  details: Record<string, unknown>
  createdAt: string
}

interface BotWasteSummary {
  totalCrawls: number
  verifiedBotCrawls: number
  fakeBotCrawls: number
  unverifiedCrawls: number
  wasteCrawls: number
  wastePercentage: number
  wasteByCategory: Record<string, number>
  topWastedUrls: Array<{ path: string; hits: number; wasteCategory: string; statusCode: number }>
  errorRate4xx: number
  errorRate5xx: number
}

interface AiSearchCitation {
  productId: string
  slug: string
  title: string
  sku: string
  priceCents: number
  formattedPrice: string
  inStock: boolean
  canonicalUrl: string
  relevanceSnippet: string
  safetyAdvice?: string
}

interface AiSearchAnswer {
  query: string
  answerText: string
  citations: AiSearchCitation[]
  groundingScore: number
  isIndexable: boolean
  noindexEnforced: boolean
  canonicalUrl: string
}

interface CuratedGuide {
  id: string
  slug: string
  topicQuery: string
  title: string
  isIndexable: boolean
  canonicalUrl: string
  version: number
  status: string
  updatedAt: string
}

const activeTab = ref<'crawler' | 'bots' | 'ai-search'>('crawler')
const loading = ref(false)
const actionLoading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

// Crawler state
const crawlRuns = ref<CrawlRun[]>([])
const selectedRunId = ref<string | null>(null)
const runIssues = ref<SeoIssue[]>([])

// Bot logs state
const botSummary = ref<BotWasteSummary | null>(null)

// AI Search state
const testQuery = ref('desengrasante industrial hornos')
const aiResult = ref<AiSearchAnswer | null>(null)
const curatedGuides = ref<CuratedGuide[]>([])

async function loadCrawlerData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const runs = (await requestFetch('/api/admin/seo/crawl/runs')) as CrawlRun[]
    crawlRuns.value = runs || []
    if (runs && runs.length > 0 && !selectedRunId.value) {
      selectedRunId.value = runs[0]!.id
      await loadRunIssues(runs[0]!.id)
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al cargar monitorización técnica'
  } finally {
    loading.value = false
  }
}

async function loadRunIssues(runId: string) {
  selectedRunId.value = runId
  try {
    const issues = (await requestFetch(`/api/admin/seo/crawl/issues?runId=${encodeURIComponent(runId)}`)) as SeoIssue[]
    runIssues.value = issues || []
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al cargar incidencias del crawl'
  }
}

async function triggerCrawl(type: 'manual' | 'scheduled' = 'manual') {
  actionLoading.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const newRun = (await requestFetch('/api/admin/seo/crawl/run', {
      method: 'POST',
      body: { triggerType: type, seedUrls: ['/'], maxDepth: 4 }
    })) as CrawlRun
    successMessage.value = `Crawl completado: ${newRun.totalUrlsScanned} URLs analizadas.`
    await loadCrawlerData()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al ejecutar crawl técnico'
  } finally {
    actionLoading.value = false
  }
}

async function loadBotData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const summary = (await requestFetch('/api/admin/seo/bots/summary')) as BotWasteSummary
    botSummary.value = summary
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al cargar métricas de bots'
  } finally {
    loading.value = false
  }
}

async function runRetentionSweep() {
  actionLoading.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/seo/bots/retention/sweep', {
      method: 'POST'
    })) as { prunedCount: number }
    successMessage.value = `Purga de retención completada: ${res.prunedCount} registros obsoletos eliminados.`
    await loadBotData()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al ejecutar purga de retención'
  } finally {
    actionLoading.value = false
  }
}

async function loadAiSearchData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const guides = (await requestFetch('/api/admin/seo/ai/curated')) as CuratedGuide[]
    curatedGuides.value = guides || []
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al cargar guías editoriales'
  } finally {
    loading.value = false
  }
}

async function testGroundedSearch() {
  if (!testQuery.value.trim()) return
  actionLoading.value = true
  errorMessage.value = ''
  try {
    const res = await requestFetch<AiSearchAnswer, string>('/api/search/ai', {
      method: 'POST',
      body: { query: testQuery.value }
    })
    aiResult.value = res
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al consultar búsqueda IA'
  } finally {
    actionLoading.value = false
  }
}

function switchTab(tab: 'crawler' | 'bots' | 'ai-search') {
  activeTab.value = tab
  errorMessage.value = ''
  successMessage.value = ''
  if (tab === 'crawler') loadCrawlerData()
  if (tab === 'bots') loadBotData()
  if (tab === 'ai-search') loadAiSearchData()
}

onMounted(() => {
  loadCrawlerData()
})
</script>

<template>
  <div class="seo-technical-panel" role="region" aria-label="Panel de Monitorización y Control SEO Técnico">
    <header class="panel-header">
      <div class="title-wrap">
        <h1 class="panel-title">SEO Técnico, Crawl & Búsqueda IA</h1>
        <p class="panel-subtitle">
          Monitorización continua (SEO-023), logs de bots (SEO-024) y guardarraíles IA (SEO-032).
        </p>
      </div>

      <nav class="tabs-nav" role="tablist" aria-label="Secciones SEO">
        <button
          role="tab"
          :aria-selected="activeTab === 'crawler'"
          :class="['tab-btn', { active: activeTab === 'crawler' }]"
          @click="switchTab('crawler')"
        >
          Monitorización Técnica
        </button>
        <button
          role="tab"
          :aria-selected="activeTab === 'bots'"
          :class="['tab-btn', { active: activeTab === 'bots' }]"
          @click="switchTab('bots')"
        >
          Análisis Bots & Desperdicio
        </button>
        <button
          role="tab"
          :aria-selected="activeTab === 'ai-search'"
          :class="['tab-btn', { active: activeTab === 'ai-search' }]"
          @click="switchTab('ai-search')"
        >
          Búsqueda IA & Guardarraíles
        </button>
      </nav>
    </header>

    <!-- Feedback messages -->
    <div v-if="errorMessage" class="alert alert-error" role="alert">
      <span>{{ errorMessage }}</span>
    </div>
    <div v-if="successMessage" class="alert alert-success" role="status">
      <span>{{ successMessage }}</span>
    </div>

    <!-- TAB 1: CRAWLER (SEO-023) -->
    <section v-if="activeTab === 'crawler'" class="tab-content" aria-label="Monitorización SEO técnica continua">
      <div class="actions-bar">
        <button
          class="btn btn-primary"
          :disabled="actionLoading"
          aria-label="Ejecutar Crawl Técnico Ahora"
          @click="triggerCrawl('manual')"
        >
          {{ actionLoading ? 'Analizando catálogo...' : 'Ejecutar Crawl Técnico' }}
        </button>
      </div>

      <div v-if="loading" class="state-box" aria-live="polite">
        <p>Cargando auditorías técnicas...</p>
      </div>

      <div v-else-if="crawlRuns.length === 0" class="state-box empty" aria-live="polite">
        <p>No se han registrado auditorías de crawl técnico todavía.</p>
        <button class="btn btn-secondary" @click="triggerCrawl('manual')">Lanzar primer rastreo</button>
      </div>

      <div v-else class="crawler-dashboard">
        <!-- Overview of latest run -->
        <div v-if="crawlRuns[0]" class="metrics-grid">
          <div class="metric-card">
            <span class="metric-label">URLs Analizadas</span>
            <span class="metric-value">{{ crawlRuns[0].totalUrlsScanned }}</span>
          </div>
          <div class="metric-card ok">
            <span class="metric-label">2xx Válidas</span>
            <span class="metric-value">{{ crawlRuns[0].status2xxCount }}</span>
          </div>
          <div class="metric-card error">
            <span class="metric-label">4xx Rotas</span>
            <span class="metric-value">{{ crawlRuns[0].status4xxCount }}</span>
          </div>
          <div class="metric-card error">
            <span class="metric-label">5xx Errores</span>
            <span class="metric-value">{{ crawlRuns[0].status5xxCount }}</span>
          </div>
          <div class="metric-card warning">
            <span class="metric-label">Canonicals</span>
            <span class="metric-value">{{ crawlRuns[0].canonicalIssuesCount }}</span>
          </div>
          <div class="metric-card warning">
            <span class="metric-label">Noindex</span>
            <span class="metric-value">{{ crawlRuns[0].noindexCount }}</span>
          </div>
          <div class="metric-card warning">
            <span class="metric-label">Huérfanas</span>
            <span class="metric-value">{{ crawlRuns[0].orphanCount }}</span>
          </div>
          <div class="metric-card critical">
            <span class="metric-label">Regresiones</span>
            <span class="metric-value">{{ crawlRuns[0].accidentalChangesCount }}</span>
          </div>
        </div>

        <!-- Issues table -->
        <div class="issues-section">
          <h2 class="section-title">Incidencias Detectadas ({{ runIssues.length }})</h2>
          <div v-if="runIssues.length === 0" class="state-box clean">
            <p>Salud técnica óptima: 0 errores críticos ni advertencias detectadas.</p>
          </div>
          <table v-else class="data-table" aria-label="Tabla de incidencias SEO">
            <thead>
              <tr>
                <th scope="col">Severidad</th>
                <th scope="col">Tipo de Incidencia</th>
                <th scope="col">URL</th>
                <th scope="col">Detalle</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="issue in runIssues" :key="issue.id">
                <td>
                  <span :class="['badge', `badge-${issue.severity}`]">{{ issue.severity }}</span>
                </td>
                <td class="font-mono">{{ issue.issueType }}</td>
                <td class="font-mono text-break">{{ issue.url }}</td>
                <td>{{ JSON.stringify(issue.details) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 2: BOT LOGS & CRAWL WASTE (SEO-024) -->
    <section v-if="activeTab === 'bots'" class="tab-content" aria-label="Análisis de logs de bots y desperdicio">
      <div class="actions-bar">
        <button
          class="btn btn-secondary"
          :disabled="actionLoading"
          aria-label="Ejecutar Purga de Retención"
          @click="runRetentionSweep"
        >
          {{ actionLoading ? 'Purgando...' : 'Ejecutar Purga de Retención' }}
        </button>
      </div>

      <div v-if="loading" class="state-box" aria-live="polite">
        <p>Cargando análisis de bots...</p>
      </div>

      <div v-else-if="!botSummary || botSummary.totalCrawls === 0" class="state-box empty" aria-live="polite">
        <p>Sin visitas de bots indexadores registradas en el periodo actual.</p>
      </div>

      <div v-else class="bots-dashboard">
        <div class="metrics-grid">
          <div class="metric-card">
            <span class="metric-label">Total Rastreos</span>
            <span class="metric-value">{{ botSummary.totalCrawls }}</span>
          </div>
          <div class="metric-card ok">
            <span class="metric-label">Bots Verificados</span>
            <span class="metric-value">{{ botSummary.verifiedBotCrawls }}</span>
          </div>
          <div class="metric-card error">
            <span class="metric-label">Bots Falsos / Spoofed</span>
            <span class="metric-value">{{ botSummary.fakeBotCrawls }}</span>
          </div>
          <div class="metric-card warning">
            <span class="metric-label">Desperdicio (Waste)</span>
            <span class="metric-value">{{ botSummary.wastePercentage }}%</span>
          </div>
          <div class="metric-card error">
            <span class="metric-label">Tasa Error 4xx</span>
            <span class="metric-value">{{ botSummary.errorRate4xx }}%</span>
          </div>
        </div>

        <div class="waste-breakdown">
          <h2 class="section-title">Desperdicio por Categoría</h2>
          <div class="category-bars">
            <div v-for="(count, category) in botSummary.wasteByCategory" :key="category" class="cat-row">
              <span class="cat-name">{{ category }}</span>
              <span class="cat-count badge">{{ count }}</span>
            </div>
          </div>
        </div>

        <div class="top-wasted-section">
          <h2 class="section-title">URLs con Mayor Desperdicio de Rastreo</h2>
          <table class="data-table" aria-label="URLs con mayor desperdicio">
            <thead>
              <tr>
                <th scope="col">Ruta</th>
                <th scope="col">Impactos</th>
                <th scope="col">Categoría de Desperdicio</th>
                <th scope="col">Código HTTP</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in botSummary.topWastedUrls" :key="item.path">
                <td class="font-mono text-break">{{ item.path }}</td>
                <td>{{ item.hits }}</td>
                <td>
                  <span class="badge badge-warning">{{ item.wasteCategory }}</span>
                </td>
                <td>{{ item.statusCode }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 3: AI SEARCH & SEO GUARDRAILS (SEO-032) -->
    <section
      v-if="activeTab === 'ai-search'"
      class="tab-content"
      aria-label="Búsqueda semántica IA y guardarraíles SEO"
    >
      <div class="guardrail-banner">
        <div class="guardrail-badge">Protección SEO Base Activa</div>
        <p>
          Las respuestas sintéticas dinámicas por IA incluyen siempre encabezado
          <code>X-Robots-Tag: noindex, follow, noarchive</code> y canónicos hacia catálogo primario. Se bloquea la
          indexación de páginas delgadas automáticas.
        </p>
      </div>

      <div class="ai-tester-card">
        <h2 class="section-title">Consultar motor de búsqueda semántica anclado</h2>
        <div class="search-form">
          <input
            v-model="testQuery"
            type="text"
            class="input-text"
            placeholder="Ej: desengrasante industrial para hornos..."
            aria-label="Consulta de búsqueda IA"
          />
          <button class="btn btn-primary" :disabled="actionLoading" @click="testGroundedSearch">
            {{ actionLoading ? 'Sintetizando...' : 'Consultar IA' }}
          </button>
        </div>

        <div v-if="aiResult" class="ai-result-box" aria-live="polite">
          <div class="result-header">
            <span class="badge badge-ok">Grounding Score: {{ aiResult.groundingScore }}</span>
            <span class="badge badge-warning">Indexable: {{ String(aiResult.isIndexable) }}</span>
            <span class="badge badge-ok">Noindex Enforced: {{ String(aiResult.noindexEnforced) }}</span>
          </div>
          <p class="ai-answer-text">{{ aiResult.answerText }}</p>

          <h3 class="citations-title">Citas Verificadas del Catálogo Activo ({{ aiResult.citations.length }})</h3>
          <ul class="citations-list">
            <li v-for="citation in aiResult.citations" :key="citation.productId" class="citation-item">
              <div class="citation-info">
                <strong>{{ citation.title }}</strong>
                <span class="citation-sku">SKU: {{ citation.sku }} | {{ citation.formattedPrice }}</span>
                <span class="citation-link">Canónico: {{ citation.canonicalUrl }}</span>
              </div>
              <p v-if="citation.safetyAdvice" class="citation-safety">{{ citation.safetyAdvice }}</p>
            </li>
          </ul>
        </div>
      </div>

      <!-- Curated guides section -->
      <div class="curated-guides-section">
        <h2 class="section-title">Guías editoriales curadas con aprobación humana</h2>
        <p class="help-text">
          Solo las respuestas revisadas y aprobadas por editores con profundidad de contenido demostrada pueden
          publicarse como URLs indexables.
        </p>

        <div v-if="curatedGuides.length === 0" class="state-box empty">
          <p>No hay guías editoriales aprobadas todavía.</p>
        </div>
        <table v-else class="data-table" aria-label="Guías editoriales curadas">
          <thead>
            <tr>
              <th scope="col">Tema / Consulta</th>
              <th scope="col">Título</th>
              <th scope="col">URL Canónica</th>
              <th scope="col">Estado</th>
              <th scope="col">Indexable</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="guide in curatedGuides" :key="guide.id">
              <td>{{ guide.topicQuery }}</td>
              <td>
                <strong>{{ guide.title }}</strong>
              </td>
              <td class="font-mono">{{ guide.canonicalUrl }}</td>
              <td>
                <span class="badge badge-ok">{{ guide.status }}</span>
              </td>
              <td>
                <span :class="['badge', guide.isIndexable ? 'badge-ok' : 'badge-warning']">{{
                  guide.isIndexable ? 'Sí' : 'No'
                }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.seo-technical-panel {
  padding: 1.5rem;
  font-family:
    system-ui,
    -apple-system,
    sans-serif;
  color: #1f2937;
}

.panel-header {
  margin-bottom: 2rem;
  border-bottom: 1px solid #e5e7eb;
  padding-bottom: 1rem;
}

.panel-title {
  font-size: 1.5rem;
  font-weight: 700;
  margin: 0;
  color: #111827;
}

.panel-subtitle {
  font-size: 0.875rem;
  color: #6b7280;
  margin-top: 0.25rem;
}

.tabs-nav {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}

.tab-btn {
  padding: 0.5rem 1rem;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  background: #f9fafb;
  cursor: pointer;
  font-weight: 500;
  font-size: 0.875rem;
}

.tab-btn.active {
  background: #2563eb;
  color: #fff;
  border-color: #2563eb;
}

.alert {
  padding: 0.75rem 1rem;
  border-radius: 0.375rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
}

.alert-error {
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #f87171;
}

.alert-success {
  background: #dcfce7;
  color: #166534;
  border: 1px solid #86efac;
}

.actions-bar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 1rem;
}

.btn {
  padding: 0.5rem 1rem;
  border-radius: 0.375rem;
  font-weight: 500;
  cursor: pointer;
  border: none;
}

.btn-primary {
  background: #2563eb;
  color: #fff;
}

.btn-secondary {
  background: #4b5563;
  color: #fff;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.metric-card {
  padding: 1rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  display: flex;
  flex-direction: column;
}

.metric-card.ok {
  border-left: 4px solid #10b981;
}
.metric-card.warning {
  border-left: 4px solid #f59e0b;
}
.metric-card.error {
  border-left: 4px solid #ef4444;
}
.metric-card.critical {
  border-left: 4px solid #b91c1c;
}

.metric-label {
  font-size: 0.75rem;
  color: #6b7280;
  text-transform: uppercase;
}

.metric-value {
  font-size: 1.5rem;
  font-weight: 700;
  margin-top: 0.25rem;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 0.375rem;
}

.data-table th,
.data-table td {
  padding: 0.75rem;
  border-bottom: 1px solid #e5e7eb;
  text-align: left;
}

.data-table th {
  background: #f9fafb;
  font-weight: 600;
}

.font-mono {
  font-family: monospace;
}
.text-break {
  word-break: break-all;
}

.badge {
  display: inline-block;
  padding: 0.2rem 0.5rem;
  border-radius: 0.25rem;
  font-size: 0.75rem;
  font-weight: 600;
  background: #e5e7eb;
}

.badge-critical {
  background: #fee2e2;
  color: #991b1b;
}
.badge-warning {
  background: #fef3c7;
  color: #92400e;
}
.badge-info {
  background: #e0f2fe;
  color: #075985;
}
.badge-ok {
  background: #dcfce7;
  color: #166534;
}

.guardrail-banner {
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  padding: 1rem;
  border-radius: 0.5rem;
  margin-bottom: 1.5rem;
}

.guardrail-badge {
  font-weight: 700;
  color: #1e40af;
  margin-bottom: 0.5rem;
}

.ai-tester-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  padding: 1.5rem;
  margin-bottom: 2rem;
}

.search-form {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}

.input-text {
  flex: 1;
  padding: 0.5rem 0.75rem;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
}

.ai-result-box {
  margin-top: 1.5rem;
  padding: 1rem;
  background: #f9fafb;
  border-radius: 0.375rem;
  border: 1px solid #e5e7eb;
}

.result-header {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.ai-answer-text {
  font-size: 1rem;
  line-height: 1.5;
  margin-bottom: 1.5rem;
}

.citations-list {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.citation-item {
  padding: 0.75rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 0.375rem;
}

.citation-info {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.citation-sku {
  font-size: 0.75rem;
  color: #4b5563;
}

.citation-link {
  font-size: 0.75rem;
  color: #2563eb;
  font-family: monospace;
}

.citation-safety {
  margin-top: 0.5rem;
  font-size: 0.8rem;
  color: #92400e;
  background: #fffbeb;
  padding: 0.25rem 0.5rem;
  border-radius: 0.25rem;
}

.state-box {
  padding: 2rem;
  text-align: center;
  background: #f9fafb;
  border: 1px dashed #d1d5db;
  border-radius: 0.5rem;
}
</style>
