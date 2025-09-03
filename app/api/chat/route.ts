// EN: Chat API route — embeds query, retrieves top-k by vector search, and asks the LLM.
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { generateAnswer } from '@/lib/rag';

const BodySchema = z.object({
  message: z.string().min(1),
  k: z.number().int().min(1).max(20).optional()
});

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const { message, k } = BodySchema.parse(json);
    const { answer, sources } = await generateAnswer(message, k ?? 10);
    return new Response(JSON.stringify({ answer, sources }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    const msg = err?.message ?? 'Unknown error';
    return new Response(JSON.stringify({ error: msg }), { status: 400 });
  }
}

