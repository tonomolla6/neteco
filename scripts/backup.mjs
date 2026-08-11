// Copia de seguridad consistente de la base de datos (usa la API de backup de SQLite,
// segura aunque el servidor esté escribiendo en modo WAL).
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const dest = `.data/backups/neteco-${stamp}.db`

mkdirSync('.data/backups', { recursive: true })
const db = new Database('.data/neteco.db', { readonly: true, fileMustExist: true })
await db.backup(dest)
db.close()
console.log(`Copia creada: ${dest}`)
