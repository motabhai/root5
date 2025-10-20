// src/index.ts — Customer Manager (Final version with assets binding)

export interface Env {
  DB: D1Database;
  DNS_SERVICE: Fetcher;
  TUNNEL_SERVICE: Fetcher;
  ZEROTRUST_SERVICE: Fetcher;
  WORKER_API_TOKEN: string;
  CLOUDFLARE_ZONE_NAME: string;
  HTML_PAGES: Fetcher; // Bound via [assets]
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonResponse = (d: any, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });

const isAuth = (req: Request, env: Env) =>
  req.headers.get("Authorization") === "Bearer " + env.WORKER_API_TOKEN;

function getMimeType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "text/plain";
}

// ----------------------------------------------------------------------
// Main Handler
// ----------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const { DB } = env;

    // Handle CORS preflight
    if (method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    // ------------------------------------------------------------------
    // Serve static HTML and assets from /public
    // ------------------------------------------------------------------
    if (method === "GET" && !path.startsWith("/api/")) {
      let pagePath = path === "/" ? "index.html" : path.replace(/^\/+/, "");
      if (!pagePath.includes(".")) pagePath += ".html";

      const file =
        (await env.HTML_PAGES.get(pagePath, { type: "text" })) ||
        (await env.HTML_PAGES.get("index.html", { type: "text" }));

      if (file)
        return new Response(file, {
          headers: { "Content-Type": getMimeType(pagePath) },
        });

        if (env.HTML_PAGES) {
      try {
        // Try to serve static files directly from /public
        const assetResponse = await env.HTML_PAGES.fetch(req);
        if (assetResponse.status !== 404) return assetResponse;
      } catch (e) {
        console.warn("Static asset fetch failed:", e.message);
      }
    }

      return new Response("404 Not Found", { status: 404 });
    }

    // ------------------------------------------------------------------
    // Initialize Database
    // ------------------------------------------------------------------
    if (method === "POST" && path === "/init") {
      if (!isAuth(req, env)) return jsonResponse({ error: "Unauthorized" }, 401);

      await DB.batch([
        DB.prepare("DROP TABLE IF EXISTS customer_dns;"),
        DB.prepare("DROP TABLE IF EXISTS test_customers;"),
        DB.prepare(`CREATE TABLE test_customers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          note TEXT,
          tunnel_uid TEXT,
          tunnel_token TEXT
        );`),
        DB.prepare(`CREATE TABLE customer_dns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL UNIQUE,
          dns_name TEXT NOT NULL UNIQUE,
          FOREIGN KEY(customer_id) REFERENCES test_customers(id) ON DELETE CASCADE
        );`),
      ]);
      return jsonResponse({ success: true, message: "Tables reset" });
    }

    // ------------------------------------------------------------------
    // Step 1: Create Customer
    // ------------------------------------------------------------------
    if (method === "POST" && path === "/api/provision/customer") {
      if (!isAuth(req, env)) return jsonResponse({ error: "Unauthorized" }, 401);
      const body = await req.json();
      const name = (body.name || "").trim();
      if (!name) return jsonResponse({ error: "Missing name" }, 400);
      const note = (body.note || "").trim();

      const result = await DB.prepare(
        "INSERT INTO test_customers (name, note) VALUES (?, ?) RETURNING id AS customerId"
      )
        .bind(name, note || null)
        .first();

      return jsonResponse(result);
    }

    // ------------------------------------------------------------------
    // Step 2: Create Tunnel via Service
    // ------------------------------------------------------------------
    if (method === "POST" && path === "/api/provision/tunnel_and_update") {
      if (!isAuth(req, env)) return jsonResponse({ error: "Unauthorized" }, 401);
      const body = await req.json();
      const { customerId, name } = body;
      if (!customerId || !name)
        return jsonResponse({ error: "Missing customerId or name" }, 400);

      const tunnelResp = await env.TUNNEL_SERVICE.fetch("https://dummy/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tunnelName: `customer-${customerId}-${name}`,
        }),
      });

      const tunnelData = await tunnelResp.json();
      if (!tunnelResp.ok || !tunnelData.success)
        return jsonResponse(
          { error: "Tunnel creation failed", details: tunnelData },
          500
        );

      const { tunnelUid, tunnelToken } = tunnelData;
      await DB.prepare(
        "UPDATE test_customers SET tunnel_uid = ?, tunnel_token = ? WHERE id = ?"
      )
        .bind(tunnelUid, tunnelToken || null, customerId)
        .run();

      return jsonResponse({ success: true, tunnelUid });
    }

    // ------------------------------------------------------------------
    // Step 3: Create DNS
    // ------------------------------------------------------------------
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

    // ------------------------------------------------------------------
    // Step 4: Add Domain to Zero Trust
    // ------------------------------------------------------------------
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

    // ------------------------------------------------------------------
    // Customer list / delete
    // ------------------------------------------------------------------
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

    const del = path.match(/^\/api\/customers\/(\d+)$/);
    if (method === "DELETE" && del) {
      if (!isAuth(req, env)) return jsonResponse({ error: "Unauthorized" }, 401);
      const id = parseInt(del[1]);
      await DB.prepare("DELETE FROM test_customers WHERE id = ?").bind(id).run();
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
