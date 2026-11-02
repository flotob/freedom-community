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
| `comment.create` | `comment.create` | `{ post, parent?, text }` (≤ 2 KiB inline) or `{ post, parent?, content, contentHash }`; `parent` replies to a comment on the same post, down to depth 4 |
| `like.set` | `like.set` | `{ target (action id), on: true\|false }` |
| `mod.hide` | `mod.hide` | `{ target, reason }` |
| `role.grant` / `role.revoke` | `role.manage` | `{ member, role }` |
| `badge.grant` / `badge.revoke` | `badge.manage` | `{ member, badge }` |
| `community.update` | `community.manage` | `{ name?, theme?, categories?, badges?, roles?, leaderboards?, plans?, treasury? }` |
| `library.create` / `library.update` | `library.manage` | `{ name, description?, cover?, postToFeed? }` / `{ library, …, archived? }`; posting into one needs `library.post` (`post.create` with `library`) |
| `plan.claim` | (any member) | `{ plan, tx }`: claim a plan for an xDAI payment on Gnosis Chain. The steward checks the transaction on chain (succeeded, to `treasury`, at least `price`) and records its verdict in the ledger, accepted or not. An approved claim grants the plan's badge until `max(current expiry, now) + days`. Each transaction is claimed once. Expired badges carry no roles: permission checks use the entry's `receivedAt`. |
| `follow.set` | (any member) | `{ member, on }`: follow or unfollow; not yourself |
| `badge.score` | `badge.score` | `{ member, badge, score }` (the member must hold the badge) |
| `quest.create` | `quest.manage` | `{ title, description?, kind: text\|mcq\|upload, options?, multi?, partial?, secret?, autoApprove?, opensAt?, closesAt?, tries?, rewards?, prerequisites?, privacy?, image? }` |
| `quest.update` | `quest.manage` | `{ quest, …any quest field, close? }` (kind is fixed once there are submissions) |
| `quest.submit` | `quest.submit` | `{ quest, answer: {sealed} \| {text} \| {image}, private? }` |
| `quest.review` | `quest.review` | `{ submission, decision: approved\|rejected\|disqualified }` |

### Badges, scores, leaderboards

A badge may carry a card decal (`settings`: davinci's `decal_text` and `decal_image`, an image being a Swarm ref; `{value}` in the text shows the member's score in that badge), a `visibility` for its icon, `default` (granted on every join from then on) and `enabled: false` (no new grants). A member's score per badge lives in `scores`. A leaderboard ranks one badge's holders: score descending, then joining order. Ranks are 1, 2, 3… with no ties.

New fields are optional and **absent until used**, with no schema defaults, so ledgers written before they existed replay to the same state hashes.

### Quests and sealed answers

Members' journals are public, so a quest's solutions (text answers, or which mcq options are correct) and the members' answers to judged quests are **sealed to the steward**:
- format: X25519 with an ephemeral key, HKDF-SHA256, AES-256-GCM (spike S5);
- seal key: derived from the steward key and published as `sealKey` in the community view;
- AAD of an answer: `<community>/quest/<quest id>/<author>`, so copying another member's ciphertext fails;
- AAD of solutions: `<community>/quest-secret/<quest author>`.

How a submission is judged:
- `autoApprove` → approved.
- A sealed answer to a quest with sealed solutions → the steward opens both and judges:
  - text: trimmed lower-case equality with any solution;
  - mcq: picks are de-duplicated; single-select needs one correct pick; multi-select needs the exact correct set;
  - multi-select with `partial`: any non-empty set of correct picks passes, and the reward is multiplied by the number of picks.
  
  It passes the verdict to the reducer as `ctx.verdict = {approved, multiplier?}` and records it in the ledger entry (`verdict`), so a replay reaches the same state.
- Everything else → `pending`, until a member with `quest.review` decides.

Rewards land **once per submission** (`paid`):
- a reward grants a badge (if enabled) and adds `score × multiplier`, or removes a badge;
- a reviewer reversing an approval takes the score back (badges stay);
- approving again pays again.

