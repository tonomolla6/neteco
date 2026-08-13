import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

interface CoverageExclusion {
  pattern: string
  reason: string
  owner: string
  reviewedBy: string
  reviewedOn: string
  expiresOn: string
}

interface CoveragePolicy {
  schemaVersion: number
  owner: string
  reviewedBy: string
  reviewedOn: string
  nextReviewOn: string
  include: string[]
  thresholds: {
    perFile: boolean
    lines: number
    functions: number
    statements: number
    branches: number
  }
  exclusions: CoverageExclusion[]
}

const policyPath = resolve('docs/testing/coverage-policy.json')

function requiredText(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
}

function dateOnly(value: unknown, field: string) {
  requiredText(value, field)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value as string) || Number.isNaN(Date.parse(`${value as string}T00:00:00Z`))) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date`)
  }
}

export function validateCoveragePolicy(value: unknown, today = new Date()): asserts value is CoveragePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('coverage policy must be an object')
  const policy = value as Partial<CoveragePolicy>
  if (policy.schemaVersion !== 1) throw new Error('coverage policy schemaVersion must be 1')
  requiredText(policy.owner, 'owner')
  requiredText(policy.reviewedBy, 'reviewedBy')
  dateOnly(policy.reviewedOn, 'reviewedOn')
  dateOnly(policy.nextReviewOn, 'nextReviewOn')
  if (!Array.isArray(policy.include) || policy.include.length === 0) throw new Error('include must not be empty')
  policy.include.forEach((pattern, index) => requiredText(pattern, `include[${index}]`))
  if (new Set(policy.include).size !== policy.include.length) throw new Error('include contains duplicate patterns')

  const thresholds = policy.thresholds
  if (!thresholds || thresholds.perFile !== true) throw new Error('coverage must use perFile thresholds')
  for (const metric of ['lines', 'functions', 'statements', 'branches'] as const) {
    if (thresholds[metric] !== 100) throw new Error(`${metric} coverage threshold must be 100`)
  }

  if (!Array.isArray(policy.exclusions)) throw new Error('exclusions must be an array')
  const todayValue = today.toISOString().slice(0, 10)
  for (const [index, exclusion] of policy.exclusions.entries()) {
    requiredText(exclusion?.pattern, `exclusions[${index}].pattern`)
    requiredText(exclusion?.reason, `exclusions[${index}].reason`)
    requiredText(exclusion?.owner, `exclusions[${index}].owner`)
    requiredText(exclusion?.reviewedBy, `exclusions[${index}].reviewedBy`)
    dateOnly(exclusion?.reviewedOn, `exclusions[${index}].reviewedOn`)
    dateOnly(exclusion?.expiresOn, `exclusions[${index}].expiresOn`)
    if (exclusion.expiresOn < todayValue) throw new Error(`coverage exclusion expired: ${exclusion.pattern}`)
  }
  const patterns = policy.exclusions.map((exclusion) => exclusion.pattern)
  if (new Set(patterns).size !== patterns.length) throw new Error('exclusions contain duplicate patterns')
}

const source = await readFile(policyPath, 'utf8')
const policy = JSON.parse(source) as unknown
validateCoveragePolicy(policy)

if (process.argv.includes('--publish')) {
  const outputPath = resolve('coverage/coverage-policy.json')
  await mkdir(resolve('coverage'), { recursive: true })
  await writeFile(outputPath, source, 'utf8')
}

process.stdout.write(
  `coverage-policy include=${policy.include.length} exclusions=${policy.exclusions.length} thresholds=100 perFile=true${
    process.argv.includes('--publish') ? ' published=coverage/coverage-policy.json' : ''
  }\n`
)
