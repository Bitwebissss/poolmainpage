(function () {
  'use strict';

  const LS_THEME  = 'mp-theme';
  const LS_LANG   = 'mp-lang';
  const LS_BASE   = 'mp-base';
  const LS_POOL   = 'mp-pool';
  const LS_MINER  = 'mp-miner-';

  const PAGE_SIZE     = 20;
  const TOP_SIZE      = 50;
  const POLL_MS       = 60_000;

  let poolSelectBound   = false;
  let ovPoolNextPayTick = null;
  let mmNextPayTick     = null;

  const CPU_ARCHS = [
    'avx512-sha-vaes', 'avx512', 'avx2-sha-vaes', 'avx2-sha',
    'avx2', 'avx', 'aes-sse42', 'sse2',
  ];

  const S = {
    base:      localStorage.getItem(LS_BASE) || 'https://pool.bitwebcore.net',
    poolId:    null,
    pool:      null,
    wsCache:   {},
    pollTimer: null,
    bPage:     0,
    ws:        null,
    wsRetry:   0,
    lang:      localStorage.getItem(LS_LANG) || 'en',
    theme:     localStorage.getItem(LS_THEME) || 'auto',
    activeTab: 'overview',
    minerSeq:  0,
  };

  const t = k => window.mpLang?.[S.lang]?.[k] ?? window.mpLang?.en?.[k] ?? k;

  const applyTkeys = () => {
    document.querySelectorAll('[data-tkey]').forEach(el => {
      const val = t(el.dataset.tkey);
      if (el.tagName === 'INPUT') el.placeholder = val;
      else el.textContent = val;
    });
  };

  const $   = id => document.getElementById(id);
  const mk  = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const txt = (tag, cls, text) => { const e = mk(tag, cls); e.textContent = String(text ?? ''); return e; };
  const safe = v => String(v ?? '').trim();

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
      if (!isFinite(d) || d <= 0) return '--';
      if (d < 1000) return d.toFixed(6);
      const u = ['', 'K', 'M', 'G', 'T', 'P'];
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

  const enc = v => encodeURIComponent(safe(v));
  const api = {
    async _get(path) {
      const r = await fetch(`${S.base}${path}`, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    pools:         ()                => api._get('/api/pools'),
    pool:          id                => api._get(`/api/pools/${enc(id)}`),
    blocks:        (id, p, s)        => api._get(`/api/pools/${enc(id)}/blocks?page=${p}&pageSize=${s}`),
    miners:        (id, p, s)        => api._get(`/api/pools/${enc(id)}/miners?page=${p}&pageSize=${s}&topMinersRange=24`),
    perf:          id                => api._get(`/api/pools/${enc(id)}/performance`),
    miner:         (id, a)           => api._get(`/api/pools/${enc(id)}/miners/${enc(a)}`),
    minerPerf:     (id, a)           => api._get(`/api/pools/${enc(id)}/miners/${enc(a)}/performance`),
    minerBlocks:   (id, a, p, s)     => api._get(`/api/pools/${enc(id)}/miners/${enc(a)}/blocks?page=${p}&pageSize=${s}`),
    minerPayments: (id, a, p, s)     => api._get(`/api/pools/${enc(id)}/miners/${enc(a)}/payments?page=${p}&pageSize=${s}`),
  };

  const wsPoolHashrate = () => S.wsCache[S.poolId]?.poolHashrate ?? null;
  const wsBlockHeight  = () => S.wsCache[S.poolId]?.blockHeight  ?? null;
  const wsMinerHr      = addr => S.wsCache[S.poolId]?.minerHashrates?.[addr] ?? null;

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

  const toast = (msg, icon = 'circle-info', type = 'info', dur = 5000) => {
    const box = $('mp-toasts');
    if (!box) return;
    while (box.children.length >= 4) box.firstChild.remove();
    const wrap = mk('div', `mp-toast ${type}`);
    const ico  = mk('i', `fa-solid fa-${icon}`);
    wrap.append(ico, document.createTextNode(msg));
    box.appendChild(wrap);
    setTimeout(() => {
      wrap.style.opacity = '0';
      wrap.style.transform = 'translateX(10px)';
      wrap.style.transition = 'opacity 0.3s, transform 0.3s';
      setTimeout(() => wrap.remove(), 320);
    }, dur);
  };

  const toastBlockFound = (height, sym, iconPath) => {
    const box = $('mp-toasts');
    if (!box) return;
    while (box.children.length >= 4) box.firstChild.remove();
    const dur  = 8000;
    const wrap = mk('div', 'mp-toast mp-toast-block ok');

    // Row: icon + text side by side
    const row = mk('div', 'mp-toast-block-row');
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

    // Progress bar at bottom
    const bar  = mk('div', 'mp-toast-bar');
    const fill = mk('div', 'mp-toast-bar-fill');
    bar.appendChild(fill);
    wrap.appendChild(bar);

    box.appendChild(wrap);

    // Animate bar: 100% -> 0% over dur ms (double-RAF to ensure paint before transition)
    fill.style.width = '100%';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fill.style.transition = `width ${dur}ms linear`;
        fill.style.width = '0%';
      });
    });

    setTimeout(() => {
      wrap.style.opacity = '0';
      wrap.style.transform = 'translateX(10px)';
      wrap.style.transition = 'opacity 0.3s, transform 0.3s';
      setTimeout(() => wrap.remove(), 320);
    }, dur);
  };

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
      S.ws.addEventListener('close', () => {
        const dot = $('ws-dot');
        if (dot) dot.classList.remove('connected');
        S.wsRetry++;
        const delay = Math.min(1000 * 2 ** S.wsRetry, 30_000);
        setTimeout(wsConnect, delay);
      });
      S.ws.addEventListener('error', err => { console.error('ws error', err); });
      S.ws.addEventListener('message', e => {
        try { wsHandle(JSON.parse(e.data)); } catch (err) { console.error('ws message error', err); }
      });
    } catch (err) { console.error('ws connect error', err); }
  };

  const wsDisconnect = () => {
    if (S.ws) { S.ws.onclose = null; S.ws.close(); S.ws = null; }
  };

  const wsHandle = msg => {
    const type = (msg.type || '').toLowerCase();
    const pid  = msg.poolId;

    if (type === 'hashrateupdated' && pid) {
      if (!S.wsCache[pid]) S.wsCache[pid] = { minerHashrates: {} };
      if (!msg.miner) {
        S.wsCache[pid].poolHashrate = msg.hashrate;
        if (pid === S.poolId) {
          const el = $('ov-pool-hr');
          if (el) el.textContent = fmt.hash(msg.hashrate);
          const ch = $('mp-chart-current');
          if (ch) ch.textContent = fmt.hash(msg.hashrate);
        }
      } else {
        if (!S.wsCache[pid].minerHashrates) S.wsCache[pid].minerHashrates = {};
        S.wsCache[pid].minerHashrates[msg.miner] = msg.hashrate;
        if (pid === S.poolId) updateLiveMinerHr(msg.miner, msg.hashrate);
      }
    }

    if (type === 'newchainheight' && pid) {
      if (!S.wsCache[pid]) S.wsCache[pid] = { minerHashrates: {} };
      S.wsCache[pid].blockHeight = msg.blockHeight;
      if (pid === S.poolId) {
        const el = $('ov-net-height');
        if (el) el.textContent = safe(msg.blockHeight);
      }
    }

    if (type === 'blockfound' && pid === S.poolId) {
      const sym  = S.pool?.pool?.coin?.symbol || '';
      const icon = sym ? `assets/images/${sym.toLowerCase()}.svg` : null;
      toastBlockFound(msg.blockHeight, sym, icon);
      if (S.activeTab === 'overview') renderOverview();
      if (S.activeTab === 'blocks')   renderBlocks(0);
    }

    if (type === 'blockunlocked' && pid === S.poolId) {
      if (S.activeTab === 'blocks') renderBlocks(S.bPage);
    }

    if (type === 'payment' && pid === S.poolId) {
      const sym = S.pool?.pool?.coin?.symbol || '';
      toast(`${t('ws.payment')} ${fmt.coin(msg.amount, sym)}`, 'money-bill-transfer', 'ok');
    }
  };

  const updateLiveMinerHr = (miner, hashrate) => {
    const saved = localStorage.getItem(LS_MINER + S.poolId);
    if (saved !== miner) return;
    const el = $('mm-live-hr');
    if (el) el.textContent = fmt.hash(hashrate);
  };

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
      if (!poolSelectBound) {
        sel.addEventListener('change', () => { if (sel.value) switchPool(sel.value); });
        poolSelectBound = true;
      }
      const saved = localStorage.getItem(LS_POOL);
      if (saved && pools.find(p => p.id === saved)) {
        sel.value = saved;
        await switchPool(saved);
      } else if (pools.length >= 1) {
        sel.value = pools[0].id;
        await switchPool(pools[0].id);
      }
    } catch { showNoPool(null); }
  };

  const switchPool = async id => {
    S.poolId = id;
    localStorage.setItem(LS_POOL, id);
    clearTimers();
    try {
      const data = await api.pool(id);
      S.pool  = data;
      S.bPage = 0;
      updateBrandIcon();
      renderActiveTab();
      startPollTimer();
    } catch { showError($('tab-content-wrap')); }
  };

  const clearTimers = () => {
    clearInterval(S.pollTimer);
    S.pollTimer = null;
  };

  const startPollTimer = () => {
    S.pollTimer = setInterval(async () => {
      if (!S.poolId) return;
      try {
        S.pool = await api.pool(S.poolId);
        if (S.activeTab === 'overview') patchOverviewRest();
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
    img.src = `assets/images/${coin.symbol.toLowerCase()}.svg`;
    img.alt = safe(coin.symbol);
    img.onerror = () => { img.remove(); iconEl.appendChild(mk('i', 'fa-solid fa-cube')); };
    iconEl.appendChild(img);
    document.title = `${safe(coin.name || coin.symbol)} Pool`;
  };

  const renderActiveTab = () => {
    switch (S.activeTab) {
      case 'overview': renderOverview(); break;
      case 'blocks':   renderBlocks(S.bPage); break;
      case 'start':    renderStart();    break;
      case 'myminer':  renderMyMiner();  break;
    }
  };

  const buildChartSvg = pts => {
    if (!pts?.length) return null;
    const W = 600, H = 90, pad = 4;
    const vals = pts.map(p => Number(p.poolHashrate));
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const rng = mx - mn || 1;
    const xs = pts.map((_, i) => pad + (i / Math.max(pts.length - 1, 1)) * (W - pad * 2));
    const ys = vals.map(v => pad + (H - pad * 2) - ((v - mn) / rng) * (H - pad * 2));
    const line = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join('L');
    const area = `M${line}L${xs[xs.length - 1].toFixed(1)},${H}L${xs[0].toFixed(1)},${H}Z`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = `<defs><linearGradient id="mpGrd" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--tab-active)" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="var(--tab-active)" stop-opacity="0.02"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#mpGrd)"/>
    <path d="M${line}" fill="none" stroke="var(--tab-active)" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>`;
    return svg;
  };

  // Universal effort progress bar: number inside the pill, bar colour changes with level.
  // 0–100% → green  |  >100% → yellow  |  >200% → red.
  // The displayed number never changes colour — it sits on top of the fill.
  const buildEffortBar = (eff, id) => {
    const n      = Number(eff);
    const cls    = fmt.effortClass(n);
    const pct    = isFinite(n) ? `${(n * 100).toFixed(1)}%` : '--';
    const wrap   = mk('div', `mp-effort-bar ${cls}`);
    const fill   = mk('div', `mp-effort-bar-fill ${cls}`);
    fill.style.width = isFinite(n) ? `${Math.min(n * 100, 100)}%` : '0%';
    if (n > 1) fill.classList.add('overrun');
    if (id) fill.id = `${id}-fill`;
    const lbl = txt('span', 'mp-effort-bar-lbl', pct);
    if (id) lbl.id = id;
    wrap.append(fill, lbl);
    return wrap;
  };

  // Shared block row builder used by renderBlocks and renderMinerBlocks
  const buildBlockRow = (b, sym, showMiner = true) => {
    const row = mk('tr');
    const htd = mk('td', 'mono');
    if (b.infoLink) {
      const a = mk('a');
      a.href = safe(b.infoLink);
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
    row.appendChild(timeTd);
    row.appendChild(txt('td', 'mono', b.reward != null ? fmt.coin(b.reward, sym) : '--'));
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

  // Inline labeled progress bar: used for Next Payment countdown
  const buildInlineBar = (progress, labelId, labelText) => {
    const bar  = mk('div', 'mp-inline-bar');
    const fill = mk('div', 'mp-inline-bar-fill');
    fill.style.width = `${Math.min(progress * 100, 100)}%`;
    // Give fill a stable ID so the countdown timer can update width each tick
    if (labelId) fill.id = `${labelId}-fill`;
    const lbl = txt('span', 'mp-inline-bar-lbl', labelText);
    if (labelId) lbl.id = labelId;
    bar.append(fill, lbl);
    return bar;
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
      const row = mk('div', 'mp-metric');
      const l = txt('span', 'mp-metric-lbl', t(key));
      const v = txt('span', `mp-metric-val${cls ? ` ${cls}` : ''}`, safe(val));
      if (id) v.id = id;
      row.append(l, v);
      card.appendChild(row);
    });
    return card;
  };

  // ── OVERVIEW ───────────────────────────────────────────────────────────────

  const renderOverview = async () => {
    const wrap = $('pane-overview');
    if (!wrap) return;
    if (!S.pool) { showNoPool(wrap); return; }
    wrap.innerHTML = '';

    const p    = S.pool.pool;
    const ns   = p.networkStats      || {};
    const ps   = p.poolStats         || {};
    const pp   = p.paymentProcessing || {};
    const coin = p.coin              || {};

    const liveHr     = wsPoolHashrate() ?? ps.poolHashrate ?? 0;
    const liveHeight = wsBlockHeight()  ?? ns.blockHeight  ?? 0;
    const sym        = safe(coin.symbol);

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
    loadChart(chartWrap);

    const minersHeader = mk('div', 'mp-section');
    minersHeader.appendChild(document.createTextNode(t('topminers.title')));
    const minersCount = txt('span', 'mp-section-count', String(TOP_SIZE));
    minersHeader.appendChild(minersCount);
    wrap.appendChild(minersHeader);
    await loadTopMiners(wrap);
  };

  const buildCoinCard = (coin, ns, p, liveHeight, sym) => {
    const card = mk('div', 'mp-card');
    const head  = mk('div', 'mp-card-head');
    const title = mk('div', 'mp-card-title');
    const iconEl = mk('span', 'mp-coin-title-icon');
    if (sym) {
      const img = document.createElement('img');
      img.src    = `assets/images/${sym.toLowerCase()}.svg`;
      img.alt    = sym;
      img.width  = 16;
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

    [
      ['coin.network', ns.networkType || coin.type || null],
      ['coin.project', coin.name || coin.canonicalName || null],
      ['coin.ticker',  sym || null],
      ['coin.algo',    coin.algorithm || null],
      // Block Height directly under Algorithm — real-time value from WS / REST
      ['net.height',   liveHeight ? String(liveHeight) : '--', 'accent', 'ov-net-height'],
    ].forEach(([key, val, cls, id]) => {
      if (!val) return;
      const row = mk('div', 'mp-metric');
      const l   = txt('span', 'mp-metric-lbl', t(key));
      const v   = txt('span', `mp-metric-val${cls ? ` ${cls}` : ''}`, safe(val));
      if (id) v.id = id;
      row.append(l, v);
      card.appendChild(row);
    });

    // Social / community links — metric rows, icon + name, rendered after all network stats
    const socialDefs = [
      [coin.website,  'fa-solid fa-globe',      t('coin.website') || 'Website'],
      [coin.twitter,  'fa-brands fa-x-twitter', 'Twitter'],
      [coin.discord,  'fa-brands fa-discord',   'Discord'],
      [coin.telegram, 'fa-brands fa-telegram',  'Telegram'],
      [coin.github,   'fa-brands fa-github',    'GitHub'],
      [coin.market,   'fa-solid fa-store',      t('coin.market') || 'Market'],
    ];

    [
      // net.height lives above, under Algorithm — real-time element id ov-net-height
      ['net.hashrate',   fmt.hash(ns.networkHashrate)],
      ['net.difficulty', fmt.diff(ns.networkDifficulty)],
      ['net.last-block', fmt.time(ns.lastNetworkBlockTime)],
      ['net.version',    ns.nodeVersion || null],
      ['net.peers',      ns.connectedPeers != null ? String(ns.connectedPeers) : null],
    ].forEach(([key, val, cls, id]) => {
      if (val === null || val === undefined) return;
      const row = mk('div', 'mp-metric');
      const l   = txt('span', 'mp-metric-lbl', t(key));
      const v   = txt('span', `mp-metric-val${cls ? ` ${cls}` : ''}`, safe(val));
      if (id) v.id = id;
      row.append(l, v);
      card.appendChild(row);
    });

    // Links at very bottom — icon (standalone) + name as link, left-aligned
    socialDefs.forEach(([url, iconCls, label]) => {
      if (!url) return;
      const row = mk('div', 'mp-social-link-row');
      const ico = mk('i', iconCls);
      const a   = mk('a', 'mp-social-link-a');
      a.href   = safe(url);
      a.target = '_blank';
      a.rel    = 'noopener noreferrer';
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

    [
      ['pool.hashrate',        fmt.hash(liveHr), 'accent', 'ov-pool-hr'],
      ['pool.miners',          ps.connectedMiners != null ? String(ps.connectedMiners) : null],
      ['pool.workers.online',  p.workersOnline  != null ? String(p.workersOnline)  : null, 'ok'],
      // Workers Offline omitted from global pool stats — always 0 at pool level
      // (a worker is either online or doesn't exist; offline workers only matter per-miner)
      ['pool.shares',          ps.sharesPerSecond != null ? ps.sharesPerSecond.toFixed(3) : null],
      ['pool.fee',             p.poolFeePercent  != null ? `${p.poolFeePercent}%` : null],
      ['pool.scheme',          pp.payoutScheme   || null],
      ['pool.min-payout',      pp.minimumPayment != null
        ? `${fmt.num(pp.minimumPayment, 8)} ${sym}`.trim() : null],
      ['pool.interval',        pp.paymentIntervalSeconds ? fmt.interval(pp.paymentIntervalSeconds) : null],
      ['pool.total-paid',      p.totalPaid != null ? fmt.coin(p.totalPaid, sym) : null],
    ].forEach(([key, val, cls, id]) => {
      if (val === null || val === undefined) return;
      const row = mk('div', 'mp-metric');
      const l   = txt('span', 'mp-metric-lbl', t(key));
      const v   = txt('span', `mp-metric-val${cls ? ` ${cls}` : ''}`, safe(val));
      if (id) v.id = id;
      row.append(l, v);
      card.appendChild(row);
    });

    // Payment countdown inline bar (pool-level)
    if (p.lastPaymentTime && pp.paymentIntervalSeconds) {
      const lastMs   = new Date(p.lastPaymentTime).getTime();
      const intMs    = pp.paymentIntervalSeconds * 1000;
      const nextMs   = lastMs + intMs;
      const secsLeft = Math.max(0, Math.round((nextMs - Date.now()) / 1000));
      const progress = Math.min(1, (Date.now() - lastMs) / intMs);
      const labelTxt = secsLeft > 0 ? fmt.interval(secsLeft) : t('misc.just-now');
      const row  = mk('div', 'mp-metric');
      const bar  = buildInlineBar(progress, 'ov-pool-next-pay', labelTxt);
      row.append(txt('span', 'mp-metric-lbl', t('myminer.next-payment')), bar);
      card.appendChild(row);
      if (ovPoolNextPayTick) { clearInterval(ovPoolNextPayTick); ovPoolNextPayTick = null; }
      if (secsLeft > 0) {
        ovPoolNextPayTick = setInterval(() => {
          const el   = $('ov-pool-next-pay');
          const fill = $('ov-pool-next-pay-fill');
          if (!el) { clearInterval(ovPoolNextPayTick); ovPoolNextPayTick = null; return; }
          const left    = Math.max(0, Math.round((nextMs - Date.now()) / 1000));
          const elapsed = Math.min(1, (Date.now() - lastMs) / intMs);
          // Update fill width every tick so bar smoothly reaches 100% at payment time
          if (fill) fill.style.width = `${elapsed * 100}%`;
          el.textContent = left > 0 ? fmt.interval(left) : t('misc.just-now');
          if (left === 0) { clearInterval(ovPoolNextPayTick); ovPoolNextPayTick = null; }
        }, 1000);
      }
    }

    // Port parameters from first port
    const portEntries = Object.entries(p.ports || {});
    if (portEntries.length) {
      const [, cfg] = portEntries[0];
      [
        ['start.start-diff',  cfg.difficulty != null ? String(cfg.difficulty) : null],
        ['start.var-min',     cfg.varDiff?.minDiff   != null ? String(cfg.varDiff.minDiff) : null],
        ['start.var-max',     cfg.varDiff?.maxDiff   != null ? String(cfg.varDiff.maxDiff) : null],
        ['start.target-time', cfg.varDiff?.targetTime ? `${cfg.varDiff.targetTime}s` : null],
        ['start.tls',         t(cfg.tls ? 'misc.yes' : 'misc.no')],
      ].forEach(([key, val]) => {
        if (val === null || val === undefined) return;
        const row = mk('div', 'mp-metric');
        row.append(txt('span', 'mp-metric-lbl', t(key)), txt('span', 'mp-metric-val', val));
        card.appendChild(row);
      });
    }

    return card;
  };

  // Current round card — includes Block Reward from last confirmed block
  const buildRoundCard = (p, ns, liveHr, sym) => {
    const eff  = Number(p.poolEffort ?? 0);
    const card = buildCard('card.round', 'fa-circle-notch', [
      ['round.ttf',        fmt.ttf(ns.networkDifficulty, liveHr)],
      ['round.last-block', fmt.time(p.lastPoolBlockTime)],
      ['round.reward',     p.blockReward != null ? fmt.coin(p.blockReward, sym) : null],
      ['round.blocks-24h', p.blocks24h       != null ? String(p.blocks24h)       : null],
      ['round.total',      p.totalBlocks     != null ? String(p.totalBlocks)     : null],
      ['round.confirmed',  p.totalConfirmedBlocks != null ? String(p.totalConfirmedBlocks) : null],
      ['round.pending',    p.totalPendingBlocks   != null ? String(p.totalPendingBlocks)   : null],
    ]);
    // Effort bar inserted as the first metric row (right after card header)
    const effortRow = mk('div', 'mp-metric');
    effortRow.append(txt('span', 'mp-metric-lbl', t('round.effort')), buildEffortBar(eff, 'ov-effort'));
    const head = card.querySelector('.mp-card-head');
    if (head?.nextSibling) card.insertBefore(effortRow, head.nextSibling);
    else card.appendChild(effortRow);
    return card;
  };

  const patchOverviewRest = () => {
    if (!S.pool) return;
    const p   = S.pool.pool;
    const ps  = p.poolStats || {};
    const ns  = p.networkStats || {};
    const set = (id, val) => { const e = $(id); if (e) e.textContent = safe(val); };
    if (wsBlockHeight() === null) set('ov-net-height', ns.blockHeight);
    if (wsPoolHashrate() === null) set('ov-pool-hr', fmt.hash(ps.poolHashrate));
    const eff  = Number(p.poolEffort ?? 0);
    set('ov-effort', fmt.effort(eff));
    const fill = $('ov-effort-fill');
    if (fill) {
      fill.style.width = `${Math.min(eff * 100, 100)}%`;
      // Sync overrun stripe
      fill.classList.toggle('overrun', eff > 1);
      // Sync colour class
      ['ok', 'warn', 'high'].forEach(c => fill.classList.remove(c));
      fill.classList.add(fmt.effortClass(eff));
    }
  };

  const loadChart = async wrap => {
    try {
      const data = await api.perf(S.poolId);
      const pts  = (data.stats || []).filter(p => p.poolHashrate > 0);
      if (!pts.length) { wrap.appendChild(txt('div', 'mp-chart-empty', t('chart.no-data'))); return; }
      const svg = buildChartSvg(pts);
      if (svg) wrap.appendChild(svg);
    } catch {
      wrap.appendChild(txt('div', 'mp-chart-empty', t('chart.no-data')));
    }
  };

  const RANK_ICONS = [
    { cls: 'mp-rank-gold',   icon: 'fa-crown' },
    { cls: 'mp-rank-silver', icon: 'fa-medal' },
    { cls: 'mp-rank-bronze', icon: 'fa-medal' },
  ];

  const loadTopMiners = async wrap => {
    try {
      const miners = await api.miners(S.poolId, 0, TOP_SIZE);
      buildTopMinersTable(wrap, miners || []);
    } catch {
      buildTopMinersTable(wrap, S.pool?.pool?.topMiners || []);
    }
  };

  const buildTopMinersTable = (wrap, miners) => {
    const box   = mk('div', 'mp-table-box');
    const table = mk('table', 'mp-table');
    const thead = mk('thead');
    const hrow  = mk('tr');
    ['topminers.rank', 'topminers.miner', 'topminers.hashrate', 'topminers.shares'].forEach(k => {
      hrow.appendChild(txt('th', '', t(k)));
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    const tbody = mk('tbody');
    if (!miners.length) {
      const row = mk('tr');
      const td  = mk('td');
      td.colSpan = 4;
      td.className = 'mp-empty';
      td.textContent = t('miners.empty');
      row.appendChild(td);
      tbody.appendChild(row);
    } else {
      miners.forEach((m, i) => {
        const row = mk('tr');
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
        tbody.appendChild(row);
      });
    }
    table.appendChild(tbody);
    box.appendChild(table);
    wrap.appendChild(box);
  };

  // ── BLOCKS ─────────────────────────────────────────────────────────────────

  const renderBlocks = async (page = 0) => {
    const wrap = $('pane-blocks');
    if (!wrap) return;
    if (!S.poolId) { showNoPool(wrap); return; }

    const isInit = page === 0 && !wrap.querySelector('.mp-table-box');
    if (isInit) { wrap.innerHTML = ''; showLoading(wrap); }

    try {
      const blocks = await api.blocks(S.poolId, page, PAGE_SIZE);
      S.bPage = page;

      if (isInit) wrap.innerHTML = '';

      const p = S.pool?.pool;
      let summaryBar = wrap.querySelector('.mp-summary-bar');
      if (!summaryBar && p) {
        summaryBar = mk('div', 'mp-summary-bar');
        [
          [t('round.total'),      p.totalBlocks],
          [t('blocks.confirmed'), p.totalConfirmedBlocks],
          [t('blocks.pending'),   p.totalPendingBlocks],
        ].forEach(([lbl, val]) => {
          const pill = mk('div', 'mp-summary-pill');
          pill.append(txt('span', '', lbl), txt('strong', '', safe(val ?? '--')));
          summaryBar.appendChild(pill);
        });
        wrap.appendChild(summaryBar);
      }

      const existing = wrap.querySelector('.mp-table-box');
      // Lock height before removing old content so page height doesn't collapse → scroll jump
      if (existing && page > 0) wrap.style.minHeight = `${wrap.offsetHeight}px`;
      if (existing) existing.remove();

      const sym   = S.pool?.pool?.coin?.symbol || '';
      const box   = mk('div', 'mp-table-box');
      const table = mk('table', 'mp-table');
      const thead = mk('thead');
      const hrow  = mk('tr');
      ['blocks.height', 'blocks.time', 'blocks.reward', 'blocks.effort',
        'blocks.miner', 'blocks.status'].forEach(k => {
        hrow.appendChild(txt('th', '', t(k)));
      });
      thead.appendChild(hrow);
      table.appendChild(thead);

      const tbody = mk('tbody');
      if (!blocks?.length) {
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
      box.appendChild(buildPager(page, blocks?.length ?? 0, pg => renderBlocks(pg)));
      wrap.appendChild(box);
      // Release height lock now that content is back
      wrap.style.minHeight = '';
    } catch { wrap.style.minHeight = ''; wrap.innerHTML = ''; showError(wrap); }
  };

  // ── START MINING ───────────────────────────────────────────────────────────

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

    // Row 1: address + worker name
    const row1    = mk('div', 'mp-gen-row');
    const addrGrp = mk('div', 'mp-gen-group grow');
    addrGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.address')));
    const addrInp = mk('input', 'mp-gen-input');
    addrInp.type         = 'text';
    addrInp.id           = 'gen-addr';
    addrInp.placeholder  = t('start.addr-placeholder');
    addrInp.autocomplete = 'off';
    addrInp.spellcheck   = false;
    addrGrp.appendChild(addrInp);

    const wrkGrp = mk('div', 'mp-gen-group');
    const wrkLbl = mk('div', 'mp-gen-lbl');
    wrkLbl.textContent = t('start.worker');
    wrkLbl.appendChild(txt('small', '', t('start.worker-hint')));
    wrkGrp.appendChild(wrkLbl);
    const wrkInp = mk('input', 'mp-gen-input');
    wrkInp.type        = 'text';
    wrkInp.id          = 'gen-worker';
    wrkInp.placeholder = t('start.worker-placeholder');
    wrkGrp.appendChild(wrkInp);
    row1.append(addrGrp, wrkGrp);

    // Stratum server row — editable input, auto-filled from port selection
    const stratumRow = mk('div', 'mp-gen-row');
    const stratumGrp = mk('div', 'mp-gen-group grow');
    stratumGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.stratum')));
    const stratumInp = mk('input', 'mp-gen-input mp-stratum-inp');
    stratumInp.type        = 'text';
    stratumInp.id          = 'gen-stratum';
    stratumInp.placeholder = `stratum+tcp://${host}:3032`;
    stratumInp.autocomplete = 'off';
    stratumInp.spellcheck   = false;
    stratumGrp.appendChild(stratumInp);
    stratumRow.appendChild(stratumGrp);

    // Row 2: port + mode + arch + threads + batch + gpu + diff
    const row2 = mk('div', 'mp-gen-row');

    const portGrp = mk('div', 'mp-gen-group');
    portGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.select-port')));
    const portSel = mk('select', 'mp-gen-select');
    portSel.id = 'gen-port';
    ports.forEach(([port, cfg]) => {
      const opt = document.createElement('option');
      opt.value = safe(port);
      const proto = cfg.tls ? 'SSL' : 'TCP';
      opt.textContent = `${port} (${proto})`;
      portSel.appendChild(opt);
    });
    portGrp.appendChild(portSel);

    const modeGrp = mk('div', 'mp-gen-group');
    modeGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.mining-type')));
    const modeSel = mk('select', 'mp-gen-select');
    modeSel.id = 'gen-mode';
    [['cpu', t('start.cpu')], ['opencl', t('start.gpu-opencl')], ['cuda', t('start.gpu-cuda')]]
      .forEach(([v, l]) => {
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
    thrInp.type  = 'number';
    thrInp.id    = 'gen-threads';
    thrInp.value = '2';
    thrInp.min   = '1';
    thrInp.max   = '256';
    thrGrp.appendChild(thrInp);

    const bsGrp = mk('div', 'mp-gen-group');
    bsGrp.id = 'gen-bs-wrap';
    bsGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.batchsize')));
    const bsInp = mk('input', 'mp-gen-input');
    bsInp.type  = 'number';
    bsInp.id    = 'gen-bs';
    bsInp.value = '3484';
    bsInp.min   = '64';
    bsGrp.appendChild(bsInp);

    const gpuGrp = mk('div', 'mp-gen-group');
    gpuGrp.id = 'gen-gpu-wrap';
    gpuGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.gpu-id')));
    const gpuInp = mk('input', 'mp-gen-input');
    gpuInp.type  = 'number';
    gpuInp.id    = 'gen-gpu';
    gpuInp.value = '0';
    gpuInp.min   = '0';
    gpuGrp.appendChild(gpuInp);

    // Static difficulty override — sets password param to d=VALUE (or x if empty)
    const diffGrp = mk('div', 'mp-gen-group');
    diffGrp.appendChild(txt('label', 'mp-gen-lbl', t('start.diff')));
    const diffInp = mk('input', 'mp-gen-input');
    diffInp.type        = 'number';
    diffInp.id          = 'gen-diff';
    diffInp.placeholder = t('start.diff-placeholder');
    diffInp.min         = '0';
    diffGrp.appendChild(diffInp);

    row2.append(portGrp, modeGrp, archGrp, thrGrp, bsGrp, gpuGrp, diffGrp);

    // Command output
    const cmdRow  = mk('div', 'mp-gen-row');
    const cmdGrp  = mk('div', 'mp-gen-group grow');
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

      // Auto-fill stratum input if user hasn't typed their own value
      if (!stratumInp.dataset.manual) stratumInp.value = computed;
      const server = safe(stratumInp.value) || computed;

      const addr = safe(addrInp.value);
      if (!addr) {
        cmdBox.innerHTML = '';
        cmdBox.appendChild(txt('span', 'mp-cmd-hint', t('start.enter-address')));
        return;
      }

      const wrk  = safe(wrkInp.value);
      const mode = modeSel.value;
      const user = wrk ? `${addr}.${wrk}` : addr;

      // Password: x for default; d=VALUE for static difficulty (NOT x;d=VALUE)
      const diffVal = parseInt(diffInp.value, 10);
      const pass    = diffVal > 0 ? `d=${diffVal}` : 'x';

      let cmd;
      if (mode === 'cpu') {
        const arch = safe(archSel.value);
        const thr  = Math.max(1, parseInt(thrInp.value, 10) || 1);
        cmd = `cpuminer-${arch} -a ${algo} -o ${server} -u ${user} -p ${pass} -t ${thr}`;
      } else {
        const gpuType = mode === 'opencl' ? 'OpenCL' : 'CUDA';
        const bs   = Math.max(64, parseInt(bsInp.value, 10) || 3484);
        const gid  = Math.max(0, parseInt(gpuInp.value, 10) || 0);
        cmd = `cpuminer-sse2 -a ${algo} --use-gpu ${gpuType} -o ${server} -u ${user} -p ${pass} --gpu-batchsize ${bs} --gpu-id ${gid}`;
      }
      cmdBox.textContent = cmd;
    };

    // Mark stratum as manually edited so auto-fill stops overwriting user input
    stratumInp.addEventListener('input', () => {
      stratumInp.dataset.manual = '1';
      buildCmd();
    });

    // Port change resets stratum auto-fill (user might switch port intentionally)
    portSel.addEventListener('change', () => {
      delete stratumInp.dataset.manual;
      buildCmd();
    });

    const toggleGpu = () => {
      const gpu = modeSel.value !== 'cpu';
      archGrp.style.display = gpu ? 'none' : '';
      thrGrp.style.display  = gpu ? 'none' : '';
      bsGrp.style.display   = gpu ? '' : 'none';
      gpuGrp.style.display  = gpu ? '' : 'none';
      buildCmd();
    };

    [addrInp, wrkInp, archSel, thrInp, bsInp, gpuInp, diffInp]
      .forEach(el => el.addEventListener('input', buildCmd));
    modeSel.addEventListener('change', toggleGpu);

    copyBtn.addEventListener('click', () => {
      const cmd = cmdBox.textContent;
      if (!cmd || cmdBox.querySelector('.mp-cmd-hint')) return;
      navigator.clipboard?.writeText(cmd).then(() => {
        copyBtn.textContent = t('start.copied');
        setTimeout(() => { copyBtn.textContent = t('start.copy'); }, 1800);
      });
    });

    bsGrp.style.display  = 'none';
    gpuGrp.style.display = 'none';
    buildCmd();

    return card;
  };

  // ── MY MINER ───────────────────────────────────────────────────────────────

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
    login.appendChild(mk('div', 'mp-login-icon')).appendChild(mk('i', 'fa-solid fa-circle-user'));
    login.appendChild(txt('div', 'mp-login-title', t('myminer.title')));
    login.appendChild(txt('div', 'mp-login-sub',   t('myminer.subtitle')));
    const row = mk('div', 'mp-login-row');
    const inp = mk('input', 'mp-addr-input');
    inp.type         = 'text';
    inp.id           = 'mm-addr-input';
    inp.placeholder  = t('myminer.placeholder');
    inp.autocomplete = 'off';
    inp.spellcheck   = false;
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
    wrap.innerHTML = '';
    showLoading(wrap);
    try {
      const [mStats, mPerf] = await Promise.all([
        api.miner(S.poolId, addr).catch(() => null),
        api.minerPerf(S.poolId, addr).catch(() => null),
      ]);

      if (seq !== S.minerSeq) return;

      if (!mStats) {
        wrap.innerHTML = '';
        const err = mk('div', 'mp-error');
        err.append(mk('i', 'fa-solid fa-circle-exclamation'),
          document.createTextNode(t('myminer.not-found')));
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
        ['myminer.balance',      mStats.pendingBalance != null
          ? fmt.coin(mStats.pendingBalance, sym) : null, 'accent'],
        ['myminer.paid',         mStats.totalPaid != null ? fmt.coin(mStats.totalPaid, sym) : null],
        ['myminer.today',        mStats.todayPaid != null ? fmt.coin(mStats.todayPaid, sym) : null],
        ['myminer.last-payment', mStats.lastPayment ? fmt.time(mStats.lastPayment) : null],
        ['myminer.blocks-found', mStats.totalConfirmedBlocks != null
          ? `${mStats.totalConfirmedBlocks} confirmed / ${mStats.totalPendingBlocks ?? 0} pending` : null],
      ]);

      if (mStats.lastPayment && pp.paymentIntervalSeconds) {
        const lastMs   = new Date(mStats.lastPayment).getTime();
        const intMs    = pp.paymentIntervalSeconds * 1000;
        const nextMs   = lastMs + intMs;
        const secsLeft = Math.max(0, Math.round((nextMs - Date.now()) / 1000));
        const progress = Math.min(1, (Date.now() - lastMs) / intMs);
        const labelTxt = secsLeft > 0 ? fmt.interval(secsLeft) : t('misc.just-now');
        const row  = mk('div', 'mp-metric');
        const bar  = buildInlineBar(progress, 'mm-next-pay', labelTxt);
        row.append(txt('span', 'mp-metric-lbl', t('myminer.next-payment')), bar);
        balCard.appendChild(row);
        if (mmNextPayTick) { clearInterval(mmNextPayTick); mmNextPayTick = null; }
        if (secsLeft > 0) {
          mmNextPayTick = setInterval(() => {
            const el   = $('mm-next-pay');
            const fill = $('mm-next-pay-fill');
            if (!el) { clearInterval(mmNextPayTick); mmNextPayTick = null; return; }
            const left    = Math.max(0, Math.round((nextMs - Date.now()) / 1000));
            const elapsed = Math.min(1, (Date.now() - lastMs) / intMs);
            // Update fill width every tick so bar smoothly reaches 100% at payment time
            if (fill) fill.style.width = `${elapsed * 100}%`;
            el.textContent = left > 0 ? fmt.interval(left) : t('misc.just-now');
            if (left === 0) { clearInterval(mmNextPayTick); mmNextPayTick = null; }
          }, 1000);
        }
      }

      const liveHr = wsMinerHr(addr);
      const perfWorkers = Object.values(mStats.performance?.workers ?? {});
      const totalHr  = liveHr !== null ? liveHr
        : perfWorkers.reduce((a, w) => a + (w.hashrate ?? 0), 0);
      const totalSps = perfWorkers.reduce((a, w) => a + (w.sharesPerSecond ?? 0), 0);

      const hrCard = buildCard('card.pool', 'fa-gauge-high', [
        ['pool.hashrate',          fmt.hash(totalHr), 'accent', 'mm-live-hr'],
        ['pool.shares',            totalSps.toFixed(3)],
        ['pool.workers.online',    mStats.workersOnline  != null ? mStats.workersOnline  : null, 'ok'],
        ['pool.workers.offline',   mStats.workersOffline != null ? mStats.workersOffline : null,
          (mStats.workersOffline || 0) > 0 ? 'warn' : ''],
        // myminer.effort row added manually below as effort bar
        ['myminer.pending-shares', mStats.pendingShares != null
          ? mStats.pendingShares.toFixed(4) : null],
      ]);
      // Insert Miner Effort as effort bar after Workers Offline row
      if (mStats.minerEffort != null) {
        const effortRow = mk('div', 'mp-metric');
        effortRow.append(
          txt('span', 'mp-metric-lbl', t('myminer.effort')),
          buildEffortBar(mStats.minerEffort)
        );
        // Find the pending-shares row and insert before it
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
        ['myminer.worker', 'myminer.hashrate', 'myminer.shares'].forEach(k => {
          whrow.appendChild(txt('th', '', t(k)));
        });
        wthead.appendChild(whrow);
        wTable.appendChild(wthead);
        const wtbody = mk('tbody');
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
    const section = container ?? mk('div', 'mp-miner-section');
    if (!container) {
      section.appendChild(txt('div', 'mp-section', t('myminer.blocks')));
      wrap.appendChild(section);
    }
    const existing = section.querySelector('.mp-table-box, .mp-empty');
    // Lock height before removing so page doesn't collapse → scroll jump
    if (existing && page > 0) section.style.minHeight = `${section.offsetHeight}px`;
    if (existing) existing.remove();

    try {
      const blocks = await api.minerBlocks(S.poolId, addr, page, PAGE_SIZE);
      const sym    = S.pool?.pool?.coin?.symbol || '';
      if (!blocks?.length) {
        section.style.minHeight = '';
        section.appendChild(txt('div', 'mp-empty', t('blocks.empty')));
        return;
      }
      const box   = mk('div', 'mp-table-box');
      const table = mk('table', 'mp-table');
      const thead = mk('thead');
      const hrow  = mk('tr');
      ['blocks.height', 'blocks.time', 'blocks.reward', 'blocks.effort', 'blocks.status']
        .forEach(k => hrow.appendChild(txt('th', '', t(k))));
      thead.appendChild(hrow);
      table.appendChild(thead);
      const tbody = mk('tbody');
      blocks.forEach(b => tbody.appendChild(buildBlockRow(b, sym, false)));
      table.appendChild(tbody);
      box.appendChild(table);
      box.appendChild(buildPager(page, blocks.length,
        pg => renderMinerBlocks(wrap, addr, pg, section)));
      section.appendChild(box);
      section.style.minHeight = '';
    } catch (err) { section.style.minHeight = ''; console.error('renderMinerBlocks error', err); }
  };

  const renderMinerPayments = async (wrap, addr, page, container) => {
    const section = container ?? mk('div', 'mp-miner-section');
    if (!container) {
      section.appendChild(txt('div', 'mp-section', t('myminer.payments')));
      wrap.appendChild(section);
    }
    const existing = section.querySelector('.mp-table-box, .mp-empty');
    // Lock height before removing so page doesn't collapse → scroll jump
    if (existing && page > 0) section.style.minHeight = `${section.offsetHeight}px`;
    if (existing) existing.remove();

    try {
      const payments = await api.minerPayments(S.poolId, addr, page, PAGE_SIZE);
      const sym      = S.pool?.pool?.coin?.symbol || '';
      if (!payments?.length) {
        section.style.minHeight = '';
        section.appendChild(txt('div', 'mp-empty', t('myminer.no-payments')));
        return;
      }
      const box   = mk('div', 'mp-table-box');
      const table = mk('table', 'mp-table');
      const thead = mk('thead');
      const hrow  = mk('tr');
      ['myminer.pay-time', 'myminer.pay-amount', 'myminer.pay-tx'].forEach(k => {
        hrow.appendChild(txt('th', '', t(k)));
      });
      thead.appendChild(hrow);
      table.appendChild(thead);
      const tbody = mk('tbody');
      payments.forEach(pay => {
        const row = mk('tr');
        const timeTd = mk('td', 'mono');
        timeTd.textContent = fmt.time(pay.created);
        timeTd.title = fmt.absTime(pay.created);
        row.appendChild(timeTd);
        row.appendChild(txt('td', 'mono', fmt.coin(pay.amount, sym)));
        const txTd = mk('td', 'mono');
        if (pay.transactionInfoLink && pay.transactionConfirmationData) {
          const a = mk('a');
          a.href = safe(pay.transactionInfoLink);
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = fmt.addr(pay.transactionConfirmationData, 10);
          txTd.appendChild(a);
        } else {
          txTd.textContent = pay.transactionConfirmationData
            ? fmt.addr(pay.transactionConfirmationData, 10) : '--';
        }
        row.appendChild(txTd);
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      box.appendChild(table);
      box.appendChild(buildPager(page, payments.length,
        pg => renderMinerPayments(wrap, addr, pg, section)));
      section.appendChild(box);
      section.style.minHeight = '';
    } catch (err) { section.style.minHeight = ''; console.error('renderMinerPayments error', err); }
  };

  const makeForgetBtn = (wrap) => {
    const fb = txt('button', 'mp-forget-btn', t('myminer.forget'));
    fb.addEventListener('click', () => {
      localStorage.removeItem(LS_MINER + S.poolId);
      renderMinerLogin(wrap);
    });
    return fb;
  };

  const appendForgetBtn = (wrap) => {
    const div = mk('div', 'mp-forget-wrap');
    div.appendChild(makeForgetBtn(wrap));
    wrap.appendChild(div);
  };

  // ── SHARED UI HELPERS ──────────────────────────────────────────────────────

  const buildPager = (page, count, onPage) => {
    const pg   = mk('div', 'mp-pager');
    const info = txt('span', 'mp-pager-info', `${t('page.current')} ${page + 1}`);
    const btns = mk('div', 'mp-pager-btns');
    const prev = txt('button', 'mp-pager-btn', t('page.prev'));
    const next = txt('button', 'mp-pager-btn', t('page.next'));
    prev.type     = 'button';
    next.type     = 'button';
    prev.disabled = page === 0;
    next.disabled = count < PAGE_SIZE;

    // Prevent rapid double-clicks / race-condition 429 errors.
    // Once a navigation starts, lock both buttons until the new pager renders.
    let navigating = false;
    const navigate = (targetPage) => {
      if (navigating) return;
      navigating = true;
      prev.disabled = true;
      next.disabled = true;
      // Preserve scroll position so the page doesn't jump to top on content swap
      const savedScrollY = window.scrollY;
      Promise.resolve(onPage(targetPage)).finally(() => {
        // If onPage replaces the DOM the buttons are gone — nothing to re-enable.
        // The finally restores scroll in case the caller didn't.
        requestAnimationFrame(() => window.scrollTo({ top: savedScrollY, behavior: 'instant' }));
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

  // ── INIT ───────────────────────────────────────────────────────────────────

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
        // Re-render active tab so all dynamic content switches language
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
      wsDisconnect();
      wsConnect();
      loadPools();
    });

    document.querySelectorAll('.mp-tab').forEach(btn => {
      btn.addEventListener('shown.bs.tab', () => {
        const target = btn.getAttribute('data-bs-target') || '';
        S.activeTab = target.replace('#pane-', '');
        renderActiveTab();
      });
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (S.theme === 'auto') applyTheme();
    });

    wsConnect();
    loadPools();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
