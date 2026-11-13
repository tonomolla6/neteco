<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import {
  CMS_PREVIEW_BREAKPOINTS,
  diffContentDocuments,
  type CmsPreviewBreakpoint,
  type ContentBlockSnapshot,
  type ContentDiffResult,
  type ContentDocumentSnapshot
} from '~~/shared/cms-preview-comparison'

const props = withDefaults(
  defineProps<{
    /** Página que se abre seleccionada; si no se indica, se elige una del listado. */
    pageId?: string
    initialBaseVersion?: number
    initialCompareVersion?: number
  }>(),
  { pageId: undefined, initialBaseVersion: undefined, initialCompareVersion: undefined }
)

interface PageOption {
  id: string
  title: string
  slug: string
  status: string
  draftVersion: number | null
  publishedVersion: number | null
  archived: boolean
}
interface VersionOption {
  version: number
  createdAt: string | null
  summary: string
  document: ContentDocumentSnapshot | null
}
type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

const requestFetch = useRequestFetch()

const activeBreakpoint = ref<CmsPreviewBreakpoint>('desktop')
const activeMode = ref<'side_by_side' | 'overlay' | 'diff_only'>('side_by_side')

/* --- Páginas y versiones reales: nunca se compara un identificador inventado --- */
const pagesStatus = ref<LoadStatus>('loading')
const pages = ref<PageOption[]>([])
const morePages = ref(false)
const selectedPageId = ref('')
const versionsStatus = ref<LoadStatus>('idle')
const versions = ref<VersionOption[]>([])
const pageMissing = ref(false)

const baseVersion = ref<number | null>(null)
const compareVersion = ref<number | null>(null)

const loading = ref(false)
const compareFailed = ref(false)
const versionMissing = ref(false)
const diffResult = ref<ContentDiffResult | null>(null)
const baseDoc = ref<ContentDocumentSnapshot | null>(null)
const compareDoc = ref<ContentDocumentSnapshot | null>(null)

// Template regression testing
const activeTab = ref<'preview_diff' | 'template_regression'>('preview_diff')
const selectedTemplate = ref<
  'home' | 'catalog' | 'search' | 'product' | 'cart_empty' | 'login' | 'promotional_landing'
>('home')
const regressionLoading = ref(false)
const regressionFailed = ref(false)
const regressionResult = ref<{ passed: boolean; missingCriticalSelectors: string[] } | null>(null)

const currentViewportWidth = computed(() => {
  return `${CMS_PREVIEW_BREAKPOINTS[activeBreakpoint.value].width}px`
})

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)
const whole = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : null)

function failureStatus(err: unknown): number | null {
  const value = asRecord(err)
  const rawStatus = value?.statusCode ?? value?.status ?? asRecord(value?.response)?.status
  return typeof rawStatus === 'number' ? rawStatus : null
}

function toPage(raw: unknown): PageOption | null {
  const value = asRecord(raw)
  if (!value || typeof value.id !== 'string' || !value.id) return null
  return {
    id: value.id,
    title: text(value.title) || text(value.slug) || 'Página sin título',
    slug: text(value.slug),
    status: text(value.status),
    draftVersion: whole(value.draftVersion),
    publishedVersion: whole(value.publishedVersion),
    archived: Boolean(value.archivedAt)
  }
}

/** Cada versión trae su contenido en `document` o, en el servidor clásico, en la propia versión. */
function toVersion(raw: unknown, page: PageOption): VersionOption | null {
  const value = asRecord(raw)
  const version = whole(value?.version)
  if (!value || version === null || version < 1) return null
  const source = asRecord(value.document) ?? value
  const seo = asRecord(source.seo)
  const document: ContentDocumentSnapshot | null = Array.isArray(source.blocks)
    ? {
        title: text(source.title, page.title),
        slug: text(source.slug, page.slug),
        seo: { title: text(seo?.title), description: text(seo?.description), noindex: seo?.noindex === true },
        blocks: asList(source.blocks).filter(
          (block): block is ContentBlockSnapshot =>
            typeof asRecord(block)?.id === 'string' && typeof asRecord(block)?.type === 'string'
        )
      }
    : null
  return {
    version,
    createdAt: text(value.createdAt) || null,
    summary: text(source.changeSummary) || text(value.changeSummary),
    document
  }
}

