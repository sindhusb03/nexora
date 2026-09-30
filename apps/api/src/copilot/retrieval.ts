import { cosineSimilarity } from "ai";

const DIMENSIONS = 48;

export interface Chunk {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly embedding: readonly number[];
}

/** Deterministic hashed-token embedding so retrieval works with no provider key. */
export function embedText(text: string): number[] {
  const vector = Array.from({ length: DIMENSIONS }, () => 0);
  for (const token of tokens(text)) {
    const bucket = hashToken(token) % DIMENSIONS;
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

export function hybridSearch(
  query: string,
  chunks: readonly Chunk[],
  limit = 4,
): readonly (Chunk & { readonly score: string })[] {
  const queryVector = embedText(query);
  const queryTokens = new Set(tokens(query));
  return chunks
    .map((chunk) => {
      const vectorScore = cosineSimilarity(queryVector, [...chunk.embedding]);
      const chunkTokens = tokens(chunk.text);
      const overlap = chunkTokens.filter((token) => queryTokens.has(token)).length;
      const keywordScore = chunkTokens.length === 0 ? 0 : overlap / Math.sqrt(chunkTokens.length);
      const score = 0.55 * vectorScore + 0.45 * keywordScore;
      return { ...chunk, score: score.toFixed(4) };
    })
    .sort((left, right) => Number(right.score) - Number(left.score))
    .slice(0, limit);
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((token) => token.length > 2);
}

function hashToken(token: string): number {
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = (hash * 33 + token.charCodeAt(index)) >>> 0;
  }
  return hash;
}
