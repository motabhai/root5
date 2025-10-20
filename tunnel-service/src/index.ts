// src/index.ts — Tunnel Service (final version, with base64 decode + D1 ready)

export interface Env {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  DB?: D1Database; // Optional: if you later want to save results to D1
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
      return new Response(JSON.stringify({ error: "Missing required environment variables." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    };

    // ------------------------------------------------------------------------
    //  POST /create  → Create a new Cloudflare Tunnel and return UID + Token
    // ------------------------------------------------------------------------
    if (path === "/create" && request.method === "POST") {
      try {
        const body = await request.json();
        const { tunnelName, customerId } = body;
        if (!tunnelName) throw new Error("Missing tunnelName");

        console.log(`🚀 Creating tunnel: ${tunnelName}`);

        // === STEP 1: Create the tunnel ===
        const createResp = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ name: tunnelName, config_src: "cloudflare" }),
          }
        );

        const createData = await createResp.json();
        if (!createResp.ok) {
          console.error("❌ Tunnel creation failed:", createData);
          throw new Error(createData.errors?.[0]?.message || "Tunnel creation failed");
        }

        const tunnelUid = createData.result?.id;
        if (!tunnelUid) throw new Error("Tunnel UID missing");

        console.log(`✅ Tunnel created: ${tunnelUid}`);

        // === STEP 2: Retrieve tunnel token ===
        const tokenURL = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelUid}/token`;
        const tokenResp = await fetch(tokenURL, { method: "GET", headers });
        const rawText = await tokenResp.text();

        console.log("🔍 /token raw response:", rawText);

        let tunnelToken: string | null = null;
        if (tokenResp.ok) {
          try {
            const tokenJson = JSON.parse(rawText);
            const rawToken = tokenJson.result;

            if (typeof rawToken === "string") {
              // Base64 decode the new token format
              const decoded = JSON.parse(atob(rawToken));
              tunnelToken = decoded.s || null;
            } else if (rawToken?.token) {
              tunnelToken = rawToken.token;
            }
          } catch (err) {
            console.warn("⚠️ Failed to decode token JSON:", err);
          }
        } else {
          console.warn("⚠️ Token request failed with status:", tokenResp.status);
        }

        console.log(`🎯 Token extracted: ${tunnelToken ? "OK" : "NULL"}`);

        // === Optional: Save to D1 if bound ===
        if (env.DB && customerId && tunnelUid) {
          try {
            await env.DB.prepare(
              "UPDATE test_customers SET tunnel_uid = ?, tunnel_token = ? WHERE id = ?"
            ).bind(tunnelUid, tunnelToken || null, customerId).run();

            console.log(`💾 Saved tunnel for customer ${customerId}`);
          } catch (dbErr) {
            console.error("⚠️ Failed to save tunnel to D1:", dbErr);
          }
        }

        return new Response(
          JSON.stringify({ success: true, tunnelUid, tunnelToken }),
          { headers: { "Content-Type": "application/json" } }
        );

      } catch (err: any) {
        console.error("❌ Exception:", err.message);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // ------------------------------------------------------------------------
    //  Default route
    // ------------------------------------------------------------------------
    return new Response(
      JSON.stringify({ message: "Tunnel Service OK" }),
      { headers: { "Content-Type": "application/json" } }
    );
  },
};