const selectedPage = computed(() => pages.value.find((page) => page.id === selectedPageId.value) ?? null)
const versionsDistinct = computed(
  () => baseVersion.value !== null && compareVersion.value !== null && baseVersion.value !== compareVersion.value
)

function resetComparison() {
  diffResult.value = null
  baseDoc.value = null
  compareDoc.value = null
  compareFailed.value = false
  versionMissing.value = false
}

let pagesSequence = 0
async function loadPages() {
  const current = ++pagesSequence
  pagesStatus.value = 'loading'
  try {
    const res = asRecord(await requestFetch<unknown>('/api/admin/content/pages', { query: { perPage: 100 } }))
    if (current !== pagesSequence) return
    const list = asList(res?.pages)
      .map(toPage)
      .filter((page): page is PageOption => page !== null)
    pages.value = list
    morePages.value = asRecord(res?.pagination)?.hasMore === true
    pagesStatus.value = 'ready'
    const wanted = [selectedPageId.value, props.pageId].find((id) => id && list.some((page) => page.id === id))
    // Sin preferencia, se abre la primera página que ya tiene cambios que comparar.
    const next = wanted ?? list.find((page) => (page.draftVersion ?? 0) > 1 && !page.archived)?.id ?? list[0]?.id ?? ''
    selectedPageId.value = next
    if (next) await loadVersions()
  } catch {
    if (current === pagesSequence) pagesStatus.value = 'error'
  }
}

let versionsSequence = 0
async function loadVersions() {
  const page = selectedPage.value
  const current = ++versionsSequence
  versions.value = []
  baseVersion.value = null
  compareVersion.value = null
  pageMissing.value = false
  resetComparison()
  if (!page) {
    versionsStatus.value = 'idle'
    return
  }
  versionsStatus.value = 'loading'
  try {
    const found = new Map<number, VersionOption>()
    // El historial llega de diez en diez; se recorre entero (con un tope razonable).
    for (let historyPage = 1; historyPage <= 20; historyPage++) {
      const res = asRecord(
        await requestFetch<unknown>(`/api/admin/content/pages/${page.id}`, {
          query: { historyPage, historyPerPage: 10 }
        })
      )
      if (current !== versionsSequence) return
      const history = asRecord(res?.history)
      const rawVersions = history ? asList(history.versions) : asList(res?.versions)
      for (const raw of rawVersions) {
        const version = toVersion(raw, page)
        if (version && !found.has(version.version)) found.set(version.version, version)
      }
      if (asRecord(history?.pagination)?.hasMore !== true || !rawVersions.length) break
    }
    const list = [...found.values()].sort((a, b) => b.version - a.version)
    versions.value = list
    versionsStatus.value = 'ready'
    if (list.length < 2) return
    const has = (version: number | undefined) => version !== undefined && list.some((item) => item.version === version)
    const preferred = page.id === props.pageId
    compareVersion.value =
      preferred && has(props.initialCompareVersion) ? props.initialCompareVersion! : list[0]!.version
    const previous = list.find((item) => item.version < compareVersion.value!) ?? list[1]!
    baseVersion.value =
      preferred && has(props.initialBaseVersion) && props.initialBaseVersion !== compareVersion.value
        ? props.initialBaseVersion!
        : previous.version
    await fetchDiff()
  } catch (err: unknown) {
    if (current !== versionsSequence) return
    if (failureStatus(err) === 404) {
      pageMissing.value = true
      versionsStatus.value = 'ready'
    } else {
      versionsStatus.value = 'error'
    }
  }
}

let diffSequence = 0
async function fetchDiff() {
  const page = selectedPage.value
  const base = baseVersion.value
  const compare = compareVersion.value
  resetComparison()
  // No se compara hasta tener una página y dos versiones distintas elegidas.
  if (!page || base === null || compare === null || base === compare) return
  const current = ++diffSequence
  loading.value = true
  try {
    const res = (await requestFetch(
      `/api/admin/content/preview-comparison?pageId=${page.id}&baseVersion=${base}&compareVersion=${compare}&breakpoint=${activeBreakpoint.value}`
    )) as {
      diff: ContentDiffResult
      baseDocument: ContentDocumentSnapshot
      compareDocument: ContentDocumentSnapshot
    }
    if (current !== diffSequence) return
    diffResult.value = res.diff
    baseDoc.value = res.baseDocument
    compareDoc.value = res.compareDocument
  } catch (err: unknown) {
    if (current !== diffSequence) return
    const status = failureStatus(err)
    const localBase = versions.value.find((item) => item.version === base)?.document ?? null
    const localCompare = versions.value.find((item) => item.version === compare)?.document ?? null
    if (status !== null && status >= 400 && status < 500 && localBase && localCompare) {
      // El servicio de comparación ha rechazado la consulta, pero el contenido de las dos versiones
      // ya está cargado: se comparan aquí con la misma función que usa el servidor.
      diffResult.value = diffContentDocuments(localBase, localCompare)
      baseDoc.value = localBase
      compareDoc.value = localCompare
    } else if (status === 404) {
      versionMissing.value = true
    } else {
      compareFailed.value = true
    }
  } finally {
    if (current === diffSequence) loading.value = false
  }
}

