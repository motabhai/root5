// src/index.ts — ONE worker (DNS + Tunnel + Zero Trust Access) with D1 logging
// Serves a small HTML UI at GET / and a secured REST API under /api/*
// Auth: send header Authorization: Bearer <AUTH_TOKEN>

// Add this at the top of your file or before the Env interface
// If you are using Cloudflare Workers, D1Database is available globally, but for TypeScript you need a type declaration.
// If you have @cloudflare/workers-types installed, import it; otherwise, declare a minimal type:

declare class D1Database {
  prepare(query: string): any;
  exec(query: string): Promise<any>;
}

export interface Env {
  // Cloudflare account/zone
  CLOUDFLARE_ACCOUNT_ID: string
  CLOUDFLARE_ZONE_ID: string
  CLOUDFLARE_API_TOKEN: string // DNS Edit/Read, Tunnel Edit/Read, Access Apps/Policies Edit/Read

  // Service-specific tokens
  TUNNEL_SERVICE_TOKEN: string
  DNS_SERVICE_TOKEN: string
  ZTNA_TOKEN: string

  // Zero Trust defaults (optional)
  ACCESS_APP_NAME_PREFIX?: string // e.g. "cust-"
  ACCESS_CERT_REQUIRED?: string   // "true" to add certificate rule

  // Worker auth
  AUTH_TOKEN: string

  // D1
  DB: D1Database
  CUSTOMERS_TABLE?: string // default "customers"
}

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null

const json = (d: Json, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } })
const text = (t: string, s = 200, c = "text/plain; charset=utf-8") =>
  new Response(t, { status: s, headers: { "Content-Type": c } })

function requireAuth(req: Request, env: Env) {
  console.log(`[debug] AUTH_TOKEN type: ${typeof env.AUTH_TOKEN}`)
  const h = req.headers.get("authorization") || ""
  const ok = h.startsWith("Bearer ") && h.slice(7) === env.AUTH_TOKEN
  if (!ok) throw new Response("Unauthorized", { status: 401 })
}

function hostnameFor(id: number, baseDomain: string, type: "ha" | "ssh" | "plc") {
  return `${type}.cust${id}.${baseDomain}`
}

function apiHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  }
}

async function cf(env: Env, path: string, init?: RequestInit, serviceToken?: string) {
  const token = serviceToken || env.CLOUDFLARE_API_TOKEN
  const url = `https://api.cloudflare.com/client/v4${path}`
  const res = await fetch(url, { ...init, headers: { ...apiHeaders(token), ...(init?.headers || {}) } })
  const body = await res.json().catch(() => ({}))
  const ok = (res.ok && (body?.success !== false)) || (body?.success === true)
  if (!ok) {
    throw new Error(
      `CF API ${init?.method || "GET"} ${path} failed: ${res.status} ${
        body?.errors ? JSON.stringify(body.errors) : ""
      }`
    )
  }
  return body
}

// In-memory storage for customers (replace D1 for demo)
const customers = new Map<number, any>()

export async function initDb(env: Env) {
  // No-op for in-memory
}

export async function upsertRow(env: Env, id: number, values: any) {
  const existing = customers.get(id) || { id, created_at: new Date().toISOString() }
  customers.set(id, { ...existing, ...values, updated_at: new Date().toISOString() })
}

export async function getRow(env: Env, id: number) {
  return customers.get(id) || null
}

export async function listRows(env: Env) {
  return Array.from(customers.values()).reverse()
}

