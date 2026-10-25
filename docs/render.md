# Deploy do backend no Render

O backend é independente dentro de `backend/`. O frontend continua em seu deploy estático na Cloudflare/Vercel. O processo Bun oferece API HTTP e coleta em segundo plano, portanto o tipo de serviço é **Web Service**, com runtime **Docker**.

Esta configuração exige um serviço pago e disco persistente. O Free pode dormir após 15 minutos sem tráfego de entrada, não permite disco persistente e perde arquivos locais em reinícios/deploys. Chamadas do coletor ao TSE não mantêm o serviço gratuito acordado.

## Pelo painel

1. Enviar a versão atual do projeto para o GitHub.
2. No Render, escolher **New → Web Service** e conectar o repositório.
3. Configurar:

| Campo | Valor |
| --- | --- |
| Root Directory | `backend` |
| Language / Runtime | `Docker` |
| Dockerfile Path | `./Dockerfile` |
| Docker Build Context | `.` |
| Docker Command | Deixar vazio: usa `CMD` do Dockerfile, `bun main.mjs` |
| Health Check Path | `/healthz` |
| Instances | `1` |
| Instance type | Pago; o Blueprint usa `0.5c-512mb` como ponto de partida |

Os caminhos Docker são relativos a `backend/` quando Root Directory está definido. O contexto e o `.dockerignore` incluem apenas arquivos necessários ao servidor, sem frontend, `.env` ou dependências locais.

4. Em **Advanced → Add Disk**, ou na página **Disks**, criar disco em `/data`. O Blueprint começa com 1 GB; medir o uso real da cobertura nacional e aumentar conforme necessário. O plano da máquina e o disco têm cobrança própria conforme o Render.
5. Cadastrar as variáveis abaixo em **Environment** e criar o serviço.

## Variáveis

```env
COLLECTOR_DB=/data/results.sqlite
COLLECTOR_UF=all
COLLECTOR_ROUND=all
COLLECTOR_OFFICES=all
COLLECTOR_RPS=40
COLLECTOR_CONCURRENCY=8

R2_ENABLED=true
R2_ACCOUNT_ID=SEU_ACCOUNT_ID
R2_ACCESS_KEY_ID=SUA_NOVA_CHAVE
R2_SECRET_ACCESS_KEY=SEU_NOVO_SEGREDO
R2_BUCKET=eleicao
R2_PREFIX=resultados
R2_PUBLIC_BASE_URL=https://eleicoes.agendasalao.com

API_ALLOWED_ORIGINS=https://corridaeleicao.vercel.app,https://eleicoes.agendasalao.com
```

Usar novas credenciais no painel; a chave compartilhada na conversa deve ser revogada. Não enviar `.env` ao GitHub. Ajustar `API_ALLOWED_ORIGINS` para os domínios reais do frontend.

`COLLECTOR_DB` deve ficar dentro do disco montado. Se importar o exemplo local, substituir `.collector/results.sqlite` por `/data/results.sqlite`. Não fixar `PORT=3000`: o Render fornece sua própria variável `PORT`, e o servidor já escuta em `0.0.0.0`.

As demais variáveis de intervalos/limites em [backend/.env.example](../backend/.env.example) são opcionais; a configuração mantém cobertura nacional por padrão. Para validar o serviço antes de habilitar uploads, usar `R2_ENABLED=false`; a API HTTP continua lendo os dados coletados no banco.

## Pelo Blueprint

Como alternativa ao painel manual, criar **New → Blueprint**, conectar o repositório e selecionar **Blueprint Path: `backend/render.yaml`**. O [arquivo](../backend/render.yaml) define somente um Web Service, com `rootDir: backend`, Docker, disco `/data`, uma instância e healthcheck.

O Render pede os valores das variáveis com `sync: false` durante a criação. A configuração contém placeholders de entrada, não credenciais. Revisar o plano pago e o disco antes de criar os recursos. Este trabalho preparou os arquivos locais; não criou serviço ou cobrança remotamente.

## Conferir o deploy

O Render fornece um endereço semelhante a `https://corrida-apuracao-api.onrender.com`.

- `GET /healthz`: processo, cobertura, preparação da fonte e publicação.
- `GET /resultados/api/v1/config.json`: catálogo de cargos, turnos e UFs.

HTTP 200 no healthcheck indica processo ativo, inclusive se o TSE estiver em pausa. Acompanhar `coverage.available`, `coverage.configured`, `preparationErrors` e `blockedUntil` para avaliar os dados. A primeira coleta nacional é gradual.

## Conectar o frontend

Com R2 habilitado e domínio/CORS/cache configurados, o frontend já usa `https://eleicoes.agendasalao.com` para os resumos públicos. O Render continua cuidando da coleta e publicação.

Para usar a API HTTP do Render diretamente, definir `FRONTEND_API_BASE_URL=https://SEU-SERVICO.onrender.com` nas variáveis de build do frontend e fazer novo deploy. O endereço do frontend precisa estar em `API_ALLOWED_ORIGINS` no backend. Não alterar a origem para um exemplo fictício antes de obter a URL real do serviço.

Referências: [monorepos](https://render.com/docs/monorepo-support), [Blueprint](https://render.com/docs/blueprint-spec), [discos persistentes](https://render.com/docs/disks) e [limites Free](https://render.com/docs/free).
