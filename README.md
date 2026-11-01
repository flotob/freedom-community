# freedom-community

Online communities that live on [Swarm](https://www.ethswarm.org/) instead of on a server, used through [Freedom Browser](https://github.com/solardev-xyz/freedom-browser).

> **Status: early prototype.** Nothing here is usable yet. The layout below is the plan; most folders are still placeholders.

## Idea in one paragraph

Every member writes their actions (posts, comments, likes, profile changes, quest answers) to their own signed journal, a Swarm feed published from Freedom Browser. A **steward** per community reads those journals, checks each action against the community's rules (membership, roles, moderation), and publishes two things to Swarm:

- an append-only **ledger** of accepted and rejected actions, with reasons;
- read-optimised **views** that the app renders: feeds, threads, member lists, leaderboards.

The steward is a convenience, not an authority. Anyone can replay the public ledger with the same rules and must reach the same state, and the community stays readable when the steward is offline.

## Layout

| Path | What |
|---|---|
| [`packages/protocol`](packages/protocol) | Schemas, builders, validators, and the pure reducer (state + action → state + outcome) shared by the steward, the app and audits. |
| [`apps/steward`](apps/steward) | The reference steward: ingest journals, verify, reduce, append the ledger, publish views, keep content stamped. |
| [`deploy/ant`](deploy/ant) | Container for the Swarm node the steward uses: [Ant](https://github.com/freedom-hq/ant) (`antd`), a light node with a Bee-compatible API. |
| [`docs`](docs) | Protocol and operations docs. |

## Requirements

- Node.js 22 or newer for the packages and the steward.
- A Swarm node with a Bee-compatible API (`antd` or Bee) and a funded postage batch for the steward.
- Freedom Browser 0.8.8 or newer for members.

## License

[MIT](LICENSE)
