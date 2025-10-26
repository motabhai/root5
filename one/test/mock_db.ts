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

export default MockD1