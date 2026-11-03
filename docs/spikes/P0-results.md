# Phase P0 spike results

Each spike answers one question with numbers.

- **Run:** 1 November 2026.
- **Freedom side:** Freedom Browser 0.8.8 (packaged AppImage, driven by [`tools/freedom-driver`](../../tools/freedom-driver)). Its embedded antd is the member's node.
- **Steward side:** a separate antd 0.5.77 in a container on a Hetzner server, reached through bee-js 13.2.0 (Freedom's version).

| Spike | Question | Answer |
|---|---|---|
| S1 | Can a page in Freedom write a journal that a server process reads through a different node? | **Yes.** Writes take 1.9–2.7 s. Readable on the steward's node 0.7–1.7 s later; visible as "latest" after 1.7–2.9 s. |
| S2 | Does a GSOC "doorbell" from Freedom reach the steward? | **Yes, 5 of 5.** Delivered about 0.6 s after the send returned (sends take 0.5–1.2 s; the first took 2.9 s). |
| S3 | Does content re-stamped by the steward outlive the member's batch? | **Yes.** Minutes after the member batch expired, both adopted blobs were whole (every chunk served), while the unadopted control had lost 7 of its 30 child chunks and no longer downloaded. |
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

- **Setup** (2026-11-01 20:58): two 100 KiB blobs on a short-lived "member" batch (depth 18).
- **Adopted blob:** re-stamped on the community batch with `PUT /stewardship` (5.3 s, same reference).
- **Control blob:** left alone.
- **Baseline:** all retrievable from a fresh, cache-less antd.
- **Expiry:** the member batch expired at 08:40 UTC on 2026-11-03, when the chain's cumulative price passed its balance. That was 27 min later than the TTL predicted at setup, because TTL estimates move with the storage price.
- **Re-check** (`check.mjs` 08:40, `chunks.mjs` 08:41 and 08:42, each from a fresh, cache-less antd):

  | Blob | Batch now | Child chunks served | Download |
  |---|---|---|---|
  | adopted (100 KiB) | community | 30 of 30 | 200, byte-identical, 0.3 s |
  | adopted in S7 (10 KiB) | community | 6 of 6 | 200, 0.2 s |
  | control (100 KiB) | expired | 21 of 30, then 23 of 30 | fails: the stream breaks after 3–7 s |
  | smoke test (58 B, one chunk) | expired | (single chunk, served) | 200 |

- **Reading the control:** antd uploads carry erasure coding (the span's top byte is `0x81`; 100 KiB is 25 data plus 5 parity chunks), so a blob survives up to 5 missing children. The control's missing set was the same in both chunk probes (7 chunks, all `404`; two further 404s in the first probe were served again a minute later), which puts it beyond repair. We can't tell whether some of those chunks had already gone before expiry (the baseline download would have masked up to 5), but the adopted copy of the same kind of content had none missing.
- **The smoke-test chunk** (on the same expired batch, but fetched through the public gateway when it was uploaded) still answered: probably a forwarding cache or a neighbourhood that hadn't evicted yet. One cached chunk proves nothing about keeping content.
- **Answer:** re-stamping is what keeps content. Without it, a member's content starts to vanish as soon as their batch expires. The steward's adoption step (re-stamp accepted content on the community batch) is therefore required, not an optimisation.
- **Follow-up:** `chunks.mjs` again some hours later, to see the control fade further.
