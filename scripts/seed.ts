// EN: Seed script (Part A - discovery). Queries the SPARQL endpoint for recent Regulations/Directives,
// prefers Romanian titles (fallback to English), paginates via LIMIT/OFFSET, and prints JSON items.

import dotenv from 'dotenv';
dotenv.config();
try { dotenv.config({ path: '.env.local', override: true }); } catch {}
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { pool } from '../lib/db';

type DiscItem = { celex: string; title: string; lang: 'ro' | 'en'; work: string; expression: string; issued?: string; urlTxt: string };

// SPARQL endpoints to try, in order. You can override primary via SPARQL_ENDPOINT.
const SPARQL_ENDPOINTS: string[] = [
  process.env.SPARQL_ENDPOINT || 'https://op.europa.eu/webapi/rdf/sparql',
  'https://publications.europa.eu/webapi/rdf/sparql'
];
const SPARQL_TIMEOUT_MS = Number(process.env.SPARQL_TIMEOUT_MS || '60000');

// A working SPARQL example used by this script (validate in the endpoint UI if needed):
//
// PREFIX eli: <http://data.europa.eu/eli/ontology#>
// PREFIX dct: <http://purl.org/dc/terms/>
// PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
// SELECT ?celex ?work ?expression ?title ?lang ?issued
// WHERE {
//   ?work a eli:LegalResource ;
//         eli:type_document ?doctype ;
//         eli:is_realized_by ?expression ;
//         eli:celex ?celex .
//   VALUES ?doctype { eli:Directive eli:Regulation }
//   OPTIONAL { ?expression dct:issued ?issued }
//   OPTIONAL { ?expression eli:title ?title_ro FILTER(LANG(?title_ro) = 'ro') }
//   OPTIONAL { ?expression eli:title ?title_en FILTER(LANG(?title_en) = 'en') }
//   BIND(COALESCE(?title_ro, ?title_en) AS ?title)
//   BIND(IF(BOUND(?title_ro), 'ro', 'en') AS ?lang)
//   FILTER(BOUND(?title))
// }
// ORDER BY DESC(?issued)
// LIMIT 10 OFFSET 0

function buildQueryCDM(limit: number, offset: number, sinceYear?: number) {
  // Variant using classes eli:Regulation / eli:Directive directly to reduce reliance on celex availability.
  const sinceFilter = sinceYear
    ? `FILTER(BOUND(?issued) && ?issued >= "${sinceYear}-01-01T00:00:00"^^xsd:dateTime)`
    : '';
  return `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX cmr: <http://publications.europa.eu/ontology/cdm/cmr#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT ?celex ?work ?expression ?title ?lang ?issued WHERE {
  ?expression a cdm:expression ;
              cdm:expression_belongs_to_work ?work ;
              cdm:expression_title ?title .
  OPTIONAL { ?expression cmr:lang ?langLiteral }
  OPTIONAL { ?expression cdm:expression_uses_language ?langRes }
  OPTIONAL { ?expression cmr:lastModificationDate ?issued }
  ?work owl:sameAs ?same .
  FILTER(CONTAINS(STR(?same), "/resource/celex/"))
  BIND(REPLACE(STR(?same), ".*/resource/celex/([^.]+).*$", "$1") AS ?celex)
  BIND(
    IF(BOUND(?langLiteral) && (STR(?langLiteral) = 'ro' || STR(?langLiteral) = 'ron' || STR(?langLiteral) = 'rum'), 'ro',
      IF(BOUND(?langLiteral) && (STR(?langLiteral) = 'en' || STR(?langLiteral) = 'eng'), 'en',
        IF(BOUND(?langRes) && CONTAINS(STR(?langRes), '/ROU'), 'ro',
          IF(BOUND(?langRes) && CONTAINS(STR(?langRes), '/ENG'), 'en', UNDEF)
        )
      )
    )
  AS ?lang)
  FILTER(BOUND(?lang))
  FILTER(REGEX(?celex, '^3[0-9]{4}[RL]'))
  ${sinceFilter}
}
LIMIT ${limit} OFFSET ${offset}
`.trim();
}

