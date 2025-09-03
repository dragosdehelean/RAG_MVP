// EN: Root layout for the Next.js App Router.
import type { ReactNode } from 'react';

export const metadata = {
  title: 'RAG EUR-Lex',
  description: 'MVP chat grounded on EUR-Lex content'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ro">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: 20 }}>
        {children}
      </body>
    </html>
  );
}

