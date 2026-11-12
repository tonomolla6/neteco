// La vista inicial acompaña al HTML SSR, que puede servirse desde caché SWR.
// Tras hidratar se aplica la preferencia real del visitante y se mantienen ambas sincronizadas.
//
// Sin elección guardada, una cuenta de empresa empieza en la lista de pedido (referencia,
// cantidad y «Añadir» por fila), que es como repone un profesional; el resto, en la rejilla.
// Ese punto de partida no se guarda: solo se recuerda lo que el visitante elige.
type CatalogView = 'grid' | 'list'

export function useCatalogView() {
  const cookie = useCookie<CatalogView | null>('catalog_view', {
    default: () => null,
    maxAge: 60 * 60 * 24 * 365
  })
  const saved = () => (cookie.value === 'grid' || cookie.value === 'list' ? cookie.value : null)
  const view = useState<CatalogView>('catalog-view-hydration', () => saved() ?? 'grid')
  const { user } = useUserSession()

  onMounted(() => {
    view.value = saved() ?? (user.value?.company ? 'list' : 'grid')
    watch(cookie, () => {
      const value = saved()
      if (value) view.value = value
    })
    watch(view, (value) => (cookie.value = value))
  })

  return view
}