function onPageChange() {
  void loadVersions()
}
function onVersionChange() {
  void fetchDiff()
}

async function runRegressionCheck() {
  regressionLoading.value = true
  regressionFailed.value = false
  regressionResult.value = null
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
  } catch {
    regressionFailed.value = true
  } finally {
    regressionLoading.value = false
  }
}

const setTab = (value: string) => {
  activeTab.value = value as 'preview_diff' | 'template_regression'
}
const setMode = (value: string) => {
  activeMode.value = value as 'side_by_side' | 'overlay' | 'diff_only'
}
const setBreakpoint = (value: string) => {
  activeBreakpoint.value = value as CmsPreviewBreakpoint
}
const TABS = [
  { value: 'preview_diff', label: 'Comparar versiones' },
  { value: 'template_regression', label: 'Comprobar páginas' }
]
const MODES = [
  { value: 'side_by_side', label: 'Con vista previa' },
  { value: 'diff_only', label: 'Solo cambios' }
]
const breakpointOptions = computed(() =>
  Object.entries(CMS_PREVIEW_BREAKPOINTS).map(([value, spec]) => ({ value, label: spec.label }))
)
const PAGE_STATUS: Record<string, string> = { draft: 'borrador', published: 'publicada', hidden: 'oculta' }
function pageLabel(page: PageOption): string {
  const status = page.archived ? 'archivada' : PAGE_STATUS[page.status]
  return status ? `${page.title} · ${status}` : page.title
}
function versionLabel(item: VersionOption): string {
  const parts = [`Versión ${item.version}`]
  if (item.createdAt) parts.push(adminDate(item.createdAt, true))
  const page = selectedPage.value
  if (page?.publishedVersion === item.version) parts.push('publicada')
  else if (page?.draftVersion === item.version) parts.push('borrador actual')
  return parts.join(' · ')
}
const compareSummary = computed(
  () => versions.value.find((item) => item.version === compareVersion.value)?.summary ?? ''
)
const CHANGE: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral']> = {
  added: ['Añadido', 'success'],
  modified: ['Modificado', 'warning'],
  removed: ['Eliminado', 'danger'],
  unchanged: ['Sin cambios', 'neutral']
}
const BLOCKS: Record<string, string> = {
  heading: 'Título',
  paragraph: 'Texto',
  text: 'Texto',
  image: 'Imagen',
  hero: 'Cabecera destacada',
  cta: 'Botón de acción',
  button: 'Botón',
  list: 'Lista',
  quote: 'Cita',
  product_grid: 'Productos',
  banner: 'Banner',
  video: 'Vídeo',
  faq: 'Preguntas frecuentes'
}
const blockLabel = (type: unknown) => BLOCKS[String(type)] ?? adminHumanize(String(type ?? 'bloque'))
const FIELDS: Record<string, string> = {
  type: 'tipo de bloque',
  text: 'texto',
  title: 'título',
  label: 'texto del botón',
  href: 'enlace',
  url: 'enlace',
  src: 'imagen',
  alt: 'descripción de la imagen',
  level: 'tamaño del título',
  items: 'elementos',
  caption: 'pie de foto'
}
const fieldLabel = (field: unknown) => FIELDS[String(field)] ?? adminHumanize(String(field)).toLowerCase()
const TEMPLATES: Record<string, string> = {
  home: 'Portada',
  catalog: 'Catálogo de productos',
  search: 'Búsqueda',
  product: 'Ficha de producto',
  cart_empty: 'Carrito vacío',
  login: 'Acceso de clientes',
  promotional_landing: 'Página de promoción'
}
const PAGE_PARTS: Record<string, string> = {
  header: 'cabecera',
  'nav.main': 'menú principal',
  'section.hero': 'cabecera destacada',
  'section.featured-products': 'productos destacados',
  footer: 'pie de página'
}
const missingParts = computed(() =>
  (regressionResult.value?.missingCriticalSelectors ?? []).map((selector) => PAGE_PARTS[selector] ?? selector)
)

