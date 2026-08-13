// Listado de productos con scroll infinito.
// La página 1 llega por SSR (SEO + primer pintado); las siguientes se cargan
// al acercarse al final mediante IntersectionObserver. Al cambiar los filtros,
// useFetch refetcha la página 1 y el acumulado se resetea.
//
// Importante: los hooks de ciclo de vida se registran ANTES de ningún await
// (tras un await dentro de un composable se pierde la instancia del componente
// y onMounted no se ejecutaría en cliente).
import type { CatalogQueryParameters, ProductListResponse, ProductSummary } from '~~/shared/types/catalog'

export async function useInfiniteProducts(baseParams: ComputedRef<CatalogQueryParameters>, pageSize = 24) {
  const extra = ref<ProductSummary[]>([]) // páginas 2+ (solo cliente)
  const page = ref(1)
  const loadingMore = ref(false)
  let generation = 0

  // sin await: arranca la petición pero deja el contexto síncrono intacto
  const asyncData = useFetch<ProductListResponse>('/api/products', {
    params: computed(() => ({ ...baseParams.value, page: 1, limit: pageSize, facets: 1 }))
  })
  const { data, status } = asyncData

  watch(data, () => {
    extra.value = []
    page.value = 1
    generation++
  })

  const items = computed(() => [...(data.value?.items ?? []), ...extra.value])
  const total = computed(() => data.value?.total ?? 0)
  const pages = computed(() => data.value?.pages ?? 1)
  const facets = computed(() => data.value?.facets ?? null)
  const canLoadMore = computed(() => page.value < pages.value)

  async function loadMore() {
    if (loadingMore.value || !canLoadMore.value) return
    loadingMore.value = true
    const gen = generation
    try {
      // sin facets: las peticiones de scroll son más ligeras
      const next = await $fetch<ProductListResponse>('/api/products', {
        params: { ...baseParams.value, page: page.value + 1, limit: pageSize }
      })
      if (gen !== generation) return // los filtros cambiaron mientras cargaba: descartar
      extra.value.push(...(next.items ?? []))
      page.value++
    } finally {
      loadingMore.value = false
    }
  }

  // sentinel: al entrar en pantalla (con 600px de antelación) carga la siguiente tanda
  const sentinel = ref<HTMLElement | null>(null)
  let observer: IntersectionObserver | null = null
  onMounted(() => {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore()
      },
      { rootMargin: '600px 0px' }
    )
    watch(
      sentinel,
      (el, _old, onCleanup) => {
        if (el && observer) {
          observer.observe(el)
          onCleanup(() => observer?.unobserve(el))
        }
      },
      { immediate: true }
    )
  })
  onBeforeUnmount(() => observer?.disconnect())

  // esperar la primera página para que el SSR salga con contenido
  await asyncData

  return { items, total, pages, facets, status, loadingMore, canLoadMore, loadMore, sentinel }
}
