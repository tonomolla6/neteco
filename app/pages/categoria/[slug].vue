<script setup lang="ts">
import { dynamicOgMeta } from '~/utils/og-image'
import { ogVersion } from '~~/shared/og-image'
import { catalogPageFailureStatus } from '~~/shared/catalog-page-status'
import { useDialogFocus } from '~/composables/useDialogFocus'
import type { CategoryNode, CategoryResponse } from '~~/shared/types/catalog'
import PromotionalBlocks from '~/components/PromotionalBlocks.vue'
import {
  readCatalogTypedRouteValue,
  catalogTypedQuery,
  countCatalogTypedSelections,
  catalogTypedPills,
  removeCatalogTypedSelection
} from '../../utils/catalog-typed-filters'

const route = useRoute()
const router = useRouter()
const runtime = useRuntimeConfig()
const governedMedia = runtime.public.mediaGoverned
const slug = computed(() => route.params.slug as string)

const { data: catData, error: categoryError } = await useFetch<CategoryResponse>('/api/categories', {
  key: 'categories'
})
const categoryFailure = catalogPageFailureStatus(categoryError.value, catData.value)
if (categoryFailure) {
  if (categoryFailure === 503) useResponseHeader('Retry-After').value = '30'
  throw createError({
    statusCode: categoryFailure,
    statusMessage: categoryFailure === 404 ? 'Categoría no encontrada' : 'Catálogo temporalmente no disponible',
    fatal: true
  })
}

function findNode(nodes: CategoryNode[], target: string): CategoryNode | null {
  for (const node of nodes) {
    if (node.slug === target) return node
    const found = findNode(node.children, target)
    if (found) return found
  }
  return null
}

const category = computed(() => findNode(catData.value?.roots ?? [], slug.value))
if (!category.value) {
  throw createError({ statusCode: 404, statusMessage: 'Categoría no encontrada', fatal: true })
}

const breadcrumb = computed(() => {
  const flat = catData.value?.flat ?? []
  const byId = new Map(flat.map((item) => [item.id, item]))
  const chain: typeof flat = []
  let node = category.value ? byId.get(category.value.id) : undefined
  while (node) {
    chain.unshift(node)
    node = node.parentId != null ? byId.get(node.parentId) : undefined
  }
  return chain
})

// ——— estado de filtros (inicializado desde la URL para poder compartir enlaces) ———
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
  priceMax: numFromQuery(route.query.max),
  inStock: route.query.stock === '1'
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
  filters.inStock = route.query.stock === '1'
  nextTick(() => (applyingRoute = false))
}

function multiFromQuery(v: unknown, sep = ','): string[] {
  return v ? String(v).split(sep).filter(Boolean) : []
}
function numFromQuery(v: unknown): number | null {
  const n = parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
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
  filters.inStock = false
  sort.value = 'featured'
}
watch(slug, resetFilters)

// URL siempre compartible: los filtros viven también en la query
watch(
  [filters, sort],
  () => {
    if (applyingRoute) return
    const query: Record<string, string> = {}
    const typed = catalogTypedQuery(filters.typed)
    if (typed) query.typed = typed
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
    if (filters.inStock) query.stock = '1'
    if (sort.value !== 'featured') query.sort = sort.value
    router.replace({ query })
  },
  { deep: true }
)
watch(() => route.fullPath, applyRouteFilters)

const { items, total, page, pages, facets, status, loadingMore, canLoadMore, loadMore, sentinel } =
  await useInfiniteProducts(
    computed(() => ({
      typed: catalogTypedQuery(filters.typed),
      category: slug.value,
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
      price_max: filters.priceMax ?? undefined,
      stock: filters.inStock ? '1' : undefined
    }))
  )

const canonicalOrigin = String(runtime.public.baseUrl).replace(/\/$/, '')
const categoryTitle = computed(() => {
  const baseName = category.value?.name ?? 'Categoría'
  return formatSeoTitle(page.value > 1 ? `${baseName} (pág. ${page.value})` : baseName)
})
const categoryDescription = computed(() => {
  const baseName = category.value?.name ?? 'productos'
  const pageSuffix = page.value > 1 ? ` (página ${page.value})` : ''
  return truncateSeoDescription(`Compra ${baseName}${pageSuffix} de uso profesional en la tienda online de NETECO.`)
})

