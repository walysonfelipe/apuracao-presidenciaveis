import Script from 'next/script';
import './globals.css';

const GA_ID = 'G-7GBY1B664L';

export const metadata = {
  metadataBase: new URL('https://apuracao.walysonassis.online'),
  title: 'Mapa do Brasil — Corrida da Apuração',
  description: 'Acompanhe a apuração presidencial por estado e município no mapa interativo da Corrida da Apuração.',
  icons: { icon: '/favicon.ico', apple: '/apple-touch-icon.png' },
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    url: '/',
    title: 'Apuração presidencial — Presidenciáveis',
    description: 'Acompanhe a apuração presidencial do Brasil, dos estados e dos municípios.',
    images: [{
      url: '/og-presidenciais.jpg?v=3',
      width: 1200,
      height: 630,
      alt: 'Apuração presidencial — Brasil, estados e municípios',
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Apuração presidencial — Presidenciáveis',
    description: 'Acompanhe a apuração presidencial do Brasil, dos estados e dos municípios.',
    images: ['/og-presidenciais.jpg?v=3'],
  },
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
      <body>
        {children}
        {/* Google tag (gtag.js) */}
        <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
        <Script id="google-analytics" strategy="afterInteractive">
          {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_ID}');`}
        </Script>
      </body>
    </html>
  );
}
