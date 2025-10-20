// src/index.ts — Customer Manager Worker (Full Integrated Version with /config)

export interface Env {
  DB: D1Database;
  DNS_SERVICE: Fetcher;
  TUNNEL_SERVICE: Fetcher;
  ZEROTRUST_SERVICE: Fetcher;
  WORKER_API_TOKEN: string;
  CLOUDFLARE_ZONE_NAME: string;
}

// ----------------------------------------------------------------------
// 🧩 Helpers
// ----------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonResponse = (data: any, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });

const isAuth = (req: Request, env: Env) =>
  req.headers.get("Authorization") === `Bearer ${env.WORKER_API_TOKEN}`;

// ----------------------------------------------------------------------
// 🧠 Worker Entry
// ----------------------------------------------------------------------
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const { DB } = env;

    if (method === "OPTIONS")
      return new Response(null, { headers: CORS_HEADERS });

    // ------------------------------------------------------------
    // 🏠 Root Page
    // ------------------------------------------------------------
    if (method === "GET" && path === "/") {
      return new Response(
        `<html><body><h1>Customer Manager Running ✅</h1><p>API ready.</p></body></html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // ------------------------------------------------------------
    // 🔧 Initialize / Reset Database
    // ------------------------------------------------------------
    if (method === "POST" && path === "/init") {
      if (!isAuth(req, env)) return jsonResponse({ error: "Unauthorized" }, 401);

      try {
        await DB.batch([
          DB.prepare("DROP TABLE IF EXISTS customer_dns;"),
          DB.prepare("DROP TABLE IF EXISTS test_customers;"),
          DB.prepare(`
            CREATE TABLE test_customers (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              note TEXT,
              tunnel_uid TEXT,
              tunnel_token TEXT
            );
          `),
          DB.prepare(`
            CREATE TABLE customer_dns (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              customer_id INTEGER NOT NULL UNIQUE,
              dns_name TEXT NOT NULL UNIQUE,
              FOREIGN KEY(customer_id) REFERENCES test_customers(id) ON DELETE CASCADE
            );
          `),
        ]);
        return jsonResponse({ success: true, message: "Tables created." });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ------------------------------------------------------------
    // 👤 Create New Customer
    // ------------------------------------------------------------
    if (method === "POST" && path === "/api/provision/customer") {
      if (!isAuth(req, env)) return jsonResponse({ error: "Unauthorized" }, 401);
      const body = await req.json();
      const name = (body.name || "").trim();
      const note = (body.note || "").trim();

      if (!name) return jsonResponse({ error: "Missing name" }, 400);

      const result = await DB.prepare(
        "INSERT INTO test_customers (name, note) VALUES (?, ?) RETURNING id AS customerId"
      )
        .bind(name, note || null)
        .first();

      return jsonResponse({ success: true, ...result });
    }

    // ------------------------------------------------------------
    // 🌐 Create Tunnel + Update DB
    // ------------------------------------------------------------
    if (method === "POST" && path === "/api/provision/tunnel_and_update") {
      if (!isAuth(req, env)) return jsonResponse({ error: "Unauthorized" }, 401);
      const body = await req.json();
      const { customerId, name } = body;
      if (!customerId || !name)
        return jsonResponse({ error: "Missing customerId or name" }, 400);

      const tunnelResp = await env.TUNNEL_SERVICE.fetch("https://dummy/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tunnelName: `customer-${customerId}-${name}` }),
      });

      const tunnelData = await tunnelResp.json();
      if (!tunnelResp.ok || !tunnelData.success)
        return jsonResponse({ error: "Tunnel creation failed", details: tunnelData }, 500);

      const { tunnelUid, tunnelToken } = tunnelData;

      await DB.prepare(
        "UPDATE test_customers SET tunnel_uid = ?, tunnel_token = ? WHERE id = ?"
      )
        .bind(tunnelUid, tunnelToken || null, customerId)
        .run();

      return jsonResponse({ success: true, tunnelUid });
    }

    // ------------------------------------------------------------
    // 🌍 Create DNS Record
    // ------------------------------------------------------------
    if (method === "POST" && path === "/api/provision/dns") {
      if (!isAuth(req, env)) return jsonResponse({ error: "Unauthorized" }, 401);
      const body = await req.json();
      const { customerId, tunnelUid } = body;
      if (!customerId || !tunnelUid)
        return jsonResponse({ error: "Missing customerId or tunnelUid" }, 400);

      const dnsSlug = `customer${customerId}`;
      await DB.prepare(
        "INSERT INTO customer_dns (customer_id, dns_name) VALUES (?, ?)"
      )
        .bind(customerId, dnsSlug)
        .run();

      return jsonResponse({
        success: true,
        customerDomain: `${dnsSlug}.${env.CLOUDFLARE_ZONE_NAME}`,
      });
    }

    // ------------------------------------------------------------
    // 🔒 Add Domain to Zero Trust
    // ------------------------------------------------------------
    if (method === "POST" && path === "/api/provision/access") {
      if (!isAuth(req, env)) return jsonResponse({ error: "Unauthorized" }, 401);
      const body = await req.json();
      const { customerDomain } = body;
      if (!customerDomain)
        return jsonResponse({ error: "Missing customerDomain" }, 400);

      const ztResp = await env.ZEROTRUST_SERVICE.fetch("https://dummy/add_domain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerDomain }),
      });

      const ztData = await ztResp.json();
      if (!ztResp.ok)
        return jsonResponse({ error: "ZT Service failed", details: ztData }, 500);

      return jsonResponse({ success: true, message: ztData.message || "Domain added" });
    }

    // ------------------------------------------------------------
    // 📋 List Customers
    // ------------------------------------------------------------
    if (method === "GET" && path === "/api/customers") {
      const { results } = await DB.prepare(`
        SELECT c.id, c.name, c.note, c.tunnel_uid, d.dns_name AS dns
        FROM test_customers c
        LEFT JOIN customer_dns d ON c.id = d.customer_id
        ORDER BY c.id ASC
      `)
        .bind()
        .all();
      return jsonResponse(results);
    }

    // ------------------------------------------------------------
    // 🧾 Fetch Config for connect.sh (NEW)
    // ------------------------------------------------------------
    const configMatch = path.match(/^\/api\/customers\/(\d+)\/config$/);
    if (method === "GET" && configMatch) {
      const id = parseInt(configMatch[1]);
      const record = await DB.prepare(`
        SELECT 
          c.id AS customer_id,
          c.name AS customer_name,
          c.tunnel_uid,
          c.tunnel_token,
          d.dns_name
        FROM test_customers c
        LEFT JOIN customer_dns d ON c.id = d.customer_id
        WHERE c.id = ?
      `)
        .bind(id)
        .first();

      if (!record)
        return jsonResponse({ error: "Customer not found" }, 404);

      return jsonResponse({
        success: true,
        customerId: record.customer_id,
        customerDomain: `${record.dns_name}.${env.CLOUDFLARE_ZONE_NAME}`,
        tunnelToken: record.tunnel_token,
        tunnelUid: record.tunnel_uid,
      });
    }

    // ------------------------------------------------------------
    // ❌ Delete Customer
    // ------------------------------------------------------------
    const delMatch = path.match(/^\/api\/customers\/(\d+)$/);
    if (method === "DELETE" && delMatch) {
      if (!isAuth(req, env)) return jsonResponse({ error: "Unauthorized" }, 401);
      const id = parseInt(delMatch[1]);
      await DB.prepare("DELETE FROM test_customers WHERE id = ?").bind(id).run();
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ------------------------------------------------------------
    // 404 Fallback
    // ------------------------------------------------------------
    return jsonResponse({ error: "Not Found" }, 404);
  },
};
