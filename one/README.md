# ONE Worker

This worker automates the provisioning of DNS records, Cloudflare Tunnels, and Zero Trust Access applications for customers.

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

### Local Development Secrets

For local development, create a `.dev.vars` file in this directory and add the following:

```
AUTH_TOKEN="<your-auth-token>"
CLOUDFLARE_API_TOKEN="<your-cloudflare-api-token>"
CLOUDFLARE_ACCOUNT_ID="<your-cloudflare-account-id>"
CLOUDFLARE_ZONE_ID="<your-cloudflare-zone-id>"
```

`wrangler` will automatically load these variables when you run `npm run dev`.

### Deployed Worker Secrets

For the deployed worker, you need to set these as encrypted secrets using `wrangler`:

```bash
# Set the token for authenticating to the worker
echo "<your-auth-token>" | npx wrangler secret put AUTH_TOKEN

# Set the token for the worker to call the Cloudflare API
echo "<your-cloudflare-api-token>" | npx wrangler secret put CLOUDFLARE_API_TOKEN
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
