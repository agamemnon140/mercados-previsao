# Maiores mercados de previsão

Página estática com os maiores mercados da Kalshi e da Polymarket por volume, atualizada uma vez por dia por um GitHub Action. Dá para ordenar pelo volume do dia, da semana, do mês ou do ano e filtrar por categoria.

## Como funciona

| Peça | O que faz |
|---|---|
| `.github/workflows/atualizar.yml` | Roda todo dia às 09:17 UTC (06:17 em Brasília) e também sob demanda. |
| `scripts/fetch.mjs` | Lê as APIs públicas das duas plataformas (sem chave), monta os rankings e grava `data/latest.json` (o que a página lê) e `data/history/AAAA-MM-DD.json` (resumo do dia). |
| `index.html` | Lê `data/latest.json` e mostra as duas listas, 25, 50 ou 100 por vez. Não chama nenhuma API externa. |

O navegador só fala com o GitHub Pages. Quem fala com a Kalshi e a Polymarket é o servidor do GitHub Actions.

## O que fica guardado

- **`data/latest.json` não fica no repositório.** Tem alguns megabytes e muda inteiro todo dia; versionado, faria o repositório crescer mais de 100 MB por ano. Ele é publicado só no site, e a cópia publicada serve de reserva: se uma plataforma falhar numa coleta, a coluna dela é mantida com o dado anterior.
- **`data/history/AAAA-MM-DD.json` fica no repositório.** É um resumo pequeno: os 100 maiores eventos de cada período, por plataforma, com volumes e probabilidades. É a série histórica para gráficos de evolução, variações em períodos mais longos e comparação entre as plataformas. Cresce cerca de 10 MB por ano.

## Colocar no ar

1. Crie um repositório **público** e suba estes arquivos na raiz.
2. Em **Settings → Pages**, em *Source*, escolha *GitHub Actions*. O próprio workflow publica o site depois de cada coleta.
3. Em **Actions**, abra *Atualizar odds* e clique em *Run workflow*. Essa primeira execução é o teste real contra as APIs.
4. Abra `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

Se a execução ficar vermelha, o log do passo *Coletar Kalshi e Polymarket* diz qual plataforma falhou e por quê. Quando só uma falha, a outra é publicada normalmente e a página avisa que uma coluna está desatualizada.

## Usar a página

- **Volume do:** Dia (24 horas), Semana (7 dias), Mês (30 dias) ou Ano (12 meses). Muda a ordenação e o volume mostrado.
- **Categoria:** Esportes, Política, Economia, Cripto, Cultura, Ciência e tecnologia, Clima, Mundo, Outros.
- O endereço guarda a escolha, por exemplo `#semana-politica`, e pode ser salvo nos favoritos.

## Como os números são calculados

- **Só mercados abertos.** Um jogo encerrado ontem não aparece, mesmo que tenha sido o maior da semana.
- **Polymarket:** a API publica o volume de cada período (`volume24hr`, `volume1wk`, `volume1mo`, `volume1yr`). O script lê os 2.000 maiores eventos de cada um.
- **Kalshi:** a API publica só o volume de 24 horas e o total desde a abertura, e não ordena por volume. O script varre todos os eventos abertos e calcula os outros períodos assim:
  - mercado aberto há menos tempo que o período: o volume do período é o total (exato);
  - mercado mais antigo: soma dos candles diários, consultados para até 3.000 eventos que podem entrar em algum ranking;
  - sem candles: semana e mês ficam no piso conhecido (mostrado com `≥`) e ano fica no total (mostrado com `≤`).
- **Unidades:** contratos na Kalshi (cada um paga US$ 1), dólares na Polymarket. As colunas não são diretamente comparáveis.
- **Probabilidade:** ponto médio entre compra e venda quando o spread é de até 10 centavos; senão, o último negócio. A Polymarket já publica o preço assim; para a Kalshi o script aplica a mesma regra.
- **Variação:** sempre a de 24 horas, qualquer que seja o período escolhido.
- **Categorias:** as etiquetas de cada plataforma são reduzidas a um conjunto comum por palavras-chave (`CATEGORY_RULES` no script). Na Polymarket, que usa várias tags por evento, cada tag e o título valem um ponto para a categoria que casar; vence a de mais pontos.
- **Resultados mostrados:** até quatro por evento. Quando só um pode acontecer (vencedor de eleição, campeão), são os mais prováveis. Quando são independentes (faixas de preço, datas), são os mais próximos de 50%. Em jogos da Polymarket, só o mercado de vencedor.
- **Rankings guardados:** os 500 maiores no geral e os 100 maiores de cada categoria, por período. Combos da Kalshi (eventos multivariados) ficam de fora.

## Ajustes

Variáveis de ambiente lidas pelo script (defina no passo *Coletar* do workflow):

| Variável | Padrão | Para quê |
|---|---|---|
| `TOP_N` | 500 | Tamanho do ranking geral de cada período. |
| `TOP_PER_CATEGORY` | 100 | Tamanho do ranking de cada categoria. |
| `POLY_DEPTH` | 2000 | Eventos lidos por período na Polymarket. |
| `KALSHI_CANDLE_EVENTS` | 3000 | Eventos da Kalshi com candles consultados. |
| `HISTORY_TOP` | 100 | Eventos por período no resumo diário. |
| `KALSHI_MAX_PAGES` | 600 | Limite da varredura da Kalshi (200 eventos por página). |

O horário fica na linha `cron` do workflow, sempre em UTC.

## Testar sem acesso às APIs

```
node --test
```

Os testes sobem um servidor local que imita as duas APIs no formato documentado (`test/mock.mjs`) e rodam o coletor contra ele: paginação, ordenação por período, categorias, candles, falha parcial e repetição após limite de requisições.

## Limites conhecidos

- Se os candles da Kalshi falharem numa coleta, ela continua e os períodos longos dos mercados antigos aparecem como limites.
- Os links dos títulos apontam para kalshi.com e polymarket.com, que estão bloqueados em conexões brasileiras.
