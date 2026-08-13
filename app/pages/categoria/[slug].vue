<script setup lang="ts">
import type { CategoryNode, CategoryResponse } from '~~/shared/types/catalog'

const route = useRoute()
const router = useRouter()
const slug = computed(() => route.params.slug as string)

const { data: catData } = await useFetch<CategoryResponse>('/api/categories', { key: 'categories' })

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

function multiFromQuery(v: unknown, sep = ','): string[] {
  return v ? String(v).split(sep).filter(Boolean) : []
}
function numFromQuery(v: unknown): number | null {
  const n = parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

function resetFilters() {
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
  sort.value = 'featured'
}
watch(slug, resetFilters)

// URL siempre compartible: los filtros viven también en la query
watch(
  [filters, sort],
  () => {
    const query: Record<string, string> = {}
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

const { items, total, facets, status, loadingMore, canLoadMore, loadMore, sentinel } = await useInfiniteProducts(
  computed(() => ({
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
    price_max: filters.priceMax ?? undefined
  }))
)

useSeoMeta({
  title: () => category.value?.name ?? 'Categoría',
  description: () => `Compra ${category.value?.name ?? 'productos'} de uso profesional en la tienda online de NETECO.`
})

const activeCount = computed(
  () =>
    filters.brands.length +
    filters.badges.length +
    filters.envases.length +
    filters.tallas.length +
    filters.capacidades.length +
    filters.colors.length +
    filters.medidas.length +
    filters.acabados.length +
    (filters.priceMin != null || filters.priceMax != null ? 1 : 0)
)

interface Pill {
  label: string
  remove: () => void
}
const pills = computed<Pill[]>(() => [
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
</script>

<template>
  <div v-if="category" class="mx-auto max-w-[1600px] px-4 py-8">
    <!-- migas -->
    <nav class="flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
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
        <h1 class="flex items-center gap-2.5 text-2xl font-bold text-slate-900 sm:text-3xl">
          <span class="size-3 shrink-0 rounded" :style="{ background: familyColor(slug) }" aria-hidden="true" />
          {{ category.name }}
        </h1>
        <p class="mt-1 text-sm text-slate-500">{{ total }} producto{{ total === 1 ? '' : 's' }}</p>
      </div>
      <div class="flex items-center gap-2">
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
        <label class="flex items-center gap-2 text-sm text-slate-500">
          <span class="hidden sm:inline">Ordenar por</span>
          <select
            v-model="sort"
            class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
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
    <div v-if="category.children?.length" class="-mx-4 mt-4 flex flex-nowrap gap-2 overflow-x-auto px-4 pb-1 lg:hidden">
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
        :key="pill.label"
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

    <div class="mt-6 grid items-start gap-8 lg:grid-cols-[250px_1fr]">
      <!-- barra lateral (escritorio) -->
      <aside
        class="sticky top-44 hidden max-h-[calc(100vh-13rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 lg:block"
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
                <span class="ml-2 shrink-0 text-xs text-slate-400">{{ child.count }}</span>
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
      <div>
        <ProductGrid :items="items" :pending="status === 'pending'" />

        <div v-if="!items.length" class="py-16 text-center">
          <UIcon name="i-lucide-package-search" class="mx-auto size-12 text-slate-300" />
          <template v-if="activeCount">
            <p class="mt-3 font-medium text-slate-600">No hay productos con esos filtros</p>
            <UButton variant="soft" class="mt-4" @click="resetFilters">Quitar filtros</UButton>
          </template>
          <template v-else>
            <p class="mt-3 font-medium text-slate-600">Aún no hay productos en esta familia</p>
            <p class="mt-1 text-sm text-slate-500">
              Estamos cargando el catálogo poco a poco. Llámanos si necesitas algo de aquí.
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
          class="absolute inset-y-0 right-0 flex w-80 max-w-[85vw] flex-col bg-white shadow-2xl"
        >
          <div class="flex items-center justify-between border-b border-slate-100 p-4">
            <p class="font-bold text-slate-900">Filtros</p>
            <button class="rounded-lg p-2 hover:bg-slate-100" aria-label="Cerrar" @click="drawerOpen = false">
              <UIcon name="i-lucide-x" class="block size-5" />
            </button>
          </div>
          <div class="flex-1 overflow-y-auto p-5">
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
