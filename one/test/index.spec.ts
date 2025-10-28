import { describe, it, expect } from 'vitest'
import worker, { initDb, upsertRow, listRows } from '../src/index'

// Inline mock to avoid workspace dependency issues
type Row = Record<string, unknown>

export class MockD1 {
  table = new Map<number, Row>()

  async exec(_sql: string) {
    // no-op for CREATE TABLE
    return
  }

  async teardown() {
    this.table = new Map<number, Row>()
  }

  prepare(sql: string) {
    const self = this
    const s = sql.trim()
    return {
      sql,
      _args: [] as unknown[],
      bind(...args: unknown[]) {
        this._args = args
        return this
      },
      async run() {
        // very small parser for the limited SQL used in the worker
        // INSERT OR IGNORE INTO ${table} (col, ...) VALUES (?, ?, ?)
        const ins = s.match(/INSERT OR IGNORE INTO\s+([^\s(]+)\s*\(([^)]+)\)\s*VALUES/i)
        if (ins) {
          const cols = ins[2].split(',').map((c: string) => c.trim())
          const args = this._args
          const id = Number(args[0])
          const row: Row = {}
          cols.forEach((col: string, i: number) => {
            row[col] = args[i]
          })
          self.table.set(id, { ...(self.table.get(id) || {}), ...row })
          return { success: true }
        }

        // UPDATE ${table} SET a = ?, b = ? WHERE id = ?
        const upd = s.match(/UPDATE\s+([^\s]+)\s+SET\s+([\s\S]+)WHERE\s+id\s*\=\s*\?/i)
        if (upd) {
          const setPart = upd[2]
          const keys: string[] = []
          const re = /([a-zA-Z0-9_]+)\s*\=\s*\?/g
          let m: RegExpExecArray | null
          while ((m = re.exec(setPart)) !== null) keys.push(m[1])
          const args = [...this._args]
          const id = Number(args.pop())
          const row = self.table.get(id) || {}
          keys.forEach((k, i) => {
            row[k] = args[i] === null ? null : args[i]
          })
          self.table.set(id, row)
          return { success: true }
        }

        return { success: true }
      },
      async first() {
        // SELECT * FROM table WHERE id = ?
        const sel = s.match(/SELECT\s+\*\s+FROM\s+([^\s]+)\s+WHERE\s+id\s*\=\s*\?/i)
        if (sel) {
          const id = Number(this._args[0])
          return self.table.get(id) || null
        }
        return null
      },
      async all() {
        // return all rows as array, ordered by id desc
        const arr = Array.from(self.table.values())
        return arr.slice().reverse()
      }
    }
  }
}

export function makeTestEnv() {
  const db = new MockD1()
  return {
    CLOUDFLARE_ACCOUNT_ID: 'acct-1',
    CLOUDFLARE_ZONE_ID: 'zone-1',
    CLOUDFLARE_API_TOKEN: 'cf-token',
    AUTH_TOKEN: 'test-token',
    DB: db
  } as any
}

describe('one worker basic', () => {
  it('health endpoint responds', async () => {
    const env = makeTestEnv()
    const req = new Request('https://example.com/api/health', { headers: { Authorization: 'Bearer test-token' } })
    const res = await (worker as any).fetch(req, env)
    const body = await res.json()
    expect(body).toEqual({ ok: true, service: 'one' })
  })

  it('db upsert and listRows', async () => {
    const env = makeTestEnv()
    await initDb(env)
    await upsertRow(env, 1, { hostname: 'cust1.example.com' })
    const rows = await listRows(env)
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThanOrEqual(1)
    // newest row should have hostname
    expect((rows[0] as any).hostname).toBe('cust1.example.com')
  })

  it('serves the HTML UI at the root', async () => {
    const env = makeTestEnv()
    const req = new Request('https://example.com/', { method: 'GET' })
    const res = await (worker as any).fetch(req, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const text = await res.text()
    expect(text).toContain('<h1>Customer Provisioner</h1>')
  })
})
