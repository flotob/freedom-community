# freedom-community protocol, v0

Status: draft for the prototype. The numbers come from the [P0 spikes](spikes/P0-results.md).

## Roles

| Who | Writes | Reads |
|---|---|---|
| **Member** (Freedom Browser) | Their **journal**, a sequence feed of actions. Larger content goes out as separate uploads. Rings the community **doorbell**. | **Views** and the **ledger** |
| **Steward** (one per community) | The **ledger**, the **views**, and re-stamps of accepted content | Members' journals |
| **Auditor** (anyone) | Nothing | Ledger plus journals, replayed with the reducer |

The steward has no special power over content it didn't sign. Every accepted action points back to a journal entry signed by its author. Anyone can replay the ledger from the genesis document and must reach the same state hash.

## Identifiers

- **Community origin.** The permission key Freedom uses for the app: `bzz://<feed-manifest>` or later an ENS name. The app is served from a feed manifest, which keeps the origin stable across app updates.
- **Member id.** The owner address of the member's journal feed. In v0 that's Freedom's **app-scoped** identity for the origin; once Freedom lets a manifest request it, it becomes the `ethereum-wallet` identity.
- **Journal.** Feed name `journal`, so topic = `keccak256(utf8("<origin>/journal"))`. That matches what Freedom computes in `swarm_createFeed` (S1). Entries are raw JSON payloads of at most 4 KiB.
- **Steward feeds.** Owner = the steward key. Topic = `keccak256(utf8("freedom-community/v0/<community-id>/<name>"))`, where names are `ledger`, `view/<view-name>` and so on.
- **Community id.** The first 16 hex characters of `keccak256` over the genesis document's canonical JSON.
- **Doorbell.** A GSOC topic, `freedom-community/v0/<community-id>/doorbell`, derived the way Freedom does it (S2).

## Genesis

A JSON document, published once and referenced by every ledger page:

```json
{
  "protocol": "freedom-community/v0",
  "name": "Waldkauz Collective",
  "origin": "bzz://…",
  "steward": "0x<steward address>",
  "createdAt": 1793500000000,
  "roles": [
    { "id": "owner", "name": "Owner", "permissions": ["*"] },
    { "id": "member", "name": "Member", "permissions": ["post.create", "comment.create", "like.set", "profile.set"] }
  ],
  "defaultRoles": ["member"],
  "owners": ["0x<first owner>"],
  "badges": [],
  "categories": [],
  "settings": { "public": true }
}
```

Permissions are plain strings. The protocol defines which permission each action needs (see Actions), and the community decides which roles hold them. A badge can carry roles, and a member's effective roles are their own plus their badges'.

## Actions

A journal entry is one action:

```json
{ "v": 0, "c": "<community-id>", "type": "post.create", "at": 1793567045442, "body": { … } }
```

- `c` binds the action to one community: the same journal topic could be reused by another app with the same origin.
- `at` is the author's clock. The steward records its own receive time too, and orders actions by (steward receive time, author, journal index).
- An action's **id** is `<owner>:<index>`, which is unique and verifiable.

| Type | Needs | Body |
|---|---|---|
| `member.join` | open community (or an invite later) | `{ profile? }` |
| `profile.set` | `profile.set` | `{ name?, bio?, avatar? (ref) }` |
| `post.create` | `post.create` | `{ title?, excerpt, content (ref), contentHash, categories?, image? (ref) }` |
| `post.edit` | author + `post.create` | `{ post (action id), title?, excerpt?, content?, contentHash?, categories? }` |
| `post.withdraw` | author | `{ post }` |
| `comment.create` | `comment.create` | `{ post, text }` (≤ 2 KiB inline) or `{ post, content, contentHash }` |
| `like.set` | `like.set` | `{ target (action id), on: true\|false }` |
| `mod.hide` | `mod.hide` | `{ target, reason }` |
| `role.grant` / `role.revoke` | `role.manage` | `{ member, role }` |
| `badge.grant` / `badge.revoke` | `badge.manage` | `{ member, badge }` |
| `community.update` | `community.manage` | `{ name?, theme?, categories?, badges?, roles? }` |
| `quest.submit` | `quest.play` | `{ quest, sealed }` (sealed answer, S5 format) |

Content larger than an entry is uploaded by the member (`swarm_publishData`) and referenced with its SHA-256. Once the steward accepts it, it **adopts** the content: it re-stamps it on the community batch (`PUT /stewardship`) so it outlives the member's batch (S3).

## Reducer

`reduce(state, action, ctx) → { state, outcome }`

- **Pure:** no I/O, no clock. `ctx = { author, index, receivedAt }`.
- **Outcome:** `{ ok: true, effects }` or `{ ok: false, reason }`. Effects are what the steward must do next, for example adopting a content reference.
- **Rejected actions** are recorded with their reason, so members and auditors see why.
- **State hash:** `keccak256` over the canonical JSON of the state, after each action.

## Ledger

A sequence feed of pages:

```json
{ "v": 0, "c": "<community-id>", "genesis": "<ref>", "page": 12, "prev": "<ref of page 11>",
  "entries": [ { "id": "0xabc…:7", "soc": "<soc address>", "receivedAt": 1793567046000, "ok": true, "stateHash": "…" },
               { "id": "0xdef…:3", "soc": "…", "receivedAt": 1793567049000, "ok": false, "reason": "not-permitted" } ] }
```

- Pages hold whole entries and stay under 4 KiB.
- A page's `entries` point at the journal chunks, not at copies, so a replay fetches the original signed actions.
- `prev` chains the pages, so a reader can walk the ledger without the feed.

## Views

The app reads pre-computed JSON documents. Each is a steward sequence feed (topic name `view/<view>`) whose latest entry is a reference to the document. The entry is bee-js's 40-byte form, an 8-byte timestamp followed by the 32-byte reference. The document is a raw blob (`/bytes`), not a `bzz` file, so a page reads it with Freedom's `swarm_readFeedEntry` and then `swarm_readData`: two verified calls per view.

| View | Content |
|---|---|
| `community` | name, theme, categories, badges, roles (public part) |
| `home/<page>` | post cards, newest first, 20 per page |
| `post/<action id>` | post plus comments and like count; the markdown `body` is embedded when the steward could read it and it matches `contentHash` |
| `members` | member cards (one page for now) |
| `member/<owner>` | profile, roles, badges, posts |
| `leaderboard/<id>` | ranking |

Views are a cache. The ledger and journals are the truth, and every view carries the ledger page and state hash it was built from.

## Freshness

1. **Member:** writes the journal entry (about 2 s), then rings the doorbell with `{ owner, index }` (about 1 s).
2. **Steward:** on the doorbell, reads that journal up to `index` (about 1 s), reduces, appends the ledger and republishes the affected views.
3. **App:** shows the member's own action optimistically at once, and everyone else sees it after the view update. Expect seconds.

The doorbell is unauthenticated, so it's a hint only. The steward also polls every member's journal slowly, as the safety net, and rings its own doorbell as a canary to detect a stuck subscription.
