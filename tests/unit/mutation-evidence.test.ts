import { describe, expect, it } from 'vitest'
import {
  auditMutationEvidence,
  auditMutationConfiguration,
  auditMutationReportScope,
  calculateMutationScore,
  extractMutations,
  validateMutationPolicy,
  type Mutation,
  type MutationPolicy
} from '../../scripts/lib/mutation-evidence'

const policy: MutationPolicy = {
  schemaVersion: 1,
  requirementId: 'TST-037',
  minimumScore: 90,
  targetScore: 95,
  owner: 'QA',
  reviewedAt: '2026-08-18T00:00:00Z',
  scope: {
    include: ['server/domain/**/*.ts', 'server/integrations/**/*.ts'],
    typeOnlyExclusions: [
      {
        file: 'server/integrations/payment-provider.ts',
        reason: 'Types only.',
        owner: 'QA',
        reviewedAt: '2026-08-18T00:00:00Z'
      }
    ]
  },
  reviews: []
}

function mutation(id: string, status: string, overrides: Partial<Mutation> = {}): Mutation {
  return {
    id,
    file: 'server/domain/money.ts',
    status,
    mutatorName: 'ConditionalExpression',
    replacement: 'false',
    ...overrides
  }
}

function report(mutations: Mutation[]) {
  const files: Record<string, Mutation[]> = {}
  for (const item of mutations) files[item.file] = [...(files[item.file] ?? []), item]
  return {
    files: Object.fromEntries(
      Object.entries(files).map(([file, fileMutations]) => [
        file,
        {
          mutants: fileMutations?.map((item) => ({
            ...item,
            location: item.location ? { start: item.location } : undefined
          }))
        }
      ])
    )
  }
}

