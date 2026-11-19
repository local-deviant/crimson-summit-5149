// Token Radar v3 dashboard — reads window.RADAR from ../data.js and renders
// everything from it. No network, no other input. The plan shown in the
// detail view is the $1,000 ticket at a 7% drop share; the net grid beside it
// prices every other size, and the board's Net / Net-h / Verdict columns
// recompute live when the controls change.
(function () {
  const D = window.RADAR;
  if (!D) { document.body.innerHTML = '<p style="padding:24px">data.js did not load.</p>'; return; }
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const money = (n) => n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + n.toFixed(0);
  const money2 = (n) => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const pct = (n) => (n === null ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%');
  // The snapshot's change_7d is already a percent (+2.37 means +2.37%),
  // so it is shown as-is; the growth factor divides it by 100 instead.
  const sharePct = (s) => { const v = Math.round(s * 1000) / 10; return Number.isInteger(v) ? String(v) : v.toFixed(1); };
  const multFmt = (m) => (m < 0.01 ? '<0.01×' : m.toFixed(2) + '×');
  const x = (n) => 'x' + n.toFixed(2);
  const state = { tab: 'all', sort: 'rank', dir: 1, chain: '', cat: '', tvl: 0, move: '', deposit: 1000, share: 0.07, sel: D.rows[0].slug };
  const WATCH = new Set(D.watchlist_slugs || []);

  // --- net at the controls ---------------------------------------------------
  function netFor(r, dep, share) { return (dep / r.tvl_usd) * r.implied_value_usd * share - r.gas_usd; }
  function verdictFor(net) { return net > D.model.farm_net_threshold ? 'FARM' : net > 0 ? 'THIN' : 'SKIP'; }

  // --- KPI strip --------------------------------------------------------------
  (function () {
    const farm = D.rows.filter((r) => r.verdict === 'FARM').length;
    const best = Math.max.apply(null, D.rows.map((r) => r.net_per_hour_usd));
    const kpis = [
      ['Ranked', String(D.board_size)],
      ['Total implied', money(D.total_implied_usd)],
      ['LOO (held-out)', x(D.validation.loo_median)],
      ['Range holds', Math.round(D.validation.range_hold * 100) + '%'],
      ['Worth farming', farm + ' FARM'],
      ['Best per hour', money2(best)],
    ];
    $('kpis').innerHTML = kpis.map(([l, v]) => '<div class="kpi"><b>' + v + '</b><span>' + l + '</span></div>').join('');
    $('meta').textContent = 'Snapshot ' + D.as_of + ' · ' + D.board_size + ' ranked of 758 protocols · watchlist ' + D.watchlist_size + '/40 · model ' + D.model_version;
    $('modelVer').textContent = D.model_version;
  })();

  // --- filters ----------------------------------------------------------------
  (function () {
    const chains = [...new Set(D.rows.flatMap((r) => r.chains))].sort();
    const cats = [...new Set(D.rows.map((r) => r.category))].sort();
    $('chainFilter').innerHTML += chains.map((c) => '<option>' + esc(c) + '</option>').join('');
    $('catFilter').innerHTML += cats.map((c) => '<option>' + esc(c) + '</option>').join('');
  })();

  // --- tabs -------------------------------------------------------------------
  const TABS = [['all', 'All'], ['watchlist', 'Watchlist'], ['FARM', 'FARM'], ['THIN', 'THIN'], ['SKIP', 'SKIP'],
    ['below', 'Below floor'], ['trades', 'Token trades'], ['aside', 'Set aside'], ['method', 'Method']];
  $('tabs').innerHTML = TABS.map(([k, l]) => '<button type="button" data-tab="' + k + '"' + (k === 'all' ? ' class="on"' : '') + '>' + l + '</button>').join('');
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    setTab(b.dataset.tab);
  });
  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === 'method') { renderBoard(); document.getElementById('method').scrollIntoView(); return; }
    renderBoard();
  }

  function filtered() {
    let rows = D.rows.slice();
    if (state.tab === 'watchlist') rows = rows.filter((r) => WATCH.has(r.slug));
    else if (state.tab === 'FARM' || state.tab === 'THIN' || state.tab === 'SKIP') rows = rows.filter((r) => verdictFor(netFor(r, state.deposit, state.share)) === state.tab);
    else if (state.tab === 'below') rows = rows.filter((r) => r.tvl_usd < D.floor_usd);
    if (state.chain) rows = rows.filter((r) => r.chains.includes(state.chain));
    if (state.cat) rows = rows.filter((r) => r.category === state.cat);
    if (state.tvl) rows = rows.filter((r) => r.tvl_usd >= state.tvl);
    if (state.move === 'up') rows = rows.filter((r) => r.change_7d !== null && r.change_7d > 0);
    if (state.move === 'down') rows = rows.filter((r) => r.change_7d !== null && r.change_7d < 0);
    const key = state.sort;
    const val = (r) => key === 'rank' ? r.rank : key === 'name' ? r.name : key === 'category' ? r.category
      : key === 'tvl' ? r.tvl_usd : key === 'change' ? (r.change_7d === null ? -9 : r.change_7d)
      : key === 'implied' ? r.implied_value_usd : key === 'odds' ? r.launch_odds
      : key === 'net' ? netFor(r, state.deposit, state.share)
      : key === 'perhour' ? netFor(r, state.deposit, state.share) / D.model.plan_hours
      : key === 'verdict' ? { FARM: 0, THIN: 1, SKIP: 2 }[verdictFor(netFor(r, state.deposit, state.share))] : r.rank;
    rows.sort((a, b) => {
      const va = val(a), vb = val(b);
      return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * state.dir;
    });
    return rows;
  }

  function renderBoard() {
    const board = $('board'), body = $('boardBody');
    if (state.tab === 'trades' || state.tab === 'aside') {
      board.style.display = 'none';
      let g = $('groupTable');
      if (!g) { g = document.createElement('div'); g.id = 'groupTable'; board.after(g); }
      if (state.tab === 'trades') {
        const gs = D.groups.token_trades;
        g.innerHTML = '<p class="count">Token trades — ' + gs.length + ' protocols whose token already trades, so the board does not price them.</p>'
          + '<table class="board"><thead><tr><th>Protocol</th><th>Category</th><th>TVL</th><th>Market cap</th></tr></thead><tbody>'
          + gs.map((r) => '<tr><td>' + esc(r.name) + '</td><td>' + esc(r.category || '—') + '</td><td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + money(r.mcap_usd) + '</td></tr>').join('') + '</tbody></table>';
      } else {
        const gs = D.groups.set_aside;
        g.innerHTML = '<p class="count">Set aside — ' + gs.length + ' pre-token protocols that are not launch candidates under the board rule.</p>'
          + '<table class="board"><thead><tr><th>Protocol</th><th>Category</th><th>TVL</th><th>Why set aside</th></tr></thead><tbody>'
          + gs.map((r) => '<tr><td>' + esc(r.name) + '</td><td>' + esc(r.category || '—') + '</td><td class="num">' + money(r.tvl_usd) + '</td><td>' + esc(r.reason) + '</td></tr>').join('') + '</tbody></table>';
      }
      $('count').textContent = '';
      return;
    }
    board.style.display = '';
    const g = $('groupTable'); if (g) g.remove();
    const rows = filtered();
    body.innerHTML = rows.map((r) => {
      const net = netFor(r, state.deposit, state.share);
      const v = verdictFor(net);
      return '<tr data-slug="' + r.slug + '"' + (r.slug === state.sel ? ' class="sel"' : '') + '>'
        + '<td class="num">' + r.rank + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.category) + '</td>'
        + '<td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + pct(r.change_7d) + '</td>'
        + '<td class="num">' + money(r.implied_value_usd) + '</td><td class="num">' + r.launch_odds.toFixed(2) + '</td>'
        + '<td class="num">' + money2(net) + '</td><td class="num">' + money2(net / D.model.plan_hours) + '</td>'
        + '<td><span class="pill ' + v + '">' + v + '</span></td></tr>';
    }).join('');
    $('count').textContent = rows.length + ' of ' + D.board_size + ' rows · deposit $' + state.deposit.toLocaleString('en-US')
      + ' · drop share ' + sharePct(state.share) + '% · FARM beats $' + D.model.farm_net_threshold + ' net';
  }

  $('board').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = 1; }
      renderBoard(); return;
    }
    const tr = e.target.closest('tr[data-slug]');
    if (tr) { state.sel = tr.dataset.slug; renderBoard(); renderDetail(); }
  });

  // --- detail -----------------------------------------------------------------
  function renderDetail() {
    const r = D.rows.find((x) => x.slug === state.sel) || D.rows[0];
    const net = netFor(r, state.deposit, state.share);
    const v = verdictFor(net);
    const exit = r.tvl_usd * 0.7;
    const cells = [
      ['Implied value', money(r.implied_value_usd)],
      ['Value if it launches', money(r.value_if_launches_usd)],
      ['Launch odds', r.launch_odds.toFixed(2)],
      ['Net ($' + state.deposit.toLocaleString('en-US') + ' @ ' + sharePct(state.share) + '%)', money2(net)],
      ['Net per hour', money2(net / D.model.plan_hours)],
      ['TVL', money(r.tvl_usd)],
      ['7-day change', pct(r.change_7d)],
      ['Rank range (p10–p90)', r.rank_p10 + '–' + r.rank_p90 + ' (full ' + r.rank_min + '–' + r.rank_max + ')'],
    ];
    const grid = [1000, 10000].map((dep) => [0.035, 0.07, 0.14].map((sh) => {
      const n = netFor(r, dep, sh);
      const on = dep === state.deposit && sh === state.share;
      return '<td class="num"' + (on ? ' style="background:#fdf6e3;font-weight:700"' : '') + '>' + money2(n) + '</td>';
    }).join('')).map((row, i) => '<tr><th>$' + [1000, 10000][i].toLocaleString('en-US') + '</th>' + row + '</tr>').join('');
    $('detail').innerHTML = '<h2>#' + r.rank + ' ' + esc(r.name) + ' <span class="pill ' + v + '">' + v + '</span></h2>'
      + '<p class="sub">' + esc(r.category) + ' · ' + r.chains.map(esc).join(', ') + ' · age ' + (r.age_days === null ? 'unknown' : r.age_days + ' days')
      + ' · multiple ' + r.multiple.toFixed(2) + ' · growth ×' + r.growth_multiplier.toFixed(2) + '</p>'
      + '<div class="grid">' + cells.map(([l, val]) => '<div class="cell"><b>' + val + '</b><span>' + l + '</span></div>').join('') + '</div>'
      + '<p><strong>Why the odds are ' + r.launch_odds.toFixed(2) + '.</strong> ' + r.peers_with_token + ' of ' + r.peers_n + ' ' + esc(r.category)
      + ' peers record a token now; corrected for their ages, P(ever) = ' + r.launch_p_ever.toFixed(2) + '. At ' + (r.age_days === null ? 'an unknown age' : r.age_days + ' days')
      + ', F(age) = ' + r.launch_f_age.toFixed(2) + ', so odds = (' + r.launch_p_ever.toFixed(2) + ' − ' + r.launch_p_ever.toFixed(2) + '×' + r.launch_f_age.toFixed(2)
      + ') / (1 − ' + r.launch_p_ever.toFixed(2) + '×' + r.launch_f_age.toFixed(2) + ') = ' + r.launch_odds.toFixed(2) + '.</p>'
      + '<h3>Net by deposit and drop share (gas ' + money2(r.gas_usd) + ' already taken off)</h3>'
      + '<table><thead><tr><th>Deposit</th><th>3.5%</th><th>7%</th><th>14%</th></tr></thead><tbody>' + grid + '</tbody></table>'
      + '<h3>Nearest traded comparables</h3>'
      + '<table><thead><tr><th>Protocol</th><th>TVL</th><th>Market cap</th><th>Multiple</th></tr></thead><tbody>'
      + r.comparables.map((c) => '<tr><td>' + esc(c.name) + '</td><td class="num">' + money(c.tvl_usd) + '</td><td class="num">' + money(c.mcap_usd) + '</td><td class="num">' + multFmt(c.mcap_usd / c.tvl_usd) + '</td></tr>').join('')
      + '</tbody></table>'
      + '<h3>Farm plan — $1,000 ticket at a 7% drop share</h3><ol>'
      + r.farm_steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>'
      + '<p>Review on <strong>' + D.model.review_date + '</strong> (84 days after the snapshot). Withdraw if TVL falls under <strong>' + money(exit) + '</strong> (70% of the snapshot TVL), if withdrawals pause, or once a token is announced.</p>';
  }

  // --- summary ----------------------------------------------------------------
  $('summaryBtn').addEventListener('click', () => {
    const s = $('summary');
    if (!s.hidden) { s.hidden = true; $('summaryBtn').textContent = 'Show summary'; return; }
    const farm = D.rows.filter((r) => r.verdict === 'FARM').sort((a, b) => b.net_per_hour_usd - a.net_per_hour_usd).slice(0, 5);
    s.innerHTML = '<h2>Summary</h2><p>' + D.board_size + ' protocols ranked; total implied ' + money(D.total_implied_usd)
      + '. ' + D.rows.filter((r) => r.verdict === 'FARM').length + ' FARM, ' + D.rows.filter((r) => r.verdict === 'THIN').length
      + ' THIN, ' + D.rows.filter((r) => r.verdict === 'SKIP').length + ' SKIP on a $1,000 ticket at 7%. The big rows are SKIP or THIN — a $1,000 deposit in a $2.8B protocol buys about $1.41 of expected drop against $30 of gas — and the FARM rows are the small ones.</p>'
      + '<h3>Best net per hour</h3><table><thead><tr><th>#</th><th>Protocol</th><th>TVL</th><th>Implied</th><th>Net</th><th>Net/h</th></tr></thead><tbody>'
      + farm.map((r) => '<tr><td>' + r.rank + '</td><td>' + esc(r.name) + '</td><td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + money(r.implied_value_usd) + '</td><td class="num">' + money2(r.net_usd) + '</td><td class="num">' + money2(r.net_per_hour_usd) + '</td></tr>').join('')
      + '</tbody></table><p>Validation: LOO ' + x(D.validation.loo_median) + ', walk-forward ' + x(D.validation.walk_forward_median)
      + ', time split ' + x(D.validation.time_split_median) + ', range-hold ' + Math.round(D.validation.range_hold * 100)
      + '% (' + D.validation.range_hold_n + ' of ' + D.validation.range_hold_denom + ' comps within 3×). The age term was tested and rejected: walk-forward x5.80 with it, x2.40 without.</p>';
    s.hidden = false;
    $('summaryBtn').textContent = 'Hide summary';
    s.scrollIntoView();
  });

  // --- CSV --------------------------------------------------------------------
  $('csvBtn').addEventListener('click', () => {
    const rows = filtered();
    const head = 'rank,slug,name,category,chains,tvl_usd,change_7d,implied_value_usd,launch_odds,net_usd,net_per_hour_usd,verdict\n';
    const body = rows.map((r) => {
      const net = netFor(r, state.deposit, state.share);
      return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', '"' + (r.category || '').replace(/"/g, '""') + '"',
        '"' + r.chains.join(';') + '"', r.tvl_usd, r.change_7d === null ? '' : r.change_7d,
        r.implied_value_usd, r.launch_odds.toFixed(3), net.toFixed(2), (net / D.model.plan_hours).toFixed(2), verdictFor(net)].join(',');
    }).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([head + body], { type: 'text/csv' }));
    a.download = 'token-radar-v3-board.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // --- controls ----------------------------------------------------------------
  $('planSize').addEventListener('change', (e) => { state.deposit = +e.target.value; renderBoard(); renderDetail(); });
  $('dropShare').addEventListener('change', (e) => { state.share = +e.target.value; renderBoard(); renderDetail(); });
  $('chainFilter').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
  $('catFilter').addEventListener('change', (e) => { state.cat = e.target.value; renderBoard(); });
  $('tvlFilter').addEventListener('change', (e) => { state.tvl = +e.target.value; renderBoard(); });
  $('moveFilter').addEventListener('change', (e) => { state.move = e.target.value; renderBoard(); });

  // --- method section -----------------------------------------------------------
  (function () {
    const v = D.validation;
    $('validation').innerHTML = '<table><thead><tr><th>Test</th><th>Result</th><th>What it means</th></tr></thead><tbody>'
      + '<tr><td>Leave-one-out (median)</td><td>' + x(v.loo_median) + '</td><td>each comp priced without itself; mean ' + x(v.loo_mean) + ' is outlier-driven</td></tr>'
      + '<tr><td>Walk-forward</td><td>' + x(v.walk_forward_median) + '</td><td>fit before 2025-01-01, tested after</td></tr>'
      + '<tr><td>Time split</td><td>' + x(v.time_split_median) + '</td><td>oldest half fit, newest half tested</td></tr>'
      + '<tr><td>Range-hold</td><td>' + Math.round(v.range_hold * 100) + '%</td><td>' + v.range_hold_n + ' of ' + v.range_hold_denom + ' comps inside 3×</td></tr>'
      + '<tr><td>Spearman (implied vs TVL rank)</td><td>' + v.spearman.toFixed(3) + '</td><td>the board mostly follows size, with the odds reordering it</td></tr>'
      + '</tbody></table>';
    $('ablation').innerHTML = '<table><thead><tr><th>Variant</th><th>LOO</th><th>Note</th></tr></thead><tbody>'
      + v.ablation.map((a) => '<tr><td>' + esc(a.variant) + '</td><td>' + x(a.loo_median) + '</td><td>' + esc(a.note) + '</td></tr>').join('')
      + '</tbody></table>';
    $('rejected').innerHTML = '<table><thead><tr><th>Variant</th><th>Why it was rejected</th></tr></thead><tbody>'
      + v.rejected.map((a) => '<tr><td>' + esc(a.variant) + '</td><td>' + esc(a.reason) + '</td></tr>').join('')
      + '</tbody></table>';
    $('ledgerBody').innerHTML = '<table><thead><tr><th>Group</th><th>N</th><th>Note</th></tr></thead><tbody>'
      + D.ledger.map((l) => '<tr><td>' + esc(l.label) + '</td><td>' + l.n + '</td><td>' + esc(l.note) + '</td></tr>').join('')
      + '<tr><td><strong>Total</strong></td><td><strong>' + D.ledger.reduce((s, l) => s + l.n, 0) + '</strong></td><td></td></tr></tbody></table>';
  })();

  // --- scatter ------------------------------------------------------------------
  (function () {
    const pts = D.comps;
    const xs = pts.map((p) => Math.log(p.tvl_usd)), ys = pts.map((p) => Math.log(p.mcap_usd));
    const x0 = Math.min.apply(null, xs) - 0.4, x1 = Math.max.apply(null, xs) + 0.4;
    const y0 = Math.min.apply(null, ys) - 0.5, y1 = Math.max.apply(null, ys) + 0.5;
    const W = 880, H = 300, L = 56, R = 14, T = 12, B = 34;
    const X = (v) => L + (v - x0) / (x1 - x0) * (W - L - R);
    const Y = (v) => T + (y1 - v) / (y1 - y0) * (H - T - B);
    const tick = (v) => '$' + (Math.exp(v) >= 1e9 ? (Math.exp(v) / 1e9).toFixed(0) + 'B' : Math.exp(v) >= 1e6 ? (Math.exp(v) / 1e6).toFixed(0) + 'M' : (Math.exp(v) / 1e3).toFixed(0) + 'K');
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Scatter of the 71 comps against the fitted curve">';
    // 3x band
    const band = (off) => 'M' + X(x0) + ',' + Y(D.model.intercept + D.model.slope * x0 + off) + ' L' + X(x1) + ',' + Y(D.model.intercept + D.model.slope * x1 + off);
    s += '<path d="' + band(Math.log(3)) + ' L' + X(x1) + ',' + Y(D.model.intercept + D.model.slope * x1 - Math.log(3)) + ' L' + X(x0) + ',' + Y(D.model.intercept + D.model.slope * x0 - Math.log(3)) + ' Z" fill="#eef2f6"/>';
    // grid + ticks
    for (let lv = Math.ceil(x0); lv <= x1; lv++) {
      s += '<line x1="' + X(lv) + '" y1="' + T + '" x2="' + X(lv) + '" y2="' + (H - B) + '" stroke="#e3e8ee"/>';
      s += '<text x="' + X(lv) + '" y="' + (H - 12) + '" font-size="10" fill="#5b6b7c" text-anchor="middle">' + tick(lv) + '</text>';
    }
    for (let lv = Math.ceil(y0); lv <= y1; lv++) {
      s += '<text x="' + (L - 6) + '" y="' + (Y(lv) + 3) + '" font-size="10" fill="#5b6b7c" text-anchor="end">' + tick(lv) + '</text>';
    }
    s += '<text x="' + (W / 2) + '" y="' + (H - 0) + '" font-size="11" fill="#5b6b7c" text-anchor="middle">TVL (log scale)</text>';
    s += '<text x="12" y="' + (H / 2) + '" font-size="11" fill="#5b6b7c" transform="rotate(-90 12 ' + (H / 2) + ')" text-anchor="middle">Market cap (log scale)</text>';
    // curve
    s += '<path d="' + band(0) + '" stroke="#b7791f" stroke-width="2" fill="none"/>';
    // points
    s += pts.map((p) => {
      const px = Math.log(p.tvl_usd), py = Math.log(p.mcap_usd);
      const pred = D.model.intercept + D.model.slope * px;
      const inside = Math.abs(py - pred) <= Math.log(3);
      return '<circle cx="' + X(px).toFixed(1) + '" cy="' + Y(py).toFixed(1) + '" r="3.2" fill="' + (inside ? '#14324f' : '#9b2c2c') + '"><title>' + esc(p.name) + ' — TVL ' + money(p.tvl_usd) + ', mcap ' + money(p.mcap_usd) + '</title></circle>';
    }).join('');
    s += '<text x="' + (W - R) + '" y="' + (T + 4) + '" font-size="11" fill="#5b6b7c" text-anchor="end">curve: ln(mcap) = 7.545 + 0.50 × ln(TVL) · band ±3× · red = outside the band</text>';
    s += '</svg>';
    $('scatter').innerHTML = s;
  })();

  // --- hash routing (for the screenshots) ---------------------------------------
  (function () {
    const h = location.hash.replace(/^#/, '');
    const m = h.match(/^detail=([\w-]+)$/);
    const t = h.match(/^tab=(\w+)$/);
    if (m && D.rows.some((r) => r.slug === m[1])) state.sel = m[1];
    if (t && TABS.some(([k]) => k === t[1])) state.tab = t[1];
    if (state.tab !== 'all') document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  })();

  renderBoard();
  renderDetail();
})();
