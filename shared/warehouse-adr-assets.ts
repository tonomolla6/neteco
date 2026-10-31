import { z } from 'zod'

export const adrClassSchema = z.enum(['8', '3', '5.1', '6.1', '9', 'NONE'])
export type AdrClass = z.infer<typeof adrClassSchema>

export const packingGroupSchema = z.enum(['I', 'II', 'III', 'NONE'])
export type PackingGroup = z.infer<typeof packingGroupSchema>

export const tunnelCodeSchema = z.enum(['(E)', '(D/E)', '(B/D)', 'NONE'])
export type TunnelCode = z.infer<typeof tunnelCodeSchema>

export const ghsPictogramSchema = z.enum([
  'GHS01', // Explosivo
  'GHS02', // Inflamable
  'GHS03', // Comburente
  'GHS04', // Gas a presión
  'GHS05', // Corrosivo
  'GHS06', // Toxicidad aguda
  'GHS07', // Nocivo / Irritante
  'GHS08', // Peligro para la salud
  'GHS09' // Peligro medio ambiente
])
export type GhsPictogram = z.infer<typeof ghsPictogramSchema>

export const signalWordSchema = z.enum(['PELIGRO', 'ATENCIÓN', 'NONE'])
export type SignalWord = z.infer<typeof signalWordSchema>

export const variantAdrSpecSchema = z
  .object({
    id: z.string().uuid(),
    variantId: z.string().min(1).max(64),
    unNumber: z.string().regex(/^(?:UN \d{4}|NONE)$/),
    properShippingName: z.string().trim().min(2).max(200),
    adrClass: adrClassSchema,
    packingGroup: packingGroupSchema,
    tunnelCode: tunnelCodeSchema,
    limitedQuantity: z.string().trim().min(1).max(20),
    adrPointsFactor: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(20), z.literal(50)]),
    pictograms: z.array(ghsPictogramSchema),
    signalWord: signalWordSchema,
    hazardStatements: z.array(z.string().trim().min(2).max(300)),
    precautionaryStatements: z.array(z.string().trim().min(2).max(300)),
    ufiCode: z.string().trim().min(10).max(50).nullable(),
    handlingInstructions: z.array(z.string().trim().min(2).max(300)),
    sdsVersion: z.string().trim().min(1).max(20),
    version: z.number().int().positive(),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
export type VariantAdrSpec = z.infer<typeof variantAdrSpecSchema>

