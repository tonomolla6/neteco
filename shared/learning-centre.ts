import { z } from 'zod'

export const LEGAL_NON_OFFICIAL_ACCREDITATION_DISCLAIMER =
  'Certificado de aprovechamiento interno Neteco. Documento formativo sin valor de titulación oficial ni acreditación profesional reglamentaria (RD 395/2007).'

export const quizQuestionOptionSchema = z.object({
  id: z.string().min(1).max(32),
  text: z.string().min(1).max(200)
})

export const quizQuestionSchema = z.object({
  id: z.string().min(1).max(32),
  question: z.string().min(5).max(300),
  options: z.array(quizQuestionOptionSchema).min(2).max(6),
  correctOptionId: z.string().min(1).max(32),
  explanation: z.string().min(5).max(500)
})

export type QuizQuestionOption = z.infer<typeof quizQuestionOptionSchema>
export type QuizQuestion = z.infer<typeof quizQuestionSchema>

export const createCourseSchema = z.object({
  title: z.string().min(3).max(200),
  slug: z
    .string()
    .min(3)
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'Slug debe contener solo letras minúsculas, números y guiones'),
  description: z.string().min(10).max(2000),
  category: z.enum([
    'chemical_safety',
    'dosage_optimization',
    'hygiene_haccp',
    'industrial_cleaning',
    'sustainability'
  ]),
  targetSector: z
    .enum([
      'hosteleria',
      'lavanderia_industrial',
      'agroalimentario',
      'automocion_taller',
      'sanitario_clinicas',
      'facility_services',
      'general'
    ])
    .optional(),
  estimatedDurationMinutes: z.number().int().min(5).max(600),
  passingScorePercent: z.number().int().min(50).max(100).default(80)
})

export type CreateCourseInput = z.infer<typeof createCourseSchema>

export const updateCourseSchema = createCourseSchema.partial().extend({
  passingScorePercent: createCourseSchema.shape.passingScorePercent.unwrap().optional(),
  version: z.number().int().min(1),
  status: z.enum(['draft', 'published', 'archived']).optional()
})

export type UpdateCourseInput = z.infer<typeof updateCourseSchema>

export const createLessonSchema = z.object({
  courseId: z.string().min(1).max(64),
  sortOrder: z.number().int().min(0),
  slug: z.string().min(3).max(100),
  title: z.string().min(3).max(200),
  summary: z.string().min(10).max(500),
  contentMarkdown: z.string().min(20).max(20000),
  linkedProductIds: z.array(z.string().min(1).max(64)).default([]),
  supportTopic: z.string().min(3).max(100),
  supportActionLabel: z.string().min(3).max(100),
  supportActionUrl: z.string().min(3).max(300),
  quizQuestions: z.array(quizQuestionSchema).default([])
})

export type CreateLessonInput = z.infer<typeof createLessonSchema>

export const submitQuizSchema = z.object({
  answers: z.record(z.string(), z.string())
})

export type SubmitQuizInput = z.infer<typeof submitQuizSchema>

export interface Course {
  id: string
  slug: string
  title: string
  description: string
  category: string
  targetSector: string | null
  estimatedDurationMinutes: number
  passingScorePercent: number
  status: 'draft' | 'published' | 'archived'
  version: number
  createdAt: string
  updatedAt: string
}

export interface Lesson {
  id: string
  courseId: string
  sortOrder: number
  slug: string
  title: string
  summary: string
  contentMarkdown: string
  linkedProductIds: string[]
  supportTopic: string
  supportActionLabel: string
  supportActionUrl: string
  quizQuestions: QuizQuestion[]
  createdAt: string
  progress?: {
    quizScorePercent: number | null
    passed: boolean
    completedAt: string | null
  }
}

export interface Certificate {
  id: string
  certificateCode: string
  customerId: string
  courseId: string
  recipientName: string
  companyName: string | null
  courseTitle: string
  finalScorePercent: number
  isOfficialAccreditation: false
  legalDisclaimer: string
  verificationHash: string
  issuedAt: string
}

export function calculateQuizScore(
  questions: QuizQuestion[],
  answers: Record<string, string>
): { scorePercent: number; passed: boolean; correctCount: number; totalCount: number } {
  if (!questions || questions.length === 0) {
    return { scorePercent: 100, passed: true, correctCount: 0, totalCount: 0 }
  }

  let correctCount = 0
  for (const q of questions) {
    const userAnswer = answers[q.id]
    if (userAnswer && userAnswer === q.correctOptionId) {
      correctCount += 1
    }
  }

  const scorePercent = Math.round((correctCount / questions.length) * 100)
  const passed = scorePercent >= 80

  return { scorePercent, passed, correctCount, totalCount: questions.length }
}

export function generateCertificateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let randomPart = ''
  for (let i = 0; i < 8; i++) {
    randomPart += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return `CERT-NET-${randomPart}`
}

export function generateVerificationHash(input: {
  certificateCode: string
  customerId: string
  courseId: string
  issuedAt: string
}): string {
  const data = `${input.certificateCode}:${input.customerId}:${input.courseId}:${input.issuedAt}:neteco-internal-cert-v1`
  // Deterministic 64-character hex hash based on data
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < data.length; i++) {
    const ch = data.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const part1 = (h1 >>> 0).toString(16).padStart(8, '0')
  const part2 = (h2 >>> 0).toString(16).padStart(8, '0')
  return (part1 + part2).repeat(4).slice(0, 64)
}

export function verifyCertificateEligibility(
  lessons: Array<{ id: string; title: string }>,
  progressItems: Array<{ lessonId: string; passed: boolean; scorePercent: number | null }>
): { eligible: boolean; averageScore: number } {
  if (lessons.length === 0) return { eligible: false, averageScore: 0 }

  const progressByLesson = new Map(progressItems.map((p) => [p.lessonId, p]))
  let totalScore = 0

  for (const lesson of lessons) {
    const prog = progressByLesson.get(lesson.id)
    if (!prog || !prog.passed) {
      return { eligible: false, averageScore: 0 }
    }
    totalScore += prog.scorePercent ?? 0
  }

  const averageScore = Math.round(totalScore / lessons.length)
  return { eligible: true, averageScore }
}
