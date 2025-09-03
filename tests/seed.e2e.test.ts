import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { query as dbQuery } from '../lib/db';

async function runSeed(args: string[], env: Record<string,string | undefined>) {
  const node = process.execPath; // Node binary
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'seed.ts');
  return new Promise<void>((resolve, reject) => {
    const child = spawn(node, [tsxCli, script, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      const msg = `seed exited with code ${code}\nSTDOUT:\n${out}\nSTDERR:\n${err}`;
      reject(new Error(msg));
    });
  });
}

async function main() {
  const celex = '32019R1234';
  const htmlFile = path.join(process.cwd(), 'tests', 'fixtures', 'sample_eurlex.html');

  try {
    await runSeed([
      '--lang=ro', '--since-year=2019', '--limit=1', '--pages=1'
    ], {
      SEED_MOCK: '1',
      SEED_MOCK_CELEX: celex,
      SEED_MOCK_LANG: 'ro',
      SEED_MOCK_HTML_FILE: htmlFile,
      OPENAI_API_KEY: 'test-key'
    });

    // Verify rows inserted
    const { rows } = await dbQuery<any>('SELECT celex, doc_id, chunk_id, content FROM documents WHERE celex = $1 ORDER BY chunk_id ASC', [celex]);
    assert.ok(rows.length > 0, 'No chunks inserted');
    assert.strictEqual(rows[0].celex, celex);
    assert.strictEqual(rows[0].doc_id, celex);
    assert.strictEqual(rows[0].chunk_id, 0);
    assert.ok((rows[0].content || '').length > 0, 'Empty content');
    // Check some parsed text survived
    const allContent = rows.map((r: any) => r.content).join('\n');
    assert.ok(/Articolul\s+1/i.test(allContent) || /Capitolul/i.test(allContent), 'Expected headings not found');

    console.log('seed e2e test passed: inserted', rows.length, 'chunks for', celex);
  } finally {
    // Cleanup inserted rows after test
    await dbQuery('DELETE FROM documents WHERE celex = $1', [celex]);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
