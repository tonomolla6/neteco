import { z } from 'zod'

export const CMS_PREVIEW_BREAKPOINTS = {
  mobile: { name: 'mobile', width: 375, height: 667, label: 'Móvil (375px)' },
  tablet: { name: 'tablet', width: 768, height: 1024, label: 'Tablet (768px)' },
  desktop: { name: 'desktop', width: 1280, height: 800, label: 'Escritorio (1280px)' }
} as const

export type CmsPreviewBreakpoint = keyof typeof CMS_PREVIEW_BREAKPOINTS

export const cmsPreviewBreakpointSchema = z.enum(['mobile', 'tablet', 'desktop'])

export interface ContentBlockSnapshot {
  id: string
  type: string
  [key: string]: unknown
}

export interface ContentDocumentSnapshot {
  title: string
  slug: string
  seo: {
    title: string
    description: string
    noindex: boolean
  }
  changeSummary?: string
  blocks: ContentBlockSnapshot[]
}

export type ChangeType = 'added' | 'removed' | 'modified' | 'unchanged'

export interface BlockDiffItem {
  id: string
  changeType: ChangeType
  oldBlock?: ContentBlockSnapshot
  newBlock?: ContentBlockSnapshot
  fieldDifferences?: string[]
}

export interface MetadataDiff {
  titleChanged: boolean
  oldTitle?: string
  newTitle?: string
  slugChanged: boolean
  oldSlug?: string
  newSlug?: string
  seoChanged: boolean
  noindexChanged: boolean
  oldSeo?: { title: string; description: string; noindex: boolean }
  newSeo?: { title: string; description: string; noindex: boolean }
}

export interface ContentDiffSummary {
  addedBlocksCount: number
  removedBlocksCount: number
  modifiedBlocksCount: number
  unchangedBlocksCount: number
}

export interface ContentDiffResult {
  hasChanges: boolean
  metadataDiff: MetadataDiff
  blockDiffs: BlockDiffItem[]
  summary: ContentDiffSummary
}

function areBlockFieldsEqual(a: ContentBlockSnapshot, b: ContentBlockSnapshot): { equal: boolean; diffs: string[] } {
  const diffs: string[] = []
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (k === 'id') continue
    const valA = JSON.stringify((a as Record<string, unknown>)[k])
    const valB = JSON.stringify((b as Record<string, unknown>)[k])
    if (valA !== valB) {
      diffs.push(k)
    }
  }
  return { equal: diffs.length === 0, diffs }
}

export function diffContentDocuments(docA: ContentDocumentSnapshot, docB: ContentDocumentSnapshot): ContentDiffResult {
  const titleChanged = docA.title !== docB.title
  const slugChanged = docA.slug !== docB.slug
  const seoChanged =
    docA.seo.title !== docB.seo.title ||
    docA.seo.description !== docB.seo.description ||
    Boolean(docA.seo.noindex) !== Boolean(docB.seo.noindex)
  const noindexChanged = Boolean(docA.seo.noindex) !== Boolean(docB.seo.noindex)

  const metadataDiff: MetadataDiff = {
    titleChanged,
    oldTitle: docA.title,
    newTitle: docB.title,
    slugChanged,
    oldSlug: docA.slug,
    newSlug: docB.slug,
    seoChanged,
    noindexChanged,
    oldSeo: docA.seo,
    newSeo: docB.seo
  }

  const mapA = new Map<string, ContentBlockSnapshot>()
  for (const b of docA.blocks) {
    mapA.set(b.id, b)
  }

  const mapB = new Map<string, ContentBlockSnapshot>()
  for (const b of docB.blocks) {
    mapB.set(b.id, b)
  }

  const blockDiffs: BlockDiffItem[] = []
  let addedCount = 0
  let removedCount = 0
  let modifiedCount = 0
  let unchangedCount = 0

  // Track blocks in order of docB, noting additions and modifications
  for (const b of docB.blocks) {
    const prev = mapA.get(b.id)
    if (!prev) {
      blockDiffs.push({
        id: b.id,
        changeType: 'added',
        newBlock: b
      })
      addedCount++
    } else {
      const fieldCheck = areBlockFieldsEqual(prev, b)
      if (fieldCheck.equal) {
        blockDiffs.push({
          id: b.id,
          changeType: 'unchanged',
          oldBlock: prev,
          newBlock: b
        })
        unchangedCount++
      } else {
        blockDiffs.push({
          id: b.id,
          changeType: 'modified',
          oldBlock: prev,
          newBlock: b,
          fieldDifferences: fieldCheck.diffs
        })
        modifiedCount++
      }
    }
  }

  // Check for blocks removed from docA
  for (const a of docA.blocks) {
    if (!mapB.has(a.id)) {
      blockDiffs.push({
        id: a.id,
        changeType: 'removed',
        oldBlock: a
      })
      removedCount++
    }
  }

  const hasChanges =
    titleChanged || slugChanged || seoChanged || addedCount > 0 || removedCount > 0 || modifiedCount > 0

  return {
    hasChanges,
    metadataDiff,
    blockDiffs,
    summary: {
      addedBlocksCount: addedCount,
      removedBlocksCount: removedCount,
      modifiedBlocksCount: modifiedCount,
      unchangedBlocksCount: unchangedCount
    }
  }
}

export const previewComparisonQuerySchema = z
  .object({
    pageId: z.string().uuid(),
    baseVersion: z.coerce.number().int().min(0).default(1),
    compareVersion: z.coerce.number().int().min(1).default(2),
    breakpoint: cmsPreviewBreakpointSchema.default('desktop')
  })
  .strict()

export const templateRegressionCheckSchema = z
  .object({
    templateName: z.enum(['home', 'catalog', 'search', 'product', 'cart_empty', 'login', 'promotional_landing']),
    breakpoint: cmsPreviewBreakpointSchema,
    renderedSelectors: z.array(z.string().min(1).max(200)).min(1).max(100)
  })
  .strict()
