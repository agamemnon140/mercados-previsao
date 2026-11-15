import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock.mjs';
import { sumCandles, unifiedCategory, resolveKalshiVolumes, normalizeKalshiEvent, normalizePolymarketEvent } from '../scripts/fetch.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/fetch.mjs', import.meta.url));

function run(mock, outDir, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      {
        env: {
          PATH: process.env.PATH,
          KALSHI_BASE: mock.kalshiBase,
          GAMMA_BASE: mock.gammaBase,
          OUT_DIR: outDir,
          PAUSE_MS: '0',
          RETRY_BASE_MS: '5',
          TOP_N: '100',
          TOP_PER_CATEGORY: '30',
          NO_PROXY: '127.0.0.1,localhost',
          ...env,
        },
      },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

async function scenario(config, env, seed) {
  const mock = await startMock(config);
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'odds-'));
  if (seed) {
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'latest.json'), JSON.stringify(seed));
  }
  const result = await run(mock, outDir, env);
  await mock.close();
  let data = null;
  try {
    data = JSON.parse(await readFile(path.join(outDir, 'latest.json'), 'utf8'));
  } catch {}
  return { ...result, data, outDir, hits: mock.hits };
}

/** Cada ranking precisa estar em ordem decrescente do volume da própria janela. */
function assertRankingsSorted(venue) {
  for (const [window, lists] of Object.entries(venue.rankings)) {
    for (const [name, ids] of Object.entries(lists)) {
      const volumes = ids.map((id) => venue.events[id].volume[window]);
      assert.ok(volumes.every((v, i) => i === 0 || v <= volumes[i - 1]), `${window}/${name} fora de ordem`);
      if (name !== 'all') assert.ok(ids.every((id) => venue.events[id].category === name), `${window}/${name} com categoria errada`);
    }
  }
}

