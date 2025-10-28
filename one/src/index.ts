import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";

type Bindings = {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_ZONE_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  TUNNEL_SERVICE_TOKEN: string;
  DNS_SERVICE_TOKEN: string;
  ZTNA_TOKEN: string;
  ACCESS_APP_NAME_PREFIX?: string;
  ACCESS_CERT_REQUIRED?: string;
  AUTH_TOKEN: string;
  DB: D1Database;
  CUSTOMERS_TABLE?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Auth middleware for /api/ routes
app.use("/api/*", async (c, next) => {
  const authHeader = c.req.header('Authorization');
  console.log('[auth] header:', authHeader ? authHeader.substring(0, 20) + '...' : 'missing');
  console.log('[auth] expected token:', c.env.AUTH_TOKEN);
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('[auth] failed: no bearer token');
    return c.json({ error: 'Unauthorized', message: 'Missing or invalid Authorization header' }, 401);
  }
  
  const token = authHeader.substring(7);
  if (token !== c.env.AUTH_TOKEN) {
    console.log('[auth] failed: token mismatch');
    return c.json({ error: 'Unauthorized', message: 'Invalid token' }, 401);
  }
  
  console.log('[auth] passed');
  return next();
});

app.get('/api/health', (c) => c.json({ ok: true, service: 'one' }));

// Declare D1Database for TypeScript
declare class D1Database {
  prepare(query: string): any;
  exec(query: string): Promise<any>;
  batch(statements: any[]): Promise<any[]>;
}

