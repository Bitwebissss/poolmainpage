(function () {
  'use strict';

  const LS_THEME = 'mp-theme';
  const LS_LANG  = 'mp-lang';
  const LS_BASE  = 'mp-base';
  const LS_POOL  = 'mp-pool';
  const LS_MINER = 'mp-miner-';

  const PAGE_SIZE  = 20;
  const TOP_SIZE   = 50;
  const POLL_MS    = 60_000;
  const CHART_REFRESH_CYCLES = 5;

  const CPU_ARCHS = [
    'avx512-sha-vaes','avx512','avx2-sha-vaes','avx2-sha','avx2','avx','aes-sse42','sse2',
  ];

  const S = {
    base:           localStorage.getItem(LS_BASE) || 'https://pool.bitwebcore.net',
    poolId:         null,
    pool:           null,
    wsCache:        {},
    pollTimer:      null,
    relTimerHandle: null,
    bPage:          0,
    ws:             null,
    wsRetry:        0,
    lang:           localStorage.getItem(LS_LANG) || 'en',
    theme:          localStorage.getItem(LS_THEME) || 'auto',
    _switching:     false,
    activeTab:      'overview',
    minerSeq:       0,
    ovSeq:          0,
    poolSelectBound: false,
    ovPayTick:      null,
    mmPayTick:      null,
    chartAge:       0,
  };

  // -- i18n --

  const t = k => window.mpLang?.[S.lang]?.[k] ?? window.mpLang?.en?.[k] ?? k;

  const applyTkeys = () => {
    document.querySelectorAll('[data-tkey]').forEach(el => {
      const v = t(el.dataset.tkey);
      if (el.tagName === 'INPUT') el.placeholder = v;
      else el.textContent = v;
    });
  };

  // -- DOM helpers --

  const $   = id => document.getElementById(id);
  const mk  = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const txt = (tag, cls, text) => { const e = mk(tag, cls); e.textContent = String(text ?? ''); return e; };
  const safe    = v => String(v ?? '').trim();
  const safeUrl = v => { const s = safe(v); return /^https?:\/\//i.test(s) ? s : ''; };

  const setEl = (id, val) => {
    const e = $(id);
    if (e && val !== null && val !== undefined) e.textContent = safe(val);
  };

  // -- Formatters --

  const fmt = {
    hash(h) {
      h = Number(h);
      if (!isFinite(h) || h <= 0) return '0 H/s';
      const u = ['H','KH','MH','GH','TH','PH'];
      const i = Math.min(Math.floor(Math.log10(h) / 3), u.length - 1);
      return `${(h / 10 ** (i * 3)).toFixed(2)} ${u[i]}/s`;
    },
    diff(d) {
      d = Number(d);
      if (!isFinite(d) || d <= 0) return '--';
      if (d < 1000) return d.toFixed(6);
      const u = ['','K','M','G','T','P'];
      const i = Math.min(Math.floor(Math.log10(d) / 3), u.length - 1);
      return `${(d / 10 ** (i * 3)).toFixed(3)} ${u[i]}`.trim();
    },
    coin(v, sym) {
      v = Number(v);
      if (!isFinite(v)) return '--';
      return sym ? `${v.toFixed(8)} ${sym}` : v.toFixed(8);
    },
    num(n, dec = 4) {
      n = Number(n);
      if (!isFinite(n)) return '--';
      return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dec });
    },
    effort(e) {
      e = Number(e);
      if (!isFinite(e)) return '--';
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
      if (!hr || hr <= 0 || !diff) return '--';
      const s = Math.round((diff * 4294967296) / hr);
      if (s < 60)    return `${s}s`;
      if (s < 3600)  return `${Math.floor(s / 60)}m ${s % 60}s`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
      return `${Math.floor(s / 86400)}d`;
    },
    interval(s) {
      s = Number(s);
      if (!s) return '--';
      if (s < 60)   return `${s}s`;
      if (s < 3600) return `${Math.floor(s / 60)}m`;
      return `${Math.floor(s / 3600)}h`;
    },
    addr(a, len = 12) {
      a = safe(a);
      if (!a) return '--';
      if (a.length <= len * 2 + 1) return a;
      return `${a.slice(0, len)}...${a.slice(-6)}`;
    },
    time(d) {
      if (!d) return t('misc.na');
      const diff = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
      if (diff < 10)    return t('misc.just-now');
      if (diff < 60)    return `${diff}s ${t('misc.ago')}`;
      if (diff < 3600)  return `${Math.floor(diff / 60)}m ${t('misc.ago')}`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}h ${t('misc.ago')}`;
      return `${Math.floor(diff / 86400)}d ${t('misc.ago')}`;
    },
    absTime(d) {
      if (!d) return '--';
      return new Date(d).toLocaleString();
    },
  };

  // -- API --

  const enc = v => encodeURIComponent(safe(v));

  // Request deduplication: если запрос к тому же URL уже летит — возвращаем тот же Promise
  const _inflight = new Map();
  const api = {
    async _get(path) {
      const url = `${S.base}${path}`;
      if (_inflight.has(url)) return _inflight.get(url);
      const promise = fetch(url, { headers: { Accept: 'application/json' } })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .finally(() => _inflight.delete(url));
      _inflight.set(url, promise);
      return promise;
    },
    pools:         ()              => api._get('/api/pools'),
    pool:          id              => api._get(`/api/pools/${enc(id)}`),
    blocks:        (id, p, s)      => api._get(`/api/pools/${enc(id)}/blocks?page=${p}&pageSize=${s}`),
    miners:        (id, p, s)      => api._get(`/api/pools/${enc(id)}/miners?page=${p}&pageSize=${s}&topMinersRange=24`),
    perf:          id              => api._get(`/api/pools/${enc(id)}/performance`),
    miner:         (id, a)         => api._get(`/api/pools/${enc(id)}/miners/${enc(a)}`),
    minerPerf:     (id, a)         => api._get(`/api/pools/${enc(id)}/miners/${enc(a)}/performance`),
    minerBlocks:   (id, a, p, s)   => api._get(`/api/pools/${enc(id)}/miners/${enc(a)}/blocks?page=${p}&pageSize=${s}`),
    minerPayments: (id, a, p, s)   => api._get(`/api/pools/${enc(id)}/miners/${enc(a)}/payments?page=${p}&pageSize=${s}`),
  };

  // -- WebSocket --

  const wsBlockHeight  = () => S.wsCache[S.poolId]?.blockHeight  ?? null;
  const wsMinerHr      = addr => S.wsCache[S.poolId]?.minerHashrates?.[addr] ?? null;

  const wsConnect = () => {
    if (!S.base) return;
    try {
      const url   = new URL(S.base);
      const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
      wsDisconnect();
      S.ws = new WebSocket(`${proto}//${url.host}/notifications`);
      S.ws.addEventListener('open', () => {
        S.wsRetry = 0;
        const dot = $('ws-dot');
        if (dot) dot.classList.add('connected');
      });
      S.ws.onclose = () => {
        const dot = $('ws-dot');
        if (dot) dot.classList.remove('connected');
        S.wsRetry++;
        setTimeout(wsConnect, Math.min(1000 * 2 ** S.wsRetry, 30_000));
      };
      S.ws.addEventListener('error', err => console.error('ws error', err));
      S.ws.addEventListener('message', e => {
        try { wsHandle(JSON.parse(e.data)); } catch (err) { console.error('ws parse error', err); }
      });
    } catch (err) { console.error('ws connect error', err); }
  };

  const wsDisconnect = () => {
    if (S.ws) { S.ws.onclose = null; S.ws.close(); S.ws = null; }
  };

  const wsHandle = msg => {
    const type = (msg.type || '').toLowerCase();
    const pid  = msg.poolId;

    if (type === 'poolstatsupdated' && pid === S.poolId) {
      // patch S.pool in-place so patchOverviewRest() uses fresh data without REST
      if (S.pool?.pool) {
        const p = S.pool.pool;
        if (!p.poolStats) p.poolStats = {};
        if (!p.networkStats) p.networkStats = {};
        p.poolStats.poolHashrate    = msg.poolHashrate;
        p.poolStats.connectedMiners = msg.connectedMiners;
        p.poolStats.sharesPerSecond = msg.sharesPerSecond;
        p.networkStats.networkHashrate    = msg.networkHashrate;
        p.networkStats.networkDifficulty  = msg.networkDifficulty;
        p.networkStats.blockHeight        = msg.blockHeight;
        p.networkStats.lastNetworkBlockTime = msg.lastNetworkBlockTime;
        if (msg.nodeVersion)    p.networkStats.nodeVersion    = msg.nodeVersion;
        if (msg.connectedPeers) p.networkStats.connectedPeers = msg.connectedPeers;
        if (msg.poolEffort    != null) p.poolEffort    = msg.poolEffort;
        if (msg.lastPoolBlockTime) p.lastPoolBlockTime = msg.lastPoolBlockTime;
      }
      patchOverviewRest();
    }

    if (type === 'hashrateupdated' && pid && msg.miner) {
      if (!S.wsCache[pid]) S.wsCache[pid] = { minerHashrates: {} };
      if (!S.wsCache[pid].minerHashrates) S.wsCache[pid].minerHashrates = {};
      S.wsCache[pid].minerHashrates[msg.miner] = msg.hashrate;
      if (pid === S.poolId) {
        const selectedMiner = localStorage.getItem(LS_MINER + S.poolId);
        if (msg.miner === selectedMiner) setEl('mm-live-hr', fmt.hash(msg.hashrate));
      }
    }

    if (type === 'newchainheight' && pid) {
      if (!S.wsCache[pid]) S.wsCache[pid] = { minerHashrates: {} };
      S.wsCache[pid].blockHeight = msg.blockHeight;
      if (pid === S.poolId) setEl('ov-net-height', msg.blockHeight);
    }

    if (type === 'blockfound' && pid === S.poolId) {
      const sym  = S.pool?.pool?.coin?.symbol || '';
      const icon = sym ? `assets/images/${sym.toLowerCase()}.svg` : null;
      toastBlockFound(msg.blockHeight, sym, icon);
      if (S.activeTab === 'overview') patchOverviewRest();
      if (S.activeTab === 'blocks')   renderBlocks(S.bPage);
    }

    if (type === 'blockunlocked' && pid === S.poolId) {
      if (S.pool?.pool) {
        const p = S.pool.pool;
        if (msg.totalBlocks          != null) p.totalBlocks          = msg.totalBlocks;
        if (msg.totalConfirmedBlocks != null) p.totalConfirmedBlocks = msg.totalConfirmedBlocks;
        if (msg.totalPendingBlocks   != null) p.totalPendingBlocks   = msg.totalPendingBlocks;
        if (msg.blocks24h            != null) p.blocks24h            = msg.blocks24h;
        if (msg.blockReward          != null) p.blockReward          = msg.blockReward;
      }
      patchOverviewRest();
      if (S.activeTab === 'blocks') renderBlocks(S.bPage);
    }

    if (type === 'payment' && pid === S.poolId) {
      const sym = S.pool?.pool?.coin?.symbol || '';
      toast(`${t('ws.payment')} ${fmt.coin(msg.amount, sym)}`, 'money-bill-transfer', 'ok');
      if (msg.totalPaid != null && S.pool?.pool) S.pool.pool.totalPaid = msg.totalPaid;
      patchOverviewRest();
      if (S.activeTab === 'myminer') refreshMinerDashboard();
    }
  };

  // -- Theme --

  const applyTheme = () => {
    const eff = S.theme === 'auto'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : S.theme;
    document.documentElement.setAttribute('data-bs-theme', eff);
    const lbl = $('theme-label');
    if (lbl) lbl.textContent = t(`theme.${S.theme}`);
    document.querySelectorAll('.mp-theme-menu .dropdown-item').forEach(item => {
      item.classList.toggle('active', item.dataset.theme === S.theme);
    });
  };

  // -- Toasts --

  const toast = (msg, icon = 'circle-info', type = 'info', dur = 5000) => {
    const box = $('mp-toasts');
    if (!box) return;
    while (box.children.length >= 4) box.firstChild.remove();
    const wrap = mk('div', `mp-toast ${type}`);
    wrap.append(mk('i', `fa-solid fa-${icon}`), document.createTextNode(msg));
    box.appendChild(wrap);
    setTimeout(() => {
      wrap.classList.add('mp-toast-out');
      setTimeout(() => wrap.remove(), 320);
    }, dur);
  };

  const toastBlockFound = (height, sym, iconPath) => {
    const box = $('mp-toasts');
    if (!box) return;
    while (box.children.length >= 4) box.firstChild.remove();
    const dur  = 8000;
    const wrap = mk('div', 'mp-toast mp-toast-block ok');

    const row      = mk('div', 'mp-toast-block-row');
    const iconWrap = mk('div', 'mp-toast-coin');
    if (iconPath) {
      const img = document.createElement('img');
      img.src = iconPath;
      img.alt = safe(sym);
      img.onerror = () => { img.remove(); iconWrap.appendChild(mk('i', 'fa-solid fa-cube')); };
      iconWrap.appendChild(img);
    } else {
      iconWrap.appendChild(mk('i', 'fa-solid fa-cube'));
    }
    const body = mk('div', 'mp-toast-body');
    body.appendChild(txt('div', 'mp-toast-head', `${t('ws.block-found')} ${sym}`));
    body.appendChild(txt('div', 'mp-toast-sub', `Block #${height}`));
    row.append(iconWrap, body);
    wrap.appendChild(row);

    const bar  = mk('div', 'mp-toast-bar');
    const fill = mk('div', 'mp-toast-bar-fill');
    bar.appendChild(fill);
    wrap.appendChild(bar);
    box.appendChild(wrap);

    fill.classList.add('mp-toast-bar-fill--full');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fill.classList.remove('mp-toast-bar-fill--full');
      fill.style.transitionDuration = `${dur}ms`;
    }));

    setTimeout(() => {
      wrap.classList.add('mp-toast-out');
      setTimeout(() => wrap.remove(), 320);
    }, dur);
  };

  // -- Pool loading / switching --

  const loadPools = async () => {
    if (!S.base) return;
    try {
      const data  = await api.pools();
      const pools = data.pools || [];
      const sel   = $('pool-select');
      if (!sel) return;
      sel.innerHTML = '';
      pools.forEach(p => {
        const opt = document.createElement('option');
        opt.value = safe(p.id);
        opt.textContent = `${safe(p.coin?.name || p.coin?.symbol || p.id)} (${safe(p.id)})`;
        sel.appendChild(opt);
      });
      if (!S.poolSelectBound) {
        sel.addEventListener('change', () => { if (sel.value) switchPool(sel.value); });
        S.poolSelectBound = true;
      }
      const saved = localStorage.getItem(LS_POOL);
      if (saved && pools.find(p => p.id === saved)) {
        sel.value = saved;
        await switchPool(saved);
      } else if (pools.length >= 1) {
        sel.value = pools[0].id;
        await switchPool(pools[0].id);
      }
    } catch { showNoPool($('tab-content-wrap')); }
  };

  const switchPool = async id => {
    // Guard against concurrent switchPool calls (race condition)
    if (S._switching) return;
    S._switching = true;
    clearTimers();
    S.poolId = id;
    localStorage.setItem(LS_POOL, id);
    try {
      S.pool  = await api.pool(id);
      S.bPage = 0;
      updateBrandIcon();
      renderActiveTab();
      startPollTimer();
    } catch { showError($('tab-content-wrap')); }
    finally { S._switching = false; }
  };

  const clearTimers = () => {
    clearInterval(S.pollTimer);
    clearInterval(S.relTimerHandle);
    clearInterval(S.ovPayTick);
    clearInterval(S.mmPayTick);
    S.pollTimer = null;
    S.relTimerHandle = null;
    S.ovPayTick    = null;
    S.mmPayTick    = null;
    S.ovPayTickRef = null;
    S.mmPayTickRef = null;
  };

  const startPollTimer = () => {
    // Always clear first — prevents timer accumulation if called more than once
    clearTimers();
    S.relTimerHandle = setInterval(() => {
      document.querySelectorAll('[data-rtime]').forEach(el => {
        el.textContent = fmt.time(el.dataset.rtime);
      });
    }, 30_000);

    S.chartAge = 0;
    S.pollTimer = setInterval(async () => {
      const pid = S.poolId;
      if (!pid) return;
      try {
        S.chartAge++;
        if (S.activeTab === 'overview' && S.chartAge >= CHART_REFRESH_CYCLES) {
          S.chartAge = 0;
          const chartWrap = document.querySelector('.mp-chart-wrap');
          if (chartWrap) { chartWrap.innerHTML = ''; loadChart(chartWrap, pid); }
        }
        if (S.activeTab === 'myminer') refreshMinerDashboard();
      } catch (err) { console.error('poll error', err); }
    }, POLL_MS);
  };

  const updateBrandIcon = () => {
    const coin  = S.pool?.pool?.coin;
    const brand = document.querySelector('.mp-brand');
    if (!brand) return;
    let iconEl = brand.querySelector('.mp-brand-coin');
    if (!iconEl) {
      iconEl = mk('span', 'mp-brand-coin');
      brand.insertBefore(iconEl, brand.firstChild);
    }
    iconEl.innerHTML = '';
    if (!coin?.symbol) { iconEl.appendChild(mk('i', 'fa-solid fa-cube')); return; }
    const img = document.createElement('img');
    img.src = `assets/images/${safe(coin.symbol).toLowerCase()}.svg`;
    img.alt = safe(coin.symbol);
    img.onerror = () => { img.remove(); iconEl.appendChild(mk('i', 'fa-solid fa-cube')); };
    iconEl.appendChild(img);
    document.title = `${safe(coin.name || coin.symbol)} Pool`;
  };

  let _renderTabTimer = null;
  const renderActiveTab = () => {
    clearTimeout(_renderTabTimer);
    _renderTabTimer = setTimeout(() => {
      switch (S.activeTab) {
        case 'overview': renderOverview(); break;
        case 'blocks':   renderBlocks(S.bPage); break;
        case 'start':    renderStart();   break;
        case 'myminer':  renderMyMiner(); break;
      }
    }, 50);
  };

  // -- Overview --

  const renderOverview = async () => {
    const wrap = $('pane-overview');
    if (!wrap) return;
    if (!S.pool) { showNoPool(wrap); return; }
    const seq = ++S.ovSeq;
    const pid = S.poolId;
    wrap.innerHTML = '';

    const p    = S.pool.pool;
    const ns   = p.networkStats      || {};
    const ps   = p.poolStats         || {};
    const pp   = p.paymentProcessing || {};
    const coin = p.coin              || {};
    const sym  = safe(coin.symbol);
    const liveHr     = ps.poolHashrate ?? 0;
    const liveHeight = wsBlockHeight()  ?? ns.blockHeight  ?? 0;

    const grid = mk('div', 'mp-ov-grid');
    grid.appendChild(buildCoinCard(coin, ns, p, liveHeight, sym));
    grid.appendChild(buildPoolCard(p, ps, pp, liveHr, sym));
    grid.appendChild(buildRoundCard(p, ns, liveHr, sym));
    wrap.appendChild(grid);

    const chartRow  = mk('div', 'mp-ov-chart-row');
    const chartCard = mk('div', 'mp-chart-card');
    const chartHead = mk('div', 'mp-chart-head');
    chartHead.appendChild(txt('span', 'mp-chart-title', t('chart.title')));
    const chartHrSpan = txt('span', 'mp-chart-current', fmt.hash(liveHr));
    chartHrSpan.id = 'mp-chart-current';
    chartHead.appendChild(chartHrSpan);
    chartCard.appendChild(chartHead);
    const chartWrap = mk('div', 'mp-chart-wrap');
    chartCard.appendChild(chartWrap);
    chartRow.appendChild(chartCard);
    wrap.appendChild(chartRow);
    loadChart(chartWrap, pid);

    const minersHeader = mk('div', 'mp-section');
    minersHeader.appendChild(document.createTextNode(t('topminers.title')));
    const minersCount = txt('span', 'mp-section-count', String(TOP_SIZE));
    minersHeader.appendChild(minersCount);
    wrap.appendChild(minersHeader);
    await loadTopMiners(wrap, pid, seq);
  };

  const buildCoinCard = (coin, ns, p, liveHeight, sym) => {
    const card  = mk('div', 'mp-card');
    const head  = mk('div', 'mp-card-head');
    const title = mk('div', 'mp-card-title');
    const iconEl = mk('span', 'mp-coin-title-icon');
    if (sym) {
      const img = document.createElement('img');
      img.src = `assets/images/${sym.toLowerCase()}.svg`;
      img.alt = sym;
      img.width = 16;
      img.height = 16;
      img.onerror = () => { img.remove(); iconEl.appendChild(mk('i', 'fa-solid fa-coins')); };
      iconEl.appendChild(img);
    } else {
      iconEl.appendChild(mk('i', 'fa-solid fa-coins'));
    }
    title.appendChild(iconEl);
    title.appendChild(document.createTextNode(t('card.coin')));
    head.appendChild(title);
    card.appendChild(head);

    const metricRows = [
      ['coin.network', ns.networkType || coin.type || null,    null,     null],
      ['coin.project', coin.name || coin.canonicalName || null, null,    null],
      ['coin.ticker',  sym || null,                             null,    null],
      ['coin.algo',    coin.algorithm || null,                  null,    null],
      ['net.height',   liveHeight ? String(liveHeight) : '--',  'accent','ov-net-height'],
      ['net.hashrate',   fmt.hash(ns.networkHashrate),           null,   'ov-net-hr'],
      ['net.difficulty', fmt.diff(ns.networkDifficulty),         null,   'ov-net-diff'],
      ['net.last-block', fmt.time(ns.lastNetworkBlockTime),      null,   'ov-net-last-blk'],
      ['net.version',    ns.nodeVersion || null,                 null,   'ov-net-ver'],
      ['net.peers',      ns.connectedPeers !== null && ns.connectedPeers !== undefined
        ? String(ns.connectedPeers) : null,                      null,   'ov-net-peers'],
    ];

    metricRows.forEach(([key, val, cls, id]) => {
      if (!val) return;
      appendMetricRow(card, t(key), safe(val), cls, id);
    });

    const socialDefs = [
      [coin.website,  'fa-solid fa-globe',      t('coin.website') || 'Website'],
      [coin.twitter,  'fa-brands fa-x-twitter', 'Twitter'],
      [coin.discord,  'fa-brands fa-discord',   'Discord'],
      [coin.telegram, 'fa-brands fa-telegram',  'Telegram'],
      [coin.github,   'fa-brands fa-github',    'GitHub'],
      [coin.market,   'fa-solid fa-store',      t('coin.market') || 'Market'],
    ];
    socialDefs.forEach(([url, iconCls, label]) => {
      if (!url) return;
      const row = mk('div', 'mp-social-link-row');
      const ico = mk('i', iconCls);
      const a   = mk('a', 'mp-social-link-a');
      a.href = safeUrl(url);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = label;
      row.append(ico, a);
      card.appendChild(row);
    });

    return card;
  };

  const buildPoolCard = (p, ps, pp, liveHr, sym) => {
    const card  = mk('div', 'mp-card');
    const head  = mk('div', 'mp-card-head');
    const title = mk('div', 'mp-card-title');
    title.appendChild(mk('i', 'fa-solid fa-server'));
    title.appendChild(document.createTextNode(t('card.pool')));
    head.appendChild(title);
    card.appendChild(head);

    const rows = [
      ['pool.hashrate',       fmt.hash(liveHr),                                              'accent', 'ov-pool-hr'],
      ['pool.miners',         ps.connectedMiners !== null && ps.connectedMiners !== undefined ? String(ps.connectedMiners) : null, null, 'ov-pool-miners'],
      ['pool.workers.online', p.workersOnline !== null && p.workersOnline !== undefined ? String(p.workersOnline) : null, 'ok', 'ov-pool-workers'],
      ['pool.shares',         ps.sharesPerSecond !== null && ps.sharesPerSecond !== undefined ? ps.sharesPerSecond.toFixed(3) : null, null, 'ov-pool-shares'],
      ['pool.fee',            p.poolFeePercent !== null && p.poolFeePercent !== undefined ? `${p.poolFeePercent}%` : null, null, null],
      ['pool.scheme',         pp.payoutScheme || null,                                         null, null],
      ['pool.min-payout',     pp.minimumPayment !== null && pp.minimumPayment !== undefined ? `${fmt.num(pp.minimumPayment, 8)} ${sym}`.trim() : null, null, null],
      ['pool.interval',       pp.paymentIntervalSeconds ? fmt.interval(pp.paymentIntervalSeconds) : null, null, null],
      ['pool.total-paid',     p.totalPaid !== null && p.totalPaid !== undefined ? fmt.coin(p.totalPaid, sym) : null, null, 'ov-pool-total-paid'],
    ];
    rows.forEach(([key, val, cls, id]) => {
      if (val === null || val === undefined) return;
      appendMetricRow(card, t(key), safe(val), cls, id);
    });

    if (p.lastPaymentTime && pp.paymentIntervalSeconds) {
      appendPaymentCountdown(card, p.lastPaymentTime, pp.paymentIntervalSeconds, 'ov-pool-next-pay', 'ovPayTick');
    }

    const portEntries = Object.entries(p.ports || {});
    if (portEntries.length) {
      const [, cfg] = portEntries[0];
      [
        ['start.start-diff',  cfg.difficulty !== null && cfg.difficulty !== undefined ? String(cfg.difficulty) : null],
        ['start.var-min',     cfg.varDiff?.minDiff !== null && cfg.varDiff?.minDiff !== undefined ? String(cfg.varDiff.minDiff) : null],
        ['start.var-max',     cfg.varDiff?.maxDiff !== null && cfg.varDiff?.maxDiff !== undefined ? String(cfg.varDiff.maxDiff) : null],
        ['start.target-time', cfg.varDiff?.targetTime ? `${cfg.varDiff.targetTime}s` : null],
        ['start.tls',         t(cfg.tls ? 'misc.yes' : 'misc.no')],
      ].forEach(([key, val]) => {
        if (val === null || val === undefined) return;
        appendMetricRow(card, t(key), val, null, null);
      });
    }

    return card;
  };

  const buildRoundCard = (p, ns, liveHr, sym) => {
    const eff  = Number(p.poolEffort ?? 0);
    const card = mk('div', 'mp-card');
    const head = mk('div', 'mp-card-head');
    const htitle = mk('div', 'mp-card-title');
    htitle.appendChild(mk('i', 'fa-solid fa-circle-notch'));
    htitle.appendChild(document.createTextNode(t('card.round')));
    head.appendChild(htitle);
    card.appendChild(head);

    const effortRow = mk('div', 'mp-metric');
    effortRow.append(txt('span', 'mp-metric-lbl', t('round.effort')), buildEffortBar(eff, 'ov-effort'));
    card.appendChild(effortRow);

    [
      ['round.ttf',        fmt.ttf(ns.networkDifficulty, liveHr),                              null, 'ov-round-ttf'],
      ['round.last-block', fmt.time(p.lastPoolBlockTime),                                       null, 'ov-round-last-blk'],
      ['round.reward',     p.blockReward !== null && p.blockReward !== undefined ? fmt.coin(p.blockReward, sym) : null, null, 'ov-round-reward'],
      ['round.blocks-24h', p.blocks24h !== null && p.blocks24h !== undefined ? String(p.blocks24h) : null, null, 'ov-round-24h'],
      ['round.total',      p.totalBlocks !== null && p.totalBlocks !== undefined ? String(p.totalBlocks) : null, null, 'ov-round-total'],
      ['round.confirmed',  p.totalConfirmedBlocks !== null && p.totalConfirmedBlocks !== undefined ? String(p.totalConfirmedBlocks) : null, null, 'ov-round-confirmed'],
      ['round.pending',    p.totalPendingBlocks !== null && p.totalPendingBlocks !== undefined ? String(p.totalPendingBlocks) : null, null, 'ov-round-pending'],
    ].forEach(([key, val, cls, id]) => {
      if (val === null || val === undefined) return;
      appendMetricRow(card, t(key), safe(val), cls, id);
    });

    return card;
  };

  const patchOverviewRest = () => {
    if (!S.pool) return;
    const p   = S.pool.pool;
    const ps  = p.poolStats         || {};
    const ns  = p.networkStats      || {};
    const pp  = p.paymentProcessing || {};
    const sym = safe(p.coin?.symbol || '');
    const liveHr = ps.poolHashrate ?? 0;

    if (wsBlockHeight() === null) setEl('ov-net-height', ns.blockHeight);
    setEl('ov-net-hr',       fmt.hash(ns.networkHashrate));
    setEl('ov-net-diff',     fmt.diff(ns.networkDifficulty));
    setEl('ov-net-last-blk', fmt.time(ns.lastNetworkBlockTime));
    if (ns.nodeVersion)                      setEl('ov-net-ver',   ns.nodeVersion);
    if (ns.connectedPeers !== null && ns.connectedPeers !== undefined) setEl('ov-net-peers', String(ns.connectedPeers));

    setEl('ov-pool-hr', fmt.hash(ps.poolHashrate));
    if (ps.connectedMiners !== null && ps.connectedMiners !== undefined) setEl('ov-pool-miners',    String(ps.connectedMiners));
    if (p.workersOnline    !== null && p.workersOnline    !== undefined) setEl('ov-pool-workers',   String(p.workersOnline));
    if (ps.sharesPerSecond !== null && ps.sharesPerSecond !== undefined) setEl('ov-pool-shares',    ps.sharesPerSecond.toFixed(3));
    if (p.totalPaid        !== null && p.totalPaid        !== undefined) setEl('ov-pool-total-paid', fmt.coin(p.totalPaid, sym));

    const eff = Number(p.poolEffort ?? 0);
    setEl('ov-effort', fmt.effort(eff));
    patchEffortBarFill('ov-effort-fill', eff);

    setEl('ov-round-ttf',      fmt.ttf(ns.networkDifficulty, liveHr));
    setEl('ov-round-last-blk', fmt.time(p.lastPoolBlockTime));
    if (p.blockReward          !== null && p.blockReward          !== undefined) setEl('ov-round-reward',    fmt.coin(p.blockReward, sym));
    if (p.blocks24h            !== null && p.blocks24h            !== undefined) setEl('ov-round-24h',       String(p.blocks24h));
    if (p.totalBlocks          !== null && p.totalBlocks          !== undefined) setEl('ov-round-total',     String(p.totalBlocks));
    if (p.totalConfirmedBlocks !== null && p.totalConfirmedBlocks !== undefined) setEl('ov-round-confirmed', String(p.totalConfirmedBlocks));
    if (p.totalPendingBlocks   !== null && p.totalPendingBlocks   !== undefined) setEl('ov-round-pending',   String(p.totalPendingBlocks));

    setEl('mp-chart-current', fmt.hash(liveHr));

    if (p.totalBlocks          !== null && p.totalBlocks          !== undefined) setEl('blk-sum-total',     String(p.totalBlocks));
    if (p.totalConfirmedBlocks !== null && p.totalConfirmedBlocks !== undefined) setEl('blk-sum-confirmed', String(p.totalConfirmedBlocks));
    if (p.totalPendingBlocks   !== null && p.totalPendingBlocks   !== undefined) setEl('blk-sum-pending',   String(p.totalPendingBlocks));

    const ovCountdownEl = $('ov-pool-next-pay');
    if (ovCountdownEl && p.lastPaymentTime && pp.paymentIntervalSeconds) {
      const card = ovCountdownEl.closest('.mp-card');
      if (card) appendPaymentCountdown(card, p.lastPaymentTime, pp.paymentIntervalSeconds, 'ov-pool-next-pay', 'ovPayTick');
    }
  };

  // -- Chart --

  const loadChart = async (wrap, pid) => {
    try {
      const data = await api.perf(pid);
      if (S.poolId !== pid) return;
      const pts  = (data.stats || []).filter(p => p.poolHashrate > 0);
      if (!pts.length) { wrap.appendChild(txt('div', 'mp-chart-empty', t('chart.no-data'))); return; }
      const container = buildChartSvg(pts);
      if (container) wrap.appendChild(container);
    } catch {
      if (S.poolId !== pid) return;
      wrap.appendChild(txt('div', 'mp-chart-empty', t('chart.no-data')));
    }
  };

  const buildChartSvg = pts => {
    if (!pts?.length) return null;
    const W = 600, H = 90, pad = 4;
    const vals = pts.map(p => Number(p.poolHashrate));
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const rng = mx - mn || 1;
    const xs  = pts.map((_, i) => pad + (i / Math.max(pts.length - 1, 1)) * (W - pad * 2));
    const ys  = vals.map(v => pad + (H - pad * 2) - ((v - mn) / rng) * (H - pad * 2));
    const line = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join('L');
    const area = `M${line}L${xs[xs.length - 1].toFixed(1)},${H}L${xs[0].toFixed(1)},${H}Z`;
    const gradId = `mpGrd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    const container = mk('div', 'mp-chart-container');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--tab-active)" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="var(--tab-active)" stop-opacity="0.02"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#${gradId})"/>
    <path d="M${line}" fill="none" stroke="var(--tab-active)" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>`;

    const hair = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    hair.setAttribute('stroke', 'var(--text-muted)');
    hair.setAttribute('stroke-width', '1');
    hair.setAttribute('stroke-dasharray', '3,3');
    hair.classList.add('mp-chart-hair');
    svg.appendChild(hair);

    const tip = mk('div', 'mp-chart-tip mp-chart-tip--hidden');

    const fmtHour = iso => {
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    const showAt = clientX => {
      const rect = svg.getBoundingClientRect();
      const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const idx  = Math.round(relX * (pts.length - 1));
      const pt   = pts[idx];
      const svgX = xs[idx];
      hair.setAttribute('x1', svgX); hair.setAttribute('x2', svgX);
      hair.setAttribute('y1', pad);  hair.setAttribute('y2', H - pad);
      hair.classList.remove('mp-chart-hair');
      tip.textContent = `${fmtHour(pt.created)} · ${fmt.hash(pt.poolHashrate)}`;
      tip.classList.remove('mp-chart-tip--hidden');
      tip.style.left = `${Math.min(relX * 100, 65)}%`;
    };

    const hideChart = () => {
      tip.classList.add('mp-chart-tip--hidden');
      hair.classList.add('mp-chart-hair');
    };

    svg.addEventListener('mousemove', e => showAt(e.clientX));
    svg.addEventListener('mouseleave', hideChart);
    svg.addEventListener('touchstart', e => { e.preventDefault(); showAt(e.touches[0].clientX); }, { passive: false });
    svg.addEventListener('touchend', () => setTimeout(hideChart, 1200));

    const axis = mk('div', 'mp-chart-axis');
    [0, Math.floor((pts.length - 1) / 2), pts.length - 1].forEach(i => {
      axis.appendChild(txt('span', 'mp-chart-axis-lbl', fmtHour(pts[i].created)));
    });

    container.append(svg, tip, axis);
    return container;
  };

  // -- Top miners --

  const RANK_ICONS = [
    { cls: 'mp-rank-gold',   icon: 'fa-crown' },
    { cls: 'mp-rank-silver', icon: 'fa-medal' },
    { cls: 'mp-rank-bronze', icon: 'fa-medal' },
  ];

  const buildMinerRow = (m, i) => {
    const row    = mk('tr');
    const rankTd = mk('td', 'rank');
    if (i < 3) {
      const { cls, icon } = RANK_ICONS[i];
      rankTd.appendChild(mk('i', `fa-solid ${icon} ${cls}`));
    } else {
      rankTd.textContent = String(i + 1);
    }
    row.appendChild(rankTd);
    const addrTd = mk('td', 'addr');
    addrTd.textContent = fmt.addr(m.miner, 16);
    addrTd.title = safe(m.miner);
    row.appendChild(addrTd);
    row.appendChild(txt('td', 'mono', fmt.hash(m.hashrate)));
    row.appendChild(txt('td', 'mono', m.sharesPerSecond?.toFixed(3) ?? '--'));
    return row;
  };

  const loadTopMiners = async (wrap, pid, seq) => {
    try {
      const miners = await api.miners(pid, 0, TOP_SIZE);
      if (S.poolId !== pid || S.ovSeq !== seq) return;
      buildTopMinersTable(wrap, miners || []);
    } catch {
      if (S.poolId !== pid || S.ovSeq !== seq) return;
      buildTopMinersTable(wrap, S.pool?.pool?.topMiners || []);
    }
  };

  const buildTopMinersTable = (wrap, miners) => {
    const box   = mk('div', 'mp-table-box');
    const table = mk('table', 'mp-table');
    const thead = mk('thead');
    const hrow  = mk('tr');
    ['topminers.rank','topminers.miner','topminers.hashrate','topminers.shares'].forEach(k => {
      hrow.appendChild(txt('th', '', t(k)));
    });
    thead.appendChild(hrow);
    table.appendChild(thead);
    const tbody = mk('tbody');
    tbody.id = 'mp-top-miners-tbody';
    if (miners.length) miners.forEach((m, i) => tbody.appendChild(buildMinerRow(m, i)));
    table.appendChild(tbody);
    box.appendChild(table);
    wrap.appendChild(box);
  };

  const patchTopMiners = async pid => {
    const tbody = $('mp-top-miners-tbody');
    if (!tbody) return;
    try {
      const miners = await api.miners(pid, 0, TOP_SIZE);
      if (S.poolId !== pid) return;
      const list = miners || [];
      tbody.innerHTML = '';
      if (!list.length) {
        const row = mk('tr');
        const td  = mk('td');
        td.colSpan = 4;
        td.className = 'mp-empty';
        td.textContent = t('miners.empty');
        row.appendChild(td);
        tbody.appendChild(row);
      } else {
        list.forEach((m, i) => tbody.appendChild(buildMinerRow(m, i)));
      }
    } catch { /* keep stale */ }
  };

  // -- Blocks --

  const buildBlockRow = (b, sym, showMiner = true) => {
    const row  = mk('tr');
    const htd  = mk('td', 'mono');
    if (b.infoLink) {
      const a = mk('a');
      a.href = safeUrl(b.infoLink);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = safe(b.blockHeight);
      htd.appendChild(a);
    } else {
      htd.textContent = safe(b.blockHeight);
    }
    row.appendChild(htd);

    const timeTd = mk('td', 'mono');
    timeTd.textContent = fmt.time(b.created);
    timeTd.title = fmt.absTime(b.created);
    if (b.created) timeTd.dataset.rtime = b.created;
    row.appendChild(timeTd);

    row.appendChild(txt('td', 'mono', b.reward !== null && b.reward !== undefined ? fmt.coin(b.reward, sym) : '--'));

    const effTd = mk('td', 'mp-effort-td');
    effTd.appendChild(buildEffortBar(b.effort));
    row.appendChild(effTd);

    if (showMiner) {
      const mTd = mk('td', 'addr');
      mTd.textContent = fmt.addr(b.miner, 12);
      mTd.title = safe(b.miner);
      row.appendChild(mTd);
    }

    const sTd = mk('td');
    const st  = (b.status || '').toLowerCase();
    let badgeCls = 'mp-badge-inf', stLbl = safe(b.status);
    if (st === 'confirmed')     { badgeCls = 'mp-badge-ok';  stLbl = t('blocks.confirmed'); }
    else if (st === 'pending')  { badgeCls = 'mp-badge-pnd'; stLbl = t('blocks.pending');   }
    else if (st === 'orphaned') { badgeCls = 'mp-badge-err'; stLbl = t('blocks.orphaned');  }
    sTd.appendChild(txt('span', `mp-badge ${badgeCls}`, stLbl));
    row.appendChild(sTd);
    return row;
  };

  const renderBlocks = async (page = 0) => {
    const wrap = $('pane-blocks');
    if (!wrap) return;
    if (!S.poolId) { showNoPool(wrap); return; }
    const pid = S.poolId;

    const isInit = page === 0 && !wrap.querySelector('.mp-table-box');
    if (isInit) { wrap.innerHTML = ''; showLoading(wrap); }

    try {
      const raw     = await api.blocks(pid, page, PAGE_SIZE + 1);
      if (S.poolId !== pid) return;
      const hasNext = (raw?.length ?? 0) > PAGE_SIZE;
      const blocks  = hasNext ? raw.slice(0, PAGE_SIZE) : (raw ?? []);
      S.bPage = page;

      if (isInit) wrap.innerHTML = '';

      const p = S.pool?.pool;
      let summaryBar = wrap.querySelector('.mp-summary-bar');
      if (!summaryBar && p) {
        summaryBar = mk('div', 'mp-summary-bar');
        [
          [t('round.total'),      p.totalBlocks,          'blk-sum-total'],
          [t('blocks.confirmed'), p.totalConfirmedBlocks,  'blk-sum-confirmed'],
          [t('blocks.pending'),   p.totalPendingBlocks,    'blk-sum-pending'],
        ].forEach(([lbl, val, id]) => {
          const pill   = mk('div', 'mp-summary-pill');
          const strong = txt('strong', '', safe(val ?? '--'));
          if (id) strong.id = id;
          pill.append(txt('span', '', lbl), strong);
          summaryBar.appendChild(pill);
        });
        wrap.appendChild(summaryBar);
      }

      const existing = wrap.querySelector('.mp-table-box');
      if (existing && page > 0) wrap.style.minHeight = `${wrap.offsetHeight}px`;
      if (existing) existing.remove();

      const sym   = S.pool?.pool?.coin?.symbol || '';
      const box   = mk('div', 'mp-table-box');
      const table = mk('table', 'mp-table');
      const thead = mk('thead');
      const hrow  = mk('tr');
      ['blocks.height','blocks.time','blocks.reward','blocks.effort','blocks.miner','blocks.status'].forEach(k => {
        hrow.appendChild(txt('th', '', t(k)));
      });
      thead.appendChild(hrow);
      table.appendChild(thead);

      const tbody = mk('tbody');
      if (!blocks.length) {
        const row = mk('tr');
        const td  = mk('td');
        td.colSpan = 6;
        td.className = 'mp-empty';
        td.textContent = t('blocks.empty');
        row.appendChild(td);
        tbody.appendChild(row);
      } else {
        blocks.forEach(b => tbody.appendChild(buildBlockRow(b, sym, true)));
      }
      table.appendChild(tbody);
      box.appendChild(table);
      box.appendChild(buildPager(page, hasNext ? PAGE_SIZE : blocks.length, pg => renderBlocks(pg)));
      wrap.appendChild(box);
      wrap.style.minHeight = '';
    } catch { wrap.style.minHeight = ''; wrap.innerHTML = ''; showError(wrap); }
  };

  // -- Start mining --

  const renderStart = () => {
    const wrap = $('pane-start');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!S.pool) { showNoPool(wrap); return; }
    const p    = S.pool.pool;
    const coin = p.coin  || {};
    const ports = Object.entries(p.ports || {});
    wrap.appendChild(buildGenerator(ports, coin, p));
  };

  const buildGenerator = (ports, coin, p) => {
    const card = mk('div', 'mp-gen-card');
    card.appendChild(txt('div', 'mp-gen-title', t('start.generator')));

    const host = (() => { try { return new URL(S.base).hostname; } catch { return 'pool.host'; } })();
    const algo = safe(coin.algorithm || 'argon2id').toLowerCase();

    const row1    = mk('div', 'mp-gen-row');
    const addrGrp = mk('div', 'mp-gen-group grow');
    addrGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.address')));
    const addrInp = mk('input', 'mp-gen-input');
    addrInp.type = 'text';
    addrInp.id = 'gen-addr';
    addrInp.placeholder = t('start.addr-placeholder');
    addrInp.autocomplete = 'off';
    addrInp.spellcheck = false;
    addrGrp.appendChild(addrInp);

    const wrkGrp = mk('div', 'mp-gen-group');
    const wrkLbl = mk('div', 'mp-gen-lbl');
    wrkLbl.textContent = t('start.worker');
    wrkLbl.appendChild(txt('small', '', t('start.worker-hint')));
    wrkGrp.appendChild(wrkLbl);
    const wrkInp = mk('input', 'mp-gen-input');
    wrkInp.type = 'text';
    wrkInp.id = 'gen-worker';
    wrkInp.placeholder = t('start.worker-placeholder');
    wrkGrp.appendChild(wrkInp);
    row1.append(addrGrp, wrkGrp);

    const stratumRow = mk('div', 'mp-gen-row');
    const stratumGrp = mk('div', 'mp-gen-group grow');
    stratumGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.stratum')));
    const stratumInp = mk('input', 'mp-gen-input mp-stratum-inp');
    stratumInp.type = 'text';
    stratumInp.id = 'gen-stratum';
    stratumInp.placeholder = `stratum+tcp://${host}:3032`;
    stratumInp.autocomplete = 'off';
    stratumInp.spellcheck = false;
    stratumGrp.appendChild(stratumInp);
    stratumRow.appendChild(stratumGrp);

    const row2    = mk('div', 'mp-gen-row');
    const portGrp = mk('div', 'mp-gen-group');
    portGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.select-port')));
    const portSel = mk('select', 'mp-gen-select');
    portSel.id = 'gen-port';
    ports.forEach(([port, cfg]) => {
      const opt = document.createElement('option');
      opt.value = safe(port);
      opt.textContent = `${port} (${cfg.tls ? 'SSL' : 'TCP'})`;
      portSel.appendChild(opt);
    });
    portGrp.appendChild(portSel);

    const modeGrp = mk('div', 'mp-gen-group');
    modeGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.mining-type')));
    const modeSel = mk('select', 'mp-gen-select');
    modeSel.id = 'gen-mode';
    [['cpu', t('start.cpu')], ['opencl', t('start.gpu-opencl')], ['cuda', t('start.gpu-cuda')]].forEach(([v, l]) => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = l;
      modeSel.appendChild(opt);
    });
    modeGrp.appendChild(modeSel);

    const archGrp = mk('div', 'mp-gen-group');
    archGrp.id = 'gen-arch-wrap';
    archGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.arch')));
    const archSel = mk('select', 'mp-gen-select');
    archSel.id = 'gen-arch';
    CPU_ARCHS.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a;
      archSel.appendChild(opt);
    });
    archGrp.appendChild(archSel);

    const thrGrp = mk('div', 'mp-gen-group');
    thrGrp.id = 'gen-thr-wrap';
    thrGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.threads')));
    const thrInp = mk('input', 'mp-gen-input');
    thrInp.type = 'number';
    thrInp.id = 'gen-threads';
    thrInp.value = '2';
    thrInp.min = '1';
    thrInp.max = '256';
    thrGrp.appendChild(thrInp);

    const bsGrp = mk('div', 'mp-gen-group mp-gen-group--hidden');
    bsGrp.id = 'gen-bs-wrap';
    bsGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.batchsize')));
    const bsInp = mk('input', 'mp-gen-input');
    bsInp.type = 'number';
    bsInp.id = 'gen-bs';
    bsInp.value = '3484';
    bsInp.min = '64';
    bsGrp.appendChild(bsInp);

    const gpuGrp = mk('div', 'mp-gen-group mp-gen-group--hidden');
    gpuGrp.id = 'gen-gpu-wrap';
    gpuGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.gpu-id')));
    const gpuInp = mk('input', 'mp-gen-input');
    gpuInp.type = 'number';
    gpuInp.id = 'gen-gpu';
    gpuInp.value = '0';
    gpuInp.min = '0';
    gpuGrp.appendChild(gpuInp);

    const diffGrp = mk('div', 'mp-gen-group');
    diffGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.diff')));
    const diffInp = mk('input', 'mp-gen-input');
    diffInp.type = 'number';
    diffInp.id = 'gen-diff';
    diffInp.placeholder = t('start.diff-placeholder');
    diffInp.min = '0';
    diffGrp.appendChild(diffInp);

    row2.append(portGrp, modeGrp, archGrp, thrGrp, bsGrp, gpuGrp, diffGrp);

    const cmdRow = mk('div', 'mp-gen-row');
    const cmdGrp = mk('div', 'mp-gen-group grow');
    cmdGrp.appendChild(txt('div', 'mp-gen-lbl', t('start.cmd-label')));
    const cmdWrap = mk('div', 'mp-cmd-wrap');
    const cmdBox  = mk('div', 'mp-cmd-box');
    cmdBox.id = 'gen-cmd';
    cmdBox.appendChild(txt('span', 'mp-cmd-hint', t('start.enter-address')));
    const copyBtn = txt('button', 'mp-cmd-copy', t('start.copy'));
    copyBtn.type = 'button';
    cmdWrap.append(cmdBox, copyBtn);
    cmdGrp.appendChild(cmdWrap);
    cmdRow.appendChild(cmdGrp);

    card.append(row1, stratumRow, row2, cmdRow);

    const buildCmd = () => {
      const port    = safe(portSel.value);
      const portCfg = (p.ports || {})[port] || {};
      const proto   = portCfg.tls ? 'stratum+ssl' : 'stratum+tcp';
      const computed = `${proto}://${host}:${port}`;
      if (!stratumInp.dataset.manual) stratumInp.value = computed;
      const server = safe(stratumInp.value) || computed;
      const addr   = safe(addrInp.value);
      if (!addr) {
        cmdBox.innerHTML = '';
        cmdBox.appendChild(txt('span', 'mp-cmd-hint', t('start.enter-address')));
        return;
      }
      const wrk   = safe(wrkInp.value);
      const mode  = modeSel.value;
      const user  = wrk ? `${addr}.${wrk}` : addr;
      const rawDiff  = safe(diffInp.value);
      const diffVal  = parseInt(rawDiff, 10);
      const safeDiff = Number.isFinite(diffVal) && diffVal > 0 ? diffVal : null;
      if (rawDiff && safeDiff === null) diffInp.value = '';
      const pass = safeDiff !== null ? `d=${safeDiff}` : 'x';

      let cmd;
      if (mode === 'cpu') {
        const arch = safe(archSel.value);
        const thr  = Math.max(1, parseInt(thrInp.value, 10) || 1);
        cmd = `cpuminer-${arch} -a ${algo} -o ${server} -u ${user} -p ${pass} -t ${thr}`;
      } else {
        const gpuType = mode === 'opencl' ? 'OpenCL' : 'CUDA';
        const bs  = Math.max(64, parseInt(bsInp.value, 10) || 3484);
        const gid = Math.max(0, parseInt(gpuInp.value, 10) || 0);
        cmd = `cpuminer-sse2 -a ${algo} --use-gpu ${gpuType} -o ${server} -u ${user} -p ${pass} --gpu-batchsize ${bs} --gpu-id ${gid}`;
      }
      cmdBox.textContent = cmd;
    };

    stratumInp.addEventListener('input', () => { stratumInp.dataset.manual = '1'; buildCmd(); });
    portSel.addEventListener('change', () => { delete stratumInp.dataset.manual; buildCmd(); });

    const toggleGpu = () => {
      const gpu = modeSel.value !== 'cpu';
      archGrp.classList.toggle('mp-gen-group--hidden', gpu);
      thrGrp.classList.toggle('mp-gen-group--hidden', gpu);
      bsGrp.classList.toggle('mp-gen-group--hidden', !gpu);
      gpuGrp.classList.toggle('mp-gen-group--hidden', !gpu);
      buildCmd();
    };

    [addrInp, wrkInp, archSel, thrInp, bsInp, gpuInp, diffInp].forEach(el => el.addEventListener('input', buildCmd));
    modeSel.addEventListener('change', toggleGpu);
    copyBtn.addEventListener('click', () => {
      const cmd = cmdBox.textContent;
      if (!cmd || cmdBox.querySelector('.mp-cmd-hint')) return;
      navigator.clipboard?.writeText(cmd).then(() => {
        copyBtn.textContent = t('start.copied');
        setTimeout(() => { copyBtn.textContent = t('start.copy'); }, 1800);
      });
    });

    buildCmd();
    return card;
  };

  // -- My Miner --

  const refreshMinerDashboard = () => {
    const addr = localStorage.getItem(LS_MINER + S.poolId);
    if (!addr) return;
    const wrap = $('pane-myminer');
    if (!wrap || !wrap.querySelector('.mp-miner-header')) return;
    patchMinerStats(addr);
  };

  const patchMinerStats = async addr => {
    const pid = S.poolId;
    const sym = S.pool?.pool?.coin?.symbol || '';
    try {
      const [mStats, mPerf] = await Promise.all([
        api.miner(pid, addr).catch(() => null),
        api.minerPerf(pid, addr).catch(() => null),
      ]);
      if (S.poolId !== pid) return;
      if (!mStats) return;

      if (mStats.pendingBalance  !== null && mStats.pendingBalance  !== undefined) setEl('mm-balance',     fmt.coin(mStats.pendingBalance, sym));
      if (mStats.totalPaid       !== null && mStats.totalPaid       !== undefined) setEl('mm-total-paid',  fmt.coin(mStats.totalPaid, sym));
      if (mStats.todayPaid       !== null && mStats.todayPaid       !== undefined) setEl('mm-today-paid',  fmt.coin(mStats.todayPaid, sym));
      if (mStats.lastPayment)                                                       setEl('mm-last-pay',    fmt.time(mStats.lastPayment));
      if (mStats.totalConfirmedBlocks !== null && mStats.totalConfirmedBlocks !== undefined)
        setEl('mm-blocks-found', `${mStats.totalConfirmedBlocks} confirmed / ${mStats.totalPendingBlocks ?? 0} pending`);

      const pp = S.pool?.pool?.paymentProcessing || {};
      const mmCountdownEl = $('mm-next-pay');
      if (mStats.lastPayment && pp.paymentIntervalSeconds) {
        const card = mmCountdownEl?.closest('.mp-card');
        if (card) appendPaymentCountdown(card, mStats.lastPayment, pp.paymentIntervalSeconds, 'mm-next-pay', 'mmPayTick');
      }

      const liveHr      = wsMinerHr(addr);
      const perfWorkers = Object.values(mStats.performance?.workers ?? {});
      const totalHr     = liveHr !== null ? liveHr : perfWorkers.reduce((a, w) => a + (w.hashrate ?? 0), 0);
      const totalSps    = perfWorkers.reduce((a, w) => a + (w.sharesPerSecond ?? 0), 0);

      if (liveHr === null) setEl('mm-live-hr', fmt.hash(totalHr));
      setEl('mm-shares', totalSps.toFixed(3));
      if (mStats.workersOnline  !== null && mStats.workersOnline  !== undefined) setEl('mm-workers-online',  String(mStats.workersOnline));
      if (mStats.workersOffline !== null && mStats.workersOffline !== undefined) setEl('mm-workers-offline', String(mStats.workersOffline));
      if (mStats.pendingShares  !== null && mStats.pendingShares  !== undefined) setEl('mm-pending-shares',  mStats.pendingShares.toFixed(4));

      if (mStats.minerEffort !== null && mStats.minerEffort !== undefined) {
        setEl('mm-effort', fmt.effort(mStats.minerEffort));
        patchEffortBarFill('mm-effort-fill', Number(mStats.minerEffort));
      }

      const latest = mPerf?.length ? mPerf[mPerf.length - 1] : null;
      const wtbody = $('mm-workers-tbody');
      if (wtbody && latest?.workers) {
        wtbody.innerHTML = '';
        Object.entries(latest.workers).forEach(([wname, wdata]) => {
          const row = mk('tr');
          row.appendChild(txt('td', 'mono', safe(wname)));
          row.appendChild(txt('td', 'mono', fmt.hash(wdata?.hashrate ?? 0)));
          row.appendChild(txt('td', 'mono', wdata?.sharesPerSecond?.toFixed(3) ?? '--'));
          wtbody.appendChild(row);
        });
      }
    } catch { /* keep stale */ }
  };

  const renderMyMiner = async () => {
    const wrap = $('pane-myminer');
    if (!wrap) return;
    if (!S.poolId) { showNoPool(wrap); return; }
    const saved = localStorage.getItem(LS_MINER + S.poolId);
    if (saved) await renderMinerDashboard(wrap, saved);
    else       renderMinerLogin(wrap);
  };

  const renderMinerLogin = wrap => {
    wrap.innerHTML = '';
    const login = mk('div', 'mp-login-wrap');
    const iconDiv = mk('div', 'mp-login-icon');
    iconDiv.appendChild(mk('i', 'fa-solid fa-circle-user'));
    login.appendChild(iconDiv);
    login.appendChild(txt('div', 'mp-login-title', t('myminer.title')));
    login.appendChild(txt('div', 'mp-login-sub',   t('myminer.subtitle')));
    const row = mk('div', 'mp-login-row');
    const inp = mk('input', 'mp-addr-input');
    inp.type = 'text';
    inp.id = 'mm-addr-input';
    inp.placeholder = t('myminer.placeholder');
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    const btn = txt('button', 'mp-open-btn', t('myminer.open'));
    btn.type = 'button';
    const open = async () => {
      const addr = safe(inp.value);
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
    const seq = ++S.minerSeq;
    const pid = S.poolId;
    wrap.innerHTML = '';
    showLoading(wrap);
    try {
      const [mStats, mPerf] = await Promise.all([
        api.miner(pid, addr).catch(() => null),
        api.minerPerf(pid, addr).catch(() => null),
      ]);
      if (seq !== S.minerSeq) return;
      if (!mStats) {
        wrap.innerHTML = '';
        const err = mk('div', 'mp-error');
        err.append(mk('i', 'fa-solid fa-circle-exclamation'), document.createTextNode(t('myminer.not-found')));
        wrap.appendChild(err);
        appendForgetBtn(wrap);
        return;
      }

      wrap.innerHTML = '';
      const hdr    = mk('div', 'mp-miner-header');
      const addrEl = mk('div', 'mp-miner-addr');
      addrEl.textContent = fmt.addr(addr, 20);
      addrEl.title = safe(addr);
      hdr.append(addrEl, makeForgetBtn(wrap));
      wrap.appendChild(hdr);

      const sym = S.pool?.pool?.coin?.symbol || '';
      const pp  = S.pool?.pool?.paymentProcessing || {};
      const grid = mk('div', 'mp-2col-grid');

      const balCard = buildCard('myminer.title', 'fa-wallet', [
        ['myminer.balance',      mStats.pendingBalance !== null && mStats.pendingBalance !== undefined ? fmt.coin(mStats.pendingBalance, sym) : null, 'accent', 'mm-balance'],
        ['myminer.paid',         mStats.totalPaid !== null && mStats.totalPaid !== undefined ? fmt.coin(mStats.totalPaid, sym) : null,   null, 'mm-total-paid'],
        ['myminer.today',        mStats.todayPaid !== null && mStats.todayPaid !== undefined ? fmt.coin(mStats.todayPaid, sym) : null,   null, 'mm-today-paid'],
        ['myminer.last-payment', mStats.lastPayment ? fmt.time(mStats.lastPayment) : null,            null, 'mm-last-pay'],
        ['myminer.blocks-found', mStats.totalConfirmedBlocks !== null && mStats.totalConfirmedBlocks !== undefined
          ? `${mStats.totalConfirmedBlocks} confirmed / ${mStats.totalPendingBlocks ?? 0} pending` : null, null, 'mm-blocks-found'],
      ]);

      if (mStats.lastPayment && pp.paymentIntervalSeconds) {
        appendPaymentCountdown(balCard, mStats.lastPayment, pp.paymentIntervalSeconds, 'mm-next-pay', 'mmPayTick');
      }

      const liveHr      = wsMinerHr(addr);
      const perfWorkers = Object.values(mStats.performance?.workers ?? {});
      const totalHr     = liveHr !== null ? liveHr : perfWorkers.reduce((a, w) => a + (w.hashrate ?? 0), 0);
      const totalSps    = perfWorkers.reduce((a, w) => a + (w.sharesPerSecond ?? 0), 0);

      const hrCard = buildCard('card.pool', 'fa-gauge-high', [
        ['pool.hashrate',          fmt.hash(totalHr),                                                       'accent', 'mm-live-hr'],
        ['pool.shares',            totalSps.toFixed(3),                                                      null,    'mm-shares'],
        ['pool.workers.online',    mStats.workersOnline  !== null && mStats.workersOnline  !== undefined ? mStats.workersOnline  : null, 'ok', 'mm-workers-online'],
        ['pool.workers.offline',   mStats.workersOffline !== null && mStats.workersOffline !== undefined ? mStats.workersOffline : null,
          (mStats.workersOffline || 0) > 0 ? 'warn' : '', 'mm-workers-offline'],
        ['myminer.pending-shares', mStats.pendingShares !== null && mStats.pendingShares !== undefined ? mStats.pendingShares.toFixed(4) : null, null, 'mm-pending-shares'],
      ]);

      if (mStats.minerEffort !== null && mStats.minerEffort !== undefined) {
        const effortRow = mk('div', 'mp-metric');
        effortRow.append(
          txt('span', 'mp-metric-lbl', t('myminer.effort')),
          buildEffortBar(mStats.minerEffort, 'mm-effort')
        );
        const rows = hrCard.querySelectorAll('.mp-metric');
        const lastRow = rows[rows.length - 1];
        if (lastRow) hrCard.insertBefore(effortRow, lastRow);
        else hrCard.appendChild(effortRow);
      }

      grid.append(balCard, hrCard);
      wrap.appendChild(grid);

      const latest = mPerf?.length ? mPerf[mPerf.length - 1] : null;
      if (latest?.workers && Object.keys(latest.workers).length) {
        wrap.appendChild(txt('div', 'mp-section', t('myminer.workers')));
        const wBox   = mk('div', 'mp-table-box');
        const wTable = mk('table', 'mp-table');
        const wthead = mk('thead');
        const whrow  = mk('tr');
        ['myminer.worker','myminer.hashrate','myminer.shares'].forEach(k => {
          whrow.appendChild(txt('th', '', t(k)));
        });
        wthead.appendChild(whrow);
        wTable.appendChild(wthead);
        const wtbody = mk('tbody');
        wtbody.id = 'mm-workers-tbody';
        Object.entries(latest.workers).forEach(([wname, wdata]) => {
          const row = mk('tr');
          row.appendChild(txt('td', 'mono', safe(wname)));
          row.appendChild(txt('td', 'mono', fmt.hash(wdata?.hashrate ?? 0)));
          row.appendChild(txt('td', 'mono', wdata?.sharesPerSecond?.toFixed(3) ?? '--'));
          wtbody.appendChild(row);
        });
        wTable.appendChild(wtbody);
        wBox.appendChild(wTable);
        wrap.appendChild(wBox);
      }

      await renderMinerBlocks(wrap, addr, 0);
      await renderMinerPayments(wrap, addr, 0);
    } catch { wrap.innerHTML = ''; showError(wrap); }
  };

  const renderMinerBlocks = async (wrap, addr, page, container) => {
    const pid     = S.poolId;
    const section = container ?? mk('div', 'mp-miner-section');
    if (!container) {
      section.appendChild(txt('div', 'mp-section', t('myminer.blocks')));
      wrap.appendChild(section);
    }
    const existing = section.querySelector('.mp-table-box, .mp-empty');
    if (existing && page > 0) section.style.minHeight = `${section.offsetHeight}px`;
    if (existing) existing.remove();

    try {
      const blocks  = await api.minerBlocks(pid, addr, page, PAGE_SIZE + 1);
      if (S.poolId !== pid) return;
      const sym     = S.pool?.pool?.coin?.symbol || '';
      const hasNext = (blocks?.length || 0) > PAGE_SIZE;
      const shown   = hasNext ? blocks.slice(0, PAGE_SIZE) : (blocks || []);
      if (!shown.length) {
        section.style.minHeight = '';
        section.appendChild(txt('div', 'mp-empty', t('blocks.empty')));
        return;
      }
      const box   = mk('div', 'mp-table-box');
      const table = mk('table', 'mp-table');
      const thead = mk('thead');
      const hrow  = mk('tr');
      ['blocks.height','blocks.time','blocks.reward','blocks.effort','blocks.status'].forEach(k => {
        hrow.appendChild(txt('th', '', t(k)));
      });
      thead.appendChild(hrow);
      table.appendChild(thead);
      const tbody = mk('tbody');
      shown.forEach(b => tbody.appendChild(buildBlockRow(b, sym, false)));
      table.appendChild(tbody);
      box.appendChild(table);
      box.appendChild(buildPager(page, hasNext ? PAGE_SIZE : shown.length, pg => renderMinerBlocks(wrap, addr, pg, section)));
      section.appendChild(box);
      section.style.minHeight = '';
    } catch (err) { section.style.minHeight = ''; console.error('renderMinerBlocks', err); }
  };

  const renderMinerPayments = async (wrap, addr, page, container) => {
    const pid     = S.poolId;
    const section = container ?? mk('div', 'mp-miner-section');
    if (!container) {
      section.appendChild(txt('div', 'mp-section', t('myminer.payments')));
      wrap.appendChild(section);
    }
    const existing = section.querySelector('.mp-table-box, .mp-empty');
    if (existing && page > 0) section.style.minHeight = `${section.offsetHeight}px`;
    if (existing) existing.remove();

    try {
      const payments  = await api.minerPayments(pid, addr, page, PAGE_SIZE + 1);
      if (S.poolId !== pid) return;
      const sym       = S.pool?.pool?.coin?.symbol || '';
      const hasNext   = (payments?.length || 0) > PAGE_SIZE;
      const shown     = hasNext ? payments.slice(0, PAGE_SIZE) : (payments || []);
      if (!shown.length) {
        section.style.minHeight = '';
        section.appendChild(txt('div', 'mp-empty', t('myminer.no-payments')));
        return;
      }
      const box   = mk('div', 'mp-table-box');
      const table = mk('table', 'mp-table');
      const thead = mk('thead');
      const hrow  = mk('tr');
      ['myminer.pay-time','myminer.pay-amount','myminer.pay-tx'].forEach(k => {
        hrow.appendChild(txt('th', '', t(k)));
      });
      thead.appendChild(hrow);
      table.appendChild(thead);
      const tbody = mk('tbody');
      shown.forEach(pay => {
        const row    = mk('tr');
        const timeTd = mk('td', 'mono');
        timeTd.textContent = fmt.time(pay.created);
        timeTd.title = fmt.absTime(pay.created);
        if (pay.created) timeTd.dataset.rtime = pay.created;
        row.appendChild(timeTd);
        row.appendChild(txt('td', 'mono', fmt.coin(pay.amount, sym)));
        const txTd = mk('td', 'mono');
        if (pay.transactionInfoLink && pay.transactionConfirmationData) {
          const a = mk('a');
          a.href = safeUrl(pay.transactionInfoLink);
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = fmt.addr(pay.transactionConfirmationData, 10);
          txTd.appendChild(a);
        } else {
          txTd.textContent = pay.transactionConfirmationData ? fmt.addr(pay.transactionConfirmationData, 10) : '--';
        }
        row.appendChild(txTd);
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      box.appendChild(table);
      box.appendChild(buildPager(page, hasNext ? PAGE_SIZE : shown.length, pg => renderMinerPayments(wrap, addr, pg, section)));
      section.appendChild(box);
      section.style.minHeight = '';
    } catch (err) { section.style.minHeight = ''; console.error('renderMinerPayments', err); }
  };

  const makeForgetBtn = wrap => {
    const fb = txt('button', 'mp-forget-btn', t('myminer.forget'));
    fb.addEventListener('click', () => {
      localStorage.removeItem(LS_MINER + S.poolId);
      renderMinerLogin(wrap);
    });
    return fb;
  };

  const appendForgetBtn = wrap => {
    const div = mk('div', 'mp-forget-wrap');
    div.appendChild(makeForgetBtn(wrap));
    wrap.appendChild(div);
  };

  // -- Shared UI components --

  const appendMetricRow = (card, label, value, cls, id) => {
    const row = mk('div', 'mp-metric');
    const l   = txt('span', 'mp-metric-lbl', label);
    const v   = txt('span', `mp-metric-val${cls ? ` ${cls}` : ''}`, value);
    if (id) v.id = id;
    row.append(l, v);
    card.appendChild(row);
  };

  const buildCard = (titleKey, icon, rows) => {
    const card = mk('div', 'mp-card');
    const head = mk('div', 'mp-card-head');
    const title = mk('div', 'mp-card-title');
    title.appendChild(mk('i', `fa-solid ${icon}`));
    title.appendChild(document.createTextNode(t(titleKey)));
    head.appendChild(title);
    card.appendChild(head);
    rows.forEach(([key, val, cls, id]) => {
      if (val === null || val === undefined) return;
      appendMetricRow(card, t(key), safe(val), cls, id);
    });
    return card;
  };

  const buildEffortBar = (eff, id) => {
    const n    = Number(eff);
    const cls  = fmt.effortClass(n);
    const pct  = isFinite(n) ? `${(n * 100).toFixed(1)}%` : '--';
    const wrap = mk('div', `mp-effort-bar ${cls}`);
    const fill = mk('div', `mp-effort-bar-fill ${cls}`);
    fill.style.width = isFinite(n) ? `${Math.min(n * 100, 100)}%` : '0%';
    if (n > 1) fill.classList.add('overrun');
    if (id) fill.id = `${id}-fill`;
    const lbl = txt('span', 'mp-effort-bar-lbl', pct);
    if (id) lbl.id = id;
    wrap.append(fill, lbl);
    return wrap;
  };

  const patchEffortBarFill = (fillId, eff) => {
    const fill = $(fillId);
    if (!fill) return;
    fill.style.width = `${Math.min(eff * 100, 100)}%`;
    fill.classList.toggle('overrun', eff > 1);
    ['ok','warn','high'].forEach(c => fill.classList.remove(c));
    fill.classList.add(fmt.effortClass(eff));
  };

  const buildInlineBar = (progress, labelId, labelText) => {
    const bar  = mk('div', 'mp-inline-bar');
    const fill = mk('div', 'mp-inline-bar-fill');
    fill.style.width = `${Math.min(progress * 100, 100)}%`;
    if (labelId) fill.id = `${labelId}-fill`;
    const lbl = txt('span', 'mp-inline-bar-lbl', labelText);
    if (labelId) lbl.id = labelId;
    bar.append(fill, lbl);
    return bar;
  };

  const appendPaymentCountdown = (card, lastPaymentTime, intervalSeconds, labelId, tickKey) => {
    const intMs = intervalSeconds * 1000;

    const existing = $(labelId);
    if (existing) {
      // Row already in DOM -- just update the timer reference, never touch the DOM
      if (existing.dataset.lastPay !== String(lastPaymentTime)) {
        existing.dataset.lastPay = String(lastPaymentTime);
        const ref = S[tickKey + 'Ref'];
        if (ref) {
          ref.lastMs = new Date(lastPaymentTime).getTime();
          ref.nextMs = ref.lastMs + intMs;
        }
      }
      return;
    }

    // First mount -- build row once, never move it again
    const ref = { lastMs: new Date(lastPaymentTime).getTime(), nextMs: 0 };
    ref.nextMs = ref.lastMs + intMs;
    S[tickKey + 'Ref'] = ref;

    const secsLeft = Math.max(0, Math.round((ref.nextMs - Date.now()) / 1000));
    const progress = Math.min(1, (Date.now() - ref.lastMs) / intMs);
    const labelTxt = secsLeft > 0 ? fmt.interval(secsLeft) : t('misc.just-now');

    const row = mk('div', 'mp-metric');
    const bar = buildInlineBar(progress, labelId, labelTxt);
    row.append(txt('span', 'mp-metric-lbl', t('myminer.next-payment')), bar);
    card.appendChild(row);

    const el = $(labelId);
    if (el) el.dataset.lastPay = String(lastPaymentTime);

    if (S[tickKey]) { clearInterval(S[tickKey]); S[tickKey] = null; }
    const id = setInterval(() => {
      const el   = $(labelId);
      const fill = $(`${labelId}-fill`);
      if (!el) { clearInterval(id); if (S[tickKey] === id) S[tickKey] = null; return; }
      const left    = Math.max(0, Math.round((ref.nextMs - Date.now()) / 1000));
      const elapsed = Math.min(1, (Date.now() - ref.lastMs) / intMs);
      if (left > 0) {
        if (fill) fill.style.width = `${elapsed * 100}%`;
        el.textContent = fmt.interval(left);
      } else {
        if (fill) fill.style.width = '0%';
        el.textContent = t('misc.just-now');
      }
    }, 1000);
    S[tickKey] = id;
  };

  const buildPager = (page, count, onPage) => {
    const pg   = mk('div', 'mp-pager');
    const info = txt('span', 'mp-pager-info', `${t('page.current')} ${page + 1}`);
    const btns = mk('div', 'mp-pager-btns');
    const prev = txt('button', 'mp-pager-btn', t('page.prev'));
    const next = txt('button', 'mp-pager-btn', t('page.next'));
    prev.type = 'button';
    next.type = 'button';
    prev.disabled = page === 0;
    next.disabled = count < PAGE_SIZE;

    let navigating = false;
    const navigate = targetPage => {
      if (navigating) return;
      navigating = true;
      prev.disabled = true;
      next.disabled = true;
      const savedY = window.scrollY;
      Promise.resolve(onPage(targetPage)).finally(() => {
        requestAnimationFrame(() => window.scrollTo({ top: savedY, behavior: 'instant' }));
      });
    };

    prev.addEventListener('click', () => navigate(page - 1));
    next.addEventListener('click', () => navigate(page + 1));
    btns.append(prev, next);
    pg.append(info, btns);
    return pg;
  };

  const showLoading = wrap => {
    const div = mk('div', 'mp-loading');
    div.append(mk('div', 'mp-spinner'), document.createTextNode(t('loading')));
    wrap.appendChild(div);
  };

  const showNoPool = wrap => {
    if (!wrap) return;
    wrap.innerHTML = '';
    const e = mk('div', 'mp-empty');
    e.append(mk('i', 'fa-solid fa-circle-info'), document.createTextNode(t('error.no-pool')));
    wrap.appendChild(e);
  };

  const showError = wrap => {
    if (!wrap) return;
    const e = mk('div', 'mp-error');
    e.append(mk('i', 'fa-solid fa-circle-exclamation'), document.createTextNode(t('error.fetch')));
    wrap.appendChild(e);
  };

  // -- Init --

  const init = () => {
    applyTheme();
    applyTkeys();

    const langSel = $('lang-select');
    if (langSel && window.mpLang) {
      Object.keys(window.mpLang).forEach(code => {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = window.mpLang[code]?.['lang.name'] || code.toUpperCase();
        if (code === S.lang) opt.selected = true;
        langSel.appendChild(opt);
      });
      langSel.addEventListener('change', () => {
        S.lang = langSel.value;
        localStorage.setItem(LS_LANG, S.lang);
        applyTkeys();
        applyTheme();
        renderActiveTab();
      });
    }

    document.querySelectorAll('.mp-theme-menu .dropdown-item').forEach(btn => {
      btn.addEventListener('click', () => {
        S.theme = btn.dataset.theme;
        localStorage.setItem(LS_THEME, S.theme);
        applyTheme();
      });
    });

    const baseInp = $('base-url');
    if (baseInp) baseInp.value = S.base;
    $('apply-url')?.addEventListener('click', () => {
      const val = safe(baseInp?.value);
      if (!val) return;
      try { new URL(val); } catch { return; }
      S.base = val;
      localStorage.setItem(LS_BASE, val);
      S.wsRetry = 0;
      wsDisconnect();
      wsConnect();
      loadPools();
    });

    document.querySelectorAll('.mp-tab').forEach(btn => {
      btn.addEventListener('shown.bs.tab', () => {
        S.activeTab = (btn.getAttribute('data-bs-target') || '').replace('#pane-', '');
        renderActiveTab();
      });
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (S.theme === 'auto') applyTheme();
    });

    wsConnect();
    loadPools();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
