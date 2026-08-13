import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { validateExploratoryEvidence } from './lib/exploratory-evidence'

const execFileAsync = promisify(execFile)

const args = process.argv.slice(2)
const evidencePath = args.find((argument) => !argument.startsWith('--'))
const commitArgument = args.find((argument) => argument.startsWith('--expected-commit='))
if (!evidencePath) {
  throw new Error('Usage: npm run audit:exploratory -- <evidence.json> [--expected-commit=<40-character SHA>]')
}
const expectedCommit = commitArgument?.slice('--expected-commit='.length)
const manifest = validateExploratoryEvidence(JSON.parse(await readFile(resolve(evidencePath), 'utf8')), expectedCommit)
await execFileAsync('git', ['cat-file', '-e', `${manifest.run.commitSha}^{commit}`])
await execFileAsync('git', ['merge-base', '--is-ancestor', manifest.run.commitSha, 'HEAD'])
const repositoryFiles = manifest.evidence.filter((item) => item.kind === 'repository_file')
for (const evidence of repositoryFiles) {
  const path = resolve(evidence.reference)
  if (!path.startsWith(`${process.cwd()}/`))
    throw new Error(`Evidence path escapes the repository: ${evidence.reference}`)
  await access(path)
}
const { stdout: changedEvidence } = await execFileAsync('git', [
  'diff',
  '--name-only',
  manifest.run.commitSha,
  '--',
  ...repositoryFiles.map((evidence) => evidence.reference)
])
if (changedEvidence.trim()) {
  throw new Error(`Exploratory probes changed since the recorded run:\n${changedEvidence.trim()}`)
}
process.stdout.write(
  `exploratory=PASS run=${manifest.run.id} commit=${manifest.run.commitSha} charters=${manifest.charters.length} defects=${manifest.defectBacklog.length}\n`
)