interface Customer {
  id: number;
  hostname: string;
  dns_record_ids: string | null;
  dns_record_id_ha: string | null;
  dns_record_id_ssh: string | null;
  dns_record_id_plc: string | null;
  tunnel_id: string | null;
  tunnel_token: string | null;
  access_app_id: string | null;
  run_command: string | null;
  created_at: string;
  updated_at: string;
}

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const json = (d: Json, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const text = (t: string, s = 200, c = "text/plain; charset=utf-8") =>
  new Response(t, { status: s, headers: { "Content-Type": c } });

function hostnameFor(id: number, baseDomain: string, type: "ha" | "ssh" | "plc") {
  return `${type}.cust${id}.${baseDomain}`;
}

function apiHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

async function cf(env: Bindings, path: string, init?: RequestInit, serviceToken?: string) {
  const token = serviceToken || env.CLOUDFLARE_API_TOKEN;
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const res = await fetch(url, { ...init, headers: { ...apiHeaders(token), ...(init?.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  const ok = (res.ok && (body?.success !== false)) || (body?.success === true);
  if (!ok) {
    console.log('[cf error]', path, res.status, body.errors);
    throw new Error(
      `CF API ${init?.method || "GET"} ${path} failed: ${res.status} ${
        body?.errors ? JSON.stringify(body.errors) : ""
      }`
    );
  }
  return body;
}

// D1 query endpoints
app.post('/api/all', async (c) => {
  try {
    let { query, params } = await c.req.json();
    let stmt = c.env.DB.prepare(query);
    if (params) {
      stmt = stmt.bind(...params);
    }
    const result = await stmt.all();
    return c.json(result);
  } catch (err) {
    return c.json({ error: `Failed to run query: ${err}` }, 500);
  }
});

app.post('/api/exec', async (c) => {
  try {
    let { query } = await c.req.json();
    let result = await c.env.DB.exec(query);
    return c.json(result);
  } catch (err) {
    return c.json({ error: `Failed to run query: ${err}` }, 500);
  }
});

app.post('/api/batch', async (c) => {
  try {
    let { batch } = await c.req.json();
    let stmts = [];
    for (let query of batch) {
      let stmt = c.env.DB.prepare(query.query);
      if (query.params) {
        stmts.push(stmt.bind(...query.params));
      } else {
        stmts.push(stmt);
      }
    }
    const results = await c.env.DB.batch(stmts);
    return c.json(results);
  } catch (err) {
    return c.json({ error: `Failed to run query: ${err}` }, 500);
  }
});

export async function initDb(env: Bindings) {
  console.log('[initDb] start');
  console.log('[initDb] env.DB defined:', !!env.DB);
  const table = env.CUSTOMERS_TABLE || "customers";
  console.log('[initDb] before DB.prepare');
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ${table} (
    id INTEGER PRIMARY KEY,
    hostname TEXT UNIQUE,
    dns_record_ids TEXT,
    dns_record_id_ha TEXT,
    dns_record_id_ssh TEXT,
    dns_record_id_plc TEXT,
    tunnel_id TEXT,
    tunnel_token TEXT,
    access_app_id TEXT,
    created_at TEXT,
    updated_at TEXT
  )`).run();
  console.log('[initDb] db prepare done');
}

export async function upsertRow(env: Bindings, id: number, values: any) {
  const table = env.CUSTOMERS_TABLE || "customers";
  const now = new Date().toISOString();
  const existing = await getRow(env, id);

  if (existing) {
    // Update existing row
    const updateFields = Object.keys(values).map(k => `${k} = ?`).join(", ");
    const updateValues = Object.values(values);
    await env.DB.prepare(`UPDATE ${table} SET ${updateFields}, updated_at = ? WHERE id = ?`)
      .bind(...updateValues, now, id)
      .run();
  } else {
    // Insert new row
    const insertFields = ["id", "created_at", "updated_at", ...Object.keys(values)].join(", ");
    const insertPlaceholders = Array(Object.keys(values).length + 3).fill("?").join(", ");
    const insertValues = [id, now, now, ...Object.values(values)];
    await env.DB.prepare(`INSERT INTO ${table} (${insertFields}) VALUES (${insertPlaceholders})`)
      .bind(...insertValues)
      .run();
  }
}

export async function getRow(env: Bindings, id: number) {
  const table = env.CUSTOMERS_TABLE || "customers";
  return env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
}

export async function listRows(env: Bindings): Promise<Customer[]> {
  const table = env.CUSTOMERS_TABLE || "customers";
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY created_at DESC`).all();
  return results as Customer[];
}

// DNS
async function createDns(env: Bindings, hostname: string, opts?: { type?: "A" | "CNAME"; content?: string }) {
  const type = opts?.type || "A";
  const content = opts?.content || "192.0.2.1";

  try {
    const listRes = await cf(env, `/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records?name=${encodeURIComponent(hostname)}&type=${type}`);
    if (listRes.result && listRes.result.length > 0) {
      return listRes.result[0];
    }
  } catch (e) {
    // Ignore
  }

  const body = await cf(env, `/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type, name: hostname, content, ttl: 120, proxied: false })
  });
  return body.result;
}

async function updateDns(env: Bindings, recordId: string, updates: { type?: "A" | "CNAME"; content?: string }) {
  const body = await cf(env, `/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify(updates)
  });
  return body.result;
}

async function deleteDns(env: Bindings, recordId: string) {
  await cf(env, `/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records/${recordId}`, { method: "DELETE" });
}

// Tunnel
async function createTunnel(env: Bindings, name: string) {
  try {
    const listRes = await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel?name=${encodeURIComponent(name)}`, {}, env.TUNNEL_SERVICE_TOKEN);
    if (listRes.result && listRes.result.length > 0) {
      const existing = listRes.result[0];
      try {
        const tokenRes = await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${existing.id}/token`, { method: "POST" }, env.TUNNEL_SERVICE_TOKEN);
        return { id: existing.id, token: tokenRes.result?.token || "" };
      } catch (e) {
        await deleteTunnel(env, existing.id);
      }
    }
  } catch (e) {
    // Ignore
  }

  const t = await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel`, {
    method: "POST",
    body: JSON.stringify({ name, config_src: "cloudflare" })
  }, env.TUNNEL_SERVICE_TOKEN);
  console.log('[createTunnel] tunnel creation response:', t);
  const tunnel = t.result;
  return { id: tunnel.id, token: tunnel.token };
}

async function setTunnelConfig(env: Bindings, tunnelId: string, hostname: string, localUrl: string) {
  await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`, {
    method: "PUT",
    body: JSON.stringify({
      config: {
        ingress: [{ hostname, service: localUrl }, { service: "http_status:404" }]
      }
    })
  }, env.TUNNEL_SERVICE_TOKEN);
}

