# Sub-agent container image (the hardened tier).
#
# Ported from ai-dev-template's .devcontainer/Dockerfile
# (github.com/ernestviola/ai-dev-template) with two deliberate removals:
#   - NO git credential helper / .gitconfig-host include. Sub-agents never receive
#     git credentials and never perform git operations (docs/DESIGN.md hard boundary).
#   - NO docker CLI. The Docker socket is the trusted tier's alone.
#
# Runtime hardening (--cap-drop=ALL, --security-opt no-new-privileges, read-only
# rootfs, network via the egress proxy only) is applied by the provisioning layer at
# container-create time, not here — see src/roles.ts / src/provisioning.ts.
#
# Follow-up: this should converge onto a published ai-dev-template GHCR base image
# consumed by digest. See sandbox/README.md and docs/CONTEXT.md.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root user the sub-agent process runs as (uid/gid 1000).
# node:22-slim ships a `node` user at 1000 — displace it so the account is named
# `agent` (src/roles.ts references the profiles by this name).
RUN userdel -r node 2>/dev/null || true; \
    groupadd -g 1000 agent && useradd -u 1000 -g agent -m agent

# In-container agent runtime. `undici` gives a proxy-aware fetch (Node 22's global
# fetch ignores HTTP(S)_PROXY). Installed at build time; the rootfs is read-only at
# run time. Node builtins + this one dep, nothing else.
COPY agent/ /opt/agent/
RUN cd /opt/agent && npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY agent-entrypoint.sh /usr/local/bin/agent-entrypoint.sh
RUN chmod +x /usr/local/bin/agent-entrypoint.sh

USER agent
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/agent-entrypoint.sh"]
