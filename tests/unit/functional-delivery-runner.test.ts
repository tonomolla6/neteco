import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { FunctionalDeliveryPlanSnapshot, FunctionalRequirementRow } from '../../shared/functional-delivery-plan'
import type { FunctionalDeliveryCommand } from '../../scripts/lib/functional-delivery-runner'
import {
  buildFunctionalDeliveryGateCommands,
  buildFunctionalDeliveryTestBatches,
  createFunctionalDeliveryReport,
  createFunctionalDeliverySpawnSpec,
  executeFunctionalDeliveryCommands,
  parseFunctionalDeliveryArgs,
  parseFunctionalRequirementRows,
  resolveFunctionalDeliverySelection,
  runFunctionalDeliveryCli
} from '../../scripts/lib/functional-delivery-runner'

const activeRows: FunctionalRequirementRow[] = [
  {
    id: 'CAT-001',
    phase_min: 'MVP',
    domain: 'Catálogo',
    priority: 'P0',
    status: 'REPO_EVIDENCE',
    requirement: 'Maestro de catálogo',
    acceptance: 'Matriz aprobada'
  },
  {
    id: 'CAT-002',
    phase_min: 'Alpha',
    domain: 'Catálogo',
    priority: 'P1',
    status: 'MISSING',
    requirement: 'Validar SKU',
    acceptance: 'No permite duplicados'
  },
  {
    id: 'PAY-001',
    phase_min: 'Alpha',
    domain: 'Pagos',
    priority: 'P0',
    status: 'PARTIAL_EXTERNAL',
    requirement: 'Autorizar pago',
    acceptance: 'Contrato vigente'
  },
  {
    id: 'OLD-001',
    phase_min: 'MVP',
    domain: 'Fuera de alcance',
    priority: 'P3',
    status: 'DISCARDED',
    requirement: 'Requisito descartado',
    acceptance: 'No aplica'
  }
]

function snapshot(): FunctionalDeliveryPlanSnapshot {
  return {
    manifestId: 'functional-delivery-v1',
    execution: ['prepare-tests', 'implement-fronts', 'root-integration', 'joint-tests'],
    dependencySemantics: 'entry-contracts-only',
    sharedContracts: [{ id: 'catalog-base', owner: 'root', purpose: 'Shared catalog integration boundary' }],
    fronts: [
      { id: 'catalog-front', title: 'Catálogo', purpose: 'Implementar catálogo' },
      { id: 'commerce-front', title: 'Comercio', purpose: 'Implementar pagos' }
    ],
    modules: [
      {
        id: 'catalog',
        title: 'Catálogo',
        ownership: [{ kind: 'prefix', prefix: 'CAT-' }],
        dependsOn: [],
        dependsOnContracts: ['catalog-base'],
        testSelectors: ['tests/unit/catalog.test.ts', 'tests/unit/catalog.test.ts', 'tests/components/catalog.test.ts'],
        riskCategories: ['data-integrity'],
        frontId: 'catalog-front',
        requirementIds: ['CAT-001', 'CAT-002'],
        requirements: activeRows.slice(0, 2),
        counts: {
          total: 2,
          byStatus: { REPO_EVIDENCE: 1, MISSING: 1 },
          byPriority: { P0: 1, P1: 1 },
          byPhase: { MVP: 1, Alpha: 1 }
        }
      },
      {
        id: 'payments',
        title: 'Pagos',
        ownership: [{ kind: 'prefix', prefix: 'PAY-' }],
        dependsOn: ['catalog'],
        dependsOnContracts: ['catalog-base'],
        testSelectors: ['tests/unit/payments.test.ts'],
        riskCategories: ['payment-and-fiscal'],
        frontId: 'commerce-front',
        requirementIds: ['PAY-001'],
        requirements: [activeRows[2]!],
        counts: {
          total: 1,
          byStatus: { PARTIAL_EXTERNAL: 1 },
          byPriority: { P0: 1 },
          byPhase: { Alpha: 1 }
        }
      }
    ],
    excludedRequirementIds: ['OLD-001'],
    excludedRequirements: [activeRows[3]!],
    rootIntegration: { owner: 'root', dependsOnFrontIds: ['catalog-front', 'commerce-front'] },
    validationBoundary: 'local-only',
    totals: {
      historicalRequirementCount: 4,
      activeRequirementCount: 3,
      discardedRequirementCount: 1,
      byStatus: { REPO_EVIDENCE: 1, MISSING: 1, PARTIAL_EXTERNAL: 1, DISCARDED: 1 },
      byPriority: { P0: 2, P1: 1, P3: 1 },
      byPhase: { MVP: 2, Alpha: 2 }
    }
  }
}

