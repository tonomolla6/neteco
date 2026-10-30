import { describe, expect, it } from 'vitest'
import {
  calculateQuizScore,
  createCourseSchema,
  createLessonSchema,
  generateCertificateCode,
  generateVerificationHash,
  verifyCertificateEligibility,
  LEGAL_NON_OFFICIAL_ACCREDITATION_DISCLAIMER,
  type QuizQuestion
} from '../../shared/learning-centre'

describe('MKT-033: Learning Centre & Internal Certificates (Domain Logic)', () => {
  const sampleQuestions: QuizQuestion[] = [
    {
      id: 'q1',
      question: '¿Cuál es el EPI obligatorio para manipular limpiadores alcalinos concentrados?',
      options: [
        { id: 'opt-a', text: 'Guantes de nitrilo y gafas panorámicas de protección química' },
        { id: 'opt-b', text: 'Solo mascarilla antipolvo FFP1' },
        { id: 'opt-c', text: 'No se requiere protección si la habitación está ventilada' }
      ],
      correctOptionId: 'opt-a',
      explanation: 'Los productos fuertemente alcalinos causan quemaduras químicas; nitrilo y gafas son obligatorios.'
    },
    {
      id: 'q2',
      question: '¿Dónde se localiza el tiempo de actuación y dilución recomendada de un desinfectante?',
      options: [
        { id: 'opt-a', text: 'En la ficha de datos de seguridad (FDS) y etiqueta técnica' },
        { id: 'opt-b', text: 'En el albarán de transporte' },
        { id: 'opt-c', text: 'En la factura comercial' }
      ],
      correctOptionId: 'opt-a',
      explanation: 'La FDS y la etiqueta técnica especifican dosis y tiempos de contacto según norma UNE-EN.'
    }
  ]

  it('validates course creation schema with valid inputs', () => {
    const valid = {
      title: 'Seguridad Química y Protocolos FDS en Lavandería Industrial',
      slug: 'seguridad-quimica-lavanderia',
      description: 'Curso práctico sobre manipulación segura de tensioactivos, álcalis y peróxidos.',
      category: 'chemical_safety',
      targetSector: 'lavanderia_industrial',
      estimatedDurationMinutes: 45,
      passingScorePercent: 80
    }
    const parsed = createCourseSchema.safeParse(valid)
    expect(parsed.success).toBe(true)
  })

  it('rejects course creation with invalid slug, empty title, or out-of-range passing score', () => {
    expect(
      createCourseSchema.safeParse({
        title: '',
        slug: 'INVALID_SLUG_WITH_CAPS!',
        description: 'Demasiado corto',
        category: 'chemical_safety',
        estimatedDurationMinutes: 2,
        passingScorePercent: 120
      }).success
    ).toBe(false)
  })

  it('validates lesson creation schema requiring product links and support resources', () => {
    const validLesson = {
      courseId: 'course-1',
      sortOrder: 1,
      slug: 'interpretacion-fds-epis',
      title: 'Interpretación de Fichas de Datos de Seguridad (FDS) y Selección de EPIs',
      summary: 'Aprende a interpretar los pictogramas SGA y frases H/P de peligro químico.',
      contentMarkdown: '# Manejo Seguro\nConsulte siempre la sección 8 de la FDS antes del trasvase.',
      linkedProductIds: ['prod-detergente-alcalino', 'prod-oxigeno-activo'],
      supportTopic: 'Seguridad Química y Asesoramiento Técnico',
      supportActionLabel: 'Consultar con el Dpto. Técnico de Neteco',
      supportActionUrl: '/soporte/contacto-tecnico?asunto=seguridad-quimica',
      quizQuestions: sampleQuestions
    }
    const res = createLessonSchema.safeParse(validLesson)
    expect(res.success).toBe(true)
  })

  it('calculates quiz scores correctly (100%, 50%, 0%)', () => {
    // 2/2 correct -> 100%
    const score100 = calculateQuizScore(sampleQuestions, { q1: 'opt-a', q2: 'opt-a' })
    expect(score100.scorePercent).toBe(100)
    expect(score100.passed).toBe(true)
    expect(score100.correctCount).toBe(2)

    // 1/2 correct -> 50%
    const score50 = calculateQuizScore(sampleQuestions, { q1: 'opt-a', q2: 'opt-b' })
    expect(score50.scorePercent).toBe(50)
    expect(score50.passed).toBe(false)
    expect(score50.correctCount).toBe(1)

    // 0/2 correct -> 0%
    const score0 = calculateQuizScore(sampleQuestions, { q1: 'opt-b', q2: 'opt-c' })
    expect(score0.scorePercent).toBe(0)
    expect(score0.passed).toBe(false)
  })

  it('generates unique certificate code and SHA-256 verification hash with non-official disclaimer', () => {
    const code = generateCertificateCode()
    expect(code).toMatch(/^CERT-NET-[A-Z0-9]{8,12}$/)

    const hash = generateVerificationHash({
      certificateCode: code,
      customerId: 'cust-123',
      courseId: 'course-seguridad',
      issuedAt: '2026-10-29T12:00:00Z'
    })
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)

    expect(LEGAL_NON_OFFICIAL_ACCREDITATION_DISCLAIMER).toContain('sin valor de titulación oficial')
    expect(LEGAL_NON_OFFICIAL_ACCREDITATION_DISCLAIMER).toContain('aprovechamiento interno')
  })

  it('evaluates certificate eligibility strictly checking that all lessons are passed', () => {
    const lessons = [
      { id: 'l1', title: 'Lección 1' },
      { id: 'l2', title: 'Lección 2' }
    ]

    // Incomplete: only l1 passed
    expect(verifyCertificateEligibility(lessons, [{ lessonId: 'l1', passed: true, scorePercent: 100 }]).eligible).toBe(
      false
    )

    // Incomplete: l2 failed
    expect(
      verifyCertificateEligibility(lessons, [
        { lessonId: 'l1', passed: true, scorePercent: 100 },
        { lessonId: 'l2', passed: false, scorePercent: 40 }
      ]).eligible
    ).toBe(false)

    // Complete: all passed
    const eligibleRes = verifyCertificateEligibility(lessons, [
      { lessonId: 'l1', passed: true, scorePercent: 100 },
      { lessonId: 'l2', passed: true, scorePercent: 80 }
    ])
    expect(eligibleRes.eligible).toBe(true)
    expect(eligibleRes.averageScore).toBe(90)
  })
})
