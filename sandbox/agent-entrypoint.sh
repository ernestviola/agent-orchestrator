#!/bin/sh
# Sub-agent container entrypoint.
#
# Contract with the provisioning layer (src/provisioning.ts):
#   - /task/task.json  is mounted read-only and describes the job (role, task text,
#     context). It never contains credentials.
#   - /out             is mounted read-write. The agent process writes its structured
#     result to /out/status.json plus any artifacts, then exits.
#   - The orchestrator reads /out back via ResultStore.finalize() once this container
#     exits. It does NOT assume a shared mount beyond this directory.
#
# PHASE 1: this is a STUB. There is no real agent runtime yet — it echoes a summary
# and records what it was asked to do, so the provisioning layer can be exercised
# end to end (mounts, network, teardown, result handoff) before any LLM code exists.
set -eu

TASK_FILE="${TASK_FILE:-/task/task.json}"
OUT_DIR="${OUT_DIR:-/out}"

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

role="unknown"
task_text=""
if [ -f "$TASK_FILE" ]; then
  # Minimal, dependency-free extraction — the stub does not need a JSON parser.
  role="$(sed -n 's/.*"role"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TASK_FILE" | head -n1)"
  task_text="$(sed -n 's/.*"task"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TASK_FILE" | head -n1)"
fi

# Prove the role-scoped mounts are shaped as expected (visible in /out/container.log).
echo "sub-agent stub starting: role=${role:-unknown}"
echo "workspace contents:"
ls -la /workspace 2>&1 || true

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$OUT_DIR/status.json" <<EOF
{
  "status": "completed",
  "role": "${role:-unknown}",
  "summary": "phase-1 stub: received task '${task_text}' as role '${role:-unknown}'",
  "startedAt": "${started_at}",
  "finishedAt": "${finished_at}"
}
EOF

echo "wrote ${OUT_DIR}/status.json"
