import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import fc, { type IRawProperty, type Parameters as FastCheckParameters, type RunDetails } from 'fast-check'

const DEFAULT_NUM_RUNS = 200
const MAX_SEED = 0x7fffffff
const PROPERTY_SEEDS_FILE = resolve(process.cwd(), 'tests/fixtures/property-seeds.json')
const PROPERTY_FAILURE_DIRECTORY = resolve(process.cwd(), 'test-results/property-failures')

export interface PropertyCheckOptions {
  readonly numRuns?: number
  readonly seedOffset?: number
}

export interface PersistedPropertySeed {
  readonly seed: number
  readonly path: string
}

interface PropertySeedsFixture {
  readonly version: 1
  readonly seeds: Record<string, PersistedPropertySeed | readonly PersistedPropertySeed[]>
}

function normalizeSeed(value: bigint): number {
  const modulus = BigInt(MAX_SEED)
  const normalized = value % modulus
  return Number(normalized === 0n ? 1n : normalized < 0n ? normalized + modulus : normalized)
}

function readInteger(value: string | undefined, name: string): number {
  if (value === undefined || value.trim() === '') return 0
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer`)
  return parsed
}

function safePropertyId(id: string): string {
  const trimmed = id.trim()
  if (!trimmed) throw new Error('Property id must not be empty')
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '_')
}

export function propertySeedFor(id: string, seedOffset = 0): number {
  const normalizedId = id.trim()
  if (!normalizedId) throw new Error('Property id must not be empty')
  if (!Number.isSafeInteger(seedOffset)) throw new Error('seedOffset must be a safe integer')
  const digest = createHash('sha256').update(`neteco-property-v1:${normalizedId}`, 'utf8').digest()
  const baseSeed = digest.readUInt32BE(0)
  const environmentOffset = readInteger(process.env.PROPERTY_SEED, 'PROPERTY_SEED')
  return normalizeSeed(BigInt(baseSeed) + BigInt(environmentOffset) + BigInt(seedOffset))
}

function assertPersistedSeed(value: unknown, propertyId: string): PersistedPropertySeed {
  if (!value || typeof value !== 'object') throw new Error(`Invalid persisted property seed for "${propertyId}"`)
  const candidate = value as Record<string, unknown>
  if (!Number.isSafeInteger(candidate.seed)) {
    throw new Error(`Persisted property seed for "${propertyId}" must contain a safe integer seed`)
  }
  if (typeof candidate.path !== 'string') {
    throw new Error(`Persisted property seed for "${propertyId}" must contain a string path`)
  }
  return { seed: candidate.seed, path: candidate.path }
}

async function readPersistedSeeds(id: string): Promise<readonly PersistedPropertySeed[]> {
  const contents = await readFile(PROPERTY_SEEDS_FILE, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (error) {
    throw new Error(
      `Unable to parse ${PROPERTY_SEEDS_FILE}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error
      }
    )
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`${PROPERTY_SEEDS_FILE} must contain a JSON object`)

  const fixture = parsed as Partial<PropertySeedsFixture> & Record<string, unknown>
  if (fixture.version !== 1 || !fixture.seeds || typeof fixture.seeds !== 'object') {
    throw new Error(`${PROPERTY_SEEDS_FILE} must use fixture version 1 with a seeds object`)
  }
  const entry = (fixture.seeds as Record<string, unknown>)[id]
  if (entry === undefined) return []
  if (Array.isArray(entry)) return entry.map((seed) => assertPersistedSeed(seed, id))
  return [assertPersistedSeed(entry, id)]
}

function safeJsonValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value === 'undefined') return '[undefined]'
  if (typeof value === 'symbol') return `[symbol: ${String(value)}]`
  if (typeof value === 'function') return `[function: ${value.name || 'anonymous'}]`
  if (depth >= 20) return '[MaxDepth]'

  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[InvalidDate]' : value.toISOString()
    if (value instanceof Error) return { name: value.name, message: value.message }
    if (value instanceof Map) {
      return [...value.entries()].map(([key, entry]) => [
        safeJsonValue(key, seen, depth + 1),
        safeJsonValue(entry, seen, depth + 1)
      ])
    }
    if (value instanceof Set) return [...value].map((entry) => safeJsonValue(entry, seen, depth + 1))
    if (Array.isArray(value)) return value.map((entry) => safeJsonValue(entry, seen, depth + 1))

    const record: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      try {
        record[key] = safeJsonValue((value as Record<string, unknown>)[key], seen, depth + 1)
      } catch (error) {
        record[key] = `[unreadable: ${error instanceof Error ? error.message : String(error)}]`
      }
    }
    return record
  } finally {
    seen.delete(value)
  }
}

async function persistFailure<Ts>(id: string, result: RunDetails<Ts>): Promise<string> {
  const file = resolve(PROPERTY_FAILURE_DIRECTORY, `${safePropertyId(id)}.json`)
  await mkdir(dirname(file), { recursive: true })
  const payload = {
    id,
    seed: result.seed,
    counterexamplePath: result.counterexamplePath,
    numShrinks: result.numShrinks,
    counterexample: safeJsonValue(result.counterexample)
  }
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return file
}

async function runProperty<Ts extends [unknown, ...unknown[]]>(
  property: IRawProperty<Ts>,
  parameters: FastCheckParameters<Ts>
): Promise<RunDetails<Ts>> {
  return Promise.resolve(fc.check(property, parameters))
}

export async function checkProperty<Ts extends [unknown, ...unknown[]]>(
  id: string,
  property: IRawProperty<Ts>,
  options: PropertyCheckOptions = {}
): Promise<RunDetails<Ts>> {
  const normalizedId = id.trim()
  safePropertyId(normalizedId)
  const numRuns = options.numRuns ?? DEFAULT_NUM_RUNS
  if (!Number.isSafeInteger(numRuns) || numRuns <= 0) throw new Error('numRuns must be a positive safe integer')
  if (options.seedOffset !== undefined && !Number.isSafeInteger(options.seedOffset)) {
    throw new Error('seedOffset must be a safe integer')
  }

  const baseParameters: FastCheckParameters<Ts> = {
    numRuns,
    seed: propertySeedFor(normalizedId, options.seedOffset ?? 0),
    path: ''
  }
  const persistedSeeds = await readPersistedSeeds(normalizedId)
  for (const persisted of persistedSeeds) {
    const replayResult = await runProperty(property, { ...baseParameters, seed: persisted.seed, path: persisted.path })
    if (replayResult.failed) {
      const file = await persistFailure(normalizedId, replayResult)
      throw new Error(
        `Property "${normalizedId}" failed while replaying seed ${replayResult.seed} at path "${replayResult.counterexamplePath ?? persisted.path}"; evidence written to ${file}`
      )
    }
  }

  const result = await runProperty(property, baseParameters)
  if (!result.failed) return result

  const file = await persistFailure(normalizedId, result)
  throw new Error(
    `Property "${normalizedId}" failed with seed ${result.seed} at path "${result.counterexamplePath ?? ''}"; evidence written to ${file}`
  )
}