async function deleteTunnel(env: Bindings, tunnelId: string) {
  await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`, { method: "DELETE" }, env.TUNNEL_SERVICE_TOKEN);
}

// Routes
app.get("/", async (c) => {
  console.log('[root] start');
  let customers: Customer[] = [];
  try {
    console.log('[root] c.env.DB defined:', !!c.env.DB);
    await initDb(c.env);
    console.log('[root] db init done');
    customers = await listRows(c.env);
    console.log('[root] list rows done, count:', customers.length);
  } catch (e: any) {
    console.error('[root] Database error:', e);
  }
  const customerRows = customers.map((customer: Customer) => {
    const dnsRecordIds = customer.dns_record_ids ? JSON.parse(customer.dns_record_ids) : [];
    return `
    <tr>
      <td>${customer.id}</td>
      <td>${customer.hostname}</td>
      <td>${dnsRecordIds.length > 0 ? dnsRecordIds.join(', ') : 'No'}</td>
      <td>${dnsRecordIds.length > 0 ? 'Yes' : 'No'}</td>
      <td>${customer.tunnel_id ? 'Yes' : 'No'}</td>
      <td>${customer.access_app_id ? 'Yes' : 'No'}</td>
      <td><pre>${customer.run_command || 'Not generated'}</pre></td>
    </tr>
  `;
  }).join('');

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
            <th>DNS Records</th>
            <th>HA DNS</th>
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
          const token = '` + c.env.AUTH_TOKEN + `';
          
          output.textContent = 'Provisioning...';

          try {
            const response = await fetch('/api/provision', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
              },
              body: JSON.stringify({ id: parseInt(id), domain })
            });

            const responseText = await response.text();
            let result;
            try {
              result = JSON.parse(responseText);
            } catch (e) {
              result = { error: 'Invalid JSON response', status: response.status, statusText: response.statusText, body: responseText };
            }

            if (!response.ok) {
              result.error = result.error || 'Request failed';
              result.status = response.status;
              result.statusText = response.statusText;
            }

            output.textContent = JSON.stringify(result, null, 2);
            
            if (response.ok && result.ok) {
              setTimeout(() => location.reload(), 1000);
            }
          } catch (e) {
            output.textContent = JSON.stringify({ error: 'Network error', message: e.message }, null, 2);
          }
        });
      </script>
    </body>
    </html>
  `;
  return c.html(ui);
});

app.post("/api/provision", async (c) => {
  try {
    console.log('[provision] start');
    console.log('[provision] DB defined:', !!c.env.DB);
    await initDb(c.env);
    const { id, domain, local } = await c.req.json<{ id: number; domain: string; local?: string }>();
    console.log('[provision] initDb done, id:', id, 'domain:', domain);
    const host = hostnameFor(id, domain, "ha");
    const tunnelName = `cust${id}`;

    const result: any = {
      ok: false,
      hostname: host,
      errors: []
    };

    // DNS
    console.log('[provision] creating DNS');
    let dns_ids: string[] = [];
    const hostnamesToCreate = [
      hostnameFor(id, domain, "ha"),
      hostnameFor(id, domain, "ssh"),
      hostnameFor(id, domain, "plc")
    ];

    for (const h of hostnamesToCreate) {
      try {
        const d = await createDns(c.env, h);
        dns_ids.push(d.id);
        console.log('[provision] DNS created for', h, d.id);
      } catch (e: any) {
        console.log('[provision] DNS failed for', h, e.message);
        result.errors.push({ service: `dns-${h}`, error: e.message });
      }
    }
    result.dns_record_ids = dns_ids;
    console.log('[provision] DNS done');

    // Tunnel
    console.log('[provision] creating tunnel');
    let tunnel: any;
    try {
      tunnel = await createTunnel(c.env, tunnelName);
      result.tunnel_id = tunnel.id;
      result.tunnel_token = tunnel.token;
      console.log('[provision] tunnel done', tunnel.id);
    } catch (e: any) {
      console.log('[provision] tunnel failed', e.message);
      result.errors.push({ service: 'tunnel_create', error: e.message });
    }

    if (tunnel && tunnel.id) {
      console.log('[provision] configuring tunnel');
      try {
        await setTunnelConfig(c.env, tunnel.id, host, local || "http://127.0.0.1:8081");
        result.tunnel_configured = true;
        console.log('[provision] tunnel config done');
      } catch (e: any) {
        console.log('[provision] tunnel config failed', e.message);
        result.errors.push({ service: 'tunnel_config', error: e.message });
      }

      if (dns_ids.length > 0) {
        console.log('[provision] updating DNS records to point to tunnel');
        for (const dnsId of dns_ids) {
          try {
            await updateDns(c.env, dnsId, { type: "CNAME", content: `${tunnel.id}.cfargotunnel.com` });
            console.log('[provision] DNS record updated:', dnsId);
          } catch (e: any) {
            console.log('[provision] DNS update failed for', dnsId, e.message);
            result.errors.push({ service: `dns_update_${dnsId}`, error: e.message });
          }
        }
        result.dns_updated = true;
        console.log('[provision] All DNS records updated');
      }
    }

    let run_command: string | undefined;
    if (result.tunnel_token) {
      run_command = `cloudflared tunnel run --token ${result.tunnel_token}`;
    }

    console.log('[provision] updating DB');
    try {
      await upsertRow(c.env, id, {
        hostname: host,
        dns_record_ids: dns_ids.length > 0 ? JSON.stringify(dns_ids) : null,
        tunnel_id: tunnel?.id || null,
        run_command: run_command || null
      });
      console.log('[provision] DB updated');
    } catch (e: any) {
      console.log('[provision] DB update failed', e.message);
      result.errors.push({ service: 'db', error: e.message });
    }

    result.ok = result.errors.length === 0;
    delete result.tunnel_token;
    console.log('[provision] done', result.ok, result.errors.length);
    return c.json(result);
  } catch (e: any) {
    console.error('[provision] Uncaught error:', e);
    return c.json({ ok: false, error: e.message, stack: e.stack }, 500);
  }
});

