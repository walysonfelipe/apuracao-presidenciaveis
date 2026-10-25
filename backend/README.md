# Coletor eleitoral em Bun

O coletor do [plano de arquitetura](../docs/arquitetura-dados.md) coleta os cargos em disputa no ambiente oficial para Brasil, as 27 UFs e os municípios anunciados para cada eleição/turno. O ciclo inicial é `ele2026`. A publicação no R2 é opcional e está implementada; o frontend já consome os resumos da API, e a implantação remota ainda está pendente.

## Executar localmente

Requer Bun 1.2.23 ou superior. Na raiz do repositório:

```sh
cp backend/.env.example backend/.env
bun run install:backend
bun run collector:once
```

Revise `backend/.env` antes da execução. O exemplo habilita cobertura nacional, todos os cargos e turnos anunciados, com teto global de 40 consultas por segundo e oito simultâneas. Filtros são opcionais para ensaios, não limites fixos da aplicação. Executar o comando acima consulta o TSE de verdade; a quantidade depende da configuração municipal. Não rodar repetidamente para contornar uma pausa registrada.

`collector:once` processa um lote de até `COLLECTOR_BATCH_SIZE` abrangências vencidas, além das atualizações regionais prioritárias, e termina. A execução contínua percorre todos os lotes até completar a cobertura; uma única execução não equivale à coleta integral do país. Não espera uma nova rodada nem o fim de um bloqueio. Código de saída 1 indica falha ou pausa da fonte, além de erros fatais. Sem dados publicados, um 404 é um estado esperado e não produz votos fictícios.

Para manter a coleta ativa:

```sh
bun run collector
```

O processo busca configurações oficiais, guarda estado em `backend/.collector/results.sqlite` quando iniciado pelos comandos da raiz e repete a checagem da agenda. SIGINT/SIGTERM interrompem as consultas e fecham o banco. Logs são JSON, com cobertura e indicação de falha; não incluem credenciais.

Por padrão, `R2_ENABLED=false`. Para habilitar uploads e configurar `https://eleicoes.agendasalao.com`, consulte a [operação do R2](../docs/r2.md). Com R2 habilitado, coleta e publicação rodam independentemente no mesmo processo.

## Configuração

As variáveis e valores iniciais estão em [`.env.example`](.env.example). O código rejeita UF, turno e limites inválidos.

| Variável | Finalidade |
| --- | --- |
| `COLLECTOR_UF` | `all` por padrão; aceita uma UF para ensaios |
| `COLLECTOR_ROUND` | `all` por padrão; aceita `1` ou `2` |
| `COLLECTOR_OFFICES` | `all` por padrão; aceita códigos separados por vírgula |
| `COLLECTOR_BATCH_SIZE` | Lote global, padrão 500 registros |
| `COLLECTOR_DB` | Caminho persistente do SQLite |
| `COLLECTOR_RPS` | Consultas espaçadas por segundo, entre 1 e 50 |
| `COLLECTOR_CONCURRENCY` | Respostas simultâneas, entre 1 e 16 |
| `COLLECTOR_TIMEOUT_MS` | Timeout incluindo leitura do corpo |
| `COLLECTOR_MAX_BYTES` | Limite por resposta, inclusive sem Content-Length |
| `COLLECTOR_REGIONAL_INTERVAL_MS` | Intervalo de Brasil e UF |
| `COLLECTOR_MUNICIPAL_INTERVAL_MS` | Intervalo municipal de Presidente |
| `COLLECTOR_OTHER_MUNICIPAL_INTERVAL_MS` | Intervalo municipal dos demais cargos |
| `COLLECTOR_COMPLETE_INTERVAL_MS` | Intervalo mínimo adicional para apuração completa |
| `COLLECTOR_CONFIG_INTERVAL_MS` | Revalidação da configuração |
| `PORT` | Porta do diagnóstico; fornecida pelo Render |

Os intervalos contam a partir da consulta concluída. São mínimos de agenda, não garantia de atraso máximo. Brasil e UF podem ser revisitados durante a varredura, mas sua prioridade é limitada para garantir progresso municipal.

## Dados persistidos e contrato inicial

O SQLite mantém listas completas comprimidas com gzip, incluindo leitura de registros antigos em texto. Resumos municipais de listas com mais de 20 candidaturas levam dois líderes e informam `candidateCount`/`candidatesTruncated`; a lista integral permanece na API HTTP. Consulte [Cobertura nacional](../docs/cobertura-nacional.md).

O banco mantém:

- Contexto `ambiente:ciclo:eleição:turno:cargo:uf`, separado entre eleições e turnos.
- Abrangência com tipo, UF e códigos TSE/IBGE municipais quando aplicáveis.
- Último resumo válido, hash de conteúdo, última consulta bem-sucedida e última tentativa.
- Próxima consulta, quantidade de falhas e erro conhecido.
- Configuração descoberta, bloqueio global e horário do último início de consulta.

