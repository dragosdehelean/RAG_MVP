// EN: Probe a specific CELEX resource to reveal predicates and classes.
const ENDPOINT = 'https://publications.europa.eu/webapi/rdf/sparql';

async function run() {
  const celex = '32016R0679';
  const query = `DESCRIBE <http://publications.europa.eu/resource/celex/${celex}>`;
  const params = new URLSearchParams({ query });
  const url = `${ENDPOINT}?${params.toString()}`;
  const res = await fetch(url, { headers: { 'Accept': 'text/turtle' } });
  const text = await res.text();
  console.log('--- DESCRIBE celex ---');
  console.log(text.slice(0, 2000));
  const cellarMatch = text.match(/<http:\/\/publications\.europa\.eu\/resource\/cellar\/[^>]+>/);
  if (cellarMatch) {
    const cellar = cellarMatch[0].slice(1, -1);
    const q2 = `DESCRIBE <${cellar}>`;
    const u2 = `${ENDPOINT}?${new URLSearchParams({ query: q2 }).toString()}`;
    const r2 = await fetch(u2, { headers: { 'Accept': 'text/turtle' } });
    const t2 = await r2.text();
    console.log('\n--- DESCRIBE cellar ---');
    console.log(t2.slice(0, 4000));
    const q2b = `SELECT ?o WHERE { <${cellar}> <http://www.w3.org/2002/07/owl#sameAs> ?o } LIMIT 10`;
    const u2b = `${ENDPOINT}?${new URLSearchParams({ query: q2b }).toString()}`;
    const r2b = await fetch(u2b, { headers: { 'Accept': 'application/sparql-results+json' } });
    const j2b = await r2b.json();
    console.log('\n--- SELECT work owl:sameAs ---');
    console.log(JSON.stringify(j2b, null, 2));
    // Inspect work predicates for date-like properties
    const qDate = `SELECT ?p ?o WHERE { <${cellar}> ?p ?o FILTER(CONTAINS(LCASE(STR(?p)), "date")) } LIMIT 200`;
    const uDate = `${ENDPOINT}?${new URLSearchParams({ query: qDate }).toString()}`;
    const rDate = await fetch(uDate, { headers: { 'Accept': 'application/sparql-results+json' } });
    const jDate = await rDate.json();
    console.log('\n--- SELECT work date-like predicates ---');
    console.log(JSON.stringify(jDate, null, 2));
    const eliRow = j2b.results.bindings.find((b:any) => String(b.o.value).includes('/eli/'));
    if (eliRow) {
      const eli = eliRow.o.value;
      const qEli = `SELECT ?p ?o WHERE { <${eli}> ?p ?o } LIMIT 200`;
      const uEli = `${ENDPOINT}?${new URLSearchParams({ query: qEli }).toString()}`;
      const rEli = await fetch(uEli, { headers: { 'Accept': 'application/sparql-results+json' } });
      const jEli = await rEli.json();
      console.log('\n--- SELECT ELI predicates ---');
      console.log(JSON.stringify(jEli, null, 2).slice(0, 4000));
    }
    const exprMatch = t2.match(/<http:\/\/publications\.europa\.eu\/resource\/cellar\/[\w\-]+\.(\d{4})>/);
    if (exprMatch) {
      const expr = exprMatch[0].slice(1, -1);
      const q3 = `DESCRIBE <${expr}>`;
      const u3 = `${ENDPOINT}?${new URLSearchParams({ query: q3 }).toString()}`;
      const r3 = await fetch(u3, { headers: { 'Accept': 'text/turtle' } });
      const t3 = await r3.text();
      console.log('\n--- DESCRIBE expression ---');
      console.log(t3.slice(0, 4000));

      // Also list predicates on expression
      const q4 = `SELECT ?p ?o WHERE { <${expr}> ?p ?o } LIMIT 200`;
      const u4 = `${ENDPOINT}?${new URLSearchParams({ query: q4 }).toString()}`;
      const r4 = await fetch(u4, { headers: { 'Accept': 'application/sparql-results+json' } });
      const j4 = await r4.json();
      console.log('\n--- SELECT expression predicates ---');
      console.log(JSON.stringify(j4, null, 2).slice(0, 4000));
    }
  }
}

run().catch(e => { console.error(e); process.exit(1); });
