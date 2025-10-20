export interface Env {
  CLOUDFLARE_ACCOUNT_ID: string
  CLOUDFLARE_API_TOKEN: string
  DB: D1Database
  CUSTOMERS_TABLE?: string // default 'test_customers'
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
      return json({ error: 'Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN' }, 500)
    }

    // Health
    if (path === '/' && request.method === 'GET') {
      return json({ ok: true, service: 'Tunnel Service', mode: 'cfd_tunnel' })
    }

    // Create a remotely-managed tunnel
    if (path === '/create' && request.method === 'POST') {
      try {
        const body = await request.json() as {
          tunnelName?: string
          customerId?: string | number
          customerDomain?: string
        }

        const { tunnelName, customerId, customerDomain } = body || {}
        if (!tunnelName) return json({ error: 'Missing tunnelName' }, 400)
        if (!customerId) return json({ error: 'Missing customerId' }, 400)

        console.log(`Creating remotely-managed tunnel: ${tunnelName}`)

        const createResp = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: tunnelName,
              config_src: 'cloudflare', // required for remotely-managed
            }),
          }
        )

        const createData = await createResp.json()
        if (!createResp.ok) {
          console.error('cfd_tunnel create error:', createData)
          return json(
            { error: createData?.errors?.[0]?.message || 'Tunnel creation failed', details: createData },
            createResp.status || 500
          )
        }

        const tunnelUid: string | undefined = createData?.result?.id
        const initialToken: string | undefined = createData?.result?.token
        if (!tunnelUid) return json({ error: 'Tunnel UID missing in create response' }, 500)

        console.log(`Tunnel created: ${tunnelUid}`)

        // Save to D1
        const table = env.CUSTOMERS_TABLE || 'test_customers'
        try {
          // store the UID (used later to fetch fresh run tokens)
          // store the initial token optionally (may be used immediately but it’s short-lived)
          const stmt = env.DB.prepare(
            `UPDATE ${table} SET tunnel_uid = ?, tunnel_token = ?, customer_domain = COALESCE(?, customer_domain) WHERE id = ?`
          ).bind(tunnelUid, initialToken ?? null, customerDomain ?? null, customerId)
          const res = await stmt.run()
          if (res.success !== true) {
            console.warn('D1 UPDATE completed but not marked success:', res)
          }
          console.log(`Saved tunnel for customer ${customerId}`)
        } catch (dbErr: any) {
          console.error('Failed to save to D1:', dbErr?.message || dbErr)
          // still return success, because tunnel exists — but report DB failure in payload
          return json({
            success: true,
            tunnel: { uid: tunnelUid, initialToken },
            warnings: ['Tunnel created, but failed to save customer row to D1'],
          })
        }

        return json({ success: true, tunnel: { uid: tunnelUid, initialToken } })
      } catch (err: any) {
        console.error('Create exception:', err?.message || err)
        return json({ error: err?.message || 'Unhandled error' }, 500)
      }
    }

    return json({ error: 'Not Found' }, 404)
  },
}

// Small helper
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
