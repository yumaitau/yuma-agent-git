# Dedicated ephemeral Linux runner. No application or registry credentials in the image.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker.io git ca-certificates bash curl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY boot.sh /usr/local/bin/yag-runner-boot
RUN chmod +x /usr/local/bin/yag-runner-boot && mkdir -p /workspace
WORKDIR /workspace
ENTRYPOINT ["/bin/sleep", "infinity"]
