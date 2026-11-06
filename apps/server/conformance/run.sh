#!/usr/bin/env bash
# Runs the OpenID Foundation conformance suite against the server's issuer (CI job `oidc-conformance`).
#   Basic OP (code flow, id_token, userinfo, prompt, max_age, code reuse, redirect_uri checks, client_secret_basic and
#   _post), PKCE (S256), and refresh token rotation, plus Config OP (discovery and JWKS).
# Needs docker, python3 and openssl. The suite is pinned by commit, its images by that release tag; apps/server must have its node_modules installed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
kit="$(cd "$here/../../.." && pwd)"
# release-v5.3.3, by commit: a moved tag cannot change what runs.
SUITE_SHA="7d420f716e49d44f8a6b04f0a3e240ad6d68ab55"
work="${CONFORMANCE_WORK:-$(mktemp -d)}"
suite="$work/suite"
certs="$work/certs"
mkdir -p "$certs" "$work/results"

if [ ! -d "$suite" ]; then
  git init --quiet "$suite"
  git -C "$suite" fetch --quiet --depth 1 https://gitlab.com/openid/conformance-suite.git "$SUITE_SHA"
  git -C "$suite" checkout --quiet FETCH_HEAD
fi
[ "$(git -C "$suite" rev-parse HEAD)" = "$SUITE_SHA" ] || { echo "the suite is not at $SUITE_SHA" >&2; exit 1; }
openssl req -x509 -nodes -days 2 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -keyout "$certs/op.key" -out "$certs/op.crt" \
  -subj "/CN=op.agent-team.test" -addext "subjectAltName=DNS:op.agent-team.test" 2>/dev/null
chmod 644 "$certs/op.key"

export KIT_DIR="$kit" CERT_DIR="$certs"
compose=(docker compose -p agent-team-conformance -f "$suite/docker-compose-prebuilt.yml" -f "$here/compose.yml")
trap '"${compose[@]}" logs --no-color op > "$work/op.log" 2>&1 || true; "${compose[@]}" down -v >/dev/null 2>&1 || true' EXIT
"${compose[@]}" up -d --quiet-pull

echo "waiting for the suite"
for _ in $(seq 1 90); do
  curl -skf https://localhost.emobix.co.uk:8443/api/runner/available >/dev/null 2>&1 && break
  sleep 2
done
curl -skf https://localhost.emobix.co.uk:8443/api/runner/available >/dev/null

python3 -m pip install --quiet --require-hashes -r "$here/requirements.txt"
cd "$suite"
CONFORMANCE_SERVER=https://localhost.emobix.co.uk:8443/ CONFORMANCE_DEV_MODE=1 python3 scripts/run-test-plan.py \
  --expected-failures-file "$here/expected-failures.json" \
  --expected-skips-file "$here/expected-skips.json" \
  --export-dir "$work/results" --verbose \
  "oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=dynamic_client]" "$here/suite-config.json" \
  "oidcc-config-certification-test-plan" "$here/suite-config.json"
