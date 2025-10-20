// index.ts — ZeroTrust Service (Final PUT-based version)

export interface Env {
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  ACCESS_APP_UID: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Check env vars ---
    if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !env.ACCESS_APP_UID) {
      return new Response(JSON.stringify({ error: "Missing env vars" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- Parse request JSON safely ---
    let body: any = {};
    try {
      const raw = await request.text();
      body = JSON.parse(raw || "{}");
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { customerDomain } = body;
    if (!customerDomain) {
      return new Response(JSON.stringify({ error: "Missing customerDomain" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- Setup API base and headers ---
    const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/access/apps/${env.ACCESS_APP_UID}`;
    const headers = {
      "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    };

    try {
      // 1️⃣ Fetch current app details
      const getResp = await fetch(base, { method: "GET", headers });
      const getData = await getResp.json();
      if (!getResp.ok) {
        return new Response(JSON.stringify({ error: "Failed to fetch current app", details: getData }), {
          status: getResp.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      const app = getData.result;
      let domains: string[] = app.self_hosted_domains || [];

      // 2️⃣ Modify domains
      if (path === "/add_domain" && request.method === "POST") {
        if (!domains.includes(customerDomain)) domains.push(customerDomain);
      } else if (path === "/remove_domain" && request.method === "POST") {
        domains = domains.filter((d) => d !== customerDomain);
      } else {
        return new Response("Not Found", { status: 404 });
      }

      // 3️⃣ Build PUT body (required by CF)
      const updatedApp = {
        name: app.name,
        type: app.type,
        session_duration: app.session_duration || "24h",
        self_hosted_domains: domains,
        app_launcher_visible: app.app_launcher_visible ?? true,
        allowed_idps: app.allowed_idps ?? [],
        auto_redirect_to_identity: app.auto_redirect_to_identity ?? false,
        skip_interstitial: app.skip_interstitial ?? true,
        policies: app.policies ?? [],
        tags: app.tags ?? [],
      };

      // 4️⃣ PUT update to CF Access API
      const putResp = await fetch(base, {
        method: "PUT",
        headers,
        body: JSON.stringify(updatedApp),
      });

      const putData = await putResp.json();

      if (!putResp.ok) {
        return new Response(JSON.stringify({ error: "Cloudflare API update failed", details: putData }), {
          status: putResp.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      // ✅ Success
      return new Response(
        JSON.stringify({
          success: true,
          updated_domains: updatedApp.self_hosted_domains,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message || "Unhandled error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};
