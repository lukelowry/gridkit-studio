# GridKit's DynamicSimulation, pinned by digest. It writes CSV; Studio imports Arrow results itself.
FROM ghcr.io/lukelowry/gridkit:arrow@sha256:2d3a57865c56a7bda2602c21145d638557371ef945187f0842b80fa3d8c1bc59
USER root
# Git for the source suite, download tools, and the libraries and Xvfb a headless VS Code needs.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl xz-utils libnss3 libgtk-3-0 libgbm1 libasound2t64 xvfb && rm -rf /var/lib/apt/lists/*
