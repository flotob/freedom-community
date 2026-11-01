# Ant node for the steward

A container for [`antd`](https://github.com/freedom-hq/ant), the Swarm node the steward talks to. `antd` is a light node with a Bee-compatible HTTP API, so the steward uses it like Bee (`/bytes`, `/chunks`, `/soc`, `/feeds`, `/stamps`, `/gsoc`, …).

## Image

- Downloads the pinned `antd` release and checks its SHA-256 before installing it.
- Runs as an unprivileged user (`ant`, uid 10001).
- Keeps all state in `/home/ant/.antd`. **Mount a persistent volume there.** It holds:
  - `signing.key`, the node's key and wallet;
  - `chequebook.json`;
  - the peer snapshot and the chunk cache, capped at 3 GB.

## Configuration

| Setting | Where | Value |
|---|---|---|
| `GNOSIS_RPC_URL` | environment (secret) | A Gnosis RPC endpoint. A keyed endpoint is fine: wallet history scans use antd's separate `GNOSIS_LOGS_RPC_URL`, whose default is the public `https://rpc.gnosischain.com`. |
| API address | `CMD` | `0.0.0.0:1633` inside the container. **Don't publish it on the host** (see Access). |
| Chequebook deposit | `CMD` | 2 xBZZ (`20000000000000000` PLUR). antd deploys a chequebook on the first start with a funded wallet, or after the first `POST /stamps`, and tops it back up to this amount. |
| Disk cache | `CMD` | 3 GB |

Ant picks a random port for peer-to-peer traffic and has no flag to fix it. The container therefore runs **outbound-only**: it connects to peers, but peers can't connect to it. Startup takes about 10 s longer while the bootnodes handshake.

## Access

The API can spend the node's wallet (`POST /stamps` buys batches), so keep it off the public internet:

- **Services on the same host** (the steward) reach it over the Docker network.
- **Operators** open an SSH tunnel to the container's address on that network:

  ```sh
  IP=$(ssh "$HOST" "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \$(docker ps -q -f name=$CONTAINER_PREFIX)")
  ssh -N -L 1733:"$IP":1633 "$HOST"   # then: curl http://localhost:1733/health
  ```

- **Coolify:** leave the domain empty (Coolify assigns a public `sslip.io` domain to new apps; remove it before the first deploy) and add no port mapping.

## Funding

The node's wallet is the address of `signing.key`; get it from `GET /addresses` or `GET /wallet`. It needs:

- **xDAI** for gas: the chequebook deployment and postage transactions;
- **xBZZ** for postage batches and the chequebook deposit.

## Upgrading

1. Pick a release on <https://github.com/freedom-hq/ant/releases>.
2. Take the `antd-<version>-linux-amd64.tar.gz` line from its `SHA256SUMS`.
3. Update `ANT_VERSION` and `ANT_SHA256` in the `Dockerfile` together, then redeploy.

## Back up the key

`signing.key` owns the wallet, the chequebook and every batch the node buys. Copy it somewhere safe after the first start. Losing it means losing access to those funds and batches.
