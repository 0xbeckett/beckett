import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { openLocalMoss } from "./index.ts";

const temporaryDirectories: string[] = [];

async function temporaryDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "beckett-moss-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("local Moss embeds, filters, persists, and reloads without fetch", async () => {
  const dataDir = await temporaryDataDir();
  const originalFetch = globalThis.fetch;
  // Any accidental cloud/model request would make this test fail. The runtime itself has no URL,
  // fetch, HTTP client, or cloud manager dependency.
  globalThis.fetch = (() => { throw new Error("network egress is forbidden in local Moss"); }) as unknown as typeof fetch;
  try {
    const moss = await openLocalMoss({ dataDir, indexName: "smoke" });
    await moss.upsert([
      { id: "refund", text: "Refunds are processed in three to five business days.", metadata: { team: "billing", visible: true } },
      { id: "password", text: "Reset a forgotten password from account settings.", metadata: { team: "support", visible: true } },
      { id: "deploy", text: "Deploy the worker after its test suite passes.", metadata: { team: "engineering", visible: false } },
    ]);

    expect(existsSync(moss.indexPath)).toBe(true);
    expect(existsSync(moss.documentsPath)).toBe(true);
    expect(moss.query("when will my reimbursement arrive?").docs[0]?.id).toBe("refund");

    const filtered = moss.query("account help", { team: "support", visible: true });
    expect(filtered.docs.map((hit) => hit.id)).toEqual(["password"]);

    const reloaded = await openLocalMoss({ dataDir, indexName: "smoke" });
    expect(reloaded.docCount).toBe(3);
    expect(reloaded.query("how long does a refund take?", { team: "billing" }).docs[0]?.id).toBe("refund");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upsert replaces an existing local document", async () => {
  const moss = await openLocalMoss({ dataDir: await temporaryDataDir() });
  await moss.upsert([{ id: "one", text: "Old deployment guide", metadata: { version: 1 } }]);
  const result = await moss.upsert([{ id: "one", text: "New rollback guide", metadata: { version: 2 } }]);
  expect(result).toMatchObject({ added: 0, updated: 1, docCount: 1 });
  expect(moss.query("rollback", { version: 2 }).docs[0]?.text).toBe("New rollback guide");
});
