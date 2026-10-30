import { z } from 'zod'
import { supportKnowledgeCategorySchema } from './support-knowledge'

/**
 * SUP-012 limited FAQ assistant. It is extractive on purpose: the only text it can
 * ever return is a sentence of an approved (published, in-review-date) help article,
 * together with the citation of that article. There is no generative path, so no
 * chemical instruction can be invented. Anything it cannot ground is declared
 * uncertain and offered to a human.
 */
const noControl = (value: string) => !/[\p{Cc}\p{Cf}]/u.test(value)
export const assistantQuestionSchema = z.string().trim().min(3).max(300).refine(noControl)
export const assistantAskInputSchema = z
  .object({ question: assistantQuestionSchema, category: supportKnowledgeCategorySchema.optional() })
  .strict()
export type AssistantAskInput = z.infer<typeof assistantAskInputSchema>
export const assistantHandoffInputSchema = z
  .object({
    turnId: z.string().uuid(),
    contactEmail: z.string().trim().toLowerCase().email().max(254).optional(),
    note: z.string().trim().min(1).max(1000).refine(noControl).optional()
  })
  .strict()
export type AssistantHandoffInput = z.infer<typeof assistantHandoffInputSchema>
export const assistantFeedbackInputSchema = z.object({ turnId: z.string().uuid(), helpful: z.boolean() }).strict()
export type AssistantFeedbackInput = z.infer<typeof assistantFeedbackInputSchema>

export type AssistantOutcome = 'answered' | 'uncertain' | 'handoff_required'
export type AssistantReason =
  'grounded' | 'no_match' | 'low_confidence' | 'chemical_safety' | 'emergency' | 'knowledge_unavailable'
export interface AssistantSource {
  pageId: string
  versionId: string
  slug: string
  title: string
  category: string
  reviewedAt: string
}
export interface ApprovedArticle extends AssistantSource {
  description: string
  passages: string[]
}
export interface GroundedSelection {
  outcome: AssistantOutcome
  reason: AssistantReason
  answer: string | null
  confidenceBp: number
  sources: AssistantSource[]
  notice: string | null
}

export const ASSISTANT_MIN_COVERAGE_BP = 6000
export const ASSISTANT_CHEMICAL_MIN_COVERAGE_BP = 8000
export const EMERGENCY_NOTICE =
  'Si hay una persona afectada o en peligro, llama al 112 ahora. Una persona de nuestro equipo revisará tu consulta, pero no sustituye a los servicios de emergencia.'
export const CHEMICAL_NOTICE =
  'Consulta siempre la ficha de datos de seguridad del producto; si tienes dudas, puedes hablar con una persona de nuestro equipo.'

const STOPWORDS = new Set(
  (
    'de la el los las un una unos unas y o a en por para con sin que como cual cuando cuanto donde es son ser se mi mis ' +
    'tu tus su sus al del lo le les me te nos puedo puedes puede pueden quiero quieres hay ha he has han no si mas muy ya ' +
    'pero este esta esto ese esa estos estas hola buenas gracias favor tengo tiene tienen sobre desde hasta entre'
  ).split(' ')
)
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}
function stem(token: string): string {
  if (token.length > 5 && token.endsWith('es')) return token.slice(0, -2)
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1)
  return token
}
/** Sorted, de-duplicated content tokens: the basis of matching and of repeated-question clustering. */
export function tokenizeQuestion(value: string): string[] {
  const tokens = foldText(value)
    .split(/[^a-z0-9ñ]+/u)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
    .map(stem)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
  return [...new Set(tokens)].sort()
}
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true
  const shortest = Math.min(a.length, b.length)
  if (shortest < 5) return false
  let prefix = 0
  while (prefix < shortest && a[prefix] === b[prefix]) prefix++
  return prefix >= Math.max(5, shortest - 2)
}
/** Removes direct identifiers before a question is persisted for analysis. */
export function redactQuestion(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, '[enlace]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[correo]')
    .replace(/\+?\d[\d\s().-]{4,}\d/g, '[numero]')
    .replace(/\s+/g, ' ')
    .trim()
}

