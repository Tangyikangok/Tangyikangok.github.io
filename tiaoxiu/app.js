/* ============================================================
 *  调休假查询系统 · 在线只读版
 *  数据源：同站点 data/leave-data.json（由金山文档 AirScript 定时写入）
 *  纯原生 JS，无第三方依赖
 * ============================================================ */
(function () {
  'use strict';

  const CFG = Object.assign({
    title: '调休假查询系统',
    subtitle: '',
    dataUrl: 'data/leave-data.json',
    privacyDefault: true,
    searchPlaceholder: '输入姓名查询剩余可用调休天数…',
    staleHours: 48,
    orgName: ''
  }, window.TX_CONFIG || {});

  /* ---------------- 工具函数 ---------------- */
  function coerceNum(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  function normName(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[\s　]+/g, '').toLowerCase();
  }
  function round3(n) {
    return Math.round((n || 0) * 1000) / 1000;
  }
  function fmt(n) {
    if (!isFinite(n)) return '0';
    return String(round3(n));
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function hoursSince(ts) {
    if (!ts) return Infinity;
    const d = new Date(ts);
    if (isNaN(d.getTime())) return Infinity;
    return (Date.now() - d.getTime()) / 3600000;
  }
  function toast(msg, isErr) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast'; }, 3000);
  }
  function setStatus(t) {
    document.getElementById('fileStatus').textContent = t;
  }

  /* ---------------- 状态 ---------------- */
  const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const state = { years: [], activeYearKey: null, updatedAt: null, source: '', loading: false };
  let privacyHide = CFG.privacyDefault;   // true = 只看本人（隐藏汇总/驾驶舱/全员明细）
  let viewMode = 'admin';                 // 'admin' 全员视图 | 'self' 员工本人视图
  let selfName = '';                      // 本人视图下的员工姓名
  let currentSearchKey = '';
  let tableForceShow = false;

  /* ---------------- 计算规则（与原 Excel 版完全一致） ---------------- */
  /* 规则：以「清算后(G)」为基准，累加 3~12 月的休假与调休。
     1、2 月的数据已体现在上年清算结果中，故不重复计入。 */
  function computePerson(p) {
    const G = coerceNum(p.clearingValue);
    let leaveSum = 0, tiaoSum = 0;
    for (let m = 2; m <= 11; m++) {
      const mm = p.months[m] || { leave: 0, tiao: 0 };
      leaveSum += coerceNum(mm.leave);
      tiaoSum += coerceNum(mm.tiao);
    }
    const ab = leaveSum;              // 休假合计
    const ac = G + tiaoSum;           // 调休合计（清算基数 + 本年调休）
    const af = ac - ab;               // 剩余可用
    return { ab: ab, ac: ac, af: af, G: G, leaveSum: leaveSum, tiaoSum: tiaoSum };
  }

  /* ---------------- 数据解析 ---------------- */
  function normalizeMonths(raw) {
    const out = [];
    for (let i = 0; i < 12; i++) {
      const m = raw && raw[i];
      if (m === undefined || m === null) { out.push({ leave: 0, tiao: 0 }); continue; }
      if (Array.isArray(m)) { out.push({ leave: coerceNum(m[0]), tiao: coerceNum(m[1]) }); continue; }
      out.push({
        leave: coerceNum(m.l !== undefined ? m.l : (m.leave !== undefined ? m.leave : m.holiday)),
        tiao: coerceNum(m.t !== undefined ? m.t : (m.tiao !== undefined ? m.tiao : m.offset))
      });
    }
    return out;
  }

  function hydrate(data) {
    const rawYears = Array.isArray(data && data.years) ? data.years : [];
    const years = rawYears.map(function (y) {
      const persons = (Array.isArray(y.persons) ? y.persons : []).map(function (p, i) {
        return {
          rowIndex: i,
          name: String(p.name === undefined || p.name === null ? '' : p.name).trim(),
          key: normName(p.name),
          dept: p.dept ? String(p.dept).trim() : '',
          months: normalizeMonths(p.months),
          clearingStatus: p.clearStatus ? String(p.clearStatus) : '',
          clearingValue: coerceNum(p.G !== undefined ? p.G : p.clearingValue)
        };
      }).filter(function (p) { return p.name !== ''; });

      return {
        year: isNaN(parseInt(y.year, 10)) ? String(y.year) : parseInt(y.year, 10),
        sheetName: String(y.year),
        persons: persons
      };
    }).sort(function (a, b) {
      return a.year < b.year ? -1 : (a.year > b.year ? 1 : 0);
    });

    state.years = years;
    state.updatedAt = data && data.updatedAt ? data.updatedAt : null;
    state.source = data && data.source ? String(data.source) : '';

    const stillThere = years.some(function (y) { return y.sheetName === state.activeYearKey; });
    if (!stillThere) {
      state.activeYearKey = years.length ? years[years.length - 1].sheetName : null;
    }
  }

  /* ---------------- 本地缓存（断网兜底） ---------------- */
  const CACHE_KEY = 'tiaoxiu:online:v1';
  function saveCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data: data }));
    } catch (e) { /* 超出配额时静默忽略 */ }
  }
  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      return p && p.data ? p : null;
    } catch (e) { return null; }
  }

  /* ---------------- 加密数据解锁 ---------------- */
  const CRED_KEY = 'tiaoxiu:cred';      // {n:姓名,p:密码}，仅 sessionStorage，关标签页即失效
  let pendingEncrypted = null;          // 当前待解密的数据包

  function readCred() {
    try {
      const raw = sessionStorage.getItem(CRED_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      return (c && c.n && c.p) ? c : null;
    } catch (e) { return null; }
  }

  function showLock(errMsg) {
    const lp = document.getElementById('lockPanel');
    const mb = document.getElementById('mainBody');
    if (lp) lp.style.display = 'block';
    if (mb) mb.style.display = 'none';
    const e = document.getElementById('lockErr');
    if (e) {
      e.textContent = errMsg || '';
      e.style.display = errMsg ? 'block' : 'none';
    }
    setStatus(errMsg ? '登录失败' : '请输入姓名和密码');
    const btn = document.getElementById('btnLock');
    if (btn) btn.style.display = 'none';
    if (!errMsg) {
      const ni = document.getElementById('nameInput');
      const pi = document.getElementById('pwInput');
      if (ni) setTimeout(function () { ni.focus(); }, 60);
      else if (pi) setTimeout(function () { pi.focus(); }, 60);
    }
  }

  function showBody() {
    const lp = document.getElementById('lockPanel');
    const mb = document.getElementById('mainBody');
    if (lp) lp.style.display = 'none';
    if (mb) mb.style.display = '';
    const btn = document.getElementById('btnLock');
    if (btn) btn.style.display = '';
  }

  /* v2：管理员全量解密 */
  async function applyAdmin(data, pw) {
    const plain = await TXCrypto.decryptAdmin(data, pw);
    const obj = JSON.parse(plain);
    obj.updatedAt = obj.updatedAt || data.updatedAt;
    obj.source = obj.source || '金山文档';
    viewMode = 'admin';
    selfName = '';
    hydrate(obj);
  }

  /* v2：员工本人解密，只保留当前姓名那一个人 */
  async function applySelf(data, name, pw) {
    const entry = await TXCrypto.findPerson(data, name);
    if (!entry) return false;
    const plain = await TXCrypto.decryptPerson(entry, pw, data.iter);
    const slice = JSON.parse(plain);
    const years = (slice.years || []).map(function (yr) {
      return {
        year: yr.year,
        persons: [{
          name: slice.name,
          dept: slice.dept || '',
          clearStatus: yr.clearStatus || '',
          G: yr.G,
          months: yr.months
        }]
      };
    });
    viewMode = 'self';
    selfName = slice.name;
    privacyHide = false;                    // 本人视图直接展示明细
    hydrate({ years: years, updatedAt: data.updatedAt, source: '金山文档' });
    return true;
  }

  /* v2 登录：姓名 + 密码 */
  async function unlockV2(data, cred) {
    const name = String(cred.n || '').trim();
    const pw = String(cred.p || '');
    if (!name || !pw) return false;
    if (name === (CFG.adminName || 'admin')) {
      try { await applyAdmin(data, pw); return true; } catch (e) { return false; }
    }
    return applySelf(data, name, pw);
  }

  /* v1 兼容：旧单包只认密码 */
  async function unlockV1(data, pw) {
    try {
      const plain = await TXCrypto.decrypt(data, pw);
      const obj = JSON.parse(plain);
      obj.updatedAt = obj.updatedAt || data.updatedAt;
      obj.source = obj.source || data.source;
      viewMode = 'admin';
      hydrate(obj);
      return true;
    } catch (e) { return false; }
  }

  /* ---------------- 加载数据 ---------------- */
  async function consumeData(data, fresh) {
    if (!data) return false;
    const isV2 = window.TXCrypto && TXCrypto.isV2 && TXCrypto.isV2(data);
    const isV1 = !isV2 && window.TXCrypto && TXCrypto.isEncrypted && TXCrypto.isEncrypted(data);

    if (isV2 || isV1) {
      if (!TXCrypto.available()) {
        setStatus('当前环境不支持解密');
        showEmpty('浏览器不支持解密。<br>请通过 <b>https</b> 或 <b>localhost</b> 访问本页面。');
        return false;
      }
      const cred = readCred();
      if (!cred) {
        pendingEncrypted = data;
        state.updatedAt = data.updatedAt || null;
        saveCache(data);
        updateStatusChip(fresh);
        showLock('');
        return false;
      }
      let ok = false;
      try {
        if (isV2) ok = await unlockV2(data, cred);
        else ok = await unlockV1(data, cred.p || '');
      } catch (e) {
        ok = false;
      }
      if (ok) {
        saveCache(data);
        afterLoad(fresh);
        showBody();
        return true;
      }
      sessionStorage.removeItem(CRED_KEY);
      pendingEncrypted = data;
      updateStatusChip(fresh);
      showLock(isV2 ? '姓名或密码不正确' : '旧口令失效，请重新输入');
      return false;
    }

    // 明文数据
    viewMode = 'admin';
    hydrate(data);
    saveCache(data);
    afterLoad(fresh);
    showBody();
    return true;
  }

  async function loadData(manual) {
    if (state.loading) return;
    state.loading = true;
    setStatus(manual ? '正在刷新…' : '正在同步数据…');

    const sep = CFG.dataUrl.indexOf('?') >= 0 ? '&' : '?';
    const url = CFG.dataUrl + sep + 't=' + Date.now();

    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      state.loading = false;
      const ok = await consumeData(data, true);
      if (ok && manual) toast('已刷新到最新数据');
    } catch (err) {
      state.loading = false;
      const cached = loadCache();
      if (cached) {
        const ok = await consumeData(cached.data, false);
        if (ok) {
          setStatus('离线缓存 · ' + fmtTime(cached.at));
          toast('暂时连不上数据源，已显示 ' + fmtTime(cached.at) + ' 的缓存数据', true);
        }
      } else {
        setStatus('数据加载失败');
        showEmpty('数据加载失败：' + (err && err.message ? err.message : err) +
          '<br>请检查网络，或确认 data/leave-data.json 是否存在。');
      }
    }
  }

  function afterLoad(fresh) {
    renderAll();
    updateStatusChip(fresh);
    const btn = document.getElementById('emptyHint');
    if (state.years.length) {
      btn.style.display = 'none';
    } else {
      showEmpty('数据文件中还没有人员记录。<br>请在金山文档表格中录入后，运行同步脚本即可。');
    }
  }

  function showEmpty(html) {
    const h = document.getElementById('emptyHint');
    const t = document.getElementById('emptyText');
    if (t) t.innerHTML = html;
    if (h) h.style.display = 'block';
    const tw = document.getElementById('tableWrap');
    if (tw) tw.innerHTML = '';
  }

  function updateStatusChip(fresh) {
    const ts = state.updatedAt ? new Date(state.updatedAt).getTime() : null;
    setStatus(ts ? '数据更新于 ' + fmtTime(ts) : '已加载');
    const badge = document.getElementById('staleBadge');
    if (badge) {
      const stale = CFG.staleHours > 0 && hoursSince(state.updatedAt || 0) > CFG.staleHours;
      badge.style.display = stale ? 'inline-block' : 'none';
      badge.title = '已有较长时间未同步，请联系管理员检查金山文档同步脚本';
    }
    const foot = document.getElementById('footNote');
    if (foot) {
      foot.textContent = (state.source ? '数据来源：' + state.source : '') +
        (ts ? ' · 最近同步 ' + fmtTime(ts) : '') +
        ' · 若与考勤记录不一致，请以人事部门核对结果为准';
    }
  }

  /* ---------------- 渲染 ---------------- */
  function renderAll() {
    renderYears();
    renderSearch();
    applyPrivacy();
  }

  function applyPrivacy() {
    const sum = document.getElementById('summary');
    const cp = document.getElementById('cockpit');
    const tw = document.getElementById('tableWrap');
    const hint = document.getElementById('emptyHint');
    const btn = document.getElementById('btnPrivacy');
    const searching = !!currentSearchKey;
    const selfMode = (viewMode === 'self');
    const tableVisible = selfMode || !privacyHide || searching || tableForceShow;

    if (selfMode) {
      // 本人视图：显示自己的汇总与明细，隐藏全员排名和隐私开关
      if (sum) { sum.style.display = ''; renderSummary(); }
      if (cp) { cp.style.display = 'none'; cp.innerHTML = ''; }
    } else if (privacyHide) {
      if (sum) { sum.style.display = 'none'; sum.innerHTML = ''; }
      if (cp) { cp.style.display = 'none'; cp.innerHTML = ''; }
    } else {
      if (sum) sum.style.display = '';
      if (cp) cp.style.display = 'block';
      renderSummary();
      renderCockpit();
    }

    if (tableVisible && state.years.length) {
      if (tw) tw.style.display = '';
      if (hint) hint.style.display = 'none';
      renderTable(searching ? currentSearchKey : undefined);
    } else {
      if (tw) { tw.style.display = 'none'; tw.innerHTML = ''; }
      if (!state.years.length && hint) hint.style.display = 'block';
    }

    if (btn) {
      if (selfMode) {
        btn.style.display = 'none';
      } else {
        btn.style.display = '';
        btn.textContent = privacyHide ? '显示全部' : '只看本人';
      }
    }

    /* 本人视图：顶部常驻欢迎条（不依赖 toast），并隐藏搜索框 */
    const wb = document.getElementById('welcomeBar');
    const sb = document.getElementById('searchBar');
    if (wb) {
      if (selfMode) {
        wb.style.display = '';
        wb.innerHTML = '<span class="w-ico"></span>' +
          '<span>你好，<span class="w-name">' + escapeHtml(selfName || '') + '</span></span>' +
          '<span class="w-sub">以下仅显示你本人的调休记录</span>';
      } else {
        wb.style.display = 'none';
        wb.innerHTML = '';
      }
    }
    if (sb) sb.style.display = selfMode ? 'none' : '';
  }

  function renderYears() {
    const nav = document.getElementById('yearTabs');
    if (!nav) return;
    nav.innerHTML = '';
    state.years.forEach(function (y) {
      const b = document.createElement('div');
      b.className = 'tab' + (y.sheetName === state.activeYearKey ? ' active' : '');
      b.textContent = y.sheetName + ' 年';
      b.onclick = function () {
        state.activeYearKey = y.sheetName;
        renderYears();
        applyPrivacy();
      };
      nav.appendChild(b);
    });
  }

  function renderSummary() {
    const box = document.getElementById('summary');
    const y = state.years.find(function (y) { return y.sheetName === state.activeYearKey; });
    if (!y) { box.innerHTML = ''; return; }
    let total = 0, neg = 0, zero = 0;
    y.persons.forEach(function (p) {
      const af = computePerson(p).af;
      total += af;
      if (af < 0) neg++; else if (af === 0) zero++;
    });
    const cards = [
      { k: y.sheetName + ' 年 · 总人数', v: y.persons.length + ' 人' },
      { k: '本年调休剩余合计', v: fmt(total) + ' 天' },
      { k: '剩余为负人数', v: neg + ' 人', warn: neg > 0 },
      { k: '剩余为 0 人数', v: zero + ' 人' }
    ];
    box.innerHTML = cards.map(function (c) {
      return '<div class="stat' + (c.warn ? ' warn' : '') + '">' +
        '<div class="k">' + escapeHtml(c.k) + '</div><div class="v">' + escapeHtml(c.v) + '</div></div>';
    }).join('');
  }

  function cpKpi(k, v, cls) {
    return '<div class="cp-kpi ' + (cls || '') + '"><div class="ck">' + escapeHtml(k) +
      '</div><div class="cv">' + escapeHtml(v) + '</div></div>';
  }

  function renderCockpit() {
    const box = document.getElementById('cockpit');
    if (!state.years.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.style.display = 'block';

    const latest = state.years[state.years.length - 1];
    const list = latest.persons.map(function (p) {
      return { name: p.name, key: p.key, af: computePerson(p).af };
    });
    const total = list.length;
    const sum = list.reduce(function (a, b) { return a + b.af; }, 0);
    const avg = total ? sum / total : 0;
    const maxAf = list.length ? Math.max.apply(null, list.map(function (x) { return x.af; })) : 0;
    const minAf = list.length ? Math.min.apply(null, list.map(function (x) { return x.af; })) : 0;
    const neg = list.filter(function (x) { return x.af < 0; }).length;
    const zero = list.filter(function (x) { return x.af === 0; }).length;

    const ranked = list.slice().sort(function (a, b) { return b.af - a.af; }).slice(0, 20);
    const maxBar = Math.max(1, ranked.length ? ranked[0].af : 1);

    const rows = ranked.map(function (x, i) {
      const rank = i + 1;
      const pct = Math.max(4, Math.round(Math.abs(x.af) / maxBar * 100));
      const rc = rank <= 3 ? ' r' + rank : '';
      return '<div class="cp-row" data-key="' + escapeHtml(x.key) + '" data-name="' + escapeHtml(x.name) + '">' +
        '<span class="cp-rank' + rc + '">' + rank + '</span>' +
        '<span class="cp-name">' + escapeHtml(x.name) + '</span>' +
        '<div class="cp-track"><div class="cp-fill' + rc + '" style="width:0" data-w="' + pct + '"></div></div>' +
        '<span class="cp-val ' + (x.af < 0 ? 'neg' : (x.af === 0 ? 'zero' : '')) + '">' + fmt(x.af) + '</span>' +
        '</div>';
    }).join('');

    box.innerHTML =
      '<div class="cp-card">' +
        '<div class="cp-head">' +
          '<div class="cp-title">数据驾驶舱</div>' +
          '<div class="cp-sub">最新年份 <b>' + escapeHtml(latest.sheetName) + '</b> 年 · 剩余调休整体分布</div>' +
        '</div>' +
        '<div class="cp-kpis">' +
          cpKpi('总人数', total + ' 人', '') +
          cpKpi('剩余调休总额', fmt(sum) + ' 天', '') +
          cpKpi('人均剩余', fmt(avg) + ' 天', '') +
          cpKpi('最高剩余', fmt(maxAf) + ' 天', 'hi') +
          cpKpi('最低剩余', fmt(minAf) + ' 天', minAf < 0 ? 'warn' : '') +
          cpKpi('剩余为负', neg + ' 人', neg > 0 ? 'warn' : '') +
          cpKpi('剩余为 0', zero + ' 人', '') +
        '</div>' +
        '<div class="cp-rank-head">剩余调休 TOP 20 <span class="cp-rank-tip">（点击姓名可定位到明细）</span></div>' +
        '<div class="cp-bars">' + (rows || '<div class="cp-empty">暂无数据</div>') + '</div>' +
      '</div>';

    requestAnimationFrame(function () {
      box.querySelectorAll('.cp-fill').forEach(function (f) {
        f.style.width = f.getAttribute('data-w') + '%';
      });
    });
  }

  function renderTable(filter) {
    const wrap = document.getElementById('tableWrap');
    const y = state.years.find(function (y) { return y.sheetName === state.activeYearKey; });
    if (!y) { wrap.innerHTML = ''; return; }

    let thead = '<thead><tr>' +
      '<th class="name-col">姓名</th>' +
      '<th class="c-rem">调休<br>剩余</th>' +
      '<th class="c-holiday">休假<br>合计</th>' +
      '<th class="c-tiao">调休<br>合计</th>';
    MONTHS.forEach(function (m) { thead += '<th class="mh">' + m + '月</th>'; });
    thead += '<th class="c-status">清算<br>状态</th><th class="c-g">清算后<br>(G)</th></tr></thead>';

    let tbody = '<tbody>';
    let shown = 0;
    y.persons.forEach(function (p) {
      if (filter && p.key.indexOf(filter) < 0) return;
      shown++;
      const c = computePerson(p);
      const rcls = c.af < 0 ? 'neg' : (c.af === 0 ? 'zero' : (c.af <= 3 ? 'low' : 'pos'));
      tbody += '<tr class="person" data-key="' + escapeHtml(p.key) + '">';
      tbody += '<td class="name-col"><span class="nm">' + escapeHtml(p.name) + '</span>' +
        (p.dept ? '<span class="dept">' + escapeHtml(p.dept) + '</span>' : '') + '</td>';
      tbody += '<td class="remain c-rem ' + rcls + '">' + fmt(c.af) + '</td>';
      tbody += '<td class="tot-holiday c-holiday">' + fmt(c.ab) + '</td>';
      tbody += '<td class="tot-tiao c-tiao">' + fmt(c.ac) + '</td>';
      p.months.forEach(function (mm) {
        const l = coerceNum(mm.leave), t = coerceNum(mm.tiao);
        tbody += '<td class="month">' +
          '<span class="ed num' + (l === 0 ? ' empty' : '') + '" data-kind="leave">' + (l === 0 ? '' : fmt(l)) + '</span>' +
          '<span class="sep">/</span>' +
          '<span class="ed num' + (t === 0 ? ' empty' : '') + '" data-kind="tiao">' + (t === 0 ? '' : fmt(t)) + '</span>' +
          '</td>';
      });
      tbody += '<td class="status-cell">' + (p.clearingStatus ? escapeHtml(p.clearingStatus) : '<span class="faint">—</span>') + '</td>';
      tbody += '<td class="clearing">' + fmt(c.G) + '</td>';
      tbody += '</tr>';
    });
    tbody += '</tbody>';

    if (!shown) {
      wrap.innerHTML = '<div class="tbl-empty">没有匹配的人员</div>';
      return;
    }
    wrap.innerHTML = '<table>' + thead + tbody + '</table>';
  }

  /* ---------------- 搜索 ---------------- */
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');

  function onSearchInput() {
    searchClear.classList.toggle('show', searchInput.value.length > 0);
    currentSearchKey = normName(searchInput.value);
    renderSearch();
    applyPrivacy();
  }

  function renderSearch() {
    const box = document.getElementById('searchResult');
    const q = currentSearchKey;
    if (!q) { box.innerHTML = ''; return; }
    if (!state.years.length) {
      box.innerHTML = '<div class="sr-empty">数据尚未加载完成</div>';
      return;
    }

    const seen = {};
    let html = '';
    // 从最新年份往前找，取每个人最新一条记录
    const reversed = state.years.slice().reverse();
    reversed.forEach(function (y) {
      y.persons.forEach(function (p) {
        if (seen[p.key]) return;
        if (p.key.indexOf(q) < 0) return;
        seen[p.key] = true;
        const c = computePerson(p);
        const cls = c.af < 0 ? 'neg' : (c.af === 0 ? 'zero' : (c.af <= 3 ? 'low' : 'pos'));
        const tip = c.af < 0
          ? '当前已超支，请尽快与人事核对'
          : (c.af === 0 ? '已无剩余可用调休' : (c.af <= 3 ? '剩余不多，可考虑安排休假' : ''));
        html += '<div class="sr-card ' + cls + '">' +
          '<div class="sr-head">' +
            '<span class="sr-name">' + escapeHtml(p.name) + '</span>' +
            (p.dept ? '<span class="sr-dept">' + escapeHtml(p.dept) + '</span>' : '') +
            '<span class="sr-year">' + escapeHtml(y.sheetName) + ' 年数据</span>' +
          '</div>' +
          '<div class="sr-main">剩余可用调休 <b>' + fmt(c.af) + '</b> 天</div>' +
          '<div class="sr-formula">休假合计 ' + fmt(c.ab) + ' 天 · 清算基数 ' + fmt(c.G) +
            ' 天 + 本年调休 ' + fmt(c.tiaoSum) + ' 天' +
            (tip ? ' · ' + tip : '') + '</div>' +
          '</div>';
      });
    });

    box.innerHTML = html || '<div class="sr-empty">未找到「' + escapeHtml(searchInput.value.trim()) +
      '」，请确认姓名是否正确（支持输入姓氏或名字的一部分）</div>';
  }

  /* ---------------- 绑定 ---------------- */
  function bindUI() {
    document.title = CFG.title;
    const t = document.getElementById('appTitle');
    if (t) t.textContent = CFG.title;
    const s = document.getElementById('appSubtitle');
    if (s) s.textContent = CFG.subtitle || '';
    if (CFG.searchPlaceholder) searchInput.placeholder = CFG.searchPlaceholder;

    searchInput.addEventListener('input', onSearchInput);
    searchClear.addEventListener('click', function () {
      searchInput.value = '';
      searchClear.classList.remove('show');
      currentSearchKey = '';
      renderSearch();
      applyPrivacy();
    });

    document.getElementById('btnPrivacy').onclick = function () {
      privacyHide = !privacyHide;
      tableForceShow = false;
      applyPrivacy();
    };

    document.getElementById('btnReload').onclick = function () { loadData(true); };

    /* 登录：姓名 + 密码 */
    async function tryUnlock() {
      const ni = document.getElementById('nameInput');
      const pi = document.getElementById('pwInput');
      const name = (ni && ni.value ? ni.value : '').trim();
      const pw = (pi && pi.value ? pi.value : '').trim();
      if (!name) { showLock('请输入姓名'); return; }
      if (!pw) { showLock('请输入密码'); return; }
      const btn = document.getElementById('btnUnlock');
      const pkg = pendingEncrypted || (loadCache() && loadCache().data);
      if (!pkg) { showLock('数据尚未加载完成，请稍候'); return; }
      btn.disabled = true;
      btn.textContent = '查询中…';
      let ok = false;
      try {
        if (TXCrypto.isV2 && TXCrypto.isV2(pkg)) ok = await unlockV2(pkg, { n: name, p: pw });
        else ok = await unlockV1(pkg, pw);
      } catch (e) {
        ok = false;
      }
      btn.disabled = false;
      btn.textContent = '查询';
      if (ok) {
        sessionStorage.setItem(CRED_KEY, JSON.stringify({ n: name, p: pw }));
        if (pi) pi.value = '';
        if (ni) ni.value = '';
        saveCache(pkg);
        afterLoad(true);
        showBody();
        toast(viewMode === 'self' ? ('你好，' + name) : '管理员已登录');
      } else {
        showLock(name === (CFG.adminName || 'admin') ? '管理员密码不正确' : '姓名或密码不正确');
      }
    }
    document.getElementById('btnUnlock').onclick = tryUnlock;
    document.getElementById('pwInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); }
    });
    const nameEl = document.getElementById('nameInput');
    if (nameEl) nameEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('pwInput').focus(); }
    });

    /* 锁定：清掉登录信息重新上锁 */
    document.getElementById('btnLock').onclick = function () {
      sessionStorage.removeItem(CRED_KEY);
      viewMode = 'admin';
      selfName = '';
      privacyHide = CFG.privacyDefault;
      state.years = [];
      state.activeYearKey = null;
      const tw = document.getElementById('tableWrap');
      if (tw) tw.innerHTML = '';
      showLock('');
      const pi = document.getElementById('pwInput');
      if (pi) pi.value = '';
      const ni = document.getElementById('nameInput');
      if (ni) ni.value = '';
    };

    document.getElementById('cockpit').addEventListener('click', function (e) {
      const row = e.target.closest('.cp-row');
      if (!row) return;
      const name = row.getAttribute('data-name') || '';
      searchInput.value = name;
      searchClear.classList.toggle('show', name.length > 0);
      currentSearchKey = normName(name);
      renderSearch();
      applyPrivacy();
      document.getElementById('searchResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // 回车直接查询：若只有一个结果，自动滚动到卡片
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        const card = document.querySelector('.sr-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (e.key === 'Escape') {
        searchInput.value = '';
        searchClear.classList.remove('show');
        currentSearchKey = '';
        renderSearch();
        applyPrivacy();
      }
    });

    // 页面重新可见时，若数据超过 10 分钟则静默刷新
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && state.updatedAt &&
        hoursSince(state.updatedAt) > 0.17) {
        loadData(false);
      }
    });
  }

  function init() {
    bindUI();
    // 先用缓存秒开，再拉远端（体感更快，弱网也不至于白屏）
    const cached = loadCache();
    if (cached) {
      consumeData(cached.data, false);
      setStatus('缓存 · ' + fmtTime(cached.at));
    }
    loadData(false);
  }

  init();
})();
