"use client";
import { useState, useRef } from 'react';

type QA = { q: string; a?: string; sources?: string[]; sourceEntries?: { citation: string; score: number }[]; error?: string };

export default function HomePage() {
  const [items, setItems] = useState<QA[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function send() {
    const question = input.trim();
    if (!question || pending) return;
    setPending(true);
    setItems(prev => [...prev, { q: question }]);
    setInput('');
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question })
      });
      const data = await res.json();
      setItems(prev => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (res.ok) {
          last.a = data.text || '';
          last.sources = Array.isArray(data.sources) ? data.sources : [];
          if (Array.isArray(data.sourceEntries)) last.sourceEntries = data.sourceEntries;
        } else {
          last.error = data?.error || 'Eroare de server';
        }
        return copy;
      });
    } catch (e: any) {
      setItems(prev => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        last.error = e?.message || 'Network error';
        return copy;
      });
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <div style={styles.headerRow}>
          <h1 style={styles.title}>RAG EUR‑Lex</h1>
          <button onClick={() => setItems([])} disabled={pending || items.length === 0} style={styles.secondaryBtn}>Șterge conversația</button>
        </div>
        <div style={styles.chat}>
          {items.length === 0 && (
            <div style={styles.hint}>Pune o întrebare despre un act UE.</div>
          )}
          {items.map((it, idx) => (
            <div key={idx} style={styles.qaBlock}>
              <div style={{ ...styles.bubble, ...styles.user }}>Q: {it.q}</div>
              {it.error && (
                <div style={{ ...styles.bubble, ...styles.error }}>Eroare: {it.error}</div>
              )}
              {it.a && (
                <div style={{ ...styles.bubble, ...styles.assistant }}>
                  <div>A: {it.a}</div>
                  {!!(it.sourceEntries && it.sourceEntries.length) && (
                    <div style={styles.sources}>
                      <div style={{ marginBottom: 4 }}>Surse:</div>
                      {it.sourceEntries.map((s, i) => {
                        const cit = s.citation || '';
                        const body = cit.startsWith('#') ? cit.slice(1) : cit;
                        const parts = body.split(':');
                        const celex = parts[0] || '';
                        const href = `https://eur-lex.europa.eu/legal-content/RO/TXT/?uri=CELEX:${celex}`;
                        return (
                          <div key={i} style={{ marginBottom: 2 }}>
                            <a href={href} target="_blank" rel="noreferrer" style={styles.link}>
                              {s.citation}
                            </a>
                            <span style={{ opacity: 0.8 }}> ({s.score.toFixed(2)})</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <div style={styles.inputRow}>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Întrebare…"
            style={styles.input}
            disabled={pending}
          />
          <button onClick={send} disabled={pending || !input.trim()} style={styles.button}>
            {pending ? 'Se trimite…' : 'Trimite'}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#0b1220', color: '#e6edf3', padding: '24px' },
  container: { maxWidth: 820, margin: '0 auto' },
  title: { margin: '8px 0 16px 0', fontSize: 22, fontWeight: 600 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  chat: { display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 },
  hint: { opacity: 0.7, fontSize: 14 },
  qaBlock: { display: 'flex', flexDirection: 'column', gap: 8 },
  bubble: { padding: '10px 12px', borderRadius: 8, lineHeight: 1.45, whiteSpace: 'pre-wrap' },
  user: { background: '#14213d' },
  assistant: { background: '#132f1c' },
  error: { background: '#3a0d0d' },
  sources: { marginTop: 8, opacity: 0.8, fontSize: 13 },
  link: { color: '#9fd0ff', textDecoration: 'underline' },
  inputRow: { display: 'flex', gap: 8 },
  input: { flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid #2b3956', outline: 'none', background: '#0f172a', color: '#e6edf3' },
  button: { padding: '10px 14px', borderRadius: 8, border: '1px solid #345', background: '#17324d', color: '#fff', cursor: 'pointer', opacity: 1 },
  secondaryBtn: { padding: '8px 10px', borderRadius: 8, border: '1px solid #2b3956', background: '#0f172a', color: '#e6edf3', cursor: 'pointer', fontSize: 13 }
};
