import { runSyntheticPurchaseCli } from './lib/synthetic-purchase'

process.exitCode = await runSyntheticPurchaseCli(process.argv.slice(2), {
  log: (line) => process.stdout.write(`${line}\n`)
})
