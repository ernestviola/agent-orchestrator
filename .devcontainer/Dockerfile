FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git bash curl ca-certificates gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN git config --global include.path /root/.gitconfig-host
RUN git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f'

WORKDIR /workspace