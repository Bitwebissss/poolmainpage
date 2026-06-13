/* docs.js -- Miningcore API Documentation
   Pure vanilla JS, IIFE, no innerHTML with user data, no eval */

(function () {
  'use strict';

  /* -- CONFIG ------------------------------------------------- */
  const LS_POOL = 'mc-pool';

  const cfg = {
    baseUrl: localStorage.getItem('mc_base_url') || 'https://pooltest.bitwebcore.net',
    poolId:  localStorage.getItem(LS_POOL)       || '',
  };

  /* -- THEME ---------------------------------------------------
     Handled by shared assets/js/theme.js (window.Theme).
     This page only reacts to the 'themechange' event to update
     its icon/label (see bindEvents / themeOnChange below). */

  const THEME_ICONS  = { light: 'fa-regular fa-sun', dark: 'fa-regular fa-moon', auto: 'fa-solid fa-circle-half-stroke' };
  const THEME_LABELS = { light: 'Light', dark: 'Dark', auto: 'Auto' };

  function applyThemeLabels(t) {
    const iconEl  = document.getElementById('theme-icon');
    const labelEl = document.getElementById('theme-label');
    if (iconEl)  iconEl.className = THEME_ICONS[t] || THEME_ICONS.auto;
    if (labelEl) labelEl.textContent = THEME_LABELS[t] || THEME_LABELS.auto;
  }

  /* -- HELPERS ------------------------------------------------ */

  // Build URL from template + path params + query params
  function buildUrl(tpl, pathVars = {}, queryVars = {}) {
    let url = cfg.baseUrl + tpl;
    Object.entries(pathVars).forEach(([k, v]) => {
      url = url.replace('{' + k + '}', encodeURIComponent(v));
    });
    const qs = Object.entries(queryVars)
      .filter(([, v]) => v !== '' && v !== null && v !== undefined)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    return qs ? url + '?' + qs : url;
  }

  // XSS-safe JSON syntax highlighter
  function highlightJson(raw) {
    const escaped = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped.replace(
      /(\"(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*\"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (m) => {
        let cls = 'json-num';
        if (/^\"/.test(m)) {
          cls = /:$/.test(m) ? 'json-key' : 'json-str';
        } else if (/true|false/.test(m)) {
          cls = 'json-bool';
        } else if (/null/.test(m)) {
          cls = 'json-null';
        }
        return '<span class="' + cls + '">' + m + '</span>';
      }
    );
  }

  // Safe text node setter
  function setText(el, text) { el.textContent = text; }
  const safe = (v) => String(v ?? '').trim();

  // Format bytes
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  /* -- API CLIENT --------------------------------------------- */
  async function apiRequest(method, url, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const t0 = performance.now();
    const res = await fetch(url, opts);
    const elapsed = Math.round(performance.now() - t0);
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, elapsed };
  }

  /* -- WEBSOCKET BASE URL NORMALIZATION ----------------------- */
  function getWsBaseUrl(rawBaseUrl) {
    const fallback = 'wss://pooltest.bitwebcore.net';
    const input = String(rawBaseUrl || '').trim();
    if (!input) return fallback;

    // Add https:// if no protocol is present
    const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(input) ? input : ('https://' + input);
    try {
      const parsed = new URL(candidate);
      // Convert http/https to ws/wss
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      else return fallback; // unsupported protocol
      return parsed.origin;
    } catch {
      return fallback;
    }
  }

  /* -- ENDPOINT DEFINITIONS ----------------------------------- */
  // param types: path | query | body
  // inputType: text | number | select
  const POOL_ENDPOINTS = [
    {
      group: 'Utility',
      items: [
        {
          id: 'healthCheck',
          method: 'GET',
          path: '/api/health-check',
          summary: 'Health check',
          desc: 'Returns 👍 if the pool API is up and reachable.',
          params: [],
        },
        {
          id: 'getHelp',
          method: 'GET',
          path: '/api/help',
          summary: 'Route list',
          desc: 'Returns a plain-text list of all registered API routes.',
          params: [],
        },
      ],
    },
    {
      group: 'Pool Stats',
      items: [
        {
          id: 'listPools',
          method: 'GET',
          path: '/api/pools-list',
          summary: 'List pools (minimal)',
          desc: 'Returns all enabled pools as a minimal list: id and coin info only. Use this to populate a pool selector. Full stats and config are at GET /api/pools/{poolId}.',
          params: [],
        },
        {
          id: 'getPool',
          method: 'GET',
          path: '/api/pools/{poolId}',
          summary: 'Pool info',
          desc: 'Returns full pool info: config, payout settings, live stats (hashrate, connected miners, shares/sec, network difficulty), block counts, last block time, last payment time, workers online/offline, and pool effort. Cached for ~60 s.',
          params: [],
        },
        {
          id: 'getPoolPerformance',
          method: 'GET',
          path: '/api/pools/{poolId}/performance',
          summary: 'Pool hashrate history',
          desc: 'Returns the last 24 hours of pool performance in hourly buckets. Each sample includes poolHashrate, connectedMiners, sharesPerSecond, networkHashrate, networkDifficulty.',
          params: [],
        },
      ],
    },
    {
      group: 'Blocks',
      items: [
        {
          id: 'getBlocks',
          method: 'GET',
          path: '/api/pools/{poolId}/blocks',
          summary: 'Pool blocks',
          desc: 'Returns the 100 most recent blocks found by this pool.\n\nResponse: Block[] — plain array.\n[ { blockHeight, hash, reward, effort, status, ... }, ... ]',
          params: [
            { name: 'state', type: 'query', inputType: 'text', placeholder: 'confirmed,pending', hint: 'Comma-separated statuses (optional)' },
          ],
        },
        {
          id: 'getBlocksV2',
          method: 'GET',
          path: '/api/v2/pools/{poolId}/blocks',
          summary: 'Pool blocks (v2 — with total count)',
          desc: 'Same 100 most recent blocks, but wrapped with metadata.\n\nResponse: { result: Block[], itemCount: N, pageCount: 1 }\nitemCount = total blocks found by this pool in DB.',
          v2: true,
          params: [
            { name: 'state', type: 'query', inputType: 'text', placeholder: 'confirmed,pending', hint: 'Comma-separated statuses (optional)' },
          ],
        },
      ],
    },
  ];

  const MINER_ENDPOINTS = [
    {
      group: 'Miner Stats',
      items: [
        {
          id: 'getMinerStats',
          method: 'GET',
          path: '/api/pools/{poolId}/miners/{address}',
          summary: 'Miner overview',
          desc: 'Returns miner stats: pending balance, total paid, pending shares, effort since last block, last payment timestamp, workers online/offline, and current per-worker hashrate snapshot.',
          params: [
            { name: 'address', type: 'path', inputType: 'text', placeholder: 'web1p...', hint: 'Miner wallet address', required: true },
          ],
        },
      ],
    },
    {
      group: 'Miner Blocks',
      items: [
        {
          id: 'getMinerBlocks',
          method: 'GET',
          path: '/api/pools/{poolId}/miners/{address}/blocks',
          summary: 'Blocks found by miner',
          desc: 'Returns the 20 most recent blocks found by this miner.\n\nResponse: Block[] — plain array.\n[ { blockHeight, hash, reward, effort, status, ... }, ... ]',
          params: [
            { name: 'address', type: 'path', inputType: 'text', placeholder: 'web1p...', hint: '', required: true },
          ],
        },
        {
          id: 'getMinerBlocksV2',
          method: 'GET',
          path: '/api/v2/pools/{poolId}/miners/{address}/blocks',
          summary: 'Miner blocks (v2 — with total count)',
          v2: true,
          desc: 'Same 20 most recent blocks, but wrapped with metadata.\n\nResponse: { result: Block[], itemCount: N, pageCount: 1 }\nitemCount = total blocks found by this miner in DB.',
          params: [
            { name: 'address', type: 'path', inputType: 'text', placeholder: 'web1p...', hint: '', required: true },
          ],
        },
      ],
    },
    {
      group: 'Miner Payments',
      items: [
        {
          id: 'getMinerPayments',
          method: 'GET',
          path: '/api/pools/{poolId}/miners/{address}/payments',
          summary: 'Miner payment history',
          desc: 'Returns the 20 most recent payments for this miner with tx hash and explorer link.\n\nResponse: Payment[] — plain array.\n[ { address, amount, transactionConfirmationData, ... }, ... ]',
          params: [
            { name: 'address',  type: 'path',  inputType: 'text',   placeholder: 'web1p...', hint: '', required: true },
          ],
        },
        {
          id: 'getMinerPaymentsV2',
          method: 'GET',
          path: '/api/v2/pools/{poolId}/miners/{address}/payments',
          summary: 'Miner payments (v2 — with total count)',
          v2: true,
          desc: 'Same 20 most recent payments, but wrapped with metadata.\n\nResponse: { result: Payment[], itemCount: N, pageCount: 1 }\nitemCount = total payments in DB (useful to show "last 20 of 47").',
          params: [
            { name: 'address',  type: 'path',  inputType: 'text',   placeholder: 'web1p...', hint: '', required: true },
          ],
        },
      ],
    },
    {
      group: 'Miner Settings',
      items: [
        {
          id: 'getMinerSettings',
          method: 'GET',
          path: '/api/pools/{poolId}/miners/{address}/settings',
          summary: 'Get miner settings',
          desc: 'Returns the miner\'s current payment threshold setting.',
          params: [
            { name: 'address', type: 'path', inputType: 'text', placeholder: 'web1p...', hint: '', required: true },
          ],
        },
        {
          id: 'setMinerSettings',
          method: 'POST',
          path: '/api/pools/{poolId}/miners/{address}/settings',
          summary: 'Update miner settings',
          desc: 'Update payment threshold. Authenticate with the mpass= password set in your stratum connection. The password is verified against your last 100 shares -- no token auth needed.',
          note: 'Auth: pass the same mpass= value you use in your stratum password field (e.g. -p mpass=abc123 or -p d=5000;mpass=abc123). The password rotates after 100 new shares with a different value.',
          params: [
            { name: 'address',          type: 'path', inputType: 'text',   placeholder: 'web1p...', hint: '', required: true },
            { name: 'password',         type: 'body', inputType: 'text',   placeholder: 'abc123',   hint: 'Your mpass= value from stratum (e.g. -p mpass=abc123)', required: true },
            { name: 'paymentThreshold', type: 'body', inputType: 'number', placeholder: '0.01',     hint: 'Min payout amount (must be >= pool minimum)', required: true },
          ],
          buildBody: (vars) => ({
            password: vars.password || '',
            settings: { paymentThreshold: parseFloat(vars.paymentThreshold) || 0 }
          }),
        },
      ],
    },
  ];

  /* -- RENDER HELPERS ----------------------------------------- */

  function makeBadge(method) {
    const span = document.createElement('span');
    span.className = 'ep-method ep-method-' + method.toLowerCase();
    setText(span, method);
    return span;
  }

  function makePathEl(path) {
    const code = document.createElement('code');
    code.className = 'ep-path';
    path.split(/({[^}]+})/).forEach((seg) => {
      if (/^{/.test(seg)) {
        const s = document.createElement('span');
        s.className = 'ep-path-param';
        setText(s, seg);
        code.appendChild(s);
      } else {
        code.appendChild(document.createTextNode(seg));
      }
    });
    return code;
  }

  function makeParamRow(param) {
    const row = document.createElement('div');
    row.className = 'ep-param-row';

    const label = document.createElement('span');
    label.className = 'ep-param-label';
    setText(label, param.name);
    const badge = document.createElement('span');
    badge.className = param.required ? 'ep-param-req' : 'ep-param-opt';
    setText(badge, param.required ? '*' : param.type);
    label.appendChild(badge);
    row.appendChild(label);

    let input;
    if (param.inputType === 'select') {
      input = document.createElement('select');
      input.className = 'ep-param-input';
      (param.options || []).forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt.value;
        setText(o, opt.label);
        input.appendChild(o);
      });
    } else {
      input = document.createElement('input');
      input.type = param.inputType === 'number' ? 'number' : 'text';
      input.className = 'ep-param-input';
      input.placeholder = param.placeholder || '';
      input.spellcheck = false;
      input.autocomplete = 'off';
    }
    input.dataset.param = param.name;
    input.dataset.paramType = param.type;
    row.appendChild(input);

    if (param.hint) {
      const hint = document.createElement('span');
      hint.className = 'ep-param-hint';
      setText(hint, param.hint);
      row.appendChild(hint);
    }

    return row;
  }

  function makeCard(ep) {
    const card = document.createElement('div');
    card.className = 'ep-card';
    card.dataset.id = ep.id;

    const hdr = document.createElement('div');
    hdr.className = 'ep-header';
    hdr.setAttribute('role', 'button');
    hdr.setAttribute('aria-expanded', 'false');
    hdr.appendChild(makeBadge(ep.method));
    hdr.appendChild(makePathEl(ep.path));
    if (ep.v2) {
      const v2 = document.createElement('span');
      v2.className = 'ep-v2-badge';
      setText(v2, 'v2');
      hdr.appendChild(v2);
    }
    const sum = document.createElement('span');
    sum.className = 'ep-summary';
    setText(sum, ep.summary);
    hdr.appendChild(sum);
    const chev = document.createElement('i');
    chev.className = 'fa-solid fa-chevron-down ep-chevron';
    hdr.appendChild(chev);
    card.appendChild(hdr);

    const body = document.createElement('div');
    body.className = 'ep-body';

    if (ep.desc) {
      const desc = document.createElement('p');
      desc.className = 'ep-desc mb-3';
      setText(desc, ep.desc);
      body.appendChild(desc);
    }

    if (ep.note) {
      const note = document.createElement('div');
      note.className = 'mc-note';
      const ni = document.createElement('i');
      ni.className = 'fa-solid fa-circle-info';
      note.appendChild(ni);
      const nt = document.createElement('span');
      setText(nt, ep.note);
      note.appendChild(nt);
      body.appendChild(note);
    }

    if (ep.params.length) {
      const ps = document.createElement('div');
      ps.className = 'ep-params';
      const pt = document.createElement('div');
      pt.className = 'ep-params-title';
      setText(pt, 'Parameters');
      ps.appendChild(pt);
      ep.params.forEach((p) => ps.appendChild(makeParamRow(p)));
      body.appendChild(ps);
    }

    const runRow = document.createElement('div');
    runRow.className = 'ep-run-row';
    const runBtn = document.createElement('button');
    runBtn.className = 'ep-run-btn';
    runBtn.type = 'button';
    runBtn.dataset.epId = ep.id;
    const ri = document.createElement('i');
    ri.className = 'fa-solid fa-play';
    runBtn.appendChild(ri);
    const rt = document.createTextNode(' Run');
    runBtn.appendChild(rt);
    runRow.appendChild(runBtn);
    const urlPreview = document.createElement('span');
    urlPreview.className = 'ep-run-url';
    urlPreview.dataset.urlPreview = ep.id;
    runRow.appendChild(urlPreview);
    body.appendChild(runRow);

    const resp = document.createElement('div');
    resp.className = 'ep-response';
    resp.dataset.respArea = ep.id;
    const meta = document.createElement('div');
    meta.className = 'ep-response-meta';
    meta.dataset.respMeta = ep.id;
    resp.appendChild(meta);
    const pre = document.createElement('pre');
    pre.className = 'ep-response-body';
    pre.dataset.respBody = ep.id;
    resp.appendChild(pre);
    body.appendChild(resp);

    card.appendChild(body);
    return card;
  }

  function renderGroup(group) {
    const wrap = document.createElement('div');
    wrap.className = 'ep-group';
    const title = document.createElement('div');
    title.className = 'ep-group-title';
    setText(title, group.group);
    wrap.appendChild(title);
    group.items.forEach((ep) => wrap.appendChild(makeCard(ep)));
    return wrap;
  }

  function renderEndpoints() {
    const poolEl  = document.getElementById('endpoints-pool');
    const minerEl = document.getElementById('endpoints-miner');
    let poolCount = 0, minerCount = 0;

    POOL_ENDPOINTS.forEach((g) => {
      poolEl.appendChild(renderGroup(g));
      poolCount += g.items.length;
    });
    MINER_ENDPOINTS.forEach((g) => {
      minerEl.appendChild(renderGroup(g));
      minerCount += g.items.length;
    });

    const pc = document.getElementById('count-pool');
    const mc = document.getElementById('count-miner');
    if (pc) setText(pc, poolCount);
    if (mc) setText(mc, minerCount);
  }

  /* -- WEBSOCKET SECTION -------------------------------------- */
  let wsConn = null;

  const WS_EVENTS = [
    {
      name: 'greeting',
      icon: '👋',
      desc: 'Sent on connect. Confirms relay is active.',
      fields: 'message',
    },
    {
      name: 'blockunlockprogress',
      icon: '🔄',
      desc: 'Confirmation progress update for a pending (immature) block. Sent on every classifier cycle until the block is fully confirmed or orphaned.',
      fields: 'poolId, blockHeight, symbol, name, progress (0..1), effort?, reward, miner, created',
    },
    {
      name: 'payment',
      icon: '💸',
      desc: 'A payment batch was processed and sent.',
      fields: 'poolId, symbol, amount, recipientsCount, txIds[], txExplorerLinks[], txFee?, totalPaid?, error',
    },
    {
      name: 'chainheightstats',
      icon: '📡',
      desc: 'Network stats snapshot sent on every new chain height. Carries block counters, network metrics and the last known block reward.',
      fields: 'poolId, networkHashrate, networkDifficulty?, blockHeight, networkBlockHeight, lastNetworkBlockTime?, totalConfirmedBlocks?, totalPendingBlocks?, totalOrphanedBlocks?, blockReward',
    },
    {
      name: 'blockfoundstats',
      icon: '🏆',
      desc: 'Extended stats snapshot sent when the pool finds a block. Same as chainheightstats plus pool block counters and the reward of the newly found block.',
      fields: 'poolId, networkHashrate, networkDifficulty?, blockHeight, networkBlockHeight, lastNetworkBlockTime?, lastPoolBlockTime?, blocks24h?, totalBlocks?, totalConfirmedBlocks?, totalPendingBlocks?, totalOrphanedBlocks?, blockReward',
    },
    {
      name: 'cyclestats',
      icon: '📊',
      desc: 'Pool performance snapshot sent on every stats cycle (≈ every 2 min). Use this for live pool hashrate and miner count displays.',
      fields: 'poolId, poolHashrate, connectedMiners, sharesPerSecond, connectedPeers?, poolEffort?',
    },
  ];

  function renderWsSection() {
    const el = document.getElementById('ws-section');

    const info = document.createElement('div');
    info.className = 'ws-card';
    const t = document.createElement('div');
    t.className = 'ws-card-title';
    const ti = document.createElement('i');
    ti.className = 'fa-solid fa-bolt';
    t.appendChild(ti);
    const tt = document.createTextNode(' WebSocket Notifications');
    t.appendChild(tt);
    info.appendChild(t);
    const d = document.createElement('p');
    d.className = 'ws-desc';
    setText(d, 'The pool exposes a raw WebSocket relay at /notifications?poolId={poolId}. Events are JSON messages with a "type" field matching the event names below (all lowercase). No socket.io protocol is used -- connect with native WebSocket.');
    info.appendChild(d);

    const note = document.createElement('div');
    note.className = 'mc-note';
    const ni = document.createElement('i');
    ni.className = 'fa-solid fa-circle-info';
    note.appendChild(ni);
    const nt = document.createElement('span');
    const wsNoteUrl = getWsUrl();
    setText(nt, 'Native WebSocket only -- not socket.io. poolId is required. Connect to: ' + wsNoteUrl);
    note.appendChild(nt);
    info.appendChild(note);

    const urlRow = document.createElement('div');
    urlRow.className = 'ws-url-row';
    const ul = document.createElement('span');
    ul.className = 'ws-url-label';
    setText(ul, 'Endpoint');
    urlRow.appendChild(ul);
    const uv = document.createElement('code');
    uv.className = 'ws-url-value';
    uv.id = 'ws-url-display';
    updateWsUrlDisplay(uv);
    urlRow.appendChild(uv);
    info.appendChild(urlRow);

    const ctrlRow = document.createElement('div');
    ctrlRow.className = 'd-flex align-items-center gap-3 mb-3 flex-wrap';
    const connBtn = document.createElement('button');
    connBtn.className = 'ws-btn ws-btn-connect';
    connBtn.type = 'button';
    connBtn.id = 'ws-connect';
    setText(connBtn, 'Connect');
    const discBtn = document.createElement('button');
    discBtn.className = 'ws-btn ws-btn-disconnect';
    discBtn.type = 'button';
    discBtn.id = 'ws-disconnect';
    discBtn.disabled = true;
    setText(discBtn, 'Disconnect');
    const statusEl = document.createElement('span');
    statusEl.className = 'ws-status';
    statusEl.id = 'ws-status';
    const dot = document.createElement('span');
    dot.className = 'ws-dot';
    statusEl.appendChild(dot);
    const stxt = document.createTextNode('Disconnected');
    statusEl.appendChild(stxt);
    ctrlRow.appendChild(connBtn);
    ctrlRow.appendChild(discBtn);
    ctrlRow.appendChild(statusEl);
    info.appendChild(ctrlRow);

    const logLabel = document.createElement('div');
    logLabel.className = 'ep-params-title mb-1';
    setText(logLabel, 'Event log');
    info.appendChild(logLabel);
    const log = document.createElement('div');
    log.className = 'ws-log';
    log.id = 'ws-log';
    const empty = document.createElement('span');
    empty.dataset.placeholder = 'true';
    setText(empty, 'Connect to start receiving events...');
    log.appendChild(empty);
    info.appendChild(log);

    el.appendChild(info);

    const evCard = document.createElement('div');
    evCard.className = 'ws-card';
    const et = document.createElement('div');
    et.className = 'ws-card-title';
    const eti = document.createElement('i');
    eti.className = 'fa-solid fa-list';
    et.appendChild(eti);
    et.appendChild(document.createTextNode(' Event Reference'));
    evCard.appendChild(et);
    const ed = document.createElement('p');
    ed.className = 'ws-desc';
    setText(ed, 'Each WebSocket message is a JSON object: { "type": "eventname", ... }. The type field is always lowercase. Fields marked ? are nullable.');
    evCard.appendChild(ed);

    const grid = document.createElement('div');
    grid.className = 'ws-events-grid';
    WS_EVENTS.forEach((ev) => {
      const chip = document.createElement('div');
      chip.className = 'ws-event-chip';
      const ico = document.createElement('span');
      ico.className = 'ws-event-icon';
      setText(ico, ev.icon);
      chip.appendChild(ico);
      const info2 = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'ws-event-name';
      setText(name, ev.name);
      const desc2 = document.createElement('div');
      desc2.className = 'ws-event-desc';
      setText(desc2, ev.desc);
      info2.appendChild(name);
      info2.appendChild(desc2);
      if (ev.fields) {
        const fields = document.createElement('div');
        fields.className = 'ws-event-fields';
        setText(fields, ev.fields);
        info2.appendChild(fields);
      }
      chip.appendChild(info2);
      grid.appendChild(chip);
    });
    evCard.appendChild(grid);
    el.appendChild(evCard);

    const codeCard = document.createElement('div');
    codeCard.className = 'ws-card';
    const ct2 = document.createElement('div');
    ct2.className = 'ws-card-title';
    const cti = document.createElement('i');
    cti.className = 'fa-solid fa-code';
    ct2.appendChild(cti);
    ct2.appendChild(document.createTextNode(' JavaScript Example'));
    codeCard.appendChild(ct2);
    const pre = document.createElement('pre');
    pre.className = 'ep-example';
    const codeEx =
`const ws = new WebSocket('ws://pooltest.bitwebcore.net/notifications?poolId=bte1');

ws.onopen = () => console.log('connected');

ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  switch (msg.type) {

    case 'cyclestats':
      // Sent every ~2 min -- use for live pool hashrate / miner count.
      // msg.poolId, msg.poolHashrate, msg.connectedMiners, msg.sharesPerSecond
      // msg.connectedPeers (nullable), msg.poolEffort (nullable)
      console.log('Pool stats', msg.poolId, msg.poolHashrate, 'effort:', msg.poolEffort);
      break;

    case 'chainheightstats':
      // Sent on every new network block -- network metrics snapshot.
      // msg.poolId, msg.networkHashrate, msg.networkDifficulty (nullable)
      // msg.blockHeight, msg.networkBlockHeight, msg.lastNetworkBlockTime (nullable)
      // msg.totalConfirmedBlocks (nullable), msg.totalPendingBlocks (nullable)
      // msg.totalOrphanedBlocks (nullable), msg.blockReward
      console.log('Chain height', msg.poolId, msg.blockHeight, 'reward:', msg.blockReward);
      break;

    case 'blockfoundstats':
      // Extended stats snapshot sent when the pool finds a block -- pool block counters.
      // msg.poolId, msg.networkHashrate, msg.networkDifficulty (nullable)
      // msg.blockHeight, msg.networkBlockHeight, msg.lastNetworkBlockTime (nullable)
      // msg.lastPoolBlockTime (nullable), msg.blocks24h (nullable)
      // msg.totalBlocks (nullable), msg.totalConfirmedBlocks (nullable)
      // msg.totalPendingBlocks (nullable), msg.totalOrphanedBlocks (nullable)
      // msg.blockReward -- reward of the newly found block (read from DB after classification)
      console.log('Block found', msg.blockHeight, 'reward:', msg.blockReward, 'total confirmed:', msg.totalConfirmedBlocks);
      break;

    case 'blockunlockprogress':
      // Confirmation progress for a pending (immature) block.
      // Sent on every classifier cycle until the block is confirmed or orphaned.
      // msg.poolId, msg.blockHeight, msg.symbol, msg.name
      // msg.progress (0..1), msg.effort (nullable)
      // msg.reward -- real reward from node, msg.miner, msg.created
      console.log('Confirm progress', msg.blockHeight, (msg.progress * 100).toFixed(1) + '%', 'reward:', msg.reward);
      break;

    case 'payment':
      // A payment batch was sent.
      // msg.poolId, msg.symbol, msg.amount, msg.recipientsCount
      // msg.txIds[], msg.txExplorerLinks[], msg.txFee (nullable)
      // msg.totalPaid (nullable), msg.error (null on success)
      console.log('Payment sent', msg.poolId, msg.amount, 'total ever paid:', msg.totalPaid);
      break;
  }
};

ws.onclose = () => console.log('disconnected');`;
    setText(pre, codeEx);
    codeCard.appendChild(pre);
    el.appendChild(codeCard);
  }

  function getWsUrl() {
    const base = getWsBaseUrl(cfg.baseUrl);
    return base + '/notifications?poolId=' + encodeURIComponent(cfg.poolId || '');
  }

  function updateWsUrlDisplay(el) {
    setText(el || document.getElementById('ws-url-display'), getWsUrl());
  }

  /* -- WS EVENT HANDLERS -------------------------------------- */
  function wsConnect() {
    if (!cfg.poolId) {
      wsSetStatus('error', 'Select pool');
      wsLogEntry('sys', 'Select a pool before connecting');
      return;
    }

    const url = getWsUrl();
    try {
      wsConn = new WebSocket(url);
      wsLogEntry('sys', 'Connecting to ' + url + '...');
      wsSetStatus('connecting', 'Connecting…');

      wsConn.onopen = () => {
        wsSetStatus('connected', 'Connected');
        wsLogEntry('sys', 'Connection established');
        document.getElementById('ws-connect').disabled = true;
        document.getElementById('ws-disconnect').disabled = false;
      };

      wsConn.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          wsLogEntry('in', JSON.stringify(msg, null, 2));
        } catch {
          wsLogEntry('in', e.data);
        }
      };

      wsConn.onerror = () => {
        wsSetStatus('error', 'Error');
        wsLogEntry('sys', 'Connection error');
      };

      wsConn.onclose = (e) => {
        wsSetStatus('', 'Disconnected');
        wsLogEntry('sys', 'Disconnected (code ' + e.code + ')');
        document.getElementById('ws-connect').disabled = false;
        document.getElementById('ws-disconnect').disabled = true;
        wsConn = null;
      };
    } catch (err) {
      wsLogEntry('sys', 'Failed: ' + err.message);
    }
  }

  function wsDisconnect() {
    if (wsConn) {
      wsConn.close();
    }
  }

  function wsSetStatus(cls, text) {
    const el = document.getElementById('ws-status');
    if (!el) return;
    el.className = 'ws-status ' + cls;
    const dot = el.querySelector('.ws-dot');
    if (!dot) return;
    el.textContent = '';
    el.appendChild(dot);
    el.appendChild(document.createTextNode(' ' + text));
  }

  function wsLogEntry(type, msg) {
    const log = document.getElementById('ws-log');
    if (!log) return;
    // Remove placeholder if present
    if (log.childElementCount === 1 && log.firstElementChild?.dataset?.placeholder === 'true') {
      log.firstElementChild.remove();
    }

    const now = new Date().toTimeString().slice(0, 8);
    const row = document.createElement('div');
    row.className = 'ws-log-entry';

    const t = document.createElement('span');
    t.className = 'ws-log-time';
    setText(t, now);

    const tp = document.createElement('span');
    tp.className = 'ws-log-type ws-log-type-' + type;
    setText(tp, type === 'in' ? '←' : type === 'out' ? '→' : '·');

    const m = document.createElement('span');
    m.className = 'ws-log-msg';
    setText(m, msg);

    row.appendChild(t);
    row.appendChild(tp);
    row.appendChild(m);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  /* -- URL PREVIEW -------------------------------------------- */
  function resolveEndpoint(ep, card) {
    const pathVars = {}, queryVars = {}, bodyVars = {};
    pathVars.poolId = cfg.poolId;

    card.querySelectorAll('[data-param]').forEach((input) => {
      const name = input.dataset.param;
      const type = input.dataset.paramType;
      const val  = input.value.trim();
      if (!val) return;
      if (type === 'path')  pathVars[name]  = val;
      if (type === 'query') queryVars[name] = val;
      if (type === 'body')  bodyVars[name]  = val;
    });

    const url = buildUrl(ep.path, pathVars, queryVars);
    return { url, bodyVars };
  }

  function updatePreview(ep, card) {
    const preview = card.querySelector('[data-url-preview]');
    if (!preview) return;
    try {
      const { url } = resolveEndpoint(ep, card);
      setText(preview, url);
    } catch {}
  }

  /* -- RUN REQUEST -------------------------------------------- */
  async function runEndpoint(epId) {
    const allEps = [...POOL_ENDPOINTS, ...MINER_ENDPOINTS].flatMap((g) => g.items);
    const ep = allEps.find((e) => e.id === epId);
    if (!ep) return;
    if (!cfg.baseUrl) { alert('Set Base URL first.'); return; }

    const card   = document.querySelector('[data-id="' + epId + '"]');
    const runBtn = card.querySelector('[data-ep-id="' + epId + '"]');
    const respEl = card.querySelector('[data-resp-area="' + epId + '"]');
    const metaEl = card.querySelector('[data-resp-meta="' + epId + '"]');
    const bodyEl = card.querySelector('[data-resp-body="' + epId + '"]');

    const { url, bodyVars } = resolveEndpoint(ep, card);

    runBtn.disabled = true;
    // Clear button content safely
    while (runBtn.firstChild) runBtn.removeChild(runBtn.firstChild);
    const sp = document.createElement('span');
    sp.className = 'ep-spinner';
    runBtn.appendChild(sp);
    runBtn.appendChild(document.createTextNode(' Running…'));

    let body = null;
    if (ep.method === 'POST' && Object.keys(bodyVars).length) {
      if (typeof ep.buildBody === 'function') {
        body = ep.buildBody(bodyVars);
      } else {
        body = { ...bodyVars };
        if (bodyVars.paymentThreshold !== undefined) {
          body.paymentThreshold = parseFloat(bodyVars.paymentThreshold) || 0;
        }
      }
    }

    try {
      const res = await apiRequest(ep.method, url, body);

      metaEl.replaceChildren();
      const statusSpan = document.createElement('span');
      statusSpan.className = res.ok ? 'ep-status-ok' : 'ep-status-err';
      setText(statusSpan, res.status + (res.ok ? ' OK' : ' Error'));
      const timeSpan = document.createElement('span');
      timeSpan.className = 'ep-resp-time';
      setText(timeSpan, res.elapsed + ' ms');
      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'ep-resp-size';
      setText(sizeSpan, fmtBytes(new Blob([res.text]).size));
      metaEl.appendChild(statusSpan);
      metaEl.appendChild(timeSpan);
      metaEl.appendChild(sizeSpan);

      try {
        const json = JSON.parse(res.text);
        const pretty = JSON.stringify(json, null, 2);
        bodyEl.innerHTML = highlightJson(pretty);
      } catch {
        bodyEl.textContent = res.text;
      }

      respEl.classList.add('visible');
    } catch (err) {
      metaEl.replaceChildren();
      const errSpan = document.createElement('span');
      errSpan.className = 'ep-status-err';
      setText(errSpan, 'Network error: ' + err.message);
      metaEl.appendChild(errSpan);
      bodyEl.textContent = '';
      respEl.classList.add('visible');
    } finally {
      runBtn.disabled = false;
      // Clear button content safely
      while (runBtn.firstChild) runBtn.removeChild(runBtn.firstChild);
      const ic = document.createElement('i');
      ic.className = 'fa-solid fa-play';
      runBtn.appendChild(ic);
      runBtn.appendChild(document.createTextNode(' Run'));
    }
  }

  /* -- POOL SELECTOR (ported from pool.js dropdown logic) ------ */
  async function loadPools() {
    if (!cfg.baseUrl) return;
    try {
      const res = await apiRequest('GET', cfg.baseUrl + '/api/pools-list', null);
      if (!res.ok) return;
      const data  = JSON.parse(res.text);
      const pools = data.pools || [];

      const menu = document.getElementById('pool-menu');
      const lbl  = document.getElementById('pool-label');
      if (!menu) return;
      menu.replaceChildren();

      const setActive = (id, text) => {
        if (lbl) lbl.textContent = text;
        menu.querySelectorAll('.dropdown-item').forEach((b) => {
          b.classList.toggle('active', b.dataset.poolId === id);
        });
      };

      pools.forEach((p) => {
        const li  = document.createElement('li');
        const btn = document.createElement('button');
        btn.className = 'dropdown-item';
        btn.type = 'button';
        btn.dataset.poolId = safe(p.id);

        const label = `${safe(p.coin?.name || p.coin?.symbol || p.id)} (${safe(p.id)})`;

        if (p.coin?.symbol) {
          const img = document.createElement('img');
          img.className = 'mp-pool-coin-img';
          img.alt = safe(p.coin.symbol);
          img.src = `assets/images/${safe(p.coin.symbol).toLowerCase()}.svg`;
          img.onerror = () => img.remove();
          btn.appendChild(img);
        }
        btn.appendChild(document.createTextNode(label));
        btn.addEventListener('click', () => {
          if (btn.dataset.poolId === cfg.poolId) return;
          setActive(btn.dataset.poolId, label);
          selectPool(btn.dataset.poolId);
        });
        li.appendChild(btn);
        menu.appendChild(li);
      });

      const saved = cfg.poolId;
      if (saved && pools.find((p) => p.id === saved)) {
        const savedBtn = [...menu.querySelectorAll('.dropdown-item')].find((b) => b.dataset.poolId === saved);
        if (savedBtn) setActive(saved, savedBtn.textContent);
        selectPool(saved, /* skipRefresh */ true);
      } else if (pools.length >= 1) {
        const firstBtn = menu.querySelector('.dropdown-item');
        if (firstBtn) setActive(pools[0].id, firstBtn.textContent);
        selectPool(pools[0].id, /* skipRefresh */ true);
      }
    } catch {}
  }

  // Apply a newly selected pool id: persist, refresh WS URL display and
  // any already-rendered request previews that reference {poolId}.
  function selectPool(id, skipRefresh) {
    cfg.poolId = id;
    localStorage.setItem(LS_POOL, id);
    if (skipRefresh) return;
    updateWsUrlDisplay();
    refreshOpenPreviews();
  }

  // Re-run updatePreview() for every endpoint card that is currently open,
  // so a pool change is reflected immediately in the URL preview.
  function refreshOpenPreviews() {
    const allEps = [...POOL_ENDPOINTS, ...MINER_ENDPOINTS].flatMap((g) => g.items);
    document.querySelectorAll('.ep-card.open[data-id]').forEach((card) => {
      const ep = allEps.find((x) => x.id === card.dataset.id);
      if (ep) updatePreview(ep, card);
    });
  }

  /* -- EVENT BINDING ------------------------------------------ */
  function bindEvents() {
    document.querySelectorAll('[data-theme]').forEach((btn) => {
      btn.addEventListener('click', () => Theme.set(btn.dataset.theme));
    });

    document.addEventListener('themechange', (e) => applyThemeLabels(e.detail.theme));

    document.getElementById('apply-url')?.addEventListener('click', () => {
      const input = document.getElementById('base-url');
      cfg.baseUrl = input.value.trim().replace(/\/$/, '');
      localStorage.setItem('mc_base_url', cfg.baseUrl);
      updateWsUrlDisplay();
      loadPools();
    });

    document.addEventListener('click', (e) => {
      const hdr = e.target.closest('.ep-header');
      if (!hdr) return;
      const card = hdr.closest('.ep-card');
      if (!card) return;
      const wasOpen = card.classList.contains('open');
      card.classList.toggle('open', !wasOpen);
      hdr.setAttribute('aria-expanded', String(!wasOpen));
    });

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ep-id]');
      if (!btn) return;
      e.stopPropagation();
      runEndpoint(btn.dataset.epId);
    });

    document.addEventListener('input', (e) => {
      const input = e.target.closest('[data-param]');
      if (!input) return;
      const card = input.closest('[data-id]');
      if (!card) return;
      const epId = card.dataset.id;
      const allEps = [...POOL_ENDPOINTS, ...MINER_ENDPOINTS].flatMap((g) => g.items);
      const ep = allEps.find((x) => x.id === epId);
      if (ep) updatePreview(ep, card);
    });

    document.getElementById('ws-connect')?.addEventListener('click', wsConnect);
    document.getElementById('ws-disconnect')?.addEventListener('click', wsDisconnect);
  }

  /* -- INIT --------------------------------------------------- */
  function init() {
    renderEndpoints();
    renderWsSection();
    bindEvents();
    Theme.init();

    const urlInput = document.getElementById('base-url');
    if (urlInput) urlInput.value = cfg.baseUrl;

    if (cfg.baseUrl) loadPools();

    updateWsUrlDisplay();
  }

  document.addEventListener('DOMContentLoaded', init);

})();
