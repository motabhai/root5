# ONE Worker

This worker automates the provisioning of DNS records (now including `ha.`, `ssh.`, and `plc.` prefixes), Cloudflare Tunnels, and Zero Trust Access applications for customers.

## Local Development

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Run Locally**:
    ```bash
    npm run dev
    ```
    This will start a local server with a hot-reload environment.

## Secrets

This worker requires the following secrets to be set:

*   `AUTH_TOKEN`: A secret token to authenticate requests to the worker's API.
*   `CLOUDFLARE_API_TOKEN`: A Cloudflare API token with permissions to edit DNS, Tunnels, and Access applications.
*   `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID.
*   `CLOUDFLARE_ZONE_ID`: The Cloudflare zone ID where DNS records will be created.
*   `TUNNEL_SERVICE_TOKEN`: A Cloudflare API token with permissions for Tunnel management.
*   `DNS_SERVICE_TOKEN`: A Cloudflare API token with permissions for DNS record management.
*   `ZTNA_TOKEN`: A Cloudflare API token with permissions for Zero Trust Access application management.

### Local Development Secrets

For local development, create a `.dev.vars` file in this directory and add the following:

```
AUTH_TOKEN="<your-auth-token>"
CLOUDFLARE_API_TOKEN="<your-cloudflare-api-token>"
CLOUDFLARE_ACCOUNT_ID="<your-cloudflare-account-id>"
CLOUDFLARE_ZONE_ID="<your-cloudflare-zone-id>"
TUNNEL_SERVICE_TOKEN="<your-tunnel-service-token>"
DNS_SERVICE_TOKEN="<your-dns-service-token>"
ZTNA_TOKEN="<your-ztna-token>"
```

`wrangler` will automatically load these variables when you run `npm run dev`.

### Deployed Worker Secrets

For the deployed worker, you need to set these as encrypted secrets using `wrangler`:

```bash
# Set the token for authenticating to the worker
echo "<your-auth-token>" | npx wrangler secret put AUTH_TOKEN

# Set the token for the worker to call the Cloudflare API
echo "<your-cloudflare-api-token>" | npx wrangler secret put CLOUDFLARE_API_TOKEN

# Set the token for Tunnel service
echo "<your-tunnel-service-token>" | npx wrangler secret put TUNNEL_SERVICE_TOKEN

# Set the token for DNS service
echo "<your-dns-service-token>" | npx wrangler secret put DNS_SERVICE_TOKEN

# Set the token for Zero Trust Access service
echo "<your-ztna-token>" | npx wrangler secret put ZTNA_TOKEN
```

## Deployment

### Manual Deployment

To deploy the worker manually, run:

```bash
npm run deploy
```

### Automated Deployment

The included GitHub Actions workflow in `.github/workflows/one-deploy.yml` will automatically deploy the worker when changes are pushed to the `main` branch.

For this to work, you need to add the following secrets to your GitHub repository's secrets:

*   `CLOUDFLARE_API_TOKEN`
*   `CLOUDFLARE_ACCOUNT_ID`
*   `CLOUDFLARE_ZONE_ID`
*   `AUTH_TOKEN`

## Changelog

### 2025-10-28

*   **DNS Record Generation:** Modified `hostnameFor` to generate `ha.`, `ssh.`, and `plc.` prefixed hostnames. The base `cust[id].chromebased.net` is no longer generated directly.
*   **API Updates:**
    *   `/api/provision` now creates multiple DNS records and stores their IDs in an array.
    *   `/api/dns` now accepts a `type` parameter for specific DNS record creation.
    *   `/api/deprovision` updated to handle deletion of multiple DNS records.
*   **Database Schema:** Updated `customers` table to include `dns_record_ids` array and individual `dns_record_id_ha`, `dns_record_id_ssh`, `dns_record_id_plc` fields.
*   **Test Fixes:** Updated unit tests to reflect new hostname generation and database schema.
*   **Build Configuration:** Added `root: '.'` to `vitest.config.ts` to resolve `wrangler.jsonc` parsing errors during testing.