onMounted(() => {
  void loadPages()
})
</script>

<template>
  <div class="adm-stack" aria-label="Comparación visual de preview">
    <AdminTabs :model-value="activeTab" :tabs="TABS" label="Modos de vista" @update:model-value="setTab" />

    <!-- Comparar versiones -->
    <section v-if="activeTab === 'preview_diff'" class="adm-stack">
      <div v-if="pagesStatus === 'loading'" role="status" class="adm-card adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando las páginas…</span>
        <div v-for="row in 3" :key="row"><i /><i /><i /></div>
      </div>

      <AdminCard v-else-if="pagesStatus === 'error'">
        <div role="alert">
          <AdminEmptyState
            variant="error"
            title="No se han podido cargar las páginas"
            description="Puede ser un fallo puntual de conexión. Vuelve a intentarlo en unos segundos."
          >
            <AdminButton icon="i-lucide-rotate-cw" @click="loadPages()">Reintentar</AdminButton>
          </AdminEmptyState>
        </div>
      </AdminCard>

      <AdminCard v-else-if="!pages.length">
        <AdminEmptyState
          icon="i-lucide-file-text"
          title="Todavía no hay páginas de contenido"
          description="Aquí se comparan dos versiones de una misma página. Crea una página y, cuando la modifiques, podrás ver qué ha cambiado."
        >
          <AdminButton to="/admin/contenido" icon="i-lucide-file-text">Ir a contenido</AdminButton>
        </AdminEmptyState>
      </AdminCard>

      <template v-else>
        <AdminCard>
          <div class="flex flex-wrap items-end gap-3">
            <AdminFormField
              v-slot="{ id }"
              label="Página"
              class="min-w-0 flex-1 basis-56"
              :help="morePages ? 'Se muestran las 100 páginas más recientes.' : undefined"
            >
              <select :id="id" v-model="selectedPageId" class="adm-input" @change="onPageChange">
                <option v-for="page in pages" :key="page.id" :value="page.id">{{ pageLabel(page) }}</option>
              </select>
            </AdminFormField>
            <template v-if="versions.length >= 2">
              <AdminFormField v-slot="{ id }" label="Versión anterior" class="min-w-0 flex-1 basis-56">
                <select :id="id" v-model="baseVersion" class="adm-input" @change="onVersionChange">
                  <option v-for="item in versions" :key="item.version" :value="item.version">
                    {{ versionLabel(item) }}
                  </option>
                </select>
              </AdminFormField>
              <AdminFormField v-slot="{ id }" label="Versión nueva" class="min-w-0 flex-1 basis-56">
                <select :id="id" v-model="compareVersion" class="adm-input" @change="onVersionChange">
                  <option v-for="item in versions" :key="item.version" :value="item.version">
                    {{ versionLabel(item) }}
                  </option>
                </select>
              </AdminFormField>
            </template>
          </div>
          <template v-if="diffResult" #footer>
            <div class="adm-toolbar w-full">
              <AdminFilters
                :model-value="activeBreakpoint"
                :options="breakpointOptions"
                label="Tamaño de pantalla"
                @update:model-value="setBreakpoint"
              />
              <div class="adm-toolbar__end">
                <AdminFilters
                  :model-value="activeMode"
                  :options="MODES"
                  label="Modo de visualización"
                  @update:model-value="setMode"
                />
              </div>
            </div>
          </template>
        </AdminCard>

        <div
          v-if="versionsStatus === 'loading' || loading"
          role="status"
          class="adm-card adm-table-skeleton"
          aria-busy="true"
        >
          <span class="sr-only">
            {{ loading ? 'Comparando las dos versiones…' : 'Cargando las versiones de la página…' }}
          </span>
          <div v-for="row in 4" :key="row"><i /><i /><i /></div>
        </div>

        <AdminCard v-else-if="versionsStatus === 'error'">
          <div role="alert">
            <AdminEmptyState
              variant="error"
              title="No se han podido cargar las versiones de esta página"
              description="Puede ser un fallo puntual de conexión. Vuelve a intentarlo en unos segundos."
            >
              <AdminButton icon="i-lucide-rotate-cw" @click="loadVersions()">Reintentar</AdminButton>
            </AdminEmptyState>
          </div>
        </AdminCard>

        <AdminCard v-else-if="pageMissing">
          <AdminEmptyState
            icon="i-lucide-file-x"
            title="Esta página ya no existe"
            description="Puede que se haya eliminado mientras tenías abierta esta pantalla."
          >
            <AdminButton icon="i-lucide-rotate-cw" @click="loadPages()">Actualizar la lista de páginas</AdminButton>
          </AdminEmptyState>
        </AdminCard>

        <AdminCard v-else-if="versions.length < 2">
          <AdminEmptyState
            icon="i-lucide-diff"
            :title="
              versions.length
                ? 'Esta página solo tiene una versión: todavía no hay nada que comparar'
                : 'Esta página todavía no tiene versiones guardadas'
            "
            description="Cada vez que guardas cambios en una página se crea una versión nueva. Cuando haya al menos dos, aquí verás qué ha cambiado de una a otra."
          >
            <AdminButton to="/admin/contenido" icon="i-lucide-pencil">Editar páginas</AdminButton>
          </AdminEmptyState>
        </AdminCard>

        <AdminCard v-else-if="!versionsDistinct">
          <AdminEmptyState
            compact
            icon="i-lucide-diff"
            title="Elige dos versiones distintas"
            description="Has elegido la misma versión en los dos desplegables: no hay nada que comparar."
          />
        </AdminCard>

        <AdminCard v-else-if="versionMissing">
          <AdminEmptyState
            icon="i-lucide-file-x"
            title="Alguna de estas versiones ya no está disponible"
            description="Actualiza la lista de versiones y elige otras dos."
          >
            <AdminButton icon="i-lucide-rotate-cw" @click="loadVersions()">Actualizar versiones</AdminButton>
          </AdminEmptyState>
        </AdminCard>

        <AdminCard v-else-if="compareFailed || !diffResult">
          <div role="alert">
            <AdminEmptyState
              variant="error"
              title="No se han podido comparar las dos versiones"
              description="Puede ser un fallo puntual de conexión. Vuelve a intentarlo en unos segundos."
            >
              <AdminButton icon="i-lucide-rotate-cw" @click="fetchDiff()">Reintentar</AdminButton>
            </AdminEmptyState>
          </div>
        </AdminCard>

        <template v-else>
          <div class="adm-grid">
            <AdminStat label="Bloques añadidos" :value="`+${diffResult.summary.addedBlocksCount}`" />
            <AdminStat label="Bloques modificados" :value="diffResult.summary.modifiedBlocksCount" />
            <AdminStat label="Bloques eliminados" :value="`−${diffResult.summary.removedBlocksCount}`" />
            <AdminStat label="Sin cambios" :value="diffResult.summary.unchangedBlocksCount" />
          </div>

          <AdminCard
            v-if="diffResult.metadataDiff.titleChanged || diffResult.metadataDiff.seoChanged"
            title="Cambios en el título y en los datos para buscadores"
          >
            <p v-if="diffResult.metadataDiff.titleChanged">
              <span class="mr-2 text-[var(--text-muted)] line-through">{{ diffResult.metadataDiff.oldTitle }}</span>
              <span class="font-semibold text-[var(--text-strong)]">{{ diffResult.metadataDiff.newTitle }}</span>
            </p>
            <p v-if="diffResult.metadataDiff.seoChanged" class="adm-help mt-1">
              Ha cambiado el título, la descripción o la visibilidad en buscadores.
            </p>
          </AdminCard>

          <AdminCard
            title="Cambios bloque a bloque"
            :description="compareSummary ? `Nota de la versión nueva: ${compareSummary}` : undefined"
            flush
          >
            <AdminEmptyState
              v-if="!diffResult.blockDiffs.length"
              compact
              icon="i-lucide-equal"
              title="Las dos versiones son iguales"
            />
            <ul v-else class="adm-list" role="list">
              <li v-for="b in diffResult.blockDiffs" :key="b.id">
                <div class="min-w-0 flex-1">
                  <p class="adm-list__title">
                    <AdminBadge :tone="CHANGE[b.changeType]?.[1] ?? 'neutral'">
                      {{ CHANGE[b.changeType]?.[0] ?? adminHumanize(b.changeType) }}
                    </AdminBadge>
                    <template v-if="b.newBlock">
                      {{ blockLabel(b.newBlock.type) }}
                    </template>
                    <template v-else-if="b.oldBlock">{{ blockLabel(b.oldBlock.type) }}</template>
                  </p>
                  <p v-if="b.newBlock" class="mt-1">
                    {{ b.newBlock.text || b.newBlock.label || b.newBlock.title || '' }}
                  </p>
                  <p v-else-if="b.oldBlock" class="mt-1 text-[var(--text-muted)] line-through">
                    {{ b.oldBlock.text || b.oldBlock.label || '' }}
                  </p>
                  <p v-if="b.fieldDifferences?.length" class="adm-help mt-1">
                    Ha cambiado: {{ b.fieldDifferences.map(fieldLabel).join(', ') }}
                  </p>
                </div>
              </li>
            </ul>
          </AdminCard>

          <AdminCard
            v-if="activeMode === 'side_by_side'"
            :title="`Vista previa de la versión nueva · ${CMS_PREVIEW_BREAKPOINTS[activeBreakpoint].label}`"
            :description="`Versión ${compareVersion} a ${currentViewportWidth} de ancho`"
          >
            <div
              class="flex justify-center overflow-x-auto rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-4"
            >
              <div
                class="max-w-full space-y-3 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] p-4 transition-all duration-300"
                :style="{ width: currentViewportWidth }"
              >
                <div
                  v-for="block in compareDoc?.blocks"
                  :key="block.id"
                  class="rounded-[var(--radius-control)] border border-[var(--border)] p-2"
                >
                  <p class="adm-help">{{ blockLabel(block.type) }}</p>
                  <p>{{ block.text || block.title || block.label }}</p>
                </div>
              </div>
            </div>
          </AdminCard>
        </template>
      </template>
    </section>

    <!-- Comprobar plantillas -->
    <section v-if="activeTab === 'template_regression'" class="adm-stack">
      <AdminCard
        title="Comprobar que una página se ve completa"
        description="Revisa que no falte ninguna parte importante (cabecera, menú, productos, pie) en el tamaño de pantalla elegido."
      >
        <div class="flex flex-wrap items-end gap-3">
          <AdminFormField v-slot="{ id }" label="Página">
            <select :id="id" v-model="selectedTemplate">
              <option value="home">Portada</option>
              <option value="catalog">Catálogo de productos</option>
              <option value="search">Búsqueda</option>
              <option value="product">Ficha de producto</option>
              <option value="cart_empty">Carrito vacío</option>
              <option value="login">Acceso de clientes</option>
              <option value="promotional_landing">Página de promoción</option>
            </select>
          </AdminFormField>
          <div class="adm-field">
            <span class="adm-label">Tamaño de pantalla</span>
            <AdminFilters
              :model-value="activeBreakpoint"
              :options="breakpointOptions"
              label="Tamaño de pantalla"
              @update:model-value="setBreakpoint"
            />
          </div>
          <AdminButton variant="primary" :loading="regressionLoading" @click="runRegressionCheck">
            {{ regressionLoading ? 'Comprobando…' : 'Comprobar página' }}
          </AdminButton>
        </div>
      </AdminCard>

      <UAlert
        v-if="regressionFailed"
        role="alert"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="No se ha podido comprobar la página"
        description="Puede ser un fallo puntual. Vuelve a intentarlo en unos segundos."
      />
      <UAlert
        v-else-if="regressionResult"
        :color="regressionResult.passed ? 'success' : 'error'"
        variant="subtle"
        :icon="regressionResult.passed ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
        :title="regressionResult.passed ? 'La página se ve completa' : 'Faltan partes de la página'"
        :description="
          regressionResult.passed
            ? `Todas las partes importantes de «${TEMPLATES[selectedTemplate]}» están en su sitio en ${CMS_PREVIEW_BREAKPOINTS[activeBreakpoint].label.toLowerCase()}.`
            : `En «${TEMPLATES[selectedTemplate]}» falta: ${missingParts.join(', ')}.`
        "
      />
    </section>
  </div>
</template>
