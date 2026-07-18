/**
 * Offline embedding used by the local Moss adapter.
 *
 * This is a deterministic feature-hashing sentence encoder, deliberately shipped in source
 * instead of fetching a model.  It has no I/O or network dependency.  Canonical concepts
 * give common agent phrasing ("credential"/"password", "refund"/"reimbursement") a
 * shared vector feature while character n-grams make unknown words less brittle.
 */

export const LOCAL_EMBEDDING_MODEL = "beckett-local-hash-v1";
export const EMBEDDING_DIMENSIONS = 384;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "what", "when", "where", "with", "you", "your",
]);

/** A compact, auditable semantic lexicon embedded in the executable (not a remote model). */
const CONCEPTS: Record<string, string> = {
  ai: "artificial-intelligence", artificial: "artificial-intelligence", intelligence: "artificial-intelligence",
  automobile: "car", auto: "car", vehicle: "car", cars: "car",
  auth: "authentication", authenticate: "authentication", authentication: "authentication", login: "authentication", signin: "authentication",
  bug: "error", bugs: "error", failure: "error", failures: "error", issue: "error", issues: "error", error: "error",
  cache: "storage", cached: "storage", caching: "storage", database: "storage", disk: "storage", persist: "storage", persistence: "storage", store: "storage", storage: "storage",
  credential: "password", credentials: "password", passcode: "password", password: "password", secret: "password", secrets: "password",
  delay: "latency", fast: "latency", latency: "latency", performance: "latency", slow: "latency", speed: "latency",
  delete: "remove", erase: "remove", remove: "remove", wipe: "remove",
  embedding: "semantic-search", embeddings: "semantic-search", recall: "semantic-search", retrieval: "semantic-search", search: "semantic-search", semantic: "semantic-search",
  money: "refund", reimbursement: "refund", reimbursements: "refund", refund: "refund", refunds: "refund", return: "refund", returns: "refund",
  message: "notification", messages: "notification", notify: "notification", notification: "notification", notifications: "notification",
  private: "privacy", privacy: "privacy", secure: "privacy", security: "privacy",
  task: "work", tasks: "work", ticket: "work", tickets: "work", work: "work",
};

function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 3 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(stem)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

function addFeature(vector: Float64Array, feature: string, weight: number): void {
  const value = hash(feature);
  const index = value % EMBEDDING_DIMENSIONS;
  vector[index] = (vector[index] ?? 0) + ((value & 0x80000000) === 0 ? weight : -weight);
}

/** Generate a unit-length local embedding. Same text always generates the same vector. */
export function embedLocal(text: string): number[] {
  const vector = new Float64Array(EMBEDDING_DIMENSIONS);
  const tokens = tokenize(text);

  for (const token of tokens) {
    addFeature(vector, `word:${token}`, 1);
    const concept = CONCEPTS[token];
    if (concept) addFeature(vector, `concept:${concept}`, 1.25);
    // Character features help with names and terms which are not in the small lexicon.
    const padded = `^${token}$`;
    for (let i = 0; i <= padded.length - 3; i++) addFeature(vector, `gram:${padded.slice(i, i + 3)}`, 0.18);
  }

  let magnitude = 0;
  for (const value of vector) magnitude += value * value;
  if (magnitude === 0) return Array.from(vector);
  const scale = 1 / Math.sqrt(magnitude);
  return Array.from(vector, (value) => value * scale);
}
