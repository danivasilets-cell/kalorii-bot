'use strict';

/* ============================================================
   Калории — мини-приложение Telegram.
   Данные хранятся в Telegram CloudStorage (у каждого пользователя свои,
   синхронизируются между устройствами). Вне Telegram — в localStorage.
   ============================================================ */

const tg = window.Telegram && window.Telegram.WebApp;
const inTelegram = !!(tg && tg.initData);
const cloud = inTelegram && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9') ? tg.CloudStorage : null;

// ---------- Утилиты ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n0 = (v) => Math.round(v || 0).toLocaleString('ru-RU');
const n1 = (v) => String(Math.round((v || 0) * 10) / 10).replace('.', ',');
const num = (s) => { const x = parseFloat(String(s).replace(',', '.').replace(/\s/g, '')); return isFinite(x) ? x : 0; };
const pad = (n) => String(n).padStart(2, '0');
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const dayKey = (d) => `d_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const keyToDate = (k) => new Date(+k.slice(2, 6), +k.slice(6, 8) - 1, +k.slice(8, 10));
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const parse = (s, def) => { try { return s ? JSON.parse(s) : def; } catch { return def; } };
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const dateText = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
function dayTitle(d) {
  const t = startOfDay(new Date());
  if (sameDay(d, t)) return 'Сегодня';
  if (sameDay(d, addDays(t, -1))) return 'Вчера';
  return dateText(d);
}
function haptic(type) {
  try {
    if (type === 'success') tg.HapticFeedback.notificationOccurred('success');
    else tg.HapticFeedback.impactOccurred('light');
  } catch {}
}
let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

// ---------- Хранилище ----------
const Store = {
  async get(keys) {
    if (cloud) {
      const out = {};
      for (let i = 0; i < keys.length; i += 20) {
        const part = keys.slice(i, i + 20);
        const vals = await new Promise((res) => cloud.getItems(part, (err, v) => res(err ? {} : v || {})));
        Object.assign(out, vals);
      }
      return out;
    }
    const out = {};
    for (const k of keys) { try { out[k] = localStorage.getItem('kal_' + k) || ''; } catch { out[k] = ''; } }
    return out;
  },
  async set(key, value) {
    if (cloud) return new Promise((res) => cloud.setItem(key, value, () => res()));
    try { localStorage.setItem('kal_' + key, value); } catch {}
  },
  async remove(key) {
    if (cloud) return new Promise((res) => cloud.removeItem(key, () => res()));
    try { localStorage.removeItem('kal_' + key); } catch {}
  },
  async keys() {
    if (cloud) return new Promise((res) => cloud.getKeys((err, ks) => res(err ? [] : ks || [])));
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('kal_')) out.push(k.slice(4)); } } catch {}
    return out;
  },
};

/** Сохраняет список, обрезая его так, чтобы влезть в лимит CloudStorage (4096 символов). */
function fitList(list, max = 4000) {
  let arr = list.slice();
  while (arr.length && JSON.stringify(arr).length > max) arr.pop();
  return arr;
}

// ---------- Расчёт нормы ----------
const ACTIVITY = [
  { id: 'minimal', f: 1.2, t: 'Минимальная', h: 'сидячая работа, без спорта' },
  { id: 'light', f: 1.375, t: 'Лёгкая', h: '1–3 тренировки в неделю' },
  { id: 'moderate', f: 1.55, t: 'Средняя', h: '3–5 тренировок в неделю' },
  { id: 'high', f: 1.725, t: 'Высокая', h: '6–7 тренировок в неделю' },
  { id: 'extreme', f: 1.9, t: 'Очень высокая', h: 'физическая работа + спорт' },
];
const GOALS = [
  { id: 'lose', t: 'Похудеть' },
  { id: 'maintain', t: 'Держать вес' },
  { id: 'gain', t: 'Набрать' },
];
const MEALS = [
  { id: 'b', t: 'Завтрак', i: '🌅' },
  { id: 'l', t: 'Обед', i: '☀️' },
  { id: 'd', t: 'Ужин', i: '🌙' },
  { id: 's', t: 'Перекусы', i: '🥕' },
];
const DEFAULT_PROFILE = { sex: 'm', age: 30, height: 175, weight: 75, activity: 'light', goal: 'lose', custom: false, customKcal: 2000, water: 2000 };

function goals(p) {
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === 'm' ? 5 : -161);
  const act = (ACTIVITY.find((a) => a.id === p.activity) || ACTIVITY[1]).f;
  const tdee = bmr * act;
  let kcal;
  if (p.custom) kcal = p.customKcal;
  else {
    kcal = p.goal === 'lose' ? tdee * 0.8 : p.goal === 'gain' ? tdee * 1.1 : tdee;
    kcal = Math.max(kcal, p.sex === 'm' ? 1500 : 1200);
  }
  const protein = p.weight * (p.goal === 'maintain' ? 1.6 : 1.8);
  const fat = (kcal * 0.28) / 9;
  const carbs = Math.max(0, (kcal - protein * 4 - fat * 9) / 4);
  return { bmr, tdee, kcal: Math.round(kcal), protein: Math.round(protein), fat: Math.round(fat), carbs: Math.round(carbs), water: p.water };
}

// ---------- Состояние ----------
const S = {
  tab: 'diary',
  day: startOfDay(new Date()),
  data: { e: [], w: 0 }, // записи выбранного дня: e — еда, w — вода (мл)
  profile: null,
  recent: [],
  custom: [],
  weights: [], // [[YYYY-MM-DD, кг]]
  history: null, // кэш для вкладки «История»
};

// Еда: { n: название, b: бренд, k/p/f/c: на 100 г, s: порция, g: граммы, m: приём пищи, bc: штрихкод }
const per = (food, g) => ({ k: (food.k * g) / 100, p: (food.p * g) / 100, f: (food.f * g) / 100, c: (food.c * g) / 100 });
function totalsOf(entries) {
  return entries.reduce((t, e) => { const x = per(e, e.g); t.k += x.k; t.p += x.p; t.f += x.f; t.c += x.c; return t; }, { k: 0, p: 0, f: 0, c: 0 });
}
const foodSub = (f) => [f.b, `${n0(f.k)} ккал · Б ${n1(f.p)} Ж ${n1(f.f)} У ${n1(f.c)} на 100 г`].filter(Boolean).join(' · ');
const foodKey = (f) => `${f.n.toLowerCase()}|${(f.b || '').toLowerCase()}`;
const plainFood = (f) => ({ n: f.n, b: f.b || undefined, k: +f.k, p: +f.p, f: +f.f, c: +f.c, s: f.s || undefined, bc: f.bc || undefined });

async function loadDay(d) {
  S.day = startOfDay(d);
  const key = dayKey(S.day);
  const v = await Store.get([key]);
  S.data = parse(v[key], { e: [], w: 0 });
}
async function saveDay() {
  const key = dayKey(S.day);
  if (!S.data.e.length && !S.data.w) await Store.remove(key);
  else await Store.set(key, JSON.stringify(S.data));
  S.history = null;
}
async function saveProfile() { await Store.set('profile', JSON.stringify(S.profile)); }
async function remember(food, g) {
  const f = { ...plainFood(food), lg: g };
  S.recent = fitList([f, ...S.recent.filter((r) => foodKey(r) !== foodKey(f))].slice(0, 40));
  await Store.set('recent', JSON.stringify(S.recent));
}

// ---------- Open Food Facts ----------
const OFF_FIELDS = 'code,product_name,product_name_ru,brands,nutriments,serving_quantity';
function offToFood(p, fallbackCode) {
  const name = ((p.product_name_ru || '').trim() || (p.product_name || '').trim());
  const n = p.nutriments || {};
  const val = (x) => (x == null || x === '' ? null : num(x));
  let k = val(n['energy-kcal_100g']);
  if (k == null && val(n.energy_100g) != null) k = val(n.energy_100g) / 4.184;
  if (!name || k == null) return null;
  const brand = (p.brands || '').split(',')[0].trim();
  const s = val(p.serving_quantity);
  return { n: name, b: brand || undefined, bc: p.code || fallbackCode, k, p: val(n.proteins_100g) || 0, f: val(n.fat_100g) || 0, c: val(n.carbohydrates_100g) || 0, s: s && s > 0 ? s : undefined };
}
async function offSearch(q) {
  const u = new URL('https://world.openfoodfacts.org/cgi/search.pl');
  Object.entries({ search_terms: q, search_simple: 1, action: 'process', json: 1, page_size: 40, fields: OFF_FIELDS })
    .forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const seen = new Set();
  return (j.products || []).map((p) => offToFood(p)).filter((f) => f && !seen.has(foodKey(f)) && seen.add(foodKey(f)));
}
async function offProduct(code) {
  const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return j.product ? offToFood(j.product, code) : null;
}

// ---------- Всплывающие экраны (стек) ----------
const sheets = [];
function openSheet(sheet) { sheets.push(sheet); renderSheet(); }
function closeSheet() { sheets.pop(); renderSheet(); }
function closeAllSheets() { sheets.length = 0; renderSheet(); }
function renderSheet() {
  const host = $('#sheets');
  const top = sheets[sheets.length - 1];
  if (!top) {
    host.innerHTML = '';
    try { tg.BackButton.hide(); } catch {}
    return;
  }
  const back = top.noBack ? '' : `<button class="link-btn" data-a="back">${sheets.length > 1 ? '‹ Назад' : 'Закрыть'}</button>`;
  host.innerHTML = `<div class="sheet">
    <div class="sheet-head"><div class="side">${back}</div><h2>${esc(top.title)}</h2><div class="side">${top.headRight ? top.headRight() : ''}</div></div>
    <div class="sheet-body">${top.render()}</div></div>`;
  try { top.noBack ? tg.BackButton.hide() : tg.BackButton.show(); } catch {}
  if (top.mount) top.mount(host.querySelector('.sheet'));
}
function refreshSheet() {
  const top = sheets[sheets.length - 1];
  const body = document.querySelector('#sheets .sheet-body');
  if (top && body) { body.innerHTML = top.render(); if (top.mount) top.mount(document.querySelector('#sheets .sheet')); }
}

// ---------- Общие куски разметки ----------
function totalsHTML(t) {
  return `<div class="totals">
    <div><b style="color:var(--kcal)">${n0(t.k)}</b><span>ккал</span></div>
    <div><b style="color:var(--prot)">${n1(t.p)}</b><span>белки</span></div>
    <div><b style="color:var(--fat)">${n1(t.f)}</b><span>жиры</span></div>
    <div><b style="color:var(--carb)">${n1(t.c)}</b><span>углеводы</span></div></div>`;
}
function foodRow(f, action, extra = '') {
  return `<button class="row" data-a="${action}" ${extra}><div class="main"><div class="title">${esc(f.n)}</div><div class="sub">${esc(foodSub(f))}</div></div></button>`;
}
function mealSeg(current) {
  return `<div class="seg">${MEALS.map((m) => `<button data-a="meal" data-m="${m.id}" class="${m.id === current ? 'on' : ''}">${m.t}</button>`).join('')}</div>`;
}

// ---------- Экран «Дневник» ----------
function renderDiary() {
  const g = goals(S.profile);
  const t = totalsOf(S.data.e);
  const left = g.kcal - t.k;
  const pct = Math.min(t.k / Math.max(g.kcal, 1), 1);
  const C = 2 * Math.PI * 50;
  const isToday = sameDay(S.day, startOfDay(new Date()));
  const macro = (label, v, goal, color) => `<div class="macro"><div class="label">${label}</div>
    <div class="bar"><i style="width:${Math.min(v / Math.max(goal, 1), 1) * 100}%;background:${v > goal * 1.1 ? 'var(--prot)' : color}"></i></div>
    <div class="nums">${n0(v)} / ${n0(goal)} г</div></div>`;

  const meals = MEALS.map((m) => {
    const items = S.data.e.map((e, i) => ({ e, i })).filter((x) => x.e.m === m.id);
    const sum = totalsOf(items.map((x) => x.e)).k;
    return `<div class="section-h"><span>${m.i} ${m.t}</span><span>${items.length ? n0(sum) + ' ккал' : ''}</span></div>
      <div class="list">
        ${items.map(({ e, i }) => { const x = per(e, e.g); return `<button class="row" data-a="edit" data-i="${i}">
          <div class="main"><div class="title">${esc(e.n)}</div><div class="sub">${n0(e.g)} г · Б ${n1(x.p)} Ж ${n1(x.f)} У ${n1(x.c)}</div></div>
          <div class="val">${n0(x.k)}</div></button>`; }).join('')}
        <button class="row add" data-a="add" data-m="${m.id}">＋ Добавить</button>
      </div>`;
  }).join('');

  return `<div class="top">
      <button class="icon-btn" data-a="prevDay" aria-label="Предыдущий день">‹</button>
      <h1>${dayTitle(S.day)}</h1>
      ${isToday ? '' : '<button class="link-btn" data-a="today">Сегодня</button>'}
      <button class="icon-btn" data-a="nextDay" aria-label="Следующий день" ${isToday ? 'disabled' : ''}>›</button>
    </div>
    <div class="card">
      <div class="summary">
        <div class="ring">
          <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="50" fill="none" stroke="var(--kcal)" stroke-opacity=".15" stroke-width="13"/>
          <circle cx="60" cy="60" r="50" fill="none" stroke="${left < 0 ? 'var(--prot)' : 'var(--kcal)'}" stroke-width="13" stroke-linecap="round"
            stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}" style="transition:stroke-dashoffset .4s"/></svg>
          <div class="center"><div class="big">${n0(Math.abs(left))}</div><div class="small">${left >= 0 ? 'осталось' : 'сверх нормы'}</div></div>
        </div>
        <div>
          <div class="stat"><div class="label">Съедено</div><div class="value">${n0(t.k)} ккал</div></div>
          <div class="stat"><div class="label">Норма</div><div class="value">${n0(g.kcal)} ккал</div></div>
        </div>
      </div>
      <div class="macros">${macro('Белки', t.p, g.protein, 'var(--prot)')}${macro('Жиры', t.f, g.fat, 'var(--fat)')}${macro('Углеводы', t.c, g.carbs, 'var(--carb)')}</div>
    </div>
    <div class="card water">
      <span style="font-size:24px">💧</span>
      <div class="main"><div>Вода: ${n0(S.data.w)} из ${n0(g.water)} мл</div>
        <div class="bar"><i style="width:${Math.min(S.data.w / Math.max(g.water, 1), 1) * 100}%;background:var(--water)"></i></div></div>
      <button class="round-btn" style="color:var(--hint)" data-a="waterMinus" ${S.data.w <= 0 ? 'disabled' : ''} aria-label="Минус стакан">−</button>
      <button class="round-btn" style="color:var(--water)" data-a="waterPlus" aria-label="Плюс стакан">+</button>
    </div>
    ${meals}`;
}

// ---------- Экран «История» ----------
async function loadHistory() {
  const keys = (await Store.keys()).filter((k) => /^d_\d{8}$/.test(k)).sort().reverse().slice(0, 90);
  const vals = await Store.get(keys);
  S.history = keys.map((k) => {
    const d = parse(vals[k], { e: [], w: 0 });
    return { date: keyToDate(k), t: totalsOf(d.e || []), w: d.w || 0 };
  }).filter((x) => x.t.k > 0 || x.w > 0);
  if (S.tab === 'history') render();
}
function renderHistory() {
  if (!S.history) { loadHistory(); return `<div class="top"><h1>История</h1></div><div class="empty"><div class="spinner" style="margin:0 auto"></div></div>`; }
  const g = goals(S.profile);
  if (!S.history.length) return `<div class="top"><h1>История</h1></div><div class="empty"><b>Пока пусто</b>Добавьте еду в дневник — здесь появится статистика.</div>`;

  const today = startOfDay(new Date());
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = addDays(today, -i);
    const h = S.history.find((x) => sameDay(x.date, d));
    days.push({ d, k: h ? h.t.k : 0 });
  }
  const max = Math.max(g.kcal * 1.15, ...days.map((x) => x.k));
  const W = 340, H = 170, bw = W / 14;
  const y = (v) => H - 18 - (v / max) * (H - 28);
  const bars = days.map((x, i) => `<rect x="${i * bw + 3}" y="${y(x.k)}" width="${bw - 6}" height="${Math.max(0, H - 18 - y(x.k))}" rx="3"
      fill="${x.k > g.kcal * 1.05 ? 'var(--fat)' : 'var(--kcal)'}"/>
      ${i % 2 === 1 ? `<text x="${i * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${x.d.getDate()}</text>` : ''}`).join('');
  const week = S.history.filter((x) => x.date >= addDays(today, -6) && x.t.k > 0);
  const avg = week.length ? week.reduce((s, x) => s + x.t.k, 0) / week.length : 0;

  return `<div class="top"><h1>История</h1></div>
    <div class="section-h"><span>Последние 2 недели</span></div>
    <div class="card"><svg class="chart" viewBox="0 0 ${W} ${H}">${bars}
      <line x1="0" x2="${W}" y1="${y(g.kcal)}" y2="${y(g.kcal)}" stroke="var(--hint)" stroke-dasharray="5 4"/></svg></div>
    ${week.length ? `<div class="footnote">В среднем за неделю: ${n0(avg)} ккал в день (норма ${n0(g.kcal)}).</div>` : ''}
    <div class="section-h"><span>По дням</span></div>
    <div class="list">${S.history.map((x) => `<button class="row" data-a="openDay" data-d="${isoDate(x.date)}">
      <div class="main"><div class="title">${WEEKDAYS[x.date.getDay()].replace(/^./, (c) => c.toUpperCase())}, ${dateText(x.date)}</div>
      <div class="sub">Б ${n0(x.t.p)} · Ж ${n0(x.t.f)} · У ${n0(x.t.c)} · вода ${n0(x.w)} мл</div></div>
      <div class="val" style="${x.t.k > g.kcal * 1.05 ? 'color:var(--fat)' : ''}">${n0(x.t.k)} ккал</div></button>`).join('')}</div>`;
}

// ---------- Экран «Вес» ----------
function renderWeight() {
  const w = S.weights;
  const last = w[w.length - 1];
  let chart = '';
  if (w.length >= 2) {
    const pts = w.slice(-60);
    const vals = pts.map((x) => x[1]);
    const lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
    const t0 = parseIso(pts[0][0]).getTime(), t1 = parseIso(pts[pts.length - 1][0]).getTime() || t0 + 1;
    const W = 340, H = 170;
    const px = (d) => 24 + ((parseIso(d).getTime() - t0) / Math.max(t1 - t0, 1)) * (W - 34);
    const py = (v) => 10 + (1 - (v - lo) / (hi - lo)) * (H - 30);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join(' ');
    chart = `<div class="card"><svg class="chart" viewBox="0 0 ${W} ${H}">
      <text x="0" y="${py(hi - 1) + 3}">${n0(hi - 1)}</text><text x="0" y="${py(lo + 1) + 3}">${n0(lo + 1)}</text>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${pts.map((p) => `<circle cx="${px(p[0])}" cy="${py(p[1])}" r="3.5" fill="var(--accent)"/>`).join('')}
      <text x="24" y="${H - 4}">${dateText(parseIso(pts[0][0]))}</text>
      <text x="${W}" y="${H - 4}" text-anchor="end">${dateText(parseIso(pts[pts.length - 1][0]))}</text></svg></div>`;
  }
  const bmi = last ? last[1] / Math.pow(S.profile.height / 100, 2) : 0;
  const diff = w.length >= 2 ? last[1] - w[0][1] : null;
  return `<div class="top"><h1>Вес</h1></div>
    <div class="list">
      <div class="field"><label>Новый вес</label><input id="newWeight" inputmode="decimal" placeholder="${n1(last ? last[1] : S.profile.weight)}"><span class="unit">кг</span></div>
    </div>
    <button class="btn" data-a="addWeight">Записать вес</button>
    ${chart}
    ${last ? `<div class="list">
      <div class="row"><div class="main">Сейчас</div><div class="val">${n1(last[1])} кг</div></div>
      ${diff != null ? `<div class="row"><div class="main">С ${dateText(parseIso(w[0][0]))}</div><div class="val">${diff > 0 ? '+' : ''}${n1(diff)} кг</div></div>` : ''}
      <div class="row"><div class="main">Индекс массы тела</div><div class="val">${n1(bmi)}</div></div></div>
    <div class="section-h"><span>Записи</span></div>
    <div class="list">${w.slice().reverse().map((x) => `<div class="row"><div class="main">${dateText(parseIso(x[0]))} ${parseIso(x[0]).getFullYear()}</div>
      <div class="val">${n1(x[1])} кг</div><button class="link-btn" style="color:var(--danger)" data-a="delWeight" data-d="${x[0]}" aria-label="Удалить">✕</button></div>`).join('')}</div>`
    : `<div class="empty">Взвешивайтесь утром натощак раз в несколько дней — так график будет честнее.</div>`}`;
}

// ---------- Экран «Профиль» (и анкета при первом запуске) ----------
function profileFormHTML(p) {
  const g = goals(p);
  const goalNote = { lose: 'Дефицит 20% от расхода — примерно 0,5 кг в неделю.', maintain: 'Калории равны суточному расходу.', gain: 'Профицит 10% — для набора вместе с тренировками.' }[p.goal];
  return `<div class="section-h"><span>О вас</span></div>
    <div class="list">
      <div class="field">${segHTML('sex', [['m', 'Мужской'], ['f', 'Женский']], p.sex)}</div>
      <div class="field"><label>Возраст</label><input data-p="age" inputmode="numeric" value="${p.age}"><span class="unit">лет</span></div>
      <div class="field"><label>Рост</label><input data-p="height" inputmode="decimal" value="${n1(p.height)}"><span class="unit">см</span></div>
      <div class="field"><label>Вес</label><input data-p="weight" inputmode="decimal" value="${n1(p.weight)}"><span class="unit">кг</span></div>
    </div>
    <div class="section-h"><span>Активность</span></div>
    <div class="list">${ACTIVITY.map((a) => `<button class="row" data-a="setP" data-k="activity" data-v="${a.id}">
      <div class="main"><div class="title">${a.t}</div><div class="sub">${a.h}</div></div><div class="val" style="color:var(--accent)">${p.activity === a.id ? '✓' : ''}</div></button>`).join('')}</div>
    <div class="section-h"><span>Цель</span></div>
    <div class="list">
      <div class="field">${segHTML('goal', GOALS.map((x) => [x.id, x.t]), p.goal)}</div>
      <button class="row" data-a="setP" data-k="custom" data-v="${p.custom ? '' : '1'}"><div class="main">Задать норму вручную</div><div class="val" style="color:var(--accent)">${p.custom ? '✓' : ''}</div></button>
      ${p.custom ? `<div class="field"><label>Норма</label><input data-p="customKcal" inputmode="numeric" value="${p.customKcal}"><span class="unit">ккал</span></div>` : ''}
    </div>
    <div class="footnote" style="margin-top:-12px">${p.custom ? '' : goalNote}</div>
    <div class="section-h"><span>Вода в день</span></div>
    <div class="list"><div class="field"><label>Цель</label><input data-p="water" inputmode="numeric" value="${p.water}"><span class="unit">мл</span></div></div>
    <div class="section-h"><span>Ваша норма в день</span></div>
    <div class="list">
      <div class="row"><div class="main">Калории</div><div class="val">${n0(g.kcal)} ккал</div></div>
      <div class="row"><div class="main">Белки</div><div class="val">${n0(g.protein)} г</div></div>
      <div class="row"><div class="main">Жиры</div><div class="val">${n0(g.fat)} г</div></div>
      <div class="row"><div class="main">Углеводы</div><div class="val">${n0(g.carbs)} г</div></div>
    </div>
    <div class="footnote">Базовый обмен ${n0(g.bmr)} ккал, расход с активностью ${n0(g.tdee)} ккал (формула Миффлина — Сан Жеора).</div>`;
}
function segHTML(key, options, current) {
  return `<div class="seg">${options.map(([v, t]) => `<button data-a="setP" data-k="${key}" data-v="${v}" class="${v === current ? 'on' : ''}">${t}</button>`).join('')}</div>`;
}
function renderProfile() {
  return `<div class="top"><h1>Профиль</h1></div>${profileFormHTML(S.profile)}
    <div class="footnote">Записи хранятся в вашем облаке Telegram и видны только вам. База продуктов — Open Food Facts (ODbL).</div>`;
}
function onboardingSheet() {
  return {
    title: '', noBack: true,
    render: () => `<div class="hero"><div class="logo">🥗</div><h2>Посчитаем вашу норму</h2>
      <p>Заполните пару полей — приложение рассчитает калории и БЖУ на день. Всё можно поменять позже в профиле.</p></div>
      ${profileFormHTML(S.profile)}<button class="btn" data-a="finishOnboarding">Начать</button>`,
    actions: {
      async finishOnboarding() { S.profile.onboarded = true; await saveProfile(); closeAllSheets(); render(); },
    },
  };
}

// ---------- Добавление еды ----------
function addFoodSheet(meal) {
  const st = { q: '', results: null, loading: false, error: null, searched: '' };
  const local = () => {
    const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const seen = new Set();
    return [...S.custom, ...S.recent, ...BUILTIN].filter((f) => {
      const hay = (f.n + ' ' + (f.b || '')).toLowerCase();
      return words.every((w) => hay.includes(w)) && !seen.has(foodKey(f)) && seen.add(foodKey(f));
    }).slice(0, 30);
  };
  let pool = [];
  const row = (f) => { pool.push(f); return foodRow(f, 'pick', `data-i="${pool.length - 1}"`); };
  const results = () => {
    pool = [];
    const q = st.q.trim();
    if (!q) {
      return `<div class="list">
          <button class="row add" data-a="barcode">▥ Найти по штрихкоду</button>
          <button class="row add" data-a="manual">✎ Создать свой продукт</button></div>
        ${S.custom.length ? `<div class="section-h"><span>Мои продукты</span></div><div class="list">${S.custom.map(row).join('')}</div>` : ''}
        ${S.recent.length ? `<div class="section-h"><span>Недавние</span></div><div class="list">${S.recent.map(row).join('')}</div>` : ''}
        <div class="section-h"><span>Базовые продукты</span></div><div class="list">${BUILTIN.map(row).join('')}</div>`;
    }
    const loc = local();
    let online;
    if (st.loading) online = `<div class="row"><div class="spinner"></div><div class="main" style="color:var(--hint)">Ищем в базе продуктов…</div></div>`;
    else if (st.error) online = `<div class="row"><div class="main" style="color:var(--hint)">${esc(st.error)}</div></div><button class="row add" data-a="search">Повторить</button>`;
    else if (st.results && st.searched === q) online = st.results.length ? st.results.map(row).join('') : `<div class="row"><div class="main" style="color:var(--hint)">Ничего не нашлось</div></div>`;
    else online = `<button class="row add" data-a="search">🔍 Искать «${esc(q)}» в интернете</button>`;
    return `${loc.length ? `<div class="section-h"><span>Найдено</span></div><div class="list">${loc.map(row).join('')}</div>` : ''}
      <div class="section-h"><span>Open Food Facts</span></div><div class="list">${online}</div>
      <div class="list"><button class="row add" data-a="manual">✎ Создать «${esc(q)}» вручную</button></div>`;
  };
  const update = () => { const el = document.getElementById('foodResults'); if (el) el.innerHTML = results(); };
  async function search() {
    const q = st.q.trim();
    if (q.length < 2 || st.loading) return;
    st.loading = true; st.error = null; update();
    try { st.results = await offSearch(q); st.searched = q; }
    catch { st.error = 'Не удалось загрузить. Проверьте интернет.'; }
    st.loading = false; update();
  }
  return {
    title: MEALS.find((m) => m.id === meal).t,
    render: () => `<input class="search" id="foodSearch" type="search" enterkeyhint="search" placeholder="Продукт или бренд" value="${esc(st.q)}" autocomplete="off">
      <div id="foodResults">${results()}</div>`,
    mount(el) {
      const input = el.querySelector('#foodSearch');
      input.addEventListener('input', () => { st.q = input.value; update(); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); search(); } });
    },
    actions: {
      pick(d) { openSheet(amountSheet(pool[+d.i], meal)); },
      search,
      barcode() { openSheet(barcodeSheet(meal)); },
      manual() { openSheet(manualSheet(meal, { n: st.q.trim() })); },
    },
  };
}

function amountSheet(food, meal) {
  const st = { g: food.lg || food.s || 100, meal };
  const presets = [...new Set([food.s, 50, 100, 150, 200, 300].filter(Boolean))];
  const totals = () => totalsHTML(per(food, st.g));
  return {
    title: 'Количество',
    render: () => `<div class="card"><div style="font-weight:600">${esc(food.n)}</div><div class="sub" style="color:var(--hint);font-size:13px">${esc(foodSub(food))}</div></div>
      <div class="list">
        <div class="field"><label>Вес</label><input id="grams" inputmode="decimal" value="${n1(st.g)}"><span class="unit">г</span></div>
        <div class="chips" style="padding-top:8px">${presets.map((v) => `<button class="chip ${v === st.g ? 'on' : ''}" data-a="preset" data-v="${v}">${v === food.s ? 'Порция ' : ''}${n0(v)} г</button>`).join('')}</div>
        <div class="field">${mealSeg(st.meal)}</div>
      </div>
      <div class="card" id="amountTotals">${totals()}</div>
      <button class="btn" data-a="addEntry">Добавить в дневник</button>`,
    mount(el) {
      const input = el.querySelector('#grams');
      input.addEventListener('input', () => {
        st.g = num(input.value);
        el.querySelector('#amountTotals').innerHTML = totals();
        el.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', +c.dataset.v === st.g));
      });
    },
    actions: {
      preset(d) { st.g = +d.v; refreshSheet(); },
      meal(d) { st.meal = d.m; refreshSheet(); },
      async addEntry() {
        if (st.g <= 0) return toast('Укажите вес');
        S.data.e.push({ ...plainFood(food), g: st.g, m: st.meal, t: Date.now() });
        haptic('success');
        closeAllSheets();
        render();
        toast('Добавлено');
        await saveDay();
        await remember(food, st.g);
      },
    },
  };
}

function editSheet(index) {
  const e = S.data.e[index];
  return {
    title: 'Запись',
    render: () => `<div class="card"><div style="font-weight:600">${esc(e.n)}</div>${e.b ? `<div style="color:var(--hint);font-size:13px">${esc(e.b)}</div>` : ''}</div>
      <div class="list">
        <div class="field"><label>Вес</label><input id="grams" inputmode="decimal" value="${n1(e.g)}"><span class="unit">г</span></div>
        <div class="field">${mealSeg(e.m)}</div>
      </div>
      <div class="card" id="editTotals">${totalsHTML(per(e, e.g))}</div>
      <button class="btn" data-a="done">Готово</button>
      <button class="btn danger" data-a="del">Удалить запись</button>`,
    mount(el) {
      const input = el.querySelector('#grams');
      input.addEventListener('input', () => { e.g = num(input.value); el.querySelector('#editTotals').innerHTML = totalsHTML(per(e, e.g)); });
    },
    actions: {
      meal(d) { e.m = d.m; refreshSheet(); },
      async done() { closeAllSheets(); render(); await saveDay(); },
      async del() { S.data.e.splice(index, 1); haptic(); closeAllSheets(); render(); await saveDay(); },
    },
  };
}

function barcodeSheet(meal) {
  const st = { code: '', loading: false, notFound: false };
  return {
    title: 'Штрихкод',
    render: () => `<div class="list"><div class="field"><input id="code" class="wide" style="width:100%" inputmode="numeric" placeholder="Цифры под штрихкодом" value="${esc(st.code)}"></div></div>
      ${st.notFound ? `<div class="card">Штрихкода <b>${esc(st.code)}</b> пока нет в базе. Добавьте продукт сами — в следующий раз он найдётся по этому коду.</div>
        <button class="btn" data-a="manualWithCode">Добавить вручную</button>` : ''}
      <button class="btn ${st.notFound ? 'ghost' : ''}" data-a="find" ${st.loading ? 'disabled' : ''}>${st.loading ? 'Ищем…' : 'Найти'}</button>
      <div class="footnote" style="margin-top:0">Введите 8 или 13 цифр, напечатанных под полосками штрихкода.</div>`,
    mount(el) {
      const input = el.querySelector('#code');
      input.addEventListener('input', () => { st.code = input.value.replace(/\D/g, ''); });
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') sheets[sheets.length - 1].actions.find(); });
      if (!st.code) setTimeout(() => input.focus(), 250);
    },
    actions: {
      async find() {
        if (st.code.length < 6) return toast('Слишком короткий код');
        const local = [...S.custom, ...S.recent].find((f) => f.bc === st.code);
        if (local) return openSheet(amountSheet(local, meal));
        st.loading = true; st.notFound = false; refreshSheet();
        try {
          const food = await offProduct(st.code);
          st.loading = false;
          if (food) { refreshSheet(); openSheet(amountSheet(food, meal)); }
          else { st.notFound = true; refreshSheet(); }
        } catch { st.loading = false; refreshSheet(); toast('Нет соединения с базой продуктов'); }
      },
      manualWithCode() { openSheet(manualSheet(meal, { bc: st.code })); },
    },
  };
}

function manualSheet(meal, init) {
  const st = { n: init.n || '', b: '', bc: init.bc || '', k: '', p: '', f: '', c: '', s: '' };
  const fields = [['k', 'Калории', 'ккал'], ['p', 'Белки', 'г'], ['f', 'Жиры', 'г'], ['c', 'Углеводы', 'г']];
  const calc = () => num(st.p) * 4 + num(st.f) * 9 + num(st.c) * 4;
  return {
    title: 'Свой продукт',
    render: () => `<div class="list">
        <div class="field"><input class="wide" style="width:100%" data-f="n" placeholder="Название" value="${esc(st.n)}"></div>
        <div class="field"><input class="wide" style="width:100%" data-f="b" placeholder="Бренд (необязательно)" value="${esc(st.b)}"></div>
        <div class="field"><input class="wide" style="width:100%" data-f="bc" inputmode="numeric" placeholder="Штрихкод (необязательно)" value="${esc(st.bc)}"></div>
      </div>
      <div class="section-h"><span>На 100 г</span></div>
      <div class="list">${fields.map(([k, t, u]) => `<div class="field"><label>${t}</label><input data-f="${k}" inputmode="decimal" placeholder="0" value="${esc(st[k])}"><span class="unit">${u}</span></div>`).join('')}</div>
      <div class="footnote" id="kcalHint">Смотрите «Пищевая ценность на 100 г» на упаковке. Если калорий нет — посчитаем по БЖУ.</div>
      <div class="list"><div class="field"><label>Порция (необяз.)</label><input data-f="s" inputmode="decimal" placeholder="—" value="${esc(st.s)}"><span class="unit">г</span></div></div>
      <button class="btn" data-a="save">Сохранить и выбрать количество</button>`,
    mount(el) {
      el.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('input', () => {
        st[inp.dataset.f] = inp.value;
        const hint = el.querySelector('#kcalHint');
        if (!st.k && calc() > 0) hint.textContent = `Калории не указаны — по БЖУ получается ${n0(calc())} ккал.`;
      }));
    },
    actions: {
      async save() {
        const name = st.n.trim();
        const k = st.k ? num(st.k) : calc();
        if (!name) return toast('Введите название');
        if (k <= 0) return toast('Укажите калории или БЖУ');
        const food = { n: name, b: st.b.trim() || undefined, bc: st.bc.trim() || undefined, k, p: num(st.p), f: num(st.f), c: num(st.c), s: num(st.s) || undefined };
        S.custom = fitList([food, ...S.custom.filter((x) => foodKey(x) !== foodKey(food))]);
        await Store.set('custom', JSON.stringify(S.custom));
        sheets.pop();
        openSheet(amountSheet(food, meal));
      },
    },
  };
}

// ---------- Вкладки и общий рендер ----------
const TAB_ICONS = {
  diary: '<path d="M7 3v8a2 2 0 0 0 2 2v8M5 3v5M9 3v5M17 3c-1.7 0-3 2-3 5s1.3 4 3 4v9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  history: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  weight: '<rect x="3" y="4" width="18" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 10a4 4 0 0 1 7 0l-2 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  profile: '<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
};
const TABS = [['diary', 'Дневник'], ['history', 'История'], ['weight', 'Вес'], ['profile', 'Профиль']];
function render() {
  const views = { diary: renderDiary, history: renderHistory, weight: renderWeight, profile: renderProfile };
  $('#app').innerHTML = views[S.tab]();
  $('#tabs').innerHTML = TABS.map(([id, t]) => `<button class="${S.tab === id ? 'on' : ''}" data-a="tab" data-t="${id}"><svg viewBox="0 0 24 24">${TAB_ICONS[id]}</svg>${t}</button>`).join('');
}

// ---------- Действия ----------
const actions = {
  tab(d) { S.tab = d.t; render(); window.scrollTo(0, 0); },
  async prevDay() { await loadDay(addDays(S.day, -1)); render(); },
  async nextDay() { await loadDay(addDays(S.day, 1)); render(); },
  async today() { await loadDay(new Date()); render(); },
  async openDay(d) { await loadDay(parseIso(d.d)); S.tab = 'diary'; render(); window.scrollTo(0, 0); },
  add(d) { openSheet(addFoodSheet(d.m)); },
  edit(d) { openSheet(editSheet(+d.i)); },
  async waterPlus() { S.data.w += 250; haptic(); render(); await saveDay(); },
  async waterMinus() { S.data.w = Math.max(0, S.data.w - 250); haptic(); render(); await saveDay(); },
  async addWeight() {
    const kg = num($('#newWeight').value);
    if (kg < 20 || kg > 400) return toast('Введите вес в килограммах');
    const today = isoDate(new Date());
    S.weights = S.weights.filter((x) => x[0] !== today).concat([[today, kg]]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    while (JSON.stringify(S.weights).length > 4000) S.weights.shift();
    S.profile.weight = kg;
    haptic('success');
    render();
    toast('Вес записан');
    await Store.set('weights', JSON.stringify(S.weights));
    await saveProfile();
  },
  async delWeight(d) {
    S.weights = S.weights.filter((x) => x[0] !== d.d);
    render();
    await Store.set('weights', JSON.stringify(S.weights));
  },
  async setP(d) {
    const v = d.k === 'custom' ? !!d.v : d.v;
    S.profile[d.k] = v;
    haptic();
    if (sheets.length) refreshSheet(); else render();
    await saveProfile();
  },
  back() { closeSheet(); },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-a]');
  if (!el) return;
  const top = sheets[sheets.length - 1];
  const inSheet = !!el.closest('#sheets');
  const fn = (inSheet && top && top.actions && top.actions[el.dataset.a]) || actions[el.dataset.a];
  if (fn) fn(el.dataset, el);
});

// Поля профиля: сохраняем при уходе с поля.
document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (!el.dataset || !el.dataset.p) return;
  const k = el.dataset.p;
  const limits = { age: [10, 100], height: [100, 250], weight: [25, 400], customKcal: [800, 6000], water: [250, 6000] };
  const [lo, hi] = limits[k];
  let v = num(el.value);
  if (!v) v = DEFAULT_PROFILE[k];
  v = Math.min(hi, Math.max(lo, v));
  S.profile[k] = k === 'age' ? Math.round(v) : v;
  if (sheets.length) refreshSheet(); else render();
  await saveProfile();
});

// ---------- Запуск ----------
async function init() {
  if (tg) {
    try { tg.ready(); tg.expand(); } catch {}
    try { if (tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes(); } catch {}
    try { tg.setHeaderColor('secondary_bg_color'); tg.setBackgroundColor('secondary_bg_color'); } catch {}
    try { tg.BackButton.onClick(() => { if (sheets.length) closeSheet(); }); } catch {}
  }
  $('#app').innerHTML = '<div class="empty"><div class="spinner" style="margin:0 auto"></div></div>';
  const v = await Store.get(['profile', 'recent', 'custom', 'weights']);
  S.profile = { ...DEFAULT_PROFILE, ...parse(v.profile, {}) };
  S.recent = parse(v.recent, []);
  S.custom = parse(v.custom, []);
  S.weights = parse(v.weights, []);
  await loadDay(new Date());
  render();
  if (!S.profile.onboarded) openSheet(onboardingSheet());
}
init();
