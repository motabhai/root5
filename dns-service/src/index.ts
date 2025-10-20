// src/index.ts (DNS Service)

export interface Env {
	CLOUDFLARE_ZONE_ID: string;
	CLOUDFLARE_API_TOKEN: string; // This is a secret
}

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head><title>DNS Service</title><style>body { font-family: sans-serif; display: grid; place-items: center; min-height: 90vh; background-color: #f0f0f0; color: #333; }</style></head>
<body><h1>⚙️ DNS Microservice</h1><p>This service is running but is not intended for direct browser access.</p></body>
</html>`;

// --- Authentication Headers ---
function getAuthHeaders(env: Env): { [key: string]: string } {
	if (!env.CLOUDFLARE_API_TOKEN) {
		throw new Error("CLOUDFLARE_API_TOKEN is missing from environment.");
	}
	return {
		'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
		'Content-Type': 'application/json',
	};
}

// --- Cloudflare API Helpers ---
async function createDnsRecord(env: Env, dnsName: string, cnameTarget: string): Promise<void> {
	const zoneId = env.CLOUDFLARE_ZONE_ID;
	if (!zoneId) throw new Error("Missing Cloudflare Zone ID.");

	const apiUrl = `${CLOUDFLARE_API_BASE}/zones/${zoneId}/dns_records`;
	const response = await fetch(apiUrl, {
		method: 'POST',
		headers: getAuthHeaders(env),
		body: JSON.stringify({ type: 'CNAME', name: dnsName, content: cnameTarget, proxied: true, ttl: 1 }),
	});
	if (!response.ok) {
		// This is where your 81053 error is coming from
		const data: any = await response.json();
		throw new Error(`Failed to create DNS record: ${JSON.stringify(data)}`);
	}
}

// ---
// --- FIX: This function is now more robust ---
// ---
async function deleteDnsRecord(env: Env, dnsName: string): Promise<void> {
	const zoneId = env.CLOUDFLARE_ZONE_ID;
	if (!zoneId) return;

	// 1. Find ALL records (A, AAAA, CNAME) with this name.
	const findUrl = `${CLOUDFLARE_API_BASE}/zones/${zoneId}/dns_records?name=${dnsName}`;
	const findResp = await fetch(findUrl, { headers: getAuthHeaders(env) });
	if (!findResp.ok) return;

	const { result }: { result: { id: string }[] } = await findResp.json();
	if (!result || result.length === 0) {
		console.log(`No DNS records found to delete for name: ${dnsName}`);
		return;
	}

	console.log(`Found ${result.length} DNS records to delete for name: ${dnsName}`);

	// 2. Loop and delete every single one.
	const deletePromises = [];
	for (const record of result) {
		const deleteUrl = `${CLOUDFLARE_API_BASE}/zones/${zoneId}/dns_records/${record.id}`;
		deletePromises.push(
			fetch(deleteUrl, { method: 'DELETE', headers: getAuthHeaders(env) })
		);
	}
	
	// Wait for all deletions to complete
	await Promise.all(deletePromises);
	console.log(`Successfully deleted all records for name: ${dnsName}`);
}
// ---
// --- END OF FIX ---
// ---

// --- Main Handler ---
export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext
	): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		const jsonResponse = (data: any, status: number = 200): Response =>
			new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

		if (method === 'GET' && path === '/') {
			return new Response(HTML_CONTENT, { headers: { 'Content-Type': 'text/html' } });
		}

		if (method !== 'POST') {
			return jsonResponse({ error: "Method Not Allowed" }, 405);
		}

		try {
			if (path === "/create") {
				const { dnsName, cnameTarget } = await request.json<{ dnsName: string, cnameTarget: string }>();
				if (!dnsName || !cnameTarget) throw new Error("Missing dnsName or cnameTarget");
				await createDnsRecord(env, dnsName, cnameTarget);
				return jsonResponse({ success: true }, 201);
			}

			if (path === "/delete") {
				const { dnsName } = await request.json<{ dnsName: string }>();
				if (!dnsName) throw new Error("Missing dnsName");
				// This endpoint now uses the new, powerful delete function
				await deleteDnsRecord(env, dnsName);
				return new Response(null, { status: 204 });
			}

			return jsonResponse({ error: "Not Found" }, 404);

		} catch (err: any) {
			return jsonResponse({ error: err.message || "DNS service failed" }, 500);
		}
	},
};