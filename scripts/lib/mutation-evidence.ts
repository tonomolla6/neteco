import { readFile } from 'node:fs/promises'
import ts from 'typescript'

export const REVIEWABLE_MUTATION_STATUSES = ['Survived', 'Timeout'] as const
const FINAL_MUTATION_STATUSES = ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError'] as const
const REVIEW_DISPOSITIONS = ['fix-required', 'accepted-risk', 'equivalent-mutant', 'test-gap'] as const

export type ReviewableMutationStatus = (typeof REVIEWABLE_MUTATION_STATUSES)[number]
export type MutationReviewDisposition = (typeof REVIEW_DISPOSITIONS)[number]

export interface MutationLocation {
  line: number
  column: number
}

export interface Mutation {
  id: string
  file: string
  status: string
  mutatorName: string
  replacement: string
  location?: MutationLocation
}

export interface MutationReport {
  files: unknown
}

export interface MutationReviewRule {
  file: string
  status: ReviewableMutationStatus
  mutatorName: string
  replacement: string
  expectedMatches: number
  expectedLocations: string[]
  line?: number
  column?: number
}

export type MutationReviewSelector = { mutantId: string } | { rule: MutationReviewRule }

export interface MutationReview {
  selector: MutationReviewSelector
  owner: string
  reviewedAt: string
  rationale: string
  disposition: MutationReviewDisposition
}

export interface MutationPolicy {
  schemaVersion: 1
  requirementId: 'TST-037'
  minimumScore: number
  targetScore: number
  owner: string
  reviewedAt: string
  scope: MutationScope
  reviews: MutationReview[]
}

export interface TypeOnlyExclusion {
  file: string
  reason: string
  owner: string
  reviewedAt: string
}

export interface MutationScope {
  include: string[]
  typeOnlyExclusions: TypeOnlyExclusion[]
}

export interface MutationScore {
  killed: number
  timeout: number
  survived: number
  noCoverage: number
  denominator: number
  numerator: number
  percentage: number
  excluded: number
}

export interface MutationAuditResult {
  score: MutationScore
  reviewable: Mutation[]
  unreviewed: Mutation[]
  unmatchedReviews: number[]
  mismatchedReviewCounts: Array<{ reviewIndex: number; expected: number; actual: number }>
  mismatchedReviewLocations: Array<{ reviewIndex: number; expected: string[]; actual: string[] }>
  overlappingReviews: Array<{ mutantId: string; reviewIndexes: number[] }>
  problems: string[]
  passed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

function requiredDate(value: unknown, field: string): string {
  const text = requiredText(value, field)
  if (Number.isNaN(Date.parse(text))) throw new Error(`${field} must be an ISO-8601 date-time`)
  return text
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`)
  }
  return value
}

function requiredLocations(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`)
  const locations = value.map((entry, index) => {
    const location = requiredText(entry, `${field}[${index}]`)
    if (!/^\d+:\d+$/.test(location)) throw new Error(`${field}[${index}] must use line:column format`)
    return location
  })
  return locations.sort()
}

function parseRule(value: unknown, field: string): MutationReviewRule {
  if (!isRecord(value)) throw new Error(`${field} must be an object`)
  const status = requiredText(value.status, `${field}.status`)
  if (!REVIEWABLE_MUTATION_STATUSES.includes(status as ReviewableMutationStatus)) {
    throw new Error(`${field}.status must be Survived or Timeout`)
  }
  const rule: MutationReviewRule = {
    file: requiredText(value.file, `${field}.file`),
    status: status as ReviewableMutationStatus,
    mutatorName: requiredText(value.mutatorName, `${field}.mutatorName`),
    replacement: requiredString(value.replacement, `${field}.replacement`),
    expectedMatches: requiredPositiveInteger(value.expectedMatches, `${field}.expectedMatches`),
    expectedLocations: requiredLocations(value.expectedLocations, `${field}.expectedLocations`)
  }
  if (rule.expectedLocations.length !== rule.expectedMatches) {
    throw new Error(`${field}.expectedLocations must contain expectedMatches entries`)
  }
  if (value.line !== undefined) rule.line = requiredPositiveInteger(value.line, `${field}.line`)
  if (value.column !== undefined) rule.column = requiredPositiveInteger(value.column, `${field}.column`)
  return rule
}

