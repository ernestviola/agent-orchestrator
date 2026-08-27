#!/bin/sh
# Sub-agent container entrypoint — a thin shim over the Node agent runtime.
#
# Contract with the provisioning layer (src/provisioning.ts):
#   - /task/task.json   (ro)  the job: { role, task, context }. Never has credentials.
#   - /workspace/src    (rw)  working copy the agent edits (engineer role)
#   - /workspace/tests  (ro)  read-only context
#   - /out              (rw)  agent writes status.json + agent.log here, then exits
#   - The orchestrator retrieves /out via ResultStore.finalize() after the container
#     exits; it does not assume a shared mount beyond this directory.
set -eu
exec node /opt/agent/agent.mjs
