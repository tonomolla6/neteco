import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, readdir } from 'node:fs/promises'
import {
  auditMutationConfiguration,
  auditMutationEvidence,
  auditMutationReportScope,
  readMutationEvidence,
  validateMutationPolicy
} from './lib/mutation-evidence'

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) return listTypeScriptFiles(path)
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
    })
  )
  return files.flat()
}

async function expectedReportFiles(include: string[], exclusions: string[]) {
  const roots = include.map((pattern) => {
    const suffix = '/**/*.ts'
    if (!pattern.endsWith(suffix)) throw new Error(`unsupported mutation scope pattern: ${pattern}`)
    return pattern.slice(0, -suffix.length)
  })
  const files = (await Promise.all(roots.map(listTypeScriptFiles))).flat()
  const excluded = new Set(exclusions)
  return files.filter((file) => !excluded.has(file)).sort()
}

function argument(name: string, fallback: string) {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

const reportPath = resolve(argument('report', 'reports/mutation/mutation.json'))
const policyPath = resolve(argument('policy', 'docs/testing/mutation-policy.json'))

try {
  const { report, policy } = await readMutationEvidence(reportPath, policyPath)
  const validatedPolicy = validateMutationPolicy(policy)
  const typeOnlySources = Object.fromEntries(
    await Promise.all(
      validatedPolicy.scope.typeOnlyExclusions.map(async ({ file }) => [file, await readFile(resolve(file), 'utf8')])
    )
  )
  const configModule = (await import(pathToFileURL(resolve('stryker.config.mjs')).href)) as { default: unknown }
  const configurationProblems = auditMutationConfiguration(configModule.default, policy, typeOnlySources)
  const result = auditMutationEvidence(report, policy)
  const scopedFiles = await expectedReportFiles(
    validatedPolicy.scope.include,
    validatedPolicy.scope.typeOnlyExclusions.map(({ file }) => file)
  )
  const reportScopeProblems = auditMutationReportScope(report, scopedFiles)
  process.stdout.write(
    `mutation-evidence score=${result.score.percentage.toFixed(2)}% killed=${result.score.killed} timeout=${result.score.timeout} survived=${result.score.survived} noCoverage=${result.score.noCoverage} excluded=${result.score.excluded} reviewed=${result.reviewable.length - result.unreviewed.length}\n`
  )
  const problems = [...configurationProblems, ...reportScopeProblems, ...result.problems]
  if (problems.length > 0) {
    throw new Error(`Mutation evidence failed:\n- ${problems.join('\n- ')}`)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
