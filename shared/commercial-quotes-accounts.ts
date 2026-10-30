import { z } from 'zod'
import { catalogPolicyUuidSchema as uuid, catalogPolicyInstantSchema as instant } from './catalog-publication-policy'

export const pipelineStageSchema = z.enum([
  'lead',
  'contacted',
  'quote_drafted',
  'quote_sent',
  'negotiation',
  'approved',
  'converted',
  'lost'
])
export type PipelineStage = z.infer<typeof pipelineStageSchema>

export const nextActionPrioritySchema = z.enum(['urgent', 'high', 'normal', 'low'])
export type NextActionPriority = z.infer<typeof nextActionPrioritySchema>

export const commercialNextActionSchema = z
  .object({
    id: uuid,
    customerId: uuid,
    quoteId: uuid.nullable(),
    actionDescription: z.string().min(5).max(500),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    priority: nextActionPrioritySchema,
    assignedIdentityId: uuid,
    assignedManagerName: z.string().optional(),
    completed: z.boolean(),
    completedAt: instant.nullable(),
    completedBy: uuid.nullable(),
    version: z.number().int().min(1),
    createdBy: uuid,
    createdAt: instant,
    updatedAt: instant
  })
  .strict()
export type CommercialNextAction = z.infer<typeof commercialNextActionSchema>

export const createNextActionInputSchema = z
  .object({
    customerId: uuid,
    quoteId: uuid.optional(),
    actionDescription: z.string().trim().min(5).max(500),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    priority: nextActionPrioritySchema.default('normal'),
    assignedIdentityId: uuid
  })
  .strict()
export type CreateNextActionInput = z.infer<typeof createNextActionInputSchema>

export const completeNextActionInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    notes: z.string().trim().min(3).max(500).optional()
  })
  .strict()
export type CompleteNextActionInput = z.infer<typeof completeNextActionInputSchema>

export const evaluateQuoteMarginInputSchema = z
  .object({
    quoteVersion: z.number().int().min(1),
    totalNetCents: z.number().int().min(0),
    totalCostCents: z.number().int().min(0)
  })
  .strict()
export type EvaluateQuoteMarginInput = z.infer<typeof evaluateQuoteMarginInputSchema>

export const quoteMarginRecordSchema = z
  .object({
    quoteId: uuid,
    quoteVersion: z.number().int().min(1),
    totalNetCents: z.number().int().min(0),
    totalCostCents: z.number().int().min(0),
    marginCents: z.number().int(),
    marginPercentageBps: z.number().int(),
    isBelowThreshold: z.boolean(),
    approvedBy: uuid.nullable(),
    approvedAt: instant.nullable(),
    createdAt: instant,
    updatedAt: instant
  })
  .strict()
export type QuoteMarginRecord = z.infer<typeof quoteMarginRecordSchema>

export const approveMarginThresholdInputSchema = z
  .object({
    reason: z.string().trim().min(5).max(500)
  })
  .strict()
export type ApproveMarginThresholdInput = z.infer<typeof approveMarginThresholdInputSchema>

export const commercialAccountSummarySchema = z
  .object({
    customerId: uuid,
    companyName: z.string(),
    contactName: z.string(),
    contactEmail: z.string(),
    activeQuotesCount: z.number().int().min(0),
    pipelineValueGrossCents: z.number().int().min(0),
    averageMarginBps: z.number().int(),
    nextActions: z.array(commercialNextActionSchema),
    recentActivities: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        description: z.string(),
        createdAt: instant
      })
    )
  })
  .strict()
export type CommercialAccountSummary = z.infer<typeof commercialAccountSummarySchema>

export const commercialPipelineSummarySchema = z
  .object({
    erpDisclaimer: z.string(),
    stages: z.record(
      pipelineStageSchema,
      z.object({
        count: z.number().int().min(0),
        totalGrossCents: z.number().int().min(0),
        weightedValueCents: z.number().int().min(0)
      })
    ),
    overallGrossCents: z.number().int().min(0),
    overallAverageMarginBps: z.number().int(),
    pendingNextActionsCount: z.number().int().min(0),
    accounts: z.array(commercialAccountSummarySchema)
  })
  .strict()
export type CommercialPipelineSummary = z.infer<typeof commercialPipelineSummarySchema>
