import { useCartStore } from '~/stores/cart'
import type { ProductCardData } from '~~/shared/types/catalog'

/**
 * Pedir desde el listado.
 *
 * Tarjeta, fila y sugerencia del buscador comparten esta lógica: cantidad que respeta el
 * mínimo y el incremento de la variante, «Añadir» sin navegar ni abrir un modal, el botón
 * que confirma durante dos segundos y un mensaje para lectores de pantalla. Solo se añade
 * directamente un producto de un único formato; con varios, se elige en su tabla.
 */
export function useListingOrder(product: () => ProductCardData) {
  const cart = useCartStore()
  const single = computed(() => product().single ?? null)
  const availability = computed(() => (single.value ? variantAvailability(single.value) : null))
  const quantity = ref(single.value?.minimumQuantity ?? 1)
  watch(
    () => single.value?.variantId,
    () => (quantity.value = single.value?.minimumQuantity ?? 1)
  )
  const maximum = computed(() => {
    const variant = single.value
    if (!variant) return null
    const limits = [variant.maximumQuantity, variant.backorderAllowed ? null : variant.stock].filter(
      (limit): limit is number => limit != null
    )
    return limits.length ? Math.min(999, ...limits) : 999
  })

  const state = ref<'idle' | 'adding' | 'added'>('idle')
  const announcement = ref('')
  const error = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined
  onBeforeUnmount(() => clearTimeout(timer))

  const canAdd = computed(
    () => !!single.value && !!availability.value?.orderable && state.value !== 'adding' && !cart.blockedMutations
  )

  async function add() {
    const variant = single.value
    const item = product()
    if (!variant || !canAdd.value) return
    const amount = quantity.value
    state.value = 'adding'
    error.value = ''
    announcement.value = ''
    try {
      await cart.add(
        {
          productId: item.id,
          slug: item.slug,
          name: item.name,
          brand: item.brand,
          variantId: variant.variantId,
          format: variant.format,
          sku: variant.sku,
          price: item.minPrice,
          netPrice: item.minNetPrice,
          visual: item.visual,
          image: item.image,
          minimumQuantity: variant.minimumQuantity,
          maximumQuantity: variant.maximumQuantity,
          quantityIncrement: variant.quantityIncrement
        },
        amount
      )
      state.value = 'added'
      announcement.value = `${amount} × ${item.name} en el carrito`
      clearTimeout(timer)
      timer = setTimeout(() => (state.value = 'idle'), 2000)
    } catch {
      state.value = 'idle'
      error.value = cart.error || 'No se ha podido añadir. Vuelve a intentarlo.'
      if (!error.value.startsWith('No se ha podido añadir')) error.value = `No se ha podido añadir. ${error.value}`
    }
  }

  return { single, availability, quantity, maximum, state, announcement, error, canAdd, add }
}
