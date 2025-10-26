import { describe, it, expect } from 'vitest'
import worker, { initDb, upsertRow, listRows } from '../src/index'
import { makeTestEnv } from './test_helper'

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
    expect(text).toContain('<h1>ONE · Customer Provisioner</h1>')
  })
})