function buildQueryELI(limit: number, offset: number, sinceYear?: number) {
  // ELI query grouped by CELEX to avoid duplicates; filter by CELEX year if provided.
  const yearFilter = sinceYear ? `FILTER(xsd:integer(SUBSTR(STR(?celex), 2, 4)) >= ${sinceYear})` : '';
  return `
PREFIX eli: <http://data.europa.eu/eli/ontology#>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?celex (SAMPLE(?work) AS ?work) (SAMPLE(?expression) AS ?expression)
       (SAMPLE(?title) AS ?title) (SAMPLE(?lang) AS ?lang) (MAX(?issued) AS ?issued)
FROM <http://publications.europa.eu/resource/dataset/cellar>
WHERE {
  ?work eli:celex ?celex .
  FILTER(REGEX(STR(?celex), '^3[0-9]{4}[RL]'))
  ${yearFilter}
  OPTIONAL {
    ?work eli:is_realized_by ?expression .
    OPTIONAL { ?expression dct:issued ?issued }
    OPTIONAL { ?expression eli:title ?title }
    OPTIONAL { ?expression dct:language ?lang }
  }
}
GROUP BY ?celex
ORDER BY DESC(?issued)
LIMIT ${limit} OFFSET ${offset}
`.trim();
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 5, baseDelayMs = 500, timeoutMs = 20000): Promise<Response> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(`timeout ${timeoutMs}ms`), timeoutMs);
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(id);
      if (res.status >= 200 && res.status < 300) return res;
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        const delay = baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 200);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      // Non-retryable
      return res;
    } catch (err) {
      lastErr = err;
      const delay = baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 200);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new Error('Fetch failed after retries');
}

async function runSparql(query: string): Promise<any> {
  const headersPost = {
    'Accept': 'application/sparql-results+json, application/json;q=0.9, */*;q=0.1',
    'Content-Type': 'application/sparql-query',
    'User-Agent': 'rag-eurlex-seeder/0.1'
  } as Record<string, string>;
  const headersGet = {
    'Accept': 'application/sparql-results+json, application/json;q=0.9, */*;q=0.1',
    'User-Agent': 'rag-eurlex-seeder/0.1'
  } as Record<string, string>;

  let lastErr: any = null;
  for (const endpoint of SPARQL_ENDPOINTS) {
    // Try POST first
    try {
      const res = await fetchWithRetry(endpoint, { method: 'POST', headers: headersPost, body: query }, 3, 700, SPARQL_TIMEOUT_MS);
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (res.ok && (ctype.includes('application/sparql-results+json') || ctype.includes('application/json'))) {
        return await res.json();
      }
      // Fall back to GET with explicit format param supported by Virtuoso
      const url = `${endpoint}?${new URLSearchParams({ query, format: 'application/sparql-results+json' }).toString()}`;
      const res2 = await fetchWithRetry(url, { method: 'GET', headers: headersGet }, 3, 700, SPARQL_TIMEOUT_MS);
      const ctype2 = (res2.headers.get('content-type') || '').toLowerCase();
      if (res2.ok && (ctype2.includes('application/sparql-results+json') || ctype2.includes('application/json'))) {
        return await res2.json();
      }
      const preview = (await res2.text()).slice(0, 200);
      lastErr = new Error(`Unexpected content-type at ${endpoint}: ${ctype2} preview=${preview}`);
      console.warn(`[Discovery] Endpoint returned non-JSON (${ctype2}). Trying next endpoint.`);
    } catch (e) {
      lastErr = e;
      console.warn(`[Discovery] Endpoint ${endpoint} failed: ${(e as any)?.message || e}`);
    }
  }
  throw lastErr || new Error('All SPARQL endpoints failed');
}

