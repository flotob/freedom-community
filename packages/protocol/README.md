# @freedom-community/protocol

Placeholder. Planned contents:

- **Schemas** for the community genesis document, the action envelope (`…/action/v0`), ledger pages and view pages.
- **Builders and validators** for each of them.
- **One pure reducer:** `(state, action) → (state, outcome)`. The steward, the app and the audit command all use it, so a replay of the ledger reaches the same state everywhere.
- **Feed helpers** that derive topics and single-owner-chunk addresses byte-identically to Freedom Browser's `window.swarm`.