test('caminho feliz: janelas, categorias e resultados das duas plataformas', async () => {
  const { code, data, outDir, hits, stderr } = await scenario({});
  assert.equal(code, 0, stderr);
  assert.equal(data.schema, 2);
  assert.deepEqual(data.windows, ['day', 'week', 'month', 'year']);

  const k = data.venues.kalshi;
  assert.equal(k.ok, true);
  assert.equal(k.scanned_events, 426); // 420 de enchimento + 6 nomeados, em 3 páginas
  assert.equal(k.truncated, false);
  assert.equal(k.rankings.day.all.length, 100);
  assert.equal(k.rankings.day.esportes.length, 30);
  assertRankingsSorted(k);
  assert.ok(!('KXNOVOL-26' in k.events), 'evento que nunca negociou não entra');
  assert.ok(Object.values(k.events).every((e) => !('_markets' in e) && !('_series' in e)), 'campos internos não vazam');

  // Jogo aberto há 5 dias: todas as janelas são o total desde a abertura.
  const game = k.events['KXNFLGAME-26NOV15KCBUF'];
  assert.deepEqual(game.volume, { day: 10000000, week: 14300000, month: 14300000, year: 14300000, total: 14300000 });
  assert.deepEqual(game.bounds, {});
  assert.equal(game.category, 'esportes');
  assert.equal(game.url, 'https://kalshi.com/markets/kxnflgame');
  assert.deepEqual(game.outcomes.map((o) => o.label), ['Buffalo', 'Kansas City']);
  assert.equal(game.outcomes[0].prob, 0.575); // ponto médio de 0,57/0,58
  assert.equal(game.outcomes[0].change_24h, 0.06); // 0,58 - 0,52
  assert.equal(game.outcomes[1].change_24h, -0.06);

  // Aberto há 90 dias: semana e mês vêm dos candles diários, ano é o total.
  const fed = k.events['KXFEDDECISION-26DEC'];
  assert.deepEqual(fed.volume, { day: 4200000, week: 29400000, month: 60800000, year: 60800000, total: 60800000 });
  assert.deepEqual(fed.bounds, {});
  assert.equal(fed.category, 'economia');
  assert.equal(fed.source_category, 'Economics');
  assert.equal(fed.n_outcomes, 5, 'mercado já liquidado não é resultado');
  assert.deepEqual(fed.outcomes.map((o) => o.label), ['Cut 25bps', 'No change', 'Cut 50bps', 'Hike 25bps']);
  assert.equal(fed.subtitle, 'Dec 9 meeting');

  // Aberto há 500 dias: até o ano vem dos candles.
  const pres = k.events['KXPRES-28'];
  assert.deepEqual(pres.volume, { day: 50000, week: 350000, month: 1500000, year: 18250000, total: 40000000 });
  assert.deepEqual(pres.bounds, {});

  assert.deepEqual(k.candles, { requested: 3, ok: 3, failed: 0, error: null });
  assert.equal(hits.candles, 3, 'candles só para quem tem janela em aberto');

  // A ordem muda com a janela.
  assert.deepEqual(k.rankings.day.all.slice(0, 2), ['KXNFLGAME-26NOV15KCBUF', 'KXFEDDECISION-26DEC']);
  assert.deepEqual(k.rankings.week.all.slice(0, 2), ['KXFEDDECISION-26DEC', 'KXNFLGAME-26NOV15KCBUF']);
  assert.deepEqual(k.rankings.year.all.slice(0, 3), ['KXFEDDECISION-26DEC', 'KXPRES-28', 'KXNFLGAME-26NOV15KCBUF']);
  assert.equal(k.rankings.day.esportes[0], 'KXNFLGAME-26NOV15KCBUF');
  assert.equal(k.rankings.year.politica[0], 'KXPRES-28');
  assert.notEqual(k.rankings.day.politica[0], 'KXPRES-28');
  assert.equal(k.rankings.day.cripto[0], 'KXBTCD-26NOV15');

  const cpi = k.events['KXCPIYOY-26NOV'];
  assert.equal(cpi.outcomes[0].prob, 0.41, 'spread largo usa o último negócio');
  assert.equal(cpi.outcomes[1].prob, null, 'sem livro e sem negócio fica nulo');
  assert.equal(cpi.outcomes[1].change_24h, null);

  const p = data.venues.polymarket;
  assert.equal(p.ok, true);
  assert.deepEqual(p.sort_mode, { day: 'api:volume24hr', week: 'api:volume1wk', month: 'api:volume1mo', year: 'api:volume1yr' });
  assert.equal(p.rankings.day.all.length, 100);
  assertRankingsSorted(p);
  assert.ok(!('9004' in p.events), 'evento com volume nulo não entra');

  const pfed = p.events['9001'];
  assert.deepEqual(pfed.volume, { day: 8400000, week: 42000000, month: 151200000, year: 504000000, total: 588000000 });
  assert.equal(pfed.category, 'economia');
  assert.equal(pfed.url, 'https://polymarket.com/event/fed-decision-in-december');
  assert.equal(pfed.n_outcomes, 4, 'mercado fechado dentro do evento é ignorado');
  assert.deepEqual(pfed.outcomes.map((o) => o.label), ['25 bps decrease', 'No change', '50+ bps decrease', '25+ bps increase']);
  assert.equal(pfed.outcomes[0].prob, 0.705);
  assert.equal(pfed.outcomes[0].change_24h, 0.035);
  assert.deepEqual(pfed.tags, ['Economy', 'Fed']);

  assert.deepEqual(p.rankings.day.all.slice(0, 3), ['9001', '9002', '9003']);
  assert.deepEqual(p.rankings.year.all.slice(0, 2), ['9003', '9001'], 'mercado longo passa à frente no ano');
  assert.equal(p.rankings.day.esportes[0], '9002');
  assert.equal(p.rankings.year.cripto[0], '9003');

  const pgame = p.events['9002'];
  assert.deepEqual(pgame.outcomes.map((o) => [o.label, o.prob, o.change_24h]), [
    ['Bills', 0.575, 0.06],
    ['Chiefs', 0.425, -0.06],
  ]);
  assert.deepEqual(p.events['9003'].outcomes.map((o) => [o.label, o.prob]), [['Yes', 0.125]]);

  const history = await readdir(path.join(outDir, 'history'));
  assert.equal(history.length, 1);
  const day = JSON.parse(await readFile(path.join(outDir, 'history', history[0]), 'utf8'));
  assert.deepEqual(Object.keys(day.venues).sort(), ['kalshi', 'polymarket']);
  assert.deepEqual(day.venues.kalshi[0].outcomes[0], ['Buffalo', 0.575]);
  assert.equal(day.venues.kalshi[0].volume.day, 10000000);
});