app.delete("/api/deprovision", async (c) => {
  console.log('[deprovision] start');
  const { id } = await c.req.json<{ id: number }>();
  console.log('[deprovision] id:', id);

  const result: any = {
    ok: false,
    errors: []
  };

  // Get current row
  const row = await getRow(c.env, id);
  if (!row) {
    return c.json({ ok: false, error: 'Customer not found' }, 404);
  }

  // Delete DNS
  if (row.dns_record_id_ha) {
    try {
      await deleteDns(c.env, row.dns_record_id_ha);
      console.log('[deprovision] DNS ha deleted');
    } catch (e: any) {
      console.log('[deprovision] DNS ha delete failed', e.message);
      result.errors.push({ service: 'dns_ha', error: e.message });
    }
  }
  if (row.dns_record_id_ssh) {
    try {
      await deleteDns(c.env, row.dns_record_id_ssh);
      console.log('[deprovision] DNS ssh deleted');
    } catch (e: any) {
      console.log('[deprovision] DNS ssh delete failed', e.message);
      result.errors.push({ service: 'dns_ssh', error: e.message });
    }
  }
  if (row.dns_record_id_plc) {
    try {
      await deleteDns(c.env, row.dns_record_id_plc);
      console.log('[deprovision] DNS plc deleted');
    } catch (e: any) {
      console.log('[deprovision] DNS plc delete failed', e.message);
      result.errors.push({ service: 'dns_plc', error: e.message });
    }
  }

  // Delete tunnel
  if (row.tunnel_id) {
    try {
      await deleteTunnel(c.env, row.tunnel_id);
      console.log('[deprovision] tunnel deleted');
    } catch (e: any) {
      console.log('[deprovision] tunnel delete failed', e.message);
      result.errors.push({ service: 'tunnel', error: e.message });
    }
  }

  // Update DB
  try {
    await upsertRow(c.env, id, {
      dns_record_ids: null,
      dns_record_id_ha: null,
      dns_record_id_ssh: null,
      dns_record_id_plc: null,
      tunnel_id: null,
      run_command: null
    });
    console.log('[deprovision] DB updated');
  } catch (e: any) {
    console.log('[deprovision] DB update failed', e.message);
    result.errors.push({ service: 'db', error: e.message });
  }

  result.ok = result.errors.length === 0;
  console.log('[deprovision] done', result.ok, result.errors.length);
  return c.json(result);
});

export default app;
