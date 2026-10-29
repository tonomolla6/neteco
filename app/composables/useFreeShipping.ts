/**
 * El umbral de envío gratis, en un solo sitio.
 *
 * Estaba escrito a mano como «150 €» en cuatro pantallas —portada, envíos, formas de
 * pago y el selector de método del checkout—, mientras el servidor lo lee de
 * `FREE_SHIPPING_THRESHOLD_CENTS`. Basta con cambiar esa variable para que la tienda
 * prometa un umbral que ya no aplica, y una promesa de envío incumplida en el momento
 * de pagar es de las cosas que peor sientan.
 *
 * `shippingCommercialPolicy()` en el servidor sigue siendo la autoridad: aquí solo se
 * lee el mismo valor para poder contarlo. Sin umbral —producción sin configurar— vale
 * 0 y todas las frases desaparecen en vez de mentir.
 *
 * Es una referencia para paquetería estándar elegible, no una cotización: palés,
 * mercancía peligrosa y otros perfiles conservan sus condiciones. El servidor
 * confirma siempre método, elegibilidad y coste antes de pagar.
 */
export function useFreeShipping() {
  const runtime = useRuntimeConfig()
  const thresholdCents = computed(() => {
    const raw: unknown = runtime.public.freeShippingThresholdCents
    if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+$/.test(raw))) return 0
    const amount = Number(raw)
    return Number.isSafeInteger(amount) && amount > 0 ? amount : 0
  })
  /**
   * En una promesa comercial «150 €» se lee mejor que «150,00 €». Los céntimos solo
   * aparecen si el umbral los tiene de verdad.
   */
  const threshold = computed(() => {
    if (!thresholdCents.value) return ''
    const redondo = thresholdCents.value % 100 === 0
    return new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: redondo ? 0 : 2
    }).format(thresholdCents.value / 100)
  })

  /** Referencia condicionada, nunca confirmación de gratuidad del pedido. */
  const label = computed(() =>
    thresholdCents.value ? `Paquetería estándar elegible gratis desde ${threshold.value}; sujeto a cotización` : ''
  )

  function missingFor(subtotalCents: number) {
    return thresholdCents.value ? Math.max(0, thresholdCents.value - subtotalCents) : 0
  }

  function progressFor(subtotalCents: number) {
    return thresholdCents.value ? Math.min(100, Math.round((subtotalCents / thresholdCents.value) * 100)) : 0
  }

  return { thresholdCents, threshold, label, missingFor, progressFor }
}
