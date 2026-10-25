# Corrida da Apuração

## Ideia

Uma corrida visual inspirada em jogos de kart. Cada candidato é um competidor na pista, e sua posição acompanha seu percentual dos votos válidos apurados. O foco é assistir à corrida e às mudanças da apuração.

## Abrir o jogo

Na raiz do repositório, execute `npm run dev:frontend` e abra `http://localhost:8000` em um navegador moderno. O jogo usa HTML, CSS e JavaScript sem dependências de execução; uma etapa de cópia reúne os arquivos públicos do frontend em `dist/frontend/`. A página consulta nossa API de resultados; se os arquivos ainda não estiverem publicados ou a conexão falhar, exibe os dados de demonstração identificados como tal.

## Como funciona

- A corrida começa direto na pista, sem menu, cadastro, palpites ou ranking.
- Cada candidato tem uma cor, um kart e uma identificação legível.
- A posição na pista representa o percentual de votos válidos do candidato. Ela não representa a porcentagem de seções apuradas.
- Quando chegam resultados oficiais novos, os karts avançam ou recuam suavemente conforme os percentuais mudam.
- Uma troca de liderança é mostrada como uma ultrapassagem, com destaque visual breve.
- O HUD mostra a posição dos candidatos, seus percentuais, o percentual de seções totalizadas, a fonte dos dados e o horário da última atualização.
- Uma contagem regressiva mostra quanto falta para as 17h (horário de Brasília). Nesse horário, o modo em tempo real é ativado automaticamente e o TSE passa a ser consultado a cada cinco segundos.
- Entre atualizações, a animação continua, mas os karts não inventam mudanças nos resultados.
- A corrida só termina quando a apuração oficial for concluída. Uma liderança parcial não dispara a vitória.
- Quando o TSE marca o resultado como matematicamente definido (`md`), o contador mostra **DEFINIDO** e os candidatos recebem a etiqueta **ELEITO** ou **2º TURNO**, conforme a situação (`st`/`e`) do arquivo EA20. Se o TSE marcar `md` antes de preencher `st`, a página aplica a regra da eleição: mais de 50% dos votos válidos elege; senão, os dois primeiros vão ao 2º turno.
- Quando o arquivo oficial chega a 100% das seções totalizadas (ou à totalização final), ou quando o TSE marca o resultado como matematicamente definido, abre uma tela própria com quem foi eleito ou quem vai ao 2º turno de Presidente, com os percentuais de votos válidos. Ela abre sozinha uma vez por turno e leva, pelo botão **Ver a apuração de todos os cargos**, à página de resultados por estado (`estados.html`); a tecla Esc fecha, e **Ver resultado final**, no cartão do líder, reabre.
- Se o arquivo do TSE ficar mais de 10 minutos sem uma nova geração (antes da totalização final), o selo muda para **TSE SEM ATUALIZAÇÃO** e informa há quanto tempo o arquivo não muda.

## Primeira versão

O protótipo começa direto na pista. Use as setas esquerda/direita para girar a câmera, os botões para alternar entre as visões da pista e `F` para tela cheia. Essas ações não alteram a classificação. O arquivo `game.js` busca a configuração EA11, encontra o código de Presidente e consulta o resultado nacional EA20 a cada 30 segundos. O código usa `s.pst` para a apuração de seções e `cand.vap` sobre os votos válidos para ordenar candidatos. A pista mostra até oito karts; a classificação lista todos. `style.css` define a interface responsiva.

## Simulação da apuração

Antes da divulgação oficial, a página abre com uma simulação local da apuração, com candidatos fictícios identificados como **SIMULAÇÃO**. Ela não consulta o ambiente de teste do TSE. A contagem começa devagar, acelera no meio e desacelera no fim; ao concluir, espera alguns segundos e recomeça com novas variações.

Às 17h, o modo ao vivo acompanha exclusivamente a API. A classificação, os votos, o percentual de seções e as situações das candidaturas chegam normalizados pelo backend. Se a API estiver indisponível, a página mantém a última leitura oficial ou uma demonstração identificada.

## Dados

O backend consulta os arquivos públicos do TSE e prepara o resultado nacional de Presidente. O frontend lê apenas o contrato da nossa API, sem interpretar EA11/EA20. A tela identifica a fonte e a geração do arquivo. Se os dados não estiverem publicados ou estiverem indisponíveis, mantém o placar ilustrativo claramente identificado; falhas sucessivas usam espera progressiva para evitar excesso de consultas.

Referências: [informações técnicas de divulgação do TSE](https://www.tse.jus.br/eleicoes/informacoes-tecnicas-sobre-a-divulgacao-de-resultados) e [especificação EA20](https://www.tse.jus.br/eleicoes/eleicoes-2026-content/arquivos/divulgacao-de-resultados/tse-ea20-arquivo-de-resultado-unificado).
