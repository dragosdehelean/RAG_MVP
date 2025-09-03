import assert from 'node:assert';
import { cosineScoreFromDistance, formatCitation, buildContext } from '../lib/rag';

// Cosine score should be 1 - distance
assert.strictEqual(cosineScoreFromDistance(0), 1);
assert.strictEqual(cosineScoreFromDistance(0.2), 0.8);

// Citation format
assert.strictEqual(formatCitation('32016R0679', 3), '#32016R0679:3');

// Context building should include bracketed citations
const ctx = buildContext([
  { celex: '32016R0679', doc_id: '32016R0679', chunk_id: 1, content: 'Lorem ipsum', score: 0.9 },
  { celex: '32016R0679', doc_id: '32016R0679', chunk_id: 2, content: 'Dolor sit amet', score: 0.8 },
]);
assert.ok(ctx.includes('[#32016R0679:1]'));
assert.ok(ctx.includes('[#32016R0679:2]'));
assert.ok(ctx.includes('Lorem ipsum'));
assert.ok(ctx.includes('Dolor sit amet'));

console.log('rag tests passed');