const paginationQuery = (target: number) => ({ ...route.query, page: target > 1 ? String(target) : undefined })
useHead(() => ({
  link: [
    ...(page.value > 1
      ? [
          {
            rel: 'prev' as const,
            href: router.resolve({ path: `/categoria/${slug.value}`, query: paginationQuery(page.value - 1) }).href
          }
        ]
      : []),
    ...(page.value < pages.value
      ? [
          {
            rel: 'next' as const,
            href: router.resolve({ path: `/categoria/${slug.value}`, query: paginationQuery(page.value + 1) }).href
          }
        ]
      : [])
  ],
  script: [
    {
      key: 'category-breadcrumb-structured-data',
      type: 'application/ld+json',
      textContent: JSON.stringify(
        buildBreadcrumbJsonLd(canonicalOrigin, [
          { name: 'Inicio', path: '/' },
          ...breadcrumb.value.map((c) => ({ name: c.name, path: `/categoria/${c.slug}` }))
        ])
      ).replace(/</g, '\\u003c')
    },
    {
      key: 'category-itemlist-structured-data',
      type: 'application/ld+json',
      textContent: JSON.stringify(
        buildItemListJsonLd(
          canonicalOrigin,
          categoryTitle.value,
          items.value.map((item, idx) => ({ name: item.name, slug: item.slug, position: idx + 1 }))
        )
      ).replace(/</g, '\\u003c')
    }
  ]
}))

const { track } = useAnalytics()
watch(
  [slug, total, status],
  ([categorySlug, resultCount, requestStatus]) => {
    if (requestStatus === 'success') {
      void track('catalog_viewed', { category: categorySlug, page: 1, resultCount })
    }
  },
  { immediate: true }
)

// Tarjeta Open Graph dinámica de la categoría (nombre, nº de productos y miniaturas); sin ella, la tarjeta estática.
const categoryOgMeta = computed(() =>
  dynamicOgMeta({
    origin: canonicalOrigin,
    kind: 'categoria',
    slug: slug.value,
    version: ogVersion(category.value?.name, category.value?.count),
    alt: `${category.value?.name ?? 'Categoría'} · NETECO`,
    dynamic: runtime.public.serverRuntime === 'cloudflare'
  })
)

useSeoMeta({
  title: () => categoryTitle.value,
  description: () => categoryDescription.value,
  ogTitle: () => `${categoryTitle.value} · NETECO`,
  ogDescription: () => categoryDescription.value,
  ogImage: () => categoryOgMeta.value.ogImage,
  ogImageWidth: () => categoryOgMeta.value.ogImageWidth,
  ogImageHeight: () => categoryOgMeta.value.ogImageHeight,
  ogImageType: () => categoryOgMeta.value.ogImageType,
  ogImageAlt: () => categoryOgMeta.value.ogImageAlt,
  twitterTitle: () => `${categoryTitle.value} · NETECO`,
  twitterDescription: () => categoryDescription.value,
  twitterImage: () => categoryOgMeta.value.twitterImage,
  twitterImageAlt: () => categoryOgMeta.value.twitterImageAlt,
  robots: () => (isIndexableCatalogQuery(route.query) ? 'index, follow' : 'noindex, follow')
})
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
    (filters.inStock ? 1 : 0) +
    (filters.priceMin != null || filters.priceMax != null ? 1 : 0)
)

