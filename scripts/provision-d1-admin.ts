import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  applyD1AdminBootstrap,
  bootstrapWranglerArguments,
  inspectD1AdminBootstrap,
  parseBootstrapArguments
} from './lib/d1-admin-bootstrap'

const execute = promisify(execFile)
const cwd = fileURLToPath(new URL('..', import.meta.url))
try {
  const options = parseBootstrapArguments(process.argv.slice(2))
  const query = async (sql: string): Promise<Record<string, unknown>[]> => {
    const { stdout } = await execute(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      bootstrapWranglerArguments(sql),
      {
        cwd,
        maxBuffer: 1024 * 1024,
        timeout: 60000
      }
    )
    const rows = JSON.parse(stdout) as Array<{ success: boolean; results: Record<string, unknown>[] }>
    if (rows.length !== 1 || rows[0]?.success !== true || !Array.isArray(rows[0].results))
      throw new Error('bootstrap_d1_unavailable')
    return rows[0].results
  }
  const result = options.apply
    ? await applyD1AdminBootstrap(
        {
          identityId: options.identityId,
          commandId: options.commandId!,
          expectedPlanHash: options.expectedPlanHash!,
          reason: options.reason!
        },
        query
      )
    : { mode: 'plan', target: 'local-d1-only', ...(await inspectD1AdminBootstrap(options.identityId, query)) }
  process.stdout.write(JSON.stringify(result) + '\n')
} catch {
  // Never print Wrangler errors/SQL, secrets or arbitrary user-supplied input.
  process.stderr.write(
    'Bootstrap no confirmado. Revisa el plan local, la cuenta verificada y MFA. Si el envío pudo aplicarse, conserva y consulta el mismo command-id; no crees otro.\n'
  )
  process.exitCode = 1
}
