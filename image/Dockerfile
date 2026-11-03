# boxie base worker image: Node, git, the search tools and OpenCode. No credentials are baked in.
# A project that needs more (a JDK, Go, Rust, CMake) adds it in projects/<repo>.Dockerfile, FROM this
# image, built by `delegate.sh build <repo>`. make, g++ and python3 stay: node-gyp builds need them.
FROM node:24-bookworm

ARG OPENCODE_VERSION=1.19.4
ARG OCR_VERSION=1.13.4

RUN apt-get update \
 && apt-get install -y --no-install-recommends git jq ripgrep python3 make g++ ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" && npm cache clean --force
# open-code-review, the review engine lib/ocr.mjs runs in this image (ROLE_* = ocr:<model>): read-only
# tools only, the repository mounted read-only. The AACR bench measured this version (2026-11-03).
RUN npm install -g "@alibaba-group/open-code-review@${OCR_VERSION}" && npm cache clean --force && ocr version

# Vineflower (Java decompiler, Apache-2.0) for `api src`: workers read dependency behaviour as source
# instead of javap -c bytecode. Used only where the project image has a JDK. Pinned and verified.
RUN mkdir -p /opt/boxie \
 && curl -fsSL -o /opt/boxie/vineflower.jar https://repo1.maven.org/maven2/org/vineflower/vineflower/1.10.1/vineflower-1.10.1.jar \
 && echo "b9b208e50793b64657a6b6292067526613f549de7405f9243624b02f4276e409  /opt/boxie/vineflower.jar" | sha256sum -c -

# The plugin first: OpenCode installs its plugin package on the warm-up start below.
COPY plugin.js /home/node/.config/opencode/plugins/boxie.js
RUN mkdir -p /work/repo/node_modules /in /out /home/node/.npm /home/node/.cache/boxie-api \
 && chown -R node:node /work /in /out /home/node

USER node
ENV OPENCODE_DISABLE_AUTOUPDATE=1
# OpenCode npm-installs its plugin package (@opencode-ai/plugin) into ~/.config/opencode on its first
# start, before the first session answers: 18-20 s in every fresh container (measured 2026-10-23,
# serve listening at 1.3 s, first /session at 19-22 s). One start here bakes it into the image.
RUN mkdir -p /tmp/warm && cd /tmp/warm && git init -q \
 && { opencode serve --hostname 127.0.0.1 --port 4096 >/tmp/warm.log 2>&1 & } \
 && for i in $(seq 1 240); do curl -fs -m 1 http://127.0.0.1:4096/session >/dev/null && break; sleep 0.5; done \
 && pkill -f "[o]pencode serve"; sleep 1 \
 ; test -d /home/node/.config/opencode/node_modules/@opencode-ai/plugin || { cat /tmp/warm.log; exit 1; } \
 && rm -rf /tmp/warm /tmp/warm.log /home/node/.local/share/opencode /home/node/.local/state/opencode
# The harness scripts last: editing one rebuilds only these layers, not the warm-up above.
USER root
COPY run-task.sh /usr/local/bin/run-task.sh
COPY api.mjs /usr/local/bin/api
COPY changed-tests.sh /opt/boxie/changed-tests.sh
COPY preamble.md preamble-review.md preamble-advise.md preamble-explore.md preamble-speccheck.md preamble-specgate.md make-config.mjs ask-mcp.mjs progress.mjs syntax-check.mjs last-stop.mjs recover-final.mjs fanout.mjs anchor.mjs filter.mjs review-state.mjs review-merge.mjs /opt/boxie/
COPY --chown=node:node skills/ /home/node/.config/opencode/skills/
RUN chmod 755 /usr/local/bin/run-task.sh /usr/local/bin/api /opt/boxie/changed-tests.sh
USER node
# A UTF-8 locale: Java 17 reads sources in the locale's encoding, and the default POSIX one compiled
# RakunLoots' UTF-8 sources as US-ASCII (RakunLoots P9, 2026-10-21).
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
WORKDIR /work
ENTRYPOINT ["sleep", "infinity"]
