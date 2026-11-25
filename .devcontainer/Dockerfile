# Development container: Node and Docker (from features, devcontainer.json) on
# Ubuntu 24.04, plus what Claude Code and git over SSH need.
#
# The build context is this directory only; nothing from the repository is
# copied in. The app itself is installed by postCreateCommand (npm ci).
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae

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
