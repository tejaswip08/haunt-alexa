#!/bin/bash
# Local development with REAL Cognito email-code sign-in (no mock auth).
# Requires AWS credentials for the haunt profile and the haunt-web client id. Nothing here creates users or sends email.
set -euo pipefail
: "${HAUNT_COGNITO_CLIENT_ID:?Set HAUNT_COGNITO_CLIENT_ID to the haunt-web app client id (not a secret).}"
export NODE_ENV=development
export AWS_PROFILE="${AWS_PROFILE:-haunt}"
export AWS_REGION=us-east-1
export HAUNT_STORE=dynamodb
export AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8001
export HAUNT_PORT=3001
export HAUNT_PROVIDER=mock HAUNT_AGENT=mock HAUNT_TTS="${HAUNT_TTS:-browser}" HAUNT_PREWRITE=off
unset HAUNT_AUTH
export HAUNT_COGNITO_CLIENT_ID
export HAUNT_COGNITO_USER_POOL_ID="${HAUNT_COGNITO_USER_POOL_ID:-us-east-1_nHfQditMF}"
exec npm run dev -w @haunt/server