Other rules: submissions need the quest open (`opensAt ≤ receivedAt < closesAt`, not `closed`), every prerequisite met (badge held, score within `min`/`max`), no pending or approved submission, not disqualified, and a try left (`tries`, default 1).

**Trust:** while a quest runs, verdicts on sealed answers are attested by the steward. An auditor checks that the replay follows them, but not that they are right.

**When the quest closes,** the steward publishes `quest-reveal/<id>`: the solutions, the AES key of the sealed solutions, and for every sealed answer its plaintext and the AES key that opens that one message (never the steward's own key). An auditor (`steward audit`) then checks:
- the revealed key opens the quest's sealed solutions to the revealed ones;
- each answer key opens the member's journal entry to the revealed answer;
- judging it again (`judgeAnswer`, in the protocol package) gives the verdict the ledger recorded.

So after the close, every verdict is verifiable.

Content larger than an entry is uploaded by the member (`swarm_publishData`) and referenced with its SHA-256. Once the steward accepts it, it **adopts** the content: it re-stamps it on the community batch (`PUT /stewardship`) so it outlives the member's batch (S3).

## Reducer

`reduce(state, action, ctx) → { state, outcome }`

- **Pure:** no I/O, no clock. `ctx = { author, index, receivedAt, verdict? }` (`verdict` only for sealed quest answers, taken from the ledger on replay).
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
| `status` | the steward's and its node's health every 5 min: ledger page, canary round trip, pending re-stamps, peers, wallet balances, batches and their TTL (all public on chain anyway); for the dashboard page |
| `genesis` | the genesis document itself (self-certifying: its canonical hash is the community id), so a page can replay the ledger |
| `home/<page>` | post cards, newest first, 20 per page |
| `post/<action id>` | post plus comments and like count; the markdown `body` is embedded when the steward could read it and it matches `contentHash` |
| `members` | member cards (one page for now) |
| `member/<owner>` | profile, roles, badges, posts, and a journal receipt: `{next, recent: [{index, type, ok, reason?, at}]}` (how far the steward has read this author's journal, and their last 20 outcomes). It is also published for someone whose join was refused (`member: false`), so their app can say why. |
| `leaderboards` | every leaderboard with its top 5 |
| `leaderboard/<id>` | the full ranking: `{rank, owner, name, avatar, score}` |
| `inbox/<owner>` | the member's last 50 notifications, in davinci's kinds: comment on your post, reply to your comment, mention (a `/users/0x…` link in a post's opening or a comment), new follower, followed author posted, quest approved/rejected/disqualified, post or comment hidden. Derived by the steward from the state before and after each action, and rebuilt from a ledger replay. Read/unread lives in the member's browser. |
| `libraries` / `library/<id>` | the libraries with post counts / one library and its posts (a library's posts reach `home` only with `postToFeed`) |
| `quests` | every quest's public part (never `secret`; `hasSolutions` instead), with counts |
| `quest/<id>` | the quest and its feed; answers only when both quest and submission are public and the answer isn't sealed; a `secret` quest shows no rows |
| `quest-reveal/<id>` | after a quest with sealed solutions closes: the solutions and each sealed answer with its message key, for re-judging |
| `review` | pending submissions with their (unsealed) answers, for reviewers |
| `index` | `{views: {<view name>: <latest feed index>}}`, republished after every view update. A latest-entry lookup costs seconds in a light node (measured 0.8–3.4 s in Freedom), and an exact-index read costs a fraction of that, so apps read this once and then read views by index. |

Views are a cache. The ledger and journals are the truth, and every view carries the ledger page and state hash it was built from.

## Freshness

1. **Member:** writes the journal entry (about 2 s), then rings the doorbell with `{ owner, index }` (about 1 s).
2. **Steward:** on the doorbell, reads that journal up to `index` (about 1 s), reduces, appends the ledger and republishes the affected views.
3. **App:** shows the member's own action optimistically at once, and everyone else sees it after the view update. Expect seconds.

The doorbell is unauthenticated, so it's a hint only. The steward also polls every member's journal slowly, as the safety net, and rings its own doorbell as a canary to detect a stuck subscription.
