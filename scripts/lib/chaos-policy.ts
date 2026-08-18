export const REQUIRED_CHAOS_FAULTS = [
  'latency',
  'duplicate',
  'reordered',
  'worker-loss',
  'cache-loss',
  'external-limit'
] as const

export type ChaosFault = (typeof REQUIRED_CHAOS_FAULTS)[number]

export interface ChaosScenario {
  id: string
  fault: ChaosFault
  testFile: string
  testName: string
  detection: string
  recovery: string
  runbookSection: string
}

export interface ChaosPolicy {
  schemaVersion: 1
  requirementId: 'TST-039'
  profile: 'ci-loopback-isolated'
  schedule: { cron: string }
  scenarios: ChaosScenario[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

export function validateChaosPolicy(value: unknown): ChaosPolicy {
  if (!isRecord(value)) throw new Error('chaos policy must be an object')
  if (value.schemaVersion !== 1) throw new Error('chaos policy schemaVersion must be 1')
  if (value.requirementId !== 'TST-039') throw new Error('chaos policy requirementId must be TST-039')
  if (value.profile !== 'ci-loopback-isolated') throw new Error('chaos policy must use the isolated loopback profile')
  if (!isRecord(value.schedule)) throw new Error('chaos policy schedule must be an object')
  const cron = text(value.schedule.cron, 'schedule.cron')
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) {
    throw new Error('chaos policy scenarios must be a non-empty array')
  }
  const scenarios = value.scenarios.map((entry, index): ChaosScenario => {
    const field = `scenarios[${index}]`
    if (!isRecord(entry)) throw new Error(`${field} must be an object`)
    const fault = text(entry.fault, `${field}.fault`)
    if (!REQUIRED_CHAOS_FAULTS.includes(fault as ChaosFault)) throw new Error(`${field}.fault is not supported`)
    const testFile = text(entry.testFile, `${field}.testFile`)
    if (!/^tests\/integration\/[a-z0-9-]+\.test\.ts$/.test(testFile)) {
      throw new Error(`${field}.testFile must be a governed integration Vitest file`)
    }
    return {
      id: text(entry.id, `${field}.id`),
      fault: fault as ChaosFault,
      testFile,
      testName: text(entry.testName, `${field}.testName`),
      detection: text(entry.detection, `${field}.detection`),
      recovery: text(entry.recovery, `${field}.recovery`),
      runbookSection: text(entry.runbookSection, `${field}.runbookSection`)
    }
  })
  const ids = scenarios.map(({ id }) => id)
  if (new Set(ids).size !== ids.length) throw new Error('chaos policy scenario IDs must be unique')
  const faults = new Set(scenarios.map(({ fault }) => fault))
  const missingFaults = REQUIRED_CHAOS_FAULTS.filter((fault) => !faults.has(fault))
  if (missingFaults.length) throw new Error(`chaos policy is missing faults: ${missingFaults.join(', ')}`)
  return { schemaVersion: 1, requirementId: 'TST-039', profile: 'ci-loopback-isolated', schedule: { cron }, scenarios }
}

export function auditChaosSources(
  policy: ChaosPolicy,
  testSources: Record<string, string>,
  runbookSource: string,
  workflowSource: string
): string[] {
  const problems: string[] = []
  for (const scenario of policy.scenarios) {
    const source = testSources[scenario.testFile]
    if (source === undefined) problems.push(`missing chaos test file: ${scenario.testFile}`)
    else if (!source.includes(scenario.testName)) {
      problems.push(`chaos test name not found in ${scenario.testFile}: ${scenario.testName}`)
    }
    if (!runbookSource.includes(`## ${scenario.runbookSection}`)) {
      problems.push(`chaos runbook section not found: ${scenario.runbookSection}`)
    }
  }
  if (!workflowSource.includes('workflow_dispatch:')) problems.push('chaos workflow is not manually dispatchable')
  if (!workflowSource.includes(`- cron: '${policy.schedule.cron}'`))
    problems.push('chaos workflow schedule differs from policy')
  if (!workflowSource.includes('npm run test:chaos')) problems.push('chaos workflow does not run the governed command')
  if (workflowSource.includes('continue-on-error')) problems.push('chaos workflow must not continue on error')
  return problems
}
