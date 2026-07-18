/**
 * Fully-local Moss runtime boundary.
 *
 * This module uses only the `Index` primitive from `@moss-dev/moss-core`.  It intentionally
 * does not construct MossClient, IndexManager, or ManageClient: those are the cloud-facing
 * APIs. Embeddings are made by ./embedding.ts in-process and the index is stored in
 * `$BECKETT_DIR/moss` as a Moss `.moss` binary plus a local document sidecar.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deserializeFromBinary, Index, serializeToBinary, type DocumentInfo } from "@moss-dev/moss-core";
import { resolveBeckettDir } from "../paths.ts";
import { EMBEDDING_DIMENSIONS, embedLocal, LOCAL_EMBEDDING_MODEL } from "./embedding.ts";

export { EMBEDDING_DIMENSIONS, embedLocal, LOCAL_EMBEDDING_MODEL } from "./embedding.ts";

export type MetadataValue = string | number | boolean;
export type MossMetadata = Record<string, MetadataValue>;

export interface MossDocument {
  id: string;
  text: string;
  metadata?: MossMetadata;
}

export type MetadataCondition =
  | MetadataValue
  | { $eq?: MetadataValue; $ne?: MetadataValue; $in?: MetadataValue[]; $nin?: MetadataValue[] };

/** A simple ANDed metadata map. `{ type: "note", audience: { $in: ["owner", "team"] } }`. */
export type MossFilters = Record<string, MetadataCondition | undefined>;

export interface QueryOptions {
  /** Maximum matching documents to return. Defaults to 5. */
  topK?: number;
  /** Dense semantic contribution from 0 (keyword only) to 1 (semantic only). Defaults to .75. */
  semanticWeight?: number;
}

export interface MossHit extends MossDocument {
  score: number;
}

export interface MossQueryResult {
  docs: MossHit[];
  query: string;
  timeTakenInMs: number;
}

export interface UpsertResult {
  added: number;
  updated: number;
  docCount: number;
}

export interface LocalMossOptions {
  /** Index name is also the basename of the persisted files. */
  indexName?: string;
  /** Defaults to `$BECKETT_DIR/moss`; pass a temporary directory in tests. */
  dataDir?: string;
  /** Environment injection keeps the default data path deterministic in callers/tests. */
  env?: NodeJS.ProcessEnv;
}

interface PersistedDocuments {
  format: 1;
  embeddingModel: typeof LOCAL_EMBEDDING_MODEL;
  documents: MossDocument[];
}

function assertIndexName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) {
    throw new Error("Moss indexName must contain only letters, numbers, '.', '_' or '-'");
  }
}

function nativeMetadata(metadata: MossMetadata | undefined): Record<string, string> | undefined {
  if (!metadata) return undefined;
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, String(value)]));
}

function nativeDocument(document: MossDocument): DocumentInfo {
  return { id: document.id, text: document.text, metadata: nativeMetadata(document.metadata) };
}

