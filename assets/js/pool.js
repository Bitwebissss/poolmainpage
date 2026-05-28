(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────────
  const LS_THEME   = 'mp-theme';
  const LS_LANG    = 'mp-lang';
  const LS_BASE    = 'mp-base';
  const LS_POOL    = 'mp-pool';
  const LS_MINER   = 'mp-miner-'; // + poolId
  const PAGE_SIZE  = 20;
  const POLL_MS    = 60_000;
  const MINER_MS   = 30_000;

  // ─── State ────────────────────────────────────────────────────────────────
  const S = {
    base:       localStorage.getItem(LS_BASE) || 'https://pool.bitwebcore.net',
    poolId:     null,
    pool:       null,
    pollTimer:  null,
    mPollTimer: null,
    bPage:      0,
    mPage:      0,
    pPage:      0,
    ws:         null,
    wsRetry:    0,
    lang:       localStorage.getItem(LS_LANG) || 'en',
    theme:      localStorage.getItem(LS_THEME) || 'auto',
    activeTab:  'overview',
    renderedTabs: new Set(),
  };

  // ─── i18n ─────────────────────────────────────────────────────────────────
  const t = k => window.mpLang?.[S.lang]?.[k] ?? window.mpLang?.en?.[k] ?? k;

  const applyTkeys = () => {
    document.querySelectorAll('[data-tkey]').forEach(el => {
      const val = t(el.dataset.tkey);
      if (el.tagName === 'INPUT') el.placeholder = val;
      else el.textContent = val;
    });
  };

  // ─── DOM helpers ──────────────────────────────────────────────────────────
  const $   = id => document.getElementById(id);
  const mk  = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const txt = (tag, cls, text) => { const e = mk(tag, cls); e.textContent = String(text ?? ''); return e; };
  const clr = id => { const e = $(id); if (e) e.innerHTML = ''; };

  // ─── Security: safe text only, never innerHTML with user data ─────────────
  const safeText = v => String(v ?? '').trim();

  // ─── Format helpers ───────────────────────────────────────────────────────
  const fmt = {
    hash(h) {
      h = Number(h);
      if (!isFinite(h) || h <= 0) return '0 H/s';
      const u = ['H', 'KH', 'MH', 'GH', 'TH', 'PH'];
      const i = Math.min(Math.floor(Math.log10(h) / 3), u.length - 1);
      return `${(h / 10 ** (i * 3)).toFixed(2)} ${u[i]}/s`;
    },
    diff(d) {
      d = Number(d);
      if (!isFinite(d) || d <= 0) return '—';
      if (d < 1000) return d.toFixed(6);
      const u = ['', 'K', 'M', 'G', 'T', 'P'];
      const i = Math.min(Math.floor(Math.log10(d) / 3), u.length - 1);
      return `${(d / 10 ** (i * 3)).toFixed(3)} ${u[i]}`.trim();
    },
    num(n, dec = 4) {
      n = Number(n);
      if (!isFinite(n)) return '—';
      return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dec });
    },
    effort(e) {
      e = Number(e);
      if (!isFinite(e)) return '—';
      return `${(e * 100).toFixed(1)}%`;
    },
    effortClass(e) {
      const pct = Number(e) * 100;
      if (pct <= 100) return 'ok';
      if (pct <= 200) return 'warn';
      return 'high';
    },
    ttf(diff, hr) {
      diff = Number(diff); hr = Number(hr);
      if (!hr || hr <= 0 || !diff) return '—';
      const s = Math.round(diff / hr);
      if (s < 60)    return `${s}s`;
      if (s < 3600)  return `${Math.floor(s/60)}m ${s%60}s`;
      if (s < 86400) return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
      return `${Math.floor(s/86400)}d`;
    },
    interval(s) {
      s = Number(s);
      if (!s) return '—';
      if (s < 60)   return `${s}s`;
      if (s < 3600) return `${Math.floor(s/60)}m`;
      return `${Math.floor(s/3600)}h`;
    },
    addr(a, len = 12) {
      a = safeText(a);
      if (!a) return '—';
      if (a.length <= len * 2 + 1) return a;
      return `${a.slice(0, len)}…${a.slice(-6)}`;
    },
    time(d) {
      if (!d) return t('misc.na');
      const diff = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
      if (diff < 10)    return t('misc.just-now');
      if (diff < 60)    return `${diff}s ${t('misc.ago')}`;
      if (diff < 3600)  return `${Math.floor(diff/60)}m ${t('misc.ago')}`;
      if (diff < 86400) return `${Math.floor(diff/3600)}h ${t('misc.ago')}`;
      return `${Math.floor(diff/86400)}d ${t('misc.ago')}`;
    },
    absTime(d) {
      if (!d) return '—';
      return new Date(d).toLocaleString();
    },
  };

  // ─── API ──────────────────────────────────────────────────────────────────
  const api = {
    async _get(path) {
      const r = await fetch(`${S.base}${path}`, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    pools:         ()              => api._get('/api/pools'),
    pool:          id              => api._get(`/api/pools/${enc(id)}`),
    blocks:        (id, p, s)      => api._get(`/api/pools/${enc(id)}/blocks?page=${p}&pageSize=${s}`),
    miners:        (id, p, s)      => api._get(`/api/pools/${enc(id)}/miners?page=${p}&pageSize=${s}`),
    perf:          id              => api._get(`/api/pools/${enc(id)}/performance`),
    miner:         (id, a)         => api._get(`/api/pools/${enc(id)}/miners/${enc(a)}`),
    minerPerf:     (id, a)         => api._get(`/api/pools/${enc(id)}/miners/${enc(a)}/performance`),
    minerPayments: (id, a, p, s)   => api._get(`/api/pools/${enc(id)}/miners/${enc(a)}/payments?page=${p}&pageSize=${s}`),
  };
  const enc = v => encodeURIComponent(safeText(v));

  // ─── Theme ────────────────────────────────────────────────────────────────
  const applyTheme = () => {
    const html = document.documentElement;
    const eff = S.theme === 'auto'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : S.theme;
    html.setAttribute('data-bs-theme', eff);
    const lbl = $('theme-label');
    if (lbl) lbl.textContent = t(`theme.${S.theme}`);
    document.querySelectorAll('.mp-theme-menu .dropdown-item').forEach(item => {
      item.classList.toggle('active', item.dataset.theme === S.theme);
    });
  };

  // ─── Toast ────────────────────────────────────────────────────────────────
  const toast = (msg, icon = 'circle-info', type = 'info', dur = 4000) => {
    const box = $('mp-toasts');
    if (!box) return;
    const wrap = mk('div', `mp-toast ${type}`);
    const ico  = mk('i', `fa-solid fa-${icon}`);
    const lbl  = document.createTextNode(msg);
    wrap.append(ico, lbl);
    box.appendChild(wrap);
    setTimeout(() => wrap.remove(), dur);
  };

  // ─── WebSocket ────────────────────────────────────────────────────────────
  const wsConnect = () => {
    if (!S.base) return;
    try {
      const url = new URL(S.base);
      const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${url.host}/notifications`;
      wsDisconnect();
      S.ws = new WebSocket(wsUrl);
      S.ws.addEventListener('open', () => {
        S.wsRetry = 0;
        const dot = $('ws-dot');
        if (dot) dot.classList.add('connected');
      });
      S.ws.addEventListener('close', () => {
        const dot = $('ws-dot');
        if (dot) dot.classList.remove('connected');
        const delay = Math.min(1000 * 2 ** S.wsRetry, 30_000);
        S.wsRetry++;
        setTimeout(wsConnect, delay);
      });
      S.ws.addEventListener('error', () => {});
      S.ws.addEventListener('message', e => {
        try { wsHandle(JSON.parse(e.data)); } catch {}
      });
    } catch {}
  };

  const wsDisconnect = () => {
    if (S.ws) { S.ws.onclose = null; S.ws.close(); S.ws = null; }
  };

  const wsHandle = data => {
    const type = (data.type || '').toLowerCase();
    if (type === 'blockfound' && data.poolId === S.poolId) {
      toast(`${t('ws.block-found')} #${data.blockHeight}`, 'cube', 'ok');
      if (S.activeTab === 'overview') renderOverview();
      if (S.activeTab === 'blocks')   renderBlocks(0);
    }
    if (type === 'newchainheight' && S.pool) {
      const el = $('ov-net-height');
      if (el) el.textContent = safeText(data.blockHeight);
    }
    if (type === 'hashrateupdated' && data.poolId === S.poolId && !data.miner) {
      const el = $('ov-pool-hr');
      if (el) el.textContent = fmt.hash(data.hashrate);
    }
    if (type === 'payment' && data.poolId === S.poolId) {
      const sym = S.pool?.pool?.coin?.symbol || '';
      toast(`${t('ws.payment')} ${fmt.num(data.amount, 4)} ${sym}`, 'money-bill-transfer', 'ok');
    }
    if (type === 'blockunlocked' && data.poolId === S.poolId) {
      if (S.activeTab === 'blocks') renderBlocks(S.bPage);
    }
  };

  // ─── Pool selector ────────────────────────────────────────────────────────
  const loadPools = async () => {
    if (!S.base) return;
    try {
      const data = await api.pools();
      const pools = data.pools || [];
      const sel = $('pool-select');
      if (!sel) return;
      sel.innerHTML = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = t('nav.select-pool');
      sel.appendChild(def);
      pools.forEach(p => {
        const opt = document.createElement('option');
        opt.value = safeText(p.id);
        opt.textContent = `${safeText(p.coin?.name || p.coin?.symbol || p.id)} (${safeText(p.id)})`;
        sel.appendChild(opt);
      });
      const saved = localStorage.getItem(LS_POOL);
      if (saved && pools.find(p => p.id === saved)) {
        sel.value = saved;
        await switchPool(saved);
      } else if (pools.length === 1) {
        sel.value = pools[0].id;
        await switchPool(pools[0].id);
      }
    } catch { showNoPool(); }
  };

  const switchPool = async id => {
    S.poolId = id;
    localStorage.setItem(LS_POOL, id);
    S.renderedTabs.clear();
    clearTimers();
    try {
      const data = await api.pool(id);
      S.pool = data;
      S.bPage = 0; S.mPage = 0; S.pPage = 0;
      renderActiveTab();
      startPollTimer();
    } catch {
      showError($('tab-content-wrap'));
    }
  };

  const clearTimers = () => {
    clearInterval(S.pollTimer);
    clearInterval(S.mPollTimer);
    S.pollTimer = null; S.mPollTimer = null;
  };

  const startPollTimer = () => {
    S.pollTimer = setInterval(async () => {
      if (!S.poolId) return;
      try {
        S.pool = await api.pool(S.poolId);
        if (S.activeTab === 'overview') updateOverviewLive();
      } catch {}
    }, POLL_MS);
  };

  // ─── Tab routing ──────────────────────────────────────────────────────────
  const renderActiveTab = () => {
    switch (S.activeTab) {
      case 'overview':  renderOverview(); break;
      case 'blocks':    renderBlocks(S.bPage); break;
      case 'miners':    renderMiners(S.mPage); break;
      case 'start':     renderStart(); break;
      case 'myminer':   renderMyMiner(); break;
    }
  };

  // ─── SVG Chart ────────────────────────────────────────────────────────────
  const buildChart = pts => {
    if (!pts?.length) return null;
    const W = 600, H = 90, pad = 4;
    const vals = pts.map(p => Number(p.poolHashrate));
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const rng = mx - mn || 1;
    const xs = pts.map((_, i) => pad + (i / Math.max(pts.length - 1, 1)) * (W - pad * 2));
    const ys = vals.map(v => pad + (H - pad * 2) - ((v - mn) / rng) * (H - pad * 2));
    const line = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join('L');
    const area = `M${line}L${xs[xs.length-1].toFixed(1)},${H}L${xs[0].toFixed(1)},${H}Z`;
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">
      <defs>
        <linearGradient id="mpGrd" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--tab-active)" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="var(--tab-active)" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#mpGrd)"/>
      <path d="M${line}" fill="none" stroke="var(--tab-active)" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  };

  // ─── Overview ─────────────────────────────────────────────────────────────
  const renderOverview = async () => {
    const wrap = $('pane-overview');
    if (!wrap) return;
    if (!S.pool) { showNoPool(wrap); return; }
    wrap.innerHTML = '';

    const p = S.pool.pool;
    const ns = p.networkStats   || {};
    const ps = p.poolStats      || {};
    const pp = p.paymentProcessing || {};

    // 3-col stat cards
    const grid = mk('div', 'mp-stats-grid');

    // Network card
    const netCard = buildCard('card.network', 'fa-globe', [
      ['net.height',     ns.blockHeight, 'accent', 'ov-net-height'],
      ['net.hashrate',   fmt.hash(ns.networkHashrate)],
      ['net.difficulty', fmt.diff(ns.networkDifficulty)],
      ['net.last-block', fmt.time(ns.lastNetworkBlockTime)],
      ['net.version',    ns.nodeVersion],
      ['net.peers',      ns.connectedPeers],
    ]);

    // Pool card
    const poolCard = buildCard('card.pool', 'fa-server', [
      ['pool.hashrate',        fmt.hash(ps.poolHashrate), 'accent', 'ov-pool-hr'],
      ['pool.miners',          ps.connectedMiners],
      ['pool.workers.online',  ps.workersOnline,  'ok'],
      ['pool.workers.offline', ps.workersOffline, ps.workersOffline > 0 ? 'warn' : ''],
      ['pool.shares',          ps.sharesPerSecond?.toFixed(3)],
      ['pool.fee',             p.poolFeePercent != null ? `${p.poolFeePercent}%` : '—'],
      ['pool.scheme',          pp.payoutScheme],
      ['pool.min-payout',      pp.minimumPayment != null ? `${fmt.num(pp.minimumPayment, 4)} ${p.coin?.symbol || ''}`.trim() : '—'],
      ['pool.interval',        fmt.interval(pp.paymentIntervalSeconds)],
    ]);

    // Round card with effort
    const eff   = Number(p.poolEffort ?? 0);
    const effCl = fmt.effortClass(eff);
    const roundCard = buildCard('card.round', 'fa-circle-notch', [
      ['round.effort',    fmt.effort(eff),        effCl, 'ov-effort'],
      ['round.ttf',       fmt.ttf(ns.networkDifficulty, ps.poolHashrate)],
      ['round.last-block', fmt.time(p.lastPoolBlockTime)],
      ['round.blocks-24h', p.blocks24h],
      ['round.reward',    p.blockReward != null ? `${p.blockReward} ${p.coin?.symbol || ''}`.trim() : '—'],
      ['round.total',     p.totalBlocks],
      ['round.confirmed', p.totalConfirmedBlocks],
      ['round.pending',   p.totalPendingBlocks],
    ]);
    // Append effort bar to round card
    const effortBar = mk('div', 'mp-effort-row');
    const track = mk('div', 'mp-effort-track');
    const fill  = mk('div', `mp-effort-fill ${effCl}`);
    fill.style.width = `${Math.min(eff * 100, 100)}%`;
    track.appendChild(fill);
    effortBar.appendChild(track);
    roundCard.appendChild(effortBar);

    grid.append(netCard, poolCard, roundCard);
    wrap.appendChild(grid);

    // Chart
    const chartCard = mk('div', 'mp-chart-card');
    const chartHead = mk('div', 'mp-chart-head');
    const chartTitle = txt('span', 'mp-chart-title', t('chart.title'));
    const chartHr = txt('span', 'mp-chart-current', fmt.hash(ps.poolHashrate));
    chartHead.append(chartTitle, chartHr);
    chartCard.appendChild(chartHead);
    const chartWrap = mk('div', 'mp-chart-wrap');
    chartWrap.id = 'mp-chart-wrap';
    chartCard.appendChild(chartWrap);
    wrap.appendChild(chartCard);
    loadChart(chartWrap);

    // Top miners
    const topSection = txt('div', 'mp-section', t('topminers.title'));
    wrap.appendChild(topSection);
    buildTopMiners(wrap, p.topMiners || []);

    S.renderedTabs.add('overview');
  };

  const buildCard = (titleKey, icon, rows) => {
    const card = mk('div', 'mp-card');
    const head = mk('div', 'mp-card-head');
    const title = mk('div', 'mp-card-title');
    const ico = mk('i', `fa-solid ${icon}`);
    const lbl = document.createTextNode(t(titleKey));
    title.append(ico, lbl);
    head.appendChild(title);
    card.appendChild(head);
    rows.forEach(([key, val, cls, id]) => {
      const row = mk('div', 'mp-metric');
      const l = txt('span', 'mp-metric-lbl', t(key));
      const v = txt('span', `mp-metric-val${cls ? ' ' + cls : ''}`, safeText(val ?? '—'));
      if (id) v.id = id;
      row.append(l, v);
      card.appendChild(row);
    });
    return card;
  };

  const updateOverviewLive = () => {
    if (!S.pool) return;
    const p  = S.pool.pool;
    const ps = p.poolStats      || {};
    const ns = p.networkStats   || {};
    const setEl = (id, val) => { const e = $(id); if (e) e.textContent = safeText(val); };
    setEl('ov-net-height', ns.blockHeight);
    setEl('ov-pool-hr',    fmt.hash(ps.poolHashrate));
    setEl('ov-effort',     fmt.effort(p.poolEffort ?? 0));
  };

  const loadChart = async wrap => {
    try {
      const data = await api.perf(S.poolId);
      const pts = (data.stats || []).filter(p => p.poolHashrate > 0);
      if (!pts.length) { wrap.innerHTML = `<div class="mp-chart-empty">${t('chart.no-data')}</div>`; return; }
      const svg = buildChart(pts);
      if (svg) wrap.innerHTML = svg; // SVG is fully controlled — no user data in attributes
    } catch { wrap.innerHTML = `<div class="mp-chart-empty">${t('chart.no-data')}</div>`; }
  };

  const buildTopMiners = (wrap, miners) => {
    const box = mk('div', 'mp-table-box');
    const table = mk('table', 'mp-table');
    const thead = mk('thead');
    const hrow  = mk('tr');
    [['topminers.rank','rank'],['topminers.miner',''],['topminers.hashrate',''],['topminers.shares','']].forEach(([k, cls]) => {
      const th = txt('th', cls || '', t(k));
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    table.appendChild(thead);
    const tbody = mk('tbody');
    if (!miners.length) {
      const row = mk('tr');
      const td = mk('td'); td.colSpan = 4; td.className = 'mp-empty';
      td.textContent = t('miners.empty');
      row.appendChild(td); tbody.appendChild(row);
    } else {
      miners.forEach((m, i) => {
        const row = mk('tr');
        row.appendChild(txt('td', 'rank', i + 1));
        const addrTd = mk('td', 'addr'); addrTd.textContent = fmt.addr(m.miner, 14);
        addrTd.title = safeText(m.miner);
        row.appendChild(addrTd);
        row.appendChild(txt('td', 'mono', fmt.hash(m.hashrate)));
        row.appendChild(txt('td', 'mono', safeText(m.sharesPerSecond?.toFixed(3) ?? '—')));
        tbody.appendChild(row);
      });
    }
    table.appendChild(tbody);
    box.appendChild(table);
    wrap.appendChild(box);
  };

  // ─── Blocks ───────────────────────────────────────────────────────────────
  const renderBlocks = async (page = 0) => {
    const wrap = $('pane-blocks');
    if (!wrap) return;
    if (!S.poolId) { showNoPool(wrap); return; }
    wrap.innerHTML = '';
    const loading = mk('div', 'mp-loading');
    const sp = mk('div', 'mp-spinner'); loading.append(sp, document.createTextNode(t('loading')));
    wrap.appendChild(loading);
    try {
      const data = await api.blocks(S.poolId, page, PAGE_SIZE);
      wrap.innerHTML = '';
      S.bPage = page;

      // Summary
      const p = S.pool?.pool;
      if (p) {
        const bar = mk('div', 'mp-summary-bar');
        [
          [t('round.total'),     p.totalBlocks],
          [t('blocks.confirmed'), p.totalConfirmedBlocks],
          [t('blocks.pending'),  p.totalPendingBlocks],
        ].forEach(([lbl, val]) => {
          const pill = mk('div', 'mp-summary-pill');
          pill.append(txt('span', '', lbl), txt('strong', '', safeText(val ?? '—')));
          bar.appendChild(pill);
        });
        wrap.appendChild(bar);
      }

      const blocks = data || [];
      const box = mk('div', 'mp-table-box');
      const table = mk('table', 'mp-table');
      const thead = mk('thead');
      const hrow  = mk('tr');
      ['blocks.height','blocks.time','blocks.reward','blocks.effort','blocks.miner','blocks.status'].forEach(k => {
        hrow.appendChild(txt('th', '', t(k)));
      });
      thead.appendChild(hrow); table.appendChild(thead);
      const tbody = mk('tbody');
      if (!blocks.length) {
        const row = mk('tr');
        const td = mk('td'); td.colSpan = 6; td.className = 'mp-empty';
        td.textContent = t('blocks.empty');
        row.appendChild(td); tbody.appendChild(row);
      } else {
        blocks.forEach(b => {
          const row = mk('tr');
          // Height
          const htd = mk('td', 'mono');
          if (b.infoLink) {
            const a = mk('a'); a.href = safeText(b.infoLink);
            a.target = '_blank'; a.rel = 'noopener noreferrer';
            a.textContent = safeText(b.blockHeight);
            htd.appendChild(a);
          } else { htd.textContent = safeText(b.blockHeight); }
          row.appendChild(htd);
          // Time
          const timeTd = mk('td', 'mono'); timeTd.textContent = fmt.time(b.created);
          timeTd.title = fmt.absTime(b.created);
          row.appendChild(timeTd);
          // Reward
          const sym = S.pool?.pool?.coin?.symbol || '';
          const rew = b.reward != null ? `${fmt.num(b.reward, 4)} ${sym}`.trim() : '—';
          row.appendChild(txt('td', 'mono', rew));
          // Effort
          const effTd = mk('td');
          const effV  = txt('span', `mp-effort-val ${fmt.effortClass(b.effort)}`, fmt.effort(b.effort));
          effTd.appendChild(effV);
          row.appendChild(effTd);
          // Miner
          const mTd = mk('td', 'addr'); mTd.textContent = fmt.addr(b.miner, 10);
          mTd.title = safeText(b.miner);
          row.appendChild(mTd);
          // Status
          const sTd = mk('td');
          const st  = (b.status || '').toLowerCase();
          let badgeCls = 'mp-badge-inf', stLbl = safeText(b.status);
          if (st === 'confirmed') { badgeCls = 'mp-badge-ok'; stLbl = t('blocks.confirmed'); }
          else if (st === 'pending') { badgeCls = 'mp-badge-pnd'; stLbl = t('blocks.pending'); }
          else if (st === 'orphaned') { badgeCls = 'mp-badge-err'; stLbl = t('blocks.orphaned'); }
          sTd.appendChild(txt('span', `mp-badge ${badgeCls}`, stLbl));
          row.appendChild(sTd);
          tbody.appendChild(row);
        });
      }
      table.appendChild(tbody);
      box.appendChild(table);
      // Pagination
      const pg = mk('div', 'mp-pager');
      const info = txt('span', 'mp-pager-info', `${t('page.prev')} ${page + 1}`);
      const btns = mk('div', 'mp-pager-btns');
      const prev = txt('button', 'mp-pager-btn', t('page.prev'));
      const next = txt('button', 'mp-pager-btn', t('page.next'));
      prev.disabled = page === 0;
      next.disabled = blocks.length < PAGE_SIZE;
      prev.addEventListener('click', () => renderBlocks(page - 1));
      next.addEventListener('click', () => renderBlocks(page + 1));
      btns.append(prev, next);
      pg.append(info, btns);
      box.appendChild(pg);
      wrap.appendChild(box);
    } catch { wrap.innerHTML = ''; showError(wrap); }
  };

  // ─── Miners ───────────────────────────────────────────────────────────────
  const renderMiners = async (page = 0) => {
    const wrap = $('pane-miners');
    if (!wrap) return;
    if (!S.poolId) { showNoPool(wrap); return; }
    wrap.innerHTML = '';
    const loading = mk('div', 'mp-loading');
    const sp = mk('div', 'mp-spinner'); loading.append(sp, document.createTextNode(t('loading')));
    wrap.appendChild(loading);
    try {
      const data = await api.miners(S.poolId, page, PAGE_SIZE);
      wrap.innerHTML = '';
      S.mPage = page;
      const miners = data || [];
      const box = mk('div', 'mp-table-box');
      const table = mk('table', 'mp-table');
      const thead = mk('thead');
      const hrow  = mk('tr');
      ['miners.address','miners.hashrate','miners.shares'].forEach(k => {
        hrow.appendChild(txt('th', '', t(k)));
      });
      thead.appendChild(hrow); table.appendChild(thead);
      const tbody = mk('tbody');
      if (!miners.length) {
        const row = mk('tr');
        const td = mk('td'); td.colSpan = 3; td.className = 'mp-empty';
        td.textContent = t('miners.empty');
        row.appendChild(td); tbody.appendChild(row);
      } else {
        miners.forEach(m => {
          const row = mk('tr');
          const addrTd = mk('td', 'addr');
          addrTd.textContent = fmt.addr(m.miner, 14);
          addrTd.title = safeText(m.miner);
          addrTd.style.cursor = 'pointer';
          addrTd.addEventListener('click', () => openMinerFromTable(m.miner));
          row.appendChild(addrTd);
          row.appendChild(txt('td', 'mono', fmt.hash(m.hashrate)));
          row.appendChild(txt('td', 'mono', m.sharesPerSecond?.toFixed(3) ?? '—'));
          tbody.appendChild(row);
        });
      }
      table.appendChild(tbody);
      box.appendChild(table);
      const pg = mk('div', 'mp-pager');
      const info = txt('span', 'mp-pager-info', `${t('page.prev')} ${page + 1}`);
      const btns = mk('div', 'mp-pager-btns');
      const prev = txt('button', 'mp-pager-btn', t('page.prev'));
      const next = txt('button', 'mp-pager-btn', t('page.next'));
      prev.disabled = page === 0;
      next.disabled = miners.length < PAGE_SIZE;
      prev.addEventListener('click', () => renderMiners(page - 1));
      next.addEventListener('click', () => renderMiners(page + 1));
      btns.append(prev, next);
      pg.append(info, btns);
      box.appendChild(pg);
      wrap.appendChild(box);
    } catch { wrap.innerHTML = ''; showError(wrap); }
  };

  const openMinerFromTable = addr => {
    if (!addr) return;
    localStorage.setItem(LS_MINER + S.poolId, safeText(addr));
    const tab = document.querySelector('[data-bs-target="#pane-myminer"]');
    if (tab) tab.click();
  };

  // ─── Start Mining ─────────────────────────────────────────────────────────
  const renderStart = () => {
    const wrap = $('pane-start');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!S.pool) { showNoPool(wrap); return; }

    const p    = S.pool.pool;
    const coin = p.coin || {};
    const ports = Object.entries(p.ports || {});

    // Coin info
    const coinBlock = mk('div', 'mp-coin-block');
    const iconWrap  = mk('div', 'mp-coin-icon');
    iconWrap.appendChild(mk('i', 'fa-solid fa-coins'));
    const coinInfo = mk('div');
    coinInfo.appendChild(txt('div', 'mp-coin-name', safeText(coin.name || coin.symbol || '')));
    const meta = [coin.symbol, coin.algorithm].filter(Boolean).join(' · ');
    coinInfo.appendChild(txt('div', 'mp-coin-meta', safeText(meta)));

    // Links
    const linksWrap = mk('div', 'mp-coin-links');
    const linkDefs = [
      [coin.website,  'fa-globe',        'Website'],
      [coin.twitter,  'fa-brands fa-x-twitter', 'Twitter'],
      [coin.discord,  'fa-brands fa-discord', 'Discord'],
      [coin.telegram, 'fa-brands fa-telegram', 'Telegram'],
      [coin.github,   'fa-brands fa-github', 'GitHub'],
      [coin.market,   'fa-chart-line',    'Market'],
    ];
    linkDefs.forEach(([url, ico, lbl]) => {
      if (!url) return;
      const a = mk('a', 'mp-coin-link');
      a.href = safeText(url); a.target = '_blank'; a.rel = 'noopener noreferrer';
      const i = mk('i', `fa-solid ${ico}`);
      a.append(i, document.createTextNode(lbl));
      linksWrap.appendChild(a);
    });
    coinInfo.appendChild(linksWrap);
    coinBlock.append(iconWrap, coinInfo);
    wrap.appendChild(coinBlock);

    // Ports table
    if (ports.length) {
      const portCard = mk('div', 'mp-ports-card');
      portCard.appendChild(txt('div', 'mp-ports-title', t('start.ports')));
      const box = mk('div', 'mp-table-box');
      const table = mk('table', 'mp-table');
      const thead = mk('thead');
      const hrow  = mk('tr');
      ['start.port','start.start-diff','start.var-min','start.var-max','start.target-time','start.tls'].forEach(k => {
        hrow.appendChild(txt('th', '', t(k)));
      });
      thead.appendChild(hrow); table.appendChild(thead);
      const tbody = mk('tbody');
      ports.forEach(([port, cfg]) => {
        const row = mk('tr');
        [
          safeText(port),
          safeText(cfg.difficulty ?? '—'),
          safeText(cfg.varDiff?.minDiff ?? '—'),
          safeText(cfg.varDiff?.maxDiff ?? '—'),
          cfg.varDiff?.targetTime ? `${cfg.varDiff.targetTime}s` : '—',
          cfg.tls ? t('misc.yes') : t('misc.no'),
        ].forEach(v => row.appendChild(txt('td', 'mono', v)));
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      box.appendChild(table);
      portCard.appendChild(box);
      wrap.appendChild(portCard);
    }

    // Generator
    wrap.appendChild(buildGenerator(ports, coin, p));
    S.renderedTabs.add('start');
  };

  const buildGenerator = (ports, coin, p) => {
    const card = mk('div', 'mp-gen-card');
    card.appendChild(txt('div', 'mp-gen-title', t('start.generator')));

    const row1 = mk('div', 'mp-gen-row');

    // Address
    const addrGrp = mk('div', 'mp-gen-group grow');
    addrGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.address')));
    const addrInp = mk('input', 'mp-gen-input');
    addrInp.type = 'text'; addrInp.id = 'gen-addr';
    addrInp.placeholder = t('start.addr-placeholder');
    addrInp.autocomplete = 'off'; addrInp.spellcheck = false;
    addrGrp.appendChild(addrInp);

    // Worker
    const wrkGrp = mk('div', 'mp-gen-group');
    const wrkLbl = mk('div', 'mp-gen-lbl');
    wrkLbl.textContent = t('start.worker');
    const wrkHint = txt('small', '', t('start.worker-hint'));
    wrkLbl.appendChild(wrkHint);
    wrkGrp.appendChild(wrkLbl);
    const wrkInp = mk('input', 'mp-gen-input');
    wrkInp.type = 'text'; wrkInp.id = 'gen-worker';
    wrkInp.placeholder = t('start.worker-placeholder');
    wrkInp.style.width = '130px';
    wrkGrp.appendChild(wrkInp);

    row1.append(addrGrp, wrkGrp);

    const row2 = mk('div', 'mp-gen-row');

    // Port
    const portGrp = mk('div', 'mp-gen-group');
    portGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.select-port')));
    const portSel = mk('select', 'mp-gen-select');
    portSel.id = 'gen-port';
    ports.forEach(([port]) => {
      const opt = document.createElement('option');
      opt.value = safeText(port);
      opt.textContent = safeText(port);
      portSel.appendChild(opt);
    });
    portGrp.appendChild(portSel);

    // Mode
    const modeGrp = mk('div', 'mp-gen-group');
    modeGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.mining-type')));
    const modeSel = mk('select', 'mp-gen-select');
    modeSel.id = 'gen-mode';
    [['cpu', t('start.cpu')], ['opencl', t('start.gpu-opencl')], ['cuda', t('start.gpu-cuda')]].forEach(([v, l]) => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = l; modeSel.appendChild(opt);
    });
    modeGrp.appendChild(modeSel);

    // CPU: arch
    const archGrp = mk('div', 'mp-gen-group');
    archGrp.id = 'gen-arch-wrap';
    archGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.arch')));
    const archSel = mk('select', 'mp-gen-select');
    archSel.id = 'gen-arch';
    ['avx512','avx2','aes','sse2'].forEach(a => {
      const opt = document.createElement('option');
      opt.value = a; opt.textContent = a; archSel.appendChild(opt);
    });
    archGrp.appendChild(archSel);

    // CPU: threads
    const thrGrp = mk('div', 'mp-gen-group');
    thrGrp.id = 'gen-thr-wrap';
    thrGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.threads')));
    const thrInp = mk('input', 'mp-gen-input');
    thrInp.type = 'number'; thrInp.id = 'gen-threads';
    thrInp.value = '2'; thrInp.min = '1'; thrInp.max = '256';
    thrInp.style.width = '80px';
    thrGrp.appendChild(thrInp);

    // GPU: batch size
    const bsGrp = mk('div', 'mp-gen-group');
    bsGrp.id = 'gen-bs-wrap'; bsGrp.style.display = 'none';
    bsGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.batchsize')));
    const bsInp = mk('input', 'mp-gen-input');
    bsInp.type = 'number'; bsInp.id = 'gen-bs';
    bsInp.value = '3484'; bsInp.min = '64';
    bsInp.style.width = '100px';
    bsGrp.appendChild(bsInp);

    // GPU: device id
    const gpuGrp = mk('div', 'mp-gen-group');
    gpuGrp.id = 'gen-gpu-wrap'; gpuGrp.style.display = 'none';
    gpuGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.gpu-id')));
    const gpuInp = mk('input', 'mp-gen-input');
    gpuInp.type = 'number'; gpuInp.id = 'gen-gpu';
    gpuInp.value = '0'; gpuInp.min = '0';
    gpuInp.style.width = '70px';
    gpuGrp.appendChild(gpuInp);

    row2.append(portGrp, modeGrp, archGrp, thrGrp, bsGrp, gpuGrp);

    // Command output
    const cmdRow = mk('div', 'mp-gen-row');
    const cmdGrp = mk('div', 'mp-gen-group grow');
    cmdGrp.appendChild(txt('div', 'mp-gen-lbl', t('start.cmd-label')));
    const cmdWrap = mk('div', 'mp-cmd-wrap');
    const cmdBox  = mk('div', 'mp-cmd-box');
    cmdBox.id = 'gen-cmd';
    const cmdHint = txt('span', 'mp-cmd-hint', t('start.enter-address'));
    cmdBox.appendChild(cmdHint);
    const copyBtn = txt('button', 'mp-cmd-copy', t('start.copy'));
    copyBtn.type = 'button';
    cmdWrap.append(cmdBox, copyBtn);
    cmdGrp.appendChild(cmdWrap);
    cmdRow.appendChild(cmdGrp);

    card.append(row1, row2, cmdRow);

    // Extract host from base URL for command
    const poolHost = (() => { try { return new URL(S.base).host; } catch { return 'pool.host'; } })();
    const algo = safeText(coin.algorithm || 'argon2id1024').toLowerCase();

    const updateCmd = () => {
      const addr   = safeText(addrInp.value);
      if (!addr) {
        cmdBox.innerHTML = '';
        cmdBox.appendChild(txt('span', 'mp-cmd-hint', t('start.enter-address')));
        return;
      }
      const wrk    = safeText(wrkInp.value);
      const port   = safeText(portSel.value);
      const mode   = modeSel.value;
      const user   = wrk ? `${addr}.${wrk}` : addr;
      const server = `stratum+tcp://${poolHost}:${port}`;
      let cmd;
      if (mode === 'cpu') {
        const arch = safeText(archSel.value);
        const thr  = Math.max(1, parseInt(thrInp.value, 10) || 1);
        cmd = `cpuminer-${arch} -a ${algo} -o ${server} -u ${user} -p x -t ${thr}`;
      } else {
        const gpuType = mode === 'opencl' ? 'OpenCL' : 'CUDA';
        const bs  = Math.max(64, parseInt(bsInp.value, 10) || 3484);
        const gid = Math.max(0, parseInt(gpuInp.value, 10) || 0);
        cmd = `cpuminer-sse2 -a ${algo} --use-gpu ${gpuType} -o ${server} -u ${user} -p x --gpu-batchsize ${bs} --gpu-id ${gid}`;
      }
      cmdBox.textContent = cmd;
    };

    const toggleGpuFields = () => {
      const isGpu = modeSel.value !== 'cpu';
      archGrp.style.display = isGpu ? 'none' : '';
      thrGrp.style.display  = isGpu ? 'none' : '';
      bsGrp.style.display   = isGpu ? '' : 'none';
      gpuGrp.style.display  = isGpu ? '' : 'none';
      updateCmd();
    };

    [addrInp, wrkInp, portSel, archSel, thrInp, bsInp, gpuInp].forEach(el => el.addEventListener('input', updateCmd));
    modeSel.addEventListener('change', toggleGpuFields);

    copyBtn.addEventListener('click', () => {
      const cmd = cmdBox.textContent;
      if (!cmd || cmd === t('start.enter-address')) return;
      navigator.clipboard?.writeText(cmd).then(() => {
        copyBtn.textContent = t('start.copied');
        setTimeout(() => { copyBtn.textContent = t('start.copy'); }, 1800);
      });
    });

    return card;
  };

  // ─── My Miner ─────────────────────────────────────────────────────────────
  const renderMyMiner = async () => {
    const wrap = $('pane-myminer');
    if (!wrap) return;
    if (!S.poolId) { showNoPool(wrap); return; }
    const saved = localStorage.getItem(LS_MINER + S.poolId);
    if (saved) {
      await renderMinerDashboard(wrap, saved);
    } else {
      renderMinerLogin(wrap);
    }
  };

  const renderMinerLogin = wrap => {
    wrap.innerHTML = '';
    const login = mk('div', 'mp-login-wrap');
    const ico = mk('div', 'mp-login-icon');
    ico.appendChild(mk('i', 'fa-solid fa-circle-user'));
    login.appendChild(ico);
    login.appendChild(txt('div', 'mp-login-title', t('myminer.title')));
    login.appendChild(txt('div', 'mp-login-sub', t('myminer.subtitle')));
    const row = mk('div', 'mp-login-row');
    const inp = mk('input', 'mp-addr-input');
    inp.type = 'text'; inp.id = 'mm-addr-input';
    inp.placeholder = t('myminer.placeholder');
    inp.autocomplete = 'off'; inp.spellcheck = false;
    const btn = txt('button', 'mp-open-btn', t('myminer.open'));
    btn.type = 'button';
    const open = async () => {
      const addr = safeText(inp.value);
      if (!addr) return;
      localStorage.setItem(LS_MINER + S.poolId, addr);
      await renderMinerDashboard(wrap, addr);
    };
    btn.addEventListener('click', open);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
    row.append(inp, btn);
    login.appendChild(row);
    wrap.appendChild(login);
  };

  const renderMinerDashboard = async (wrap, addr) => {
    wrap.innerHTML = '';
    const loading = mk('div', 'mp-loading');
    const sp = mk('div', 'mp-spinner');
    loading.append(sp, document.createTextNode(t('loading')));
    wrap.appendChild(loading);
    try {
      const [mStats, mPerf] = await Promise.all([
        api.miner(S.poolId, addr).catch(() => null),
        api.minerPerf(S.poolId, addr).catch(() => null),
      ]);
      if (!mStats) {
        wrap.innerHTML = '';
        const err = mk('div', 'mp-error');
        err.append(mk('i', 'fa-solid fa-circle-exclamation'), document.createTextNode(t('myminer.not-found')));
        wrap.appendChild(err);
        const forgetWrap = mk('div');
        forgetWrap.style.cssText = 'text-align:center;margin-top:12px';
        const fb = txt('button', 'mp-forget-btn', t('myminer.forget'));
        fb.addEventListener('click', () => { localStorage.removeItem(LS_MINER + S.poolId); renderMinerLogin(wrap); });
        forgetWrap.appendChild(fb);
        wrap.appendChild(forgetWrap);
        return;
      }
      wrap.innerHTML = '';

      // Header
      const hdr = mk('div', 'mp-miner-header');
      const addrEl = mk('div', 'mp-miner-addr');
      addrEl.textContent = fmt.addr(addr, 16);
      addrEl.title = safeText(addr);
      const fb = txt('button', 'mp-forget-btn', t('myminer.forget'));
      fb.addEventListener('click', () => { localStorage.removeItem(LS_MINER + S.poolId); renderMinerLogin(wrap); });
      hdr.append(addrEl, fb);
      wrap.appendChild(hdr);

      // Stats cards grid
      const sym = S.pool?.pool?.coin?.symbol || '';
      const grid = mk('div', 'mp-stats-grid');
      const balCard = buildCard('myminer.title', 'fa-wallet', [
        ['myminer.balance',      mStats.pendingBalance != null ? `${fmt.num(mStats.pendingBalance, 8)} ${sym}`.trim() : '—', 'accent'],
        ['myminer.paid',         mStats.totalPaid != null ? `${fmt.num(mStats.totalPaid, 8)} ${sym}`.trim() : '—'],
        ['myminer.today',        mStats.todayPaid != null ? `${fmt.num(mStats.todayPaid, 8)} ${sym}`.trim() : '—'],
        ['myminer.effort',       fmt.effort(mStats.minerEffort)],
        ['myminer.last-payment', fmt.time(mStats.lastPayment)],
      ]);
      const hrCard = buildCard('card.pool', 'fa-gauge-high', [
        ['pool.hashrate',  fmt.hash(mStats.performance?.hashrate ?? 0), 'accent'],
        ['pool.shares',    mStats.performance?.sharesPerSecond?.toFixed(3) ?? '—'],
        ['pool.workers.online',  mStats.workersOnline],
        ['pool.workers.offline', mStats.workersOffline],
      ]);
      grid.append(balCard, hrCard);
      wrap.appendChild(grid);

      // Workers table
      if (mPerf?.workers) {
        const wSection = txt('div', 'mp-section', t('myminer.workers'));
        wrap.appendChild(wSection);
        const workers = Object.entries(mPerf.workers);
        if (workers.length) {
          const wBox = mk('div', 'mp-table-box');
          const wTable = mk('table', 'mp-table');
          const wthead = mk('thead');
          const whrow  = mk('tr');
          ['myminer.worker','myminer.hashrate','myminer.shares'].forEach(k => {
            whrow.appendChild(txt('th','',t(k)));
          });
          wthead.appendChild(whrow); wTable.appendChild(wthead);
          const wtbody = mk('tbody');
          workers.forEach(([wname, wdata]) => {
            const row = mk('tr');
            row.appendChild(txt('td','mono', safeText(wname)));
            // wdata is array of performance snapshots; use latest
            const latest = Array.isArray(wdata) ? wdata[wdata.length - 1] : wdata;
            row.appendChild(txt('td','mono', fmt.hash(latest?.hashrate ?? 0)));
            row.appendChild(txt('td','mono', latest?.sharesPerSecond?.toFixed(3) ?? '—'));
            wtbody.appendChild(row);
          });
          wTable.appendChild(wtbody);
          wBox.appendChild(wTable);
          wrap.appendChild(wBox);
        } else {
          const e = mk('div','mp-empty'); e.textContent = t('myminer.no-workers');
          wrap.appendChild(e);
        }
      }

      // Payments
      await renderMinerPayments(wrap, addr, 0);

    } catch { wrap.innerHTML = ''; showError(wrap); }
  };

  const renderMinerPayments = async (wrap, addr, page) => {
    S.pPage = page;
    // Remove old payments section if exists
    const old = $('mm-pay-section');
    if (old) old.remove();

    const section = mk('div');
    section.id = 'mm-pay-section';
    const payTitle = txt('div', 'mp-section', t('myminer.payments'));
    section.appendChild(payTitle);

    try {
      const data = await api.minerPayments(S.poolId, addr, page, PAGE_SIZE);
      const payments = data || [];
      const sym = S.pool?.pool?.coin?.symbol || '';
      const box = mk('div', 'mp-table-box');
      const table = mk('table', 'mp-table');
      const thead = mk('thead');
      const hrow  = mk('tr');
      ['myminer.pay-amount','myminer.pay-time','myminer.pay-tx'].forEach(k => {
        hrow.appendChild(txt('th','',t(k)));
      });
      thead.appendChild(hrow); table.appendChild(thead);
      const tbody = mk('tbody');
      if (!payments.length) {
        const row = mk('tr');
        const td = mk('td'); td.colSpan = 3; td.className = 'mp-empty';
        td.textContent = t('myminer.no-payments');
        row.appendChild(td); tbody.appendChild(row);
      } else {
        payments.forEach(pay => {
          const row = mk('tr');
          row.appendChild(txt('td','mono', `${fmt.num(pay.amount, 8)} ${sym}`.trim()));
          const timeTd = mk('td','mono'); timeTd.textContent = fmt.time(pay.created);
          timeTd.title = fmt.absTime(pay.created);
          row.appendChild(timeTd);
          const txTd = mk('td','mono');
          if (pay.transactionConfirmationData && pay.infoLink) {
            const a = mk('a'); a.href = safeText(pay.infoLink);
            a.target = '_blank'; a.rel = 'noopener noreferrer';
            a.textContent = fmt.addr(pay.transactionConfirmationData, 10);
            a.title = safeText(pay.transactionConfirmationData);
            txTd.appendChild(a);
          } else if (pay.transactionConfirmationData) {
            txTd.textContent = fmt.addr(pay.transactionConfirmationData, 10);
          } else { txTd.textContent = '—'; }
          row.appendChild(txTd);
          tbody.appendChild(row);
        });
      }
      table.appendChild(tbody);
      box.appendChild(table);
      const pg = mk('div', 'mp-pager');
      const info = txt('span', 'mp-pager-info', `${t('page.prev')} ${page + 1}`);
      const btns = mk('div', 'mp-pager-btns');
      const prev = txt('button', 'mp-pager-btn', t('page.prev'));
      const next = txt('button', 'mp-pager-btn', t('page.next'));
      prev.disabled = page === 0;
      next.disabled = payments.length < PAGE_SIZE;
      prev.addEventListener('click', () => renderMinerPayments(wrap, addr, page - 1));
      next.addEventListener('click', () => renderMinerPayments(wrap, addr, page + 1));
      btns.append(prev, next);
      pg.append(info, btns);
      box.appendChild(pg);
      section.appendChild(box);
    } catch {
      const e = mk('div','mp-error');
      e.append(mk('i','fa-solid fa-triangle-exclamation'), document.createTextNode(t('error.fetch')));
      section.appendChild(e);
    }
    wrap.appendChild(section);
  };

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const showNoPool = wrap => {
    if (!wrap) return;
    wrap.innerHTML = '';
    const e = mk('div', 'mp-empty');
    e.append(mk('i', 'fa-solid fa-layer-group'), document.createTextNode(' ' + t('error.no-pool')));
    wrap.appendChild(e);
  };
  const showError = wrap => {
    if (!wrap) return;
    const e = mk('div', 'mp-error');
    e.append(mk('i', 'fa-solid fa-triangle-exclamation'), document.createTextNode(' ' + t('error.fetch')));
    wrap.appendChild(e);
  };

  // ─── Base URL bar ─────────────────────────────────────────────────────────
  const setupBaseBar = () => {
    const inp = $('base-url');
    const btn = $('apply-url');
    if (!inp || !btn) return;
    inp.value = S.base;
    const apply = async () => {
      const val = inp.value.trim().replace(/\/$/, '');
      S.base = val;
      localStorage.setItem(LS_BASE, val);
      wsConnect();
      await loadPools();
    };
    btn.addEventListener('click', apply);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
  };

  // ─── Init ─────────────────────────────────────────────────────────────────
  const init = () => {
    // Theme
    applyTheme();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (S.theme === 'auto') applyTheme();
    });
    document.querySelectorAll('.mp-theme-menu .dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        S.theme = item.dataset.theme;
        localStorage.setItem(LS_THEME, S.theme);
        applyTheme();
      });
    });

    // Language
    const langSel = $('lang-select');
    if (langSel) {
      langSel.value = S.lang;
      langSel.addEventListener('change', () => {
        S.lang = langSel.value;
        localStorage.setItem(LS_LANG, S.lang);
        applyTkeys();
        applyTheme();
        if (S.pool) renderActiveTab();
      });
    }

    // Tabs
    document.querySelectorAll('.mp-tab').forEach(tab => {
      tab.addEventListener('shown.bs.tab', e => {
        const target = e.target.dataset.bsTarget?.replace('#pane-', '');
        if (!target) return;
        S.activeTab = target;
        if (!S.renderedTabs.has(target)) renderActiveTab();
      });
    });

    // Pool select
    const poolSel = $('pool-select');
    if (poolSel) {
      poolSel.addEventListener('change', e => {
        const id = safeText(e.target.value);
        if (id) switchPool(id);
      });
    }

    // Base URL bar
    setupBaseBar();

    // Apply translations after setup
    applyTkeys();

    // Auto-load if base URL already saved
    if (S.base) {
      wsConnect();
      loadPools();
    }
  };

  document.addEventListener('DOMContentLoaded', init);
})();
