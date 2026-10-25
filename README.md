# Corrida da Apuração

Mapa interativo da apuração presidencial por estado e município. Um único app Next.js serve a página e a API que consulta o TSE, com cache em memória e, opcionalmente, no Cloudflare R2.

## Organização

```text
app/page.jsx                            Página única: mapa do Brasil, estados e municípios
app/api/resultados/[turno]/[uf]/route.js  API de resultados (br ou sigla da UF)
components/election-map.jsx             Mapa interativo (cliente)
lib/tse.mjs                             Leitura e validação dos arquivos oficiais do TSE
lib/results.mjs                         Cache por pedaço, fila e limite de consultas
lib/storage.mjs                         Persistência opcional dos pedaços no R2
lib/workers.mjs                         Mini workers que atualizam todos os estados em segundo plano
instrumentation.js                      Inicia os workers junto com o servidor
public/data/mapa/                       Malhas do IBGE por UF (ver docs/malhas.md)
test/                                   Testes com respostas locais
```

## Rodar

Com Node.js 22.13 ou superior:

```sh
npm install
npm run dev        # http://localhost:3000
```

Produção:

```sh
npm run build
npm start
```

Ao abrir o mapa, o servidor consulta o TSE de verdade. As variáveis opcionais estão em [.env.example](.env.example); copie para `.env.local` para alterar limites ou ativar o R2. Credenciais ficam apenas no servidor.

## Como os dados chegam ao mapa

O navegador nunca consulta o TSE. Ele pede à API apenas o pedaço aberto:

- `GET /api/resultados/2/br` — Brasil e as 27 UFs.
- `GET /api/resultados/2/sp` — a UF e todos os seus municípios.

Cada pedaço (turno + UF) é atualizado sob demanda:

1. A resposta sai na hora com o que já está em memória; se o processo acabou de iniciar, o pedaço é lido do R2.
2. Se algum item estiver vencido, uma única atualização começa em segundo plano, compartilhada por todos os visitantes. Só os itens vencidos são consultados: Brasil e UFs a cada 30 s, municípios a cada 3 min e apuração completa a cada 10 min.
3. Os resultados entram no pedaço conforme chegam e são gravados no R2 a cada 10 s e ao final. Outra instância ou um reinício reaproveita esse pedaço em vez de consultar o TSE de novo.
4. O mapa repete a consulta a cada 10 s (3 s enquanto o servidor ainda preenche o pedaço) e pausa em abas ocultas.

## Cache para todos os visitantes

| Camada | O que guarda | Efeito |
|---|---|---|
| Servidor | Resposta de cada pedaço já montada e comprimida em gzip, uma vez por versão (no máximo 1 remontagem/s por pedaço) | Cada visita só envia bytes prontos; nada é recalculado por visitante |
| ETag | Versão do pedaço | Consulta sem mudança volta como `304`, sem corpo |
| CDN | `s-maxage=5, stale-while-revalidate=30` | Milhares de visitantes no mesmo estado viram 1 requisição ao servidor a cada 5 s |
| Navegador | Pedaços já abertos e requisições em andamento | Voltar a um estado é instantâneo; passar o mouse num estado já baixa malha e votos |

O formato é enxuto: nome, partido, número e cor de cada candidato vão uma vez por resposta, e cada cidade leva só ids, votos e percentuais. A malha e os votos do Brasil são pré-carregados pelo HTML, em paralelo com os scripts.

Medido localmente, com o 2º turno ainda zerado: MG completo (853 cidades) com 8,5 KB em gzip (309 KB sem compressão) e Brasil com 741 B; 3.000 requisições com 50 simultâneas, sem falhas, p95 de 154 ms. Com votos reais as respostas ficam maiores.

Para o cache compartilhado valer, coloque uma CDN na frente. Com Cloudflare (Tunnel ou proxy), crie uma Cache Rule para `/api/resultados/*` e `/api/fotos/*` com "Eligible for cache" e "Use cache-control header if present". Sem essa regra, a Cloudflare não guarda JSON e todas as consultas chegam ao servidor.

Fotos das candidaturas saem de `GET /api/fotos/<turno>/<id>`: o servidor baixa cada foto do TSE uma vez, guarda em memória e no R2 e só aceita candidaturas que já apareceram num resumo carregado, para que ninguém use a rota para sondar o TSE. Sem foto, a legenda mostra a inicial.

## Mini workers em segundo plano

Com `npm start` (produção), 4 mini workers começam junto com o servidor e mantêm aquecidos todos os pedaços do turno mais recente: Brasil, as 27 UFs e as 5.570 cidades. Assim, quem abre qualquer estado já encontra os dados prontos.

- Cada worker pega uma **fatia** de 40 itens vencidos de um pedaço, consulta, grava e volta para a fila.
- Ordem: Brasil primeiro; depois estados abertos por alguém nos últimos 5 minutos; depois rodízio, com o pedaço atendido há mais tempo indo antes. Nenhum estado grande trava os outros.
- Todos dividem o mesmo limite de consultas ao TSE e as mesmas pausas por bloqueio. Uma visita e um worker nunca atualizam o mesmo pedaço ao mesmo tempo.
- Com 40 consultas/s, uma varredura completa leva cerca de 2min45s (medido: 28/28 abrangências e 2.563 cidades em 75 s). Cidades são relidas a cada 3 min, Brasil e UFs a cada 30 s.
- Os pedaços alterados vão para o R2 no máximo a cada 10 s, e uma última vez ao encerrar o processo.

Os workers precisam de um processo contínuo (`next start` na máquina, container ou VM). Em hospedagem serverless eles não ficam vivos; ali vale só a atualização sob demanda. Rode workers em **uma única instância** e desligue nas demais com `BACKGROUND_WORKERS=false`. Em `npm run dev` ficam desligados, a menos que `BACKGROUND_WORKERS=true`.

Sem workers, os pedaços continuam sendo atualizados sob demanda, e só existem para estados que alguém abriu. As configurações do TSE (eleição e correspondência IBGE/TSE dos municípios) também ficam em cache, a segunda também no R2.

Proteções da fonte: todas as consultas passam por um limite global (`TSE_RPS`, padrão 40/s) com concorrência limitada. HTTP 403/429 pausa todas as consultas por pelo menos 10 minutos. Três falhas seguidas interrompem a varredura do pedaço por 1 minuto. Falhas nunca viram zero votos: o último resultado válido é mantido e o mapa avisa quando está desatualizado.

O limite vale por processo. Com várias instâncias, o R2 evita a maior parte das consultas repetidas, mas não coordena os limites entre elas; prefira uma instância durante a apuração.

## Verificações

```sh
npm test
npm run build
```

Os testes usam respostas locais e não consultam o TSE.

## Documentação

- [Dados geográficos](docs/malhas.md)
- [Ideia original](docs/IDEIA.md)