function parseReview(value: unknown, index: number): MutationReview {
  const field = `reviews[${index}]`
  if (!isRecord(value)) throw new Error(`${field} must be an object`)
  if (!isRecord(value.selector)) throw new Error(`${field}.selector must be an object`)

  const selectorKeys = Object.keys(value.selector)
  if (selectorKeys.length !== 1 || (!selectorKeys.includes('mutantId') && !selectorKeys.includes('rule'))) {
    throw new Error(`${field}.selector must contain exactly one mutantId or rule`)
  }

  const owner = requiredText(value.owner, `${field}.owner`)
  const reviewedAt = requiredDate(value.reviewedAt, `${field}.reviewedAt`)
  const rationale = requiredText(value.rationale, `${field}.rationale`)

  const selector: MutationReviewSelector =
    value.selector.mutantId !== undefined
      ? { mutantId: requiredText(value.selector.mutantId, `${field}.selector.mutantId`) }
      : { rule: parseRule(value.selector.rule, `${field}.selector.rule`) }

  const disposition = requiredText(value.disposition, `${field}.disposition`)
  if (!REVIEW_DISPOSITIONS.includes(disposition as MutationReviewDisposition)) {
    throw new Error(`${field}.disposition is not supported`)
  }

  return {
    selector,
    owner,
    reviewedAt,
    rationale,
    disposition: disposition as MutationReviewDisposition
  }
}

function parseScope(value: unknown): MutationScope {
  if (!isRecord(value)) throw new Error('scope must be an object')
  if (!Array.isArray(value.include) || value.include.length === 0) {
    throw new Error('scope.include must be a non-empty array')
  }
  const include = value.include.map((entry, index) => requiredText(entry, `scope.include[${index}]`))
  if (new Set(include).size !== include.length) throw new Error('scope.include contains duplicates')
  if (!Array.isArray(value.typeOnlyExclusions)) throw new Error('scope.typeOnlyExclusions must be an array')
  const typeOnlyExclusions = value.typeOnlyExclusions.map((entry, index) => {
    const field = `scope.typeOnlyExclusions[${index}]`
    if (!isRecord(entry)) throw new Error(`${field} must be an object`)
    return {
      file: requiredText(entry.file, `${field}.file`),
      reason: requiredText(entry.reason, `${field}.reason`),
      owner: requiredText(entry.owner, `${field}.owner`),
      reviewedAt: requiredDate(entry.reviewedAt, `${field}.reviewedAt`)
    }
  })
  if (new Set(typeOnlyExclusions.map(({ file }) => file)).size !== typeOnlyExclusions.length) {
    throw new Error('scope.typeOnlyExclusions contains duplicate files')
  }
  return { include, typeOnlyExclusions }
}

export function validateMutationPolicy(value: unknown): MutationPolicy {
  if (!isRecord(value)) throw new Error('mutation policy must be an object')
  if (value.schemaVersion !== 1) throw new Error('mutation policy schemaVersion must be 1')
  if (value.requirementId !== 'TST-037') throw new Error('mutation policy requirementId must be TST-037')
  if (
    typeof value.minimumScore !== 'number' ||
    !Number.isFinite(value.minimumScore) ||
    value.minimumScore < 90 ||
    value.minimumScore > 100
  ) {
    throw new Error('mutation policy minimumScore must be between 90 and 100')
  }
  if (
    typeof value.targetScore !== 'number' ||
    !Number.isFinite(value.targetScore) ||
    value.targetScore < 95 ||
    value.targetScore > 100 ||
    value.targetScore < value.minimumScore
  ) {
    throw new Error('mutation policy targetScore must be between 95 and 100 and at least minimumScore')
  }
  const owner = requiredText(value.owner, 'owner')
  const reviewedAt = requiredDate(value.reviewedAt, 'reviewedAt')
  const scope = parseScope(value.scope)
  if (!Array.isArray(value.reviews)) throw new Error('mutation policy reviews must be an array')
  const reviews = value.reviews.map((review, index) => parseReview(review, index))

  const selectorKeys = reviews.map((review) => {
    return 'mutantId' in review.selector
      ? `id:${review.selector.mutantId}`
      : `rule:${JSON.stringify(review.selector.rule)}`
  })
  if (new Set(selectorKeys).size !== selectorKeys.length)
    throw new Error('mutation policy contains duplicate review selectors')

  return {
    schemaVersion: 1,
    requirementId: 'TST-037',
    minimumScore: value.minimumScore,
    targetScore: value.targetScore,
    owner,
    reviewedAt,
    scope,
    reviews
  }
}

export function isTypeOnlyModule(source: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return sourceFile.statements.every((statement) => {
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEmptyStatement(statement)
    ) {
      return true
    }
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      return Boolean(
        clause?.isTypeOnly ||
        (clause?.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly))
      )
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) return true
      if (!statement.moduleSpecifier && !statement.exportClause) return true
      return Boolean(
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.every((element) => element.isTypeOnly)
      )
    }
    return false
  })
}

