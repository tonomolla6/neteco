// Preferencia cuadrícula/lista de los listados, persistida en cookie
// (cookie y no localStorage para que el SSR ya pinte la vista correcta).
export function useCatalogView() {
  return useCookie<'grid' | 'list'>('catalog_view', {
    default: () => 'grid',
    maxAge: 60 * 60 * 24 * 365
  })
}
