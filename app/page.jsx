import ElectionMap from '../components/election-map.jsx';

export default function Home() {
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Corrida da Apuração, início"><img src="/logo.webp" alt="Corrida da Apuração" /></a>
      </header>
      <main>
        <ElectionMap />
      </main>
    </>
  );
}
