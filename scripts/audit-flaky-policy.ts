import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { forbiddenTestControls } from './lib/flaky-policy'

async function testFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = resolve(directory, entry.name)
        return entry.isDirectory()
          ? testFiles(path)
          : Promise.resolve(/\.(?:test|spec)\.ts$/.test(entry.name) ? [path] : [])
      })
    )
  )
    .flat()
    .sort()
}

const violations: string[] = []
for (const file of await testFiles(resolve('tests'))) {
  const source = await readFile(file, 'utf8')
  for (const control of forbiddenTestControls(source)) violations.push(`${relative(process.cwd(), file)}: ${control}`)
}
const playwrightConfig = await readFile(resolve('playwright.config.ts'), 'utf8')
if (!/\bretries:\s*0\b/.test(playwrightConfig)) violations.push('playwright.config.ts: retries must equal zero')
const vitestConfig = await readFile(resolve('vitest.config.ts'), 'utf8')
if (/\bretry:\s*[1-9]/.test(vitestConfig)) violations.push('vitest.config.ts: retries must equal zero')
for (const file of ['package.json', '.github/workflows/ci.yml']) {
  const source = await readFile(resolve(file), 'utf8')
  if (/--retries?(?:=|\s+)[1-9]/.test(source)) violations.push(`${file}: CLI test retries are forbidden`)
  if (file.endsWith('.yml') && /continue-on-error:\s*true/.test(source)) {
    violations.push(`${file}: test failures cannot be ignored`)
  }
}
if (violations.length) throw new Error(`Flaky-test policy failed:\n- ${violations.join('\n- ')}`)
process.stdout.write('flaky-policy retries=0 skipped=0 todo=0 focused=0 expected-failures=0 ignored-failures=0\n')
