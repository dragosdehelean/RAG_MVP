-- EN: SQL init for pgvector and the documents table with vector index.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents(
  id BIGSERIAL PRIMARY KEY,
  celex TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  chunk_id INT NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_docs_vec
  ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists=100);

-- Ensure idempotent seeding: prevent duplicates per CELEX + chunk
CREATE UNIQUE INDEX IF NOT EXISTS uq_docs_celex_chunk
  ON documents (celex, chunk_id);

ANALYZE documents;
