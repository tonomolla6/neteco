import { spawn, type ChildProcess } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCatalogCsvCells } from '../../shared/catalog-tabular-core'
import {
  buildFunctionalDeliveryPlan,
  validateFunctionalDeliveryPlan,
  type FunctionalDeliveryPlanSnapshot,
  type FunctionalRequirementRow
} from '../../shared/functional-delivery-plan'

const REQUIRED_CSV_COLUMNS = ['id', 'phase_min', 'domain', 'priority', 'status', 'requirement', 'acceptance'] as const
const REQUIREMENT_STATUSES = new Set([
  'REPO_EVIDENCE',
  'PARTIAL_EXTERNAL',
  'MISSING',
  'NOT_VERIFIED',
  'ROADMAP_NOT_STARTED',
  'DISCARDED'
])
const TEST_ROOTS = ['tests/unit', 'tests/components'] as const
const MAX_CSV_BYTES = 20_000_000

export interface FunctionalDeliveryCliArgs {
  moduleIds: string[]
  run: boolean
  gate: boolean
  json: boolean
  help: boolean
}

export interface FunctionalDeliveryCommand {
  label: string
  executable: 'npm' | 'vitest'
  args: string[]
}

export interface FunctionalDeliverySpawnSpec {
  executable: string
  args: string[]
  cwd: string
  stdio: 'inherit'
  shell: false
  detached: boolean
}

export interface FunctionalDeliverySelection {
  manifestId: string
  plannedModuleCount: number
  dependencySemantics: FunctionalDeliveryPlanSnapshot['dependencySemantics']
  sharedContracts: FunctionalDeliveryPlanSnapshot['sharedContracts']
  fronts: FunctionalDeliveryPlanSnapshot['fronts']
  rootIntegration: FunctionalDeliveryPlanSnapshot['rootIntegration']
  totals: FunctionalDeliveryPlanSnapshot['totals']
  modules: FunctionalDeliveryPlanSnapshot['modules']
  selectedRequirementCount: number
  selectedRequirementIds: string[]
  testSelectors: string[]
}

export interface FunctionalDeliveryReport {
  execution: 'dry-plan'
  manifestId: string
  plannedModuleCount: number
  dependencySemantics: FunctionalDeliveryPlanSnapshot['dependencySemantics']
  sharedContracts: FunctionalDeliveryPlanSnapshot['sharedContracts']
  fronts: FunctionalDeliveryPlanSnapshot['fronts']
  rootIntegration: FunctionalDeliveryPlanSnapshot['rootIntegration']
  denominator: {
    historicalRequirementCount: number
    activeRequirementCount: number
    discardedRequirementCount: number
  }
  historicalStatusCounts: Record<string, number>
  activeStatusCounts: Record<string, number>
  selectedModuleIds: string[]
  selectedRequirementCount: number
  selectedStatusCounts: Record<string, number>
  requirements: FunctionalRequirementRow[]
  testSelectorCount: number
  testSelectors: string[]
  modules: Array<{
    id: string
    title: string
    frontId: string
    dependsOn: string[]
    dependsOnContracts: string[]
    riskCategories: string[]
    requirementCount: number
    countsByStatus: Record<string, number>
    testSelectors: string[]
  }>
  evidenceBoundary: string
}

export interface FunctionalDeliveryCommandResult {
  exitCode: number
  completed: number
  stoppedAt: string | null
  error?: string
}

function usageError(message: string): Error {
  return new Error(`${message}\n${functionalDeliveryUsage()}`)
}

export function functionalDeliveryUsage(): string {
  return 'Usage: npm run development:plan -- [--module <id> ...] [--run] [--json] | [--gate] [--run] [--json]'
}