O resumo é produzido pelos adaptadores exclusivos do backend: candidaturas e votos, percentuais sobre a soma dos votos válidos das candidaturas aceitas pelo adaptador, liderança/empate, vantagem, seções totalizadas, geração informada pelo TSE e situação de conclusão. Votos devem ser inteiros seguros. Totais nacionais vêm do arquivo nacional, sem somar municípios.

Horários internos são epoch em milissegundos UTC. O campo `generation` preserva data/hora textual recebida da fonte sem assumir um fuso horário; `sourceGeneratedAt` permanece `null` até essa informação poder ser confirmada. O contrato público inicial e sua política de timestamps estão em [R2](../docs/r2.md); o banco não é uma API pública.

Falhas preservam o resultado anterior. 404 pausa globalmente por pelo menos um minuto e exige revalidar a configuração. 403/429 pausam por pelo menos dez minutos. `Retry-After` aceita segundos ou data HTTP e nunca reduz a pausa mínima. Outras falhas usam espera progressiva. Pausas e agenda sobrevivem ao reinício.

## Diagnóstico

Em execução contínua, `GET /healthz` informa processo ativo, contexto, cobertura e bloqueio. Respostas usam `Cache-Control: no-store`; os caminhos públicos de dados são descritos no [contrato da API](../docs/api.md), e os demais retornam 404. A API só lê o banco: acessos de visitantes não disparam consultas ao TSE.

HTTP 200 indica que o processo está ativo, inclusive quando a fonte está indisponível. Para acompanhar os dados, verificar `coverage.available`, `coverage.failed`, `coverage.oldestCheckedAt`, `lastError` e `blockedUntil`. Essa distinção evita reiniciar o coletor repetidamente durante um bloqueio do TSE.

O diagnóstico inclui `schemaVersion: 1` para seu próprio formato. Os arquivos públicos também têm schema próprio documentado em [R2](../docs/r2.md). O horário da consulta não substitui o horário de geração da fonte. O campo `publication` informa habilitação, última publicação, falha e URL do manifesto quando disponível.

## Preparar o Render

Os arquivos [Dockerfile](Dockerfile), [.dockerignore](.dockerignore) e [render.yaml](render.yaml) tornam o deploy independente dentro de `backend/`. Nenhum recurso remoto foi criado.

O [guia do Render](../docs/render.md) detalha a criação pelo painel ou Blueprint. Usar **Web Service**, runtime **Docker**, **Root Directory: `backend`**, Dockerfile `./Dockerfile` e contexto `.`. O comando de início vem do Dockerfile: `bun main.mjs`.

Para coleta contínua com SQLite persistente, usar serviço pago, uma instância e disco em `/data`, com `COLLECTOR_DB=/data/results.sqlite`. Configurar as variáveis R2 no painel e o healthcheck `/healthz`. O plano Free suspende por inatividade e não oferece disco persistente.

A imagem fixa Bun 1.2.23, versão usada na validação local. Atualizações do runtime devem passar pelos testes antes de alterar essa versão.

O SQLite usa uma lease de 60 segundos para impedir dois processos no mesmo banco; a execução renova a lease antes das consultas e a cada ciclo. O ritmo e o bloqueio também ficam no banco. Esse mecanismo exige o mesmo volume: cópias com volumes separados não compartilham coordenação nem limite. Não escalar réplicas nesta etapa.

## Testar sem consultar o TSE

```sh
bun run test:collector
node --test test/frontend/electoral-map.mjs
```

Os testes do coletor usam respostas locais, relógio controlado e SQLite temporário. Cobrem validação de abrangências, ritmo, concorrência, prioridade, falhas, bloqueios, timeout, retomada e execução real do comando `--once` com fonte substituída apenas no subprocesso de teste. Os testes de frontend verificam o contrato da API. A suíte nacional simula 5.568 municípios e mais de 33 mil resultados de vários cargos/turnos, incluindo publicação R2 e exceções territoriais.

## Próximas entregas

- Medir coleta real, cobertura e consumo da UF escolhida, quando a fonte estiver disponível.
- Validar upload real, domínio, CORS e cache do R2 após configurar uma nova chave no servidor.
- Validar mapa, corrida e resultados na origem de produção após implantar a API.
- Medir a cobertura nacional real, a idade por cargo/território e o consumo de volume e rede. A ampliação nacional já está implementada e é o padrão.

Referências: [Docker no Render](https://render.com/docs/docker), [SQLite no Bun](https://bun.sh/docs/runtime/sqlite), [discos no Render](https://render.com/docs/disks) e [informações técnicas do TSE](https://www.tse.jus.br/eleicoes/informacoes-tecnicas-sobre-a-divulgacao-de-resultados).
