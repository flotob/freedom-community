# freedom-community

Online communities that live on [Swarm](https://www.ethswarm.org/) instead of on a server, used through [Freedom Browser](https://github.com/solardev-xyz/freedom-browser).

> **Status: working prototype (November 2026).** One test community runs end to end in Freedom 0.8.8:
> - joining with one consent sheet; posts with images and categories, comments, likes, edits;
> - moderation with reasons; roles, and badges that carry roles, with score decals;
> - quests (secret-answer text, multiple choice, reviewed photos) and leaderboards;
> - a ledger anyone can replay in their browser.
>
> The client is a separate, private app; this repository holds the open protocol, the steward and the node deployment.

## Idea in one paragraph

Every member writes their actions (posts, comments, likes, profile changes, quest answers) to their own signed journal, a Swarm feed published from Freedom Browser. A **steward** per community reads those journals, checks each action against the community's rules (membership, roles, moderation), and publishes two things to Swarm:

- an append-only **ledger** of accepted and rejected actions, with reasons;
- read-optimised **views** that the app renders: feeds, threads, member lists, leaderboards.

The steward is a convenience, not an authority:
- Anyone can replay the public ledger with the same rules and must reach the same state (`steward audit`, or in a browser).
- The community stays readable when the steward is offline.
- A steward with an empty disk rebuilds itself from the ledger.

Quest solutions and members' answers to judged quests are sealed to the steward, so they can't be copied from public journals. The steward's verdicts are recorded in the ledger (see [`docs/protocol.md`](docs/protocol.md) for the trust model).

## Layout

| Path | What |
|---|---|
| [`packages/protocol`](packages/protocol) | Schemas, builders, validators, and the pure reducer (state + action → state + outcome) shared by the steward, the app and audits. |
| [`apps/steward`](apps/steward) | The reference steward: ingest journals, verify, reduce, append the ledger, publish views, keep content stamped, judge sealed answers. Also `scripts/` to create a community, publish an app at its stable origin, and write an action as any key. |
| [`deploy/ant`](deploy/ant) | Container for the Swarm node the steward uses: [Ant](https://github.com/freedom-hq/ant) (`antd`), a light node with a Bee-compatible API, plus the doorbell keeper. |
| [`spikes`](spikes) | The feasibility spikes (P0) and their results ([`docs/spikes`](docs/spikes)). |
| [`tools/freedom-driver`](tools/freedom-driver) | Drives a real Freedom Browser through CDP for end-to-end checks. |
| [`docs`](docs) | Protocol and operations docs. |

## Requirements

- Node.js 22 or newer for the packages and the steward.
- A Swarm node with a Bee-compatible API (`antd` or Bee) and a funded postage batch for the steward.
- Freedom Browser 0.8.8 or newer for members.

## License

[MIT](LICENSE)
