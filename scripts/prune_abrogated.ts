import 'dotenv/config';
import dotenv from 'dotenv';
try { dotenv.config({ path: '.env.local', override: true }); } catch {}
import { Pool } from 'pg';

// Simple EUR-Lex status detector: fetches the HTML page and checks for markers.
// If a document is "No longer in force" (EN) / similar markers, it will be removed.

const EURLEX_LANG = process.env.EURLEX_LANG || 'EN';
const BASE_URL = `https://eur-lex.europa.eu/legal-content/${EURLEX_LANG}/TXT/?uri=CELEX:`;

const MARKERS = [
  /No\s+longer\s+in\s+force/i,
  /Ceased\s+to\s+be\s+in\s+force/i,
  /Nu\s+mai\s+este\s+în\s+vigoare/i,
  /Nu\s+mai\s+este\s+in\s+vigoare/i,
  /abrogare\s+implicită/i,
  /abrogat(ă)?/i,
];

type Options = { dryRun: boolean; limit?: number };

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' as any });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function isNoLongerInForce(html: string): { matched: boolean; endOfValidity?: string } {
  const matched = MARKERS.some((re) => re.test(html));
  if (!matched) return { matched: false };
  const m = html.match(/Date of end of validity:\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i);
  return { matched: true, endOfValidity: m?.[1] };
}

async function listCelex(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ celex: string }>('SELECT DISTINCT celex FROM documents ORDER BY celex');
  return rows.map((r) => r.celex);
}

async function prune(pool: Pool, opts: Options) {
  const celexes = await listCelex(pool);
  const toScan = typeof opts.limit === 'number' ? celexes.slice(0, opts.limit) : celexes;
  let removed = 0;
  let flagged: Array<{ celex: string; end?: string }> = [];

  for (const celex of toScan) {
    const url = BASE_URL + encodeURIComponent(celex);
    try {
      const html = await fetchText(url);
      const { matched, endOfValidity } = isNoLongerInForce(html);
      if (matched) {
        flagged.push({ celex, end: endOfValidity });
        if (!opts.dryRun) {
          await pool.query('DELETE FROM documents WHERE celex = $1', [celex]);
          removed++;
          console.log(`Removed ${celex} (end of validity: ${endOfValidity || 'n/a'})`);
        } else {
          console.log(`Would remove ${celex} (end of validity: ${endOfValidity || 'n/a'})`);
        }
      }
    } catch (e: any) {
      console.warn(`Skip ${celex}: ${e?.message || e}`);
    }
  }

  console.log('\n--- Prune Summary ---');
  console.log(`Checked: ${toScan.length} documents`);
  console.log(`Flagged (no longer in force): ${flagged.length}`);
  if (!opts.dryRun) console.log(`Removed from DB: ${removed}`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await prune(pool, { dryRun, limit });
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

