// Servidor simulado das duas APIs, no formato documentado (dados inventados, só para teste).
import http from 'node:http';

const DAY = 86400;
const TITLES = [
  'Who will win the 2028 Democratic presidential nomination?',
  'Lakers at Celtics',
  'Highest temperature in New York City tomorrow?',
  'Will the US enter a recession before the end of 2027?',
  'Best Picture at the 2027 Academy Awards',
  'Ethereum price at the end of November?',
  'Next Prime Minister of the United Kingdom',
  'How many Fed rate cuts in 2027?',
  'Premier League winner 2026-27',
  'Will OpenAI announce a new flagship model before January?',
  'Brazil Selic rate after the December Copom meeting',
  'US unemployment rate in November?',
];
const KALSHI_CATEGORIES = ['Politics', 'Sports', 'Climate and Weather', 'Economics', 'Entertainment', 'Crypto', 'World', 'Economics', 'Sports', 'Science and Technology', 'Economics', 'Economics'];
const POLY_TAGS = [['Politics', 'Elections'], ['Sports', 'NBA'], ['Weather'], ['Economy'], ['Culture', 'Movies'], ['Crypto', 'Ethereum'], ['World', 'UK'], ['Economy', 'Fed'], ['Sports', 'Soccer'], ['Tech', 'AI'], ['Economy', 'Brazil'], ['Economy']];

const money = (x) => x.toFixed(4);
const fp = (x) => x.toFixed(2);
const daysAgo = (days) => new Date(Date.now() - days * DAY * 1000).toISOString();

// ------------------------------------------------------------------ Kalshi

function kMarket(ticker, label, { bid, ask, last, prev, vol24, vol, oi, opened = 3, status = 'active', close = '2026-12-10T19:00:00Z' }) {
  return {
    ticker,
    event_ticker: ticker.split('-').slice(0, 2).join('-'),
    market_type: 'binary',
    title: '',
    yes_sub_title: label,
    no_sub_title: label,
    status,
    open_time: daysAgo(opened),
    close_time: close,
    yes_bid_dollars: money(bid),
    yes_ask_dollars: money(ask),
    no_bid_dollars: money(1 - ask),
    no_ask_dollars: money(1 - bid),
    last_price_dollars: money(last),
    previous_price_dollars: money(prev),
    volume_fp: fp(vol),
    volume_24h_fp: fp(vol24),
    open_interest_fp: fp(oi),
  };
}

function kEvent(event_ticker, series_ticker, title, sub_title, category, markets) {
  return { event_ticker, series_ticker, title, sub_title, category, mutually_exclusive: true, markets };
}

