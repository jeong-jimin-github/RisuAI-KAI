import { defineConfig } from 'drizzle-kit'
import { resolve } from 'node:path'

export default defineConfig({
    schema: './src/db/schema.ts',
    out: './drizzle',
    dialect: 'sqlite',
    dbCredentials: {
        url: resolve(process.env.KAI_DATA_DIR ?? './data', process.env.KAI_DB_FILE ?? 'kai.db'),
    },
    verbose: true,
    strict: true,
})