describe('functional delivery batch runner', () => {
  it('typechecks every own Node auditor/harness root without Nuxt-generated config, aliases or source exclusions', () => {
    const root = process.cwd()
    const config = ts.readConfigFile(resolve(root, 'tsconfig.audit.json'), ts.sys.readFile)
    expect(config.error).toBeUndefined()
    expect(config.config.extends).toBeUndefined()
    expect(config.config.exclude).toBeUndefined()
    expect(config.config.compilerOptions.paths).toBeUndefined()
    expect(config.config.compilerOptions).toMatchObject({
      noEmit: true,
      strict: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      target: 'esnext',
      lib: ['esnext', 'dom', 'dom.iterable'],
      types: ['node'],
      allowImportingTsExtensions: true
    })
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
    expect(parsed.errors).toEqual([])
    const included = new Set(parsed.fileNames.map((file) => relative(root, file).replaceAll('\\', '/')))
    const expected = [
      'worker-configuration.d.ts',
      'scripts/functional-delivery.ts',
      ...readdirSync(resolve(root, 'scripts'))
        .filter((name) => /^(?:audit|run|test)-.*\.ts$/.test(name))
        .map((name) => 'scripts/' + name)
    ]
    function visit(directory: string) {
      for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
        const path = directory + '/' + entry.name
        if (entry.isDirectory()) visit(path)
        else if (entry.isFile() && path.endsWith('.ts')) expected.push(path)
      }
    }
    visit('scripts/lib')
    expect(expected.length).toBeGreaterThan(1)
    expect(expected.filter((file) => !included.has(file))).toEqual([])
    expect(included.has('scripts/audit-cloudflare-shop.ts')).toBe(true)
    expect(included.has('scripts/lib/audit-native-catalog-import-browser.ts')).toBe(true)
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['typecheck:audit']).toBe('tsc --noEmit -p tsconfig.audit.json')
  })

  it('checks Node auditors in Cloudflare CI before compiling or executing the shop audit', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/cloudflare-compat.yml'), 'utf8')
    const shop = workflow.split('  shop-runtime:')[1]!.split('  worker-canary:')[0]!
    const ordered = [
      'npm ci',
      'npm run typecheck:audit',
      'npm run build:cloudflare-ui',
      'npm run build:worker-shop',
      'npm run audit:shop-bundle',
      'npx playwright install chromium',
      'npm run audit:shop:ci'
    ]
    const positions = ordered.map((command) => shop.indexOf('- run: ' + command))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(shop.match(/- run: npm run typecheck:audit/g)).toHaveLength(1)
    expect(workflow).toContain('- run: npm run typecheck:worker')
  })

  it('rejects unknown, duplicated, conflicting and incomplete CLI options', () => {
    expect(() => parseFunctionalDeliveryArgs(['--wat'])).toThrow(/unknown/i)
    expect(() => parseFunctionalDeliveryArgs(['--module', 'catalog', '--module', 'catalog'])).toThrow(/duplicate/i)
    expect(parseFunctionalDeliveryArgs(['--gate', '--run'])).toMatchObject({ gate: true, run: true })
    expect(parseFunctionalDeliveryArgs(['--gate', '--json'])).toMatchObject({ gate: true, json: true })
    expect(() => parseFunctionalDeliveryArgs(['--gate', '--module', 'catalog'])).toThrow(/cannot be combined/i)
    expect(() => parseFunctionalDeliveryArgs(['--module'])).toThrow(/module/i)
    expect(() => parseFunctionalDeliveryArgs(['--module', '--run'])).toThrow(/module/i)
    expect(() => parseFunctionalDeliveryArgs(['--json', '--run'])).toThrow(/json/i)
  })

  it('parses bounded RFC4180 requirement CSV and rejects malformed headers, status and duplicate IDs', () => {
    const csv = [
      'id,phase_min,domain,priority,status,requirement,acceptance',
      'CAT-001,MVP,"Catálogo, público",P0,REPO_EVIDENCE,"Requisito, con coma","Criterio con ""comillas"""'
    ].join('\r\n')
    expect(parseFunctionalRequirementRows(csv)).toEqual([
      {
        id: 'CAT-001',
        phase_min: 'MVP',
        domain: 'Catálogo, público',
        priority: 'P0',
        status: 'REPO_EVIDENCE',
        requirement: 'Requisito, con coma',
        acceptance: 'Criterio con "comillas"'
      }
    ])
    expect(() => parseFunctionalRequirementRows('id,status\nCAT-001,REPO_EVIDENCE')).toThrow(/header|column/i)
    expect(() =>
      parseFunctionalRequirementRows(
        'id,phase_min,domain,priority,status,requirement,acceptance\nCAT-001,MVP,Catálogo,P0,COMPLETE,Req,Accept'
      )
    ).toThrow(/status/i)
    expect(() =>
      parseFunctionalRequirementRows(
        'id,phase_min,domain,priority,status,requirement,acceptance\nCAT-001,MVP,Catálogo,P0,MISSING,Req,Accept\nCAT-001,Alpha,Catálogo,P1,MISSING,Req2,Accept2'
      )
    ).toThrow(/duplicate/i)
  })

  it('preserves the historical denominator while focusing multiple selected modules and deduplicating selectors', () => {
    const plan = snapshot()
    const selection = resolveFunctionalDeliverySelection(plan, ['catalog', 'payments'], () => true)
    expect(selection.totals).toMatchObject({
      historicalRequirementCount: 4,
      activeRequirementCount: 3,
      discardedRequirementCount: 1
    })
    expect(selection.selectedRequirementCount).toBe(3)
    expect(selection.modules.map((module) => module.id)).toEqual(['catalog', 'payments'])
    expect(selection.testSelectors).toEqual([
      'tests/unit/catalog.test.ts',
      'tests/components/catalog.test.ts',
      'tests/unit/payments.test.ts'
    ])
    const report = createFunctionalDeliveryReport(selection)
    expect(report).toMatchObject({
      denominator: { historicalRequirementCount: 4, activeRequirementCount: 3, discardedRequirementCount: 1 },
      historicalStatusCounts: { REPO_EVIDENCE: 1, MISSING: 1, PARTIAL_EXTERNAL: 1, DISCARDED: 1 },
      selectedRequirementCount: 3
    })
    expect(report.requirements.map((row) => row.id)).toEqual(['CAT-001', 'CAT-002', 'PAY-001'])
    expect(report.evidenceBoundary).toMatch(/not.*production acceptance/i)
    expect(() => resolveFunctionalDeliverySelection(plan, ['unknown-module'], () => true)).toThrow(/unknown module/i)
    expect(() => resolveFunctionalDeliverySelection(plan, ['catalog'], () => false)).toThrow(/selector.*not found/i)
  })

  it('builds one Vitest batch per project rather than spawning per requirement', () => {
    const selection = resolveFunctionalDeliverySelection(snapshot(), ['catalog', 'payments'], () => true)
    expect(buildFunctionalDeliveryTestBatches(selection)).toEqual([
      {
        label: 'Selected unit tests',
        executable: 'vitest',
        args: [
          'run',
          '--config',
          'vitest.node.config.ts',
          '--project',
          'unit',
          '--maxWorkers=2',
          'tests/unit/catalog.test.ts',
          'tests/unit/payments.test.ts'
        ]
      },
      {
        label: 'Selected component tests (serial)',
        executable: 'vitest',
        args: [
          'run',
          '--project',
          'component',
          '--maxWorkers=1',
          '--no-file-parallelism',
          'tests/components/catalog.test.ts'
        ]
      }
    ])
  })

  it('defines one ordered local gate and runs no later command after a failure', async () => {
    const commands = buildFunctionalDeliveryGateCommands()
    expect(commands.map((command) => `${command.executable} ${command.args.join(' ')}`)).toEqual([
      'npm run format:check',
      'npm run lint',
      'npm run typecheck:worker',
      'npm run typecheck',
      'npm run typecheck:audit',
      'vitest run --config vitest.node.config.ts --project unit --maxWorkers=2',
      'vitest run --project component --maxWorkers=1 --no-file-parallelism',
      'npm run build:cloudflare-ui',
      'npm run build:worker-shop',
      'npm run audit:shop-bundle',
      'npm run audit:shop:local',
      'npm run requirements:audit'
    ])

    const execute = vi.fn(async (command: (typeof commands)[number]) => (command.label === 'Lint' ? 7 : 0))
    const result = await executeFunctionalDeliveryCommands(commands, execute)
    expect(result).toMatchObject({ exitCode: 7, completed: 1, stoppedAt: 'Lint' })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('shows the gate as a dry plan unless --run is explicit', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const executeCommands = vi.fn(async (_commands: readonly FunctionalDeliveryCommand[], _rootDir: string) => ({
      exitCode: 0,
      completed: 12,
      stoppedAt: null
    }))
    const dryExit = await runFunctionalDeliveryCli(['--gate'], {
      rootDir: '/repo',
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      executeCommands
    })
    expect(dryExit).toBe(0)
    expect(executeCommands).not.toHaveBeenCalled()
    expect(stdout.join('')).toContain('dry plan; use --run to execute')
    expect(stdout.join('')).toContain('npm run typecheck:audit')
    expect(stderr).toEqual([])

    const runExit = await runFunctionalDeliveryCli(['--gate', '--run'], {
      rootDir: '/repo',
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      executeCommands
    })
    expect(runExit).toBe(0)
    expect(executeCommands).toHaveBeenCalledTimes(1)
    expect(executeCommands.mock.calls[0]![0].map((command) => command.executable)).toContain('npm')
    expect(executeCommands.mock.calls[0]![0]).toEqual(buildFunctionalDeliveryGateCommands())
  })

  it('stops at a Node auditor type failure before starting tests, builds or native acceptance', async () => {
    const commands = buildFunctionalDeliveryGateCommands()
    const execute = vi.fn(async (command: FunctionalDeliveryCommand) =>
      command.args.join(' ') === 'run typecheck:audit' ? 2 : 0
    )
    const result = await executeFunctionalDeliveryCommands(commands, execute)
    expect(result).toEqual({ exitCode: 2, completed: 4, stoppedAt: 'Node audit TypeScript' })
    expect(execute.mock.calls.map(([command]) => command)).toEqual(commands.slice(0, 5))
  })

  it('executes only allowlisted test batches for --module with --run', async () => {
    const executeCommands = vi.fn(async (commands: readonly FunctionalDeliveryCommand[], _rootDir: string) => ({
      exitCode: 0,
      completed: commands.length,
      stoppedAt: null
    }))
    const exitCode = await runFunctionalDeliveryCli(['--module', 'catalog', '--run'], {
      rootDir: '/repo',
      stdout: () => undefined,
      stderr: () => undefined,
      loadPlan: async () => snapshot(),
      executeCommands
    })
    expect(exitCode).toBe(0)
    expect(executeCommands).toHaveBeenCalledTimes(1)
    const commands = executeCommands.mock.calls[0]![0]
    expect(commands).toHaveLength(2)
    expect(commands.every((command) => command.executable === 'vitest')).toBe(true)
    expect(commands.flatMap((command) => command.args)).not.toContain('npm')
    const spawnSpec = createFunctionalDeliverySpawnSpec(commands[0]!, '/repo')
    expect(spawnSpec).toMatchObject({ cwd: '/repo', stdio: 'inherit', shell: false })
    expect(spawnSpec.detached).toBe(process.platform !== 'win32')
    expect(spawnSpec.executable).toBe(process.execPath)
    expect(spawnSpec.args.slice(1)).toEqual(commands[0]!.args)
    expect(spawnSpec.args[0]).toBe('/repo/node_modules/vitest/vitest.mjs')
  })

  it('runs all commands serially and reports success only after the full batch', async () => {
    const commands = buildFunctionalDeliveryGateCommands()
    const order: string[] = []
    const result = await executeFunctionalDeliveryCommands(commands, async (command) => {
      order.push(command.label)
      return 0
    })
    expect(result).toEqual({ exitCode: 0, completed: commands.length, stoppedAt: null })
    expect(order).toEqual(commands.map((command) => command.label))
  })
})
