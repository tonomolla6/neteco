<script setup lang="ts">
import {
  readCatalogTypedRouteValue,
  catalogTypedQuery,
  countCatalogTypedSelections,
  catalogTypedPills,
  removeCatalogTypedSelection,
  hasCatalogTypedFacets
} from '../utils/catalog-typed-filters'
const route = useRoute()
const router = useRouter()
const q = computed(() => String(route.query.q ?? '').trim())

useSeoMeta({ title: () => (q.value ? `Resultados para «${q.value}»` : 'Buscar'), robots: 'noindex, follow' })

const sort = ref('featured')
const selectedCategory = ref('')
const filters = reactive({
  typed: readCatalogTypedRouteValue(route.query.typed),
  brands: [] as string[],
  badges: [] as string[],
  envases: [] as string[],
  tallas: [] as string[],
  capacidades: [] as string[],
  colors: [] as string[],
  medidas: [] as string[],
  acabados: [] as string[],
  priceMin: null as number | null,
  priceMax: null as number | null
})

function multiFromQuery(value: unknown, separator = ',') {
  return value ? String(value).split(separator).filter(Boolean) : []
}

function numberFromQuery(value: unknown) {
  const parsed = Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : null
}

function replaceValues(target: string[], values: string[]) {
  target.splice(0, target.length, ...values)
}

let applyingRoute = false
function applyRouteFilters() {
  let typed
  try {
    typed = readCatalogTypedRouteValue(route.query.typed)
  } catch {
    showError(createError({ statusCode: 400, statusMessage: 'Filtros de atributos no válidos', fatal: true }))
    return
  }
  applyingRoute = true
  filters.typed = typed
  sort.value = String(route.query.sort ?? 'featured')
  selectedCategory.value = String(route.query.familia ?? '')
  replaceValues(filters.brands, multiFromQuery(route.query.brand))
  replaceValues(filters.badges, multiFromQuery(route.query.badge))
  replaceValues(filters.envases, multiFromQuery(route.query.envase))
  replaceValues(filters.tallas, multiFromQuery(route.query.talla))
  replaceValues(filters.capacidades, multiFromQuery(route.query.cap))
  replaceValues(filters.colors, multiFromQuery(route.query.color))
  replaceValues(filters.medidas, multiFromQuery(route.query.medida, '|'))
  replaceValues(filters.acabados, multiFromQuery(route.query.acabado))
  filters.priceMin = numberFromQuery(route.query.min)
  filters.priceMax = numberFromQuery(route.query.max)
  nextTick(() => (applyingRoute = false))
}
applyRouteFilters()

function resetFilters() {
  filters.typed = []
  filters.brands = []
  filters.badges = []
  filters.envases = []
  filters.tallas = []
  filters.capacidades = []
  filters.colors = []
  filters.medidas = []
  filters.acabados = []
  filters.priceMin = null
  filters.priceMax = null
  selectedCategory.value = ''
}

watch(
  [filters, sort, selectedCategory],
  () => {
    if (applyingRoute) return
    const query: Record<string, string> = {}
    const typed = catalogTypedQuery(filters.typed)
    if (typed) query.typed = typed
    if (q.value) query.q = q.value
    if (selectedCategory.value) query.familia = selectedCategory.value
    if (filters.brands.length) query.brand = filters.brands.join(',')
    if (filters.badges.length) query.badge = filters.badges.join(',')
    if (filters.envases.length) query.envase = filters.envases.join(',')
    if (filters.tallas.length) query.talla = filters.tallas.join(',')
    if (filters.capacidades.length) query.cap = filters.capacidades.join(',')
    if (filters.colors.length) query.color = filters.colors.join(',')
    if (filters.medidas.length) query.medida = filters.medidas.join('|')
    if (filters.acabados.length) query.acabado = filters.acabados.join(',')
    if (filters.priceMin != null) query.min = String(filters.priceMin)
    if (filters.priceMax != null) query.max = String(filters.priceMax)
    if (sort.value !== 'featured') query.sort = sort.value
    router.replace({ query })
  },
  { deep: true }
)

watch(() => route.fullPath, applyRouteFilters)