test('candles da Kalshi indisponíveis: semana e mês viram piso, ano vira teto', async () => {
  const { code, data } = await scenario({ candles: 'down' });
  assert.equal(code, 0, 'a coleta continua valendo');
  const k = data.venues.kalshi;
  assert.equal(k.candles.ok, 0);
  assert.equal(k.candles.failed, 3);
  assert.match(k.candles.error, /HTTP 401/);

  const fed = k.events['KXFEDDECISION-26DEC'];
  assert.deepEqual(fed.volume, { day: 4200000, week: 4200000, month: 4200000, year: 60800000, total: 60800000 });
  assert.deepEqual(fed.bounds, { week: 'min', month: 'min' });

  const pres = k.events['KXPRES-28'];
  assert.deepEqual(pres.volume, { day: 50000, week: 50000, month: 50000, year: 40000000, total: 40000000 });
  assert.deepEqual(pres.bounds, { week: 'min', month: 'min', year: 'max' });

  // Quem abriu há pouco continua exato, com ou sem candles.
  assert.deepEqual(k.events['KXNFLGAME-26NOV15KCBUF'].bounds, {});
});

test('Polymarket ignora o parâmetro de ordenação: cai na varredura completa', async () => {
  const { code, data } = await scenario({ poly: 'ignore-order' });
  assert.equal(code, 0);
  const p = data.venues.polymarket;
  assert.equal(p.sort_mode, 'varredura');
  assert.equal(p.scanned_events, 234);
  assert.equal(p.truncated, false);
  assert.equal(p.rankings.day.all[0], '9001');
  assert.equal(p.rankings.year.all[0], '9003');
  assertRankingsSorted(p);
});

test('Polymarket recusa a primeira grafia do campo: usa a segunda', async () => {
  const { code, data } = await scenario({ poly: 'reject-camel' });
  assert.equal(code, 0);
  assert.deepEqual(data.venues.polymarket.sort_mode, { day: 'api:volume_24hr', week: 'api:volume_1wk', month: 'api:volume_1mo', year: 'api:volume_1yr' });
  assert.equal(data.venues.polymarket.rankings.day.all[0], '9001');
});

test('Kalshi fora do ar: mantém o último dado bom e sinaliza a falha', async () => {
  const seed = {
    schema: 2,
    generated_at: '2026-11-13T09:17:00.000Z',
    venues: {
      kalshi: {
        ok: true,
        error: null,
        fetched_at: '2026-11-13T09:17:00.000Z',
        volume_unit: 'contracts',
        events: { ANTIGO: { id: 'ANTIGO', title: 'Dado de ontem', volume: { day: 1 }, outcomes: [] } },
        rankings: { day: { all: ['ANTIGO'] } },
      },
    },
  };
  const { code, data, outDir } = await scenario({ kalshi: 'down' }, {}, seed);
  assert.equal(code, 1, 'o job precisa ficar vermelho');
  assert.equal(data.venues.kalshi.ok, false);
  assert.match(data.venues.kalshi.error, /HTTP 500/);
  assert.equal(data.venues.kalshi.fetched_at, '2026-11-13T09:17:00.000Z');
  assert.deepEqual(data.venues.kalshi.rankings.day.all, ['ANTIGO']);
  assert.equal(data.venues.polymarket.ok, true);
  assert.equal(data.venues.polymarket.rankings.day.all.length, 100);
  const history = await readdir(path.join(outDir, 'history'));
  const day = JSON.parse(await readFile(path.join(outDir, 'history', history[0]), 'utf8'));
  assert.deepEqual(Object.keys(day.venues), ['polymarket'], 'histórico só guarda o que foi coletado hoje');
});

test('as duas fora do ar, sem dado anterior: arquivo válido e saída com erro', async () => {
  const { code, data } = await scenario({ kalshi: 'down', poly: 'down' });
  assert.equal(code, 1);
  assert.equal(data.venues.kalshi.ok, false);
  assert.equal(data.venues.polymarket.ok, false);
  assert.deepEqual(data.venues.polymarket.events, {});
});

