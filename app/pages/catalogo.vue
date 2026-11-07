<script setup lang="ts">
import type { CategoryResponse } from '~~/shared/types/catalog'
import PromotionalBlocks from '~/components/PromotionalBlocks.vue'
import {
  readCatalogTypedRouteValue,
  catalogTypedQuery,
  countCatalogTypedSelections,
  catalogTypedPills,
  removeCatalogTypedSelection
} from '../utils/catalog-typed-filters'

const route = useRoute()
const router = useRouter()
const runtime = useRuntimeConfig()
const canonicalOrigin = String(runtime.public.baseUrl).replace(/\/$/, '')
const currentCatalogPage = computed(() => paginationNumber(route.query) ?? 1)
const catalogTitle = computed(() =>
  currentCatalogPage.value > 1 ? `Todo el catálogo (pág. ${currentCatalogPage.value})` : 'Todo el catálogo'
)
const catalogDescription = computed(() =>
  currentCatalogPage.value > 1
    ? `Catálogo completo de NETECO (página ${currentCatalogPage.value}): químicos de limpieza profesional, higiene, guantes y menaje.`
    : 'Catálogo completo de NETECO: químicos de limpieza profesional, higiene, guantes y menaje. Filtra por familia, marca, precio y formato.'
)

useSeoMeta({
  title: () => catalogTitle.value,
  description: () => catalogDescription.value,
  ogTitle: () => `${catalogTitle.value} · NETECO`,
  ogDescription: () => catalogDescription.value,
  twitterTitle: () => `${catalogTitle.value} · NETECO`,
  twitterDescription: () => catalogDescription.value,
  robots: () => (isIndexableCatalogQuery(route.query) ? 'index, follow' : 'noindex, follow')
})

const { data: catData } = await useFetch<CategoryResponse>('/api/categories', { key: 'categories' })

// árbol para la barra lateral: raíces como grupos, familias con producto como opciones
const familyTree = computed(() =>
  (catData.value?.roots ?? [])
    .map((root) => ({
      ...root,
      children: root.children.filter((category) => category.count > 0)
    }))
    .filter((root) => root.children.length || root.count > 0)
)
const knownSlugs = computed(() => new Set((catData.value?.flat ?? []).map((category) => category.slug)))

// ——— estado (inicializado desde la URL para poder compartir enlaces) ———
function multiFromQuery(v: unknown, sep = ','): string[] {
  return v ? String(v).split(sep).filter(Boolean) : []
}
function numFromQuery(v: unknown): number | null {
  const n = parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

const selectedCategory = ref(knownSlugs.value.has(String(route.query.familia ?? '')) ? String(route.query.familia) : '')
const sort = ref(String(route.query.sort ?? 'featured'))
const filters = reactive({
  typed: readCatalogTypedRouteValue(route.query.typed),
  brands: multiFromQuery(route.query.brand),
  badges: multiFromQuery(route.query.badge),
  envases: multiFromQuery(route.query.envase),
  tallas: multiFromQuery(route.query.talla),
  capacidades: multiFromQuery(route.query.cap),
  colors: multiFromQuery(route.query.color),
  medidas: multiFromQuery(route.query.medida, '|'),
  acabados: multiFromQuery(route.query.acabado),
  priceMin: numFromQuery(route.query.min),
  priceMax: numFromQuery(route.query.max)
})

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
  selectedCategory.value = knownSlugs.value.has(String(route.query.familia ?? '')) ? String(route.query.familia) : ''
  sort.value = String(route.query.sort ?? 'featured')
  replaceValues(filters.brands, multiFromQuery(route.query.brand))
  replaceValues(filters.badges, multiFromQuery(route.query.badge))
  replaceValues(filters.envases, multiFromQuery(route.query.envase))
  replaceValues(filters.tallas, multiFromQuery(route.query.talla))
  replaceValues(filters.capacidades, multiFromQuery(route.query.cap))
  replaceValues(filters.colors, multiFromQuery(route.query.color))
  replaceValues(filters.medidas, multiFromQuery(route.query.medida, '|'))
  replaceValues(filters.acabados, multiFromQuery(route.query.acabado))
  filters.priceMin = numFromQuery(route.query.min)
  filters.priceMax = numFromQuery(route.query.max)
  selectedGroup.value = groupOfSelected.value
  nextTick(() => (applyingRoute = false))
}

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
  selectedGroup.value = ''
  sort.value = 'featured'
}

