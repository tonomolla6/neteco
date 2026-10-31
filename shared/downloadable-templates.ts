import { z } from 'zod'

export const templateTypeSchema = z.enum(['checklist', 'plan', 'guide'])
export type TemplateType = z.infer<typeof templateTypeSchema>

export const templateCategorySchema = z.enum([
  'hosteleria',
  'industria',
  'sanitario',
  'lavanderia',
  'alimentaria',
  'mantenimiento'
])
export type TemplateCategory = z.infer<typeof templateCategorySchema>

export const templateStatusSchema = z.enum(['draft', 'published', 'archived'])
export type TemplateStatus = z.infer<typeof templateStatusSchema>

export const templateChecklistItemSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().trim().min(2).max(300),
    mandatory: z.boolean(),
    frequency: z.enum(['diaria', 'semanal', 'mensual', 'por_turno', 'por_lote', 'previa_uso']).optional(),
    criticalControlPoint: z.boolean().default(false)
  })
  .strict()
export type TemplateChecklistItem = z.infer<typeof templateChecklistItemSchema>

export const templateSectionSchema = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().max(1000).optional(),
    items: z.array(templateChecklistItemSchema).min(1).max(50)
  })
  .strict()
export type TemplateSection = z.infer<typeof templateSectionSchema>

export const templatePdfMetadataSchema = z
  .object({
    filename: z.string().regex(/^[a-z0-9-]+\.pdf$/),
    byteSize: z.number().int().positive(),
    title: z.string().min(1).max(200),
    language: z.literal('es'),
    accessible: z.literal(true)
  })
  .strict()
export type TemplatePdfMetadata = z.infer<typeof templatePdfMetadataSchema>

export const downloadableTemplateSchema = z
  .object({
    id: z.string().uuid(),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .min(2)
      .max(160),
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().min(10).max(500),
    templateType: templateTypeSchema,
    category: templateCategorySchema,
    targetAudience: z.string().trim().min(2).max(160),
    sections: z.array(templateSectionSchema).min(1).max(20),
    pdfMetadata: templatePdfMetadataSchema,
    status: templateStatusSchema,
    version: z.number().int().positive(),
    publishedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      .nullable(),
    reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    reviewDueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    createdBy: z.string().uuid(),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    canonicalPath: z.string().regex(/^\/plantillas\/[a-z0-9-]+$/),
    downloadUrl: z.string().regex(/^\/api\/templates\/[a-z0-9-]+\/pdf$/),
    indexable: z.boolean()
  })
  .strict()
export type DownloadableTemplate = z.infer<typeof downloadableTemplateSchema>

export const templateSummarySchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string().min(3).max(200),
    description: z.string().min(10).max(500),
    templateType: templateTypeSchema,
    category: templateCategorySchema,
    targetAudience: z.string().min(2).max(160),
    version: z.number().int().positive(),
    publishedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      .nullable(),
    canonicalPath: z.string().regex(/^\/plantillas\/[a-z0-9-]+$/),
    downloadUrl: z.string().regex(/^\/api\/templates\/[a-z0-9-]+\/pdf$/),
    itemCount: z.number().int().nonnegative(),
    indexable: z.boolean()
  })
  .strict()
export type TemplateSummary = z.infer<typeof templateSummarySchema>

export const templateListQuerySchema = z
  .object({
    q: z.string().trim().max(80).default(''),
    category: templateCategorySchema.optional(),
    type: templateTypeSchema.optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    perPage: z.coerce.number().int().min(1).max(50).default(20)
  })
  .strict()
export type TemplateListQuery = z.infer<typeof templateListQuerySchema>

export const templateListResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z.array(templateSummarySchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    perPage: z.number().int().positive(),
    pages: z.number().int().nonnegative(),
    categories: z.array(templateCategorySchema),
    types: z.array(templateTypeSchema),
    canonicalPath: z.literal('/plantillas'),
    indexable: z.boolean()
  })
  .strict()
export type TemplateListResponse = z.infer<typeof templateListResponseSchema>

export const templateCreateInputSchema = z
  .object({
    commandId: z.string().uuid(),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .min(2)
      .max(160),
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().min(10).max(500),
    templateType: templateTypeSchema,
    category: templateCategorySchema,
    targetAudience: z.string().trim().min(2).max(160),
    sections: z.array(templateSectionSchema).min(1).max(20),
    reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    reviewDueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
  .refine((d) => d.reviewDueAt > d.reviewedAt, {
    message: 'reviewDueAt must be after reviewedAt'
  })
export type TemplateCreateInput = z.infer<typeof templateCreateInputSchema>

export const templatePublishInputSchema = z
  .object({
    commandId: z.string().uuid(),
    templateId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative()
  })
  .strict()
export type TemplatePublishInput = z.infer<typeof templatePublishInputSchema>

export const templateUpdateInputSchema = z
  .object({
    commandId: z.string().uuid().optional(),
    templateId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(5).max(200),
    description: z.string().trim().min(10).max(1000),
    sections: z.array(templateSectionSchema).min(1).max(20),
    reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    reviewDueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
  .refine((d) => d.reviewDueAt > d.reviewedAt, {
    message: 'reviewDueAt must be after reviewedAt'
  })
export type TemplateUpdateInput = z.infer<typeof templateUpdateInputSchema>
