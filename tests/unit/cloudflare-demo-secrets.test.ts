import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { configuredEditorialSecrets } from '../../workers/runtime/customer-operations-config'
import { configuredAnalyticsMeasurement, type AnalyticsRuntimeEnv } from '../../workers/runtime/analytics-config'

type PreparedSecrets = Record<string, { name: string; type: 'secret_text'; text: string }>

// Extract only the actual pure generator. Never evaluate the operator CLI, its
// imports, credential reads, process environment mutations or Cloudflare API.
function generator() {
  const source = readFileSync(new URL('../../scripts/cloudflare-demo-remote.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('cloudflare-demo-remote.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = ast.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'prepareDemoSecrets'
  )
  if (!declaration) throw new Error('demo_secret_generator_not_found')
  const javascript = ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  let sequence = 0
  const randomBytes = vi.fn((length: number) => Buffer.alloc(length, ++sequence))
  const exports: { prepareDemoSecrets?: (names: ReadonlySet<string>) => PreparedSecrets } = {}
  runInNewContext(javascript, { exports, randomBytes }, { timeout: 1000 })
  if (!exports.prepareDemoSecrets) throw new Error('demo_secret_generator_not_exported')
  return { prepare: exports.prepareDemoSecrets, randomBytes }
}

describe('demo secret generation matches effective runtime contracts', () => {
  it('generates a newsletter key accepted by the real newsletter validator', () => {
    const { prepare } = generator()
    const secrets = prepare(new Set())
    expect(configuredEditorialSecrets(secrets.NEWSLETTER_HMAC_KEY!.text)?.hmacKey.length).toBe(32)
  })

  it('generates an independent analytics key accepted by the real analytics validator', () => {
    const { prepare } = generator()
    const secrets = prepare(new Set())
    const env = Object.fromEntries(Object.entries(secrets).map(([name, secret]) => [name, secret.text]))
    expect(configuredAnalyticsMeasurement(env as AnalyticsRuntimeEnv).sessionPepper?.length).toBe(32)
    expect(secrets.ANALYTICS_SESSION_PEPPER!.text === secrets.NEWSLETTER_HMAC_KEY!.text).toBe(false)
  })

  it('preserves the other six key formats and separate cryptographic entropy requests', () => {
    const { prepare, randomBytes } = generator()
    const secrets = prepare(new Set())
    const hexNames = [
      'NUXT_SESSION_PASSWORD',
      'AUTH_RATE_LIMIT_PEPPER',
      'AUTH_TOKEN_PEPPER',
      'MEDIA_SCAN_SECRET',
      'CMS_PREVIEW_SECRET'
    ]
    for (const name of hexNames) {
      expect(/^[a-f0-9]{96}$/.test(secrets[name]!.text)).toBe(true)
      expect(secrets[name]!.name === name && secrets[name]!.type === 'secret_text').toBe(true)
    }
    expect(Buffer.from(secrets.AUTH_ENCRYPTION_KEY!.text, 'base64').length).toBe(32)
    expect(randomBytes).toHaveBeenCalledTimes(8)
    expect(randomBytes.mock.calls.filter(([length]) => length === 48)).toHaveLength(5)
    expect(randomBytes.mock.calls.filter(([length]) => length === 32)).toHaveLength(3)
    expect(new Set(Object.values(secrets).map((secret) => secret.text)).size).toBe(8)
  })

  it('never rotates an existing key and does not request entropy for skipped keys', () => {
    const { prepare, randomBytes } = generator()
    const first = prepare(new Set())
    randomBytes.mockClear()
    expect(Object.keys(prepare(new Set(Object.keys(first))))).toHaveLength(0)
    expect(randomBytes).not.toHaveBeenCalled()
    const missing = prepare(new Set(Object.keys(first).filter((name) => name !== 'NEWSLETTER_HMAC_KEY')))
    expect(Object.keys(missing)).toEqual(['NEWSLETTER_HMAC_KEY'])
    expect(randomBytes).toHaveBeenCalledTimes(1)
  })
})
