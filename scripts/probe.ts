// EN: Small helper to probe the SPARQL endpoint with ad-hoc queries.
const ENDPOINT = 'https://publications.europa.eu/webapi/rdf/sparql';

async function run(query: string) {
  const params = new URLSearchParams({ query });
  const url = `${ENDPOINT}?${params.toString()}`;
  const res = await fetch(url, { headers: { Accept: 'application/sparql-results+json' } });
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
}

// Try to find any predicate whose IRI contains 'celex'
const q = `
SELECT DISTINCT ?p WHERE {
  ?s ?p ?o .
  FILTER(CONTAINS(LCASE(STR(?p)), "celex"))
} LIMIT 50`;

run(q).catch(e => { console.error(e); process.exit(1); });