export function kalshiEvents() {
  const named = [
    // Aberto há 90 dias: semana e mês dependem dos candles; ano é o total.
    kEvent('KXFEDDECISION-26DEC', 'KXFEDDECISION', 'Fed decision in December?', 'Dec 9 meeting', 'Economics', [
      kMarket('KXFEDDECISION-26DEC-C25', 'Cut 25bps', { bid: 0.7, ask: 0.72, last: 0.71, prev: 0.67, vol24: 2100000, vol: 31000000, oi: 9000000, opened: 90 }),
      kMarket('KXFEDDECISION-26DEC-H0', 'No change', { bid: 0.23, ask: 0.25, last: 0.24, prev: 0.27, vol24: 1500000, vol: 22000000, oi: 7000000, opened: 90 }),
      kMarket('KXFEDDECISION-26DEC-C50', 'Cut 50bps', { bid: 0.03, ask: 0.04, last: 0.04, prev: 0.05, vol24: 400000, vol: 6000000, oi: 2000000, opened: 90 }),
      kMarket('KXFEDDECISION-26DEC-H25', 'Hike 25bps', { bid: 0.0, ask: 0.01, last: 0.01, prev: 0.01, vol24: 90000, vol: 900000, oi: 400000, opened: 90 }),
      kMarket('KXFEDDECISION-26DEC-C75', 'Cut 75bps+', { bid: 0.0, ask: 0.01, last: 0.0, prev: 0.0, vol24: 10000, vol: 100000, oi: 50000, opened: 90 }),
      // Já liquidado: conta no volume, não aparece como resultado.
      kMarket('KXFEDDECISION-26DEC-OLD', 'Emergency cut before Dec', { bid: 0, ask: 0, last: 0.01, prev: 0.01, vol24: 100000, vol: 800000, oi: 0, opened: 90, status: 'finalized' }),
    ]),
    // Aberto há 5 dias: todas as janelas são o total.
    kEvent('KXNFLGAME-26NOV15KCBUF', 'KXNFLGAME', 'Kansas City at Buffalo', 'Nov 15', 'Sports', [
      kMarket('KXNFLGAME-26NOV15KCBUF-BUF', 'Buffalo', { bid: 0.57, ask: 0.58, last: 0.58, prev: 0.52, vol24: 5200000, vol: 7400000, oi: 3100000, opened: 5, close: '2026-11-16T04:00:00Z' }),
      kMarket('KXNFLGAME-26NOV15KCBUF-KC', 'Kansas City', { bid: 0.42, ask: 0.43, last: 0.42, prev: 0.48, vol24: 4800000, vol: 6900000, oi: 2900000, opened: 5, close: '2026-11-16T04:00:00Z' }),
    ]),
    kEvent('KXCPIYOY-26NOV', 'KXCPIYOY', 'CPI year-over-year in November?', '', 'Economics', [
      // Spread largo: vale o último negócio.
      kMarket('KXCPIYOY-26NOV-T3.0', 'Above 3.0%', { bid: 0.3, ask: 0.55, last: 0.41, prev: 0.4, vol24: 300000, vol: 2000000, oi: 800000, opened: 20 }),
      // Sem negócio e sem livro: probabilidade nula.
      kMarket('KXCPIYOY-26NOV-T3.5', 'Above 3.5%', { bid: 0, ask: 1, last: 0, prev: 0, vol24: 0, vol: 0, oi: 0, opened: 20 }),
    ]),
    kEvent('KXBTCD-26NOV15', 'KXBTCD', 'Bitcoin price on Nov 15?', '5pm EST', 'Crypto', [
      kMarket('KXBTCD-26NOV15-T100K', '$100,000 or above', { bid: 0.61, ask: 0.63, last: 0.62, prev: 0.71, vol24: 900000, vol: 1200000, oi: 600000, opened: 1, close: '2026-11-15T22:00:00Z' }),
    ]),
    kEvent('KXNOVOL-26', 'KXNOVOL', 'Market that never traded', '', 'World', [
      kMarket('KXNOVOL-26-A', 'Yes', { bid: 0.1, ask: 0.9, last: 0, prev: 0, vol24: 0, vol: 0, oi: 0 }),
    ]),
    // Aberto há 500 dias: até o ano depende dos candles.
    kEvent('KXPRES-28', 'KXPRES', '2028 presidential election winner', '', 'Politics', [
      kMarket('KXPRES-28-D', 'Democratic', { bid: 0.52, ask: 0.53, last: 0.52, prev: 0.52, vol24: 50000, vol: 40000000, oi: 12000000, opened: 500, close: '2028-11-07T12:00:00Z' }),
    ]),
  ];
  const filler = [];
  for (let i = 0; i < 420; i++) {
    const vol24 = Math.round(250000 / (i + 1));
    filler.push(
      kEvent(`KXFILL-${i}`, 'KXFILL', TITLES[i % TITLES.length], '', KALSHI_CATEGORIES[i % TITLES.length], [
        kMarket(`KXFILL-${i}-Y`, 'Yes', { bid: 0.45, ask: 0.47, last: 0.46, prev: 0.46, vol24, vol: vol24 * 9, oi: vol24 * 2 }),
      ]),
    );
  }
  // Mistura a ordem: a API não devolve por volume.
  return [...filler.slice(0, 150), named[3], named[5], ...filler.slice(150, 300), named[0], named[4], named[2], ...filler.slice(300), named[1]];
}

/** Candles diários: cada dia repete o volume de 24h do mercado, terminando no end_ts pedido. */
function kalshiCandles(event, startTs, endTs) {
  const count = Math.max(0, Math.floor((endTs - startTs) / DAY));
  return {
    market_tickers: event.markets.map((m) => m.ticker),
    market_candlesticks: event.markets.map((m) =>
      Array.from({ length: count }, (_, k) => ({
        end_period_ts: endTs - k * DAY,
        volume_fp: m.volume_24h_fp,
        open_interest_fp: m.open_interest_fp,
        price: { close_dollars: m.last_price_dollars },
      })).reverse(),
    ),
    adjusted_end_ts: endTs,
  };
}

