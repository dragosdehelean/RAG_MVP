import { NextResponse } from 'next/server';
import { z } from 'zod';
import { answer } from '@/lib/rag';

const BodySchema = z.object({
  query: z.string().min(1).optional(),
  question: z.string().min(1).optional(),
  k: z.number().int().positive().max(50).optional()
}).refine((d) => typeof d.query === 'string' || typeof d.question === 'string', {
  message: 'Provide "query" or "question"',
  path: ['query']
});

export async function POST(req: Request) {
  try {
    const json = await req.json().catch(() => ({}));
    const parse = BodySchema.safeParse(json);
    if (!parse.success) {
      return NextResponse.json({ error: 'Invalid request', details: parse.error.issues }, { status: 400 });
    }
    const q = parse.data.query ?? parse.data.question!;
    const result = await answer(q);
    return NextResponse.json(result, { status: 200 });
  } catch (e: any) {
    const msg = e?.message || 'Unexpected error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
