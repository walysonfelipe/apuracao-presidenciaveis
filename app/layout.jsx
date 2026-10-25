import './globals.css';

export const metadata = {
  title: 'Mapa do Brasil — Corrida da Apuração',
  description: 'Acompanhe a apuração presidencial por estado e município no mapa interativo da Corrida da Apuração.',
  icons: { icon: '/favicon.ico', apple: '/apple-touch-icon.png' },
  openGraph: { images: '/og-image.jpg' },
};

export const viewport = { themeColor: '#04132e' };

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="preload" href="/data/mapa/brasil.json.gz" as="fetch" crossOrigin="anonymous" fetchPriority="high" />
        {/* Results of the default view (Brasil, latest round) download in parallel with the scripts. */}
        <link rel="preload" href="/api/resultados/2/br" as="fetch" crossOrigin="anonymous" fetchPriority="high" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Manrope:wght@400;500;600;700;800&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