export function parseFunctionalDeliveryArgs(argv: readonly string[]): FunctionalDeliveryCliArgs {
  const result: FunctionalDeliveryCliArgs = { moduleIds: [], run: false, gate: false, json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--module') {
      const moduleId = argv[index + 1]
      if (!moduleId || moduleId.startsWith('--') || !moduleId.trim()) throw usageError('--module requires a module ID')
      if (result.moduleIds.includes(moduleId)) throw usageError(`Duplicate --module value: ${moduleId}`)
      result.moduleIds.push(moduleId)
      index += 1
    } else if (argument === '--run') {
      if (result.run) throw usageError('Duplicate --run flag')
      result.run = true
    } else if (argument === '--gate') {
      if (result.gate) throw usageError('Duplicate --gate flag')
      result.gate = true
    } else if (argument === '--json') {
      if (result.json) throw usageError('Duplicate --json flag')
      result.json = true
    } else if (argument === '--help' || argument === '-h') {
      result.help = true
    } else {
      throw usageError(`Unknown functional delivery option: ${argument}`)
    }
  }

  if (result.gate && result.moduleIds.length > 0) {
    throw usageError('--gate is global and cannot be combined with --module')
  }
  if (result.json && result.run) throw usageError('--json is available for dry plans only; omit --run')
  return result
}

export function parseFunctionalRequirementRows(csvText: string): FunctionalRequirementRow[] {
  if (Buffer.byteLength(csvText, 'utf8') > MAX_CSV_BYTES)
    throw new Error('Functional requirement CSV exceeds the 20 MB limit')
  const cells = parseCatalogCsvCells(csvText, { maxRows: 5_000, maxColumns: 32, maxCellCharacters: 20_000 })
  if (cells.length < 2) throw new Error('Functional requirement CSV must include a header and at least one row')

  const header = cells[0]!.map((cell, index) => (index === 0 ? cell.replace(/^\uFEFF/, '') : cell))
  const headerIndexes = new Map<string, number>()
  for (let index = 0; index < header.length; index += 1) {
    const column = header[index]!.trim()
    if (!column) throw new Error(`Functional requirement CSV has an empty header at column ${index + 1}`)
    if (headerIndexes.has(column)) throw new Error(`Functional requirement CSV has a duplicate header: ${column}`)
    headerIndexes.set(column, index)
  }
  const missingColumns = REQUIRED_CSV_COLUMNS.filter((column) => !headerIndexes.has(column))
  if (missingColumns.length > 0)
    throw new Error(`Functional requirement CSV is missing required columns: ${missingColumns.join(', ')}`)

  const rows: FunctionalRequirementRow[] = []
  const seenIds = new Set<string>()
  for (let rowIndex = 1; rowIndex < cells.length; rowIndex += 1) {
    const cellsForRow = cells[rowIndex]!
    if (cellsForRow.every((cell) => cell.trim() === '')) continue
    if (cellsForRow.length !== header.length) {
      throw new Error(
        `Functional requirement CSV row ${rowIndex + 1} has ${cellsForRow.length} columns; expected ${header.length}`
      )
    }
    const value = (column: (typeof REQUIRED_CSV_COLUMNS)[number]) => cellsForRow[headerIndexes.get(column)!]!.trim()
    const row: FunctionalRequirementRow = {
      id: value('id'),
      phase_min: value('phase_min'),
      domain: value('domain'),
      priority: value('priority'),
      status: value('status'),
      requirement: value('requirement'),
      acceptance: value('acceptance')
    }
    if (!row.id) throw new Error(`Functional requirement CSV row ${rowIndex + 1} has an empty ID`)
    if (seenIds.has(row.id)) throw new Error(`Functional requirement CSV has duplicate requirement ID ${row.id}`)
    seenIds.add(row.id)
    if (!row.phase_min || !row.domain || !row.priority || !row.requirement || !row.acceptance) {
      throw new Error(`Functional requirement CSV row ${rowIndex + 1} is missing a required value`)
    }
    if (!REQUIREMENT_STATUSES.has(row.status)) {
      throw new Error(`Functional requirement CSV row ${rowIndex + 1} has unknown status ${row.status || '(empty)'}`)
    }
    rows.push(row)
  }
  if (rows.length === 0) throw new Error('Functional requirement CSV contains no requirement rows')
  return rows
}

