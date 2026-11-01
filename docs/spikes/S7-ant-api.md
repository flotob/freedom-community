# Spike S7: does the released `antd` serve what the steward needs?

**Answer: yes.** 14 of 15 checks passed in the first run. GSOC delivery failed there and was resolved in the S2 follow-up (stale subscription state, cleared by a restart; see [P0-results.md](P0-results.md#s2-doorbell)). The checks pass against `antd` 0.5.77, the release of 29 October 2026, used through bee-js 13.2.0 (the version Freedom 0.8.8 ships).

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
| GSOC | `GET /gsoc/subscribe/{addr}` (websocket), `POST /soc` | fail, then **pass** | first run: 0 of 9 delivered; after a container restart, 9 of 9 at 1.2–1.3 s, and 5 of 5 from Freedom (S2) |
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

## GSOC follow-up

- **First run:** delivery failed because antd's lurker stayed on peers at proximity 6–7 to the target for over an hour.
- **After a restart:** the node reached peers at proximity 9–14 and delivered every message, including ones sent from Freedom.
- **Details and the steward's canary mitigation:** [P0-results.md](P0-results.md#s2-doorbell).
