// La vista inicial acompaña al HTML SSR, que puede servirse desde caché SWR.
// Tras hidratar se aplica la cookie real del visitante y se mantienen ambas sincronizadas.
export function useCatalogView() {
  const cookie = useCookie<'grid' | 'list'>('catalog_view', {
    default: () => 'grid',
    maxAge: 60 * 60 * 24 * 365
  })
  const view = useState<'grid' | 'list'>('catalog-view-hydration', () => cookie.value)

  onMounted(() => {
    view.value = cookie.value
    watch(cookie, (value) => (view.value = value))
    watch(view, (value) => (cookie.value = value))
  })

  return view
}
