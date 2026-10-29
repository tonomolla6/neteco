export type CatalogAction = 'productCreate' | 'productUpdate' | 'productDelete' | 'productStatusUpdate'
export interface CatalogCapabilitiesMetadata {
  capabilities?: Partial<Record<CatalogAction, boolean>>
}

/** Missing capabilities preserve the existing Node contract, but never enable
 * an unimplemented Cloudflare mutation. Server authorization remains decisive. */
export function catalogActionAvailable(
  metadata: CatalogCapabilitiesMetadata | null | undefined,
  action: CatalogAction,
  cloudflare: boolean
): boolean {
  return metadata?.capabilities ? metadata.capabilities[action] === true : !cloudflare
}
