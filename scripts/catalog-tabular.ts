import { readFile, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import postgres from 'postgres'
import {
  applyCatalogImport,
  catalogRecordsFromDatabase,
  previewCatalogImport,
  rollbackCatalogImport
} from '../server/services/catalog-import'
import {
  exportCatalogCsv,
  exportCatalogXlsx,
  parseCatalogCsv,
  parseCatalogXlsx,
  validateCatalogRecords
} from '../server/services/catalog-tabular'

const connection = process.env.DATABASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
const sql = postgres(connection, { max: 1, connect_timeout: 10 })

function option(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
}

async function parse(path: string) {
  const bytes = await readFile(path)
  const extension = extname(path).toLowerCase()
  if (extension === '.csv') return parseCatalogCsv(bytes)
  if (extension === '.xlsx') return parseCatalogXlsx(bytes)
  throw new Error('Catalog tabular files must use .csv or .xlsx')
}

async function preview(path: string) {
  const validation = validateCatalogRecords(await parse(path))
  return { validation: validation.summary, ...(await previewCatalogImport(sql, validation)) }
}

try {
  const [command, pathOrBatch, version] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
  if (command === 'preview' && pathOrBatch) {
    process.stdout.write(`${JSON.stringify({ event: 'catalog.import.previewed', ...(await preview(pathOrBatch)) })}\n`)
  } else if (command === 'apply' && pathOrBatch && version) {
    const validation = validateCatalogRecords(await parse(pathOrBatch))
    if (process.argv.includes('--dry-run')) {
      process.stdout.write(
        `${JSON.stringify({ event: 'catalog.import.previewed', validation: validation.summary, ...(await previewCatalogImport(sql, validation)) })}\n`
      )
    } else {
      const candidate = await previewCatalogImport(sql, validation)
      const expectedConfirmation = `import:${version}:${candidate.checksumSha256}`
      if (process.env.APP_ENV === 'production' && process.env.CATALOG_IMPORT_CONFIRM !== expectedConfirmation) {
        throw new Error(`Set CATALOG_IMPORT_CONFIRM=${expectedConfirmation} after reviewing the production preview`)
      }
      process.stdout.write(
        `${JSON.stringify({ event: 'catalog.import.applied', ...(await applyCatalogImport(sql, validation, version)) })}\n`
      )
    }
  } else if (command === 'rollback' && pathOrBatch) {
    process.stdout.write(
      `${JSON.stringify({ event: 'catalog.import.rolled_back', ...(await rollbackCatalogImport(sql, pathOrBatch)) })}\n`
    )
  } else if (command === 'export' && pathOrBatch) {
    const records = await catalogRecordsFromDatabase(sql, { status: option('status'), sourceId: option('source-id') })
    const extension = extname(pathOrBatch).toLowerCase()
    const bytes =
      extension === '.csv'
        ? exportCatalogCsv(records)
        : extension === '.xlsx'
          ? await exportCatalogXlsx(records)
          : (() => {
              throw new Error('Catalog export path must use .csv or .xlsx')
            })()
    await writeFile(pathOrBatch, bytes, { mode: 0o600, flag: 'wx' })
    process.stdout.write(
      `${JSON.stringify({ event: 'catalog.exported', path: pathOrBatch, rows: records.length, status: option('status') ?? null, sourceId: option('source-id') ?? null })}\n`
    )
  } else {
    throw new Error(
      'Usage: catalog-tabular preview <file.csv|xlsx> | apply <file> <version> [--dry-run] | rollback <batch-id> | export <new-file.csv|xlsx> [--status=published] [--source-id=uuid]'
    )
  }
} finally {
  await sql.end({ timeout: 5 })
}
