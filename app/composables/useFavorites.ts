export interface AccountFavoriteItem {
  variantId: string
  cartVariantId: number | null
  sku: string
  quantity: string
  name: string
  slug: string
  format: string
  unitLabel: string
  minimumQuantity: number
  maximumQuantity: number | null
  quantityIncrement: number
  available: boolean
  reason: 'unpublished' | 'quantity_changed' | 'out_of_stock' | 'cart_unmapped' | null
}

export interface AccountFavoriteList {
  id: string
  name: string
  isDefault: boolean
  items: AccountFavoriteItem[]
}

export interface FavoriteCartPreparation {
  outcome: 'ready'
  ready: Array<{ variantId: string; cartVariantId: number; quantity: number; unitLabel: string }>
  unavailable: AccountFavoriteItem[]
}

export function favoriteUnavailableLabel(item: AccountFavoriteItem): string {
  switch (item.reason) {
    case 'unpublished':
      return 'Referencia retirada del catálogo'
    case 'quantity_changed':
      return 'Revisa la cantidad mínima o el múltiplo de compra'
    case 'out_of_stock':
      return 'Sin stock suficiente para esta cantidad'
    case 'cart_unmapped':
      return 'Referencia pendiente de habilitar para compra'
    default:
      return 'No disponible ahora mismo'
  }
}
