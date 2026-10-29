import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { inventoryAndRedactArtifacts, redactArtifactText } from '../../scripts/lib/ci-artifacts'

const execFileAsync = promisify(execFile)

describe('CI artifact redaction', () => {
  it('audits the effective monitor coverage/JUnit commands and CI integration prerequisites', async () => {
    const result = await execFileAsync('node_modules/.bin/tsx', ['scripts/audit-ci-artifacts.ts'])
    expect(result.stdout).toContain('ci-artifacts=PASS policy=TST-036')
  })
  it('redacts credentials, authorization, private keys and non-test email addresses', () => {
    const source = [
      'DATABASE_URL=postgres://neteco:private@db.example.invalid/app',
      'Authorization: Bearer abc.def.ghi',
      '"apiToken":"token-value"',
      'buyer@example.com',
      'safe@example.invalid',
      '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----'
    ].join('\n')
    const result = redactArtifactText(source)
    expect(result.redactions).toBe(5)
    expect(result.text).not.toContain('private@')
    expect(result.text).not.toContain('abc.def.ghi')
    expect(result.text).not.toContain('token-value')
    expect(result.text).not.toContain('buyer@example.com')
    expect(result.text).not.toContain('private-material')
    expect(result.text).toContain('safe@example.invalid')
  })

  it('redacts explicit environment values without including them in the inventory', () => {
    const result = redactArtifactText('config=runtime-sensitive-value', ['runtime-sensitive-value'])
    expect(result).toEqual({ text: 'config=[REDACTED]', redactions: 1 })
  })

  it('does not corrupt reporter JavaScript identifiers that merely contain sensitive words', () => {
    const source = 'const token = readToken(); formatter.apiKey = keyName'
    expect(redactArtifactText(source)).toEqual({ text: source, redactions: 0 })
  })

  it('redacts Playwright network headers and sensitive query parameters', () => {
    const result = redactArtifactText(
      '{"name":"cookie","value":"session=private"}\nhttps://example.invalid/path?token=private-token&safe=yes'
    )
    expect(result).toEqual({
      text: '{"name":"cookie","value":"[REDACTED]"}\nhttps://example.invalid/path?token=[REDACTED]&safe=yes',
      redactions: 2
    })
    expect(redactArtifactText(result.text).redactions).toBe(0)
  })

  it('rebuilds trace archives after redacting their textual network records', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'neteco-ci-artifacts-test-'))
    try {
      const source = resolve(root, 'source')
      const artifacts = resolve(root, 'artifacts')
      await mkdir(source)
      await mkdir(artifacts)
      await writeFile(resolve(source, 'trace.network'), '{"name":"cookie","value":"session=private"}\n', 'utf8')
      await execFileAsync('zip', ['-q', resolve(artifacts, 'trace.zip'), 'trace.network'], { cwd: source })

      const inventory = await inventoryAndRedactArtifacts(['artifacts'], [], root)
      const { stdout } = await execFileAsync('unzip', ['-p', resolve(artifacts, 'trace.zip'), 'trace.network'])
      expect(stdout).toContain('"value":"[REDACTED]"')
      expect(stdout).not.toContain('session=private')
      expect(inventory).toMatchObject({ redactedFiles: 1, redactions: 1 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
