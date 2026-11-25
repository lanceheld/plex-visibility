# Development container: Node and Docker (from features, devcontainer.json) on
# Ubuntu 24.04, plus what Claude Code and git over SSH need.
#
# The build context is this directory only; nothing from the repository is
# copied in. The app itself is installed by postCreateCommand (npm ci).
#
# The base image is pinned by digest. It was mcr.microsoft.com/devcontainers/base:ubuntu-24.04
# when pinned; to update, pull that tag and copy its digest here.
FROM mcr.microsoft.com/devcontainers/base@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae

# GitHub's SSH host key, so the first `git fetch`/`git push` to the
# git@github.com remote doesn't stop at a host-key prompt. The key is
# checked against the fingerprint GitHub publishes
# (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints).
# Authentication itself uses the host's SSH agent, which VS Code forwards
# into the container; no private key is copied here.
RUN set -eu; \
    echo 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' \
        > /etc/ssh/ssh_known_hosts; \
    ssh-keygen -lf /etc/ssh/ssh_known_hosts | grep -q 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' \
        || { echo 'github.com host key does not match the published fingerprint'; exit 1; }

# SonarQube CLI (`sonar`: https://github.com/SonarSource/sonarqube-cli), for
# checking code against SonarQube Cloud from here and from Claude Code. Log
# in with `sonar auth login` (devcontainer.json says where the login is
# kept). Its install script always takes the latest release and checks
# nothing, so the release is pinned and checked against the SHA-256 SonarSource publishes
# next to each binary (<binary URL>.sha256). To update, change the version
# and both hashes together; `sonar update` can't write to /usr/local/bin.
ARG SONARQUBE_CLI_VERSION=1.13.1.18209
ARG SONARQUBE_CLI_SHA256_AMD64=b2e3facf6038514c846f7c3cfa2b7cf0a0761c8b052fc5b76fe424cdfbc9c9b7
ARG SONARQUBE_CLI_SHA256_ARM64=ce018c8dda6cef163416aad742d8192c587c73a51bd40be9441f48780f24f343
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
        amd64) platform=linux-x86-64; sha256="$SONARQUBE_CLI_SHA256_AMD64" ;; \
        arm64) platform=linux-arm64; sha256="$SONARQUBE_CLI_SHA256_ARM64" ;; \
        *) echo "No SonarQube CLI build for $(dpkg --print-architecture)"; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/sonar \
        "https://binaries.sonarsource.com/Distribution/sonarqube-cli/${SONARQUBE_CLI_VERSION}/linux/sonarqube-cli-${SONARQUBE_CLI_VERSION}-${platform}.bin"; \
    echo "${sha256}  /usr/local/bin/sonar" | sha256sum -c -; \
    chmod 755 /usr/local/bin/sonar