export function auditMutationConfiguration(
  configValue: unknown,
  policyValue: unknown,
  typeOnlySources: Record<string, string>
): string[] {
  const policy = validateMutationPolicy(policyValue)
  const problems: string[] = []
  if (!isRecord(configValue)) return ['Stryker config must be an object']
  const expectedMutate = [...policy.scope.include, ...policy.scope.typeOnlyExclusions.map(({ file }) => `!${file}`)]
  if (JSON.stringify(configValue.mutate) !== JSON.stringify(expectedMutate)) {
    problems.push('Stryker mutate patterns do not match the governed scope')
  }
  const thresholds = isRecord(configValue.thresholds) ? configValue.thresholds : {}
  if (thresholds.break !== policy.minimumScore || thresholds.high !== policy.targetScore) {
    problems.push('Stryker thresholds do not match minimumScore and targetScore')
  }
  if (configValue.incremental !== false) problems.push('Stryker incremental mode must be disabled')
  if (configValue.disableTypeChecks !== false) problems.push('Stryker must not inject @ts-nocheck into project files')
  if (!Array.isArray(configValue.reporters) || !configValue.reporters.includes('json')) {
    problems.push('Stryker must publish the JSON report')
  }
  if (!Array.isArray(configValue.checkers) || !configValue.checkers.includes('typescript')) {
    problems.push('Stryker must keep the TypeScript checker enabled')
  }
  for (const exclusion of policy.scope.typeOnlyExclusions) {
    const source = typeOnlySources[exclusion.file]
    if (source === undefined) problems.push(`missing excluded source: ${exclusion.file}`)
    else if (!isTypeOnlyModule(source, exclusion.file)) {
      problems.push(`excluded file contains runtime logic: ${exclusion.file}`)
    }
  }
  return problems
}

function parseMutation(value: unknown, file: string, index: number): Mutation {
  const field = `${file}.mutants[${index}]`
  if (!isRecord(value)) throw new Error(`${field} must be an object`)
  const location = isRecord(value.location) && isRecord(value.location.start) ? value.location.start : undefined
  const status = requiredText(value.status, `${field}.status`)
  if (!FINAL_MUTATION_STATUSES.includes(status as (typeof FINAL_MUTATION_STATUSES)[number])) {
    throw new Error(`${field}.status is not a supported final Stryker status: ${status}`)
  }
  const parsed: Mutation = {
    id: requiredText(value.id, `${field}.id`),
    file,
    status,
    mutatorName: requiredText(value.mutatorName, `${field}.mutatorName`),
    replacement: requiredString(value.replacement, `${field}.replacement`)
  }
  if (location) {
    parsed.location = {
      line: requiredPositiveInteger(location.line, `${field}.location.start.line`),
      column: requiredPositiveInteger(location.column, `${field}.location.start.column`)
    }
  }
  return parsed
}

export function auditMutationReportScope(report: unknown, expectedFiles: string[]): string[] {
  if (!isRecord(report) || !isRecord(report.files)) return ['mutation report must contain a files object']
  const actual = Object.keys(report.files).sort()
  const expected = [...new Set(expectedFiles)].sort()
  const missing = expected.filter((file) => !actual.includes(file))
  const unexpected = actual.filter((file) => !expected.includes(file))
  const problems: string[] = []
  if (missing.length > 0) problems.push(`mutation report is missing scoped files: ${missing.join(', ')}`)
  if (unexpected.length > 0) problems.push(`mutation report contains files outside scope: ${unexpected.join(', ')}`)
  return problems
}

export function extractMutations(value: unknown): Mutation[] {
  if (!isRecord(value) || !isRecord(value.files)) throw new Error('mutation report must contain a files object')
  const mutations: Mutation[] = []
  const ids = new Set<string>()
  for (const [file, fileValue] of Object.entries(value.files)) {
    if (!isRecord(fileValue) || !Array.isArray(fileValue.mutants))
      throw new Error(`${file} must contain a mutants array`)
    for (const [index, mutant] of fileValue.mutants.entries()) {
      const parsed = parseMutation(mutant, file, index)
      if (ids.has(parsed.id)) throw new Error(`mutation report contains duplicate mutant id: ${parsed.id}`)
      ids.add(parsed.id)
      mutations.push(parsed)
    }
  }
  if (mutations.length === 0) throw new Error('mutation report contains no mutants')
  return mutations
}

export function calculateMutationScore(mutations: Mutation[]): MutationScore {
  const counts = {
    killed: mutations.filter((mutation) => mutation.status === 'Killed').length,
    timeout: mutations.filter((mutation) => mutation.status === 'Timeout').length,
    survived: mutations.filter((mutation) => mutation.status === 'Survived').length,
    noCoverage: mutations.filter((mutation) => mutation.status === 'NoCoverage').length
  }
  const denominator = counts.killed + counts.timeout + counts.survived + counts.noCoverage
  const numerator = counts.killed + counts.timeout
  return {
    ...counts,
    denominator,
    numerator,
    percentage: denominator === 0 ? 0 : (numerator / denominator) * 100,
    excluded: mutations.length - denominator
  }
}

