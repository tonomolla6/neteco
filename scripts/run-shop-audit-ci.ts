import { runOracleShopAudit } from './lib/oracle-shop-audit'

if (process.argv.length !== 2) {
  process.stderr.write('Shop CI audit accepts no command-line arguments.\n')
  process.exitCode = 1
} else {
  runOracleShopAudit().then(
    (code) => {
      process.exitCode = code
    },
    () => {
      // Browser/provider exceptions can contain the private websocket endpoint.
      process.stderr.write('Shop CI audit failed; inspect the preceding audit results.\n')
      process.exitCode = 1
    }
  )
}
