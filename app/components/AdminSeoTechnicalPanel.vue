<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'

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
    successMessage.value = `Revisión terminada: ${newRun.totalUrlsScanned} páginas analizadas.`
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
    successMessage.value = `Se han borrado ${res.prunedCount} registros antiguos.`
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

type SeoTab = 'crawler' | 'bots' | 'ai-search'
const TABS: Array<{ value: SeoTab; label: string }> = [
  { value: 'crawler', label: 'Revisión de páginas' },
  { value: 'bots', label: 'Visitas de buscadores' },
  { value: 'ai-search', label: 'Respuestas con IA' }
]
const onTab = (value: string) => switchTab(value as SeoTab)

const SEVERITY: Record<string, [string, 'danger' | 'warning' | 'info']> = {
  critical: ['Grave', 'danger'],
  warning: ['Aviso', 'warning'],
  info: ['Informativo', 'info']
}
const ISSUES: Record<string, string> = {
  canonical_missing: 'Falta indicar la dirección principal',
  canonical_mismatch: 'La dirección principal apunta a otra página',
  canonical_invalid: 'Dirección principal incorrecta',
  noindex_detected: 'Página oculta a buscadores',
  unexpected_noindex: 'Página oculta a buscadores por error',
  missing_schema: 'Faltan datos de producto para Google',
  schema_missing: 'Faltan datos de producto para Google',
  orphan_page: 'Ninguna página enlaza a esta',
  broken_link: 'Enlace roto',
  status_4xx: 'La página no existe',
  status_5xx: 'La página da error al abrirse',
  redirect_chain: 'Demasiadas redirecciones seguidas',
  accidental_change: 'Cambio inesperado desde la última revisión',
  max_depth_exceeded: 'Página demasiado escondida en la tienda'
}
const issueLabel = (type: string) => ISSUES[type] ?? adminHumanize(type)
function issueDetail(details: Record<string, unknown>): string {
  const parts = Object.entries(details ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(
      ([key, value]) => `${adminHumanize(key)}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    )
  return parts.length ? parts.join(' · ') : '—'
}
const WASTE: Record<string, string> = {
  search_results: 'Resultados de búsqueda',
  internal_search: 'Resultados de búsqueda',
  faceted_navigation: 'Filtros combinados',
  filters: 'Filtros combinados',
  pagination: 'Paginación',
  parameters: 'Direcciones con parámetros',
  tracking_parameters: 'Direcciones con parámetros de seguimiento',
  not_found: 'Páginas que no existen',
  error_4xx: 'Páginas que no existen',
  error_5xx: 'Páginas que dan error',
  redirect: 'Redirecciones',
  duplicate: 'Páginas duplicadas',
  noindex: 'Páginas ocultas a buscadores',
  cart: 'Carrito y compra',
  account: 'Área de cliente'
}
const wasteLabel = (category: string) => WASTE[category] ?? adminHumanize(category)
const wasteItems = computed(() =>
  Object.entries(botSummary.value?.wasteByCategory ?? {}).map(([category, count]) => ({
    label: wasteLabel(category),
    value: count
  }))
)
function httpLabel(code: number): string {
  if (code >= 500) return `Error de la tienda (${code})`
  if (code === 404 || code === 410) return `No existe (${code})`
  if (code >= 400) return `No disponible (${code})`
  if (code >= 300) return `Redirección (${code})`
  return `Correcta (${code})`
}
const confirmSweep = ref(false)
async function confirmRetentionSweep() {
  confirmSweep.value = false
  await runRetentionSweep()
}

onMounted(() => {
  loadCrawlerData()
})
</script>

<template>
  <div class="adm-stack" role="region" aria-label="Panel de monitorización y control SEO técnico">
    <AdminPageActions>
      <button
        v-if="activeTab === 'crawler'"
        type="button"
        class="adm-btn adm-btn--primary"
        :disabled="actionLoading"
        aria-label="Analizar la tienda ahora"
        @click="triggerCrawl('manual')"
      >
        <UIcon
          :name="actionLoading ? 'i-lucide-loader-circle' : 'i-lucide-scan-search'"
          class="size-4 shrink-0"
          :class="actionLoading && 'animate-spin'"
        />
        {{ actionLoading ? 'Analizando la tienda…' : 'Analizar la tienda ahora' }}
      </button>
      <button
        v-else-if="activeTab === 'bots'"
        type="button"
        class="adm-btn adm-btn--secondary"
        :disabled="actionLoading"
        aria-label="Borrar registros antiguos"
        @click="confirmSweep = true"
      >
        {{ actionLoading ? 'Borrando…' : 'Borrar registros antiguos' }}
      </button>
    </AdminPageActions>

    <AdminTabs :model-value="activeTab" :tabs="TABS" label="Secciones SEO" @update:model-value="onTab" />

    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="No se ha podido completar la operación"
      description="Vuelve a intentarlo dentro de un momento."
    />
    <UAlert
      v-if="successMessage"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successMessage"
    />

    <!-- Revisión de páginas -->
    <section v-if="activeTab === 'crawler'" class="adm-stack" aria-label="Monitorización SEO técnica continua">
      <div v-if="loading" class="adm-card adm-table-skeleton" aria-live="polite" aria-busy="true">
        <span class="sr-only">Cargando revisiones…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
      </div>

      <AdminCard v-else-if="crawlRuns.length === 0" flush>
        <AdminEmptyState
          v-if="errorMessage"
          variant="error"
          title="No se han podido cargar las revisiones"
          description="Comprueba la conexión y vuelve a intentarlo."
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="loadCrawlerData">Reintentar</AdminButton>
        </AdminEmptyState>
        <AdminEmptyState
          v-else
          icon="i-lucide-scan-search"
          title="Todavía no se ha revisado la tienda"
          description="La revisión recorre las páginas de la tienda y avisa de enlaces rotos, páginas ocultas a Google y otros problemas."
          aria-live="polite"
        >
          <AdminButton icon="i-lucide-scan-search" :disabled="actionLoading" @click="triggerCrawl('manual')">
            Hacer la primera revisión
          </AdminButton>
        </AdminEmptyState>
      </AdminCard>

      <template v-else>
        <div v-if="crawlRuns[0]" class="adm-grid">
          <AdminStat
            label="Páginas revisadas"
            :value="crawlRuns[0].totalUrlsScanned"
            :hint="`Última revisión: ${adminDate(crawlRuns[0].completedAt ?? crawlRuns[0].startedAt, true)}`"
          />
          <AdminStat label="Páginas correctas" :value="crawlRuns[0].status2xxCount" />
          <AdminStat label="Enlaces rotos" :value="crawlRuns[0].status4xxCount" hint="Páginas que no existen" />
          <AdminStat
            label="Errores de la tienda"
            :value="crawlRuns[0].status5xxCount"
            hint="Páginas que fallan al abrir"
          />
          <AdminStat
            label="Dirección principal mal indicada"
            :value="crawlRuns[0].canonicalIssuesCount"
            hint="Páginas duplicadas sin señalar la original"
          />
          <AdminStat label="Ocultas a Google" :value="crawlRuns[0].noindexCount" />
          <AdminStat label="Sin enlaces de entrada" :value="crawlRuns[0].orphanCount" hint="Nadie enlaza a ellas" />
          <AdminStat
            label="Cambios inesperados"
            :value="crawlRuns[0].accidentalChangesCount"
            hint="Respecto a la revisión anterior"
          />
        </div>

        <AdminCard :title="`Problemas encontrados (${runIssues.length})`" flush>
          <template v-if="crawlRuns.length > 1" #actions>
            <select
              class="adm-input"
              aria-label="Revisión que se muestra"
              :value="selectedRunId ?? ''"
              @change="loadRunIssues(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="run in crawlRuns" :key="run.id" :value="run.id">
                Revisión del {{ adminDate(run.startedAt, true) }}
              </option>
            </select>
          </template>
          <AdminEmptyState
            v-if="runIssues.length === 0"
            compact
            icon="i-lucide-circle-check"
            title="Todo en orden"
            description="La última revisión no ha encontrado errores ni avisos."
          />
          <div v-else class="adm-table-wrap">
            <table class="adm-table" aria-label="Tabla de incidencias SEO">
              <thead>
                <tr>
                  <th scope="col">Gravedad</th>
                  <th scope="col">Problema</th>
                  <th scope="col">Página</th>
                  <th scope="col">Detalle</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="issue in runIssues" :key="issue.id">
                  <td>
                    <AdminBadge :tone="SEVERITY[issue.severity]?.[1] ?? 'neutral'">
                      {{ SEVERITY[issue.severity]?.[0] ?? adminHumanize(issue.severity) }}
                    </AdminBadge>
                  </td>
                  <td>{{ issueLabel(issue.issueType) }}</td>
                  <td class="break-all">{{ issue.url }}</td>
                  <td class="adm-help">{{ issueDetail(issue.details) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </AdminCard>
      </template>
    </section>

    <!-- Visitas de buscadores -->
    <section v-if="activeTab === 'bots'" class="adm-stack" aria-label="Análisis de logs de bots y desperdicio">
      <div v-if="loading" class="adm-card adm-table-skeleton" aria-live="polite" aria-busy="true">
        <span class="sr-only">Cargando visitas de buscadores…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
      </div>

      <AdminCard v-else-if="!botSummary || botSummary.totalCrawls === 0" flush>
        <AdminEmptyState
          v-if="errorMessage"
          variant="error"
          title="No se han podido cargar las visitas de buscadores"
          description="Comprueba la conexión y vuelve a intentarlo."
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="loadBotData">Reintentar</AdminButton>
        </AdminEmptyState>
        <AdminEmptyState
          v-else
          icon="i-lucide-bot"
          title="Sin visitas de buscadores en este periodo"
          description="Cuando Google u otros buscadores recorran la tienda, verás aquí qué páginas visitan."
          aria-live="polite"
        />
      </AdminCard>

      <template v-else>
        <div class="adm-grid">
          <AdminStat label="Visitas de buscadores" :value="botSummary.totalCrawls" />
          <AdminStat label="Buscadores auténticos" :value="botSummary.verifiedBotCrawls" />
          <AdminStat label="Robots que se hacen pasar por buscadores" :value="botSummary.fakeBotCrawls" />
          <AdminStat
            label="Visitas desaprovechadas"
            :value="`${botSummary.wastePercentage} %`"
            hint="En páginas que no aportan nada"
          />
          <AdminStat label="Visitas a páginas rotas" :value="`${botSummary.errorRate4xx} %`" />
        </div>

        <AdminCard
          title="Dónde se desaprovechan las visitas"
          description="Tipos de página que los buscadores recorren sin que sirva para posicionar la tienda."
        >
          <AdminBreakdown :items="wasteItems" />
        </AdminCard>

        <AdminCard title="Páginas con más visitas desaprovechadas" flush>
          <div class="adm-table-wrap">
            <table class="adm-table" aria-label="URLs con mayor desperdicio">
              <thead>
                <tr>
                  <th scope="col">Página</th>
                  <th scope="col" data-numeric>Visitas</th>
                  <th scope="col">Motivo</th>
                  <th scope="col">Respuesta</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in botSummary.topWastedUrls" :key="item.path">
                  <td class="break-all">{{ item.path }}</td>
                  <td data-numeric>{{ item.hits }}</td>
                  <td>
                    <AdminBadge tone="warning">{{ wasteLabel(item.wasteCategory) }}</AdminBadge>
                  </td>
                  <td>{{ httpLabel(item.statusCode) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </AdminCard>
      </template>
    </section>

    <!-- Respuestas con IA -->
    <section v-if="activeTab === 'ai-search'" class="adm-stack" aria-label="Búsqueda semántica IA y guardarraíles SEO">
      <UAlert
        color="neutral"
        variant="subtle"
        icon="i-lucide-shield-check"
        title="Las respuestas automáticas no se publican en Google"
        description="Las respuestas que genera la IA para cada búsqueda no aparecen en buscadores y siempre enlazan a la ficha del producto. Solo se publican las guías revisadas por una persona."
      />

      <AdminCard
        title="Probar una pregunta"
        description="Comprueba qué respondería la tienda y en qué productos del catálogo se apoya."
      >
        <form class="flex flex-wrap gap-2" @submit.prevent="testGroundedSearch">
          <input
            v-model="testQuery"
            type="text"
            class="adm-input min-w-0 flex-1"
            placeholder="Ej.: desengrasante industrial para hornos"
            aria-label="Consulta de búsqueda IA"
          />
          <button type="submit" class="adm-btn adm-btn--secondary" :disabled="actionLoading">
            {{ actionLoading ? 'Preparando respuesta…' : 'Probar pregunta' }}
          </button>
        </form>

        <div v-if="aiResult" class="mt-4 space-y-4" aria-live="polite">
          <div class="flex flex-wrap gap-2">
            <AdminBadge :tone="aiResult.groundingScore >= 0.7 ? 'success' : 'warning'">
              Apoyada en el catálogo: {{ Math.round(aiResult.groundingScore * 100) }} %
            </AdminBadge>
            <AdminBadge :tone="aiResult.isIndexable ? 'warning' : 'success'">
              {{ aiResult.isIndexable ? 'Visible en Google' : 'No aparece en Google' }}
            </AdminBadge>
          </div>
          <p class="text-[var(--text-strong)]">{{ aiResult.answerText }}</p>

          <div>
            <h3>Productos en los que se apoya ({{ aiResult.citations.length }})</h3>
            <ul class="adm-list mt-2">
              <li v-for="citation in aiResult.citations" :key="citation.productId">
                <div class="min-w-0 flex-1">
                  <p class="adm-list__title">{{ citation.title }}</p>
                  <p class="adm-help">Ref. {{ citation.sku }} · {{ citation.formattedPrice }}</p>
                  <p class="adm-help break-all">{{ citation.canonicalUrl }}</p>
                  <p v-if="citation.safetyAdvice" class="adm-help mt-1">
                    <UIcon name="i-lucide-triangle-alert" class="mr-1 inline size-3.5 align-[-2px]" />{{
                      citation.safetyAdvice
                    }}
                  </p>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </AdminCard>

      <AdminCard
        title="Guías revisadas por el equipo"
        description="Solo las respuestas revisadas y aprobadas por un editor se publican como páginas visibles en buscadores."
        flush
      >
        <AdminEmptyState
          v-if="curatedGuides.length === 0"
          compact
          icon="i-lucide-book-open"
          title="Todavía no hay guías aprobadas"
        />
        <div v-else class="adm-table-wrap">
          <table class="adm-table" aria-label="Guías editoriales curadas">
            <thead>
              <tr>
                <th scope="col">Pregunta</th>
                <th scope="col">Título</th>
                <th scope="col">Dirección</th>
                <th scope="col">Estado</th>
                <th scope="col">Visible en Google</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="guide in curatedGuides" :key="guide.id">
                <td>{{ guide.topicQuery }}</td>
                <td class="font-semibold text-[var(--text-strong)]">{{ guide.title }}</td>
                <td class="break-all">{{ guide.canonicalUrl }}</td>
                <td><AdminBadge :status="guide.status" /></td>
                <td>
                  <AdminBadge :tone="guide.isIndexable ? 'success' : 'neutral'">
                    {{ guide.isIndexable ? 'Sí' : 'No' }}
                  </AdminBadge>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </AdminCard>
    </section>

    <AdminConfirm
      v-model:open="confirmSweep"
      title="Borrar registros antiguos"
      description="Se eliminarán las visitas de buscadores que ya han superado el plazo de conservación. No se puede deshacer."
      confirm-label="Borrar registros"
      danger
      @confirm="confirmRetentionSweep"
    />
  </div>
</template>