const { items, total, page, pages, facets, status, retrying, retry, loadingMore, canLoadMore, loadMore, sentinel } =
  await useInfiniteProducts(
    computed(() => ({
      typed: catalogTypedQuery(filters.typed),
      q: q.value || undefined,
      category: selectedCategory.value || undefined,
      sort: sort.value,
      brand: filters.brands.join(',') || undefined,
      badge: filters.badges.join(',') || undefined,
      envase: filters.envases.join(',') || undefined,
      talla: filters.tallas.join(',') || undefined,
      capacidad: filters.capacidades.join(',') || undefined,
      color: filters.colors.join(',') || undefined,
      medida: filters.medidas.join('|') || undefined,
      acabado: filters.acabados.join(',') || undefined,
      price_min: filters.priceMin ?? undefined,
      price_max: filters.priceMax ?? undefined
    }))
  )

const paginationQuery = (target: number) => ({ ...route.query, page: target > 1 ? String(target) : undefined })

/** ¿Hay algo que filtrar? Si la búsqueda no devuelve nada, tampoco hay facetas. */
const hasFacets = computed(() =>
  Boolean(
    facets.value &&
    (hasCatalogTypedFacets(facets.value.typed) ||
      (facets.value.brands?.length ?? 0) > 1 ||
      facets.value.badges?.length ||
      (facets.value.envases?.length ?? 0) > 1 ||
      (facets.value.capacidades?.length ?? 0) > 1 ||
      facets.value.tallas?.length)
  )
)

const activeCount = computed(
  () =>
    countCatalogTypedSelections(filters.typed) +
    filters.brands.length +
    filters.badges.length +
    filters.envases.length +
    filters.tallas.length +
    filters.capacidades.length +
    filters.colors.length +
    filters.medidas.length +
    filters.acabados.length +
    (filters.priceMin != null || filters.priceMax != null ? 1 : 0) +
    (selectedCategory.value ? 1 : 0)
)

const categoryFacet = computed(() => (facets.value?.categories ?? []).slice(0, 10))
const typedPills = computed(() => catalogTypedPills(filters.typed, facets.value?.typed))

/**
 * La barra lateral solo aparece si tiene algo que ofrecer. Sin resultados no hay
 * facetas, y se quedaba como una caja blanca de 250 px junto al «no hemos encontrado
 * nada». Se mantiene si hay filtros puestos: pueden ser justamente la razón de que no
 * salga nada, y hay que poder quitarlos desde ahí.
 */
const showSidebar = computed(() => Boolean(categoryFacet.value.length || hasFacets.value || activeCount.value))
const selectedCategoryName = computed(
  () => categoryFacet.value.find((category) => category.slug === selectedCategory.value)?.name ?? selectedCategory.value
)

const { track } = useAnalytics()
watch(
  [q, total, status],
  ([query, resultCount, requestStatus]) => {
    if (requestStatus === 'success' && query) {
      void track('search_completed', { query: query.toLocaleLowerCase('es-ES').slice(0, 80), resultCount })
    }
  },
  { immediate: true }
)