export async function inventoryFunctionalDeliveryTestSelectors(rootDir: string): Promise<Set<string>> {
  const inventory = new Set<string>()
  for (const testRoot of TEST_ROOTS) {
    const absoluteRoot = resolve(rootDir, testRoot)
    async function visit(directory: string): Promise<void> {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      for (const entry of entries) {
        const absolutePath = resolve(directory, entry.name)
        if (entry.isDirectory()) {
          await visit(absolutePath)
        } else if (entry.isFile() && /\.(?:test|spec)\.ts$/.test(entry.name)) {
          const relativePath = absolutePath
            .slice(resolve(rootDir).length + 1)
            .split(sep)
            .join('/')
          inventory.add(relativePath)
        }
      }
    }
    await visit(absoluteRoot)
  }
  return inventory
}

function validateSafeSelector(selector: string): void {
  if (
    selector.includes('\\') ||
    selector.startsWith('/') ||
    selector.split('/').includes('..') ||
    selector.split('/').includes('.') ||
    selector.startsWith('-') ||
    !TEST_ROOTS.some((root) => selector.startsWith(`${root}/`)) ||
    !/\.(?:test|spec)\.ts$/.test(selector)
  ) {
    throw new Error(`Functional delivery selector is not an allowed local Vitest test path: ${selector}`)
  }
}

export function resolveFunctionalDeliverySelection(
  snapshot: FunctionalDeliveryPlanSnapshot,
  requestedModuleIds: readonly string[] = [],
  selectorExists: (selector: string) => boolean = () => true
): FunctionalDeliverySelection {
  const moduleIds = new Set<string>()
  for (const moduleId of requestedModuleIds) {
    if (moduleIds.has(moduleId)) throw new Error(`Duplicate module selection: ${moduleId}`)
    moduleIds.add(moduleId)
  }
  const knownIds = new Set(snapshot.modules.map((module) => module.id))
  const unknownIds = [...moduleIds].filter((moduleId) => !knownIds.has(moduleId))
  if (unknownIds.length > 0)
    throw new Error(`Unknown module ID${unknownIds.length > 1 ? 's' : ''}: ${unknownIds.join(', ')}`)

  const selectedModules = snapshot.modules.filter((module) => moduleIds.size === 0 || moduleIds.has(module.id))
  const selectors: string[] = []
  const seenSelectors = new Set<string>()
  for (const module of selectedModules) {
    for (const selector of module.testSelectors) {
      validateSafeSelector(selector)
      if (!selectorExists(selector))
        throw new Error(`Functional delivery selector was not found in the test path inventory: ${selector}`)
      if (!seenSelectors.has(selector)) {
        selectors.push(selector)
        seenSelectors.add(selector)
      }
    }
  }

  const selectedRequirementIds = [...new Set(selectedModules.flatMap((module) => module.requirementIds))]
  return {
    manifestId: snapshot.manifestId,
    plannedModuleCount: snapshot.modules.length,
    dependencySemantics: snapshot.dependencySemantics,
    sharedContracts: snapshot.sharedContracts,
    fronts: snapshot.fronts,
    rootIntegration: snapshot.rootIntegration,
    totals: snapshot.totals,
    modules: selectedModules,
    selectedRequirementCount: selectedRequirementIds.length,
    selectedRequirementIds,
    testSelectors: selectors
  }
}

function countActiveStatuses(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([status]) => status !== 'DISCARDED'))
}