// -------------------------------------------------------------- Polymarket

function pMarket(id, question, group, outcomes, prices, { change = null, vol24 = 0, closed = false } = {}) {
  return {
    id: String(id),
    question,
    groupItemTitle: group,
    outcomes: JSON.stringify(outcomes), // a Gamma manda arrays como texto JSON
    outcomePrices: JSON.stringify(prices.map(String)),
    active: true,
    closed,
    archived: false,
    oneDayPriceChange: change,
    volume24hr: vol24,
    volume: String(vol24 * 12),
  };
}

function pEvent(id, slug, title, vol24, tags, markets, { week = 5, month = 18, year = 60 } = {}) {
  const scale = (factor) => (vol24 === null ? null : vol24 * factor);
  return {
    id: String(id),
    slug,
    title,
    active: true,
    closed: false,
    archived: false,
    volume24hr: vol24,
    volume1wk: scale(week),
    volume1mo: scale(month),
    volume1yr: scale(year),
    volume: scale(year + 10),
    liquidity: 500000,
    openInterest: 900000,
    endDate: '2026-12-31T12:00:00Z',
    tags: tags.map((label, i) => ({ id: String(i), label, slug: label.toLowerCase() })),
    markets,
  };
}

export function polymarketEvents() {
  const named = [
    pEvent(9001, 'fed-decision-in-december', 'Fed decision in December?', 8400000, ['Economy', 'Fed'], [
      pMarket(1, 'Fed cuts 25 bps in December?', '25 bps decrease', ['Yes', 'No'], [0.705, 0.295], { change: 0.035, vol24: 4000000 }),
      pMarket(2, 'No change in December?', 'No change', ['Yes', 'No'], [0.245, 0.755], { change: -0.03, vol24: 3000000 }),
      pMarket(3, 'Fed cuts 50+ bps in December?', '50+ bps decrease', ['Yes', 'No'], [0.04, 0.96], { change: -0.005, vol24: 1000000 }),
      pMarket(4, 'Fed hikes in December?', '25+ bps increase', ['Yes', 'No'], [0.006, 0.994], { change: 0, vol24: 300000 }),
      pMarket(5, 'Old bucket', 'Resolved bucket', ['Yes', 'No'], [0, 1], { vol24: 100000, closed: true }),
    ]),
    // Jogo de um dia: grande no dia, pequeno nas janelas longas.
    pEvent(9002, 'nfl-kc-buf-2026-11-15', 'Chiefs vs. Bills', 6100000, ['Sports', 'NFL'], [
      pMarket(10, 'Chiefs vs. Bills', '', ['Chiefs', 'Bills'], [0.425, 0.575], { change: -0.06, vol24: 6100000 }),
    ], { week: 1.2, month: 1.2, year: 1.2 }),
    // Mercado longo: modesto no dia, o maior do ano.
    pEvent(9003, 'will-bitcoin-hit-150k-in-2026', 'Will Bitcoin hit $150k in 2026?', 2500000, ['Crypto'], [
      pMarket(20, 'Will Bitcoin hit $150k in 2026?', '', ['Yes', 'No'], [0.125, 0.875], { change: 0.02, vol24: 2500000 }),
    ], { week: 6, month: 40, year: 400 }),
    // Volume nulo: num ORDER BY ... DESC do Postgres, estes vêm na frente.
    pEvent(9004, 'brand-new-event', 'Brand new event without stats', null, ['Culture'], [
      pMarket(30, 'Brand new?', '', ['Yes', 'No'], [0.5, 0.5]),
    ]),
  ];
  const filler = [];
  for (let i = 0; i < 230; i++) {
    const vol24 = Math.round(900000 / (i + 1));
    const k = (i + 5) % TITLES.length;
    filler.push(
      pEvent(1000 + i, `filler-${i}`, TITLES[k], vol24, POLY_TAGS[k], [
        pMarket(100 + i, TITLES[k], '', ['Yes', 'No'], [0.33, 0.67], { change: 0.01, vol24 }),
      ]),
    );
  }
  // Ordem padrão embaralhada (determinística), como numa listagem por id.
  const mixed = filler
    .map((event, i) => ({ event, key: (i * 97) % 230 }))
    .sort((a, b) => a.key - b.key)
    .map(({ event }) => event);
  return [...mixed.slice(0, 120), named[1], named[3], ...mixed.slice(120), named[2], named[0]];
}

