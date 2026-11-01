# Phase P0 spike results

Each spike answers one question with numbers.

- **Run:** 1 November 2026.
- **Freedom side:** Freedom Browser 0.8.8 (packaged AppImage, driven by [`tools/freedom-driver`](../../tools/freedom-driver)). Its embedded antd is the member's node.
- **Steward side:** a separate antd 0.5.77 in a container on a Hetzner server, reached through bee-js 13.2.0 (Freedom's version).

| Spike | Question | Answer |
|---|---|---|
| S1 | Can a page in Freedom write a journal that a server process reads through a different node? | **Yes.** Writes take 1.9–2.7 s. Readable on the steward's node 0.7–1.7 s later; visible as "latest" after 1.7–2.9 s. |
| S2 | Does a GSOC "doorbell" from Freedom reach the steward? | **Yes, 5 of 5.** Delivered about 0.6 s after the send returned (sends take 0.5–1.2 s; the first took 2.9 s). |
| S3 | Does content re-stamped by the steward outlive the member's batch? | **Pending:** the member batch expires around 2026-11-03 08:13 UTC. Baseline taken. |
| S5 | Can a page seal a quest answer that only the steward can open? | **Yes.** WebCrypto X25519 + HKDF + AES-GCM in the page, `node:crypto` on the steward. Tampering is detected. |
| S6 | Can members post on stamps the steward sponsors? | **Not through `window.swarm` today.** antd accepts envelope uploads, but no Freedom method passes one. Asked for. |
| S7 | Does the released antd serve every endpoint the steward needs? | **Yes**, 15 of 15 after the GSOC follow-up. See [S7-ant-api.md](S7-ant-api.md). |

## S1: journal round trip

[`spikes/s1-journal`](../../spikes/s1-journal), [results](../../spikes/s1-journal/results-member-b.json)

- **Opening the site:** the test site is served from `bzz://` and loads in Freedom in 2.1 s. Its `freedom-manifest.json` asks for `feeds`, and one consent sheet grants it.
- **Feed creation:** `swarm_createFeed({name: 'journal'})` returns `{owner, topic, manifestReference, identityMode: 'app-scoped'}`.
- **Topic derivation:** the topic matches our own calculation, `keccak256("bzz://<site hash>/journal")`. A steward can therefore compute any member's journal topic from the community's origin and the member's address.
- **Five entries:** each was written with `swarm_writeFeedEntry` and read back on the steward's node, both by index and as "latest".

  | Entry | Write in Freedom | Readable by index on the steward node | Visible as latest |
  |---|---|---|---|
  | 0 | 2.7 s | 1.0 s | 2.2 s |
  | 1 | 2.7 s | 1.7 s | 2.9 s |
  | 2 | 2.1 s | 0.7 s | 1.7 s |
  | 3 | 2.1 s | 0.7 s | 1.7 s |
  | 4 | 1.9 s | 1.7 s | 2.7 s |

- **Chunk check:** each chunk was checked independently: identifier = keccak256(topic ‖ uint64be(index)), and the owner recovered from the signature matches the feed owner.
- **Format note:** Freedom stores the **raw payload** in the feed chunk. Read it with bee-js `downloadPayload()`. `download()` assumes the older timestamp-prefixed format and cuts off the first 8 bytes.
- **Identity note:** the manifest path gives each site an `app-scoped` identity, which isn't portable across devices. Using the user's `ethereum-wallet` identity needs a manifest field (asked for). Until then, a member's id is their app-scoped owner address for that origin.

**End to end:** a post is on the network and visible to the steward about 3–5 s after the member hits publish.

## S2: doorbell

[`spikes/s2-doorbell`](../../spikes/s2-doorbell), [results](../../spikes/s2-doorbell/results-member-b.json)

- **Address derivation:** Freedom derives a GSOC address from a plain topic string (`messaging-service.js`):
  - identifier = keccak256(topic);
  - signer = bee-js `gsocMine(keccak256("freedom-gsoc-v1:" + topic), identifier, 12)`;
  - address = keccak256(identifier ‖ owner).
- **Steward side:** the steward derives the same address from the community's doorbell topic and subscribes on its own antd with `GET /gsoc/subscribe/{address}`.
- **Result:** 5 of 5 rings from the page arrived, each about 0.6 s after `swarm_sendGsoc` returned.
- **Design consequence (decision D1):** members ring the doorbell after each journal write, and the steward reads that journal at once. Slow polling of all journals stays as the safety net. No chain transaction is needed per action.

**The stuck-subscription observation** (node-only runs, before S2):
- On the server node, three subscriptions (warm-ups of 3 s, 90 s and 420 s) received nothing.
- antd's lurker kept pulling from the same five peers at proximity 6–7 to the target, with unchanged cursors for more than an hour, and never moved closer.
- A fresh local antd reached peers at proximity 8–11 within a second and received every message, and so did the server node after a container restart.
- Later subscriptions on the restarted node all worked, even with a 5 s warm-up.
- The trigger isn't known. **Mitigation for the steward:** ring its own doorbell every few minutes as a canary; if the canary doesn't arrive, re-subscribe, and restart the node if that doesn't help.

## S5: sealed answers

[`spikes/s5-sealed`](../../spikes/s5-sealed), [results](../../spikes/s5-sealed/results.json)

- **Secure context:** `bzz://` pages are a secure context in Freedom (`isSecureContext: true`), and `crypto.subtle` supports X25519.
- **Format v0:**
  - an ephemeral X25519 key agrees with the steward's public key;
  - HKDF-SHA256 derives the key (salt = ephemeral public key ‖ steward public key, info = `freedom-community/sealed-answer/v0`);
  - AES-256-GCM encrypts, with the context (quest, member, time) as additional authenticated data.
- **Results:** answers of 2 B, 29 B (Unicode) and 2,000 B round-trip, and changing the context makes opening fail. A sealed answer adds about 230 bytes of JSON.

## S6: sponsored stamps

antd issues pre-signed stamps (`POST /envelope/{address}`) and accepts uploads that carry one (`swarm-postage-stamp` header); see S7. But no `window.swarm` method in Freedom 0.8.8 accepts a stamp, so a member can't post on the steward's batch.

**Ask:** an optional `stamp` on `swarm_publishChunk`, `swarm_writeSingleOwnerChunk` and `swarm_writeFeedEntry`.

Until then, each member buys a Starter plan once, for **0.52 xDAI** through Freedom's own flow (depth 20, 30 days).

## S3: adoption outlives the member batch

[`spikes/s3-adoption`](../../spikes/s3-adoption)

- **Setup:** two 100 KiB blobs on a short-lived "member" batch.
- **Adopted blob:** re-stamped on the community batch with `PUT /stewardship` (5.3 s).
- **Control blob:** left alone.
- **Baseline:** all retrievable from a fresh, cache-less antd.
- **Next:** re-run `check.mjs` after the member batch expires.