const drawerOpen = ref(false)
watch(
  () => route.fullPath,
  () => (drawerOpen.value = false)
)
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-4 py-8">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">
      <template v-if="q">Resultados para «{{ q }}»</template>
      <template v-else>Buscar</template>
    </h1>
    <div class="mt-1 flex flex-wrap items-center justify-between gap-3">
      <p v-if="q && status === 'success' && !retrying" aria-live="polite" class="text-sm text-slate-500">
        {{ total }} producto{{ total === 1 ? '' : 's' }} encontrado{{ total === 1 ? '' : 's' }}
      </p>
      <div v-if="q" class="flex min-w-0 flex-wrap items-center gap-2">
        <button
          class="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500 lg:hidden"
          @click="drawerOpen = true"
        >
          <UIcon name="i-lucide-sliders-horizontal" class="size-4" />
          Filtros
          <span
            v-if="activeCount"
            class="flex size-5 items-center justify-center rounded-full bg-neteco-600 text-[11px] font-bold text-white"
          >
            {{ activeCount }}
          </span>
        </button>
        <ViewToggle />
        <select
          v-model="sort"
          aria-label="Ordenar por"
          class="min-w-0 max-w-[11rem] rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
        >
          <option value="featured">Relevancia</option>
          <option value="price_asc">Precio: menor a mayor</option>
          <option value="price_desc">Precio: mayor a menor</option>
          <option value="name">Nombre A-Z</option>
        </select>
      </div>
    </div>

    <div class="mt-4 max-w-xl sm:hidden">
      <SearchBox />
    </div>

    <!-- filtros activos -->
    <div v-if="activeCount" class="mt-4 flex flex-wrap items-center gap-2">
      <button
        v-for="pill in typedPills"
        :key="`typed:${pill.definitionId}:${JSON.stringify(pill.value)}`"
        data-typed-pill
        type="button"
        :aria-label="`Quitar ${pill.label}`"
        class="flex items-center gap-1.5 rounded-full bg-neteco-600 px-3 py-1.5 text-sm text-white transition hover:bg-neteco-700"
        @click="filters.typed = removeCatalogTypedSelection(filters.typed, pill.definitionId, pill.value)"
      >
        {{ pill.label }} <UIcon name="i-lucide-x" class="size-3.5" />
      </button>
      <button
        v-if="selectedCategory"
        class="flex items-center gap-1.5 rounded-full bg-neteco-600 px-3 py-1.5 text-sm text-white transition hover:bg-neteco-700"
        @click="selectedCategory = ''"
      >
        {{ selectedCategoryName }} <UIcon name="i-lucide-x" class="size-3.5" />
      </button>
      <button class="text-sm font-medium text-slate-500 underline hover:text-neteco-600" @click="resetFilters">
        Quitar todo
      </button>
    </div>

    <!-- Sin consulta, la página quedaba en blanco salvo el titular. Quien llega aquí sin
         escribir nada necesita una salida, y en un mayorista lo más útil son los términos
         con los que la gente pide de verdad por teléfono. -->
    <div v-if="!q" class="mt-8 max-w-2xl">
      <p class="text-[var(--text-muted)]">
        Escribe el nombre del producto o la referencia del albarán. Si no lo encuentras,
        <ContactAction link-class="font-medium text-neteco-700 hover:underline" /> y te lo buscamos.
      </p>
      <p class="mt-6 text-sm font-semibold text-[var(--text-strong)]">Búsquedas frecuentes</p>
      <div class="mt-3 flex flex-wrap gap-2">
        <NuxtLink
          v-for="term in [
            'guantes',
            'lejía',
            'desengrasante',
            'papel higiénico',
            'bolsas de basura',
            'lavavajillas',
            'fregasuelos',
            'servilletas'
          ]"
          :key="term"
          :to="{ path: '/buscar', query: { q: term } }"
          class="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-sm text-[var(--text)] transition hover:border-neteco-300 hover:text-neteco-700"
        >
          {{ term }}
        </NuxtLink>
      </div>
      <UButton class="mt-6" color="neutral" variant="outline" to="/catalogo" icon="i-lucide-layout-grid">
        Ver todo el catálogo
      </UButton>
    </div>

    <div
      v-if="q"
      class="mt-6 grid grid-cols-1 items-start gap-8"
      :class="showSidebar ? 'lg:grid-cols-[250px_1fr]' : ''"
    >
      <!-- barra lateral -->
      <aside
        v-if="showSidebar"
        class="sticky top-44 hidden max-h-[calc(100vh-13rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 lg:block"
      >
        <div v-if="categoryFacet.length" class="border-b border-slate-100 pb-4">
          <p class="text-sm font-semibold text-slate-800">Categoría</p>
          <ul class="mt-3 space-y-1">
            <li v-for="c in categoryFacet" :key="c.slug">
              <button
                class="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm transition"
                :class="
                  selectedCategory === c.slug
                    ? 'bg-neteco-50 font-medium text-neteco-700'
                    : 'text-slate-600 hover:bg-neteco-50 hover:text-neteco-700'
                "
                @click="selectedCategory = selectedCategory === c.slug ? '' : c.slug"
              >
                <span class="truncate">{{ c.name }}</span>
                <span class="ml-2 shrink-0 text-xs text-slate-600">{{ c.n }}</span>
              </button>
            </li>
          </ul>
        </div>
        <ProductFilters :facets="facets" :filters="filters" @update:filters="Object.assign(filters, $event)" />
      </aside>

      <!-- resultados -->
      <div :aria-busy="status === 'pending' || retrying">
        <p v-if="status === 'pending' || retrying" role="status" class="py-8 text-center text-sm text-slate-600">
          Buscando productos…
        </p>
        <div v-else-if="status === 'error'" role="alert" class="py-16 text-center">
          <p class="font-medium text-slate-700">No se han podido cargar los resultados.</p>
          <p class="mt-1 text-sm text-slate-500">La consulta y los filtros se conservan. Puedes volver a intentarlo.</p>
          <UButton class="mt-5" variant="soft" @click="retry">Reintentar búsqueda</UButton>
        </div>
        <ProductGrid v-if="status === 'success' && !retrying && items.length" :items="items" :pending="false" />

        <div v-if="status === 'success' && !retrying && items.length" ref="sentinel" class="h-px" aria-hidden="true" />
        <div
          v-if="status === 'success' && !retrying && loadingMore"
          role="status"
          class="flex items-center justify-center gap-2 py-8 text-sm text-slate-500"
        >
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> Cargando más productos…
        </div>
        <div v-else-if="status === 'success' && !retrying && canLoadMore" class="py-6 text-center">
          <UButton variant="soft" @click="loadMore">Cargar más</UButton>
        </div>

        <nav
          v-if="status === 'success' && !retrying && pages > 1"
          aria-label="Páginas de resultados de búsqueda"
          class="flex items-center justify-between gap-3 py-6"
        >
          <UButton
            v-if="page > 1"
            :to="{ query: paginationQuery(page - 1) }"
            color="neutral"
            variant="outline"
            icon="i-lucide-chevron-left"
          >
            Anterior
          </UButton>
          <span v-else />
          <span class="tabular text-sm text-[var(--text-muted)]">Página {{ page }} de {{ pages }}</span>
          <UButton
            v-if="page < pages"
            :to="{ query: paginationQuery(page + 1) }"
            color="neutral"
            variant="outline"
            trailing-icon="i-lucide-chevron-right"
          >
            Siguiente
          </UButton>
          <span v-else />
        </nav>

        <div v-if="status === 'success' && !retrying && !items.length" role="status" class="py-20 text-center">
          <UIcon name="i-lucide-search-x" class="mx-auto size-12 text-slate-300" />
          <p class="mt-3 font-medium text-slate-600">No hemos encontrado nada con «{{ q }}»</p>
          <p class="mt-1 text-sm text-slate-500">
            Prueba con otro término (p. ej. «desengrasante», «lavavajillas», «papel») o explora el catálogo.
          </p>
          <div class="mt-5 flex justify-center gap-3">
            <UButton v-if="activeCount" variant="soft" @click="resetFilters">Quitar filtros</UButton>
            <UButton to="/catalogo" variant="soft" icon="i-lucide-layout-grid">Ver el catálogo</UButton>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="py-20 text-center">
      <UIcon name="i-lucide-search" class="mx-auto size-12 text-slate-300" />
      <p class="mt-3 font-medium text-slate-600">Escribe en el buscador qué necesitas</p>
      <p class="mt-1 text-sm text-slate-500">Por ejemplo «desengrasante», «lavavajillas» o «papel».</p>
      <UButton to="/catalogo" variant="soft" class="mt-5" icon="i-lucide-layout-grid">Ver el catálogo</UButton>
    </div>

    <!-- drawer de filtros (móvil) -->
    <Teleport to="body">
      <div v-if="drawerOpen" class="fixed inset-0 z-50 lg:hidden" @keydown.escape="drawerOpen = false">
        <div class="absolute inset-0 bg-slate-900/50" @click="drawerOpen = false" />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Filtros"
          class="absolute inset-y-0 right-0 flex w-80 max-w-[85vw] flex-col bg-white shadow-[var(--shadow-overlay)]"
        >
          <div class="flex items-center justify-between border-b border-slate-100 p-4">
            <p class="font-bold text-slate-900">Filtros</p>
            <button class="rounded-lg p-2 hover:bg-slate-100" aria-label="Cerrar" @click="drawerOpen = false">
              <UIcon name="i-lucide-x" class="block size-5" />
            </button>
          </div>
          <div class="flex-1 overflow-y-auto p-5">
            <div v-if="categoryFacet.length" class="border-b border-slate-100 pb-4">
              <p class="text-sm font-semibold text-slate-800">Categoría</p>
              <ul class="mt-3 space-y-1">
                <li v-for="c in categoryFacet" :key="c.slug">
                  <button
                    class="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm transition"
                    :class="
                      selectedCategory === c.slug
                        ? 'bg-neteco-50 font-medium text-neteco-700'
                        : 'text-slate-600 hover:bg-neteco-50'
                    "
                    @click="selectedCategory = selectedCategory === c.slug ? '' : c.slug"
                  >
                    <span class="truncate">{{ c.name }}</span>
                    <span class="ml-2 shrink-0 text-xs text-slate-600">{{ c.n }}</span>
                  </button>
                </li>
              </ul>
            </div>
            <ProductFilters :facets="facets" :filters="filters" @update:filters="Object.assign(filters, $event)" />
          </div>
          <div class="border-t border-slate-100 p-4">
            <UButton block size="lg" @click="drawerOpen = false">
              Ver {{ total }} producto{{ total === 1 ? '' : 's' }}
            </UButton>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
