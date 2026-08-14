# A machine that has never seen this project. Installs the PUBLISHED package
# from npm rather than the working tree, so the test covers what users get:
# the tarball's contents, its dependency closure, and whether a profile
# composes from a cold start.
#
# python3/make/g++ are here for dsh, not for this plugin. dsh depends on
# node-pty, which ships no linux-arm64 prebuild, so on ARM it compiles from
# source and a toolchain-free image fails before this plugin is reached.
FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /work
COPY smoke.sh /usr/local/bin/smoke
ENTRYPOINT ["/usr/local/bin/smoke"]
