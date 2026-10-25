# Malhas do mapa interativo

Dados públicos do IBGE obtidos em 24/10/2026. Os arquivos são locais para que a navegação funcione sem consultas externas após abrir o projeto por um servidor HTTP.

## Fontes

- [Malha nacional por unidades federativas](https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?intrarregiao=UF&formato=application/vnd.geo%2Bjson&qualidade=minima).
- [Malha nacional por municípios](https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?intrarregiao=municipio&formato=application/vnd.geo%2Bjson&qualidade=minima).
- [Nomes e códigos das localidades](https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome).
- [Documentação da API de malhas](https://servicodados.ibge.gov.br/api/docs/malhas?versao=3).

## Organização

`brasil.json` contém as 27 unidades federativas. Os demais arquivos usam o código de dois dígitos do IBGE da UF e contêm os territórios da malha municipal daquela UF. O conjunto retornado pela API contém 5.570 territórios; representa a malha simplificada disponibilizada pelo serviço, sem afirmar ser a divisão municipal mais recente. O Distrito Federal é apresentado como território próprio, pois não se divide em municípios.

Os polígonos e anéis interiores do GeoJSON foram preservados em caminhos SVG com duas casas decimais, numa projeção equiretangular com paralelo de referência de 15° S. Cada registro traz `id`, `name`, `path`, `center` e `bounds`; o arquivo nacional inclui sigla, região e contagem de territórios. Os JSON originais somam aproximadamente 2,75 MB. As versões `.json.gz` somam 898 KB (67,3% menores), sem remover pontos ou alterar os contornos. O mapa nacional passa de 73 KB para 25 KB. Cada estado continua sendo carregado separadamente, quando necessário.

Não há resultados eleitorais nestes arquivos: eles contêm apenas geometrias e metadados geográficos. Na página, as cores são aplicadas separadamente a partir dos resultados oficiais do TSE, conforme documentado no [README do projeto](../../README.md).

## Carregamento otimizado

O HTML antecipa o download de `brasil.json.gz`. O navegador descompacta a malha com `DecompressionStream`; se a API ou o arquivo compactado estiver indisponível, usa o JSON original. Funciona em hospedagem estática e com `python3 -m http.server`, sem configurar compressão no servidor. Hospedagens que enviam `Content-Encoding: gzip` também são aceitas.

Downloads em andamento e malhas já abertas são reutilizados em memória durante a navegação. Passar o mouse ou focar um estado no mapa antecipa sua malha após 120 ms; conexões que informam economia de dados ou 2G não fazem essa antecipação. Não há download automático de todas as UFs. A lista de localidades só é criada ao abrir a busca, e fontes externas não bloqueiam a exibição do mapa.

Depois de alterar qualquer JSON, regenere os arquivos compactados a partir da raiz do projeto:

```sh
gzip -9 -n -k -f frontend/data/mapa/*.json
```

Publique os JSON e seus arquivos `.gz` juntos para manter as duas versões sincronizadas.
