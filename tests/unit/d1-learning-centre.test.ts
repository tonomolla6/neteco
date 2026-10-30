import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLearningCourseAdmin,
  createLearningLessonAdmin,
  getCourseWithProgress,
  getLearningCertificateByCode,
  issueInternalCertificate,
  submitLessonQuiz,
  LearningCentreError
} from '../../workers/learning/learning-centre'
import {
  ADMIN_IDENTITY,
  CUSTOMER_IDENTITY_1,
  NOW,
  OTHER_IDENTITY,
  PROD_1,
  PROD_2,
  createLearningCampaignsWorld,
  type LearningCampaignsWorld
} from './learning-campaigns-fixture'

let world: LearningCampaignsWorld
beforeEach(async () => {
  world = await createLearningCampaignsWorld()
})
afterEach(() => world.close())

const code = (e: unknown) => (e instanceof LearningCentreError ? e.code : `unknown:${String(e)}`)
const fails = (p: Promise<unknown>) => p.then(() => 'resolved', code)

describe('MKT-033: D1 Learning Centre & Certificates', () => {
  const sampleCourse = {
    title: 'Manejo Seguro de Químicos y FDS en Lavandería Industrial',
    slug: 'manejo-seguro-quimicos-lavanderia',
    description: 'Protocolos de seguridad, dosificación y lectura de fichas de seguridad.',
    category: 'chemical_safety' as const,
    targetSector: 'lavanderia_industrial' as const,
    estimatedDurationMinutes: 60,
    passingScorePercent: 80
  }

  const sampleLesson = {
    sortOrder: 1,
    slug: 'leccion-1-lectura-fds',
    title: 'Lección 1: Fichas de Datos de Seguridad y EPIs',
    summary: 'Aprende a interpretar los pictogramas y frases H/P de peligro químico.',
    contentMarkdown: '# Interpretación de FDS\nSección 8 y EPIs obligatorios para peróxidos y álcalis.',
    linkedProductIds: [PROD_1, PROD_2],
    supportTopic: 'Seguridad Química y Protocolos',
    supportActionLabel: 'Contactar Soporte Técnico Químico',
    supportActionUrl: '/soporte/contacto-tecnico?tema=quimica',
    quizQuestions: [
      {
        id: 'q1',
        question: '¿Qué guantes se recomiendan para productos cáusticos?',
        options: [
          { id: 'opt-a', text: 'Nitrilo de alto gramaje o neopreno resistente' },
          { id: 'opt-b', text: 'Guantes de látex doméstico fino' }
        ],
        correctOptionId: 'opt-a',
        explanation: 'El látex común se degrada rápidamente con álcalis fuertes.'
      }
    ]
  }

  it('allows live admin to create a course and lessons, but forbids non-admin users', async () => {
    // Non-admin attempt fails
    expect(
      await fails(
        createLearningCourseAdmin(world.db, {
          actorId: OTHER_IDENTITY,
          input: sampleCourse,
          now: NOW
        })
      )
    ).toBe('forbidden')

    // Live admin succeeds
    const course = await createLearningCourseAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: sampleCourse,
      now: NOW
    })
    expect(course.id).toBeDefined()
    expect(course.slug).toBe(sampleCourse.slug)
    expect(course.version).toBe(1)

    // Admin adds a lesson with linked products and support action
    const lesson = await createLearningLessonAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: { ...sampleLesson, courseId: course.id },
      now: NOW
    })
    expect(lesson.id).toBeDefined()
    expect(lesson.linkedProductIds).toEqual([PROD_1, PROD_2])
    expect(lesson.supportActionLabel).toBe('Contactar Soporte Técnico Químico')
  })

  it('prevents duplicate course slugs or duplicate lesson sort orders', async () => {
    const course = await createLearningCourseAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: sampleCourse,
      now: NOW
    })

    // Duplicate course slug
    expect(
      await fails(
        createLearningCourseAdmin(world.db, {
          actorId: ADMIN_IDENTITY,
          input: sampleCourse,
          now: NOW
        })
      )
    ).toBe('slug_conflict')

    await createLearningLessonAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: { ...sampleLesson, courseId: course.id },
      now: NOW
    })

    // Duplicate lesson order
    expect(
      await fails(
        createLearningLessonAdmin(world.db, {
          actorId: ADMIN_IDENTITY,
          input: { ...sampleLesson, courseId: course.id, slug: 'leccion-otra' },
          now: NOW
        })
      )
    ).toBe('duplicate_lesson_order')
  })

  it('tracks customer progress, evaluates quiz submission, and handles pass/fail states', async () => {
    const course = await createLearningCourseAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: sampleCourse,
      now: NOW
    })
    const lesson = await createLearningLessonAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: { ...sampleLesson, courseId: course.id },
      now: NOW
    })

    // Customer submits incorrect answer -> failing score
    const failResult = await submitLessonQuiz(world.db, {
      customerId: CUSTOMER_IDENTITY_1,
      lessonId: lesson.id,
      answers: { q1: 'opt-b' },
      now: NOW
    })
    expect(failResult.passed).toBe(false)
    expect(failResult.scorePercent).toBe(0)

    // Check course progress
    let courseWithProgress = await getCourseWithProgress(world.db, course.slug, CUSTOMER_IDENTITY_1)
    expect(courseWithProgress.lessons[0].progress?.passed).toBe(false)
    expect(courseWithProgress.lessons[0].progress?.quizScorePercent).toBe(0)

    // Customer re-submits with correct answer -> passing score
    const passResult = await submitLessonQuiz(world.db, {
      customerId: CUSTOMER_IDENTITY_1,
      lessonId: lesson.id,
      answers: { q1: 'opt-a' },
      now: NOW
    })
    expect(passResult.passed).toBe(true)
    expect(passResult.scorePercent).toBe(100)

    courseWithProgress = await getCourseWithProgress(world.db, course.slug, CUSTOMER_IDENTITY_1)
    expect(courseWithProgress.lessons[0].progress?.passed).toBe(true)
    expect(courseWithProgress.lessons[0].progress?.quizScorePercent).toBe(100)
  })

  it('issues an internal certificate only when all lessons are passed, enforcing non-official disclaimer', async () => {
    const course = await createLearningCourseAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: sampleCourse,
      now: NOW
    })
    const lesson1 = await createLearningLessonAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: { ...sampleLesson, courseId: course.id, sortOrder: 1, slug: 'leccion-1' },
      now: NOW
    })
    const lesson2 = await createLearningLessonAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: {
        ...sampleLesson,
        courseId: course.id,
        sortOrder: 2,
        slug: 'leccion-2',
        title: 'Lección 2: Neutralización de Vertidos'
      },
      now: NOW
    })

    // Attempting certificate before completing lessons fails
    expect(
      await fails(
        issueInternalCertificate(world.db, {
          customerId: CUSTOMER_IDENTITY_1,
          courseId: course.id,
          recipientName: 'Elena Gómez Navarro',
          companyName: 'Lavanderías Turia S.L.',
          now: NOW
        })
      )
    ).toBe('course_incomplete')

    // Pass lesson 1
    await submitLessonQuiz(world.db, {
      customerId: CUSTOMER_IDENTITY_1,
      lessonId: lesson1.id,
      answers: { q1: 'opt-a' },
      now: NOW
    })

    // Still incomplete
    expect(
      await fails(
        issueInternalCertificate(world.db, {
          customerId: CUSTOMER_IDENTITY_1,
          courseId: course.id,
          recipientName: 'Elena Gómez Navarro',
          companyName: 'Lavanderías Turia S.L.',
          now: NOW
        })
      )
    ).toBe('course_incomplete')

    // Pass lesson 2
    await submitLessonQuiz(world.db, {
      customerId: CUSTOMER_IDENTITY_1,
      lessonId: lesson2.id,
      answers: { q1: 'opt-a' },
      now: NOW
    })

    // Issue certificate now succeeds!
    const cert = await issueInternalCertificate(world.db, {
      customerId: CUSTOMER_IDENTITY_1,
      courseId: course.id,
      recipientName: 'Elena Gómez Navarro',
      companyName: 'Lavanderías Turia S.L.',
      now: NOW
    })

    expect(cert.certificateCode).toMatch(/^CERT-NET-/)
    expect(cert.isOfficialAccreditation).toBe(false) // STRICT: never promises official accreditation
    expect(cert.legalDisclaimer).toContain('sin valor de titulación oficial')
    expect(cert.finalScorePercent).toBe(100)
    expect(cert.verificationHash).toHaveLength(64)

    // Verify retrieval by certificate code
    const retrieved = await getLearningCertificateByCode(world.db, cert.certificateCode)
    expect(retrieved?.recipientName).toBe('Elena Gómez Navarro')
    expect(retrieved?.isOfficialAccreditation).toBe(false)

    // Cannot issue duplicate certificate for same course/customer
    expect(
      await fails(
        issueInternalCertificate(world.db, {
          customerId: CUSTOMER_IDENTITY_1,
          courseId: course.id,
          recipientName: 'Elena Gómez Navarro',
          companyName: 'Lavanderías Turia S.L.',
          now: NOW
        })
      )
    ).toBe('already_certified')
  })
})
