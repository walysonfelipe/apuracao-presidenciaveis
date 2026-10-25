**O que você procura é a API de Malhas Geográficas do IBGE**: ela oferece mapas simplificados em **GeoJSON e SVG**, próprios para usar em sites e manipular as divisões territoriais. [servicodados.ibge.gov.br](https://servicodados.ibge.gov.br/api/docs/malhas?versao=3\&utm_source=chatgpt.com)

Links diretos:

| Mapa | Para usar em um sistema | Para visualizar ou editar como vetor |
|---|---|---|
| **Brasil separado por estados** | [GeoJSON dos estados](https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?intrarregiao=UF&formato=application/vnd.geo%2Bjson&qualidade=intermediaria) | [SVG dos estados](https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?intrarregiao=UF&formato=image/svg%2Bxml&qualidade=intermediaria) |
| **Brasil separado por municípios** | [GeoJSON dos municípios](https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?intrarregiao=municipio&formato=application/vnd.geo%2Bjson&qualidade=intermediaria) | [SVG dos municípios](https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?intrarregiao=municipio&formato=image/svg%2Bxml&qualidade=intermediaria) |
| **São Paulo separado por municípios** | [GeoJSON dos municípios de SP](https://servicodados.ibge.gov.br/api/v3/malhas/estados/SP?intrarregiao=municipio&formato=application/vnd.geo%2Bjson&qualidade=intermediaria) | [SVG dos municípios de SP](https://servicodados.ibge.gov.br/api/v3/malhas/estados/SP?intrarregiao=municipio&formato=image/svg%2Bxml&qualidade=intermediaria) |

**Para o seu caso, eu começaria pelo GeoJSON**: cada território fica representado por uma geometria, permitindo configurar cores, seleção, cliques e informações por município no seu mapa. O SVG serve melhor para editar a aparência como desenho vetorial.

A [documentação oficial tem um gerador de links](https://servicodados.ibge.gov.br/api/docs/malhas?versao=3#queryBuilder), onde você escolhe território, formato, qualidade e divisão interna. [servicodados.ibge.gov.br](https://servicodados.ibge.gov.br/api/docs/malhas?versao=3\&utm_source=chatgpt.com)

Se precisar dos **limites completos, com mais detalhes**, também existe o [download oficial das malhas de 2025 em Shapefile](https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/malhas_municipais/municipio_2025/Brasil/), com arquivos separados para estados e municípios. [IBGE](https://www.ibge.gov.br/geociencias/organizacao-do-territorio/malhas-territoriais/15774-malhas.html?utm_source=chatgpt.com)