export function createFunctionalDeliveryReport(selection: FunctionalDeliverySelection): FunctionalDeliveryReport {
  const selectedStatusCounts: Record<string, number> = {}
  for (const module of selection.modules) {
    for (const [status, count] of Object.entries(module.counts.byStatus)) {
      if (status !== 'DISCARDED') selectedStatusCounts[status] = (selectedStatusCounts[status] ?? 0) + count
    }
  }
  return {
    execution: 'dry-plan',
    manifestId: selection.manifestId,
    plannedModuleCount: selection.plannedModuleCount,
    dependencySemantics: selection.dependencySemantics,
    sharedContracts: selection.sharedContracts,
    fronts: selection.fronts,
    rootIntegration: selection.rootIntegration,
    denominator: {
      historicalRequirementCount: selection.totals.historicalRequirementCount,
      activeRequirementCount: selection.totals.activeRequirementCount,
      discardedRequirementCount: selection.totals.discardedRequirementCount
    },
    historicalStatusCounts: { ...selection.totals.byStatus },
    activeStatusCounts: countActiveStatuses(selection.totals.byStatus),
    selectedModuleIds: selection.modules.map((module) => module.id),
    selectedRequirementCount: selection.selectedRequirementCount,
    selectedStatusCounts,
    requirements: selection.modules
      .flatMap((module) => module.requirements)
      .map((row) => ({ ...row }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    testSelectorCount: selection.testSelectors.length,
    testSelectors: selection.testSelectors,
    modules: selection.modules.map((module) => ({
      id: module.id,
      title: module.title,
      frontId: module.frontId,
      dependsOn: [...module.dependsOn],
      dependsOnContracts: [...module.dependsOnContracts],
      riskCategories: [...module.riskCategories],
      requirementCount: module.requirementIds.length,
      countsByStatus: countActiveStatuses(module.counts.byStatus),
      testSelectors: [...module.testSelectors]
    })),
    evidenceBoundary:
      'These selectors are local regression tests only; they do not assert production acceptance or close external/operational requirements.'
  }
}

export function formatFunctionalDeliveryReport(report: FunctionalDeliveryReport): string {
  const focus =
    report.selectedModuleIds.length === report.plannedModuleCount
      ? 'all planned modules'
      : report.selectedModuleIds.join(', ')
  const statusCounts = Object.entries(report.activeStatusCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count}`)
    .join('  ')
  const lines = [
    `Functional delivery plan: ${report.manifestId}`,
    'Mode: dry plan; no tests were executed.',
    `Requirements: active ${report.denominator.activeRequirementCount} / historical ${report.denominator.historicalRequirementCount}; discarded ${report.denominator.discardedRequirementCount}.`,
    `Active requirement statuses: ${statusCounts || 'none'}.`,
    `Focus: ${focus}; assigned active requirements ${report.selectedRequirementCount}; resolved test selectors ${report.testSelectorCount}.`,
    'Module coverage and current assigned statuses:'
  ]
  for (const module of report.modules) {
    const statuses = Object.entries(module.countsByStatus)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `${status}=${count}`)
      .join(', ')
    lines.push(
      `- ${module.id} — ${module.title}: ${module.requirementCount} active requirements (${statuses || 'no active status rows'}); ${module.testSelectors.length} selector(s).`
    )
    for (const selector of module.testSelectors) lines.push(`  - ${selector}`)
  }
  lines.push(`Evidence boundary: ${report.evidenceBoundary}`)
  return lines.join('\n')
}

export function buildFunctionalDeliveryTestBatches(
  selection: FunctionalDeliverySelection
): FunctionalDeliveryCommand[] {
  const unit = selection.testSelectors.filter((selector) => selector.startsWith('tests/unit/'))
  const component = selection.testSelectors.filter((selector) => selector.startsWith('tests/components/'))
  const commands: FunctionalDeliveryCommand[] = []
  if (unit.length > 0) {
    commands.push({
      label: 'Selected unit tests',
      executable: 'vitest',
      args: ['run', '--config', 'vitest.node.config.ts', '--project', 'unit', '--maxWorkers=2', ...unit]
    })
  }
  if (component.length > 0) {
    commands.push({
      label: 'Selected component tests (serial)',
      executable: 'vitest',
      args: ['run', '--project', 'component', '--maxWorkers=1', '--no-file-parallelism', ...component]
    })
  }
  return commands
}

export function buildFunctionalDeliveryGateCommands(): FunctionalDeliveryCommand[] {
  return [
    { label: 'Format check', executable: 'npm', args: ['run', 'format:check'] },
    { label: 'Lint', executable: 'npm', args: ['run', 'lint'] },
    { label: 'Worker TypeScript', executable: 'npm', args: ['run', 'typecheck:worker'] },
    { label: 'Nuxt TypeScript', executable: 'npm', args: ['run', 'typecheck'] },
    { label: 'Node audit TypeScript', executable: 'npm', args: ['run', 'typecheck:audit'] },
    {
      label: 'All unit tests',
      executable: 'vitest',
      args: ['run', '--config', 'vitest.node.config.ts', '--project', 'unit', '--maxWorkers=2']
    },
    {
      label: 'All component tests (serial)',
      executable: 'vitest',
      args: ['run', '--project', 'component', '--maxWorkers=1', '--no-file-parallelism']
    },
    { label: 'Cloudflare UI build', executable: 'npm', args: ['run', 'build:cloudflare-ui'] },
    { label: 'Worker build', executable: 'npm', args: ['run', 'build:worker-shop'] },
    { label: 'Bundle audit', executable: 'npm', args: ['run', 'audit:shop-bundle'] },
    { label: 'Native audit', executable: 'npm', args: ['run', 'audit:shop:local'] },
    { label: 'Read-only requirements audit', executable: 'npm', args: ['run', 'requirements:audit'] }
  ]
}

export type FunctionalDeliveryExecutor = (command: FunctionalDeliveryCommand) => Promise<number>

export async function executeFunctionalDeliveryCommands(
  commands: readonly FunctionalDeliveryCommand[],
  executor: FunctionalDeliveryExecutor
): Promise<FunctionalDeliveryCommandResult> {
  let completed = 0
  for (const command of commands) {
    let exitCode: number
    try {
      exitCode = await executor(command)
    } catch (error) {
      return {
        exitCode: 1,
        completed,
        stoppedAt: command.label,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    if (exitCode !== 0) return { exitCode, completed, stoppedAt: command.label }
    completed += 1
  }
  return { exitCode: 0, completed, stoppedAt: null }
}

export function createFunctionalDeliverySpawnSpec(
  command: FunctionalDeliveryCommand,
  rootDir: string
): FunctionalDeliverySpawnSpec {
  if (command.executable === 'npm') {
    return {
      executable: 'npm',
      args: [...command.args],
      cwd: rootDir,
      stdio: 'inherit',
      shell: false,
      detached: process.platform !== 'win32'
    }
  }
  const vitestEntrypoint = resolve(rootDir, 'node_modules/vitest/vitest.mjs')
  return {
    executable: process.execPath,
    args: [vitestEntrypoint, ...command.args],
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
    detached: process.platform !== 'win32'
  }
}

function runOwnChild(command: FunctionalDeliveryCommand, rootDir: string): Promise<number> {
  const invocation = createFunctionalDeliverySpawnSpec(command, rootDir)
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess
    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd: invocation.cwd,
        stdio: invocation.stdio,
        shell: invocation.shell,
        detached: invocation.detached
      })
    } catch (error) {
      rejectPromise(error)
      return
    }

    let requestedSignal: NodeJS.Signals | undefined
    const interruptChild = (signal: NodeJS.Signals) => {
      requestedSignal = signal
      if (!child.pid || child.exitCode !== null) return
      if (!invocation.detached) {
        child.kill(signal)
        return
      }
      // The detached group was created by this spawn. Signalling only npm's
      // direct PID can orphan its compiler/test descendants on cancellation.
      try {
        process.kill(-child.pid, signal)
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal)
      }
    }
    const onSigInt = () => interruptChild('SIGINT')
    const onSigTerm = () => interruptChild('SIGTERM')
    process.once('SIGINT', onSigInt)
    process.once('SIGTERM', onSigTerm)

    let settled = false
    const cleanup = () => {
      process.removeListener('SIGINT', onSigInt)
      process.removeListener('SIGTERM', onSigTerm)
    }
    child.once('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      rejectPromise(error)
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      cleanup()
      if (requestedSignal) {
        resolvePromise(requestedSignal === 'SIGINT' ? 130 : 143)
      } else if (code !== null) {
        resolvePromise(code)
      } else {
        resolvePromise(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)
      }
    })
  })
}

export async function executeFunctionalDeliveryLocally(
  commands: readonly FunctionalDeliveryCommand[],
  rootDir: string
): Promise<FunctionalDeliveryCommandResult> {
  return executeFunctionalDeliveryCommands(commands, (command) => runOwnChild(command, rootDir))
}

export async function loadFunctionalDeliveryPlan(rootDir: string): Promise<FunctionalDeliveryPlanSnapshot> {
  const csvPath = resolve(rootDir, 'docs/production/requirements-traceability.csv')
  const rows = parseFunctionalRequirementRows(await readFile(csvPath, 'utf8'))
  const selectorInventory = await inventoryFunctionalDeliveryTestSelectors(rootDir)
  const snapshot = buildFunctionalDeliveryPlan(rows)
  const validationErrors = validateFunctionalDeliveryPlan(snapshot, rows, {
    selectorExists: (selector) => selectorInventory.has(selector)
  })
  if (validationErrors.length > 0) {
    throw new Error(`Functional delivery plan validation failed:\n- ${validationErrors.join('\n- ')}`)
  }
  return snapshot
}

export interface FunctionalDeliveryCliRuntime {
  rootDir: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  executeCommands?: (
    commands: readonly FunctionalDeliveryCommand[],
    rootDir: string
  ) => Promise<FunctionalDeliveryCommandResult>
  loadPlan?: (rootDir: string) => Promise<FunctionalDeliveryPlanSnapshot>
}

function printCommandFailure(
  result: FunctionalDeliveryCommandResult,
  noun: 'batch' | 'step',
  stderr: (text: string) => void
): void {
  if (!result.stoppedAt) return
  stderr(
    `Stopped at ${result.stoppedAt} (exit ${result.exitCode}) after ${result.completed} completed ${noun}(s).${result.error ? ` ${result.error}` : ''}\n`
  )
}

export async function runFunctionalDeliveryCli(
  argv: readonly string[],
  runtime: FunctionalDeliveryCliRuntime
): Promise<number> {
  try {
    const options = parseFunctionalDeliveryArgs(argv)
    if (options.help) {
      runtime.stdout(`${functionalDeliveryUsage()}\n`)
      runtime.stdout(
        'Without flags, show the grouped dry plan. --run executes only registered local unit/component tests. --gate shows the fixed local gate; --gate --run executes it.\n'
      )
      return 0
    }

    const executeCommands = runtime.executeCommands ?? executeFunctionalDeliveryLocally
    if (options.gate) {
      const commands = buildFunctionalDeliveryGateCommands()
      if (options.json) {
        const report = {
          event: 'functional_delivery.gate_plan',
          execution: 'dry-plan',
          validationBoundary: 'local-only',
          stopsOnFailure: true,
          commands: commands.map((command) => ({
            label: command.label,
            executable: command.executable,
            args: [...command.args]
          }))
        }
        runtime.stdout(`${JSON.stringify(report, null, 2)}\n`)
      } else {
        runtime.stdout('Fixed local functional-delivery gate (dry plan; use --run to execute), in serial order:\n')
        for (const command of commands)
          runtime.stdout(`- ${command.label}: ${command.executable} ${command.args.join(' ')}\n`)
      }
      if (!options.run) return 0
      runtime.stdout('Executing the fixed local gate sequentially; the first non-zero result stops the batch.\n')
      const result = await executeCommands(commands, runtime.rootDir)
      printCommandFailure(result, 'step', runtime.stderr)
      return result.exitCode
    }

    const snapshot = await (runtime.loadPlan ?? loadFunctionalDeliveryPlan)(runtime.rootDir)
    const selection = resolveFunctionalDeliverySelection(snapshot, options.moduleIds)
    const report = createFunctionalDeliveryReport(selection)
    runtime.stdout(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatFunctionalDeliveryReport(report)}\n`
    )
    if (!options.run) return 0

    const commands = buildFunctionalDeliveryTestBatches(selection)
    if (commands.length === 0) {
      runtime.stderr(
        'No registered unit/component selectors can be executed for this selection. The dry plan remains available with no --run.\n'
      )
      return 2
    }
    runtime.stdout(
      'Executing selected local regression tests in one batch per Vitest project. These results are not production acceptance.\n'
    )
    for (const command of commands)
      runtime.stdout(`- ${command.label}: ${command.executable} ${command.args.join(' ')}\n`)
    const result = await executeCommands(commands, runtime.rootDir)
    printCommandFailure(result, 'batch', runtime.stderr)
    return result.exitCode
  } catch (error) {
    runtime.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export function getFunctionalDeliveryRepositoryRoot(scriptUrl: string): string {
  return fileURLToPath(new URL('../', scriptUrl))
}
