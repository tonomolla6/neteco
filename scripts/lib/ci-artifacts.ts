import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const textExtensions = new Set(['.html', '.json', '.log', '.md', '.txt', '.xml'])
const execFileAsync = promisify(execFile)

export interface ArtifactEntry {
  path: string
  bytes: number
  sha256: string
  kind: 'text' | 'binary'
  redactions: number
}

export interface ArtifactInventory {
  files: ArtifactEntry[]
  redactedFiles: number
  redactions: number
}

const sensitiveJsonAssignment =
  /("[^"]*(?:password|passwd|secret|token|api[_-]?key)[^"]*"\s*:\s*")(?!\[REDACTED\]")([^"]*)(")/gi
const sensitiveEnvironmentAssignment =
  /^(\s*[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY)[A-Z0-9_]*\s*=\s*)(?!\[REDACTED\]\s*$)(.+)$/gim
const credentialUrl = /\b((?:postgres(?:ql)?|redis|https?):\/\/)[^\s/"'<>]+:[^\s@"'<>]+@/gi
const authorizationHeader = /\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s"'<>]+/gi
const privateKey =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
const personalEmail = /\b[A-Z0-9._%+-]+@(?![A-Z0-9.-]+\.invalid\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const sensitiveHeaderObject =
  /("name"\s*:\s*"(?:authorization|cookie|set-cookie|x-[^"]*token[^"]*)"\s*,\s*"value"\s*:\s*")(?!\[REDACTED\]")[^"]*(")/gi
const sensitiveQueryValue = /([?&](?:access[_-]?token|token|code|key|secret)=)(?!\[REDACTED\](?:[&#"\s]|$))[^&#"\s]+/gi

function replace(text: string, expression: RegExp, replacement: string | ((...values: string[]) => string)) {
  let count = 0
  const value = text.replace(expression, (...values) => {
    count += 1
    return typeof replacement === 'string' ? replacement : replacement(...(values as string[]))
  })
  return { value, count }
}

export function redactArtifactText(source: string, explicitSecrets: string[] = []) {
  let text = source
  let redactions = 0
  for (const secret of [...new Set(explicitSecrets)]
    .filter((value) => value.length >= 8)
    .sort((a, b) => b.length - a.length)) {
    const parts = text.split(secret)
    if (parts.length === 1) continue
    redactions += parts.length - 1
    text = parts.join('[REDACTED]')
  }
  for (const [expression, replacement] of [
    [credentialUrl, (_match: string, scheme: string) => `${scheme}[REDACTED]@`],
    [authorizationHeader, (_match: string, prefix: string) => `${prefix}[REDACTED]`],
    [
      sensitiveJsonAssignment,
      (_match: string, prefix: string, _value: string, suffix: string) => `${prefix}[REDACTED]${suffix}`
    ],
    [sensitiveEnvironmentAssignment, (_match: string, prefix: string) => `${prefix}[REDACTED]`],
    [sensitiveHeaderObject, (_match: string, prefix: string, suffix: string) => `${prefix}[REDACTED]${suffix}`],
    [sensitiveQueryValue, (_match: string, prefix: string) => `${prefix}[REDACTED]`],
    [privateKey, '[REDACTED PRIVATE KEY]'],
    [personalEmail, '[REDACTED EMAIL]']
  ] as Array<[RegExp, string | ((...values: string[]) => string)]>) {
    const result = replace(text, expression, replacement)
    text = result.value
    redactions += result.count
  }
  return { text, redactions }
}

async function filesBelow(path: string): Promise<string[]> {
  const current = await lstat(path).catch(() => undefined)
  if (!current) return []
  if (current.isSymbolicLink()) return []
  if (current.isFile()) return [path]
  const entries = await readdir(path, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => filesBelow(resolve(path, entry.name))))
  return nested.flat()
}

async function redactTraceArchive(path: string, explicitSecrets: string[]) {
  const temporary = await mkdtemp(resolve(tmpdir(), 'neteco-trace-redaction-'))
  const extracted = resolve(temporary, 'trace')
  const rebuilt = resolve(temporary, 'trace.zip')
  let redactions = 0
  try {
    await execFileAsync('unzip', ['-qq', path, '-d', extracted])
    for (const entry of await filesBelow(extracted)) {
      const contents = await readFile(entry)
      const text = contents.toString('utf8')
      if (!Buffer.from(text).equals(contents)) continue
      const result = redactArtifactText(text, explicitSecrets)
      if (result.redactions === 0) continue
      await writeFile(entry, result.text, 'utf8')
      redactions += result.redactions
    }
    await execFileAsync('zip', ['-q', '-r', rebuilt, '.'], { cwd: extracted })
    await rename(rebuilt, path)
    return redactions
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function inventoryAndRedactArtifacts(
  roots: string[],
  explicitSecrets: string[] = [],
  repositoryRoot = process.cwd()
): Promise<ArtifactInventory> {
  const paths = (await Promise.all(roots.map((root) => filesBelow(resolve(repositoryRoot, root))))).flat().sort()
  const files: ArtifactEntry[] = []
  let redactedFiles = 0
  let redactions = 0
  for (const path of paths) {
    let contents = await readFile(path)
    let fileRedactions = 0
    const extension = extname(path).toLowerCase()
    const kind = textExtensions.has(extension) ? 'text' : 'binary'
    if (kind === 'text') {
      const result = redactArtifactText(contents.toString('utf8'), explicitSecrets)
      fileRedactions = result.redactions
      if (fileRedactions > 0) {
        await writeFile(path, result.text, 'utf8')
        contents = Buffer.from(result.text)
        redactedFiles += 1
        redactions += fileRedactions
      }
    } else if (extension === '.zip') {
      fileRedactions = await redactTraceArchive(path, explicitSecrets)
      if (fileRedactions > 0) {
        contents = await readFile(path)
        redactedFiles += 1
        redactions += fileRedactions
      }
    }
    files.push({
      path: relative(repositoryRoot, path),
      bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
      kind,
      redactions: fileRedactions
    })
  }
  return { files, redactedFiles, redactions }
}
