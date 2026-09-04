# Radar Macro — ETF Dashboard

Dashboard de desempenho e risco para 3 ETFs — **EWZ** (Brasil), **FXE** (Euro) e **EEM** (mercados emergentes) — com interpretação contextualizada de Sharpe, drawdown e volatilidade rolantes, e uma leitura diária de mercado.

**Site ao vivo:** `https://rodrigomambrini.github.io/desafiojgp/`

## O que tem aqui

- Preço, variação do dia e histórico diário (Yahoo Finance) para os 3 ativos.
- Desempenho indexado, drawdown, volatilidade rolante (21 pregões) e Sharpe rolante (63 pregões), com seletor de período.
- Caixas de interpretação: cada métrica é comparada com a distribuição histórica do próprio ativo (percentis p25/p50/p75), com a variação da última semana e o ranking entre os 3 ativos.
- "Leitura do mercado": 2 parágrafos por ativo explicando o que aconteceu e por quê, atualizados 1x/dia.

## Como os dados são atualizados

- **Preços e métricas** (`data/etf_data.json`): [`.github/workflows/update-prices.yml`](.github/workflows/update-prices.yml) roda `scripts/fetch_and_compute.py` de hora em hora, seg-sex, no horário de mercado, e commita o resultado — sem precisar abrir o site.
- **Leitura do mercado** (`data/thesis.json`): atualizada 1x/dia, após o fechamento, por uma rotina do Claude que pesquisa notícias reais sobre cada ativo e escreve a análise.
- Para forçar uma atualização manual de preços: aba *Actions* deste repositório → *Update ETF prices* → *Run workflow*.

## Rodando localmente

Não precisa de build nem de dependências — é HTML/CSS/JS puro consumindo os JSONs em `data/`:

```bash
python -m http.server 8000
# abra http://localhost:8000
```

Para regenerar os dados manualmente:

```bash
python scripts/fetch_and_compute.py
```

## Metodologia (resumo)

- Preço de fechamento diário, não ajustado por proventos.
- Volatilidade: desvio-padrão dos retornos diários, janela de 21 pregões, anualizada (×√252).
- Sharpe: retorno médio / desvio-padrão dos retornos diários, janela de 63 pregões, anualizado, assumindo taxa livre de risco = 0%.
- Bandas "normal" de cada indicador: percentis p10/p25/p50/p75/p90 calculados sobre o histórico carregado do próprio ativo (até 6 anos) — não são benchmarks de mercado genéricos.
- Drawdown: queda percentual do fechamento em relação ao topo anterior, dentro da janela carregada.

Isso não constitui recomendação de investimento.