function matchesRule(mutation: Mutation, rule: MutationReviewRule): boolean {
  return (
    mutation.file === rule.file &&
    mutation.status === rule.status &&
    mutation.mutatorName === rule.mutatorName &&
    mutation.replacement === rule.replacement &&
    (rule.line === undefined || mutation.location?.line === rule.line) &&
    (rule.column === undefined || mutation.location?.column === rule.column)
  )
}

function reviewMatches(mutation: Mutation, review: MutationReview): boolean {
  if ('mutantId' in review.selector) return mutation.id === review.selector.mutantId
  return matchesRule(mutation, review.selector.rule)
}

function mutationLocation(mutation: Mutation): string {
  return mutation.location ? `${mutation.location.line}:${mutation.location.column}` : 'unknown'
}

export function auditMutationEvidence(report: unknown, policyValue: unknown): MutationAuditResult {
  const policy = validateMutationPolicy(policyValue)
  const mutations = extractMutations(report)
  const score = calculateMutationScore(mutations)
  const reviewable = mutations.filter((mutation) =>
    REVIEWABLE_MUTATION_STATUSES.includes(mutation.status as ReviewableMutationStatus)
  )
  const matches = new Map<string, number[]>()
  for (const mutation of reviewable) {
    matches.set(
      mutation.id,
      policy.reviews.flatMap((review, index) => (reviewMatches(mutation, review) ? [index] : []))
    )
  }

  const unreviewed = reviewable.filter((mutation) => (matches.get(mutation.id)?.length ?? 0) === 0)
  const overlappingReviews = reviewable
    .map((mutation) => ({ mutantId: mutation.id, reviewIndexes: matches.get(mutation.id) ?? [] }))
    .filter(({ reviewIndexes }) => reviewIndexes.length > 1)
  const unmatchedReviews = policy.reviews
    .map((review, index) => (mutations.some((mutation) => reviewMatches(mutation, review)) ? -1 : index))
    .filter((index) => index >= 0)
  const mismatchedReviewCounts = policy.reviews.flatMap((review, reviewIndex) => {
    const actual = reviewable.filter((mutation) => reviewMatches(mutation, review)).length
    const expected = 'rule' in review.selector ? review.selector.rule.expectedMatches : 1
    return actual === expected ? [] : [{ reviewIndex, expected, actual }]
  })
  const mismatchedReviewLocations = policy.reviews.flatMap((review, reviewIndex) => {
    if (!('rule' in review.selector)) return []
    const actual = reviewable
      .filter((mutation) => reviewMatches(mutation, review))
      .map(mutationLocation)
      .sort()
    const expected = [...review.selector.rule.expectedLocations].sort()
    return JSON.stringify(actual) === JSON.stringify(expected) ? [] : [{ reviewIndex, expected, actual }]
  })
  const problems: string[] = []
  if (score.denominator === 0) problems.push('mutation report has no scoreable mutants')
  if (score.percentage < policy.minimumScore) {
    problems.push(`mutation score ${score.percentage.toFixed(2)}% is below required ${policy.minimumScore}%`)
  }
  if (unreviewed.length > 0)
    problems.push(`unreviewed Survived/Timeout mutants: ${unreviewed.map((mutation) => mutation.id).join(', ')}`)
  if (overlappingReviews.length > 0) {
    problems.push(
      `ambiguous mutation reviews: ${overlappingReviews
        .map(({ mutantId, reviewIndexes }) => `${mutantId}=>${reviewIndexes.join(',')}`)
        .join('; ')}`
    )
  }
  if (unmatchedReviews.length > 0)
    problems.push(`mutation reviews match no report mutant: ${unmatchedReviews.join(', ')}`)
  if (mismatchedReviewCounts.length > 0) {
    problems.push(
      `mutation review counts changed: ${mismatchedReviewCounts
        .map(({ reviewIndex, expected, actual }) => `${reviewIndex} expected ${expected}, found ${actual}`)
        .join('; ')}`
    )
  }
  if (mismatchedReviewLocations.length > 0) {
    problems.push(
      `mutation review locations changed: ${mismatchedReviewLocations
        .map(
          ({ reviewIndex, expected, actual }) =>
            `${reviewIndex} expected ${expected.join(',')}, found ${actual.join(',') || 'none'}`
        )
        .join('; ')}`
    )
  }

  return {
    score,
    reviewable,
    unreviewed,
    unmatchedReviews,
    mismatchedReviewCounts,
    mismatchedReviewLocations,
    overlappingReviews,
    problems,
    passed: problems.length === 0
  }
}

export async function readMutationEvidence(reportPath: string, policyPath: string) {
  const [reportSource, policySource] = await Promise.all([readFile(reportPath, 'utf8'), readFile(policyPath, 'utf8')])
  return {
    report: JSON.parse(reportSource) as unknown,
    policy: JSON.parse(policySource) as unknown
  }
}
