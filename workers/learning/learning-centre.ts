import {
  calculateQuizScore,
  createCourseSchema,
  createLessonSchema,
  generateCertificateCode,
  generateVerificationHash,
  LEGAL_NON_OFFICIAL_ACCREDITATION_DISCLAIMER,
  type Certificate,
  type Course,
  type CreateCourseInput,
  type CreateLessonInput,
  type Lesson,
  type QuizQuestion
} from '../../shared/learning-centre'

export class LearningCentreError extends Error {
  constructor(
    readonly code:
      | 'forbidden'
      | 'unauthorized'
      | 'not_found'
      | 'slug_conflict'
      | 'duplicate_lesson_order'
      | 'course_incomplete'
      | 'already_certified'
      | 'version_conflict'
      | 'invalid_input'
  ) {
    super(code)
    this.name = 'LearningCentreError'
  }
}

export async function requireAdmin(db: D1Database, actorId: string): Promise<void> {
  const row = await db
    .prepare(
      `SELECT 1 as ok FROM identities i
       JOIN identity_roles ir ON ir.identity_id = i.id
       JOIN role_permissions rp ON rp.role_code = ir.role_code
       WHERE i.id = ?1 AND i.status = 'active' AND rp.permission_code = 'administration.manage'
         AND (ir.expires_at IS NULL OR ir.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
    )
    .bind(actorId)
    .first<{ ok: number }>()

  if (!row?.ok) throw new LearningCentreError('forbidden')
}

export async function createLearningCourseAdmin(
  db: D1Database,
  args: { actorId: string; input: CreateCourseInput; now: string }
): Promise<Course> {
  await requireAdmin(db, args.actorId)
  const parsed = createCourseSchema.safeParse(args.input)
  if (!parsed.success) throw new LearningCentreError('invalid_input')

  const existing = await db
    .prepare(`SELECT id FROM learning_courses WHERE slug = ?1`)
    .bind(parsed.data.slug)
    .first<{ id: string }>()

  if (existing) throw new LearningCentreError('slug_conflict')

  const id = `crs-${crypto.randomUUID()}`
  await db
    .prepare(
      `INSERT INTO learning_courses (
        id, slug, title, description, category, target_sector,
        estimated_duration_minutes, passing_score_percent, status, version, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'published', 1, ?9, ?10)`
    )
    .bind(
      id,
      parsed.data.slug,
      parsed.data.title,
      parsed.data.description,
      parsed.data.category,
      parsed.data.targetSector ?? null,
      parsed.data.estimatedDurationMinutes,
      parsed.data.passingScorePercent ?? 80,
      args.now,
      args.now
    )
    .run()

  return {
    id,
    slug: parsed.data.slug,
    title: parsed.data.title,
    description: parsed.data.description,
    category: parsed.data.category,
    targetSector: parsed.data.targetSector ?? null,
    estimatedDurationMinutes: parsed.data.estimatedDurationMinutes,
    passingScorePercent: parsed.data.passingScorePercent ?? 80,
    status: 'published',
    version: 1,
    createdAt: args.now,
    updatedAt: args.now
  }
}

export async function createLearningLessonAdmin(
  db: D1Database,
  args: { actorId: string; input: CreateLessonInput; now: string }
): Promise<Lesson> {
  await requireAdmin(db, args.actorId)
  const parsed = createLessonSchema.safeParse(args.input)
  if (!parsed.success) throw new LearningCentreError('invalid_input')

  const existingOrder = await db
    .prepare(`SELECT id FROM learning_lessons WHERE course_id = ?1 AND sort_order = ?2`)
    .bind(parsed.data.courseId, parsed.data.sortOrder)
    .first<{ id: string }>()

  if (existingOrder) throw new LearningCentreError('duplicate_lesson_order')

  const id = `lsn-${crypto.randomUUID()}`
  await db
    .prepare(
      `INSERT INTO learning_lessons (
        id, course_id, sort_order, slug, title, summary, content_markdown,
        linked_product_ids_json, support_topic, support_action_label, support_action_url,
        quiz_questions_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
    )
    .bind(
      id,
      parsed.data.courseId,
      parsed.data.sortOrder,
      parsed.data.slug,
      parsed.data.title,
      parsed.data.summary,
      parsed.data.contentMarkdown,
      JSON.stringify(parsed.data.linkedProductIds ?? []),
      parsed.data.supportTopic,
      parsed.data.supportActionLabel,
      parsed.data.supportActionUrl,
      JSON.stringify(parsed.data.quizQuestions ?? []),
      args.now
    )
    .run()

  return {
    id,
    courseId: parsed.data.courseId,
    sortOrder: parsed.data.sortOrder,
    slug: parsed.data.slug,
    title: parsed.data.title,
    summary: parsed.data.summary,
    contentMarkdown: parsed.data.contentMarkdown,
    linkedProductIds: parsed.data.linkedProductIds ?? [],
    supportTopic: parsed.data.supportTopic,
    supportActionLabel: parsed.data.supportActionLabel,
    supportActionUrl: parsed.data.supportActionUrl,
    quizQuestions: (parsed.data.quizQuestions ?? []) as QuizQuestion[],
    createdAt: args.now
  }
}

export async function listPublicCourses(
  db: D1Database,
  filter?: { sector?: string; category?: string }
): Promise<Course[]> {
  let sql = `SELECT id, slug, title, description, category, target_sector, estimated_duration_minutes, passing_score_percent, status, version, created_at, updated_at
             FROM learning_courses WHERE status = 'published'`
  const params: unknown[] = []

  if (filter?.sector) {
    params.push(filter.sector)
    sql += ` AND (target_sector = ?${params.length} OR target_sector IS NULL OR target_sector = 'general')`
  }
  if (filter?.category) {
    params.push(filter.category)
    sql += ` AND category = ?${params.length}`
  }
  sql += ` ORDER BY created_at DESC`

  const rows = await db
    .prepare(sql)
    .bind(...params)
    .all<{
      id: string
      slug: string
      title: string
      description: string
      category: string
      target_sector: string | null
      estimated_duration_minutes: number
      passing_score_percent: number
      status: 'draft' | 'published' | 'archived'
      version: number
      created_at: string
      updated_at: string
    }>()

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    category: r.category,
    targetSector: r.target_sector,
    estimatedDurationMinutes: r.estimated_duration_minutes,
    passingScorePercent: r.passing_score_percent,
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

export async function getCourseWithProgress(
  db: D1Database,
  slugOrId: string,
  customerId?: string
): Promise<Course & { lessons: Lesson[] }> {
  const courseRow = await db
    .prepare(
      `SELECT id, slug, title, description, category, target_sector, estimated_duration_minutes, passing_score_percent, status, version, created_at, updated_at
       FROM learning_courses WHERE id = ?1 OR slug = ?1`
    )
    .bind(slugOrId)
    .first<{
      id: string
      slug: string
      title: string
      description: string
      category: string
      target_sector: string | null
      estimated_duration_minutes: number
      passing_score_percent: number
      status: 'draft' | 'published' | 'archived'
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!courseRow) throw new LearningCentreError('not_found')

  const lessonRows = await db
    .prepare(
      `SELECT id, course_id, sort_order, slug, title, summary, content_markdown,
              linked_product_ids_json, support_topic, support_action_label, support_action_url,
              quiz_questions_json, created_at
       FROM learning_lessons WHERE course_id = ?1 ORDER BY sort_order ASC`
    )
    .bind(courseRow.id)
    .all<{
      id: string
      course_id: string
      sort_order: number
      slug: string
      title: string
      summary: string
      content_markdown: string
      linked_product_ids_json: string
      support_topic: string
      support_action_label: string
      support_action_url: string
      quiz_questions_json: string
      created_at: string
    }>()

  const progressMap = new Map<
    string,
    { quiz_score_percent: number | null; passed: number; completed_at: string | null }
  >()
  if (customerId) {
    const progRows = await db
      .prepare(
        `SELECT lesson_id, quiz_score_percent, passed, completed_at
         FROM learning_customer_progress WHERE customer_id = ?1 AND course_id = ?2`
      )
      .bind(customerId, courseRow.id)
      .all<{
        lesson_id: string
        quiz_score_percent: number | null
        passed: number
        completed_at: string | null
      }>()
    for (const p of progRows.results ?? []) {
      progressMap.set(p.lesson_id, p)
    }
  }

  const lessons: Lesson[] = (lessonRows.results ?? []).map((l) => {
    const prog = progressMap.get(l.id)
    return {
      id: l.id,
      courseId: l.course_id,
      sortOrder: l.sort_order,
      slug: l.slug,
      title: l.title,
      summary: l.summary,
      contentMarkdown: l.content_markdown,
      linkedProductIds: JSON.parse(l.linked_product_ids_json || '[]'),
      supportTopic: l.support_topic,
      supportActionLabel: l.support_action_label,
      supportActionUrl: l.support_action_url,
      quizQuestions: JSON.parse(l.quiz_questions_json || '[]'),
      createdAt: l.created_at,
      progress: prog
        ? {
            quizScorePercent: prog.quiz_score_percent,
            passed: prog.passed === 1,
            completedAt: prog.completed_at
          }
        : undefined
    }
  })

  return {
    id: courseRow.id,
    slug: courseRow.slug,
    title: courseRow.title,
    description: courseRow.description,
    category: courseRow.category,
    targetSector: courseRow.target_sector,
    estimatedDurationMinutes: courseRow.estimated_duration_minutes,
    passingScorePercent: courseRow.passing_score_percent,
    status: courseRow.status,
    version: courseRow.version,
    createdAt: courseRow.created_at,
    updatedAt: courseRow.updated_at,
    lessons
  }
}

export async function submitLessonQuiz(
  db: D1Database,
  args: { customerId: string; lessonId: string; answers: Record<string, string>; now: string }
): Promise<{ passed: boolean; scorePercent: number }> {
  const lesson = await db
    .prepare(`SELECT id, course_id, quiz_questions_json FROM learning_lessons WHERE id = ?1`)
    .bind(args.lessonId)
    .first<{ id: string; course_id: string; quiz_questions_json: string }>()

  if (!lesson) throw new LearningCentreError('not_found')

  const questions: QuizQuestion[] = JSON.parse(lesson.quiz_questions_json || '[]')
  const { scorePercent, passed } = calculateQuizScore(questions, args.answers)

  const existing = await db
    .prepare(`SELECT id FROM learning_customer_progress WHERE customer_id = ?1 AND lesson_id = ?2`)
    .bind(args.customerId, args.lessonId)
    .first<{ id: string }>()

  if (existing) {
    await db
      .prepare(
        `UPDATE learning_customer_progress
         SET quiz_score_percent = ?1, passed = ?2, answers_json = ?3, completed_at = ?4, updated_at = ?5
         WHERE id = ?6`
      )
      .bind(scorePercent, passed ? 1 : 0, JSON.stringify(args.answers), passed ? args.now : null, args.now, existing.id)
      .run()
  } else {
    const id = `prog-${crypto.randomUUID()}`
    await db
      .prepare(
        `INSERT INTO learning_customer_progress (
          id, customer_id, course_id, lesson_id, quiz_score_percent, passed, answers_json, completed_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      )
      .bind(
        id,
        args.customerId,
        lesson.course_id,
        args.lessonId,
        scorePercent,
        passed ? 1 : 0,
        JSON.stringify(args.answers),
        passed ? args.now : null,
        args.now,
        args.now
      )
      .run()
  }

  return { passed, scorePercent }
}

export async function issueInternalCertificate(
  db: D1Database,
  args: { customerId: string; courseId: string; recipientName: string; companyName?: string; now: string }
): Promise<Certificate> {
  const course = await db
    .prepare(`SELECT id, title, passing_score_percent FROM learning_courses WHERE id = ?1`)
    .bind(args.courseId)
    .first<{ id: string; title: string; passing_score_percent: number }>()

  if (!course) throw new LearningCentreError('not_found')

  const existingCert = await db
    .prepare(`SELECT id FROM learning_certificates WHERE customer_id = ?1 AND course_id = ?2`)
    .bind(args.customerId, args.courseId)
    .first<{ id: string }>()

  if (existingCert) throw new LearningCentreError('already_certified')

  // Verify all lessons in course are completed & passed
  const lessons = await db
    .prepare(`SELECT id FROM learning_lessons WHERE course_id = ?1`)
    .bind(args.courseId)
    .all<{ id: string }>()

  const lessonList = lessons.results ?? []
  if (lessonList.length === 0) throw new LearningCentreError('course_incomplete')

  const progress = await db
    .prepare(
      `SELECT lesson_id, quiz_score_percent, passed
       FROM learning_customer_progress WHERE customer_id = ?1 AND course_id = ?2`
    )
    .bind(args.customerId, args.courseId)
    .all<{ lesson_id: string; quiz_score_percent: number; passed: number }>()

  const progMap = new Map((progress.results ?? []).map((p) => [p.lesson_id, p]))

  let totalScore = 0
  for (const l of lessonList) {
    const p = progMap.get(l.id)
    if (!p || p.passed !== 1) {
      throw new LearningCentreError('course_incomplete')
    }
    totalScore += p.quiz_score_percent ?? 0
  }

  const finalScorePercent = Math.round(totalScore / lessonList.length)
  const certCode = generateCertificateCode()
  const verificationHash = generateVerificationHash({
    certificateCode: certCode,
    customerId: args.customerId,
    courseId: args.courseId,
    issuedAt: args.now
  })

  const certId = `cert-${crypto.randomUUID()}`
  await db
    .prepare(
      `INSERT INTO learning_certificates (
        id, certificate_code, customer_id, course_id, recipient_name, company_name,
        course_title, final_score_percent, is_official_accreditation, legal_disclaimer,
        verification_hash, issued_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?11)`
    )
    .bind(
      certId,
      certCode,
      args.customerId,
      args.courseId,
      args.recipientName,
      args.companyName ?? null,
      course.title,
      finalScorePercent,
      LEGAL_NON_OFFICIAL_ACCREDITATION_DISCLAIMER,
      verificationHash,
      args.now
    )
    .run()

  return {
    id: certId,
    certificateCode: certCode,
    customerId: args.customerId,
    courseId: args.courseId,
    recipientName: args.recipientName,
    companyName: args.companyName ?? null,
    courseTitle: course.title,
    finalScorePercent,
    isOfficialAccreditation: false,
    legalDisclaimer: LEGAL_NON_OFFICIAL_ACCREDITATION_DISCLAIMER,
    verificationHash,
    issuedAt: args.now
  }
}

export async function getLearningCertificateByCode(
  db: D1Database,
  certificateCode: string
): Promise<Certificate | null> {
  const row = await db
    .prepare(
      `SELECT id, certificate_code, customer_id, course_id, recipient_name, company_name,
              course_title, final_score_percent, is_official_accreditation, legal_disclaimer,
              verification_hash, issued_at
       FROM learning_certificates WHERE certificate_code = ?1`
    )
    .bind(certificateCode)
    .first<{
      id: string
      certificate_code: string
      customer_id: string
      course_id: string
      recipient_name: string
      company_name: string | null
      course_title: string
      final_score_percent: number
      is_official_accreditation: number
      legal_disclaimer: string
      verification_hash: string
      issued_at: string
    }>()

  if (!row) return null

  return {
    id: row.id,
    certificateCode: row.certificate_code,
    customerId: row.customer_id,
    courseId: row.course_id,
    recipientName: row.recipient_name,
    companyName: row.company_name,
    courseTitle: row.course_title,
    finalScorePercent: row.final_score_percent,
    isOfficialAccreditation: false,
    legalDisclaimer: row.legal_disclaimer,
    verificationHash: row.verification_hash,
    issuedAt: row.issued_at
  }
}
