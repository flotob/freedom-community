# Spike S7: does the released `antd` serve what the steward needs?

**Answer: yes for everything except GSOC delivery, which goes on to spike S2.** 14 of 15 checks pass against `antd` 0.5.77, the release of 29 October 2026, used through bee-js 13.2.0 (the version Freedom 0.8.8 ships).

- **Run:** 2026-11-01. The node is outbound-only, in a container on a Hetzner server, with about 110–170 peers and SWAP on.
- **Script:** [`spikes/s7-ant-api/check.mjs`](../../spikes/s7-ant-api/check.mjs).
- **Raw results:** [`results.json`](../../spikes/s7-ant-api/results.json).

| Check | Endpoints | Result | Numbers |
|---|---|---|---|
| Bytes | `POST /bytes`, `GET /bytes/{ref}` | pass | 10 KiB uploaded in 2.0 s |
| Chunks | `POST /chunks`, `GET /chunks/{addr}` | pass | 0.9 s round trip |
| Site (collection) | `POST /bzz` (tar), `GET /bzz/{ref}/`, `GET /bzz/{ref}/{path}` | pass | correct `text/html` and `text/javascript` content types |
| Single-owner chunk | `POST /soc/{owner}/{id}`, `GET /soc/{owner}/{id}` | pass | readable 0.2 s after the write; address matches the local calculation |
| Sequence feed, 3 updates | `POST /soc`, `GET /feeds/{owner}/{topic}` | pass | write 1.7 s (7 s for the first update), new latest visible about 1.0 s after each write |
| Feed manifest | `POST /feeds/{owner}/{topic}`, `GET /bzz/{manifest}/` | pass | resolves to the feed's target about 1 s after creation |
| Stewardship | `GET /stewardship/{ref}`, `PUT /stewardship/{ref}` | pass | re-stamp on another batch took 0.7 s for 10 KiB; retrievable before and after |
| Envelope (pre-signed stamp) | `POST /envelope/{addr}`, then `POST /chunks` with `swarm-postage-stamp` | pass | issuer is the batch owner; the chunk is retrievable |
| **GSOC** | `GET /gsoc/subscribe/{addr}` (websocket), `POST /soc` | **fail** | 0 of 1, then 0 of 5 messages delivered (90 s warm-up) |
| ACT grantees | `POST /grantee`, `GET /grantee/{ref}` | pass | |
| Pins | `POST/GET/DELETE /pins` | pass | |
| Tags | `POST /tags`, `GET /tags/{uid}` | pass | |
| Stamp reads | `GET /stamps`, `/stamps/{id}`, `/stamps/{id}/buckets`, `/chainstate` | pass | |
| Stamp top-up | `PATCH /stamps/topup/{id}/{amount}` | pass | visible within about 12 s |
| Stamp dilute | `PATCH /stamps/dilute/{id}/{depth}` | pass | depth 17 → 18, TTL 2.99 → 1.49 days |

## What this means for the steward

- **Feeds are fast enough for polling.** A new update is visible as "latest" about 1 s after it's written. A steward that polls members' journals every few seconds sees new actions within seconds, even without a doorbell.
- **Re-stamping works the way spike S3 needs.** `PUT /stewardship/{ref}` fetches the content from the network and re-stamps it on our batch, and the content doesn't need to be pinned on our node first. S3 still has to show that content outlives the member's batch.
- **Sponsored stamps are possible.** `/envelope` hands out a stamp signed by the steward's batch for a chunk address, and an upload carrying that stamp is accepted. Spike S6 checks whether Freedom can use such a stamp.
- **Sites deploy from a directory upload** with the right content types, so the app can be served from `bzz://`.

## GSOC: what failed and what's known

- antd's GSOC receive path (`ant_p2p::lurker`) pulls the target neighbourhood live from the 5 connected peers closest to the target.
- In both runs the closest connected peers shared only 6–7 leading bits with the target (`lurker pulling neighborhood bin … bin=7` and `bin=6`). With about 2,000 nodes in the network, the storer neighbourhood is likely 9–10 bits deep, so those peers don't store the message and have nothing to hand over.
- The lurker re-dials toward the neighbourhood every 30 s. In these runs (up to about 4 minutes) the covering peers didn't get closer.

Next steps (spike S2): a longer warm-up, sending from a second node, and logging which peers the neighbourhood dial reaches. If GSOC can't be made reliable for a light node, the fallback is decision D1's: poll the journals, which the feed numbers above show is workable.
