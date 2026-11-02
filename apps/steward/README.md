# Steward

Runs one community. It reads members' journals, applies the community's rules with
`@freedom-community/protocol`'s reducer, appends the public ledger, publishes the views the
app renders, and re-stamps everything it accepts on the community batch. The protocol is
described in [`docs/protocol.md`](../../docs/protocol.md).

```sh
# create a community (steward key, app origin feed, first owner, genesis.json)
BEE_URL=… BATCH=<community batch> STEWARD_KEY_FILE=steward.key OWNER_KEY_FILE=owner.key \
  COMMUNITY=examples/waldkauz/community.json OUT=genesis.json node scripts/init.ts

# run it
BEE_URL=… BATCH=<community batch> STEWARD_KEY_FILE=steward.key GENESIS=genesis.json \
  DATA_DIR=./steward-data POLL_MS=30000 CANARY_MS=120000 node src/cli.ts run

# or as a container (build context: repo root); STEWARD_KEY and GENESIS_JSON may replace the files
docker build -f apps/steward/Dockerfile -t steward .
docker run -e BEE_URL=… -e BATCH=… -e STEWARD_KEY=… -e GENESIS_JSON="$(cat genesis.json)" -v steward-data:/data steward

# anyone can audit a community from Swarm alone
BEE_URL=… STEWARD=0x… COMMUNITY=<id> node src/cli.ts audit

# made-up demo members (journals written exactly like Freedom's swarm_writeFeedEntry)
BEE_URL=… BATCH=<member batch> GENESIS=genesis.json KEYS=members.json OWNER_KEY_FILE=owner.key node scripts/seed.ts
```

The pipeline, step by step:

1. **Ingest.** The GSOC doorbell gives low latency. Every known member's journal is also polled slowly, and the steward rings its own doorbell as a canary; if the canary doesn't come back, it re-subscribes. A stranger's first entry must be a `member.join`; anything else is ignored.
2. **Reduce.** Each entry, accepted or rejected, becomes a ledger entry with its outcome and the new state hash.
3. **Ledger.** Pages of at most 4 KiB go out as a sequence feed.
4. **Views.** Changed views are republished as JSON files behind feeds; feed indices are tracked locally.
5. **Adopt.** Accepted content is re-stamped with `PUT /stewardship`. Every journal chunk the ledger references is re-uploaded with the community batch, so an audit still works after members' batches expire.

The local state file is only a cache. When `DATA_DIR` is empty, the steward replays its own
ledger from Swarm exactly as an auditor would. It starts only if that replay agrees with every
recorded outcome and state hash, then rebuilds all views. With `STATUS_PORT` set it answers any
HTTP request with a JSON status: ledger page, state hash, the last canary round trip, and
pending re-stamps.
