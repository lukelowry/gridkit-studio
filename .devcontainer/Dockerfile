# GridKit Studio's default GridKit image: DynamicSimulation and ContingencyAnalysis on PATH.
FROM ghcr.io/lukelowry/gridkit:latest
USER root
# Git for the source suite, download tools, and the libraries and Xvfb a headless VS Code needs.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl xz-utils libnss3 libgtk-3-0 libgbm1 libasound2t64 xvfb && rm -rf /var/lib/apt/lists/*
