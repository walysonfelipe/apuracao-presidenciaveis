# Cobertura nacional implementada

## Escopo

O padrão é `COLLECTOR_UF=all`, `COLLECTOR_ROUND=all` e `COLLECTOR_OFFICES=all`. A descoberta usa EA11 para cargos/turnos/territórios e a configuração municipal de cada eleição para a correspondência TSE/IBGE. A aplicação não fixa códigos de eleição nem o número de municípios.

Presidente, Governador, Senador, deputados federais/estaduais/distritais, Conselheiro Distrital e cargos de eleições suplementares entram conforme forem anunciados para `ele2026`. Perguntas de consultas populares não são tratadas como candidaturas.

- Presidente tem um resultado nacional oficial e resultados por UF/município.
- Cargos estaduais têm abrangências regionais e municipais, sem inventar arquivo nacional.
- Deputado Estadual não é consultado no DF; Deputado Distrital é consultado no DF.
- Segundo turno respeita as UFs e os cargos explicitamente anunciados.
- Eleições municipais são restritas aos municípios participantes, inclusive quando há várias eleições na mesma UF.

## Fila e atualização

Uma única fila controla todos os cargos/UFs/turnos. Configurações e resultados compartilham o teto global; aumentar o número de cargos não multiplica esse limite. Lotes limitados e alternância entre contextos evitam que um estado grande impeça o restante de progredir.

| Configuração inicial | Valor |
| --- | --- |
| Consultas por segundo | 40, teto configurável até 50 |
| Requisições simultâneas | 8 |
| Lote global | 500 registros, além de atualizações regionais prioritárias |
| Brasil e UFs | Intervalo mínimo de 30 segundos |
| Municípios de Presidente | Intervalo mínimo de 5 minutos |
| Municípios dos demais cargos | Intervalo mínimo de 1 hora |
| Apurações completas | Intervalo mínimo de 10 minutos, sem reduzir o intervalo do cargo |

Esses são mínimos da agenda, não promessas de atraso máximo. Uma varredura inicial com cerca de 34 mil arquivos exige pelo menos cerca de 14 minutos a 40 consultas/s, antes de latência, falhas e atualizações prioritárias. O ciclo real deve ser medido. Estados e Brasil têm prioridade durante a carga municipal.

Uma falha isolada de validação/rede recebe espera por registro e não paralisa o país. Falhas consecutivas acionam pausa global. 403/429 interrompem imediatamente a coleta; 404 pausa o lote para evitar percorrer arquivos ausentes e recebe espera progressiva para o arquivo. A indisponibilidade de uma configuração municipal não impede preparar as demais eleições.

`collector:once` executa um lote e termina. `collector` continua percorrendo a fila, com progresso persistido. `coverage.configured` conta arquivos por cargo/turno/território, não municípios únicos; `preparationErrors` identifica eleições cuja configuração ainda não pôde ser carregada.

## Armazenamento e publicação

Resultados completos são comprimidos em gzip no SQLite; registros antigos em texto continuam legíveis. Publicação e API leem os dados por contexto, sem carregar o país inteiro na memória.

Resumos municipais de eleições estaduais/federais com mais de 20 candidaturas levam os dois líderes e informam `candidateCount`/`candidatesTruncated`. A lista integral continua acessível na API HTTP. Eleições municipais mantêm listas completas. A seleção de UF mostra a lista estadual completa.

O R2 recebe arquivos versionados, manifestos por cargo/UF e um catálogo único de todas as seleções publicadas. O resultado nacional de Presidente inclui os resumos das 27 UFs. A limpeza protege arquivos referenciados por qualquer manifesto atual do journal.

Senador e deputados também têm painéis agregados por UF. São identificados como agregações de consultas feitas em momentos diferentes. A aplicação não apresenta essa soma como arquivo nacional oficial. Cadeiras são as atribuídas pelo TSE, sem projeção de eleição no cliente.

Mesmo com compressão, o volume de todos os cargos pode ultrapassar os 500 MB do plano inicialmente discutido. É necessário medir o volume real e ajustar armazenamento, retenção e intervalos. O teste de cobertura não estima custo com arquivos reais.

## Frontend e API

O frontend continua consultando somente nossa API. Abas de cargos vêm do catálogo e são habilitadas por UF/turno. Eleições municipais têm seletor de cidade. Os painéis nacionais de parlamentares são publicados pelo backend, com cobertura explícita. O mapa principal e a corrida seguem Presidente.

Rotas e esquema estão em [API](api.md); implantação e cache em [Backend](../backend/README.md) e [R2](r2.md).

## Verificação

```sh
bun run test:collector
npm run test:frontend
npm run test:browser
```

A suíte nacional usa respostas locais para 5.568 municípios, 27 UFs, vários cargos e ambos os turnos: mais de 33 mil resultados em 167 contextos do cenário. Verifica cobertura integral, ritmo global, ausência de chamadas duplicadas ao resultado nacional, exceções do DF/segundo turno, configuração parcial, armazenamento comprimido, detalhes completos, R2 e painéis nacionais. Esses números pertencem ao cenário de teste; a configuração real determina a cobertura real.

Os testes de navegador bloqueiam acesso direto ao TSE e verificam mapa, corrida, resultados estaduais, cargos municipais e painéis nacionais. Não foi executada uma coleta nacional real nem um deploy remoto nesta ampliação.

Referências: [configuração oficial de eleições](https://resultados.tse.jus.br/oficial/comum/config/ele-c.json) e [informações técnicas do TSE](https://www.tse.jus.br/eleicoes/informacoes-tecnicas-sobre-a-divulgacao-de-resultados).