// --------- DNS
async function createDns(env: Env, hostname: string, opts?: { type?: "A" | "CNAME"; content?: string }) {
  const type = opts?.type || "A"
  const content = opts?.content || "192.0.2.1" // placeholder if tunnel not yet created

  // Check if record already exists
  try {
    const listRes = await cf(env, `/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records?name=${encodeURIComponent(hostname)}&type=${type}`, { method: "GET" }, env.DNS_SERVICE_TOKEN)
    if (listRes.result && listRes.result.length > 0) {
      return listRes.result[0] // Return existing record
    }
  } catch (e) {
    // Ignore, proceed to create
  }

  const body = (await cf(env, `/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type, name: hostname, content, ttl: 120, proxied: false })
  }, env.DNS_SERVICE_TOKEN)) as any
  return body.result
}

async function deleteDns(env: Env, recordId: string) {
  await cf(env, `/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records/${recordId}`, { method: "DELETE" }, env.DNS_SERVICE_TOKEN)
}

// --------- Tunnel (remotely managed)
async function createTunnel(env: Env, name: string) {
  // First, check if tunnel with this name already exists
  try {
    const listRes = await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel?name=${encodeURIComponent(name)}`, { method: 'GET' }, env.TUNNEL_SERVICE_TOKEN)
    if (listRes.result && listRes.result.length > 0) {
      const existing = listRes.result[0]
      // Get token for existing tunnel
      try {
        const tokenRes = await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${existing.id}/token`, { method: "POST" }, env.TUNNEL_SERVICE_TOKEN)
        return { id: existing.id, token: tokenRes.result?.token || "" }
      } catch (e: any) {
        // If we can't get the token, delete the existing tunnel and create a new one
        if (e.message && e.message.includes("Method Not Allowed")) {
          await deleteTunnel(env, existing.id)
          // Now proceed to create new tunnel below
        } else {
          throw e
        }
      }
    }
  } catch (e: any) {
    // If listing fails, try to create and catch the conflict error
    if (e.message && e.message.includes("already have a tunnel")) {
      throw e // Re-throw the conflict error
    }
    // Otherwise ignore and proceed to create
  }

  const t = (await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel`, {
    method: "POST",
    body: JSON.stringify({ name, config_src: "cloudflare" })
  }, env.TUNNEL_SERVICE_TOKEN)) as any
  const tunnel = t.result
  return { id: tunnel.id as string, token: tunnel.token as string }
}

async function setTunnelConfig(env: Env, tunnelId: string, hostname: string, localUrl: string) {
  // This is the correct endpoint for configuring a remotely-managed tunnel
  await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`, {
    method: "PUT",
    body: JSON.stringify({
      config: {
        ingress: [{ hostname, service: localUrl }, { service: "http_status:404" }]
      }
    })
  }, env.TUNNEL_SERVICE_TOKEN)
}

async function routeTunnelToHostname(env: Env, tunnelId: string, hostname: string) {
  await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/config/routes/dns`, {
    method: "POST",
    body: JSON.stringify({ hostname })
  }, env.TUNNEL_SERVICE_TOKEN)
}

async function deleteTunnel(env: Env, tunnelId: string) {
  await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`, { method: "DELETE" }, env.TUNNEL_SERVICE_TOKEN)
}

// --------- Zero Trust Access (self_hosted)
async function createAccessApp(env: Env, hostname: string) {
  const name = `${env.ACCESS_APP_NAME_PREFIX || "cust-"}${hostname}`

  // Check if app already exists
  try {
    const listRes = await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/access/apps?name=${encodeURIComponent(name)}`, { method: "GET" }, env.ZTNA_TOKEN)
    if (listRes.result && listRes.result.length > 0) {
      return listRes.result[0] // Return existing app
    }
  } catch (e) {
    // Ignore, proceed to create
  }

  const appBody = (await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/access/apps`, {
    method: "POST",
    body: JSON.stringify({
      name,
      domain: hostname,
      type: "self_hosted",
      session_duration: "24h"
    })
  }, env.ZTNA_TOKEN)) as any
  const app = appBody.result as { id: string }

  // Policy
  const includeRule =
    env.ACCESS_CERT_REQUIRED === "true" ? [{ certificate: {} }] : [{ everyone: {} }]

  await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/access/apps/${app.id}/policies`, {
    method: "POST",
    body: JSON.stringify({
      decision: "allow",
      name: "Default Allow",
      include: includeRule,
      precedence: 1
    })
  }, env.ZTNA_TOKEN)

  return app
}