// ----------------------------------------------------------------- servidor

const CAMEL_ORDER = ['volume24hr', 'volume1wk', 'volume1mo', 'volume1yr'];
const snake = (field) => field.replace(/^volume/, 'volume_');

/**
 * scenario.kalshi:  'ok' | 'down' | 'flaky'
 * scenario.candles: 'ok' | 'down'
 * scenario.poly:    uma ou mais de 'ignore-order' | 'reject-camel' | 'no-keyset' | 'offset-limit' | 'down'
 */
export function startMock(scenario = {}) {
  const kalshi = kalshiEvents();
  const poly = polymarketEvents();
  const hits = { kalshi: 0, candles: 0, poly: 0 };
  const polyFlags = new Set([].concat(scenario.poly ?? []));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (url.pathname === '/trade-api/v2/events') {
      hits.kalshi += 1;
      if (scenario.kalshi === 'down') return send(500, '{"error":"internal"}');
      if (scenario.kalshi === 'flaky' && hits.kalshi <= 2) return send(429, '{"error":"slow down"}', { 'retry-after': '0' });
      if (url.searchParams.get('status') !== 'open' || url.searchParams.get('with_nested_markets') !== 'true') {
        return send(400, '{"error":"bad params"}');
      }
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 200);
      const start = Number(url.searchParams.get('cursor') || 0);
      const slice = kalshi.slice(start, start + limit);
      const next = start + limit < kalshi.length ? String(start + limit) : '';
      return send(200, { events: slice, cursor: next });
    }

    const candleRoute = url.pathname.match(/^\/trade-api\/v2\/series\/([^/]+)\/events\/([^/]+)\/candlesticks$/);
    if (candleRoute) {
      hits.candles += 1;
      if (scenario.candles === 'down') return send(401, '{"error":"unauthorized"}');
      const event = kalshi.find((e) => e.event_ticker === decodeURIComponent(candleRoute[2]) && e.series_ticker === decodeURIComponent(candleRoute[1]));
      if (!event) return send(404, '{"error":"not found"}');
      if (url.searchParams.get('period_interval') !== '1440') return send(400, '{"error":"bad interval"}');
      return send(200, kalshiCandles(event, Number(url.searchParams.get('start_ts')), Number(url.searchParams.get('end_ts'))));
    }

    if (url.pathname === '/events' || url.pathname === '/events/keyset') {
      hits.poly += 1;
      const keyset = url.pathname === '/events/keyset';
      if (polyFlags.has('down')) return send(503, 'upstream unavailable');
      if (keyset && (polyFlags.has('no-keyset') || polyFlags.has('offset-limit'))) return send(404, '{"error":"not found"}');
      if (keyset && url.searchParams.has('offset')) return send(422, '{"error":"offset is not supported, use after_cursor"}');
      const order = url.searchParams.get('order');
      if (polyFlags.has('reject-camel') && CAMEL_ORDER.includes(order)) return send(422, '{"type":"validation error","error":"order fields are not valid"}');
      let list = poly.filter((e) => e.active && !e.closed);
      const field = CAMEL_ORDER.find((f) => f === order || snake(f) === order);
      if (field && !polyFlags.has('ignore-order')) {
        // NULLS FIRST, como um ORDER BY ... DESC de Postgres.
        list = list.slice().sort((a, b) => (b[field] ?? Infinity) - (a[field] ?? Infinity));
      }
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);
      if (keyset) {
        const start = Number(url.searchParams.get('after_cursor') || 0);
        const slice = list.slice(start, start + limit);
        // O cursor só vem quando a página voltou cheia.
        return send(200, slice.length === limit ? { events: slice, next_cursor: String(start + limit) } : { events: slice });
      }
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (polyFlags.has('offset-limit') && offset >= 200) {
        return send(422, '{"type":"validation error","error":"offset too large, use /events/keyset for deeper pagination"}');
      }
      return send(200, list.slice(offset, offset + limit));
    }

    send(404, '{"error":"not found"}');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        hits,
        kalshiBase: `http://127.0.0.1:${port}/trade-api/v2`,
        gammaBase: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (process.argv[2] === 'serve') {
  const mock = await startMock();
  console.log(JSON.stringify({ kalshiBase: mock.kalshiBase, gammaBase: mock.gammaBase }));
}