describe('mutation evidence governance', () => {
  it('uses Killed plus Timeout in the numerator and excludes errors from the denominator', () => {
    expect(
      calculateMutationScore([
        mutation('killed', 'Killed'),
        mutation('timeout', 'Timeout'),
        mutation('survived', 'Survived'),
        mutation('uncovered', 'NoCoverage'),
        mutation('compile', 'CompileError'),
        mutation('runtime', 'RuntimeError')
      ])
    ).toEqual({
      killed: 1,
      timeout: 1,
      survived: 1,
      noCoverage: 1,
      denominator: 4,
      numerator: 2,
      percentage: 50,
      excluded: 2
    })
  })

  it('requires every Survived and Timeout mutant to have an explicit review', () => {
    const result = auditMutationEvidence(
      report([mutation('killed', 'Killed'), mutation('survived', 'Survived')]),
      policy
    )
    expect(result.passed).toBe(false)
    expect(result.unreviewed.map(({ id }) => id)).toEqual(['survived'])
    expect(result.problems).toContain('unreviewed Survived/Timeout mutants: survived')
  })

  it('accepts exact mutant IDs and constrained rules, while rejecting unmatched reviews', () => {
    const result = auditMutationEvidence(
      report([
        ...Array.from({ length: 18 }, (_, index) => mutation(`killed-${index}`, 'Killed')),
        mutation('survived-id', 'Survived'),
        mutation('timeout-rule', 'Timeout', {
          file: 'server/domain/shipping.ts',
          mutatorName: 'EqualityOperator',
          replacement: 'false',
          location: { line: 10, column: 4 }
        })
      ]),
      {
        ...policy,
        reviews: [
          {
            selector: { mutantId: 'survived-id' },
            owner: 'QA',
            reviewedAt: '2026-08-18T00:00:00Z',
            rationale: 'The assertion covers the intended branch.',
            disposition: 'equivalent-mutant'
          },
          {
            selector: {
              rule: {
                file: 'server/domain/shipping.ts',
                status: 'Timeout',
                mutatorName: 'EqualityOperator',
                replacement: 'false',
                expectedMatches: 1,
                expectedLocations: ['10:4'],
                line: 10,
                column: 4
              }
            },
            owner: 'QA',
            reviewedAt: '2026-08-18T00:00:00Z',
            rationale: 'The timeout is bounded and has an equivalent execution path.',
            disposition: 'accepted-risk'
          }
        ]
      }
    )
    expect(result.passed).toBe(true)
    expect(result.unmatchedReviews).toEqual([])

    const unmatched = auditMutationEvidence(report([mutation('survived-id', 'Survived')]), {
      ...policy,
      reviews: [
        {
          selector: { mutantId: 'not-in-report' },
          owner: 'QA',
          reviewedAt: '2026-08-18T00:00:00Z',
          rationale: 'Review is intentionally invalid for this fixture.',
          disposition: 'test-gap'
        }
      ]
    })
    expect(unmatched.unmatchedReviews).toEqual([0])
    expect(unmatched.passed).toBe(false)
  })

  it('rejects a policy without a complete review selector and review metadata', () => {
    expect(() => validateMutationPolicy({ ...policy, reviews: [{ selector: { mutantId: 'm1' } }] })).toThrow(
      'reviews[0].owner must be a non-empty string'
    )
    expect(() =>
      validateMutationPolicy({
        ...policy,
        reviews: [
          {
            selector: { rule: { file: 'server/domain/money.ts', status: 'Survived' } },
            owner: 'QA',
            reviewedAt: '2026-08-18T00:00:00Z',
            rationale: 'incomplete',
            disposition: 'accepted-risk'
          }
        ]
      })
    ).toThrow('reviews[0].selector.rule.mutatorName must be a non-empty string')
    expect(() => validateMutationPolicy({ ...policy, minimumScore: 89 })).toThrow(
      'mutation policy minimumScore must be between 90 and 100'
    )
  })

  it('rejects duplicate mutant IDs because an ID selector must be unambiguous', () => {
    expect(() =>
      extractMutations(report([mutation('duplicate', 'Killed'), mutation('duplicate', 'Survived')]))
    ).toThrow('mutation report contains duplicate mutant id: duplicate')
  })

  it('rejects unknown or incomplete Stryker statuses instead of excluding them from the score', () => {
    expect(() => extractMutations(report([mutation('pending', 'Pending')]))).toThrow(
      'status is not a supported final Stryker status: Pending'
    )
  })

  it('requires the mutation report to contain exactly the governed source files', () => {
    const scopedReport = report([
      mutation('domain', 'Killed'),
      mutation('integration', 'Killed', { file: 'server/integrations/redsys.ts' })
    ])
    expect(auditMutationReportScope(scopedReport, ['server/domain/money.ts', 'server/integrations/redsys.ts'])).toEqual(
      []
    )
    expect(auditMutationReportScope(scopedReport, ['server/domain/money.ts', 'server/domain/shipping.ts'])).toEqual([
      'mutation report is missing scoped files: server/domain/shipping.ts',
      'mutation report contains files outside scope: server/integrations/redsys.ts'
    ])
  })

  it('invalidates a rule when a matching mutant moves to a different source location', () => {
    const moved = auditMutationEvidence(
      report([
        ...Array.from({ length: 9 }, (_, index) => mutation(`killed-${index}`, 'Killed')),
        mutation('moved', 'Survived', { location: { line: 11, column: 4 } })
      ]),
      {
        ...policy,
        reviews: [
          {
            selector: {
              rule: {
                file: 'server/domain/money.ts',
                status: 'Survived',
                mutatorName: 'ConditionalExpression',
                replacement: 'false',
                expectedMatches: 1,
                expectedLocations: ['10:4']
              }
            },
            owner: 'QA',
            reviewedAt: '2026-08-18T00:00:00Z',
            rationale: 'The prior review belongs to the prior location.',
            disposition: 'test-gap'
          }
        ]
      }
    )
    expect(moved.passed).toBe(false)
    expect(moved.mismatchedReviewLocations).toEqual([{ reviewIndex: 0, expected: ['10:4'], actual: ['11:4'] }])
  })

  it('locks Stryker scope and permits exclusions only while they remain type-only', () => {
    const config = {
      mutate: ['server/domain/**/*.ts', 'server/integrations/**/*.ts', '!server/integrations/payment-provider.ts'],
      thresholds: { high: 95, low: 90, break: 90 },
      incremental: false,
      disableTypeChecks: false,
      reporters: ['json'],
      checkers: ['typescript']
    }
    expect(
      auditMutationConfiguration(config, policy, {
        'server/integrations/payment-provider.ts': 'export interface PaymentProvider { readonly name: string }'
      })
    ).toEqual([])
    expect(
      auditMutationConfiguration(config, policy, {
        'server/integrations/payment-provider.ts': 'export const unsafeRuntimeLogic = true'
      })
    ).toContain('excluded file contains runtime logic: server/integrations/payment-provider.ts')
  })
})
