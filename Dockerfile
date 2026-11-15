# Self-contained build: dependencies are installed and the plugin is built inside Linux, so the host needs only Docker.

# Build stage: install the dependencies and build the plugin. The compilers are node-pty's fallback (node-gyp) on a platform it has
# no prebuilt binary for; they stay out of the runtime image.
FROM node:24.22.2-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates curl gnupg \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@11.7.0

# mise installs each repository's toolchains in the host's setup step (T11.2, D10). Exact release; the archive's SHA-256 is checked
# per architecture before it is unpacked (the sums are from the release's SHASUMS256.txt, whose minisign signature was verified
# when the version was pinned).
ARG TARGETARCH
ARG MISE_VERSION=2026.10.25
ARG MISE_SHA256_AMD64=199966edaad1b208eb4c72955f1722dafb8fa799f575db720dea05aaa8216546
ARG MISE_SHA256_ARM64=a7d1e2add53441ff76e7e971e7a3fb15c117741836ce51c026f5fb7eebe7dbcf
RUN set -eu; \
  case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
    amd64) arch=x64; sum="$MISE_SHA256_AMD64" ;; \
    arm64) arch=arm64; sum="$MISE_SHA256_ARM64" ;; \
    *) echo "no mise checksum for ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL --proto '=https' --retry 5 --retry-all-errors --retry-delay 3 -o /tmp/mise.tar.gz "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${arch}.tar.gz"; \
  echo "${sum}  /tmp/mise.tar.gz" | sha256sum -c -; \
  mkdir -p /opt/mise/bin; \
  tar -xzf /tmp/mise.tar.gz -C /tmp mise/bin/mise; \
  install -m 0755 /tmp/mise/bin/mise /opt/mise/bin/mise; \
  rm -rf /tmp/mise /tmp/mise.tar.gz; \
  /opt/mise/bin/mise --version
# Test services (T12.1, D11): PostgreSQL's apt key, checked by its fingerprint, and Apache Kafka's release, checked by its SHA-512.
# Kafka is Java bytecode, the same on every architecture.
ARG PGDG_FINGERPRINT=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
ARG KAFKA_VERSION=4.4.0
ARG KAFKA_SHA512=f5ceba8a265ab6bb2d68362b1f6859a95e15d60ef92ba83b43fdf065b557dc18e98d6383c15b9977320e25b3a2c8b6f11decb17b0fa6c0f163423793a0eb95cb
RUN set -eu; \
  curl -fsSL --proto '=https' --retry 5 --retry-all-errors --retry-delay 3 -o /tmp/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
  test "$(gpg --show-keys --with-colons /tmp/pgdg.asc | awk -F: '/^fpr/ { print $10; exit }')" = "$PGDG_FINGERPRINT"; \
  mkdir -p /out/keyrings; gpg --dearmor -o /out/keyrings/pgdg.gpg /tmp/pgdg.asc; rm /tmp/pgdg.asc; \
  curl -fsSL --proto '=https' --retry 5 --retry-all-errors --retry-delay 3 -o /tmp/kafka.tgz "https://archive.apache.org/dist/kafka/${KAFKA_VERSION}/kafka_2.13-${KAFKA_VERSION}.tgz"; \
  echo "${KAFKA_SHA512}  /tmp/kafka.tgz" | sha512sum -c -; \
  mkdir -p /opt/kafka; tar -xzf /tmp/kafka.tgz -C /opt/kafka --strip-components=1; rm /tmp/kafka.tgz; \
  rm -rf /opt/kafka/site-docs
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile \
  && mkdir -p /out \
  && pnpm licenses list --long > /out/node-packages.txt
COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
RUN pnpm build

# Runtime stage: the same base image, so the built addons match. It has a C/C++ toolchain and the headers most backend
# dependencies build against, so a job's `pip install` or `npm install` can compile a package with no wheel or
# prebuilt binary for the platform (psycopg2, mysqlclient, bcrypt, node-gyp modules). Like the other packages here they come from
# the base image's pinned Debian release (bookworm) and its security updates, not by exact package version: the archive drops
# superseded versions, so exact pins would break the build within weeks.
FROM node:24.22.2-bookworm-slim
ARG VERSION=0.1.0
LABEL org.opencontainers.image.title="Workflow Agent" \
      org.opencontainers.image.description="A self-hosted coding agent that works through Jira, Mattermost and GitLab, with people approving each step" \
      org.opencontainers.image.source="https://github.com/raisultan/workflow-agent" \
      org.opencontainers.image.licenses="Apache-2.0 AND MIT" \
      org.opencontainers.image.version="${VERSION}"
