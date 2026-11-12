import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

/** Operator-owned credentials store. Override with NETECO_DEMO_CLOUDFLARE_CREDENTIALS (absolute path). */
export const DEFAULT_DEMO_CREDENTIALS_FILE = '/root/.config/workspace/credentials/cloudflare.txt'
const OWNER = 'mail@tonomolla.es'

export function demoCredentialsPath(environment: Record<string, string | undefined>) {
  const configured = environment.NETECO_DEMO_CLOUDFLARE_CREDENTIALS?.trim()
  if (!configured) return DEFAULT_DEMO_CREDENTIALS_FILE
  if (!isAbsolute(configured)) throw new Error('demo_credentials_path_invalid')
  return configured
}

/** Returns the API token only when the file's account matches the demo account. Errors never carry values. */
export async function readDemoCredentials(path: string, account: string): Promise<string> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new Error('demo_credentials_unreadable')
  }
  const entries = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator > 0) entries.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  const token = entries.get(`TOKEN_${OWNER}`)
  if (!token || entries.get(`IDCUENTA_${OWNER}`) !== account) throw new Error('demo_credentials_required')
  return token
}
