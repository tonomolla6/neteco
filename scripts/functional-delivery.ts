import { getFunctionalDeliveryRepositoryRoot, runFunctionalDeliveryCli } from './lib/functional-delivery-runner'

async function main(): Promise<void> {
  const rootDir = getFunctionalDeliveryRepositoryRoot(import.meta.url)
  process.exitCode = await runFunctionalDeliveryCli(process.argv.slice(2), {
    rootDir,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text)
  })
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
