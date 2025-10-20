import { Hono } from 'hono'

// ---- Environment bindings ----
export interface Env {
  CLOUDFLARE_ACCOUNT_ID: string
  CLOUDFLARE_API_TOKEN: string // needs Tunnel/Cloudflare One Connector write perms
  DB: D1Database
  // Optional: allow overriding table name
  CUSTOMERS_TABLE?: string // default 'test_customers'
}

type CustomerRow = {
  id: string | number
  tunnel_uid: string | null
  customer_domain: string | null
}

const app = new Hono<{ Bindings: Env }>()

// Health check
app.get('/', (c) => c.text('Customer Manager Worker: OK'))

// Fetch customer config (domain + fresh run token)
app.get('/api/customers/:id/config', async (c) => {
  const customerId = c.req.param('id')
  const {
    CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN,
    DB,
    CUSTOMERS_TABLE = 'test_customers',
  } = c.env

  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN || !DB) {
    return c.json(
      { error: 'Missing required environment bindings (DB, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)' },
      500
    )
  }

  // 1) Load customer record
  let row: CustomerRow | null = null
  try {
    row = await DB.prepare(
      `SELECT id, tunnel_uid, customer_domain FROM ${CUSTOMERS_TABLE} WHERE id = ?`
    ).bind(customerId).first<CustomerRow>()
  } catch (err: any) {
    console.error('D1 query error:', err?.message || err)
    return c.json({ error: 'Database query failed.' }, 500)
  }

  if (!row) {
    return c.json({ error: `Customer ${customerId} not found.` }, 404)
  }
  if (!row.tunnel_uid) {
    return c.json({ error: `Customer ${customerId} has no tunnel_uid assigned.` }, 400)
  }

  const tunnelId = row.tunnel_uid
  const customerDomain = row.customer_domain || null

  // 2) Get a NEW run token for this remotely-managed tunnel
  const tokenUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/token`

  let runToken: string | undefined
  try {
    const resp = await fetch(tokenUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    })

    if (!resp.ok) {
      const body = await resp.text()
      console.error(`Cloudflare token error: ${resp.status} ${resp.statusText} :: ${body}`)
      return c.json(
        { error: 'Cloudflare API failed to generate token.', details: body || resp.statusText },
        502
      )
    }

    // IMPORTANT: for /cfd_tunnel/{id}/token the token is a STRING in result
    const json = await resp.json() as { result?: string }
    runToken = json?.result
    if (!runToken) {
      console.error('Token endpoint returned empty result payload:', json)
      return c.json({ error: 'Token endpoint returned empty result.' }, 502)
    }
  } catch (err: any) {
    console.error('Token fetch exception:', err?.message || err)
    return c.json({ error: 'Failed to fetch run token.' }, 500)
  }

  // 3) Return structured payload
  return c.json({
    version: 1,
    customer: {
      id: customerId,
      domain: customerDomain,
    },
    tunnel: {
      uid: tunnelId,
      token: runToken,
    },
  })
})

export default app
