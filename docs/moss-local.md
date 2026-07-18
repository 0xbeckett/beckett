# Fully-local Moss runtime

`src/moss-local/` is an internal-only retrieval boundary for the later memory transplant. It does **not** change Beckett's existing markdown memory graph or the `recall`/`remember` CLI.

## What is local

- The exact `@moss-dev/moss-core@0.8.7` N-API core is pinned in `package.json`/`bun.lock`. The adapter uses only its in-process `Index` primitive (hybrid dense + keyword retrieval); it never constructs `MossClient`, `IndexManager`, or `ManageClient`, which are the Cloud-facing APIs.
- `beckett-local-hash-v1` is a deterministic feature-hashing sentence encoder shipped in [`src/moss-local/embedding.ts`](../src/moss-local/embedding.ts). It runs in-process, has no fetch/HTTP dependency, and needs no model download or API key. Its small semantic lexicon plus character features provides offline semantic matching for agent memory terms.
- Each index is durable under `$BECKETT_DIR/moss` (default: `~/.beckett/moss`) as `<name>.moss` (Moss core binary index) and `<name>.docs.json` (original typed metadata). `upsert` atomically replaces both local files and `openLocalMoss` reloads them.

The one-time `bun install` fetches the pinned native package as normal dependency installation. It is not a runtime service or model download. After installation, ingestion and query have no network path. The smoke test replaces `fetch` with a throwing function while it opens, ingests, queries, and reloads an index.

## Install and run

```sh
bun install
bun run moss:smoke
bun run moss:bench
```

The benchmark creates/reuses `$BECKETT_DIR/moss/bench/three-thousand.{moss,docs.json}`, warms the process, then prints end-to-end local query p50/p95 over 600 queries on 3,000 documents. The timer includes the local embedding and Moss hybrid search but excludes startup/index construction. It is a benchmark rather than a CI test because host CPU affects the sub-10ms target.

To verify the hot path at the OS boundary on Linux, after `bun install`:

```sh
strace -f -e trace=network -o /tmp/moss-network.log bun run moss:smoke
# /tmp/moss-network.log contains no connect/sendto calls from Moss ingest/query
```

## Internal API

```ts
import { openLocalMoss } from "./src/moss-local/index.ts";

const moss = await openLocalMoss({ indexName: "agent-notes" });
await moss.upsert([
  { id: "deploy-1", text: "Deploy after tests pass.", metadata: { project: "beckett", visibility: "owner" } },
]);
const result = moss.query("how do I ship it?", { project: "beckett" });
```

`query(text, filters, options?)` performs hybrid semantic + keyword retrieval. Filters are ANDed exact values by default and support `$eq`, `$ne`, `$in`, and `$nin`, for example `{ visibility: { $in: ["owner", "team"] } }`. Query hits retain original string/number/boolean metadata.

## Attribution

Moss is BSD-2-Clause (upstream: <https://github.com/usemoss/moss>). This adapter is deliberately limited to the open core's local `Index` API and locally generated `custom` embeddings. The upstream Cloud SDK is neither imported nor configured.
