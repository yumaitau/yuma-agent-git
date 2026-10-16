# Dedicated ephemeral Linux runner. No application or registry credentials in the image.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker.io git ca-certificates bash curl python3 make g++ unzip \
    && rm -rf /var/lib/apt/lists/*

# Deployment tools (issue #50): pinned and checksum-verified, linux/amd64.
# Jobs authenticate with OIDC (AWS_WEB_IDENTITY_TOKEN_FILE), never baked-in keys.
# Bump a version together with its SHA-256 from the vendor's release page.
ARG AWS_CLI_VERSION=2.37.6
ARG AWS_CLI_SHA256=cd40c7d1f41b3a4964e77a65377e480d71fe6ebc96bbbb64eb2239d69af6fbb2
ARG HELM_VERSION=v3.22.0
ARG HELM_SHA256=1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb
ARG KUBECTL_VERSION=v1.37.1
ARG KUBECTL_SHA256=65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8
RUN set -eux; cd /tmp; \
    curl -fsSLo awscli.zip "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWS_CLI_VERSION}.zip"; \
    echo "${AWS_CLI_SHA256}  awscli.zip" | sha256sum -c -; \
    unzip -q awscli.zip; ./aws/install; rm -rf aws awscli.zip; \
    curl -fsSLo helm.tgz "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz"; \
    echo "${HELM_SHA256}  helm.tgz" | sha256sum -c -; \
    tar -xzf helm.tgz linux-amd64/helm; install -m 0755 linux-amd64/helm /usr/local/bin/helm; rm -rf linux-amd64 helm.tgz; \
    curl -fsSLo kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl"; \
    echo "${KUBECTL_SHA256}  kubectl" | sha256sum -c -; \
    install -m 0755 kubectl /usr/local/bin/kubectl; rm kubectl; \
    aws --version; helm version --short; kubectl version --client

COPY boot.sh /usr/local/bin/yag-runner-boot
RUN chmod +x /usr/local/bin/yag-runner-boot && mkdir -p /workspace
WORKDIR /workspace
ENTRYPOINT ["/bin/sleep", "infinity"]
