import type { MaybeRefOrGetter } from 'vue'
import type {
  ProductRecommendationsResponse,
  RecommendationStrip,
  RecommendationStripKind
} from '~~/shared/product-recommendations'

/**
 * Franjas de recomendación para la ficha o el carrito, en una sola petición.
 *
 * Se piden en el navegador tras montar: llevan los productos vistos (guardados en el
 * navegador) y el precio del cliente, y no deben retrasar el HTML de la ficha. Solo existen
 * en el entorno Cloudflare; en el otro, la ficha usa sus relacionados de siempre.
 */
export function useProductRecommendations(options: {
  product?: MaybeRefOrGetter<string | null | undefined>
  cart?: MaybeRefOrGetter<string[]>
  strips: RecommendationStripKind[]
  limit?: number
}) {
  const runtime = useRuntimeConfig()
  const recent = useRecentlyViewed()
  const available = runtime.public.serverRuntime === 'cloudflare'
  const strips = shallowRef<RecommendationStrip[]>([])
  const state = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  let generation = 0

  const key = computed(() =>
    JSON.stringify([toValue(options.product) ?? '', [...new Set(toValue(options.cart) ?? [])].sort()])
  )

  async function load() {
    if (!available || !import.meta.client) return
    const token = ++generation
    const product = toValue(options.product) ?? ''
    const cart = [...new Set(toValue(options.cart) ?? [])].slice(0, 30)
    state.value = 'loading'
    try {
      const response = await $fetch<ProductRecommendationsResponse>('/api/product-recommendations', {
        query: {
          ...(product ? { product } : {}),
          ...(cart.length ? { cart: cart.join(',') } : {}),
          ...(recent.slugs.value.length
            ? { recent: recent.slugs.value.filter((slug) => slug !== product).join(',') || undefined }
            : {}),
          strips: options.strips.join(','),
          limit: options.limit ?? 8
        },
        retry: 0
      })
      if (token !== generation) return
      strips.value = Array.isArray(response?.strips) ? response.strips : []
      state.value = 'ready'
    } catch {
      if (token !== generation) return
      // Las recomendaciones nunca bloquean la compra: si fallan, simplemente no se pintan.
      strips.value = []
      state.value = 'error'
    }
  }

  onMounted(() => {
    recent.restore()
    watch(key, () => void load(), { immediate: true })
  })

  const strip = (kind: RecommendationStripKind) => computed(() => strips.value.find((entry) => entry.kind === kind))
  return { available, strips, state, strip, reload: load }
}
