// Drop and rebuild the local test database from supabase/migrations/.
//
//   docker compose up -d
//   npm run db:reset
//
// Refuses to run against anything that is not obviously a local database. This
// script drops the public schema; pointing it at production would be
// unrecoverable, so the guard is deliberately blunt rather than clever.

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'

const DEFAULT_URL = 'postgres://billyai:billyai@localhost:54331/billyai'
const url = process.env.DATABASE_URL ?? DEFAULT_URL

const host = new URL(url).hostname
if (!['localhost', '127.0.0.1', '::1', 'db'].includes(host)) {
  console.error(
    `Refusing to reset a non-local database (host: ${host}).\n` +
    `This drops the public schema. If you really mean it, do it by hand.`,
  )
  process.exit(1)
}

const client = new pg.Client({ connectionString: url })
await client.connect()

console.log(`Resetting ${host}…`)
await client.query('DROP SCHEMA IF EXISTS public CASCADE')
await client.query('CREATE SCHEMA public')

const dir = join(import.meta.dirname, '..', 'supabase', 'migrations')
const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()

for (const file of files) {
  const sql = await readFile(join(dir, file), 'utf8')
  try {
    await client.query(sql)
    console.log(`  ${file}`)
  } catch (err) {
    console.error(`\n${file} failed:\n${err.message}`)
    await client.end()
    process.exit(1)
  }
}

await client.end()
console.log(`Applied ${files.length} migration(s).`)