export const warehouseLotRecordSchema = z
  .object({
    id: z.string().uuid(),
    lotNumber: z.string().trim().min(3).max(64),
    variantId: z.string().min(1).max(64),
    specVersion: z.number().int().positive(),
    manufacturingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    unitsProduced: z.number().int().positive().max(1000000),
    qaReleaseStatus: z.enum(['approved', 'quarantine', 'rejected']),
    qaReleasedBy: z.string().uuid().nullable(),
    qaReleasedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      .nullable(),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
  .refine((lot) => lot.expiryDate >= lot.manufacturingDate, {
    message: 'expiryDate must be greater than or equal to manufacturingDate'
  })
export type WarehouseLotRecord = z.infer<typeof warehouseLotRecordSchema>

export const generatedClpLabelSchema = z
  .object({
    source: z.literal('cloudflare'),
    variantId: z.string(),
    lotNumber: z.string(),
    productName: z.string(),
    variantLabel: z.string(),
    netQuantity: z.string(),
    unNumber: z.string(),
    properShippingName: z.string(),
    signalWord: signalWordSchema,
    pictograms: z.array(ghsPictogramSchema),
    hazardStatements: z.array(z.string()),
    precautionaryStatements: z.array(z.string()),
    ufiCode: z.string().nullable(),
    emergencyPhone: z.literal('+34 91 562 04 20'), // INTCF
    supplierInfo: z.object({
      name: z.string(),
      address: z.string(),
      vatNumber: z.string()
    }),
    manufacturingDate: z.string(),
    expiryDate: z.string(),
    specVersion: z.number().int().positive(),
    sdsVersion: z.string(),
    barcodeData: z.string(),
    generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
export type GeneratedClpLabel = z.infer<typeof generatedClpLabelSchema>

export const adrTransportLineSchema = z
  .object({
    unNumber: z.string(),
    properShippingName: z.string(),
    adrClass: adrClassSchema,
    packingGroup: packingGroupSchema,
    tunnelCode: tunnelCodeSchema,
    packagesCount: z.number().int().positive(),
    packageType: z.string(),
    totalLitersOrKg: z.number().positive(),
    transportCategory: z.number().int().min(0).max(4),
    adrFactor: z.number().int().min(0).max(50),
    calculatedPoints: z.number().nonnegative(),
    isDangerousGoods: z.boolean()
  })
  .strict()
export type AdrTransportLine = z.infer<typeof adrTransportLineSchema>

export const adrTransportDocumentSchema = z
  .object({
    source: z.literal('cloudflare'),
    manifestId: z.string().uuid(),
    lotNumbers: z.array(z.string()),
    lines: z.array(adrTransportLineSchema),
    totalCalculatedPoints: z.number().nonnegative(),
    isExemptUnder1136: z.boolean(), // Total <= 1000 points exemption
    mandatoryDeclaration: z.string(),
    carrierInstructions: z.array(z.string()),
    generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
export type AdrTransportDocument = z.infer<typeof adrTransportDocumentSchema>

export const warehouseHandlingInstructionsSchema = z
  .object({
    source: z.literal('cloudflare'),
    variantId: z.string(),
    lotNumber: z.string().nullable(),
    unNumber: z.string(),
    storageConditions: z.array(z.string()),
    incompatibleMaterials: z.array(z.string()),
    requiredPpe: z.array(z.string()), // Equipos de Protección Individual
    spillResponseSteps: z.array(z.string()),
    firstAidSummary: z.array(z.string()),
    specVersion: z.number().int().positive(),
    generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
export type WarehouseHandlingInstructions = z.infer<typeof warehouseHandlingInstructionsSchema>

export const upsertVariantAdrSpecInputSchema = z.object({
  variantId: z.string().min(1).max(64),
  unNumber: z.string().regex(/^(?:UN \d{4}|NONE)$/),
  properShippingName: z.string().trim().min(2).max(200),
  adrClass: adrClassSchema,
  packingGroup: packingGroupSchema,
  tunnelCode: tunnelCodeSchema,
  limitedQuantity: z.string().trim().min(1).max(20),
  adrPointsFactor: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(20), z.literal(50)]),
  pictograms: z.array(ghsPictogramSchema),
  signalWord: signalWordSchema,
  hazardStatements: z.array(z.string().trim().min(2).max(300)),
  precautionaryStatements: z.array(z.string().trim().min(2).max(300)),
  ufiCode: z.string().trim().min(10).max(50).nullable().optional(),
  handlingInstructions: z.array(z.string().trim().min(2).max(300)),
  sdsVersion: z.string().trim().min(1).max(20)
})
export type UpsertVariantAdrSpecInput = z.infer<typeof upsertVariantAdrSpecInputSchema>

export const createWarehouseLotInputSchema = z
  .object({
    commandId: z.string().min(1).max(128),
    lotNumber: z.string().trim().min(3).max(64),
    variantId: z.string().min(1).max(64),
    specVersion: z.number().int().positive(),
    manufacturingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    unitsProduced: z.number().int().positive().max(1000000),
    qaReleaseStatus: z.enum(['approved', 'quarantine', 'rejected'])
  })
  .refine((lot) => lot.expiryDate >= lot.manufacturingDate, {
    message: 'expiryDate must be greater than or equal to manufacturingDate'
  })
export type CreateWarehouseLotInput = z.infer<typeof createWarehouseLotInputSchema>

export const generateAdrTransportDocumentInputSchema = z.object({
  commandId: z.string().min(1).max(128),
  shipmentItems: z
    .array(
      z.object({
        lotNumber: z.string().trim().min(3).max(64),
        packagesCount: z.number().int().positive(),
        packageType: z.string().trim().min(2).max(50),
        litersOrKgPerPackage: z.number().positive()
      })
    )
    .min(1)
})
export type GenerateAdrTransportDocumentInput = z.infer<typeof generateAdrTransportDocumentInputSchema>
