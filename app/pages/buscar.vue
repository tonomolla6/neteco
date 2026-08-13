<script setup lang="ts">
const route = useRoute()
const q = computed(() => String(route.query.q ?? '').trim())

useSeoMeta({ title: () => (q.value ? `Resultados para «${q.value}»` : 'Buscar') })

const sort = ref('featured')
const selectedCategory = ref('')
const filters = reactive({
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
  selectedCategory.value = ''
}
watch(q, resetFilters)

const { items, total, facets, status, loadingMore, canLoadMore, loadMore, sentinel } = await useInfiniteProducts(
  computed(() => ({
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
    (filters.priceMin != null || filters.priceMax != null ? 1 : 0) +
    (selectedCategory.value ? 1 : 0)
)

const categoryFacet = computed(() => (facets.value?.categories ?? []).slice(0, 10))
const selectedCategoryName = computed(
  () => categoryFacet.value.find((category) => category.slug === selectedCategory.value)?.name ?? selectedCategory.value
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
      <p v-if="q" class="text-sm text-slate-500">
        {{ total }} producto{{ total === 1 ? '' : 's' }} encontrado{{ total === 1 ? '' : 's' }}
      </p>
      <div v-if="q" class="flex items-center gap-2">
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
          class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
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

    <div v-if="q" class="mt-6 grid items-start gap-8 lg:grid-cols-[250px_1fr]">
      <!-- barra lateral -->
      <aside
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
                <span class="ml-2 shrink-0 text-xs text-slate-400">{{ c.n }}</span>
              </button>
            </li>
          </ul>
        </div>
        <ProductFilters :facets="facets" :filters="filters" @update:filters="Object.assign(filters, $event)" />
      </aside>

      <!-- resultados -->
      <div>
        <ProductGrid v-if="items.length" :items="items" :pending="status === 'pending'" />

        <div v-if="items.length" ref="sentinel" class="h-px" aria-hidden="true" />
        <div v-if="loadingMore" class="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> Cargando más productos…
        </div>
        <div v-else-if="canLoadMore" class="py-6 text-center">
          <UButton variant="soft" @click="loadMore">Cargar más</UButton>
        </div>

        <div v-if="!items.length" class="py-20 text-center">
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
          class="absolute inset-y-0 right-0 flex w-80 max-w-[85vw] flex-col bg-white shadow-2xl"
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
                    <span class="ml-2 shrink-0 text-xs text-slate-400">{{ c.n }}</span>
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
