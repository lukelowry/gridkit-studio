# GridKit Studio's default GridKit image, pinned by digest: DynamicSimulation on PATH.
FROM ghcr.io/lukelowry/gridkit:latest@sha256:79cf2400321b91f869148afc50182c897df57705e2e67089b245d05e57be8001
USER root
# Git for the source suite, download tools, and the libraries and Xvfb a headless VS Code needs.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl xz-utils libnss3 libgtk-3-0 libgbm1 libasound2t64 xvfb && rm -rf /var/lib/apt/lists/*
