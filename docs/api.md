# API de resultados

## Responsabilidades

O frontend recebe dados normalizados. O backend descobre eleições, consulta o TSE, cruza códigos municipais, valida arquivos, calcula percentuais, cores e situações eleitorais e persiste resultados. Não há código compartilhado entre cliente e servidor.

O serviço Bun oferece uma API somente de leitura a partir do SQLite. Com R2 habilitado, os mesmos resumos são distribuídos pelo domínio público e CDN. Uma requisição de visitante não inicia uma consulta ao TSE.

## Configuração

Em [api-config.js](../frontend/api-config.js), a base padrão é `http://localhost:3000` em localhost/127.0.0.1 e `https://eleicoes.agendasalao.com` nos demais hosts. O prefixo é `resultados`.

Para outro endereço, definir `FRONTEND_API_BASE_URL` no build. `FRONTEND_DATA_PREFIX` permite trocar o prefixo quando a base é definida. São variáveis públicas; não colocar credenciais do servidor no frontend.

```sh
FRONTEND_API_BASE_URL=https://sua-api.up.railway.app npm run build:frontend
```

No backend, `API_ALLOWED_ORIGINS` é uma lista separada por vírgula. Os valores iniciais incluem o frontend local na porta 8000 e os domínios conhecidos de produção. Para distribuir pelo R2, configurar o CORS conforme [r2.md](r2.md).

## Descobrir os dados

1. Buscar `GET /resultados/api/v1/config.json`.
2. Selecionar `rounds[turno].offices[cargo].scopes[uf]`, sem substituir turno, cargo ou UF. Quando houver várias eleições municipais na mesma UF, a seleção pode ser uma lista; escolher a que anuncia o município desejado.
3. Buscar o `manifestKey` dessa seleção. Para os painéis nacionais de Senador e deputados, usar o `overviewKey` anunciado pelo cargo.
4. Buscar `datasets.brasil.key` e/ou `datasets.estado.key`.
5. Usar `statusKey` para consultar os horários e falhas da coleta.

As chaves incluem o prefixo completo e devem ser combinadas com a base da API. O cliente rejeita referências fora da origem e do prefixo configurados.

O catálogo tem `schemaVersion: 1`, `environment: oficial`, `cycle: ele2026`, uma lista dinâmica de `offices` e `rounds[turno].offices[cargo]`. Cada cargo traz nome, `scopes` por UF e, quando aplicável, `overviewKey`. Cada seleção contém `election`, `uf`, `office`, `date`, `level` e `manifestKey`; eleições municipais também anunciam seus municípios. Os códigos vêm do TSE. No R2, apenas seleções com manifesto publicado são anunciadas.

## Resultado normalizado

Cada documento tem `schemaVersion`, `context`, `scope` e `result`. O estadual também contém `municipalities`, com abrangência, códigos IBGE/TSE e resultado por cidade.

| Campo de `result` | Significado |
| --- | --- |
| `candidates` | Identificador, nome, número, partido, votos, percentual, cor e situação |
| `total` | Soma dos votos das candidaturas válidas aceitas pelo adaptador |
| `leader`, `tied`, `margin` | Liderança, empate e vantagem em pontos percentuais |
| `fill` | Cor final do território no mapa |
| `counted`, `sections` | Percentual e contagens de seções |
| `votes` | Válidos, brancos, nulos e total da fonte; ausências ficam `null` |
| `abstention` | Contagem e percentual de abstenção quando disponíveis |
| `complete`, `defined` | Situação de totalização/definição informada pela fonte |
| `round`, `election` | Identidade eleitoral |
| `generation`, `idg` | Geração textual e identificador da fonte |
| `sourceGeneratedAt` | Reservado para geração em epoch UTC; atualmente `null`, sem assumir fuso de `dg/hg` |

As situações são preparadas no backend. Uma liderança municipal/estadual de Presidente não declara um eleito nacional. A interface não calcula projeções. Fotos ficam `null` até haver cache de imagens no servidor; a apresentação usa iniciais.

`result: null` significa indisponibilidade, não zero votos. O status separa consulta bem-sucedida, tentativa e erro. O horário de consulta não substitui a geração da fonte.

## Cache e cobertura

Catálogo, manifesto e status têm cache compartilhado curto. Os arquivos com hash são imutáveis. A API HTTP gera os documentos sob demanda a partir do banco, sem consultar o TSE, e mantém cache em memória de até 64 MiB e hashes recentes por até cinco minutos; no R2 vale a retenção de objetos documentada.

O mapa atualiza a cada dez segundos e recebe todos os municípios em um resumo estadual. A página de resultados atualiza a cada quinze segundos. Falhas preservam a última leitura, sem fallback direto ao TSE ou troca de turno.

A cobertura padrão inclui **todas as UFs, municípios, cargos e turnos anunciados pelo TSE** para o ciclo. Os filtros `COLLECTOR_UF`, `COLLECTOR_ROUND` e `COLLECTOR_OFFICES` são opcionais. Não se cria resultado para cargo/turno/território não anunciado. O DF recebe Deputado Distrital, e Governador no segundo turno só aparece nas UFs configuradas. A geometria funciona independentemente da coleta.

A corrida usa a API para resultados oficiais e simulação local identificada antes da divulgação. Não consulta o simulado do TSE.

## Operação local

Em terminais separados, na raiz: `bun run collector` e `npm run dev:frontend`. O coletor faz consultas reais conforme `backend/.env`. `GET /healthz` é o diagnóstico; os caminhos públicos aceitam somente GET/HEAD e não expõem arquivos do servidor.

O código está preparado localmente. A implantação Railway e a validação do domínio, R2 e cache de produção ainda estão pendentes.

As regras de `md` (eleito/segundo turno) e `esae` (sem atribuição) são interpretadas no backend conforme a [especificação EA20 do TSE](https://www.tse.jus.br/eleicoes/eleicoes-2026-content/arquivos/divulgacao-de-resultados/tse-ea20-arquivo-de-resultado-unificado).

## Listas municipais completas e painéis nacionais

A API HTTP oferece `GET /resultados/oficial/ele2026/<eleicao>/<turno>/<cargo>/municipios/<uf>/<ibge>.json`, exclusivamente para municípios preparados pelo coletor. Essa rota lê a lista completa no SQLite. Os resumos grandes publicados no R2 podem ser compactos: `candidatesTruncated: true` e `candidateCount` explicitam quando só dois líderes estão no resumo. Eleições municipais mantêm listas completas nos seus documentos. A rota de detalhes completos não é um objeto estático replicado automaticamente no R2.

`/resultados/api/v1/nacional/<turno>/<cargo>.json` oferece painéis de Senador e deputados. Eles identificam `aggregate: true` e cobertura por UF. Não representam uma totalização nacional oficial nem uma fotografia simultânea. Os percentuais individuais continuam sendo os da UF do candidato. Vagas e cadeiras por partido vêm da atribuição oficial, sem projeção de eleitos no navegador.

Presidente usa exclusivamente o arquivo nacional oficial para o resultado de Brasil. Seu documento também reúne os resumos estaduais para colorir as 27 UFs sem baixar todos os municípios.
