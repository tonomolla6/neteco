import { z } from 'zod'

const id = z.string().uuid()
const text = (maximum: number) => z.string().trim().min(1).max(maximum)

export const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('heading'), level: z.enum(['h2', 'h3']), text: text(180) }).strict(),
  z.object({ id, type: z.literal('paragraph'), text: text(5_000) }).strict(),
  z.object({ id, type: z.literal('list'), items: z.array(text(500)).min(1).max(30) }).strict(),
  z.object({ id, type: z.literal('image'), assetId: id, alt: text(240), caption: z.string().trim().max(500) }).strict(),
  z
    .object({
      id,
      type: z.literal('callout'),
      tone: z.enum(['info', 'success', 'warning']),
      title: text(180),
      text: text(2_000)
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal('cta'),
      label: text(120),
      href: z
        .string()
        .trim()
        .max(500)
        .refine((value) => value.startsWith('/') || /^https:\/\//.test(value), 'El enlace debe ser interno o HTTPS')
    })
    .strict()
])

export const contentDocumentSchema = z
  .object({
    title: text(160),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(160),
    blocks: z.array(contentBlockSchema).min(1).max(80),
    seo: z.object({ title: text(70), description: text(180), noindex: z.boolean().default(false) }).strict(),
    changeSummary: text(500)
  })
  .strict()

export type ContentBlock = z.infer<typeof contentBlockSchema>