test('limite de requisições (429) é repetido até passar', async () => {
  const { code, data, hits } = await scenario({ kalshi: 'flaky' });
  assert.equal(code, 0);
  assert.equal(data.venues.kalshi.ok, true);
  assert.equal(hits.kalshi, 5); // 2 recusas + 3 páginas
});

test('limite de páginas marca a varredura como incompleta', async () => {
  const { code, data } = await scenario({}, { KALSHI_MAX_PAGES: '1' });
  assert.equal(code, 0);
  assert.equal(data.venues.kalshi.truncated, true);
  assert.equal(data.venues.kalshi.scanned_events, 200);
});

test('candle na borda da janela entra na proporção em que se sobrepõe', () => {
  const day = 86400;
  const start = 1000000;
  const candles = [
    { end: start - day, volume: 100 }, // todo fora
    { end: start, volume: 100 }, // termina na borda: fora
    { end: start + day / 4, volume: 100 }, // um quarto dentro
    { end: start + day, volume: 100 }, // todo dentro
    { end: start + 3 * day, volume: 100 }, // todo dentro
  ];
  assert.equal(sumCandles(candles, start), 225);
});

test('volume por janela respeita dia <= semana <= mês <= ano <= total', () => {
  const record = { _markets: [{ ticker: 'A', total: 1000, day: 400, age: 100 }] };
  const nowSec = 2000000000;
  // Candles somam menos que o volume do dia: o piso é o dia.
  const candles = new Map([['A', [{ end: nowSec, volume: 10 }]]]);
  const { volume, bounds } = resolveKalshiVolumes(record, candles, 30, nowSec);
  assert.deepEqual(volume, { day: 400, week: 400, month: 400, year: 1000, total: 1000 });
  assert.deepEqual(bounds, {});
});

test('categorias das duas plataformas caem no mesmo conjunto', () => {
  assert.equal(unifiedCategory(['Sports']), 'esportes');
  assert.equal(unifiedCategory(['Politics', 'Trump', 'Economy']), 'politica');
  assert.equal(unifiedCategory(['Economy', 'Fed']), 'economia');
  assert.equal(unifiedCategory(['Financials']), 'economia');
  assert.equal(unifiedCategory(['Climate and Weather']), 'clima');
  assert.equal(unifiedCategory(['Entertainment']), 'cultura');
  assert.equal(unifiedCategory(['Pop Culture', 'Movies']), 'cultura');
  assert.equal(unifiedCategory(['Science and Technology']), 'ciencia');
  assert.equal(unifiedCategory(['Crypto', 'Bitcoin', 'Economy']), 'cripto');
  assert.equal(unifiedCategory(['World']), 'mundo');
  assert.equal(unifiedCategory(['Transportation']), 'outros');
  assert.equal(unifiedCategory([]), 'outros');
});

test('categorias: casos reais de tags da Polymarket', () => {
  // Decisão do Fed tem a tag "Trump", mas é economia.
  assert.equal(unifiedCategory(['Fed', 'fomc', 'Trump', 'Economy', 'Fed Decision in December?']), 'economia');
  // Eleição estrangeira com a tag "World" continua política.
  assert.equal(unifiedCategory(['French Election', 'Main Election', 'France', 'World', 'Next French Presidential Election']), 'politica');
  // Conflito internacional com a tag "Politics" vai para mundo.
  assert.equal(unifiedCategory(['Politics', 'World', 'Geopolitics', 'Foreign Policy', 'Will China invade Taiwan by end of 2026?']), 'mundo');
  assert.equal(unifiedCategory(['Iran', 'Israel', 'Geopolitics', 'Israel x Iran', 'Israel x Iran ceasefire continues through...?']), 'mundo');
  // Sem tag útil, o título decide.
  assert.equal(unifiedCategory(['UK', 'Labour', 'Andy Burnham', 'Keir Starmer', 'How many UK Prime Ministers by end of 2027?']), 'politica');
  assert.equal(unifiedCategory(['Oil', 'Geopolitics', 'Commodities', 'Finance', 'Crude Oil all time high by...?']), 'economia');
  assert.equal(unifiedCategory(['Esports', 'counter strike 2', 'Games', 'Sports']), 'esportes');
  assert.equal(unifiedCategory(['Culture', 'TV', 'netflix', 'Movies']), 'cultura');
});