async function deleteAccessApp(env: Env, appId: string) {
  await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/access/apps/${appId}`, { method: "DELETE" }, env.ZTNA_TOKEN)
}

// --------- HTML UI
const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ONE · DNS + Tunnel + ZT Access</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; }
    form { display: grid; gap: 0.75rem; max-width: 760px; }
    fieldset { border: 1px solid #ddd; padding: 1rem; border-radius: 12px; }
    input, button { padding: 0.6rem 0.8rem; font-size: 1rem; }
    .row { display: grid; grid-template-columns: 180px 1fr; gap: 1rem; align-items: center; }
    pre { background: #0b1020; color: #dfe6ff; padding: 1rem; border-radius: 10px; overflow: auto; }
    code { background:#f6f6f6; padding:2px 6px; border-radius:6px }
  </style>
</head>
<body>
  <h1>ONE · Customer Provisioner</h1>
  <p>Creates <strong>DNS</strong>, <strong>Cloudflare Tunnel (ingress + route)</strong>, and <strong>Zero Trust Access</strong> for a customer. Use your API auth token below.</p>

  <form id="f">
    <fieldset>
      <legend>Inputs</legend>
      <div class="row"><label>Customer ID</label><input name="id" type="number" min="1" required /></div>
      <div class="row"><label>Base domain</label><input name="domain" placeholder="chromebased.net" required /></div>
      <div class="row"><label>Local service URL</label><input name="local" value="http://127.0.0.1:8081" required /></div>
      <div class="row"><label>Auth token</label><input name="token" type="password" placeholder="AUTH_TOKEN" required /></div>
    </fieldset>
    <fieldset>
      <legend>Actions</legend>
      <button name="action" value="add_customer">Add Customer</button>
      <button name="action" value="provision">Provision All</button>
      <button name="action" value="dns_add" type="button">Add DNS</button>
      <button name="action" value="tunnel_add" type="button">Add Tunnel</button>
      <button name="action" value="access_add" type="button">Add ZT App</button>
      <button name="action" value="deprovision" type="button">Delete ALL</button>
    </fieldset>
  </form>

  <pre id="out"></pre>

  <script>
    const f = document.getElementById('f');
    const out = document.getElementById('out');
    async function call(path, method, body, token) {
      const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(body) })
      const txt = await res.text()
      try { return JSON.parse(txt) } catch { return { raw: txt } }
    }
    f.addEventListener('click', async (e) => {
      if (e.target.tagName !== 'BUTTON') return
      e.preventDefault()
      const fd = new FormData(f)
      const id = Number(fd.get('id'))
      const domain = String(fd.get('domain'))
      const local = String(fd.get('local'))
      const token = String(fd.get('token'))
      const base = ''
      let r
      if (e.target.value === 'add_customer') r = await call(base + '/api/customers', 'POST', { id, domain }, token)
      if (e.target.value === 'provision') r = await call(base + '/api/provision', 'POST', { id, domain, local }, token)
      if (e.target.value === 'dns_add') r = await call(base + '/api/dns', 'POST', { id, domain }, token)
      if (e.target.value === 'tunnel_add') r = await call(base + '/api/tunnel', 'POST', { id, domain, local }, token)
      if (e.target.value === 'access_add') r = await call(base + '/api/ztapp', 'POST', { id, domain }, token)
      if (e.target.value === 'deprovision') r = await call(base + '/api/deprovision', 'DELETE', { id, domain }, token)
      out.textContent = JSON.stringify(r, null, 2)
    })
  </script>
</body>
</html>`

const testHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>ONE · Test Page</title>
  </head>
  <body>
    <h1>ONE — Test</h1>
    <p>Quick test controls for provision / deprovision.</p>
    <label>Auth token: <input id="token" value="" /></label><br/>
    <label>Customer ID: <input id="id" type="number" value="1" /></label><br/>
    <label>Domain: <input id="domain" value="example.com" /></label><br/>
    <button id="prov">Provision</button>
    <button id="deprov">Deprovision</button>
    <pre id="out"></pre>
    <script>
      const out = document.getElementById('out')
      document.getElementById('prov').addEventListener('click', async () => {
        const token = (document.getElementById('token') as HTMLInputElement).value
        const id = Number((document.getElementById('id') as HTMLInputElement).value)
        const domain = (document.getElementById('domain') as HTMLInputElement).value
        const res = await fetch('/api/provision', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ id, domain }) })
        out.textContent = await res.text()
      })
      document.getElementById('deprov').addEventListener('click', async () => {
        const token = (document.getElementById('token') as HTMLInputElement).value
        const id = Number((document.getElementById('id') as HTMLInputElement).value)
        const res = await fetch('/api/deprovision', { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ id }) })
        out.textContent = await res.text()
      })
    </script>
  </body>
