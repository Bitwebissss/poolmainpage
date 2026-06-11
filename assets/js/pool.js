(function () {
  'use strict';

  const LS_THEME = 'mp-theme';
  const LS_LANG  = 'mp-lang';
  const LS_BASE  = 'mp-base';
  const LS_POOL  = 'mp-pool';
  const LS_MINER = 'mp-miner-';

  const PAGE_SIZE        = 20;
  const MINER_BLOCKS_PAGE = 10;
  const POLL_MS    = 90_000;
  const CHART_REFRESH_CYCLES = 5;
  // Bitcoin-style PoW: expected hashes for difficulty 1 is 2^32.
  const DIFF_MULTIPLIER = 2 ** 32;

  const CPU_ARCHS = [
    'avx512-sha-vaes','avx512','avx2-sha-vaes','avx2-sha','avx2','avx','aes-sse42','sse2',
  ];

  const S = {
    base:           localStorage.getItem(LS_BASE) || 'https://pooltest.bitwebcore.net',
    poolId:         null,
    pool:           null,
    pollTimer:      null,
    relTimerHandle: null,
    bPage:          0,
    ws:             null,
    wsRetry:        0,
    lang:           localStorage.getItem(LS_LANG) || 'en',
    theme:          localStorage.getItem(LS_THEME) || 'auto',
    _switching:     false,
    _pendingPoolId: null,
    activeTab:      'overview',
    minerSeq:       0,
    poolSelectBound: false,
    ovCountdown:    null,
    mmCountdown:    null,
    ovEffort:       null,
    mmEffort:       null,
    chartAge:       0,
    serverDown:     false,
    blocks:            [],
    blocksLoaded:      false,
    blocksPoolId:      null,
    patchMinerBlocks:  null,
    patchMinerPayments: null,
  };

  let wsRetryTimer = null;
  let wsRetryToken = 0;

  const t = k => window.mpLang?.[S.lang]?.[k] ?? window.mpLang?.en?.[k] ?? k;

  const applyTkeys = () => {
    document.querySelectorAll('[data-tkey]').forEach(el => {
      const v = t(el.dataset.tkey);
      if (el.tagName === 'INPUT') el.placeholder = v;
      else el.textContent = v;
    });
  };

  const $   = id => document.getElementById(id);
  const mk  = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const txt = (tag, cls, text) => { const e = mk(tag, cls); e.textContent = String(text ?? ''); return e; };
  const safe    = v => String(v ?? '').trim();
  const safeUrl = (v) => {
    const s = String(v ?? '').trim();
    try {
      const url = new URL(s);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return url.href;
    } catch {
      return '';
    }
  };

  const setEl = (id, val) => {
    const e = $(id);
    if (e && val != null) e.textContent = safe(val);
  };

  const fmt = {
    hash(h) {
      h = Number(h);
      if (!isFinite(h) || h <= 0) return '0 H/s';
      const u = ['H','KH','MH','GH','TH','PH'];
      const i = Math.min(Math.max(0, Math.floor(Math.log10(h) / 3)), u.length - 1);
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
      const s = Math.round((diff * DIFF_MULTIPLIER) / hr);
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

  const enc = v => encodeURIComponent(safe(v));

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
    pools:         ()              => api._get('/api/pools-list'),
    pool:          id              => api._get(`/api/pools/${enc(id)}`),
    blocks:        (id, p, s)      => api._get(`/api/pools/${enc(id)}/blocks?page=${p}&pageSize=${s}`),
    perf:          id              => api._get(`/api/pools/${enc(id)}/performance`),
    miner:         (id, a)         => api._get(`/api/pools/${enc(id)}/miners/${enc(a)}`),
    minerBlocks:   (id, a)         => api._get(`/api/pools/${enc(id)}/miners/${enc(a)}/blocks`),
    minerPayments: (id, a)         => api._get(`/api/pools/${enc(id)}/miners/${enc(a)}/payments`),
  };

  const wsConnect = () => {
    if (!S.base || !S.poolId) return;
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    const myToken = wsRetryToken;
    try {
      const url   = new URL(S.base);
      const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
      wsDisconnect();
      S.ws = new WebSocket(`${proto}//${url.host}/notifications?poolId=${encodeURIComponent(S.poolId)}`);
      S.ws.addEventListener('open', () => {
        S.wsRetry = 0;
        if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
        const dot = $('ws-dot');
        if (dot) dot.classList.add('connected');
      });
      S.ws.onclose = () => {
        const dot = $('ws-dot');
        if (dot) dot.classList.remove('connected');
        const attempt = S.wsRetry;
        const delay = Math.min(1000 * 2 ** attempt, 30_000);
        S.wsRetry = Math.min(S.wsRetry + 1, 30);
        wsRetryTimer = setTimeout(() => {
          if (myToken !== wsRetryToken) return;
          wsConnect();
        }, delay);
      };
      S.ws.addEventListener('error', err => console.error('ws error', err));
      S.ws.addEventListener('message', e => {
        try { wsHandle(JSON.parse(e.data)); } catch (err) { console.error('ws parse error', err); }
      });
    } catch (err) { console.error('ws connect error', err); }
  };

  const wsDisconnect = () => {
    wsRetryToken += 1;
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    if (S.ws) { S.ws.onclose = null; S.ws.close(); S.ws = null; }
    S.wsRetry = 0;
  };

  const wsHandle = msg => {
    const type = (msg.type || '').toLowerCase();
    const pid  = msg.poolId;

    if (type === 'chainheightstats' && pid === S.poolId) {
      if (S.pool?.pool) {
        const p = S.pool.pool;
        if (!p.networkStats) p.networkStats = {};
        p.networkStats.networkHashrate = msg.networkHashrate;
        if (msg.networkDifficulty    != null) p.networkStats.networkDifficulty    = msg.networkDifficulty;
        if (msg.blockHeight          != null) p.networkStats.blockHeight          = msg.blockHeight;
        if (msg.networkBlockHeight   != null) p.networkStats.networkBlockHeight   = msg.networkBlockHeight;
        if (msg.lastNetworkBlockTime != null) p.networkStats.lastNetworkBlockTime = msg.lastNetworkBlockTime;
        if (msg.totalConfirmedBlocks != null) p.totalConfirmedBlocks = msg.totalConfirmedBlocks;
        if (msg.totalPendingBlocks   != null) p.totalPendingBlocks   = msg.totalPendingBlocks;
        if (msg.totalOrphanedBlocks  != null) p.totalOrphanedBlocks  = msg.totalOrphanedBlocks;
        if (msg.blockReward          != null) p.blockReward          = msg.blockReward;
      }
      patchOverviewRest();
    }

    if (type === 'blockfoundstats' && pid === S.poolId) {
      if (S.pool?.pool) {
        const p = S.pool.pool;
        if (!p.networkStats) p.networkStats = {};
        p.networkStats.networkHashrate = msg.networkHashrate;
        if (msg.networkDifficulty    != null) p.networkStats.networkDifficulty    = msg.networkDifficulty;
        if (msg.blockHeight          != null) p.networkStats.blockHeight          = msg.blockHeight;
        if (msg.networkBlockHeight   != null) p.networkStats.networkBlockHeight   = msg.networkBlockHeight;
        if (msg.lastNetworkBlockTime != null) p.networkStats.lastNetworkBlockTime = msg.lastNetworkBlockTime;
        if (msg.lastPoolBlockTime)            p.lastPoolBlockTime                 = msg.lastPoolBlockTime;
        if (msg.blocks24h            != null) p.blocks24h                         = msg.blocks24h;
        if (msg.totalBlocks          != null) p.totalBlocks                       = msg.totalBlocks;
        if (msg.totalConfirmedBlocks != null) p.totalConfirmedBlocks              = msg.totalConfirmedBlocks;
        if (msg.totalPendingBlocks   != null) p.totalPendingBlocks                = msg.totalPendingBlocks;
        if (msg.totalOrphanedBlocks  != null) p.totalOrphanedBlocks               = msg.totalOrphanedBlocks;
        if (msg.blockReward          != null) p.blockReward                       = msg.blockReward;
      }
      patchOverviewRest();
      const sym  = S.pool?.pool?.coin?.symbol || '';
      const icon = sym ? `assets/images/${sym.toLowerCase()}.svg` : null;
      toastBlockFound(msg.blockHeight, sym, icon);
    }

    if (type === 'blockunlockprogress' && pid === S.poolId) {
      const changed = upsertBlockFromWs(msg);
      if (changed && S.activeTab === 'blocks') renderBlocks(S.bPage);
      // If this block belongs to the saved miner AND they're on the miner tab — update quietly
      const savedAddr = localStorage.getItem(LS_MINER + pid);
      if (savedAddr && msg.miner &&
          msg.miner.toLowerCase() === savedAddr.toLowerCase() &&
          S.patchMinerBlocks && S.activeTab === 'myminer') {
        S.patchMinerBlocks();
      }
    }

    if (type === 'cyclestats' && pid === S.poolId) {
      if (S.pool?.pool) {
        const p = S.pool.pool;
        if (!p.poolStats) p.poolStats = {};
        p.poolStats.poolHashrate    = msg.poolHashrate;
        p.poolStats.connectedMiners = msg.connectedMiners;
        p.poolStats.sharesPerSecond = msg.sharesPerSecond;
        if (msg.connectedPeers != null) {
          if (!p.networkStats) p.networkStats = {};
          p.networkStats.connectedPeers = msg.connectedPeers;
        }
        if (msg.poolEffort != null) p.poolEffort = msg.poolEffort;
      }
      patchOverviewRest();
    }

    if (type === 'payment' && pid === S.poolId) {
      const sym = S.pool?.pool?.coin?.symbol || '';
      toast(`${t('ws.payment')} ${fmt.coin(msg.amount, sym)}`, 'money-bill-transfer', 'ok');
      const now = new Date().toISOString();
      if (S.pool?.pool) {
        if (msg.totalPaid != null) S.pool.pool.totalPaid = msg.totalPaid;
        S.pool.pool.lastPaymentTime = now;
      }
      S.ovCountdown?.reset(now);
      S.mmCountdown?.reset(now);
      patchOverviewRest();
      if (S.activeTab === 'myminer') refreshMinerDashboard();
    }
  };

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

  const loadPools = async () => {
    if (!S.base) return;
    try {
      const data  = await api.pools();
      S.serverDown = false;
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
        if (saved) localStorage.removeItem(LS_POOL);
        sel.value = pools[0].id;
        await switchPool(pools[0].id);
      }
    } catch {
      S.serverDown = true;
      S.pool = null;
      renderActiveTab();
    }
  };

  const switchPool = async id => {
    if (S._switching) { S._pendingPoolId = id; return; }
    S._switching = true;
    clearTimers();
    S.poolId = id;
    localStorage.setItem(LS_POOL, id);
    try {
      S.pool  = await api.pool(id);
      S.serverDown = false;
      S.bPage  = 0;
      S.blocks = [];
      S.blocksLoaded = false;
      S.blocksPoolId = null;
      updateBrandIcon();
      renderActiveTab();
      startPollTimer();
      S.wsRetry = 0;
      wsDisconnect();
      wsConnect();
    } catch {
      S.serverDown = true;
      S.pool = null;
      renderActiveTab();
    }
    finally {
      S._switching = false;
      const nextId = S._pendingPoolId;
      S._pendingPoolId = null;
      if (nextId && nextId !== S.poolId) switchPool(nextId);
    }
  };

  const clearTimers = () => {
    clearInterval(S.pollTimer);
    clearInterval(S.relTimerHandle);
    S.pollTimer = null;
    S.relTimerHandle = null;
    S.ovCountdown?.destroy(); S.ovCountdown = null;
    S.mmCountdown?.destroy(); S.mmCountdown = null;
    S.ovEffort = null;
    S.mmEffort = null;
    S.patchMinerBlocks  = null;
    S.patchMinerPayments = null;
  };

  const startPollTimer = () => {
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
          if (chartWrap) { chartWrap.innerHTML = ''; await loadChart(chartWrap, pid); }
        }
        if (S.activeTab === 'myminer') await refreshMinerDashboard();
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
        case 'overview':  renderOverview();  break;
        case 'blocks':    renderBlocks(S.bPage); break;
        case 'start':     renderStart();    break;
        case 'myminer':   renderMyMiner();  break;
        case 'settings':  renderSettings(); break;
      }
    }, 50);
  };

  const renderOverview = async () => {
    const wrap = $('pane-overview');
    if (!wrap) return;
    if (!S.pool) { S.serverDown ? showServerDown(wrap) : showNoPool(wrap); return; }
    const pid = S.poolId;
    wrap.innerHTML = '';

    const p    = S.pool.pool;
    const ns   = p.networkStats      || {};
    const ps   = p.poolStats         || {};
    const pp   = p.paymentProcessing || {};
    const coin = p.coin              || {};
    const sym  = safe(coin.symbol);
    const liveHr     = ps.poolHashrate ?? 0;
    const liveHeight = ns.networkBlockHeight ?? ns.blockHeight ?? 0;

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
      ['net.peers',      ns.connectedPeers != null
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
      const validatedUrl = safeUrl(url);
      if (!validatedUrl) return;
      const row = mk('div', 'mp-social-link-row');
      const ico = mk('i', iconCls);
      const a   = mk('a', 'mp-social-link-a');
      a.href = validatedUrl;
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
      ['pool.miners',         ps.connectedMiners != null ? String(ps.connectedMiners) : null, null, 'ov-pool-miners'],
      ['pool.shares',         ps.sharesPerSecond != null ? ps.sharesPerSecond.toFixed(3) : null, null, 'ov-pool-shares'],
      ['pool.fee',            p.poolFeePercent   != null ? `${p.poolFeePercent}%` : null,    null, null],
      ['pool.scheme',         pp.payoutScheme || null,                                         null, null],
      ['pool.min-payout',     pp.minimumPayment  != null ? `${fmt.num(pp.minimumPayment, 8)} ${sym}`.trim() : null, null, null],
      ['pool.interval',       pp.paymentIntervalSeconds ? fmt.interval(pp.paymentIntervalSeconds) : null, null, null],
      ['pool.total-paid',     p.totalPaid        != null ? fmt.coin(p.totalPaid, sym) : null, null, 'ov-pool-total-paid'],
    ];
    rows.forEach(([key, val, cls, id]) => {
      if (val === null || val === undefined) return;
      appendMetricRow(card, t(key), safe(val), cls, id);
    });

    if (p.lastPaymentTime && pp.paymentIntervalSeconds) {
      S.ovCountdown?.destroy();
      S.ovCountdown = CountdownTick.build(card, p.lastPaymentTime, pp.paymentIntervalSeconds);
    }

    const portEntries = Object.entries(p.ports || {});
    if (portEntries.length) {
      const [, cfg] = portEntries[0];
      [
        ['start.start-diff',  cfg.difficulty          != null ? String(cfg.difficulty) : null],
        ['start.var-min',     cfg.varDiff?.minDiff    != null ? String(cfg.varDiff.minDiff) : null],
        ['start.var-max',     cfg.varDiff?.maxDiff    != null ? String(cfg.varDiff.maxDiff) : null],
        ['start.target-time', cfg.varDiff?.targetTime ? `${cfg.varDiff.targetTime}s` : null],
        ['start.tls',         t(cfg.tls ? 'misc.yes' : 'misc.no')],
        ['start.tls-auto',    cfg.tlsAuto === true ? t('misc.yes') : null],
      ].forEach(([key, val]) => {
        if (val === null || val === undefined) return;
        appendMetricRow(card, t(key), val, null, null);
      });
    }

    return card;
  };

  const buildRoundCard = (p, ns, liveHr, sym) => {
    const isSolo = (p.paymentProcessing?.payoutScheme || '').toUpperCase() === 'SOLO';
    // poolEffort is always the sum of all miners' work since the last found block.
    // For SOLO this is still a real number — but it represents combined pool effort,
    // not a "round" in the PPLNS sense. We show it with a different label so miners
    // understand it's not their personal effort (that lives in the My Miner tab).
    // If the value is null (pool has never found a block yet), hide the bar entirely.
    const hasEffort = p.poolEffort != null;
    const eff = hasEffort ? Number(p.poolEffort) : 0;
    const card = mk('div', 'mp-card');
    const head = mk('div', 'mp-card-head');
    const htitle = mk('div', 'mp-card-title');
    htitle.appendChild(mk('i', 'fa-solid fa-circle-notch'));
    htitle.appendChild(document.createTextNode(t(isSolo ? 'card.solo' : 'card.round')));
    head.appendChild(htitle);
    card.appendChild(head);

    if (hasEffort) {
      const effortLblKey = isSolo ? 'round.effort-pool' : 'round.effort';
      const effortRow = mk('div', 'mp-metric');
      S.ovEffort = EffortBar.build(eff);
      effortRow.append(txt('span', 'mp-metric-lbl', t(effortLblKey)), S.ovEffort.el);
      if (isSolo) {
        // Tooltip: clarify this is combined pool effort, not per-miner
        effortRow.title = t('round.effort-pool-tip');
      }
      card.appendChild(effortRow);
    } else {
      S.ovEffort = null;
    }

    [
      ['round.work-height', String(ns.blockHeight ?? 0),                                          null, 'ov-round-work-height'],
      ['round.ttf',        fmt.ttf(ns.networkDifficulty, liveHr),                              null, 'ov-round-ttf'],
      ['round.last-block', fmt.time(p.lastPoolBlockTime),                                       null, 'ov-round-last-blk'],
      ['round.reward',     p.blockReward          != null ? fmt.coin(p.blockReward, sym) : null, null, 'ov-round-reward'],
      ['round.blocks-24h', p.blocks24h            != null ? String(p.blocks24h) : null,           null, 'ov-round-24h'],
      ['round.total',      p.totalBlocks          != null ? String(p.totalBlocks) : null,          null, 'ov-round-total'],
      ['round.confirmed',  p.totalConfirmedBlocks != null ? String(p.totalConfirmedBlocks) : null, null, 'ov-round-confirmed'],
      ['round.pending',    p.totalPendingBlocks   != null ? String(p.totalPendingBlocks) : null,   null, 'ov-round-pending'],
      ['round.orphaned',   p.totalOrphanedBlocks  != null ? String(p.totalOrphanedBlocks) : null,  null, 'ov-round-orphaned'],
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
    const sym = safe(p.coin?.symbol || '');
    const liveHr = ps.poolHashrate ?? 0;

    setEl('ov-net-height', ns.networkBlockHeight ?? ns.blockHeight);
    setEl('ov-net-hr',       fmt.hash(ns.networkHashrate));
    setEl('ov-net-diff',     fmt.diff(ns.networkDifficulty));
    setEl('ov-net-last-blk', fmt.time(ns.lastNetworkBlockTime));
    if (ns.nodeVersion)                      setEl('ov-net-ver',   ns.nodeVersion);
    if (ns.connectedPeers != null) setEl('ov-net-peers', String(ns.connectedPeers));

    setEl('ov-pool-hr', fmt.hash(ps.poolHashrate));
    if (ps.connectedMiners != null) setEl('ov-pool-miners',    String(ps.connectedMiners));
    if (ps.sharesPerSecond != null) setEl('ov-pool-shares',    ps.sharesPerSecond.toFixed(3));
    if (p.totalPaid        != null) setEl('ov-pool-total-paid', fmt.coin(p.totalPaid, sym));

    if (p.poolEffort != null) {
      S.ovEffort?.update(Number(p.poolEffort));
    }

    setEl('ov-round-ttf',      fmt.ttf(ns.networkDifficulty, liveHr));
    setEl('ov-round-last-blk', fmt.time(p.lastPoolBlockTime));
    if (ns.blockHeight             != null) setEl('ov-round-work-height', String(ns.blockHeight));
    if (p.blockReward          != null) setEl('ov-round-reward',    fmt.coin(p.blockReward, sym));
    if (p.blocks24h            != null) setEl('ov-round-24h',       String(p.blocks24h));
    if (p.totalBlocks          != null) setEl('ov-round-total',     String(p.totalBlocks));
    if (p.totalConfirmedBlocks != null) setEl('ov-round-confirmed', String(p.totalConfirmedBlocks));
    if (p.totalPendingBlocks   != null) setEl('ov-round-pending',   String(p.totalPendingBlocks));
    if (p.totalOrphanedBlocks  != null) setEl('ov-round-orphaned',  String(p.totalOrphanedBlocks));

    setEl('mp-chart-current', fmt.hash(liveHr));

    if (p.totalBlocks          != null) setEl('blk-sum-total',     String(p.totalBlocks));
    if (p.totalConfirmedBlocks != null) setEl('blk-sum-confirmed', String(p.totalConfirmedBlocks));
    if (p.totalPendingBlocks   != null) setEl('blk-sum-pending',   String(p.totalPendingBlocks));
    if (p.totalOrphanedBlocks  != null) setEl('blk-sum-orphaned',  String(p.totalOrphanedBlocks));
  };

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
    if (!pts || pts.length < 2) return null;
    const W = 600, H = 90, pad = 4;
    const vals = pts.map(p => Number(p.poolHashrate));
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const rng = mx - mn || 1;
    const xs  = pts.map((_, i) => pad + (i / Math.max(pts.length - 1, 1)) * (W - pad * 2));
    const ys  = vals.map(v => pad + (H - pad * 2) - ((v - mn) / rng) * (H - pad * 2));
    const coords = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`);
    const strokePath = `M${coords[0]}L${coords.slice(1).join('L')}`;
    const areaPath = `${strokePath}L${xs[xs.length - 1].toFixed(1)},${H}L${xs[0].toFixed(1)},${H}Z`;
    const gradId = `mpGrd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    const container = mk('div', 'mp-chart-container');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const linearGradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    linearGradient.setAttribute('id', gradId);
    linearGradient.setAttribute('x1', '0');
    linearGradient.setAttribute('y1', '0');
    linearGradient.setAttribute('x2', '0');
    linearGradient.setAttribute('y2', '1');
    const stopStart = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stopStart.setAttribute('offset', '0%');
    stopStart.setAttribute('stop-color', 'var(--tab-active)');
    stopStart.setAttribute('stop-opacity', '0.25');
    const stopEnd = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stopEnd.setAttribute('offset', '100%');
    stopEnd.setAttribute('stop-color', 'var(--tab-active)');
    stopEnd.setAttribute('stop-opacity', '0.02');
    linearGradient.append(stopStart, stopEnd);
    defs.appendChild(linearGradient);

    const areaPathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    areaPathEl.setAttribute('d', areaPath);
    areaPathEl.setAttribute('fill', `url(#${gradId})`);

    const linePathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    linePathEl.setAttribute('d', strokePath);
    linePathEl.setAttribute('fill', 'none');
    linePathEl.setAttribute('stroke', 'var(--tab-active)');
    linePathEl.setAttribute('stroke-width', '2');
    linePathEl.setAttribute('stroke-linecap', 'round');
    linePathEl.setAttribute('stroke-linejoin', 'round');

    svg.append(defs, areaPathEl, linePathEl);

    const hair = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    hair.setAttribute('stroke', 'var(--text-muted)');
    hair.setAttribute('stroke-width', '1');
    hair.setAttribute('stroke-dasharray', '3,3');
    hair.classList.add('mp-chart-hair', 'mp-chart-hair--hidden');
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
      hair.classList.remove('mp-chart-hair--hidden');
      tip.textContent = `${fmtHour(pt.created)} · ${fmt.hash(pt.poolHashrate)}`;
      tip.classList.remove('mp-chart-tip--hidden');
      tip.style.left = `${Math.min(relX * 100, 65)}%`;
    };

    const hideChart = () => {
      tip.classList.add('mp-chart-tip--hidden');
      hair.classList.add('mp-chart-hair--hidden');
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

  const buildBlockRow = (b, sym, showMiner = true) => {
    const row  = mk('tr');
    row.dataset.height = String(b.blockHeight);
    const htd  = mk('td', 'mono');
    const validatedUrl = safeUrl(b.infoLink);
    if (validatedUrl) {
      const a = mk('a');
      a.href = validatedUrl;
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

    row.appendChild(txt('td', 'mono', b.reward != null ? fmt.coin(b.reward, sym) : '--'));

    const effTd = mk('td', 'mp-effort-td');
    effTd.appendChild(EffortBar.build(b.effort).el);
    row.appendChild(effTd);

    if (showMiner) {
      const mTd = mk('td', 'addr');
      mTd.textContent = fmt.addr(b.miner, 12);
      applyCopyAddr(mTd, safe(b.miner));
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

  const BLOCKS_MAX  = 100;

  const hasBlocksCache = pid => S.blocksLoaded && S.blocksPoolId === pid;

  const setBlocksCache = (pid, blocks) => {
    S.blocks = Array.isArray(blocks) ? blocks : [];
    S.blocksLoaded = true;
    S.blocksPoolId = pid;
  };

  const upsertBlockFromWs = msg => {
    if (!hasBlocksCache(S.poolId)) return false;
    const height = Number(msg.blockHeight);
    if (!isFinite(height)) return false;

    const idx = S.blocks.findIndex(b => Number(b.blockHeight) === height);
    const block = idx !== -1 ? { ...S.blocks[idx] } : { blockHeight: msg.blockHeight };
    ['blockHeight', 'symbol', 'name', 'progress', 'effort', 'reward', 'miner', 'created', 'status', 'infoLink'].forEach(key => {
      if (msg[key] != null) block[key] = msg[key];
    });

    if (idx !== -1) S.blocks[idx] = block;
    else S.blocks.unshift(block);

    S.blocks.sort((a, b) => Number(b.blockHeight) - Number(a.blockHeight));
    if (S.blocks.length > BLOCKS_MAX) S.blocks.length = BLOCKS_MAX;
    return true;
  };

  const loadBlocksCache = async pid => {
    const raw = await api.blocks(pid, 0, BLOCKS_MAX);
    const blocks = Array.isArray(raw?.blocks) ? raw.blocks : (Array.isArray(raw) ? raw : []);
    setBlocksCache(pid, blocks);
  };

  const renderBlocks = async (page = 0) => {
    const wrap = $('pane-blocks');
    if (!wrap) return;
    if (!S.poolId) { S.serverDown ? showServerDown(wrap) : showNoPool(wrap); return; }
    const pid = S.poolId;

    const isInit = page === 0 && !wrap.querySelector('.mp-table-box');
    if (isInit) { wrap.innerHTML = ''; showLoading(wrap); }

    try {
      if (!hasBlocksCache(pid)) {
        await loadBlocksCache(pid);
        if (S.poolId !== pid) return;
      }

      if (S.poolId !== pid) return;
      const start      = page * PAGE_SIZE;
      const pageBlocks = S.blocks.slice(start, start + PAGE_SIZE);
      const hasNext    = start + PAGE_SIZE < S.blocks.length;
      S.bPage = page;

      if (isInit) wrap.innerHTML = '';

      const p = S.pool?.pool;
      let summaryBar = wrap.querySelector('.mp-summary-bar');
      if (!summaryBar && p) {
        summaryBar = mk('div', 'mp-summary-bar');
        [
          ['round.total',      p.totalBlocks,          'blk-sum-total'],
          ['blocks.confirmed', p.totalConfirmedBlocks,  'blk-sum-confirmed'],
          ['blocks.pending',   p.totalPendingBlocks,    'blk-sum-pending'],
          ['blocks.orphaned',  p.totalOrphanedBlocks,   'blk-sum-orphaned'],
        ].forEach(([key, val, id]) => {
          const pill   = mk('div', 'mp-summary-pill');
          const strong = txt('strong', '', safe(val ?? '--'));
          if (id) strong.id = id;
          const lblEl = txt('span', '', t(key));
          lblEl.dataset.tkey = key;
          pill.append(lblEl, strong);
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
      if (!pageBlocks.length) {
        const row = mk('tr');
        const td  = mk('td');
        td.colSpan = 6;
        td.className = 'mp-empty';
        td.textContent = t('blocks.empty');
        row.appendChild(td);
        tbody.appendChild(row);
      } else {
        pageBlocks.forEach(b => tbody.appendChild(buildBlockRow(b, sym, true)));
      }
      table.appendChild(tbody);
      box.appendChild(table);
      box.appendChild(buildPager(page, hasNext, pg => renderBlocks(pg)));
      wrap.appendChild(box);
      wrap.style.minHeight = '';
    } catch { wrap.style.minHeight = ''; wrap.innerHTML = ''; showError(wrap); }
  };

  const renderStart = () => {
    const wrap = $('pane-start');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!S.pool) { S.serverDown ? showServerDown(wrap) : showNoPool(wrap); return; }
    const p    = S.pool.pool;
    const coin = p.coin  || {};
    const ports = Object.entries(p.ports || {});
    wrap.appendChild(buildGenerator(ports, coin, p));
  };

  const buildGenerator = (ports, coin, p) => {
    const card = mk('div', 'mp-gen-card');
    card.appendChild(txt('div', 'mp-gen-title', t('start.generator')));

    const host = (() => { try { return new URL(S.base).hostname; } catch { return 'pool.host'; } })();

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

    const protGrp = mk('div', 'mp-gen-group mp-gen-group--hidden');
    protGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.proto-label')));
    const protSel = mk('select', 'mp-gen-select');
    [['ssl', 'SSL (stratum+ssl://)'], ['tcp', 'TCP (stratum+tcp://)']].forEach(([v, l]) => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = l;
      protSel.appendChild(opt);
    });
    protGrp.appendChild(protSel);

    const stratumGrp = mk('div', 'mp-gen-group grow');
    stratumGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.stratum')));
    const stratumInp = mk('input', 'mp-gen-input mp-stratum-inp');
    stratumInp.type = 'text';
    stratumInp.id = 'gen-stratum';
    stratumInp.placeholder = `stratum+tcp://${host}:3032`;
    stratumInp.autocomplete = 'off';
    stratumInp.spellcheck = false;
    stratumGrp.appendChild(stratumInp);
    stratumRow.append(protGrp, stratumGrp);

    const row2    = mk('div', 'mp-gen-row');
    const portGrp = mk('div', 'mp-gen-group');
    portGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.select-port')));
    const portSel = mk('select', 'mp-gen-select');
    portSel.id = 'gen-port';
    ports.forEach(([port, cfg]) => {
      const opt = document.createElement('option');
      opt.value = safe(port);
      opt.textContent = `${port} (${cfg.tlsAuto ? 'SSL+TCP' : cfg.tls ? 'SSL' : 'TCP'})`;
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

    const algoGrp = mk('div', 'mp-gen-group');
    algoGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.algo-label')));
    const algoInp = mk('input', 'mp-gen-input');
    algoInp.type = 'text';
    algoInp.id = 'gen-algo';
    algoInp.placeholder = 'argon2id1024';
    algoInp.autocomplete = 'off';
    algoInp.spellcheck = false;
    algoInp.value = safe(coin.algorithm || '');
    algoGrp.appendChild(algoInp);

    const archGrp = mk('div', 'mp-gen-group');    archGrp.id = 'gen-arch-wrap';
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

    row2.append(portGrp, modeGrp, algoGrp, archGrp, thrGrp, bsGrp, gpuGrp, diffGrp);

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
      const tlsAuto = portCfg.tlsAuto === true;
      const hasTls  = portCfg.tls === true;
      protGrp.classList.toggle('mp-gen-group--hidden', !tlsAuto);
      const proto   = tlsAuto
        ? (protSel.value === 'ssl' ? 'stratum+ssl' : 'stratum+tcp')
        : (hasTls ? 'stratum+ssl' : 'stratum+tcp');
      const computed = `${proto}://${host}:${port}`;
      if (!stratumInp.dataset.manual) stratumInp.value = computed;
      const server = safe(stratumInp.value) || computed;
      const addr   = safe(addrInp.value);
      const algo   = safe(algoInp.value);
      if (!addr) {
        cmdBox.innerHTML = '';
        cmdBox.appendChild(txt('span', 'mp-cmd-hint', t('start.enter-address')));
        return;
      }
      if (!algo) {
        cmdBox.innerHTML = '';
        cmdBox.appendChild(txt('span', 'mp-cmd-hint', t('start.enter-algo')));
        return;
      }
      const wrk   = safe(wrkInp.value);
      const mode  = modeSel.value;
      const user  = wrk ? `${addr}.${wrk}` : addr;
      const rawDiff  = safe(diffInp.value);
      const isStrictInt = /^\d+$/.test(rawDiff);
      const diffVal  = isStrictInt ? Number(rawDiff) : NaN;
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
    protSel.addEventListener('change', () => { delete stratumInp.dataset.manual; buildCmd(); });

    const toggleGpu = () => {
      const gpu = modeSel.value !== 'cpu';
      archGrp.classList.toggle('mp-gen-group--hidden', gpu);
      thrGrp.classList.toggle('mp-gen-group--hidden', gpu);
      bsGrp.classList.toggle('mp-gen-group--hidden', !gpu);
      gpuGrp.classList.toggle('mp-gen-group--hidden', !gpu);
      buildCmd();
    };

    [addrInp, wrkInp, algoInp, archSel, thrInp, bsInp, gpuInp, diffInp].forEach(el => el.addEventListener('input', buildCmd));
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

  const refreshMinerDashboard = () => {
    const addr = localStorage.getItem(LS_MINER + S.poolId);
    if (!addr) return;
    const wrap = $('pane-myminer');
    if (!wrap || !wrap.querySelector('.mp-miner-header')) return;
    patchMinerStats(addr);
    S.patchMinerBlocks?.();
    S.patchMinerPayments?.();
  };

  const patchMinerStats = async addr => {
    const pid = S.poolId;
    const sym = S.pool?.pool?.coin?.symbol || '';
    try {
      const mStats = await api.miner(pid, addr).catch(() => null);
      if (S.poolId !== pid) return;
      if (!mStats) return;

      if (mStats.pendingBalance  != null) setEl('mm-balance',     fmt.coin(mStats.pendingBalance, sym));
      if (mStats.totalPaid       != null) setEl('mm-total-paid',  fmt.coin(mStats.totalPaid, sym));
      if (mStats.todayPaid       != null) setEl('mm-today-paid',  fmt.coin(mStats.todayPaid, sym));
      if (mStats.lastPayment)                                       setEl('mm-last-pay',    fmt.time(mStats.lastPayment));
      if (mStats.totalConfirmedBlocks != null) {
        const orphaned = mStats.totalOrphanedBlocks > 0 ? ` / ${mStats.totalOrphanedBlocks} ${t('blocks.orphaned')}` : '';
        setEl('mm-blocks-found', `${mStats.totalConfirmedBlocks} ${t('blocks.confirmed')} / ${mStats.totalPendingBlocks ?? 0} ${t('blocks.pending')}${orphaned}`);
      }

      const pp = S.pool?.pool?.paymentProcessing || {};
      if (mStats.lastPayment && pp.paymentIntervalSeconds && S.mmCountdown) {
        S.mmCountdown.reset(mStats.lastPayment);
      }

      const perfWorkers = Object.values(mStats.performance?.workers ?? {});
      const totalHr     = perfWorkers.reduce((a, w) => a + (w.hashrate ?? 0), 0);
      const totalSps    = perfWorkers.reduce((a, w) => a + (w.sharesPerSecond ?? 0), 0);

      setEl('mm-live-hr', fmt.hash(totalHr));
      setEl('mm-shares', totalSps.toFixed(3));
      if (mStats.workersOnline  != null) setEl('mm-workers-online',  String(mStats.workersOnline));
      if (mStats.workersOffline != null) setEl('mm-workers-offline', String(mStats.workersOffline));
      if (mStats.pendingShares  != null) setEl('mm-pending-shares',  mStats.pendingShares.toFixed(4));

      if (mStats.minerEffort != null) {
        S.mmEffort?.update(Number(mStats.minerEffort));
      }

      const latest = mStats.performance ?? null;
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
    if (!S.poolId) { S.serverDown ? showServerDown(wrap) : showNoPool(wrap); return; }
    const saved = localStorage.getItem(LS_MINER + S.poolId);
    if (!saved) { renderMinerLogin(wrap); return; }
    // DOM already built for this pool — refresh all data without DOM rebuild
    if (wrap.dataset.renderedPool === S.poolId && wrap.querySelector('.mp-miner-header')) {
      refreshMinerDashboard();
      return;
    }
    await renderMinerDashboard(wrap, saved);
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
    wrap.dataset.renderedPool = '';     // clear while loading
    wrap.innerHTML = '';
    showLoading(wrap);
    try {
      const mStats = await api.miner(pid, addr).catch(() => null);
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
      wrap.dataset.renderedPool = pid;  // DOM is valid for this pool
      const hdr    = mk('div', 'mp-miner-header');
      const addrEl = mk('div', 'mp-miner-addr');
      addrEl.textContent = fmt.addr(addr, 20);
      applyCopyAddr(addrEl, safe(addr));
      hdr.append(addrEl, makeForgetBtn(wrap));
      wrap.appendChild(hdr);

      const sym = S.pool?.pool?.coin?.symbol || '';
      const pp  = S.pool?.pool?.paymentProcessing || {};
      const grid = mk('div', 'mp-2col-grid');

      const balCard = buildCard('myminer.title', 'fa-wallet', [
        ['myminer.balance',      mStats.pendingBalance != null ? fmt.coin(mStats.pendingBalance, sym) : null, 'accent', 'mm-balance'],
        ['myminer.paid',         mStats.totalPaid      != null ? fmt.coin(mStats.totalPaid, sym) : null,      null, 'mm-total-paid'],
        ['myminer.today',        mStats.todayPaid      != null ? fmt.coin(mStats.todayPaid, sym) : null,      null, 'mm-today-paid'],
        ['myminer.last-payment', mStats.lastPayment ? fmt.time(mStats.lastPayment) : null,                    null, 'mm-last-pay'],
        ['myminer.blocks-found', mStats.totalConfirmedBlocks != null
          ? `${mStats.totalConfirmedBlocks} ${t('blocks.confirmed')} / ${mStats.totalPendingBlocks ?? 0} ${t('blocks.pending')}${mStats.totalOrphanedBlocks > 0 ? ` / ${mStats.totalOrphanedBlocks} ${t('blocks.orphaned')}` : ''}` : null, null, 'mm-blocks-found'],
      ]);

      if (mStats.lastPayment && pp.paymentIntervalSeconds) {
        S.mmCountdown?.destroy();
        S.mmCountdown = CountdownTick.build(balCard, mStats.lastPayment, pp.paymentIntervalSeconds);
      }

      const perfWorkers = Object.values(mStats.performance?.workers ?? {});
      const totalHr     = perfWorkers.reduce((a, w) => a + (w.hashrate ?? 0), 0);
      const totalSps    = perfWorkers.reduce((a, w) => a + (w.sharesPerSecond ?? 0), 0);

      const hrCard = buildCard('card.pool', 'fa-gauge-high', [
        ['pool.hashrate',          fmt.hash(totalHr),                                                       'accent', 'mm-live-hr'],
        ['pool.shares',            totalSps.toFixed(3),                                                      null,    'mm-shares'],
        ['pool.workers.online',    mStats.workersOnline  != null ? mStats.workersOnline  : null, 'ok', 'mm-workers-online'],
        ['pool.workers.offline',   mStats.workersOffline != null ? mStats.workersOffline : null,
          (mStats.workersOffline || 0) > 0 ? 'warn' : '', 'mm-workers-offline'],
        ['myminer.pending-shares', mStats.pendingShares  != null ? mStats.pendingShares.toFixed(4) : null, null, 'mm-pending-shares'],
      ]);

      if (mStats.minerEffort != null) {
        S.mmEffort = EffortBar.build(mStats.minerEffort);
        const effortRow = mk('div', 'mp-metric');
        effortRow.append(txt('span', 'mp-metric-lbl', t('myminer.effort')), S.mmEffort.el);
        const metricRows = hrCard.querySelectorAll('.mp-metric');
        const lastRow = metricRows[metricRows.length - 1];
        if (lastRow) hrCard.insertBefore(effortRow, lastRow);
        else hrCard.appendChild(effortRow);
      }

      grid.append(balCard, hrCard);
      wrap.appendChild(grid);

      const latest = mStats.performance ?? null;
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

      await renderMinerBlocks(wrap, addr);
      await renderMinerPayments(wrap, addr);
    } catch { wrap.innerHTML = ''; showError(wrap); }
  };

  const renderMinerBlocks = async (wrap, addr) => {
    const pid     = S.poolId;
    const section = mk('div', 'mp-miner-section');
    section.appendChild(txt('div', 'mp-section', t('myminer.blocks')));
    wrap.appendChild(section);

    let allBlocks   = [];
    let currentPage = 0;

    const showPage = page => {
      currentPage = page;
      const existing = section.querySelector('.mp-table-box, .mp-empty');
      if (existing && page > 0) section.style.minHeight = `${section.offsetHeight}px`;
      if (existing) existing.remove();

      const sym     = S.pool?.pool?.coin?.symbol || '';
      const start   = page * MINER_BLOCKS_PAGE;
      const shown   = allBlocks.slice(start, start + MINER_BLOCKS_PAGE);
      const hasNext = start + MINER_BLOCKS_PAGE < allBlocks.length;

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
      // client-side pager — no re-fetch on page change
      box.appendChild(buildPager(page, hasNext, pg => showPage(pg)));
      section.appendChild(box);
      section.style.minHeight = '';
    };

    // Initial load
    try {
      const raw = await api.minerBlocks(pid, addr);
      if (S.poolId !== pid) return;
      allBlocks = Array.isArray(raw) ? raw : [];
    } catch (err) {
      console.error('renderMinerBlocks fetch', err);
      allBlocks = [];
    }
    showPage(0);

    // Expose refresh — re-fetches data, re-renders current page without full DOM rebuild
    S.patchMinerBlocks = async () => {
      try {
        const raw = await api.minerBlocks(pid, addr);
        if (S.poolId !== pid) return;
        allBlocks = Array.isArray(raw) ? raw : [];
        showPage(currentPage);
      } catch { /* keep stale */ }
    };
  };

  const renderMinerPayments = async (wrap, addr) => {
    const pid     = S.poolId;
    const section = mk('div', 'mp-miner-section');
    section.appendChild(txt('div', 'mp-section', t('myminer.payments')));
    wrap.appendChild(section);

    let allPayments = [];
    let currentPage = 0;

    const showPage = page => {
      currentPage = page;
      const existing = section.querySelector('.mp-table-box, .mp-empty');
      if (existing && page > 0) section.style.minHeight = `${section.offsetHeight}px`;
      if (existing) existing.remove();

      const sym     = S.pool?.pool?.coin?.symbol || '';
      const start   = page * MINER_BLOCKS_PAGE;
      const shown   = allPayments.slice(start, start + MINER_BLOCKS_PAGE);
      const hasNext = start + MINER_BLOCKS_PAGE < allPayments.length;

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
        const txUrl = safeUrl(pay.transactionInfoLink);
        if (txUrl && pay.transactionConfirmationData) {
          const a = mk('a');
          a.href = txUrl;
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
      box.appendChild(buildPager(page, hasNext, pg => showPage(pg)));
      section.appendChild(box);
      section.style.minHeight = '';
    };

    // Initial load
    try {
      const raw = await api.minerPayments(pid, addr);
      if (S.poolId !== pid) return;
      allPayments = Array.isArray(raw) ? raw : [];
    } catch (err) {
      console.error('renderMinerPayments fetch', err);
      allPayments = [];
    }
    showPage(0);

    // Expose refresh — re-fetches data, re-renders current page without full DOM rebuild
    S.patchMinerPayments = async () => {
      try {
        const raw = await api.minerPayments(pid, addr);
        if (S.poolId !== pid) return;
        allPayments = Array.isArray(raw) ? raw : [];
        showPage(currentPage);
      } catch { /* keep stale */ }
    };
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

  // Replaces native browser title tooltip on addresses.
  // Adds cursor:pointer + click-to-copy with a brief inline ✓ flash.
  const applyCopyAddr = (el, fullAddr) => {
    el.classList.add('mp-addr-copy');
    el.addEventListener('click', () => {
      navigator.clipboard?.writeText(fullAddr).then(() => {
        const was = el.textContent;
        el.textContent = t('start.copied');
        el.classList.add('mp-addr-copied');
        setTimeout(() => {
          el.textContent = was;
          el.classList.remove('mp-addr-copied');
        }, 1200);
      });
    });
  };

  const appendMetricRow = (card, label, value, cls, id) => {
    const row = mk('div', 'mp-metric');
    const l   = txt('span', 'mp-metric-lbl', label);
    const v   = txt('span', `mp-metric-val${cls ? ` ${cls}` : ''}`, value);
    if (id) v.id = id;
    row.append(l, v);
    card.appendChild(row);
  };

  const renderSettings = () => {
    const wrap = $('pane-settings');
    if (!wrap) return;
    wrap.innerHTML = '';

    const card = mk('div', 'mp-card');

    const head = mk('div', 'mp-card-head');
    const title = mk('div', 'mp-card-title');
    title.appendChild(mk('i', 'fa-solid fa-plug'));
    title.appendChild(document.createTextNode(t('settings.connection')));
    head.appendChild(title);
    card.appendChild(head);

    card.appendChild(txt('div', 'mp-settings-lbl', t('settings.api-url')));

    const row = mk('div', 'mp-settings-row');
    const inp = mk('input', 'mp-addr-input');
    inp.type = 'url';
    inp.id = 'base-url';
    inp.placeholder = 'https://pooltest.bitwebcore.net';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.value = S.base || '';

    const btn = mk('button', 'mp-open-btn');
    btn.type = 'button';
    btn.id = 'apply-url';
    btn.append(mk('i', 'fa-solid fa-arrows-rotate'), document.createTextNode(' '));
    const btnSpan = txt('span', '', t('ui.connect'));
    btnSpan.dataset.tkey = 'ui.connect';
    btn.appendChild(btnSpan);

    row.append(inp, btn);
    card.appendChild(row);

    btn.addEventListener('click', () => {
      const val = safe(inp.value);
      if (!val) return;
      try { new URL(val); } catch { return; }
      S.base = val;
      localStorage.setItem(LS_BASE, val);
      S.wsRetry = 0;
      wsDisconnect();
      loadPools();
    });

    inp.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });

    wrap.appendChild(card);
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

  const EffortBar = {
    build(eff) {
      const apply = (wrap, fill, lbl, n) => {
        const cls = fmt.effortClass(n);
        const pct = isFinite(n) ? `${(n * 100).toFixed(1)}%` : '--';
        fill.style.width = isFinite(n) ? `${Math.min(n * 100, 100)}%` : '0%';
        fill.classList.toggle('overrun', n > 1);
        ['ok', 'warn', 'high'].forEach(c => fill.classList.remove(c));
        fill.classList.add(cls);
        lbl.textContent = pct;
        ['ok', 'warn', 'high'].forEach(c => wrap.classList.remove(c));
        wrap.classList.add(cls);
      };

      const n    = Number(eff);
      const wrap = mk('div', 'mp-effort-bar');
      const fill = mk('div', 'mp-effort-bar-fill');
      const lbl  = mk('span', 'mp-effort-bar-lbl');
      wrap.append(fill, lbl);
      apply(wrap, fill, lbl, n);

      return {
        el: wrap,
        update(newEff) { apply(wrap, fill, lbl, Number(newEff)); },
      };
    },
  };

  const CountdownTick = {
    build(card, lastPaymentTime, intervalSeconds) {
      const intMs = intervalSeconds * 1000;
      let lastMs = lastPaymentTime ? new Date(lastPaymentTime).getTime() : Date.now();
      let nextMs = lastMs + intMs;

      const nowInit = Date.now();
      if (nextMs <= nowInit) {
        const periods = Math.floor((nowInit - lastMs) / intMs);
        lastMs += periods * intMs;
        nextMs = lastMs + intMs;
      }

      const fill = mk('div', 'mp-inline-bar-fill');
      const lbl  = mk('span', 'mp-inline-bar-lbl');
      const bar  = mk('div', 'mp-inline-bar');
      bar.append(fill, lbl);
      const row = mk('div', 'mp-metric');
      row.append(txt('span', 'mp-metric-lbl', t('myminer.next-payment')), bar);
      card.appendChild(row);

      let waitingTimer = null;

      const clearWaiting = () => {
        if (waitingTimer) {
          clearTimeout(waitingTimer);
          waitingTimer = null;
        }
      };

      const advanceToNextPeriod = () => {
        lastMs = nextMs;
        nextMs = lastMs + intMs;
        clearWaiting();
        update();
      };

      const update = () => {
        const nowMs = Date.now();
        if (nowMs >= nextMs) {
          if (!waitingTimer) {
            fill.style.width = '100%';
            lbl.textContent = t('misc.just-now');
            waitingTimer = setTimeout(() => {
              advanceToNextPeriod();
            }, 5000);
          }
          return;
        }

        clearWaiting();
        const leftMs = nextMs - nowMs;
        const leftSec = Math.ceil(leftMs / 1000);
        const elapsed = Math.min(1, (nowMs - lastMs) / intMs);
        fill.style.width = `${elapsed * 100}%`;
        lbl.textContent = leftSec < 60 ? `${leftSec}s`
          : leftSec < 3600 ? `${Math.floor(leftSec / 60)}m`
          : leftSec < 86400 ? `${Math.floor(leftSec / 3600)}h`
          : `${Math.floor(leftSec / 86400)}d`;
      };

      update();
      const intervalId = setInterval(update, 1000);

      return {
        reset(newLastPaymentTime) {
          lastMs = new Date(newLastPaymentTime).getTime();
          nextMs = lastMs + intMs;
          clearWaiting();
          update();
        },
        destroy() {
          clearInterval(intervalId);
          clearWaiting();
          row.remove();
        },
      };
    },
  };

  const buildPager = (page, hasNext, onPage) => {
    const pg   = mk('div', 'mp-pager');
    const info = txt('span', 'mp-pager-info', `${t('page.current')} ${page + 1}`);
    const btns = mk('div', 'mp-pager-btns');
    const prev = txt('button', 'mp-pager-btn', t('page.prev'));
    const next = txt('button', 'mp-pager-btn', t('page.next'));
    prev.type = 'button';
    next.type = 'button';
    prev.disabled = page === 0;
    next.disabled = !hasNext;

    let navigating = false;
    const navigate = targetPage => {
      if (navigating) return;
      navigating = true;
      prev.disabled = true;
      next.disabled = true;
      const savedY = window.scrollY;
      Promise.resolve(onPage(targetPage)).finally(() => {
        navigating = false;
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

  const showServerDown = wrap => {
    if (!wrap) return;
    wrap.innerHTML = '';
    const e = mk('div', 'mp-empty');
    e.appendChild(mk('i', 'fa-solid fa-plug-circle-xmark'));
    e.appendChild(document.createTextNode(' ' + t('error.server-down')));
    const btn = mk('button', 'mp-open-btn');
    btn.type = 'button';
    btn.style.marginTop = '14px';
    btn.append(mk('i', 'fa-solid fa-gear'), document.createTextNode(' '));
    const sp = document.createElement('span');
    sp.dataset.tkey = 'tab.settings';
    sp.textContent = t('tab.settings');
    btn.appendChild(sp);
    btn.addEventListener('click', () => {
      document.querySelector('[data-bs-target="#pane-settings"]')?.click();
    });
    e.appendChild(btn);
    wrap.appendChild(e);
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

    document.querySelectorAll('.mp-tab').forEach(btn => {
      btn.addEventListener('shown.bs.tab', () => {
        S.activeTab = (btn.getAttribute('data-bs-target') || '').replace('#pane-', '');
        renderActiveTab();
      });
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (S.theme === 'auto') applyTheme();
    });

    loadPools();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
