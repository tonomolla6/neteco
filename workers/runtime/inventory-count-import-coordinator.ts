import { z } from 'zod'
import {
  inventoryCountImportApprovalInputSchema,
  inventoryCountImportProposalInputSchema,
  type InventoryCountImportReceipt
} from '../../shared/inventory-count-import'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  approveD1InventoryCountImport,
  InventoryCountImportError,
  proposeD1InventoryCountImport
} from '../catalog/inventory-count-import'

const claims = z
  .object({
    identityId: catalogPolicyUuidSchema,
    sessionId: catalogPolicyUuidSchema,
    sessionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
const common = {
  type: z.literal('inventory_count_import'),
  claims,
  idempotencyKey: catalogPolicyUuidSchema
}
const command = z.discriminatedUnion('action', [
  z
    .object({
      ...common,
      action: z.literal('propose'),
      targetId: z.null(),
      input: inventoryCountImportProposalInputSchema
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('approve'),
      targetId: catalogPolicyUuidSchema,
      input: inventoryCountImportApprovalInputSchema
    })
    .strict()
])

export function parseInventoryCountImportCoordinatorCommand(raw: unknown) {
  let value: unknown
  try {
    value = catalogPolicyOwnJson(raw)
  } catch {
    throw new InventoryCountImportError('invalid_input')
  }
  const result = command.safeParse(value)
  if (!result.success) throw new InventoryCountImportError('invalid_input')
  return result.data
}

/** Only invoked inside the existing global inventory mutation queue. D1
 * re-authorizes even durable replays; reservation response caches do not apply. */
export async function executeD1InventoryCountImportCoordinatorCommand(
  database: D1Database,
  raw: unknown
): Promise<InventoryCountImportReceipt> {
  const parsed = parseInventoryCountImportCoordinatorCommand(raw)
  const options = { idempotencyKey: parsed.idempotencyKey }
  return parsed.action === 'propose'
    ? proposeD1InventoryCountImport(database, parsed.claims, parsed.input, options)
    : approveD1InventoryCountImport(database, parsed.claims, parsed.targetId, parsed.input, options)
}
