#!/bin/bash

# ==============================================================================
#  Mini PC Tunnel Connector Script
# ==============================================================================
#
#  This script fetches a unique tunnel command from the provisioning server
#  and executes it to connect this device to the Cloudflare network.
#
#  Usage:
#  ./minipc_script.sh <customer_id>
#
#  Example:
#  ./minipc_script.sh 1
#

# --- Configuration ---
# The base URL of your worker application
API_BASE_URL="https://one.pavol-eisenberg.workers.dev"

# The authentication token for the API.
# IMPORTANT: In a real product, this should be stored securely,
# for example, in a protected file or an encrypted hardware store.
AUTH_TOKEN="0%7wQk0#KgUtbl3O"


# --- Script Logic ---

# 1. Check for Customer ID input
CUSTOMER_ID=$1
if [ -z "$CUSTOMER_ID" ]; then
  echo "Error: Customer ID is required."
  echo "Usage: $0 <customer_id>"
  exit 1
fi

echo "Starting provisioning for Customer ID: $CUSTOMER_ID"

# 2. Construct the API endpoint URL
COMMAND_URL="$API_BASE_URL/api/customers/$CUSTOMER_ID/command"
echo "Fetching command from: $COMMAND_URL"

# 3. Fetch the command from the API and capture response details
# Use -w to output the HTTP status code on a new line after the body
API_RESPONSE=$(curl -sS -w "\\n%{http_code}" -H "Authorization: Bearer $AUTH_TOKEN" "$COMMAND_URL")
HTTP_CODE=$(echo "$API_RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$API_RESPONSE" | sed '$d')

# 4. Check for a successful HTTP response
if [ "$HTTP_CODE" -ne 200 ]; then
  echo "Error: API request failed with HTTP status code $HTTP_CODE."
  echo "Server response:"
  echo "$RESPONSE_BODY"
  exit 1
fi

# 5. Try to parse the command from the JSON response
RUN_COMMAND=$(echo "$RESPONSE_BODY" | jq -r '.run_command')
if [ $? -ne 0 ]; then
    echo "Error: Failed to parse JSON response from server."
    echo "Raw server response:"
    echo "$RESPONSE_BODY"
    exit 1
fi

# 6. Check if the command was retrieved successfully
if [ -z "$RUN_COMMAND" ] || [ "$RUN_COMMAND" == "null" ]; then
  echo "Error: Could not retrieve a valid run command from the server."
  echo "Please check the customer ID and ensure it has been provisioned."
  exit 1
fi

# 7. Execute the retrieved command
echo "Command retrieved successfully. Starting Cloudflare tunnel..."
echo "Executing: $RUN_COMMAND"

# Use eval to properly execute the command string with its arguments
eval $RUN_COMMAND

echo "Tunnel process finished."