test('faixas independentes mostram os resultados mais próximos de 50%', () => {
  const strike = (label, p) => ({
    ticker: `KXBTCD-X-${label}`,
    yes_sub_title: label,
    status: 'active',
    yes_bid_dollars: String(p - 0.005),
    yes_ask_dollars: String(p + 0.005),
    last_price_dollars: String(p),
    previous_price_dollars: String(p),
    volume_fp: '100.00',
    volume_24h_fp: '10.00',
    open_interest_fp: '5.00',
    open_time: new Date().toISOString(),
  });
  const markets = [['$57k', 0.99], ['$58k', 0.97], ['$60k', 0.8], ['$62k', 0.55], ['$63k', 0.45], ['$65k', 0.2], ['$70k', 0.03]].map(([l, p]) => strike(l, p));
  const base = { event_ticker: 'KXBTCD-X', series_ticker: 'KXBTCD', title: 'BTC price?', category: 'Crypto', markets };

  const ladder = normalizeKalshiEvent({ ...base, mutually_exclusive: false });
  assert.deepEqual(ladder.outcomes.map((o) => o.label), ['$60k', '$62k', '$63k', '$65k']);
  assert.equal(ladder.n_outcomes, 7);

  // Quando só um resultado pode acontecer, continuam valendo os mais prováveis.
  const exclusive = normalizeKalshiEvent({ ...base, mutually_exclusive: true });
  assert.deepEqual(exclusive.outcomes.map((o) => o.label), ['$57k', '$58k', '$60k', '$62k']);
});

test('jogo na Polymarket mostra o vencedor, não as linhas de handicap', () => {
  const market = (question, outcomes, prices, sportsMarketType) => ({
    question,
    groupItemTitle: question,
    outcomes: JSON.stringify(outcomes),
    outcomePrices: JSON.stringify(prices.map(String)),
    active: true,
    closed: false,
    sportsMarketType,
    oneDayPriceChange: 0.04,
    volume24hr: 1000,
  });
  const game = normalizePolymarketEvent({
    id: 1,
    slug: 'nba-lal-bos',
    title: 'Lakers vs. Celtics',
    volume24hr: 5000,
    tags: [{ label: 'Sports' }, { label: 'NBA' }],
    markets: [
      market('O/U 220.5', ['Over', 'Under'], [0.97, 0.03], 'totals'),
      market('Spread -3.5', ['Lakers', 'Celtics'], [0.95, 0.05], 'spreads'),
      market('Lakers vs. Celtics', ['Lakers', 'Celtics'], [0.38, 0.62], 'moneyline'),
    ],
  });
  assert.deepEqual(game.outcomes.map((o) => [o.label, o.prob, o.change_24h]), [
    ['Celtics', 0.62, -0.04],
    ['Lakers', 0.38, 0.04],
  ]);
  assert.equal(game.n_outcomes, 2);

  // Futebol: três mercados Sim/Não (casa, empate, fora), todos "moneyline".
  const soccer = normalizePolymarketEvent({
    id: 2,
    slug: 'epl-ars-che',
    title: 'Arsenal vs. Chelsea',
    volume24hr: 5000,
    tags: [{ label: 'Sports' }, { label: 'Soccer' }],
    markets: [
      market('Arsenal', ['Yes', 'No'], [0.5, 0.5], 'moneyline'),
      market('Draw', ['Yes', 'No'], [0.27, 0.73], 'moneyline'),
      market('Chelsea', ['Yes', 'No'], [0.23, 0.77], 'moneyline'),
      market('O/U 2.5', ['Over', 'Under'], [0.55, 0.45], 'totals'),
    ],
  });
  assert.deepEqual(soccer.outcomes.map((o) => [o.label, o.prob]), [['Arsenal', 0.5], ['Draw', 0.27], ['Chelsea', 0.23]]);
});