</html>`

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === "/test") {
        try {
          await initDb(env)
          return new Response(testHtml, { headers: { "content-type": "text/html; charset=utf-8" } })
        } catch (e: any) {
          // Return error details for local debugging (do not expose in production)
          const msg = `initDb failed: ${e?.message || String(e)}\n\nStack:\n${e?.stack || ''}`
          return new Response(msg, { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } })
        }
    }

    // Simple ping for quick responsiveness checks (no DB)
    if (url.pathname === "/ping") {
      console.log('[ping] hit')
      return new Response('pong', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    }

      // Debug helper: report DB binding and a simple test query result
      if (url.pathname === "/debug-db") {
        try {
          // Log so wrangler dev definitely prints a line when this endpoint is hit
          console.log('[debug-db] hit')

          const hasDb = !!env.DB
          let probe: any = null
          if (hasDb) {
            try {
              // Run the probe but guard with a timeout to avoid hanging the dev server
              const probePromise = env.DB.prepare("SELECT 1 as ok").first()
              const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 3000))
              const r = await Promise.race([probePromise, timeout])
              probe = r
            } catch (err: any) {
              probe = { error: err?.message || String(err) }
            }
          }
          return json({ ok: true, hasDb: hasDb, probe })
        } catch (err: any) {
          return json({ ok: false, error: err?.message || String(err) }, 500)
        }
      }

        // Detailed stepwise DB init for debugging local D1 issues.
        if (url.pathname === "/init-db-debug") {
          try {
            console.log('[init-db-debug] hit')
            const table = env.CUSTOMERS_TABLE || "customers"
            const statements = [
              // create table (same simplified schema)
              `CREATE TABLE IF NOT EXISTS ${table} (\n    id INTEGER PRIMARY KEY,\n    hostname TEXT UNIQUE,\n    dns_record_ids TEXT,\n    dns_record_id_ha TEXT,
    dns_record_id_ssh TEXT,
    dns_record_id_plc TEXT,
    tunnel_id TEXT,\n    tunnel_token TEXT,\n    access_app_id TEXT,\n    created_at TEXT,\n    updated_at TEXT\n  );`,
              // quick select probe
              `SELECT 1 as ok;`,
              // try an insert
              `INSERT OR IGNORE INTO ${table} (id, created_at) VALUES (999999, '1970-01-01T00:00:00Z');`,
              // select the inserted row
              `SELECT * FROM ${table} WHERE id = 999999;`
            ]

            const results: any[] = []
            for (const s of statements) {
              try {
                if (s.trim().toUpperCase().startsWith("SELECT")) {
                  const r = await env.DB.prepare(s).first()
                  results.push({ sql: s, result: r })
                } else {
                  const r = await env.DB.exec(s)
                  results.push({ sql: s, result: r })
                }
              } catch (e: any) {
                results.push({ sql: s, error: e?.message || String(e) })
              }
            }

            return json({ ok: true, results })
          } catch (e: any) {
            return json({ ok: false, error: e?.message || String(e) }, 500)
          }
        }

    if (url.pathname === "/") {
      const customers = await listRows(env)
      const customerRows = customers.map(c => `
        <tr>
          <td>${c.id}</td>
          <td>${c.hostname}</td>
          <td>${c.tunnel_id ? 'Yes' : 'No'}</td>
          <td>${c.access_app_id ? 'Yes' : 'No'}</td>
          <td><pre>${c.run_command || 'Not generated'}</pre></td>
        </tr>
      `).join('')

      const ui = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Customer Provisioner</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 2rem; background-color: #f4f6f8; color: #333; }
            h1, h2 { color: #1a2b4d; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; background-color: #fff; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            th, td { padding: 1rem; text-align: left; border-bottom: 1px solid #ddd; }
            th { background-color: #e9edf2; }
            pre { background-color: #2d3748; color: #e2e8f0; padding: 0.5rem; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; }
            form { background-color: #fff; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); display: grid; gap: 1rem; max-width: 500px; }
            input { padding: 0.75rem; border: 1px solid #ccc; border-radius: 4px; font-size: 1rem; }
            button { padding: 0.75rem 1.5rem; border: none; border-radius: 4px; background-color: #2563eb; color: white; font-size: 1rem; cursor: pointer; }
            button:hover { background-color: #1d4ed8; }
          </style>
        </head>
        <body>
          <h1>Customer Provisioner</h1>
          
          <h2>Existing Customers</h2>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Hostname</th>
                <th>Tunnel Provisioned</th>
                <th>Access App Provisioned</th>
                <th>Run Command</th>
              </tr>
            </thead>
            <tbody>
              ${customerRows}
            </tbody>
          </table>

          <h2>Provision New Customer</h2>
          <form id="provision-form">
            <label for="customer-id">Customer ID:</label>
            <input type="number" id="customer-id" name="id" required>
            
            <label for="domain">Domain:</label>
            <input type="text" id="domain" name="domain" value="chromebased.net" required>

            <button type="submit">Provision Customer</button>
          </form>
          <pre id="form-output"></pre>

          <script>
            document.getElementById('provision-form').addEventListener('submit', async (e) => {
              e.preventDefault();
              const form = e.target;
              const output = document.getElementById('form-output');
              const formData = new FormData(form);
              const id = formData.get('id');
              const domain = formData.get('domain');
              
              output.textContent = 'Provisioning...';

              const response = await fetch('/api/provision', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ${env.AUTH_TOKEN}'
                },
                body: JSON.stringify({ id: parseInt(id), domain })
              });

              const result = await response.json();
              output.textContent = JSON.stringify(result, null, 2);
              
              // Refresh the page to show the new customer in the list
              if (response.ok && result.ok) {
                setTimeout(() => location.reload(), 1000);
              }
            });
          </script>
        </body>
        </html>
      `;
      return new Response(ui, { headers: { "content-type": "text/html; charset=utf-8" } })
    }

    // Secure API
    if (url.pathname.startsWith("/api/")) {
      try {
        requireAuth(req, env)
      } catch (e: any) {
        return e
      }
    }

    async function readBody<T = any>() {
      try {
        return (await req.json()) as T
      } catch {
        return {} as T
      }
    }

    if (url.pathname === "/api/health") return json({ ok: true, service: "one" })

    if (url.pathname === "/api/customers" && req.method === "GET") {
      await initDb(env)
      const rows = await listRows(env)
      return json(rows)
    }

    if (url.pathname === "/api/customers" && req.method === "POST") {
      await initDb(env)
      const { id, domain } = await readBody<{ id: number; domain: string }>()
      const host = hostnameFor(id, domain, "ha")
      await upsertRow(env, id, { hostname: host })
      return json({ ok: true, action: "customer_added", id, hostname: host })
    }

    // DNS create
    if (url.pathname === "/api/dns" && req.method === "POST") {
      await initDb(env)
      console.log(`[debug] CLOUDFLARE_API_TOKEN type: ${typeof env.CLOUDFLARE_API_TOKEN}`)
      const { id, domain, type } = await readBody<{ id: number; domain: string; type: "ha" | "ssh" | "plc" }>()
      const host = hostnameFor(id, domain, type)
      const r = await createDns(env, host)
      await upsertRow(env, id, { [`dns_record_id_${type}`]: r.id })
      return json({ ok: true, action: "dns_created", hostname: host, dns_record_id: r.id, type })
    }

    // Provision all: DNS -> Access App -> Tunnel -> Tunnel Config -> Return token
    if (url.pathname === "/api/provision" && req.method === "POST") {
      await initDb(env)
      const { id, domain, local } = await readBody<{ id: number; domain: string; local?: string }>()
      const host = hostnameFor(id, domain, "ha")
      const tunnelName = `cust${id}`

      const result: any = {
        ok: false,
        hostname: host,
        errors: []
      }

      // Step 1: Create DNS Records
      let dns_ids: string[] = []
      const hostnamesToCreate = [
        hostnameFor(id, domain, "ha"), // ha.cust[id].chromebased.net
        hostnameFor(id, domain, "ssh"), // ssh.cust[id].chromebased.net
        hostnameFor(id, domain, "plc")  // plc.cust[id].chromebased.net
      ];

      for (const h of hostnamesToCreate) {
        try {
          const d = await createDns(env, h);
          dns_ids.push(d.id);
        } catch (e: any) {
          result.errors.push({ service: `dns-${h}`, error: e.message });
        }
      }
      result.dns_record_ids = dns_ids;

      // Step 2: Create Zero Trust Access Application
      let app: any
      try {
        app = await createAccessApp(env, host)
        result.access_app_id = app.id
      } catch (e: any) {
        result.errors.push({ service: 'ztna', error: e.message })
      }

      // Step 3: Create the Tunnel
      let tunnel: any
      try {
        tunnel = await createTunnel(env, tunnelName)
        result.tunnel_id = tunnel.id
        result.tunnel_token = tunnel.token
      } catch (e: any) {
        result.errors.push({ service: 'tunnel_create', error: e.message })
      }

      // Step 4: Configure the Tunnel's Public Hostname (the correct way)
      if (tunnel && tunnel.id) {
        try {
          await setTunnelConfig(env, tunnel.id, host, local || "http://127.0.0.1:8081")
          result.tunnel_configured = true
        } catch (e: any) {
          result.errors.push({ service: 'tunnel_config', error: e.message })
        }
      }

      // Step 5: Generate the run command and save it to the database
      let run_command: string | undefined
      if (result.tunnel_token) {
        run_command = `cloudflared tunnel run --token ${result.tunnel_token}`
      }

      // Update DB
      try {
        await upsertRow(env, id, {
          hostname: host,
          dns_record_ids: dns_ids.length > 0 ? dns_ids : null,
          access_app_id: app?.id || null,
          tunnel_id: tunnel?.id || null,
          run_command: run_command || null
        })
      } catch (e: any) {
        result.errors.push({ service: 'db', error: e.message })
      }

      result.ok = result.errors.length === 0
      // Remove sensitive token from the response to the admin UI
      delete result.tunnel_token
      return json(result)
    }

    // Deprovision ALL: Access -> Tunnel -> DNS; then clear DB pointers
    if (url.pathname === "/api/deprovision" && req.method === "DELETE") {
      await initDb(env)
      const { id } = await readBody<{ id: number }>()
      const row: any = await getRow(env, id)
      if (!row) return json({ ok: true, note: "nothing to delete" })

      const out: Record<string, string> = {}

      if (row.access_app_id) {
        try {
          await deleteAccessApp(env, row.access_app_id)
          out.access_app = "deleted"
        } catch (e: any) {
          out.access_app = "error: " + e.message
        }
      }
      if (row.tunnel_id) {
        try {
          await deleteTunnel(env, row.tunnel_id)
          out.tunnel = "deleted"
        } catch (e: any) {
          out.tunnel = "error: " + e.message
        }
      }
      if (row.dns_record_ids && Array.isArray(row.dns_record_ids)) {
        for (const recordId of row.dns_record_ids) {
          try {
            await deleteDns(env, recordId)
            out[`dns-${recordId}`] = "deleted"
          } catch (e: any) {
            out[`dns-${recordId}`] = "error: " + e.message
          }
        }
      }
      if (row.dns_record_id_ha) {
        try {
          await deleteDns(env, row.dns_record_id_ha)
          out.dns_ha = "deleted"
        } catch (e: any) {
          out.dns_ha = "error: " + e.message
        }
      }
      if (row.dns_record_id_ssh) {
        try {
          await deleteDns(env, row.dns_record_id_ssh)
          out.dns_ssh = "deleted"
        } catch (e: any) {
          out.dns_ssh = "error: " + e.message
        }
      }
      if (row.dns_record_id_plc) {
        try {
          await deleteDns(env, row.dns_record_id_plc)
          out.dns_plc = "deleted"
        } catch (e: any) {
          out.dns_plc = "error: " + e.message
        }
      }

      await upsertRow(env, id, {
        dns_record_ids: null,
        dns_record_id_ha: null,
        dns_record_id_ssh: null,
        dns_record_id_plc: null,
        tunnel_id: null,
        tunnel_token: null,
        access_app_id: null
      })

      return json({ ok: true, result: out })
    }

    // Endpoint for mini PC to fetch its run command
    const commandMatch = url.pathname.match(/^\/api\/customers\/(\d+)\/command$/)
    if (commandMatch && req.method === "GET") {
      const id = parseInt(commandMatch[1], 10)
      const row: any = await getRow(env, id)
      if (!row || !row.run_command) {
        return text("Command not found for this customer ID", 404)
      }
      return json({ run_command: row.run_command })
    }

    return text("Not found", 404)
  }
}