interface Pill {
  key?: string
  typed?: boolean
  label: string
  remove: () => void
}
const pills = computed<Pill[]>(() => [
  ...(filters.inStock ? [{ label: 'Solo en stock', remove: () => (filters.inStock = false) }] : []),
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
const filterDialog = ref<HTMLElement | null>(null)
useDialogFocus(filterDialog, drawerOpen)
watch(
  () => route.fullPath,
  () => (drawerOpen.value = false)
)
</script>

<template>
  <div v-if="category" class="mx-auto max-w-[1600px] px-4 py-8 sm:px-6">
    <PromotionalBlocks
      :context="{ placement: 'category', path: `/categoria/${category.slug}`, categorySlug: category.slug }"
      class="mb-6"
    />
    <!-- migas -->
    <nav aria-label="Migas de pan" class="hidden flex-wrap items-center gap-1.5 text-sm text-slate-500 md:flex">
      <NuxtLink to="/" class="hover:text-neteco-600">Inicio</NuxtLink>
      <template v-for="(c, i) in breadcrumb" :key="c.id">
        <UIcon name="i-lucide-chevron-right" class="size-3.5" />
        <NuxtLink
          :to="`/categoria/${c.slug}`"
          :class="i === breadcrumb.length - 1 ? 'font-medium text-slate-700' : 'hover:text-neteco-600'"
        >
          {{ c.name }}
        </NuxtLink>
      </template>
    </nav>

    <!-- cabecera -->
    <div class="mt-3 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="flex items-center gap-3 text-2xl font-bold text-slate-900 sm:text-3xl">
          <span
            class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)]"
            aria-hidden="true"
          >
            <img
              v-if="!governedMedia"
              :src="familyImage(slug)"
              alt=""
              width="48"
              height="48"
              class="h-full w-full object-contain p-1"
            />
            <UIcon v-else name="i-lucide-package" class="size-7 text-neteco-600" />
          </span>
          {{ category.name }}
        </h1>
        <p aria-live="polite" class="mt-1 text-sm text-slate-500">{{ total }} producto{{ total === 1 ? '' : 's' }}</p>
        <NuxtLink
          v-if="runtime.public.serverRuntime === 'cloudflare'"
          :to="{ path: '/contacto', query: { categoria: category.slug } }"
          class="mt-2 inline-block text-sm font-medium text-neteco-700 underline underline-offset-2"
          >Consultar sobre esta categoría</NuxtLink
        >
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

    <!-- subcategorías (carril móvil; en escritorio van en la barra lateral) -->
    <div
      v-if="category.children?.length"
      class="-mx-4 mt-4 scrollbar-none flex flex-nowrap gap-2 overflow-x-auto px-4 pb-1 lg:hidden"
    >
      <NuxtLink
        v-for="child in category.children.filter((item) => item.count > 0)"
        :key="child.id"
        :to="`/categoria/${child.slug}`"
        class="shrink-0 whitespace-nowrap rounded-full border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-600 transition hover:border-neteco-300 hover:text-neteco-700"
      >
        {{ child.name }} <span class="text-slate-500">· {{ child.count }}</span>
      </NuxtLink>
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

    <div class="mt-6 grid grid-cols-1 items-start gap-8 lg:grid-cols-[250px_1fr]">
      <!-- barra lateral (escritorio) -->
      <aside
        class="scrollbar-none sticky top-44 hidden max-h-[calc(100vh-13rem)] overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white p-5 lg:block"
      >
        <div v-if="category.children?.length" class="border-b border-slate-100 pb-4">
          <p class="text-sm font-semibold text-slate-800">Subcategorías</p>
          <ul class="mt-3 space-y-1">
            <li v-for="child in category.children.filter((item) => item.count > 0)" :key="child.id">
              <NuxtLink
                :to="`/categoria/${child.slug}`"
                class="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm text-slate-600 transition hover:bg-neteco-50 hover:text-neteco-700"
              >
                <span class="truncate">{{ child.name }}</span>
                <span class="ml-2 shrink-0 text-xs text-slate-500">{{ child.count }}</span>
              </NuxtLink>
            </li>
          </ul>
        </div>
        <ProductFilters :facets="facets" :filters="filters" @update:filters="Object.assign(filters, $event)" />
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
          <template v-if="activeCount">
            <p class="mt-3 font-medium text-slate-600">No hay productos con esos filtros</p>
            <UButton variant="soft" class="mt-4" @click="resetFilters">Quitar filtros</UButton>
          </template>
          <template v-else>
            <p class="mt-3 font-medium text-slate-600">Aún no hay productos en esta familia</p>
            <p class="mt-1 text-sm text-slate-500">
              Aún no vendemos esta familia en la web. Si necesitas algo de aquí, <ContactAction />.
            </p>
            <UButton to="/catalogo" variant="soft" class="mt-4" icon="i-lucide-layout-grid">Ver el catálogo</UButton>
          </template>
        </div>

        <!-- scroll infinito -->
        <div ref="sentinel" class="h-px" aria-hidden="true" />
        <div v-if="loadingMore" class="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> Cargando más productos…
        </div>
        <div v-else-if="canLoadMore" class="py-6 text-center">
          <UButton variant="soft" @click="loadMore">Cargar más</UButton>
        </div>
        <!-- Eran dos enlaces de texto sueltos, sin decir en qué página estás ni cuántas hay.
             Siguen siendo enlaces reales para que el catálogo se pueda rastrear e indexar. -->
        <nav
          v-if="pages > 1"
          aria-label="Paginación de la categoría"
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
          ref="filterDialog"
          role="dialog"
          tabindex="-1"
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
          <div class="scrollbar-none flex-1 overflow-y-auto overscroll-contain p-5">
            <ProductFilters :facets="facets" :filters="filters" @update:filters="Object.assign(filters, $event)" />
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
