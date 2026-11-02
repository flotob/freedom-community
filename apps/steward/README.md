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

# publish a built app at the community's stable origin (uploads DIR, points the app feed at it;
# refuses to upload source maps)
BEE_URL=… BATCH=… STEWARD_KEY_FILE=steward.key APP_TOPIC=freedom-community/v0/app/<name> DIR=dist node scripts/publish-app.ts

# made-up demo members (journals written exactly like Freedom's swarm_writeFeedEntry)
BEE_URL=… BATCH=<member batch> GENESIS=genesis.json KEYS=members.json OWNER_KEY_FILE=owner.key node scripts/seed.ts
```

The pipeline, step by step:

1. **Ingest.** The GSOC doorbell gives low latency. Every known member's journal is also polled slowly, and the steward rings its own doorbell as a canary; if the canary doesn't come back, it re-subscribes. A stranger's first entry must be a `member.join`; anything else is ignored.
2. **Reduce.** Each entry, accepted or rejected, becomes a ledger entry with its outcome and the new state hash.
3. **Ledger.** Pages of at most 4 KiB go out as a sequence feed.
4. **Views.** Changed views are republished as raw JSON blobs behind feeds, so Freedom pages can read them with `swarm_readData`. Post views embed the hash-checked markdown body. Feed indices are tracked locally, and a new view format republishes every view.
5. **Adopt.** Accepted content is re-stamped with `PUT /stewardship`, including images a post body references as `bzz://<ref>`. Every journal chunk the ledger references is re-uploaded with the community batch, so an audit still works after members' batches expire.

Environment for `run`:

| Variable | Meaning |
|---|---|
| `BEE_URL` | the node's API (`http://davinci-ant:1633` on the server's Docker network) |
| `BATCH` | the community's postage batch (ledger, views, adopted content) |
| `STEWARD_KEY` / `STEWARD_KEY_FILE` | the steward key; the seal key for quest answers is derived from it |
| `GENESIS_JSON` / `GENESIS` | the genesis document (or a path to it) |
| `DATA_DIR` | the local cache (default `./steward-data`) |
| `POLL_MS` | journal polling interval (default 30 s) |
| `CANARY_MS` | doorbell self-test interval (default 5 min) |
| `STATUS_MS` | how often the `status` view is published (default 5 min; 0 turns it off) |
| `STATUS_PORT` | optional: serve a JSON status over HTTP inside the container |
| `STEWARD_INSTANCE` | this process's name in the status view (random if unset) |
| `TAKEOVER_MS` | wait as a standby while another instance's status is younger than this (default: three of its status intervals) |

**Standby and handover.** The `status` view doubles as a lease. A steward that finds another instance's fresh status waits as a standby, writing nothing. Once that status is older than the takeover window, it takes over. A steward whose saved ledger position is behind the ledger on Swarm replays the ledger before writing (another instance moved it on, or it crashed before saving). An active steward that sees a newer status from someone else steps down.

The local state file is only a cache. When `DATA_DIR` is empty, the steward replays its own
ledger from Swarm exactly as an auditor would. It starts only if that replay agrees with every
recorded outcome and state hash, then rebuilds all views. With `STATUS_PORT` set it answers any
HTTP request with a JSON status: ledger page, state hash, the last canary round trip, and
pending re-stamps.
