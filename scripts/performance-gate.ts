import { runPerformanceGateCli } from './lib/performance-gate'

process.exitCode = await runPerformanceGateCli(process.argv.slice(2), (line) => process.stdout.write(`${line}\n`))
