# `sandbox/` — sub-agent container assets

These build the **hardened tier**: the disposable per-task containers the provisioning
layer (`src/provisioning.ts`) stands up for each sub-agent, plus their egress proxy.

## Provenance

Ported from [`ai-dev-template`](https://github.com/ernestviola/ai-dev-template)
(`.devcontainer/Dockerfile`, `.devcontainer/Dockerfile.proxy`,
`.devcontainer/tinyproxy.conf`, `.devcontainer/proxy-entrypoint.sh`,
`hooks/allowed-domains.txt`) with these deliberate changes:

- **No git credential helper / `.gitconfig-host` include** in `Dockerfile`. Sub-agents
  never receive git credentials and never run git — a hard boundary in `docs/DESIGN.md`.
- **No docker CLI** in the sub-agent image. The Docker socket belongs to the trusted
  tier alone.
- **No `sleep infinity` / devcontainer / compose lifecycle.** `agent-entrypoint.sh`
  runs once and exits; the orchestrator reads the result and tears the container down.
- **Allowlist baked into the proxy image** rather than mounted via compose, since the
  provisioning layer starts one proxy per run.
- `openrouter.ai` added to the allowlist (the template only had `api.anthropic.com`).

## Follow-up

Once this stabilises, lift `Dockerfile` + the proxy assets **back** into
`ai-dev-template` as a published GHCR base image, and have this repo's sub-agent image
be `FROM ghcr.io/ernestviola/ai-dev-template-base@sha256:...` (pinned by digest). This
directory is effectively the extraction spec for that. Tracked in `docs/CONTEXT.md`.

## Files

| File | Role |
|---|---|
| `Dockerfile` | `orq-sandbox:dev` — sub-agent image. Non-root `agent` (uid 1000), `bash`/`curl`/`ca-certificates`, the agent runtime at `/opt/agent`, entrypoint below. |
| `agent-entrypoint.sh` | Thin shim: `exec node /opt/agent/agent.mjs`. |
| `agent/agent.mjs` | In-container agent runtime (engineer role). Reads `/task/task.json` (ro), asks the model for whole-file `src/` edits, applies them, runs the project test command, feeds failures back up to `ORQ_MAX_ITERS` turns, writes `/out/status.json` + `/out/agent.log`, exits 0 on pass. Node builtins + `undici` (proxy-aware `fetch`). |
| `agent/package.json` | Pins the one runtime dep (`undici`); `npm install`ed into `/opt/agent` at image build. |
| `Dockerfile.proxy` | `orq-proxy:dev` — tinyproxy egress proxy. |
| `tinyproxy.conf` | `FilterDefaultDeny Yes`, `FilterType fnmatch`, CONNECT on 443/80. |
| `proxy-entrypoint.sh` | Renders `allowed-domains.txt` → filter file, execs tinyproxy. |
| `allowed-domains.txt` | Destination allowlist (exact hostnames; `fnmatch`). |
| `build.sh` | `docker build` both images. `npm run sandbox:build`. |

## Runtime hardening lives elsewhere

`--cap-drop=ALL`, `--security-opt no-new-privileges`, read-only root fs, tmpfs, the
per-run internal network, and the role-scoped ro/rw mounts are applied by
`src/provisioning.ts` at container-create time — **not** in these Dockerfiles. The
mount profiles themselves are in `src/roles.ts` (a security-boundary file).

## Build

```sh
npm run sandbox:build        # -> orq-sandbox:dev, orq-proxy:dev
```

Exercise it end to end through the provisioning layer (needs `OPENROUTER_API_KEY`
in `.env.local`):

```sh
npm run dev -- --engineer fixtures/sample-project "Implement fizzbuzz so the tests pass"
```

`agent.mjs`'s loop/parse/apply/test logic (everything except the real model call) is
covered without a key by the stub-server check in the test suite.
