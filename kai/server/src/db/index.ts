import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { resolve } from 'node:path'
import { env } from '../env.js'
import * as schema from './schema.js'

const sqlite = new Database(env.dbPath)

// WAL keeps readers from blocking the single writer, which matters because the
// gateway writes usage rows on every completion while the UI polls chat lists.
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('synchronous = NORMAL')
sqlite.pragma('foreign_keys = ON')
sqlite.pragma('busy_timeout = 5000')

export const db = drizzle(sqlite, { schema })
export const rawDb = sqlite
export { schema }
export type DB = typeof db

export function migrateDatabase() {
    migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') })
}
