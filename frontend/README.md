# Frontend

Esta pasta contém somente o site: HTML, CSS, JavaScript de apresentação, imagens e malhas geográficas. A interpretação dos arquivos TSE e as regras eleitorais pertencem ao [backend](../backend/README.md).

## Executar

Na raiz do repositório, com Node.js e Python 3:

```sh
npm run dev:frontend
```

Abra [localhost:8000](http://localhost:8000). O comando copia os arquivos públicos para `dist/frontend/` e serve essa pasta. Execute novamente depois de editar os arquivos. Para gerar apenas os arquivos, use `npm run build:frontend`.

## API e cobertura

O frontend consulta somente a nossa API. Em desenvolvimento, o endereço padrão é `http://localhost:3000`; em produção, `https://eleicoes.agendasalao.com`. Configuração, rotas, cache e campos estão no [contrato da API](../docs/api.md).

O coletor descobre todas as UFs, municípios, cargos e turnos em disputa. As abas de cargos são habilitadas conforme o catálogo da API, respeitando as exceções do DF e as UFs com segundo turno. Cargos municipais têm seletor de cidade; Senador e deputados também têm painéis nacionais identificados como agregados por UF. A geometria das 27 UFs continua independente dos resultados.

## Arquivos

- [index.html](index.html), [mapa.js](mapa.js), [mapa.css](mapa.css): navegação e mapa.
- [api-config.js](api-config.js): endereço público da API, sem segredos.
- [api-client.js](api-client.js): catálogo, manifestos e resumos normalizados.
- [results-loader.js](results-loader.js): atualização, pausa, cancelamento e última leitura.
- [mapa-resultados.js](mapa-resultados.js): aplicação de cores e detalhes recebidos da API.
- [corrida.html](corrida.html), [game.js](game.js), [style.css](style.css): corrida e simulação local identificada.
- [estados.html](estados.html), [estados.js](estados.js), [estados.css](estados.css): apresentação dos resultados.
- [data/mapa/](data/mapa/): geometria e códigos IBGE; veja [a documentação dos dados](data/mapa/README.md).
- [build.mjs](build.mjs): cópia de assets públicos para o deploy.

## Navegação e resultados

Clique em uma UF para abrir sua malha municipal. Selecione uma cidade no mapa ou busque por nome/código IBGE. O endereço preserva UF, município e turno. Arraste e use os controles de zoom para explorar a malha.

As cores, votos, percentuais e situações das candidaturas chegam preparados pelo servidor. Falhas mantêm a última leitura identificada. Sem resultado, o território permanece neutro. Fotos usam iniciais até existir cache de imagens no servidor.

O mapa consulta os resumos a cada dez segundos e pausa em abas ocultas. Uma cidade selecionada reutiliza o resumo estadual, sem consulta individual à fonte eleitoral.

## Verificar

Na raiz:

```sh
npm run test:frontend
npm run test:browser
```

O segundo comando exige Node.js 22 ou superior e Google Chrome; `CHROME_BIN` permite informar outro caminho. Ele gera o site, verifica as 27 malhas e exercita as três páginas com respostas locais da API e acesso direto ao TSE bloqueado.

Para medir o carregamento das malhas após gerar o site: `node test/frontend/map-loading.mjs --benchmark`. Esse modo usa rede/CPU simuladas e não mede a coleta eleitoral.
