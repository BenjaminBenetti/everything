#!/usr/bin/env bash
# Run voice-asr's Python tests that need no model: units, the WebSocket contract against the test-only
# fake worker, the hardening follow-ups, and model provisioning. They run in a virtual environment in
# the repository's ignored .local directory, holding the hash-locked runtime dependency, because some
# tests start the service as a separate process with its own environment. The real-native suite,
# tests/test_native.py, needs the model and the built worker; see README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
environment=$(cd ../.. && pwd)/.local/voice-asr-venv
if [ ! -x "$environment/bin/python" ]; then
  "${PYTHON:-python3}" -m venv "$environment"
  "$environment/bin/python" -m pip install --quiet --disable-pip-version-check --no-deps --require-hashes \
    -r requirements.lock
fi
PYTHONPATH="src:tests" "$environment/bin/python" -m unittest \
  tests.test_units tests.test_contract tests.test_live tests.test_followup tests.test_provision