RUN apt-get update \
  && apt-get install -y --no-install-recommends git bubblewrap ca-certificates \
    build-essential pkg-config \
    libpq-dev default-libmysqlclient-dev libffi-dev libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev liblzma-dev \
    libxml2-dev libxslt1-dev \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/workbench/state /var/lib/workbench/work /var/lib/workbench/toolchains \
  && chown -R node:node /var/lib/workbench \
  && chmod 0700 /var/lib/workbench/state \
  && chmod 0755 /var/lib/workbench/work /var/lib/workbench/toolchains

# mise, outside every PATH: only the host's setup step runs it, by this path; no sandbox gets it (T11.0).
COPY --from=build /opt/mise/bin/mise /opt/mise/bin/mise
COPY third_party/mise.LICENSE /opt/mise/LICENSE

# Test services (T12.1, D11): Postgres 15–18 from PostgreSQL's own repository (server packages only, no cluster made), RabbitMQ and
# Java 17 from Debian, and Kafka. Each job's commands start them inside their own sandbox, on first connection (src/sandbox/services.ts).
COPY --from=build /out/keyrings/pgdg.gpg /usr/share/keyrings/pgdg.gpg
COPY --from=build /opt/kafka /opt/kafka
RUN echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && mkdir -p /etc/postgresql-common/createcluster.d \
  && echo "create_main_cluster = false" > /etc/postgresql-common/createcluster.d/workbench.conf \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-15 postgresql-16 postgresql-17 postgresql-18 rabbitmq-server openjdk-17-jre-headless \
  && rm -rf /var/lib/apt/lists/*
# Each service's data, prepared once as the user that runs it (initdb refuses root), then owned by root and read-only: a start
# copies it into the sandbox's /tmp instead of initialising. The script uses only Node's own modules, so it runs before the rest.
# One step, so the data is not stored twice in the image's layers.
COPY src/sandbox/services.ts /opt/workbench-services-build/services.mts
RUN mkdir -p /opt/workbench-services && chown node:node /opt/workbench-services \
  && runuser -u node -- node /opt/workbench-services-build/services.mts --build /opt/workbench-services \
  && chown -R root:root /opt/workbench-services && chmod -R a+rX,go-w /opt/workbench-services && rm -rf /opt/workbench-services-build

WORKDIR /workspace

# The licences (NOTICE lists what the image contains), and the generated licence list of the Node packages it ships.
COPY LICENSE NOTICE ./
COPY third_party ./third_party
COPY --from=build /out/node-packages.txt ./third_party/node-packages.txt
COPY --from=build /workspace/package.json /workspace/pnpm-lock.yaml /workspace/pnpm-workspace.yaml ./
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/lib ./lib
COPY tsconfig.json ./
RUN ln -sfn /workspace/node_modules /var/lib/workbench/node_modules
COPY cordis.patch.yml ./
COPY skills ./skills
COPY locale ./locale
COPY examples ./examples
COPY src ./src
COPY scripts ./scripts

ENV DSH_HOME=/var/lib/workbench/dsh \
    NARB_DISABLE_NATIVE_CACHE=1 \
    WORKBENCH_SANDBOX_WRAPPER=/workspace/lib/sandbox-wrapper.js \
    WORKBENCH_MISE=/opt/mise/bin/mise \
    WORKBENCH_TOOLCHAINS_DIR=/var/lib/workbench/toolchains \
    WORKBENCH_SERVICES_DIR=/opt/workbench-services
RUN npm install -g pnpm@11.7.0 \
  && mkdir -p /var/lib/workbench/dsh \
  && npx dsh --profile workflow-agent --from-default-profile web --dump-config >/dev/null \
  && npx dsh plugin --profile workflow-agent link /workspace \
  && cp /workspace/examples/profile.cordis.patch.yml /var/lib/workbench/dsh/profiles/workflow-agent/cordis.patch.yml \
  && mkdir -p /opt/workflow-agent /etc/workflow-agent \
  && cp -a /var/lib/workbench/dsh/profiles/workflow-agent /opt/workflow-agent/dsh-profile \
  && chmod -R a+rX /opt/workflow-agent \
  && chown -R node:node /var/lib/workbench

USER node

# Run dsh directly (not through npx), so it receives SIGTERM itself and shuts down cleanly: sessions flushed, state lock released.
# The dashboard (D13); set WORKBENCH_DASHBOARD_HOST=0.0.0.0 to publish it from the container.
EXPOSE 25410
# The entry point refreshes the DSH profile from the image on every start, with the operator's profile file over it
# (scripts/entrypoint.sh); the profile in the DSH volume is never stale.
ENTRYPOINT ["/workspace/scripts/entrypoint.sh"]
CMD ["node", "node_modules/@deepseek-ai/dsh/lib/bin.js", "--profile", "workflow-agent", "--no-open", "--port", "25401"]