async function runDiscovery(limit = 10, pages = 1, sinceYear?: number): Promise<DiscItem[]> {
  if (SEED_MOCK) {
    const mockCelex = process.env.SEED_MOCK_CELEX || '32019R1234';
    const mockLang = (process.env.SEED_MOCK_LANG === 'en' ? 'en' : 'ro') as 'ro' | 'en';
    const item: DiscItem = {
      celex: mockCelex,
      title: mockCelex,
      lang: mockLang,
      work: '', expression: '', issued: `${(process.env.SEED_MOCK_YEAR || '2019')}-01-01`,
      urlTxt: `mock://local/CELEX:${mockCelex}`
    };
    return [item];
  }
  const items: DiscItem[] = [];
  for (let page = 0; page < pages; page++) {
    const offset = page * limit;
    const queryELI = buildQueryELI(limit, offset, sinceYear);
    const queryCDM = buildQueryCDM(limit, offset, sinceYear);
    console.log(`[Discovery] Querying SPARQL (ELI) page ${page + 1}/${pages}, limit ${limit}, offset ${offset}`);
    let data = await runSparql(queryELI);
    let bindings: any[] = data?.results?.bindings ?? [];
    if (!bindings.length) {
      console.warn('[Discovery] ELI returned 0 items; trying CDM fallback.');
      data = await runSparql(queryCDM);
      bindings = data?.results?.bindings ?? [];
    }
    if (page === 0) {
      console.log('--- SPARQL (validated) ---');
      console.log(queryELI);
      console.log('--------------------------');
    }
    for (const b of bindings) {
      const celex = b.celex?.value as string | undefined;
      const work = b.work?.value as string | undefined;
      const expression = b.expression?.value as string | undefined;
      const title = b.title?.value as string | undefined;
      const langVal = b.lang?.value as string | undefined;
      const lang: 'ro' | 'en' = langVal?.toUpperCase?.().includes('/ROU') ? 'ro' : 'en';
      const issued = b.issued?.value as string | undefined;
      if (!celex || !title) continue;
      if (sinceYear) {
        if (issued) {
          const yearStr = (issued || '').slice(0, 4);
          const y = Number(yearStr);
          if (Number.isFinite(y) && y < sinceYear) continue;
        } else {
          const m = celex.match(/^3(\d{4})[A-Z]/);
          const y2 = m ? Number(m[1]) : NaN;
          if (Number.isFinite(y2) && y2 < sinceYear) continue;
        }
      }
      const urlTxt = `https://eur-lex.europa.eu/legal-content/${lang.toUpperCase()}/TXT/?uri=CELEX:${celex}`;
      items.push({ celex, title, lang, work: work ?? '', expression: expression ?? '', issued, urlTxt });
    }
    if (!bindings.length) break; // no more
  }
  // Deduplicate by CELEX, prefer Romanian if available
  const byCelex = new Map<string, DiscItem>();
  for (const it of items) {
    const prev = byCelex.get(it.celex);
    if (!prev) { byCelex.set(it.celex, it); continue; }
    if (prev.lang !== 'ro' && it.lang === 'ro') byCelex.set(it.celex, it);
  }
  return Array.from(byCelex.values());
}

// -----------------------------
// Part B: fetch & parse helpers
// -----------------------------

const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SEED_MOCK = process.env.SEED_MOCK === '1' || process.env.SEED_TEST_MODE === '1';

type Token = { type: 'heading' | 'text'; text: string };

