import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_DEMO_CREDENTIALS_FILE,
  demoCredentialsPath,
  readDemoCredentials
} from '../../scripts/lib/demo-credentials'

const ACCOUNT = '15f0ac470ce8d173cf7633c7bbcba3ec'
const TOKEN = 'synthetic-demo-token-value-0123456789'
const directories: string[] = []
function file(content: string) {
  const directory = mkdtempSync(join(tmpdir(), 'neteco-demo-credentials-'))
  directories.push(directory)
  const path = join(directory, 'cloudflare.txt')
  writeFileSync(path, content, { mode: 0o600 })
  return path
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('demo Cloudflare credentials location', () => {
  it('defaults to the workspace credentials store, not the retired /devtono path', () => {
    expect(DEFAULT_DEMO_CREDENTIALS_FILE).toBe('/root/.config/workspace/credentials/cloudflare.txt')
    expect(demoCredentialsPath({})).toBe(DEFAULT_DEMO_CREDENTIALS_FILE)
  })

  it('accepts an explicit absolute path from NETECO_DEMO_CLOUDFLARE_CREDENTIALS', () => {
    expect(demoCredentialsPath({ NETECO_DEMO_CLOUDFLARE_CREDENTIALS: '/secure/cf.txt' })).toBe('/secure/cf.txt')
    expect(() => demoCredentialsPath({ NETECO_DEMO_CLOUDFLARE_CREDENTIALS: 'relative.txt' })).toThrow(
      'demo_credentials_path_invalid'
    )
  })

  it('returns the token only for the exact demo account', async () => {
    const path = file(
      `IDCUENTA_other@example.invalid=ffff\nTOKEN_other@example.invalid=wrong\n\nIDCUENTA_mail@tonomolla.es=${ACCOUNT}\nTOKEN_mail@tonomolla.es= ${TOKEN}\r\n`
    )
    await expect(readDemoCredentials(path, ACCOUNT)).resolves.toBe(TOKEN)
  })

  it('refuses a mismatched account without disclosing the token or file contents', async () => {
    const path = file(`IDCUENTA_mail@tonomolla.es=0000\nTOKEN_mail@tonomolla.es=${TOKEN}\n`)
    const error = await readDemoCredentials(path, ACCOUNT).catch((reason: Error) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('demo_credentials_required')
    expect(JSON.stringify(error) + String((error as Error).stack)).not.toContain(TOKEN)
  })

  it('reports a missing file with a stable code and no path contents', async () => {
    await expect(readDemoCredentials('/nonexistent/neteco/cloudflare.txt', ACCOUNT)).rejects.toThrow(
      'demo_credentials_unreadable'
    )
  })
})
