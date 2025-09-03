**RAG EUR‑Lex MVP**

- Simple RAG stack over EU legislation using EUR‑Lex/CELLAR discovery, HTML parsing, OpenAI embeddings, and Postgres + pgvector.

**Prerequisites**
- Docker Desktop: required for Postgres with `pgvector`.
- Node.js LTS: v18+ (v20 recommended), npm.
- OpenAI API key with active billing/quota.

**Configuration**
- Create `.env.local` in the project root:
  - `DATABASE_URL=postgres://postgres:postgres@localhost:5432/ragdb`
  - `OPENAI_API_KEY=sk-...`
  - `OPENAI_EMBED_MODEL=text-embedding-3-small` (default)
  - `OPENAI_CHAT_MODEL=gpt-4o` (default)
  - Optional SPARQL knobs:
    - `SPARQL_ENDPOINT=https://op.europa.eu/webapi/rdf/sparql` (script also tries publications.europa.eu)
    - `SPARQL_TIMEOUT_MS=120000`

**Run Steps**
- Start DB: `npm run db:up`
  - Bootstraps Postgres 16 + `pgvector` and runs `docker/init.sql` to create the `documents` table and vector index.
- Verify DB: `npm run db:ping`
  - Prints server version and database name if the connection works.
- Seed data (discovery → fetch → parse → chunk → embed → upsert):
  - Typical: `npm run seed -- --limit=10 --pages=1 --since-year=2024`
  - Specific CELEX: `npm run seed -- --celex=32016R0679`
  - Dry‑run without embeddings/DB (for quick tests): `npm run seed -- --limit=5 --pages=1 --since-year=2024 --no-embed`
  - On completion the script logs totals, per‑step duration, and a mini report of first CELEX + chunk counts.
- Start app: `npm run dev` then open `http://localhost:3000`
  - Minimal chat UI calls `POST /api/ask` and shows answer + citations with similarity scores. “Șterge conversația” clears the thread.

**What’s Implemented**
- Discovery via SPARQL (ELI first, CDM fallback); prefers Romanian where available.
- Fetch stable EUR‑Lex TXT page (`urlTxt`) for each item.
- Parse with Cheerio; strip obvious nav/boilerplate; preserve article/section headings.
- Chunk text to ~800–1000 chars with sentence‑aware splits; hard‑split if a single sentence is too long.
- Embedding: OpenAI `text-embedding-3-small` (1536‑dim), stored in `pgvector`.
- Upsert: one row per chunk with `celex` (also `doc_id`), `chunk_id`, `content`, `embedding`.
- Retrieval: cosine similarity using `embedding <=> $1` ordering; returns top‑k chunks and scores.
- Answering: system prompt enforces STRICT grounding; cites `[ #CELEX:chunk ]`; Romanian output; temperature 0.2.
- API route: `POST /api/ask` accepts `{ question }` (or `{ query }`) and returns `{ text, sources, sourceEntries }`.
- UI: minimal chat with enter‑to‑send, pending state, and source links to EUR‑Lex.
- Tests: `npm run test` covers cosine mapping and citation/context formatting.

**Limitations**
- HTML parsing may still include some boilerplate (varies by EUR‑Lex template).
- Citations are per‑chunk; no paragraph/line exact anchors on EUR‑Lex pages.
- Not all acts have Romanian text; the seeder can fall back to EN for content.
- Discovery endpoint performance may vary; queries avoid heavy global sorts but can still be slow/intermittent.
- Embedding/answering requires OpenAI quota; without it use `--no-embed` for dry‑run.

**Potential Upgrades**
- DOM extraction: tighter selectors per EUR‑Lex template; handle annexes, tables, footnotes more precisely.
- CELLAR REST: fetch canonical HTML/PDF binaries instead of web TXT for stable parsing; consider XML where available.
- Rerankers: add cross‑encoder/LM rerank pass over top‑k to improve precision.
- Streaming: server‑stream answers to UI for faster perceived latency.
- Multilingual: UI toggle (RO/EN) with language‑scoped retrieval; multi‑embed per language.
- Indexing: experiment with HNSW (pgvector) or tune IVFFlat lists/ef/search params.
- Concurrency: batched embeddings with rate‑limit aware pooling; backoff policies.
- Caching: store fetched HTML and parsed chunks to speed up re‑seeds.

**Troubleshooting**
- Port in use (5432):
  - Change port mapping in `docker-compose.yml` (e.g., `5433:5432`) and update `DATABASE_URL` accordingly.
- Vector extension missing:
  - Ensure `docker/init.sql` runs; check `CREATE EXTENSION vector;` and that you’re connected to `ragdb`.
- “DATABASE_URL is not set”:
  - Ensure `.env.local` has `DATABASE_URL`, and restart the command; both `lib/db.ts` and scripts load `.env.local`.
- SPARQL timeouts / HTML responses:
  - The seeder falls back across endpoints and GET/POST; increase `SPARQL_TIMEOUT_MS`, reduce `--limit`, or use `--celex=` to bypass discovery.
- OpenAI 429 or quota errors:
  - Activate billing/credit on the project for the API key; for testing use `--no-embed`.
- Slow seeds:
  - Start with small `--limit`, and run again later; logs show per‑step durations for diagnosis.

**Acceptance Checklist (PRD)**
- Discovery: recent Regulations/Directives via SPARQL; prefer RO titles (fallback EN); stable `urlTxt`; limit/paging.
- Fetch & Parse: load each `urlTxt`, extract main legal text; strip nav; keep article/section headings.
- Chunking: build ~800–1000 char chunks, sentence‑aware when possible.
- Embeddings: `OPENAI_EMBED_MODEL=text-embedding-3-small`.
- Storage: upsert into Postgres `documents` with `celex` as `celex` and `doc_id`, incremental `chunk_id`, `content`, `embedding`.
- Retrieval: cosine top‑k from `documents` using `embedding <=> $1`.
- Answer: STRICTLY from context; cite `[ #CELEX:chunk ]`; fallback when insufficient; `OPENAI_CHAT_MODEL=gpt-4o` temperature 0.2.
- API: `POST /api/ask` with validation and robust errors.
- UI: minimal chat, Enter‑to‑send, disabled while pending; shows Q/A and “Sources: #CELEX:chunk (score) …”; clear chat button.
- Logging: seeder prints total docs, total chunks, average chunk length, and per‑step durations; mini report of first 3 CELEX.
- Tests: cosine mapping and citation/context formatting.

