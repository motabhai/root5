import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import MockD1 from './mock_db'
import worker, { initDb, getRow } from '../src/index'

function makeEnv() {
  return {
    CLOUDFLARE_ACCOUNT_ID: 'acct-1',
    CLOUDFLARE_ZONE_ID: 'zone-1',
    CLOUDFLARE_API_TOKEN: 'cf-token',
    AUTH_TOKEN: 'test-token',
    DB: new MockD1()
  } as any
}

describe('provision & deprovision flow', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url
      // DNS create
      if (url.includes('/zones/') && url.includes('/dns_records') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true, result: { id: 'dns-1' } }), { status: 200 })
      }
      // DNS delete
      if (url.includes('/dns_records/') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      // Tunnel create
      if (url.includes('/cfd_tunnel') && url.endsWith('/cfd_tunnel') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true, result: { id: 'tun-1' } }), { status: 200 })
      }
      // Tunnel token
      if (url.includes('/cfd_tunnel/') && url.endsWith('/token')) {
        return new Response(JSON.stringify({ success: true, result: { token: 'tkn-1' } }), { status: 200 })
      }
      // Tunnel config PUT
      if (url.includes('/cfd_tunnel/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      // Tunnel route
      if (url.includes('/config/routes/dns') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      // Tunnel delete
      if (url.includes('/cfd_tunnel/') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      // Access app create
      if (url.includes('/access/apps') && init?.method === 'POST' && !url.includes('/policies')) {
        return new Response(JSON.stringify({ success: true, result: { id: 'app-1' } }), { status: 200 })
      }
      // Access policy create
      if (url.includes('/policies') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 })
      }
      // Access app delete
      if (url.includes('/access/apps/') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }

      // default
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 })
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('provisions and then deprovisions successfully', async () => {
    const env = makeEnv()

    // Provision
    const provisionReq = new Request('https://example.com/api/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1, domain: 'example.com', local: 'http://127.0.0.1:8081' })
    })

    const provisionRes = await (worker as any).fetch(provisionReq, env)
    const provisionBody = await provisionRes.json()
    expect(provisionBody.ok).toBe(true)
    expect(provisionBody.hostname).toBe('ha.cust1.example.com')
    expect(provisionBody.dns_record_ids).toEqual(['dns-1', 'dns-1', 'dns-1'])

    // DB row exists
    const row = await getRow(env, 1)
    expect((row as any).hostname).toBe('ha.cust1.example.com')
    expect((row as any).dns_record_ids).toEqual(['dns-1', 'dns-1', 'dns-1'])
    expect((row as any).tunnel_id).toBe('tun-1')
    expect((row as any).access_app_id).toBe('app-1')

    // Deprovision
    const deprovReq = new Request('https://example.com/api/deprovision', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1 })
    })
    const deprovRes = await (worker as any).fetch(deprovReq, env)
    const deprovBody = await deprovRes.json()
    expect(deprovBody.ok).toBe(true)

    const row2 = await getRow(env, 1)
    expect((row2 as any).dns_record_ids).toBe(null)
    expect((row2 as any).dns_record_id_ha).toBe(null)
    expect((row2 as any).dns_record_id_ssh).toBe(null)
    expect((row2 as any).dns_record_id_plc).toBe(null)
    expect((row2 as any).tunnel_id).toBe(null)
    expect((row2 as any).access_app_id).toBe(null)
  })
})