const EMERGENCY =
  /\b(beb(?:i|e)\w*|ingeri\w*|trag(?:o|ue|ad|ar)\w*|inhal\w*|intoxic\w*|envenen\w*|quemadur\w*|salpic\w*|ojos?|vomit\w*|desmay\w*|urgenci\w*)\b/
const CHEMICAL =
  /\b(mezcl\w*|junt(?:ar|o|e)\w*|combin\w*|dilu\w*|dosis|dosific\w*|proporcion\w*|neutraliz\w*|reaccion\w*|gas(?:es)? toxic\w*|cuanto (?:echar|poner|usar|anadir|verter))\b/
export type AssistantRisk = 'none' | 'chemical' | 'emergency'
export function assessRisk(question: string): AssistantRisk {
  const folded = foldText(question)
  if (EMERGENCY.test(folded)) return 'emergency'
  return CHEMICAL.test(folded) ? 'chemical' : 'none'
}

const toSource = (article: ApprovedArticle): AssistantSource => ({
  pageId: article.pageId,
  versionId: article.versionId,
  slug: article.slug,
  title: article.title,
  category: article.category,
  reviewedAt: article.reviewedAt
})
const refuse = (
  outcome: AssistantOutcome,
  reason: AssistantReason,
  confidenceBp = 0,
  notice: string | null = null
): GroundedSelection => ({ outcome, reason, answer: null, confidenceBp, sources: [], notice })

export function sentencesOf(passages: readonly string[]): string[] {
  return passages.flatMap((passage) =>
    passage
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length >= 8 && sentence.length <= 600)
  )
}

export function selectGroundedAnswer(
  question: string,
  articles: readonly ApprovedArticle[],
  risk: AssistantRisk
): GroundedSelection {
  if (risk === 'emergency') return refuse('handoff_required', 'emergency', 0, EMERGENCY_NOTICE)
  const query = tokenizeQuestion(question)
  let best: { article: ApprovedArticle; sentence: string; coverage: number; own: number } | null = null
  if (query.length > 0) {
    for (const article of articles) {
      const context = [...tokenizeQuestion(article.title), ...tokenizeQuestion(article.description)]
      for (const sentence of sentencesOf(article.passages)) {
        const own = tokenizeQuestion(sentence)
        const ownHits = query.filter((token) => own.some((candidate) => tokensMatch(token, candidate))).length
        if (ownHits === 0) continue
        const covered = query.filter((token) =>
          [...own, ...context].some((candidate) => tokensMatch(token, candidate))
        ).length
        const coverage = covered / query.length
        if (!best || coverage > best.coverage || (coverage === best.coverage && ownHits > best.own))
          best = { article, sentence, coverage, own: ownHits }
      }
    }
  }
  if (!best)
    return refuse(
      risk === 'chemical' ? 'handoff_required' : 'uncertain',
      risk === 'chemical' ? 'chemical_safety' : 'no_match'
    )
  const confidenceBp = Math.round(best.coverage * 10000)
  const enough = confidenceBp >= ASSISTANT_MIN_COVERAGE_BP && best.own >= Math.min(2, query.length)
  if (risk === 'chemical') {
    const trusted = ['seguridad', 'productos'].includes(best.article.category)
    if (!trusted || confidenceBp < ASSISTANT_CHEMICAL_MIN_COVERAGE_BP || !enough)
      return refuse('handoff_required', 'chemical_safety', confidenceBp)
  } else if (!enough) return refuse('uncertain', 'low_confidence', confidenceBp)
  return {
    outcome: 'answered',
    reason: 'grounded',
    answer: best.sentence,
    confidenceBp,
    sources: [toSource(best.article)],
    notice: risk === 'chemical' ? CHEMICAL_NOTICE : null
  }
}

/** Two unresolved questions are the same topic when one's content words are (almost) contained in the other's. */
export function questionsSimilar(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const shared = a.filter((token) => b.some((other) => tokensMatch(token, other))).length
  return shared >= Math.min(2, a.length, b.length) && shared / Math.min(a.length, b.length) >= 0.75
}
