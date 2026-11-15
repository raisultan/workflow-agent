# The eval's mock services (mock GitLab, mock Jira): Node and git, nothing else. Synthetic data only.
FROM node:24.22.2-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /eval
COPY services ./services
COPY repos ./repos
USER node
