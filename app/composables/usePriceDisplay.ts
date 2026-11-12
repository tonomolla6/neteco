/**
 * Precios sin IVA o con IVA, a elección de quien compra.
 *
 * Un hostelero compara en neto; un particular, con el impuesto dentro. Antes lo decidía el
 * despliegue (`priceDisplayMode`); ahora ese valor es solo el punto de partida.
 *
 * El HTML del servidor siempre usa el valor del despliegue: portada, catálogo y fichas se
 * sirven desde una caché compartida (SWR), así que pintar ahí la preferencia de un visitante
 * se la enseñaría al siguiente. La preferencia real —la cookie o, sin ella, el tipo de
 * cuenta— se aplica tras hidratar, como la vista del catálogo, y no produce desajuste.
 */
export type PriceDisplayMode = 'net' | 'gross'

const isMode = (value: unknown): value is PriceDisplayMode => value === 'net' || value === 'gross'

/** La elección guardada manda; sin ella, una cuenta de empresa ve neto. */
export function resolveInitialPriceMode(input: {
  saved: unknown
  company: boolean
  fallback: PriceDisplayMode
}): PriceDisplayMode {
  if (isMode(input.saved)) return input.saved
  return input.company ? 'net' : input.fallback
}

export function usePriceDisplay() {
  const runtime = useRuntimeConfig()
  const fallback: PriceDisplayMode = runtime.public.priceDisplayMode === 'net-and-gross' ? 'net' : 'gross'
  const cookie = useCookie<string | null>('price_display', {
    default: () => null,
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    path: '/'
  })
  // Lo que ha decidido el visitante (o su tipo de cuenta); `null` es «lo que diga el despliegue».
  const choice = useState<PriceDisplayMode | null>('price-display-mode', () => null)
  const mode = computed<PriceDisplayMode>(() => choice.value ?? fallback)
  const net = computed(() => mode.value === 'net')

  function setMode(value: PriceDisplayMode) {
    choice.value = value
    cookie.value = value
  }

  /** Aplica la preferencia del visitante. Solo en cliente y después de hidratar. */
  function applyVisitorPreference(company: boolean) {
    const resolved = resolveInitialPriceMode({ saved: cookie.value, company, fallback })
    choice.value = resolved === fallback && !isMode(cookie.value) ? null : resolved
  }

  return { mode, net, setMode, applyVisitorPreference }
}