function cleanText(s: string): string {
  return s
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[\r\f]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isLikelyHeading(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Heuristics for article/section headings in EUR-Lex
  return /^(Article|Articolul|Art\.|Section|Capitolul|Chapter|Annex)/i.test(t) || /^[IVXLC]+\.?\s/.test(t);
}

function extractMainTokens(html: string): Token[] {
  const $ = cheerio.load(html);

  // Remove obvious non-content
  $('script, style, link, noscript, iframe, svg').remove();
  $('nav, header, footer, aside, .navbar, .header, .footer, .nav, #header, #footer, #toolbar, .toolbar, .breadcrumb, .breadcrumbs, .menu, .leftCol, .rightCol, .site-header, .site-footer, .cookie, #pageheader, #pagefooter, .portalnav').remove();

  // Try to find the main legal text container
  const main = (
    $('#text').first().length ? $('#text').first() :
    $('#documentContent').first().length ? $('#documentContent').first() :
    $('#PP').first().length ? $('#PP').first() :
    $('main').first().length ? $('main').first() :
    $('article').first().length ? $('article').first() :
    $('.tabContent').first().length ? $('.tabContent').first() :
    $('#tc-main').first().length ? $('#tc-main').first() :
    $('.content').first().length ? $('.content').first() :
    $('body')
  );

  const nodes = main.find('h1, h2, h3, h4, p, li').toArray();
  const tokens: Token[] = [];
  for (const n of nodes) {
    const name = ((n as any).tagName?.toLowerCase?.() as string | undefined) || (($(n).prop('tagName') as string | undefined)?.toLowerCase());
    let text = cleanText($(n).text());
    if (!text) continue;
    if (name === 'li') text = `• ${text}`;
    const type: Token['type'] = (name && name.startsWith('h')) || isLikelyHeading(text) ? 'heading' : 'text';
    tokens.push({ type, text });
  }
  // Coalesce consecutive headings
  const merged: Token[] = [];
  for (const t of tokens) {
    if (merged.length && merged[merged.length - 1].type === 'heading' && t.type === 'heading') {
      merged[merged.length - 1].text += '\n' + t.text;
    } else {
      merged.push(t);
    }
  }
  return merged;
}

function sentenceSplit(paragraph: string): string[] {
  // Simple sentence boundary detection. Keeps abbreviations somewhat intact.
  const text = paragraph.replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const parts = text.split(/(?<=[\.!?])\s+(?=[A-ZÎÂĂȘȚA-Z])/u); // naive but decent
  if (parts.length <= 1) return [text];
  return parts;
}

function buildChunks(tokens: Token[], minSize = 800, maxSize = 1000): string[] {
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    const c = cleanText(current);
    if (c) chunks.push(c);
    current = '';
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading') {
      if (current.trim().length > 0) flush();
      current += (current ? '\n' : '') + t.text + '\n';
      continue;
    }
    const sentences = sentenceSplit(t.text);
    for (const s of sentences) {
      const tryAdd = current.length > 0 ? current + ' ' + s : s;
      if (tryAdd.length <= maxSize) {
        current = tryAdd;
      } else if (current.length >= minSize) {
        flush();
        current = s;
      } else if (s.length >= maxSize) {
        // Hard split long sentence
        let start = 0;
        while (start < s.length) {
          const end = Math.min(start + maxSize, s.length);
          const slice = s.slice(start, end);
          if (current.length + slice.length + 1 > maxSize && current.length >= minSize) {
            flush();
          }
          current += (current ? ' ' : '') + slice;
          start = end;
        }
      } else {
        // current too short but adding s would exceed max: flush and add
        if (current) flush();
        current = s;
      }
    }
  }
  if (current.trim()) flush();
  return chunks;
}

async function embed(text: string): Promise<number[]> {
  if (SEED_MOCK) {
    const dim = 1536;
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    const vec: number[] = new Array(dim);
    let x = h || 123456789;
    for (let i = 0; i < dim; i++) { x = (1103515245 * x + 12345) & 0x7fffffff; vec[i] = ((x / 0x7fffffff) * 2) - 1; }
    return vec;
  }
  try {
    const res = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
    return res.data[0].embedding as number[];
  } catch (e: any) {
    const msg = e?.message || '';
    if (e?.status === 429 && /quota/i.test(String(msg))) {
      throw new Error('OpenAI quota exceeded. Configure billing for your API key or use --no-embed to dry-run.');
    }
    throw e;
  }
}

