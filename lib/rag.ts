// EN: RAG utilities — embedding, retrieval via pgvector, and answer generation.
import OpenAI from 'openai';
import { query as dbQuery } from './db';

const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o';
const TEMPERATURE = 0.2;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type RetrievedChunk = {
  celex: string;
  doc_id: string;
  chunk_id: number;
  content: string;
  score: number; // cosine similarity
};

export function toPgVector(vec: number[]): string {
  // pgvector expects a literal like '[0.1, 0.2, ...]'
  return `[${vec.join(',')}]`;
}

export function cosineScoreFromDistance(distance: number): number {
  // For vector_cosine_ops, <=> yields (1 - cosine_similarity)
  // So score (similarity) = 1 - distance
  return 1 - Number(distance);
}

export function formatCitation(celex: string, chunkId: number): string {
  return `#${celex}:${chunkId}`;
}

export async function embedText(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
  return res.data[0].embedding as number[];
}

export async function retrieve(queryText: string, k = 5): Promise<RetrievedChunk[]> {
  const embedding = await embedText(queryText);
  const v = toPgVector(embedding);
  const sql = `
    SELECT celex, doc_id, chunk_id, content,
           (1 - (embedding <=> $1::vector)) AS score
    FROM documents
    ORDER BY embedding <=> $1::vector
    LIMIT $2;
  `;
  const { rows } = await dbQuery<any>(sql, [v, k]);
  return rows.map(r => ({
    celex: r.celex,
    doc_id: r.doc_id,
    chunk_id: Number(r.chunk_id),
    content: r.content,
    score: Number(r.score)
  }));
}

export function buildContext(chunks: RetrievedChunk[]): string {
  return chunks.map(c => `[${formatCitation(c.celex, c.chunk_id)}]\n${c.content}`).join('\n\n');
}

export async function answer(query: string): Promise<{ text: string; sources: string[]; sourceEntries: { citation: string; score: number }[] }> {
  const chunks = await retrieve(query, 5);
  if (!chunks.length || (chunks[0]?.score ?? 0) < 0.25) {
    return { text: "Nu știu. Nu am suficiente informații din contextul recuperat.", sources: [], sourceEntries: [] };
  }

  const context = buildContext(chunks);
  const system = "Answer STRICTLY from the provided context. If the context is insufficient, say you don't know. Cite using the format [#CELEX:chunkId]. Answer in Romanian.";

  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: TEMPERATURE,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Întrebare:\n${query}\n\nContext:\n${context}` }
    ]
  });

  const text = completion.choices[0]?.message?.content?.trim() || '';
  const sourceEntries = chunks.map(c => ({ citation: formatCitation(c.celex, c.chunk_id), score: Number(c.score) }));
  const sources = sourceEntries.map(s => s.citation);
  return { text, sources, sourceEntries };
}

// Backwards-compat wrappers (optional use elsewhere)
export async function retrieveTopK(queryText: string, k = 10) {
  return retrieve(queryText, k);
}
export async function generateAnswer(question: string, k = 10) {
  const chunks = await retrieve(question, k);
  if (!chunks.length || (chunks[0]?.score ?? 0) < 0.25) {
    return { answer: 'Nu știu. Nu am suficiente informații din contextul recuperat.', sources: [] as any };
  }
  const context = buildContext(chunks);
  const system = "Answer STRICTLY from the provided context. If the context is insufficient, say you don't know. Cite using the format [#CELEX:chunkId]. Answer in Romanian.";
  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: TEMPERATURE,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Întrebare:\n${question}\n\nContext:\n${context}` }
    ]
  });
  const answer = completion.choices[0]?.message?.content?.trim() || '';
  const sources = chunks.map(c => ({ celex: c.celex, chunk_id: c.chunk_id, relevance: c.score }));
  return { answer, sources };
}
