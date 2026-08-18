import { describe, expect, it } from 'vitest'
import { auditChaosSources, validateChaosPolicy } from '../../scripts/lib/chaos-policy'

const scenarios = ['latency', 'duplicate', 'reordered', 'worker-loss', 'cache-loss', 'external-limit'].map((fault) => ({
  id: fault,
  fault,
  testFile: `tests/integration/${fault}.test.ts`,
  testName: `handles ${fault}`,
  detection: `detect ${fault}`,
  recovery: `recover ${fault}`,
  runbookSection: `Scenario ${fault}`
}))

const policy = {
  schemaVersion: 1,
  requirementId: 'TST-039',
  profile: 'ci-loopback-isolated',
  schedule: { cron: '17 3 * * 1' },
  scenarios
}

describe('scheduled chaos policy', () => {
  it('requires every governed fault and complete deterministic scenario metadata', () => {
    expect(validateChaosPolicy(policy).scenarios).toHaveLength(6)
    expect(() => validateChaosPolicy({ ...policy, scenarios: scenarios.slice(1) })).toThrow(
      'chaos policy is missing faults: latency'
    )
    expect(() => validateChaosPolicy({ ...policy, scenarios: [...scenarios, scenarios[0]] })).toThrow(
      'chaos policy scenario IDs must be unique'
    )
  })

  it('binds every scenario to a real test, runbook section and blocking scheduled workflow', () => {
    const validated = validateChaosPolicy(policy)
    const testSources = Object.fromEntries(scenarios.map((scenario) => [scenario.testFile, scenario.testName]))
    const runbook = scenarios.map((scenario) => `## ${scenario.runbookSection}`).join('\n')
    const workflow = "workflow_dispatch:\n  schedule:\n    - cron: '17 3 * * 1'\n  run: npm run test:chaos\n"
    expect(auditChaosSources(validated, testSources, runbook, workflow)).toEqual([])
    expect(auditChaosSources(validated, {}, '', `${workflow}continue-on-error: true`)).toEqual(
      expect.arrayContaining([
        'missing chaos test file: tests/integration/latency.test.ts',
        'chaos runbook section not found: Scenario latency',
        'chaos workflow must not continue on error'
      ])
    )
  })
})