/** Convert the public friendly map to the filter AST expected by Moss core. */
function nativeFilter(filters: MossFilters | undefined): object | undefined {
  if (!filters) return undefined;
  const clauses = Object.entries(filters)
    .filter(([, condition]) => condition !== undefined)
    .map(([field, condition]) => {
      const value = typeof condition === "object" && condition !== null
        ? Object.fromEntries(Object.entries(condition).map(([operator, operand]) => [
          operator,
          Array.isArray(operand) ? operand.map(String) : String(operand),
        ]))
        : { $eq: String(condition) };
      return { field, condition: value };
    });
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

function validateDocument(document: MossDocument): void {
  if (!document.id.trim()) throw new Error("Moss document id must not be empty");
  if (!document.text.trim()) throw new Error(`Moss document '${document.id}' text must not be empty`);
  for (const [key, value] of Object.entries(document.metadata ?? {})) {
    if (!key.trim() || !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Moss document '${document.id}' has invalid metadata '${key}'`);
    }
  }
}

async function atomicWrite(path: string, contents: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

/**
 * A persistent, in-process Moss core index. Create it with `await openLocalMoss()`.
 * All query work is synchronous native code; async is used only for durable file writes.
 */
export class LocalMoss {
  readonly indexName: string;
  readonly dataDir: string;
  readonly indexPath: string;
  readonly documentsPath: string;
  private index: Index;
  private readonly documents = new Map<string, MossDocument>();

  private constructor(indexName: string, dataDir: string) {
    this.indexName = indexName;
    this.dataDir = dataDir;
    this.indexPath = join(dataDir, `${indexName}.moss`);
    this.documentsPath = join(dataDir, `${indexName}.docs.json`);
    this.index = new Index(indexName, "custom");
  }

  static async open(options: LocalMossOptions = {}): Promise<LocalMoss> {
    const indexName = options.indexName ?? "memory";
    assertIndexName(indexName);
    const dataDir = resolve(options.dataDir ?? join(resolveBeckettDir(options.env), "moss"));
    const local = new LocalMoss(indexName, dataDir);
    await local.load();
    return local;
  }

  get docCount(): number {
    return this.index.docCount;
  }

  /** Embed, upsert, build, and atomically persist local documents. No network activity occurs. */
  async upsert(input: readonly MossDocument[]): Promise<UpsertResult> {
    const latest = new Map<string, MossDocument>();
    for (const document of input) {
      validateDocument(document);
      latest.set(document.id, { ...document, metadata: document.metadata ? { ...document.metadata } : undefined });
    }
    if (latest.size === 0) return { added: 0, updated: 0, docCount: this.docCount };

    const docs = [...latest.values()];
    const result = this.index.addDocuments(docs.map(nativeDocument), docs.map((document) => embedLocal(document.text)), { upsert: true });
    for (const document of docs) this.documents.set(document.id, document);
    await this.persist();
    return { ...result, docCount: this.docCount };
  }

  /** Delete documents by id, then atomically persist. Unknown ids are ignored. */
  async delete(ids: readonly string[]): Promise<{ deleted: number; docCount: number }> {
    const targets = [...new Set(ids)].filter((id) => this.documents.has(id));
    if (targets.length === 0) return { deleted: 0, docCount: this.docCount };
    const deleted = this.index.deleteDocuments(targets);
    for (const id of targets) this.documents.delete(id);
    await this.persist();
    return { deleted, docCount: this.docCount };
  }

  /** All documents currently in the index (defensive copies, typed metadata preserved). */
  list(): MossDocument[] {
    return [...this.documents.values()].map((document) => ({
      ...document,
      metadata: document.metadata ? { ...document.metadata } : undefined,
    }));
  }

  /** Hybrid local search (Moss dense + keyword fusion) with an optional metadata AND-filter. */
  query(text: string, filters?: MossFilters, options: QueryOptions = {}): MossQueryResult {
    if (!text.trim()) return { docs: [], query: text, timeTakenInMs: 0 };
    const topK = options.topK ?? 5;
    const semanticWeight = options.semanticWeight ?? 0.75;
    if (!Number.isInteger(topK) || topK < 1) throw new Error("Moss topK must be a positive integer");
    if (semanticWeight < 0 || semanticWeight > 1) throw new Error("Moss semanticWeight must be between 0 and 1");

    const result = this.index.query(text, topK, embedLocal(text), semanticWeight, nativeFilter(filters));
    return {
      query: text,
      timeTakenInMs: result.timeTakenInMs ?? 0,
      docs: result.docs.map((hit) => ({
        ...(this.documents.get(hit.id) ?? { id: hit.id, text: hit.text, metadata: hit.metadata }),
        score: hit.score,
      })),
    };
  }

  private async load(): Promise<void> {
    try {
      const [binary, rawDocuments] = await Promise.all([readFile(this.indexPath), readFile(this.documentsPath, "utf8")]);
      const persisted = JSON.parse(rawDocuments) as PersistedDocuments;
      if (persisted.format !== 1 || persisted.embeddingModel !== LOCAL_EMBEDDING_MODEL || !Array.isArray(persisted.documents)) {
        throw new Error(`Unsupported local Moss index format at ${this.dataDir}`);
      }
      for (const document of persisted.documents) validateDocument(document);
      const serialized = deserializeFromBinary(binary);
      if (serialized.dimension !== EMBEDDING_DIMENSIONS || serialized.name !== this.indexName) {
        throw new Error(`Local Moss index '${this.indexName}' does not match this runtime`);
      }
      this.index.deserialize(serialized, persisted.documents.map(nativeDocument));
      for (const document of persisted.documents) this.documents.set(document.id, document);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async persist(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const docs: PersistedDocuments = {
      format: 1,
      embeddingModel: LOCAL_EMBEDDING_MODEL,
      documents: [...this.documents.values()],
    };
    // Each durable file is replaced atomically; the sidecar retains typed metadata that Moss's
    // binary document format intentionally stores as strings.
    await atomicWrite(this.documentsPath, `${JSON.stringify(docs)}\n`);
    await atomicWrite(this.indexPath, serializeToBinary(this.index.serialize()));
  }
}

/** Open (and, if present, reload) a fully-local persisted Moss index. */
export function openLocalMoss(options?: LocalMossOptions): Promise<LocalMoss> {
  return LocalMoss.open(options);
}
