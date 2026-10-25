# Runner hardening notes

The runner can create containers through the host Docker API. Access to `/var/run/docker.sock` is effectively host-root-equivalent: separating the runner from the public API narrows exposure but does not remove this privilege. Only deploy reviewed runner code, protect `RUNNER_TOKEN`, and do not publish port `3099`.

## Implemented constraints

- Runner bearer authentication with timing-safe comparison on every route except its non-sensitive `/health` check.
- Bot IDs are validated UUIDs and workspace paths are resolved under the configured workspace root.
- Runtime is selected from a fixed Python/Node list; container image names are not user-supplied.
- Each bot gets its own bridge network, no port publishing, and inter-container communication disabled for that network.
- Source files are bind-mounted read-only and copied into a writable temporary filesystem at startup.
- Container user is `1000:1000`; root filesystem is read-only; all Linux capabilities are dropped; `no-new-privileges` is set; CPU, RAM, and process count are capped.
- Bot containers have no Docker socket, no host path mounts except their own read-only project, and no privileged mode.
- Uploaded ZIP path traversal and symlinks are rejected by the API before a workspace is made runnable.

## Not enforced by this MVP

- **Egress is not allowlisted to Discord.** Bots need outbound HTTPS to Discord, and domains/IPs may vary. A bot can make outbound requests. Apply host-level egress firewall rules or a controlled proxy if you need a destination allowlist.
- The Docker bridge gateway/host network and private network reachability are not comprehensively filtered from each bot. Host services should not listen on interfaces reachable from bot networks without their own authentication/firewall policy. Do not rely on the UI to make host services unreachable.
- The runtime images use maintained major/minor tags, not digest-pinned immutable images. Pin trusted image digests in a hardened deployment process if reproducibility is mandatory.
- Native dependencies and startup commands execute inside the bot container with network access. A configured startup command is user code inside the isolated bot container, not a host shell command.
- Resource caps do not cover all possible disk I/O, network bandwidth, or malicious kernel/container-runtime vulnerabilities.

## Manual administrator hardening

1. Keep the VPS OS, Docker Engine and Compose plugin updated.
2. Use a separate VPS for untrusted third-party code. On a single VPS, host-level isolation and firewall configuration are still part of the trust boundary.
3. Ensure the Compose `runner-private` network has no published ports and that Coolify routes only to panel port `3001`.
4. Use a new dedicated persistent data path; do not reuse Coolify's own internal directories or another app's data path.
5. Restrict SSH access and run an appropriate host firewall. Consider disallowing access from bot bridge subnets to host services and private LAN ranges while retaining DNS/HTTPS access needed for Discord.
6. Set `NODEBASE_ENCRYPTION_KEY` and `RUNNER_TOKEN` to independently generated random values. Back them up securely; do not commit them or share them in chat/logs.
7. Start with one harmless bot and verify actual logs, stop/restart, deletion and persistence before placing important workloads on the service.
8. Back up the SQLite database and storage folders consistently. Test restoring backups before relying on them.
