# Steward

Placeholder. The steward runs one community. It works as a pipeline:

1. **Ingest:** learn about new journal entries from a GSOC "doorbell" ping plus slow polling of members' journals.
2. **Verify:** signature, schema, and the community's rules.
3. **Reduce:** apply the action with `@freedom-community/protocol`'s reducer.
4. **Ledger:** append the action and its outcome, accepted or rejected with a reason.
5. **Views:** republish the pages the app reads.
6. **Stamps:** re-stamp accepted content on the community's postage batch so it outlives members' own batches.

It talks to a Swarm node through the Bee-compatible HTTP API; see [`deploy/ant`](../../deploy/ant).
