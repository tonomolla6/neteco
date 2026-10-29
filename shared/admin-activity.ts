import { z } from 'zod'
import { catalogCategoryActionSchema } from './catalog-category-commands'
import { catalogPolicyActionSchema, catalogPolicyInstantSchema } from './catalog-publication-policy'
import { cmsActionSchema } from './cms-commands'
import { cmsPublicationActionSchema } from './cms-publication'
import { inventoryCommandActionSchema } from './inventory-commands'
import { fulfillmentActionSchema } from './order-fulfillment'

export const ADMIN_ACTIVITY_ACTIONS = {
  catalog_category: catalogCategoryActionSchema.options,
  catalog_product_status: ['draft', 'review', 'published', 'hidden', 'discontinued'],
  catalog_policy: catalogPolicyActionSchema.options,
  cms_draft: cmsActionSchema.options,
  cms_publication: cmsPublicationActionSchema.options,
  inventory: inventoryCommandActionSchema.options,
  fulfillment: fulfillmentActionSchema.options,
  support: ['created', 'update', 'reply', 'note', 'call', 'attachment']
} as const
export const ADMIN_ACTIVITY_DESTINATIONS = {
  catalog_category: '/admin/categorias',
  catalog_product_status: '/admin/productos',
  catalog_policy: '/admin/politicas-catalogo',
  cms_draft: '/admin/contenido',
  cms_publication: '/admin/contenido',
  inventory: '/admin/inventario',
  fulfillment: '/admin/pedidos',
  support: '/admin/soporte'
} as const
export const adminActivityKindSchema = z.enum([
  'catalog_category',
  'catalog_product_status',
  'catalog_policy',
  'cms_draft',
  'cms_publication',
  'inventory',
  'fulfillment',
  'support'
])
export type AdminActivityKind = z.infer<typeof adminActivityKindSchema>
const item = <K extends AdminActivityKind>(kind: K) =>
  z
    .object({
      id: z
        .string()
        .max(100)
        .regex(new RegExp(`^${kind}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`, 'i')),
      kind: z.literal(kind),
      action: z.enum(ADMIN_ACTIVITY_ACTIONS[kind]),
      createdAt: catalogPolicyInstantSchema,
      to: z.literal(ADMIN_ACTIVITY_DESTINATIONS[kind])
    })
    .strict()
export const adminActivityItemSchema = z.discriminatedUnion('kind', [
  item('catalog_category'),
  item('catalog_product_status'),
  item('catalog_policy'),
  item('cms_draft'),
  item('cms_publication'),
  item('inventory'),
  item('fulfillment'),
  item('support')
])
export const adminActivityResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z.array(adminActivityItemSchema).max(20),
    nextCursor: z
      .string()
      .min(1)
      .max(768)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable()
  })
  .strict()
export type AdminActivityItem = z.infer<typeof adminActivityItemSchema>
export type AdminActivityResponse = z.infer<typeof adminActivityResponseSchema>
