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
| `Dockerfile` | `orq-sandbox:dev` — sub-agent image. Non-root `agent` (uid 1000), `bash`/`curl`/`ca-certificates`, entrypoint below. |
| `agent-entrypoint.sh` | Reads `/task/task.json` (ro), runs the agent process, writes `/out/status.json` + artifacts (rw), exits. **Phase 1: a stub.** |
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

Sanity-check the sub-agent image by hand:

```sh
mkdir -p /tmp/t/in /tmp/t/out
echo '{"role":"engineer","task":"noop"}' > /tmp/t/in/task.json
docker run --rm \
  -v /tmp/t/in:/task:ro -v /tmp/t/out:/out \
  --cap-drop=ALL --security-opt no-new-privileges --read-only \
  --tmpfs /tmp orq-sandbox:dev
cat /tmp/t/out/status.json
```
