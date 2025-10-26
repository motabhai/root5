<#
Usage:
  # set environment variables first (PowerShell)
  $env:AUTH_TOKEN = 'your-auth-token'
  # optionally set API_URL (defaults to local wrangler dev)
  $env:API_URL = 'http://127.0.0.1:8787'
  # then run
  pwsh .\one\scripts\add-dns.ps1 -Id 1 -Domain 'example.com'
#>

param(
  [Parameter(Mandatory=$true)][int]$Id,
  [Parameter(Mandatory=$true)][string]$Domain,
  # Optional: pass token on the command line to avoid exporting environment variables
  [Parameter(Mandatory=$false)][string]$Token,
  # Optional: override API URL
  [Parameter(Mandatory=$false)][string]$ApiUrl
)


# If a token was passed on the command line, use it (avoids exporting env vars)
if ($Token) { $env:AUTH_TOKEN = $Token }

if (-not $env:AUTH_TOKEN) {
  Write-Error "AUTH_TOKEN not found. Either set the environment variable or pass -Token '<token>' to this script."
  exit 1
}

# Allow overriding API url via param or env
$apiUrl = $ApiUrl
if (-not $apiUrl) { $apiUrl = $env:API_URL }
if (-not $apiUrl) { $apiUrl = 'http://127.0.0.1:8787' }

try {
  $masked = $env:AUTH_TOKEN
  if ($masked.Length -gt 8) { $masked = $masked.Substring(0,4) + '...' + $masked.Substring($masked.Length -4) }
} catch { $masked = '<hidden>' }
Write-Host "Using API URL: $apiUrl  (auth: $masked)"

$body = @{ id = $Id; domain = $Domain } | ConvertTo-Json

try {
  Write-Host "Calling POST $apiUrl/api/dns to add DNS record for cust$Id.$Domain"
  $res = Invoke-RestMethod -Uri "$apiUrl/api/dns" -Method Post -Headers @{ Authorization = "Bearer $($env:AUTH_TOKEN)"; 'Content-Type' = 'application/json' } -Body $body
  Write-Host "Response:"; $res | ConvertTo-Json -Depth 5
} catch {
  Write-Error "Error calling API: $_"
}

try {
  Write-Host "Fetching customers from $apiUrl/api/customers"
  $rows = Invoke-RestMethod -Uri "$apiUrl/api/customers" -Method Get -Headers @{ Authorization = "Bearer $($env:AUTH_TOKEN)" }
  Write-Host "Customers:"; $rows | ConvertTo-Json -Depth 5
} catch {
  Write-Error "Error fetching customers: $_"
}