watch(
  [filters, sort, selectedCategory],
  () => {
    if (applyingRoute) return
    const query: Record<string, string> = {}
    const typed = catalogTypedQuery(filters.typed)
    if (typed) query.typed = typed
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

const { items, total, page, pages, facets, status, loadingMore, canLoadMore, loadMore, sentinel } =
  await useInfiniteProducts(
    computed(() => ({
      typed: catalogTypedQuery(filters.typed),
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
useHead(() => ({
  link: [
    ...(page.value > 1
      ? [
          {
            rel: 'prev' as const,
            href: router.resolve({ path: '/catalogo', query: paginationQuery(page.value - 1) }).href
          }
        ]
      : []),
    ...(page.value < pages.value
      ? [
          {
            rel: 'next' as const,
            href: router.resolve({ path: '/catalogo', query: paginationQuery(page.value + 1) }).href
          }
        ]
      : [])
  ],
  script: [
    {
      key: 'catalog-breadcrumb-structured-data',
      type: 'application/ld+json',
      textContent: JSON.stringify(
        buildBreadcrumbJsonLd(canonicalOrigin, [
          { name: 'Inicio', path: '/' },
          { name: 'Catálogo', path: '/catalogo' }
        ])
      ).replace(/</g, '\\u003c')
    },
    {
      key: 'catalog-itemlist-structured-data',
      type: 'application/ld+json',
      textContent: JSON.stringify(
        buildItemListJsonLd(
          canonicalOrigin,
          catalogTitle.value,
          items.value.map((item, idx) => ({ name: item.name, slug: item.slug, position: idx + 1 }))
        )
      ).replace(/</g, '\\u003c')
    }
  ]
}))

const selectedCategoryName = computed(() => {
  if (!selectedCategory.value) return ''
  const flat = catData.value?.flat ?? []
  return flat.find((category) => category.slug === selectedCategory.value)?.name ?? selectedCategory.value
})

const { track } = useAnalytics()
watch(
  [selectedCategory, total, status],
  ([category, resultCount, requestStatus]) => {
    if (requestStatus === 'success') {
      void track('catalog_viewed', { category: category || null, page: 1, resultCount })
    }
  },
  { immediate: true }
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

interface Pill {
  key?: string
  typed?: boolean
  label: string
  remove: () => void
}
// chips en dos niveles: grupos temáticos (mismos que el mega-menú) → familias del grupo
const chipGroups = computed(() =>
  familyTree.value.flatMap((root) =>
    root.children.length > 8 ? groupFamilies(root.children) : [{ title: root.name, items: root.children }]
  )
)
const groupOfSelected = computed(
  () => chipGroups.value.find((group) => group.items.some((item) => item.slug === selectedCategory.value))?.title ?? ''
)
const selectedGroup = ref(groupOfSelected.value)
const activeGroupItems = computed(
  () => chipGroups.value.find((group) => group.title === selectedGroup.value)?.items ?? []
)

const pills = computed<Pill[]>(() => [
  ...catalogTypedPills(filters.typed, facets.value?.typed).map((pill) => ({
    key: `typed:${pill.definitionId}:${JSON.stringify(pill.value)}`,
    typed: true,
    label: pill.label,
    remove: () => {
      filters.typed = removeCatalogTypedSelection(filters.typed, pill.definitionId, pill.value)
    }
  })),
  ...filters.brands.map((v) => ({ label: v, remove: () => filters.brands.splice(filters.brands.indexOf(v), 1) })),
  ...filters.badges.map((v) => ({
    label: BADGES[v]?.label ?? v,
    remove: () => filters.badges.splice(filters.badges.indexOf(v), 1)
  })),
  ...filters.envases.map((v) => ({
    label: ENVASE_LABELS[v] ?? v,
    remove: () => filters.envases.splice(filters.envases.indexOf(v), 1)
  })),
  ...filters.tallas.map((v) => ({
    label: `Talla ${v}`,
    remove: () => filters.tallas.splice(filters.tallas.indexOf(v), 1)
  })),
  ...filters.capacidades.map((v) => ({
    label: formatCapacity(v),
    remove: () => filters.capacidades.splice(filters.capacidades.indexOf(v), 1)
  })),
  ...filters.colors.map((v) => ({
    label: v.replace(/\s*\([^)]*\)$/, ''),
    remove: () => filters.colors.splice(filters.colors.indexOf(v), 1)
  })),
  ...filters.medidas.map((v) => ({
    label: v,
    remove: () => filters.medidas.splice(filters.medidas.indexOf(v), 1)
  })),
  ...filters.acabados.map((v) => ({
    label: v,
    remove: () => filters.acabados.splice(filters.acabados.indexOf(v), 1)
  })),
  ...(filters.priceMin != null || filters.priceMax != null
    ? [
        {
          label: `${filters.priceMin ?? 0} € – ${filters.priceMax ?? '∞'} €`,
          remove: () => {
            filters.priceMin = null
            filters.priceMax = null
          }
        }
      ]
    : [])
])

const drawerOpen = ref(false)
watch(
  () => route.fullPath,
  () => (drawerOpen.value = false)
)

function pickCategory(slug: string) {
  selectedCategory.value = selectedCategory.value === slug ? '' : slug
}

function pickAllCategories() {
  selectedGroup.value = ''
  selectedCategory.value = ''
}

watch(() => route.fullPath, applyRouteFilters)
</script>

<template>
  <div v-if="filters" class="mx-auto max-w-[1600px] px-4 py-8">
    <PromotionalBlocks :context="{ placement: 'catalog', path: '/catalogo' }" class="mb-6" />
    <!-- cabecera -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">
          {{ selectedCategory ? selectedCategoryName : 'Todo el catálogo' }}
        </h1>
        <p aria-live="polite" class="mt-1 text-sm text-slate-500">{{ total }} producto{{ total === 1 ? '' : 's' }}</p>
      </div>
      <div class="flex min-w-0 flex-wrap items-center gap-2">
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
        <label class="flex min-w-0 items-center gap-2 text-sm text-slate-500">
          <span class="hidden sm:inline">Ordenar por</span>
          <select
            v-model="sort"
            aria-label="Ordenar productos"
            class="min-w-0 max-w-[11rem] rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
          >
            <option value="featured">Relevancia</option>
            <option value="price_asc">Precio: menor a mayor</option>
            <option value="price_desc">Precio: mayor a menor</option>
            <option value="name">Nombre A-Z</option>
          </select>
        </label>
      </div>
    </div>

    <!-- familias en dos niveles: grupos temáticos → familias del grupo elegido -->
    <div class="mt-5 space-y-2">
      <div
        class="-mx-4 flex flex-nowrap gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0"
      >
        <button
          class="shrink-0 whitespace-nowrap rounded-full border px-3.5 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
          :class="
            !selectedCategory && !selectedGroup
              ? 'border-neteco-600 bg-neteco-600 text-white'
              : 'border-slate-200 bg-white text-slate-600 hover:border-neteco-300'
          "
          @click="pickAllCategories"
        >
          Todas
        </button>
        <button
          v-for="g in chipGroups"
          :key="g.title"
          :aria-expanded="selectedGroup === g.title"
          class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
          :class="
            selectedGroup === g.title || groupOfSelected === g.title
              ? 'border-neteco-500 bg-neteco-50 text-neteco-700'
              : 'border-slate-200 bg-white text-slate-600 hover:border-neteco-300'
          "
          @click="selectedGroup = selectedGroup === g.title ? '' : g.title"
        >
          {{ g.title }}
          <UIcon
            name="i-lucide-chevron-down"
            class="size-3.5 opacity-60 transition-transform"
            :class="selectedGroup === g.title ? 'rotate-180' : ''"
          />
        </button>
      </div>

      <div
        v-if="activeGroupItems.length"
        class="-mx-4 flex flex-nowrap gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0"
      >
        <button
          v-for="child in activeGroupItems"
          :key="child.id"
          :aria-pressed="selectedCategory === child.slug"
          class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
          :class="
            selectedCategory === child.slug
              ? 'border-neteco-600 bg-neteco-600 font-medium text-white'
              : 'border-slate-200 bg-white text-slate-600 hover:border-neteco-300'
          "
          @click="pickCategory(child.slug)"
        >
          {{ child.name }}
          <span :class="selectedCategory === child.slug ? 'text-neteco-100' : 'text-slate-600'">{{ child.count }}</span>
        </button>
      </div>
    </div>

    <!-- filtros activos -->
    <div v-if="pills.length" class="mt-4 flex flex-wrap items-center gap-2">
      <button
        v-for="pill in pills"
        :key="pill.key ?? pill.label"
        :data-typed-pill="pill.typed ? '' : undefined"
        :aria-label="`Quitar ${pill.label}`"
        class="flex items-center gap-1.5 rounded-full bg-neteco-600 px-3 py-1.5 text-sm text-white transition hover:bg-neteco-700"
        @click="pill.remove()"
      >
        {{ pill.label }}
        <UIcon name="i-lucide-x" class="size-3.5" />
      </button>
      <button class="text-sm font-medium text-slate-500 underline hover:text-neteco-600" @click="resetFilters">
        Quitar todo
      </button>
    </div>

    <div class="mt-6 grid grid-cols-1 items-start gap-8 lg:grid-cols-[260px_1fr]">
      <!-- barra lateral (escritorio): solo filtros; las familias van en chips arriba -->
      <aside
        class="sticky top-44 hidden max-h-[calc(100vh-13rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 lg:block"
      >
        <ProductFilters
          :facets="facets"
          :filters="filters"
          :hide="['gama']"
          @update:filters="Object.assign(filters, $event)"
        />
        <button
          v-if="activeCount"
          class="mt-2 w-full rounded-lg border border-slate-200 py-2 text-sm font-medium text-slate-600 transition hover:border-neteco-300 hover:text-neteco-700"
          @click="resetFilters"
        >
          Quitar los {{ activeCount }} filtros
        </button>
      </aside>

      <!-- resultados -->
      <div :aria-busy="status === 'pending'">
        <ProductGrid :items="items" :pending="status === 'pending'" />

        <div v-if="status !== 'pending' && !items.length" role="status" class="py-16 text-center">
          <UIcon name="i-lucide-package-search" class="mx-auto size-12 text-slate-300" />
          <p class="mt-3 font-medium text-slate-600">No hay productos con esos filtros</p>
          <UButton variant="soft" class="mt-4" @click="resetFilters">Quitar filtros</UButton>
        </div>

        <!-- scroll infinito -->
        <div ref="sentinel" class="h-px" aria-hidden="true" />
        <div
          v-if="loadingMore"
          role="status"
          class="flex items-center justify-center gap-2 py-8 text-sm text-slate-500"
        >
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> Cargando más productos…
        </div>
        <div v-else-if="canLoadMore" class="py-6 text-center">
          <UButton variant="soft" @click="loadMore">Cargar más</UButton>
        </div>
        <!-- Eran dos enlaces de texto sueltos, sin indicar en qué página estás ni cuántas hay.
             Se mantienen como enlaces reales para que sigan siendo rastreables e indexables. -->
        <nav
          v-if="pages > 1"
          aria-label="Paginación del catálogo"
          class="flex flex-wrap items-center justify-center gap-3 py-6"
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
        <p v-else-if="items.length > 24" class="py-6 text-center text-sm text-slate-500">
          Has visto los {{ total }} productos
        </p>
      </div>
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
            <ProductFilters
              :facets="facets"
              :filters="filters"
              :hide="['gama']"
              @update:filters="Object.assign(filters, $event)"
            />
          </div>
          <div class="border-t border-slate-100 p-4">
            <UButton block size="lg" @click="drawerOpen = false">
              Ver {{ total }} producto{{ total === 1 ? '' : 's' }}
            </UButton>
            <button
              v-if="activeCount"
              class="mt-2 w-full py-1.5 text-sm font-medium text-slate-500 underline"
              @click="resetFilters"
            >
              Quitar todo
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
