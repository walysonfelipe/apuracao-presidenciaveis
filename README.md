# Corrida da Apuração

Mapa interativo e corrida visual para acompanhar a apuração presidencial. O projeto está separado entre site e serviço de dados.

## Organização

```text
frontend/             HTML, CSS, JavaScript, imagens e malhas do site
backend/              Coletor Bun, SQLite, publicador R2 e dependências
  .env.example        Exemplo de variáveis do servidor
  Dockerfile          Imagem Bun do backend
  render.yaml         Deploy independente no Render
  package.json        Dependências e comandos do backend
test/
  frontend/           Testes do mapa e do navegador
  backend/            Testes do coletor e da publicação
docs/                 Arquitetura, operação do R2 e conceito do jogo
dist/frontend/        Site gerado para servir/publicar; ignorado pelo Git
package.json          Atalhos para executar as tarefas pela raiz
vercel.json           Build e diretório público do site na hospedagem atual
```

## Rodar o frontend

Na raiz do repositório, com Node.js e Python 3:

```sh
npm run dev:frontend
```

Abra [localhost:8000](http://localhost:8000). O comando copia os arquivos públicos do frontend para `dist/frontend/` e serve essa pasta. Execute novamente após editar os arquivos; não há recarregamento automático.

Para gerar apenas o site:

```sh
npm run build:frontend
```

Na Cloudflare, use esse comando de build, a raiz do repositório como diretório de trabalho e `dist/frontend` como saída pública. A configuração da hospedagem atual na Vercel também aponta para essa saída. Nenhum deploy remoto foi executado nesta reorganização.

As páginas continuam sendo `/`, `/corrida.html` e `/estados.html` após publicar. Veja os recursos e detalhes do mapa no [README do frontend](frontend/README.md).

## Rodar o backend

Na raiz, com Bun 1.2.23 ou superior:

```sh
cp backend/.env.example backend/.env
bun run install:backend
bun run collector
```

Revise `backend/.env` antes de iniciar: o coletor consulta o TSE de verdade. O padrão é coletar todas as UFs, todos os turnos e os cargos anunciados para o ciclo ele2026. `R2_ENABLED=false` mantém uploads desabilitados.

Para uma única rodada, use `bun run collector:once`. Os atalhos executam dentro de `backend/`, onde ficam as variáveis, dependências e o banco local em `.collector/`.

No Render, crie um **Web Service com Docker**, configure **Root Directory: `backend`** e anexe um disco persistente em `/data`. O passo a passo e a opção de Blueprint estão no [guia do Render](docs/render.md). O [Dockerfile](backend/Dockerfile) usa somente essa pasta. O frontend é publicado separadamente na Cloudflare/Vercel. Consulte a [operação do backend](backend/README.md) e a [configuração do R2](docs/r2.md).

## Verificações

```sh
npm run test:frontend
bun run test:collector
```

Para os testes de navegador, instale Google Chrome e use Node.js 22 ou superior:

```sh
npm run test:browser
```

Os testes usam respostas locais; os modos de consulta real estão documentados separadamente no [frontend](frontend/README.md). As dependências do backend são instaladas pelo comando `install:backend`.

## Estado da integração

O frontend consulta somente a nossa API. O backend é responsável por consultar o TSE, interpretar os arquivos, calcular os dados e servir ou publicar os resumos. Localmente, a API do Bun roda em `http://localhost:3000`; em produção, o domínio de dados configurado é `https://eleicoes.agendasalao.com`, com publicação opcional no R2 e cache na CDN. A implantação remota e a validação do bucket real ainda estão pendentes.

A cobertura é nacional: Brasil, 27 UFs e os municípios anunciados pelo TSE, com os cargos e turnos efetivamente em disputa. Governador, Senador, deputados, Conselheiro Distrital e cargos de eleições suplementares são descobertos pela configuração oficial. O frontend oferece as seleções anunciadas, os resultados municipais e os painéis nacionais de parlamentares. A geometria continua independente da coleta. Fotos usam iniciais até existir cache de imagens no servidor.

A operação, os intervalos e a validação com 5.568 municípios simulados estão em [Cobertura nacional](docs/cobertura-nacional.md).

Resultados oficiais, simulações e demonstrações devem permanecer identificados. Nunca publicar credenciais do servidor junto aos arquivos estáticos.

## Documentação

- [Frontend e uso do mapa](frontend/README.md)
- [Backend e execução local](backend/README.md)
- [Deploy no Render](docs/render.md)
- [Contrato da API e configuração do frontend](docs/api.md)
- [Arquitetura de coleta e cache](docs/arquitetura-dados.md)
- [Publicação no R2, domínio, CORS e cache](docs/r2.md)
- [Conceito e funcionamento da corrida](docs/game.md)
- [Ideia original](docs/IDEIA.md)
- [Dados geográficos](frontend/data/mapa/README.md)