function toPgVector(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

// Detect abrogated/expired acts based on EUR-Lex page markers
const NO_LONGER_IN_FORCE_MARKERS: RegExp[] = [
  /No\s+longer\s+in\s+force/i,
  /Ceased\s+to\s+be\s+in\s+force/i,
  /Nu\s+mai\s+este\s+în\s+vigoare/i,
  /Nu\s+mai\s+este\s+in\s+vigoare/i,
  /abrogare\s+implicită/i,
  /abrogat(ă)?/i,
  /End\s+of\s+validity/i,
];

function isNoLongerInForce(html: string): { matched: boolean; endOfValidity?: string } {
  const matched = NO_LONGER_IN_FORCE_MARKERS.some((re) => re.test(html));
  if (!matched) return { matched: false };
  const m = html.match(/Date of end of validity:\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i);
  return { matched: true, endOfValidity: m?.[1] };
}

async function upsertDocument(celex: string, chunks: string[]) {
  // Replace strategy: delete existing rows for celex/doc_id and insert fresh chunks
  // First compute embeddings to keep transaction short.
  const embeddings: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const emb = await embed(chunks[i]);
    embeddings.push(toPgVector(emb));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sql = `
      INSERT INTO documents (celex, doc_id, chunk_id, content, embedding)
      VALUES ($1, $2, $3, $4, $5::vector)
      ON CONFLICT (celex, chunk_id) DO UPDATE
      SET doc_id = EXCLUDED.doc_id,
          content = EXCLUDED.content,
          embedding = EXCLUDED.embedding
    `;
    for (let i = 0; i < chunks.length; i++) {
      await client.query(sql, [celex, celex, i, chunks[i], embeddings[i]]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function processItem(item: DiscItem, opts?: { noEmbed?: boolean }) {
  const t0 = Date.now();
  let html: string;
  if (SEED_MOCK) {
    const f = process.env.SEED_MOCK_HTML_FILE || path.join(process.cwd(), 'tests', 'fixtures', 'sample_eurlex.html');
    html = fs.readFileSync(f, 'utf-8');
  } else {
    let res = await fetchWithRetry(item.urlTxt, { method: 'GET', headers: { 'Accept': 'text/html', 'User-Agent': 'rag-eurlex-seeder/0.1' } }, 5, 800, 25000);
    if (!res.ok && String(item.urlTxt).includes('/RO/')) {
      const fallback = item.urlTxt.replace('/RO/', '/EN/');
      console.warn(`[Fetch] ${item.celex} RO not available (HTTP ${res.status}). Trying EN.`);
      res = await fetchWithRetry(fallback, { method: 'GET', headers: { 'Accept': 'text/html', 'User-Agent': 'rag-eurlex-seeder/0.1' } }, 5, 800, 25000);
    }
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Failed to fetch TXT for ${item.celex}. HTTP ${res.status}: ${txt.slice(0,200)}`);
    }
    html = await res.text();
  }
  const tFetch = Date.now();
  // Skip abrogated/expired acts
  const abro = isNoLongerInForce(html);
  if (abro.matched) {
    console.log(`[Skip] ${item.celex} is no longer in force (end: ${abro.endOfValidity || 'n/a'}). Skipping import.`);
    return {
      celex: item.celex,
      chunkCount: 0,
      avgChunkLen: 0,
      durations: { fetchMs: tFetch - t0, parseMs: 0, dbMs: 0, totalMs: tFetch - t0 }
    };
  }
  const tokens = extractMainTokens(html);
  const chunks = buildChunks(tokens, 800, 1000);
  const tParse = Date.now();
  if (!opts?.noEmbed) {
    await upsertDocument(item.celex, chunks);
  } else {
    console.log(`[Dry-run] ${item.celex}: parsed ${chunks.length} chunks. Skipping embed+DB.`);
  }
  const tDb = Date.now();
  return {
    celex: item.celex,
    chunkCount: chunks.length,
    avgChunkLen: chunks.length ? Math.round(chunks.reduce((a, b) => a + b.length, 0) / chunks.length) : 0,
    durations: {
      fetchMs: tFetch - t0,
      parseMs: tParse - tFetch,
      dbMs: tDb - tParse,
      totalMs: tDb - t0,
    }
  };
}

async function main() {
  const argv = process.argv.slice(2);
  // Minimal arg parsing: --limit, --pages, --since-year
  const limit = Math.max(1, Number((argv.find(a => a.startsWith('--limit='))?.split('=')[1]) ?? 10));
  const pages = Math.max(1, Number((argv.find(a => a.startsWith('--pages='))?.split('=')[1]) ?? 1));
  const sinceYearArg = argv.find(a => a.startsWith('--since-year='))?.split('=')[1];
  const sinceYear = sinceYearArg ? Number(sinceYearArg) : undefined;
  const noEmbed = argv.includes('--no-embed') || argv.includes('--discovery-only');

  const tStart = Date.now();
  const celexArg = argv.find(a => a.startsWith('--celex='))?.split('=')[1];
  let items: DiscItem[] = [];
  if (celexArg) {
    const celexes = celexArg.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`[Manual] CELEX override detected: ${celexes.join(', ')}`);
    items = celexes.map(celex => ({
      celex,
      title: celex,
      lang: 'ro',
      work: '',
      expression: '',
      issued: undefined,
      urlTxt: `https://eur-lex.europa.eu/legal-content/RO/TXT/?uri=CELEX:${celex}`
    }));
  } else {
    items = await runDiscovery(limit, pages, sinceYear);
  }
  const tDisc = Date.now();
  console.log(`Discovery found ${items.length} items in ${(tDisc - tStart) / 1000}s`);

  const reports: Array<{ celex: string; chunkCount: number; avgChunkLen: number; durations: { fetchMs: number; parseMs: number; dbMs: number; totalMs: number } }> = [];
  let totalChunks = 0;
  let sumChunkLen = 0;
  let sumFetch = 0, sumParse = 0, sumDb = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    console.log(`\n[${i + 1}/${items.length}] ${it.celex} — fetching and processing...`);
    try {
      const rep = await processItem(it, { noEmbed });
      reports.push(rep);
      totalChunks += rep.chunkCount;
      sumChunkLen += rep.avgChunkLen * Math.max(1, rep.chunkCount);
      sumFetch += rep.durations.fetchMs;
      sumParse += rep.durations.parseMs;
      sumDb += rep.durations.dbMs;
      console.log(`Processed ${it.celex}: ${rep.chunkCount} chunks (avg ${rep.avgChunkLen} chars). Took ${Math.round(rep.durations.totalMs)}ms`);
    } catch (e: any) {
      console.error(`Failed ${it.celex}:`, e?.message || e);
    }
  }

  const tEnd = Date.now();
  const avgChunkLen = totalChunks ? Math.round(sumChunkLen / totalChunks) : 0;

  // Summary logs
  console.log('\n--- Seed Summary ---');
  console.log(`Total docs: ${items.length}`);
  console.log(`Total chunks: ${totalChunks}`);
  console.log(`Avg chunk length: ${avgChunkLen} chars`);
  console.log(`Duration — discovery: ${((tDisc - tStart) / 1000).toFixed(2)}s, fetch+parse: ${((sumFetch + sumParse) / 1000).toFixed(2)}s, embed+db: ${(sumDb / 1000).toFixed(2)}s, overall: ${((tEnd - tStart) / 1000).toFixed(2)}s`);

  // Mini report: all CELEX with chunk counts
  const brief = reports.map(r => `${r.celex}: ${r.chunkCount} chunks`).join('; ');
  console.log(`Mini report: ${brief || 'no documents processed'}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
