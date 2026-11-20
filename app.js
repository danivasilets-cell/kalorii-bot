'use strict';

/* ============================================================
   Калории — мини-приложение Telegram.
   Данные хранятся в Telegram CloudStorage (у каждого пользователя свои,
   синхронизируются между устройствами). Вне Telegram — в localStorage.
   ============================================================ */

const tg = window.Telegram && window.Telegram.WebApp;
const inTelegram = !!(tg && tg.initData);
// Адрес бота на Cloudflare (для статистики владельца). Пусто — не отправлять.
const API_URL = 'https://kalorii-bot.danilvasilec10.workers.dev';
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
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
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
  prev: { e: [], w: 0 }, // предыдущий день — для «как вчера»
  daySet: new Set(), // дни, в которые есть записи
  ach: {}, // полученные достижения
  strip: new Map(), // калории по дням для ленты дат
};

// Еда: { n: название, b: бренд, k/p/f/c: на 100 г, s: порция, g: граммы, m: приём пищи, bc: штрихкод }
const per = (food, g) => ({ k: (food.k * g) / 100, p: (food.p * g) / 100, f: (food.f * g) / 100, c: (food.c * g) / 100 });
function totalsOf(entries) {
  return entries.reduce((t, e) => { const x = per(e, e.g); t.k += x.k; t.p += x.p; t.f += x.f; t.c += x.c; return t; }, { k: 0, p: 0, f: 0, c: 0 });
}
const foodSub = (f) => [f.b, `${n0(f.k)} ккал · Б ${n1(f.p)} Ж ${n1(f.f)} У ${n1(f.c)} на 100 г`].filter(Boolean).join(' · ');
const foodKey = (f) => `${f.n.toLowerCase()}|${(f.b || '').toLowerCase()}`;
const plainFood = (f) => ({ n: f.n, b: f.b || undefined, k: +f.k, p: +f.p, f: +f.f, c: +f.c, s: f.s || undefined, bc: f.bc || undefined, cat: f.cat != null ? f.cat : undefined });

async function loadDay(d) {
  S.day = startOfDay(d);
  const key = dayKey(S.day), pk = dayKey(addDays(S.day, -1));
  const v = await Store.get([key, pk]);
  S.data = parse(v[key], { e: [], w: 0 });
  S.prev = parse(v[pk], { e: [], w: 0 });
}
async function saveDay() {
  const key = dayKey(S.day);
  if (!S.data.e.length && !S.data.w) { S.daySet.delete(key); await Store.remove(key); }
  else { S.daySet.add(key); await Store.set(key, JSON.stringify(S.data)); }
  S.strip.set(key, totalsOf(S.data.e).k);
  S.history = null;
  await checkAchievements();
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
  host.innerHTML = `<div class="sheet-backdrop" ${top.noBack ? '' : 'data-a="back"'}></div><div class="sheet ${top.compact ? 'compact' : ''}"><div class="grabber"></div>
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
  return `<button class="row" data-a="${action}" ${extra}><div class="fic">${f.star ? '⭐' : catEmoji(f)}</div><div class="main"><div class="title">${esc(f.n)}</div><div class="sub">${esc(foodSub(f))}</div></div></button>`;
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
  const C = 2 * Math.PI * 52;
  const isToday = sameDay(S.day, startOfDay(new Date()));
  const macro = (label, v, goal, color) => {
    const r = 21, Cm = 2 * Math.PI * r, k = Math.min(v / Math.max(goal, 1), 1);
    return `<div class="macro">
      <div class="mring"><svg viewBox="0 0 54 54"><circle cx="27" cy="27" r="${r}" fill="none" stroke="rgba(255,255,255,.2)" stroke-width="6"/>
        <circle cx="27" cy="27" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${Cm}" stroke-dashoffset="${Cm * (1 - k)}" style="transition:stroke-dashoffset .8s"/></svg>
        <b>${Math.round((v / Math.max(goal, 1)) * 100)}%</b></div>
      <div class="label">${label}</div><div class="nums">${n0(v)} / ${n0(goal)} г</div></div>`;
  };

  const cupsTotal = Math.min(16, Math.max(4, Math.round(g.water / 250)));
  const cupsOn = Math.round(S.data.w / 250);
  const cups = Array.from({ length: cupsTotal }, (_, i) => `<button class="cup ${i < cupsOn ? 'on' : ''} ${i === cupsOn - 1 && S.popCup ? 'pop' : ''}" data-a="waterSet" data-n="${i + 1}" aria-label="${(i + 1) * 250} мл"></button>`).join('');

  const meals = MEALS.map((m) => {
    const items = S.data.e.map((e, i) => ({ e, i })).filter((x) => x.e.m === m.id);
    const sum = totalsOf(items.map((x) => x.e)).k;
    const prevItems = (S.prev.e || []).filter((e) => e.m === m.id);
    return `<div class="list meal">
        <div class="meal-h"><div class="badge">${m.i}</div><div class="name">${m.t}</div>
          <div class="kcal">${items.length ? `${n0(sum)} <span>ккал</span>` : ''}</div></div>
        ${items.map(({ e, i }) => { const x = per(e, e.g); return `<button class="row" data-a="edit" data-i="${i}">
          <div class="main"><div class="title">${esc(e.n)}</div><div class="sub">${n0(e.g)} г · Б ${n1(x.p)} · Ж ${n1(x.f)} · У ${n1(x.c)}</div></div>
          <div class="val">${n0(x.k)}</div></button>`; }).join('')}
        ${CFG.copyMeal && !items.length && prevItems.length ? `<button class="row copy" data-a="copyMeal" data-m="${m.id}"><span class="plus soft">↺</span>Как вчера · ${prevItems.length} ${plural(prevItems.length, 'продукт', 'продукта', 'продуктов')}, ${n0(totalsOf(prevItems).k)} ккал</button>` : ''}
        <button class="row add" data-a="add" data-m="${m.id}"><span class="plus">+</span>Добавить</button>
      </div>`;
  }).join('');

  const st = streak();
  const subtitle = cap(isToday ? `${WEEKDAYS[S.day.getDay()]}, ${dateText(S.day)}` : WEEKDAYS[S.day.getDay()]);
  const today = startOfDay(new Date());
  const strip = Array.from({ length: 21 }, (_, i) => addDays(today, i - 20)).map((d) => {
    const key = dayKey(d), sel = sameDay(d, S.day);
    const k = sel ? t.k : S.strip.get(key) || 0;
    const r = 15, Cd = 2 * Math.PI * r, q = Math.min(k / Math.max(g.kcal, 1), 1);
    return `<button class="dchip ${sel ? 'on' : ''} ${sameDay(d, today) ? 'now' : ''}" data-a="pickDay" data-d="${isoDate(d)}">
      <span>${['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.getDay()]}</span>
      <svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="${r}" fill="none" class="tr" stroke-width="3"/>
        ${k ? `<circle cx="18" cy="18" r="${r}" fill="none" class="pr ${k > g.kcal * 1.1 ? 'over' : ''}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${Cd}" stroke-dashoffset="${Cd * (1 - q)}" transform="rotate(-90 18 18)"/>` : ''}
        <text x="18" y="22.5" text-anchor="middle">${d.getDate()}</text></svg></button>`;
  }).join('');
  const banner = CFG.banner.on && CFG.banner.text ? `<div class="banner ${esc(CFG.banner.style)}">${esc(CFG.banner.text)}</div>` : '';
  return `<div class="top">
      <h1><span class="sub-title">${subtitle}</span>${dayTitle(S.day)}</h1>
      ${isToday ? `<button class="streak-chip ${st ? '' : 'off'}" data-a="streakInfo">🔥 ${st}</button>` : '<button class="pill-btn" data-a="today">Сегодня</button>'}
    </div>
    <div class="strip" id="strip">${strip}</div>
    ${banner}
    <div class="hero">
      <div class="summary">
        <div class="ring">
          <svg viewBox="0 0 120 120">
            <defs><linearGradient id="ringG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${left < 0 ? '#ffc2cf' : '#b8f1ff'}"/></linearGradient></defs>
            <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,.2)" stroke-width="11"/>
            <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="1" stroke-dasharray="2 5"/>
            <circle cx="60" cy="60" r="52" fill="none" stroke="url(#ringG)" stroke-width="11" stroke-linecap="round"
              stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}" style="transition:stroke-dashoffset .8s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 0 8px rgba(255,255,255,.7))"/>
          </svg>
          <div class="center"><div class="big" data-count="${Math.round(Math.abs(left))}">${n0(lastCount)}</div><div class="small">${left >= 0 ? 'ккал осталось' : 'сверх нормы'}</div></div>
        </div>
        <div>
          <div class="stat"><div class="label">Съедено</div><div class="value">${n0(t.k)} <span>ккал</span></div></div>
          <div class="stat"><div class="label">Норма</div><div class="value">${n0(g.kcal)} <span>ккал</span></div></div>
        </div>
      </div>
      <div class="macros">${macro('Белки', t.p, g.protein, 'var(--prot)')}${macro('Жиры', t.f, g.fat, 'var(--fat)')}${macro('Углев.', t.c, g.carbs, 'var(--carb)')}</div>
    </div>
    <div class="card">
      <div class="water-head">
        <div class="main"><b>💧 Вода</b><div class="sub">${n0(S.data.w)} из ${n0(g.water)} мл</div></div>
        <button class="round-btn" data-a="waterMinus" ${S.data.w <= 0 ? 'disabled' : ''} aria-label="Минус стакан">−</button>
        <button class="round-btn" data-a="waterPlus" aria-label="Плюс стакан">+</button>
      </div>
      <div class="cups">${cups}</div>
    </div>
    ${isToday && CFG.tips ? `<div class="card tip"><div class="ic">💡</div><div><b>Совет дня</b><p>${esc(tipOfDay())}</p></div></div>` : ''}
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
  if (!S.history.length) return `<div class="top"><h1>История</h1></div><div class="empty"><div class="em">📊</div><b>Пока пусто</b>Добавьте еду в дневник — здесь появится статистика.</div>`;

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
      fill="${x.k > g.kcal * 1.05 ? 'var(--fat)' : 'url(#barGrad)'}"/>
      ${i % 2 === 1 ? `<text x="${i * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${x.d.getDate()}</text>` : ''}`).join('');
  const week = S.history.filter((x) => x.date >= addDays(today, -6) && x.t.k > 0);
  const avg = week.length ? week.reduce((s, x) => s + x.t.k, 0) / week.length : 0;

  return `<div class="top"><h1>История</h1></div>
    <div class="section-h"><span>Последние 2 недели</span></div>
    <div class="card"><svg class="chart" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b8bff"/><stop offset="1" stop-color="#27c0f2"/></linearGradient></defs>${bars}
      <line x1="0" x2="${W}" y1="${y(g.kcal)}" y2="${y(g.kcal)}" stroke="var(--hint)" stroke-dasharray="5 4"/></svg></div>
    <div class="section-h"><span>Календарь</span><span>5 недель</span></div>
    <div class="card">${heatmapHTML(g)}</div>
    ${week.length ? `<div class="stats3"><div><b>${n0(avg)}</b><span>в среднем, ккал</span></div><div><b>${n0(g.kcal)}</b><span>норма, ккал</span></div><div><b>${week.length}</b><span>дней из 7</span></div></div>` : ''}
    <div class="section-h"><span>По дням</span></div>
    <div class="list">${S.history.map((x) => `<button class="row" data-a="openDay" data-d="${isoDate(x.date)}">
      <div class="main"><div class="title">${WEEKDAYS[x.date.getDay()].replace(/^./, (c) => c.toUpperCase())}, ${dateText(x.date)}</div>
      <div class="sub">Б ${n0(x.t.p)} · Ж ${n0(x.t.f)} · У ${n0(x.t.c)} · вода ${n0(x.w)} мл</div></div>
      <div class="val" style="${x.t.k > g.kcal * 1.05 ? 'color:var(--fat)' : ''}">${n0(x.t.k)} ккал</div></button>`).join('')}</div>`;
}

function heatmapHTML(g) {
  const today = startOfDay(new Date());
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const start = addDays(monday, -28);
  const byDay = new Map(S.history.map((x) => [isoDate(x.date), x.t.k]));
  const cells = [];
  for (let i = 0; i < 35; i++) {
    const d = addDays(start, i);
    const k = byDay.get(isoDate(d)) || 0;
    const r = k / Math.max(g.kcal, 1);
    let cls = !k ? '' : r > 1.1 ? 'over' : r >= 0.85 ? 'l3' : r >= 0.5 ? 'l2' : 'l1';
    if (sameDay(d, today)) cls += ' today';
    if (d > today) cls += ' future';
    cells.push(`<i class="${cls}" title="${dateText(d)}: ${n0(k)} ккал"></i>`);
  }
  return `<div class="heat">${['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((w) => `<div class="wd">${w}</div>`).join('')}${cells.join('')}</div>
    <div class="legend"><span><i style="background:rgba(42,116,245,.28)"></i>мало</span><span><i style="background:rgba(42,116,245,.55)"></i>половина</span>
    <span><i style="background:var(--grad)"></i>в норме</span><span><i style="background:linear-gradient(135deg,#ffcf5c,#ff9a3d)"></i>перебор</span></div>`;
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
      <defs><linearGradient id="wArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b8bff" stop-opacity=".28"/><stop offset="1" stop-color="#3b8bff" stop-opacity="0"/></linearGradient></defs>
      <path d="${line} L${px(pts[pts.length - 1][0]).toFixed(1)},${H - 20} L${px(pts[0][0]).toFixed(1)},${H - 20} Z" fill="url(#wArea)"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      ${pts.map((p) => `<circle cx="${px(p[0])}" cy="${py(p[1])}" r="4" fill="var(--card)" stroke="var(--accent)" stroke-width="2.5"/>`).join('')}
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
    : `<div class="empty"><div class="em">⚖️</div>Взвешивайтесь утром натощак раз в несколько дней — так график будет честнее.</div>`}`;
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
      <div class="main"><div class="title">${a.t}</div><div class="sub">${a.h}</div></div><div class="val accent">${p.activity === a.id ? '✓' : ''}</div></button>`).join('')}</div>
    <div class="section-h"><span>Цель</span></div>
    <div class="list">
      <div class="field">${segHTML('goal', GOALS.map((x) => [x.id, x.t]), p.goal)}</div>
      <button class="row" data-a="setP" data-k="custom" data-v="${p.custom ? '' : '1'}"><div class="main">Задать норму вручную</div><div class="val accent">${p.custom ? '✓' : ''}</div></button>
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
  const got = Object.keys(S.ach).length;
  const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  return `<div class="top"><h1><span class="sub-title">${u ? esc(u.first_name) + ' · ' : ''}прогресс и настройки</span>Профиль</h1></div>
    <div class="stats3">
      <div><b>🔥 ${streak()}</b><span>серия сейчас</span></div>
      <div><b>${bestStreak()}</b><span>рекорд, дней</span></div>
      <div><b>${S.daySet.size}</b><span>дней в дневнике</span></div>
    </div>
    ${CFG.achievements ? `<div class="section-h"><span>Достижения</span><span>${got} из ${ACH.length}</span></div>
    <div class="card"><div class="badges">${ACH.map((a) => `<button class="badge-item ${S.ach[a.id] ? 'on' : ''}" data-a="badge" data-id="${a.id}"><div class="medal">${a.i}</div><span>${a.t}</span></button>`).join('')}</div></div>` : ''}
    ${profileFormHTML(S.profile)}
    <div class="footnote">Записи хранятся в вашем облаке Telegram и видны только вам. База продуктов — встроенная (${BUILTIN.length}) и Open Food Facts (ODbL).</div>
    <div class="version" data-a="secret">${esc(CFG.title)} · версия ${APP_VERSION}${isAdmin() ? ' · <span data-a="openAdmin">🛠 панель</span>' : ''}</div>`;
}
function onboardingSheet() {
  return {
    title: '', noBack: true,
    render: () => `<div class="welcome"><div class="logo">${LOGO}</div><h2>Посчитаем вашу норму</h2>
      <p>Пара вопросов — и приложение рассчитает калории и БЖУ на день. Всё можно поменять позже в профиле.</p></div>
      ${profileFormHTML(S.profile)}<button class="btn" data-a="finishOnboarding">Начать</button>`,
    actions: {
      async finishOnboarding() { S.profile.onboarded = true; await saveProfile(); closeAllSheets(); render(); celebrate(); toast(`Ваша норма: ${n0(goals(S.profile).kcal)} ккал в день 🎉`); },
    },
  };
}

// ---------- Добавление еды ----------
function addFoodSheet(meal) {
  const st = { q: '', results: null, loading: false, error: null, searched: '', cat: null };
  const norm = (t) => t.toLowerCase().replace(/ё/g, 'е');
  const featured = () => (CFG.foods || []).map((f) => ({ ...f, star: true }));
  const local = () => {
    const q = norm(st.q.trim());
    const words = q.split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const seen = new Set();
    const scored = [];
    for (const f of [...featured(), ...S.custom, ...S.recent, ...BUILTIN]) {
      const name = norm(f.n), hay = name + ' ' + norm(f.b || '');
      if (!words.every((w) => hay.includes(w)) || seen.has(foodKey(f))) continue;
      seen.add(foodKey(f));
      const score = name.startsWith(q) ? 0 : name.split(/[\s(,-]+/).some((w) => w.startsWith(words[0])) ? 1 : 2;
      scored.push([score, name.length, f]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, 60).map((x) => x[2]);
  };
  let pool = [];
  const row = (f) => { pool.push(f); return foodRow(f, 'pick', `data-i="${pool.length - 1}"`); };
  const results = () => {
    pool = [];
    const q = st.q.trim();
    if (!q && st.cat != null) {
      const c = CATEGORIES[st.cat];
      return `<button class="pill-btn" data-a="catBack" style="margin-bottom:12px">‹ Все категории</button>
        <div class="section-h"><span>${c.emoji} ${c.name}</span><span>${c.count}</span></div>
        <div class="list">${BUILTIN.filter((f) => f.cat === st.cat).map(row).join('')}</div>`;
    }
    if (!q) {
      const fe = featured();
      return `<div class="quick">
          <button data-a="barcode"><span>🔢</span>По штрихкоду<small>цифры с упаковки</small></button>
          <button data-a="manual"><span>✍️</span>Свой продукт<small>КБЖУ с этикетки</small></button></div>
        ${fe.length ? `<div class="section-h"><span>⭐ Рекомендуем</span></div><div class="list">${fe.map(row).join('')}</div>` : ''}
        ${S.recent.length ? `<div class="section-h"><span>Недавние</span></div><div class="list">${S.recent.slice(0, 12).map(row).join('')}</div>` : ''}
        ${S.custom.length ? `<div class="section-h"><span>Мои продукты</span></div><div class="list">${S.custom.map(row).join('')}</div>` : ''}
        <div class="section-h"><span>Каталог</span><span>${BUILTIN.length} продуктов</span></div>
        <div class="cats">${CATEGORIES.map((c) => `<button data-a="cat" data-c="${c.id}"><span>${c.emoji}</span><b>${c.name}</b><small>${c.count}</small></button>`).join('')}</div>`;
    }
    const loc = local();
    let online;
    if (st.loading) online = `<div class="row"><div class="spinner"></div><div class="main" style="color:var(--hint)">Ищем в базе продуктов…</div></div>`;
    else if (st.error) online = `<div class="row"><div class="main" style="color:var(--hint)">${esc(st.error)}</div></div><button class="row add" data-a="search">Повторить</button>`;
    else if (st.results && st.searched === q) online = st.results.length ? st.results.map(row).join('') : `<div class="row"><div class="main" style="color:var(--hint)">Ничего не нашлось</div></div>`;
    else online = `<button class="row add" data-a="search"><span class="plus">🔍</span>Искать «${esc(q)}» в интернете</button>`;
    return `${loc.length ? `<div class="section-h"><span>Найдено</span><span>${loc.length}</span></div><div class="list">${loc.map(row).join('')}</div>` : ''}
      ${CFG.online ? `<div class="section-h"><span>🌐 Интернет-база</span></div><div class="list">${online}</div>` : ''}
      <div class="list"><button class="row add" data-a="manual"><span class="plus">✍️</span>Создать «${esc(q)}» вручную</button></div>`;
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
    render: () => `<div class="search-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input class="search" id="foodSearch" type="search" enterkeyhint="search" placeholder="Продукт или бренд" value="${esc(st.q)}" autocomplete="off"></div>
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
      cat(d) { st.cat = +d.c; update(); document.querySelector('#sheets .sheet').scrollTo(0, 0); },
      catBack() { st.cat = null; update(); },
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
    render: () => `<div class="card food-card"><div class="ic">🍽️</div><div><b>${esc(food.n)}</b><small>${esc(foodSub(food))}</small></div></div>
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
    render: () => `<div class="card food-card"><div class="ic">🍽️</div><div><b>${esc(e.n)}</b>${e.b ? `<small>${esc(e.b)}</small>` : ''}</div></div>
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
        checkAchievements();
        sheets.pop();
        openSheet(amountSheet(food, meal));
      },
    },
  };
}

// ---------- Фирменные мелочи: логотип, советы, серия, достижения, конфетти, приветствие ----------
const LOGO = `<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="logoG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6fe0ff"/><stop offset="1" stop-color="#2a63f5"/></linearGradient></defs>
  <rect width="48" height="48" rx="15" fill="url(#logoG)"/>
  <circle cx="24" cy="24" r="13" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="4.5"/>
  <path d="M24 11a13 13 0 1 1-12.6 9.8" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M24.5 30.5c-4.6-.6-7-4-6.2-8.8 4.8-.6 8 2 8.4 6.4.1.9-.1 1.7-.5 2.4z" fill="#fff"/></svg>`;

const TIPS = [
  'Стакан воды перед едой помогает не переесть.',
  'Белок в каждом приёме пищи дольше сохраняет сытость.',
  'Взвешивайтесь в одно и то же время — утром, натощак.',
  'Записывайте еду сразу, а не вечером — так точнее.',
  'Половина тарелки — овощи, четверть — белок, четверть — гарнир.',
  'Сон меньше 7 часов усиливает аппетит на следующий день.',
  'Масло — самый незаметный источник калорий: 1 ложка ≈ 90 ккал.',
  'Сладкие напитки — пустые калории. Попробуйте воду с лимоном.',
  'Медленная еда: сигнал сытости приходит через 15–20 минут.',
  'Колебания веса ±1 кг за день — это вода, а не жир.',
  'Перекус с белком (творог, йогурт) лучше, чем печенье.',
  'Планируйте ужин заранее — меньше соблазна заказать доставку.',
  'Прогулка 30 минут ≈ 120–150 ккал и отличное настроение.',
  'Не морите себя голодом: слишком жёсткий дефицит тормозит прогресс.',
  'Соусы и заправки тоже считаются — их легко забыть.',
  'Держите полезный перекус под рукой: орехи, фрукты, йогурт.',
  'Один «плохой» день ничего не портит. Важна неделя целиком.',
  'Клетчатка из овощей и круп помогает пищеварению и сытости.',
  'Алкоголь — 7 ккал на грамм и сильный стимулятор аппетита.',
  'Сравнивайте себя с собой месяц назад, а не с другими.',
  'Готовьте больше белка впрок — курица, яйца, творог.',
  'Фрукты лучше есть целиком, а не пить соком.',
];
const tipOfDay = () => TIPS[Math.floor(startOfDay(new Date()).getTime() / 864e5) % TIPS.length];
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };
function suggestedMeal() {
  const h = new Date().getHours();
  return h >= 4 && h < 11 ? 'b' : h < 16 ? 'l' : h < 22 ? 'd' : 's';
}

// Серия: дни подряд, в которые были записи (сегодня ещё можно успеть).
const hasDay = (d) => S.daySet.has(dayKey(d));
function streak() {
  let d = startOfDay(new Date());
  if (!hasDay(d)) d = addDays(d, -1);
  let n = 0;
  while (hasDay(d)) { n++; d = addDays(d, -1); }
  return n;
}
function bestStreak() {
  let best = 0, cur = 0, prev = null;
  for (const k of [...S.daySet].sort()) {
    const d = keyToDate(k);
    cur = prev && sameDay(addDays(prev, 1), d) ? cur + 1 : 1;
    best = Math.max(best, cur);
    prev = d;
  }
  return best;
}

const ACH = [
  { id: 'first', i: '🍽️', t: 'Первый шаг', d: 'Добавить первую запись', ok: () => S.data.e.length > 0 },
  { id: 's3', i: '🔥', t: 'Разгон', d: '3 дня подряд', ok: () => streak() >= 3 },
  { id: 's7', i: '⚡', t: 'Неделя', d: '7 дней подряд', ok: () => streak() >= 7 },
  { id: 's30', i: '👑', t: 'Легенда', d: '30 дней подряд', ok: () => streak() >= 30 },
  { id: 'water', i: '💧', t: 'Водный баланс', d: 'Выпить норму воды за день', ok: () => S.data.w >= goals(S.profile).water },
  { id: 'target', i: '🎯', t: 'В точку', d: 'Съесть 90–110% нормы калорий', ok: () => { const r = totalsOf(S.data.e).k / goals(S.profile).kcal; return r >= 0.9 && r <= 1.1; } },
  { id: 'protein', i: '💪', t: 'Белковый день', d: 'Выполнить норму белка', ok: () => totalsOf(S.data.e).p >= goals(S.profile).protein },
  { id: 'early', i: '🐦', t: 'Ранняя пташка', d: 'Записать завтрак до 9 утра', ok: () => S.data.e.some((e) => e.m === 'b' && e.t && new Date(e.t).getHours() < 9) },
  { id: 'scale', i: '⚖️', t: 'На весах', d: 'Записать свой вес', ok: () => S.weights.length > 0 },
  { id: 'chef', i: '👨‍🍳', t: 'Шеф', d: 'Создать свой продукт', ok: () => S.custom.length > 0 },
  { id: 'gourmet', i: '🍱', t: 'Гурман', d: 'Попробовать 10 разных продуктов', ok: () => S.recent.length >= 10 },
  { id: 'loyal', i: '💎', t: 'Постоянство', d: 'Вести дневник 14 дней', ok: () => S.daySet.size >= 14 },
];
async function checkAchievements() {
  if (!CFG.achievements) return;
  const fresh = ACH.filter((a) => !S.ach[a.id] && a.ok());
  if (!fresh.length) return;
  fresh.forEach((a) => { S.ach[a.id] = Date.now(); });
  celebrate();
  haptic('success');
  toast(`🏆 ${fresh[0].i} ${fresh[0].t} — ${fresh[0].d.toLowerCase()}${fresh.length > 1 ? ` (+${fresh.length - 1})` : ''}`);
  if (S.tab === 'profile' && !sheets.length) render();
  await Store.set('ach', JSON.stringify(S.ach));
}

function celebrate() {
  if (!CFG.confetti) return;
  const c = $('#confetti');
  const ctx = c.getContext('2d');
  const W = innerWidth, H = innerHeight, dpr = devicePixelRatio || 1;
  c.width = W * dpr; c.height = H * dpr; ctx.scale(dpr, dpr);
  const colors = ['#2a74f5', '#1fc3ee', '#6fe0ff', '#8a6bff', '#ffcf5c', '#ff6b8b'];
  const parts = Array.from({ length: 140 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * 120, y: H * 0.38,
    vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 5,
    r: 5 + Math.random() * 6, c: colors[(Math.random() * colors.length) | 0],
    rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.35, sq: Math.random() < 0.6,
  }));
  const t0 = performance.now();
  (function frame(now) {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.32; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c;
      if (p.sq) ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); else { ctx.beginPath(); ctx.arc(0, 0, p.r / 2.4, 0, 7); ctx.fill(); }
      ctx.restore();
    }
    if (now - t0 < 2800) requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
  })(t0);
}

// Плавный счётчик для больших чисел.
let lastCount = 0;
function animateCounts() {
  const el = document.querySelector('[data-count]');
  if (!el) return;
  const to = +el.dataset.count, from = lastCount, t0 = performance.now(), dur = 650;
  lastCount = to;
  if (from === to) return;
  (function step(now) {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = n0(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}

function showWelcome() {
  const el = $('#welcome');
  const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  const name = (u && u.first_name) || 'Друг';
  const h = new Date().getHours();
  const [greet, emoji] = h >= 5 && h < 12 ? ['Доброе утро', '☀️'] : h >= 12 && h < 17 ? ['Добрый день', '🌤'] : h >= 17 && h < 23 ? ['Добрый вечер', '🌆'] : ['Доброй ночи', '🌙'];
  const d = new Date();
  const g = goals(S.profile), t = totalsOf(S.data.e), st = streak();
  const first = !S.profile.onboarded;
  const delay = (s) => `style="animation-delay:${s}s"`;
  el.innerHTML = `<div class="orb a"></div><div class="orb b"></div>
    <div class="w-logo up">${LOGO}${esc(CFG.title)}</div>
    <div class="w-greet up" ${delay(0.05)}>${greet} ${emoji}</div>
    <div class="w-name up" ${delay(0.12)}>${esc(name)}</div>
    <div class="w-date up" ${delay(0.18)}>${cap(WEEKDAYS[d.getDay()])}, ${dateText(d)}</div>
    ${CFG.welcomeText ? `<div class="w-custom up" ${delay(0.22)}>${esc(CFG.welcomeText)}</div>` : ''}
    ${first
      ? `<div class="w-tip up" ${delay(0.26)}><b>Добро пожаловать</b>Посчитаем вашу норму калорий и БЖУ — это меньше минуты. Дальше просто добавляйте еду.</div>`
      : `<div class="w-stats up" ${delay(0.26)}>
          <div><b>${st ? '🔥 ' + st : '—'}</b><span>${st ? plural(st, 'день', 'дня', 'дней') + ' подряд' : 'начните серию'}</span></div>
          <div><b>${n0(Math.max(0, g.kcal - t.k))}</b><span>ккал осталось</span></div>
          ${CFG.achievements ? `<div><b>${Object.keys(S.ach).length}/${ACH.length}</b><span>достижений</span></div>` : `<div><b>${n0(S.data.w)}</b><span>мл воды</span></div>`}</div>
        ${CFG.tips ? `<div class="w-tip up" ${delay(0.34)}><b>💡 Совет дня</b>${esc(tipOfDay())}</div>` : ''}`}
    <button class="btn up" ${delay(0.42)} data-a="closeWelcome">${first ? 'Начать' : 'Открыть дневник'}</button>`;
  el.hidden = false;
}

// ---------- Глобальные настройки (меняются владельцем в скрытой панели) ----------
const APP_VERSION = '3.1';
const DEFAULT_CONFIG = {
  title: 'Калории',
  theme: 'ice',
  welcome: true,
  welcomeText: '',
  tips: true,
  achievements: true,
  confetti: true,
  copyMeal: true,
  online: true,
  banner: { on: false, text: '', style: 'info' },
  maintenance: { on: false, text: 'Скоро вернёмся — идут технические работы 🛠' },
  foods: [],
};
const THEMES = [
  { id: 'ice', t: 'Лёд', c: 'linear-gradient(135deg,#2563ff,#1fc3ee)' },
  { id: 'ocean', t: 'Океан', c: 'linear-gradient(135deg,#0b5ed7,#00b4a6)' },
  { id: 'sapphire', t: 'Сапфир', c: 'linear-gradient(135deg,#3b2fd9,#3d8bff)' },
  { id: 'sky', t: 'Небо', c: 'linear-gradient(135deg,#4aa8ff,#8fd8ff)' },
];
const mergeConfig = (c) => ({ ...DEFAULT_CONFIG, ...(c || {}), banner: { ...DEFAULT_CONFIG.banner, ...((c && c.banner) || {}) }, maintenance: { ...DEFAULT_CONFIG.maintenance, ...((c && c.maintenance) || {}) } });
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
let CFG = mergeConfig(parse(lsGet(API_URL ? 'kal_cfg_cache' : 'kal_cfg_local'), {}));
const isAdmin = () => lsGet('kal_admin') === '1';

function applyConfig() {
  document.documentElement.dataset.accent = CFG.theme || 'ice';
  document.title = CFG.title || 'Калории';
}
/** Загружает настройки с сервера. Возвращает true, если они изменились. */
async function loadServerConfig(timeout = 4000) {
  if (!API_URL) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(`${API_URL}/api/config?t=${Date.now()}`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!r.ok) return false;
    const text = JSON.stringify(await r.json());
    if (text === lsGet('kal_cfg_cache')) return false;
    lsSet('kal_cfg_cache', text);
    CFG = mergeConfig(JSON.parse(text));
    applyConfig();
    return true;
  } catch { return false; }
}
/** Применяет свежие настройки к уже открытому приложению (в т.ч. включает/выключает заглушку). */
async function refreshConfig() {
  if (!(await loadServerConfig())) return;
  const blocked = CFG.maintenance.on && !isAdmin();
  if (blocked) { closeAllSheets(); return showMaintenance(); }
  if (document.querySelector('.maint')) { render(); return; }
  if (!sheets.length) render();
}
/** Диагностика для панели владельца. */
async function checkServer() {
  if (!API_URL) return 'Адрес сервера не задан в приложении.';
  try {
    const r = await fetch(`${API_URL}/api/config?t=${Date.now()}`, { cache: 'no-store' });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { return `Сервер отвечает (${r.status}), но это старая версия кода воркера. Обновите код в Cloudflare (Edit code → вставить заново → Deploy).`; }
    const keys = Object.keys(j);
    if (!keys.length) return '✅ Сервер работает. Настройки ещё ни разу не сохранялись — нажмите «Сохранить для всех».';
    return `✅ Сервер работает. На сервере сохранено: тех. работы — ${j.maintenance && j.maintenance.on ? 'ВКЛ' : 'выкл'}, баннер — ${j.banner && j.banner.on ? 'ВКЛ' : 'выкл'}, тема — ${j.theme || 'ice'}, своих продуктов — ${(j.foods || []).length}.`;
  } catch (e) { return 'Не удалось связаться с сервером: ' + (e && e.message ? e.message : 'ошибка сети'); }
}
async function saveConfig(next) {
  if (!API_URL) {
    lsSet('kal_cfg_local', JSON.stringify(next));
    CFG = mergeConfig(next);
    return { ok: true, local: true };
  }
  if (!inTelegram) return { ok: false, error: 'Сохранять можно только из Telegram' };
  try {
    const r = await fetch(API_URL + '/api/config', { method: 'POST', body: JSON.stringify({ initData: tg.initData, config: next }) });
    const j = await r.json();
    if (j.ok) { lsSet('kal_cfg_cache', JSON.stringify(next)); CFG = mergeConfig(next); try { localStorage.removeItem('kal_cfg_local'); } catch {} }
    return j;
  } catch { return { ok: false, error: 'Нет связи с сервером' }; }
}
async function fetchStats() {
  if (!API_URL || !inTelegram) return null;
  try {
    const r = await fetch(API_URL + '/api/stats', { method: 'POST', body: JSON.stringify({ initData: tg.initData }) });
    return await r.json();
  } catch { return { ok: false, error: 'Нет связи с сервером' }; }
}

// ---------- Секретный вход: 10 нажатий на версию + PIN ----------
let secretTaps = 0, secretTimer;
function secretTap() {
  secretTaps++;
  clearTimeout(secretTimer);
  secretTimer = setTimeout(() => { secretTaps = 0; }, 2500);
  if (secretTaps >= 5 && secretTaps < 10) haptic();
  if (secretTaps >= 10) {
    secretTaps = 0;
    haptic('success');
    openSheet(pinSheet());
  }
}
function pinSheet() {
  const st = { pin: '', err: false };
  const PIN = '777777';
  const dots = () => Array.from({ length: 6 }, (_, i) => `<i class="${i < st.pin.length ? 'on' : ''}"></i>`).join('');
  const press = (k) => {
    if (k === 'del') st.pin = st.pin.slice(0, -1);
    else if (st.pin.length < 6) st.pin += k;
    st.err = false;
    haptic();
    if (st.pin.length === 6) {
      if (st.pin === PIN) {
        lsSet('kal_admin', '1');
        haptic('success');
        sheets.pop();
        openSheet(adminSheet());
        return;
      }
      st.err = true;
      st.pin = '';
      try { tg.HapticFeedback.notificationOccurred('error'); } catch {}
    }
    refreshSheet();
  };
  return {
    title: 'Доступ владельца',
    render: () => `<div class="pin">
        <div class="pin-lock">🔐</div>
        <p>Введите код доступа</p>
        <div class="pin-dots ${st.err ? 'shake' : ''}">${dots()}</div>
        <div class="pin-err">${st.err ? 'Неверный код' : ''}</div>
        <div class="pin-pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k) => k ? `<button data-a="pinKey" data-k="${k}">${k === 'del' ? '⌫' : k}</button>` : '<span></span>').join('')}</div>
      </div>`,
    actions: { pinKey: (d) => press(d.k) },
  };
}

function adminSheet() {
  // Настройки, сохранённые до подключения сервера, подтягиваем в черновик, чтобы отправить их всем.
  const pendingLocal = API_URL ? parse(lsGet('kal_cfg_local'), null) : null;
  const draft = JSON.parse(JSON.stringify(pendingLocal ? mergeConfig(pendingLocal) : CFG));
  const st = { stats: null, statsLoading: false, saving: false, msg: '', food: { n: '', k: '', p: '', f: '', c: '' }, importText: '' };
  const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  const sw = (key, label, sub) => {
    const val = key.split('.').reduce((o, k) => o[k], draft);
    return `<button class="row" data-a="toggle" data-k="${key}"><div class="main"><div class="title">${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div><span class="switch ${val ? 'on' : ''}"><i></i></span></button>`;
  };
  const loadStats = async () => {
    st.statsLoading = true; refreshSheet();
    st.stats = await fetchStats();
    st.statsLoading = false; refreshSheet();
  };
  return {
    title: '🛠 Владелец',
    render: () => {
      const s = st.stats;
      return `
      <div class="card admin-status">
        <div class="row-flat"><span>Сервер</span><b class="${API_URL ? 'ok' : 'warn'}">${API_URL ? '● подключён' : '● не подключён'}</b></div>
        <div class="row-flat"><span>Ваш Telegram ID</span><b>${u ? u.id : '—'}</b></div>
        <div class="row-flat"><span>Версия</span><b>${APP_VERSION}</b></div>
        ${st.check ? `<p class="hint">${esc(st.check)}</p>` : ''}
        ${API_URL ? '<button class="btn ghost" style="margin:10px 0 0" data-a="checkSrv">Проверить сервер</button>' : ''}
        ${pendingLocal ? '<p class="hint">Загружены настройки, сохранённые на этом телефоне до подключения сервера. Нажмите «Сохранить для всех» внизу.</p>' : ''}
        ${API_URL ? '' : '<p class="hint">Без сервера настройки сохраняются только на этом устройстве. Пришлите адрес Cloudflare-воркера — и они будут применяться у всех.</p>'}
      </div>

      <div class="section-h"><span>📊 Статистика</span></div>
      <div class="card">
        ${!API_URL ? '<p class="hint" style="margin:0">Доступна после подключения сервера.</p>'
          : st.statsLoading ? '<div class="spinner" style="margin:6px auto"></div>'
          : s && s.ok ? `<div class="stats3 in">
              <div><b>${s.total}</b><span>всего</span></div><div><b>${s.new24}</b><span>новых за 24ч</span></div><div><b>${s.active24}</b><span>активных 24ч</span></div>
              <div><b>${s.new7}</b><span>новых за 7д</span></div><div><b>${s.appUsers}</b><span>открывали app</span></div><div><b>${s.opens}</b><span>открытий</span></div></div>
              ${(s.latest || []).map((x) => `<div class="row-flat"><span>${esc(x.n || 'Без имени')}${x.u ? ' @' + esc(x.u) : ''}</span><b>📱${x.o}</b></div>`).join('')}`
          : `<p class="hint" style="margin:0 0 10px">${s ? esc(s.error || 'Ошибка') : 'Нажмите, чтобы загрузить'}</p><button class="btn ghost" data-a="loadStats">Загрузить статистику</button>`}
      </div>

      <div class="section-h"><span>📣 Объявление для всех</span></div>
      <div class="list">
        ${sw('banner.on', 'Показывать баннер', 'Появится вверху дневника у всех пользователей')}
        <div class="field"><textarea data-cfg="banner.text" rows="3" placeholder="Например: Добавили 600 продуктов! 🎉">${esc(draft.banner.text)}</textarea></div>
        <div class="field"><div class="seg">${[['info', 'Инфо'], ['promo', 'Акция'], ['warn', 'Важно']].map(([v, t]) => `<button data-a="cfgSet" data-k="banner.style" data-v="${v}" class="${draft.banner.style === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      </div>

      <div class="section-h"><span>🎨 Оформление</span></div>
      <div class="card"><div class="themes">${THEMES.map((t) => `<button class="theme-dot ${draft.theme === t.id ? 'on' : ''}" data-a="cfgSet" data-k="theme" data-v="${t.id}"><i style="background:${t.c}"></i>${t.t}</button>`).join('')}</div></div>
      <div class="list">
        <div class="field"><label>Название</label><input class="wide" style="text-align:right" data-cfg="title" value="${esc(draft.title)}" maxlength="24"></div>
        <div class="field"><textarea data-cfg="welcomeText" rows="2" placeholder="Своя фраза на экране приветствия (необязательно)">${esc(draft.welcomeText)}</textarea></div>
      </div>

      <div class="section-h"><span>⚙️ Функции</span></div>
      <div class="list">
        ${sw('welcome', 'Экран приветствия', 'При каждом открытии')}
        ${sw('tips', 'Совет дня')}
        ${sw('achievements', 'Достижения')}
        ${sw('confetti', 'Конфетти')}
        ${sw('copyMeal', '«Как вчера»', 'Повтор вчерашнего приёма пищи')}
        ${sw('online', 'Поиск в интернете', 'База Open Food Facts')}
      </div>

      <div class="section-h"><span>⭐ Свои продукты для всех</span><span>${draft.foods.length}</span></div>
      <div class="list">
        ${draft.foods.map((f, i) => `<div class="row"><div class="fic">⭐</div><div class="main"><div class="title">${esc(f.n)}</div><div class="sub">${n0(f.k)} ккал · Б ${n1(f.p)} Ж ${n1(f.f)} У ${n1(f.c)}</div></div><button class="link-btn" style="color:var(--danger)" data-a="delFood" data-i="${i}">✕</button></div>`).join('')}
        <div class="field"><input class="wide" data-food="n" placeholder="Название продукта или блюда" value="${esc(st.food.n)}"></div>
        <div class="field mini4">${[['k', 'ккал'], ['p', 'Б'], ['f', 'Ж'], ['c', 'У']].map(([k, t]) => `<input data-food="${k}" inputmode="decimal" placeholder="${t}" value="${esc(st.food[k])}">`).join('')}</div>
        <button class="row add" data-a="addFood"><span class="plus">+</span>Добавить в общую базу</button>
      </div>

      <div class="section-h"><span>🚧 Тех. работы</span></div>
      <div class="list">
        ${sw('maintenance.on', 'Режим обслуживания', 'Пользователи увидят заглушку. Вы — нет.')}
        <div class="field"><textarea data-cfg="maintenance.text" rows="2">${esc(draft.maintenance.text)}</textarea></div>
      </div>

      ${st.msg ? `<div class="card admin-msg">${esc(st.msg)}</div>` : ''}
      <button class="btn" data-a="saveCfg" ${st.saving ? 'disabled' : ''}>${st.saving ? 'Сохраняем…' : API_URL ? 'Сохранить для всех' : 'Сохранить'}</button>

      <div class="section-h"><span>🧰 Инструменты (мои данные)</span></div>
      <div class="list">
        <button class="row" data-a="exportData"><div class="fic">📤</div><div class="main"><div class="title">Экспорт данных</div><div class="sub">Скопировать все записи в буфер</div></div></button>
        <div class="field"><textarea data-imp rows="2" placeholder="Вставьте экспорт сюда для импорта">${esc(st.importText)}</textarea></div>
        <button class="row" data-a="importData"><div class="fic">📥</div><div class="main"><div class="title">Импорт данных</div></div></button>
        <button class="row" data-a="demoData"><div class="fic">🧪</div><div class="main"><div class="title">Заполнить демо-данными</div><div class="sub">2 недели записей для проверки графиков</div></div></button>
        <button class="row" data-a="resetAch"><div class="fic">🏆</div><div class="main"><div class="title">Сбросить достижения</div></div></button>
        <button class="row" data-a="wipe"><div class="fic">🗑</div><div class="main"><div class="title" style="color:var(--danger)">Удалить все мои данные</div></div></button>
        <button class="row" data-a="logoutAdmin"><div class="fic">🔒</div><div class="main"><div class="title">Выйти из режима владельца</div></div></button>
      </div>`;
    },
    mount(el) {
      el.querySelectorAll('[data-cfg]').forEach((inp) => inp.addEventListener('input', () => {
        const path = inp.dataset.cfg.split('.');
        const last = path.pop();
        path.reduce((o, k) => o[k], draft)[last] = inp.value;
      }));
      el.querySelectorAll('[data-food]').forEach((inp) => inp.addEventListener('input', () => { st.food[inp.dataset.food] = inp.value; }));
      const imp = el.querySelector('[data-imp]');
      if (imp) imp.addEventListener('input', () => { st.importText = imp.value; });
    },
    actions: {
      toggle(d) {
        const path = d.k.split('.');
        const last = path.pop();
        const o = path.reduce((x, k) => x[k], draft);
        o[last] = !o[last];
        haptic(); refreshSheet();
      },
      cfgSet(d) {
        const path = d.k.split('.');
        const last = path.pop();
        path.reduce((x, k) => x[k], draft)[last] = d.v;
        if (d.k === 'theme') document.documentElement.dataset.accent = d.v;
        haptic(); refreshSheet();
      },
      loadStats,
      async checkSrv() { st.check = 'Проверяем…'; refreshSheet(); st.check = await checkServer(); refreshSheet(); },
      addFood() {
        const f = st.food;
        const k = num(f.k) || num(f.p) * 4 + num(f.f) * 9 + num(f.c) * 4;
        if (!f.n.trim() || k <= 0) return toast('Нужно название и калории');
        draft.foods.push({ n: f.n.trim(), k, p: num(f.p), f: num(f.f), c: num(f.c) });
        st.food = { n: '', k: '', p: '', f: '', c: '' };
        haptic('success'); refreshSheet();
      },
      delFood(d) { draft.foods.splice(+d.i, 1); refreshSheet(); },
      async saveCfg() {
        st.saving = true; st.msg = ''; refreshSheet();
        const r = await saveConfig(draft);
        st.saving = false;
        st.msg = r.ok ? (r.local ? '✅ Сохранено на этом устройстве' : `✅ Сохранено на сервере — пользователи увидят изменения при открытии приложения${draft.maintenance.on ? '. Заглушку вы не видите, потому что вы владелец.' : ''}`) : '⚠️ ' + (r.error || 'Ошибка');
        if (r.ok) { haptic('success'); applyConfig(); render(); }
        refreshSheet();
      },
      async exportData() {
        const keys = await Store.keys();
        const vals = await Store.get(keys);
        const text = JSON.stringify(vals);
        try { await navigator.clipboard.writeText(text); toast(`Скопировано: ${keys.length} записей`); }
        catch { st.importText = text; refreshSheet(); toast('Скопируйте текст из поля импорта'); }
      },
      async importData() {
        const data = parse(st.importText, null);
        if (!data || typeof data !== 'object') return toast('Неверный формат');
        for (const [k, v] of Object.entries(data)) if (v) await Store.set(k, v);
        toast('Импортировано — перезапуск…');
        setTimeout(() => location.reload(), 800);
      },
      async demoData() {
        const today = startOfDay(new Date());
        for (let i = 1; i <= 14; i++) {
          const d = addDays(today, -i);
          const pick = (n) => BUILTIN.find((f) => f.n === n);
          const e = [['Овсянка на молоке', 250, 'b'], ['Банан', 120, 'b'], ['Гречка с мясом', 300, 'l'], ['Салат Греческий', 150, 'l'], ['Куриная грудка запечённая', 180, 'd'], ['Рис басмати варёный', 150, 'd'], ['Йогурт греческий 2%', 150, 's']]
            .map(([n, g, m], j) => ({ ...plainFood(pick(n)), g: Math.round(g * (0.7 + Math.random() * 0.6)), m, t: d.getTime() + 8 * 3600e3 + j * 3600e3 }));
          await Store.set(dayKey(d), JSON.stringify({ e, w: 250 * (4 + Math.floor(Math.random() * 5)) }));
          S.daySet.add(dayKey(d));
        }
        toast('Готово — перезапуск…');
        setTimeout(() => location.reload(), 800);
      },
      async resetAch() { S.ach = {}; await Store.set('ach', '{}'); toast('Достижения сброшены'); },
      async wipe() {
        const ok = await new Promise((res) => {
          try { tg.showConfirm('Удалить ВСЕ ваши записи, вес и профиль? Это необратимо.', res); }
          catch { res(window.confirm('Удалить ВСЕ ваши записи, вес и профиль?')); }
        });
        if (!ok) return;
        for (const k of await Store.keys()) await Store.remove(k);
        toast('Данные удалены');
        setTimeout(() => location.reload(), 800);
      },
      logoutAdmin() { try { localStorage.removeItem('kal_admin'); } catch {} closeAllSheets(); toast('Режим владельца выключен'); },
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
  const tab = ([id, t]) => `<button class="tab ${S.tab === id ? 'on' : ''}" data-a="tab" data-t="${id}"><svg viewBox="0 0 24 24">${TAB_ICONS[id]}</svg>${t}</button>`;
  $('#tabs').innerHTML = TABS.slice(0, 2).map(tab).join('') + '<button class="fab" data-a="quickAdd" aria-label="Добавить еду">+</button>' + TABS.slice(2).map(tab).join('');
  if (S.tab === 'diary') {
    animateCounts();
    const strip = $('#strip'), on = strip && strip.querySelector('.on');
    if (on) strip.scrollLeft = on.offsetLeft - strip.clientWidth / 2 + on.clientWidth / 2;
  }
  S.popCup = false;
}

async function setWater(ml) {
  const goal = goals(S.profile).water;
  const reached = S.data.w < goal && ml >= goal;
  S.popCup = ml > S.data.w;
  S.data.w = ml;
  haptic(reached ? 'success' : undefined);
  render();
  if (reached) { celebrate(); toast('💧 Норма воды выполнена!'); }
  await saveDay();
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
  async waterPlus() { await setWater(S.data.w + 250); },
  async waterSet(d) { const n = +d.n; const cur = Math.round(S.data.w / 250); await setWater((cur === n ? n - 1 : n) * 250); },
  async waterMinus() { await setWater(Math.max(0, S.data.w - 250)); },
  async pickDay(d) { haptic(); await loadDay(parseIso(d.d)); render(); },
  secret() { secretTap(); },
  openAdmin(d, el) { secretTaps = 0; openSheet(adminSheet()); },
  quickAdd() { openSheet(addFoodSheet(suggestedMeal())); },
  streakInfo() { const st = streak(); toast(st ? `🔥 ${st} ${plural(st, 'день', 'дня', 'дней')} подряд · рекорд ${bestStreak()}` : 'Добавьте еду сегодня — начнётся серия 🔥'); },
  badge(d) { const a = ACH.find((x) => x.id === d.id); toast(`${a.i} ${a.t}: ${a.d}${S.ach[a.id] ? ' ✓' : ''}`); },
  closeWelcome() {
    const el = $('#welcome');
    el.classList.add('hide');
    setTimeout(() => { el.hidden = true; el.classList.remove('hide'); el.innerHTML = ''; }, 450);
    haptic();
    if (!S.profile.onboarded) openSheet(onboardingSheet());
    else checkAchievements();
  },
  async copyMeal(d) {
    const items = S.prev.e.filter((e) => e.m === d.m);
    const now = Date.now();
    items.forEach((e, i) => S.data.e.push({ ...e, t: now + i }));
    haptic('success');
    render();
    toast(`Добавлено как вчера: ${items.length}`);
    await saveDay();
  },
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
    await checkAchievements();
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
  applyTheme();
  applyConfig();
  if (tg) {
    try { tg.onEvent('themeChanged', applyTheme); } catch {}
    try { tg.ready(); tg.expand(); } catch {}
    try { if (tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes(); } catch {}
    try { tg.BackButton.onClick(() => { if (sheets.length) closeSheet(); }); } catch {}
  }
  $('#app').innerHTML = '<div class="empty"><div class="spinner" style="margin:0 auto"></div></div>';
  const [v, keys] = await Promise.all([Store.get(['profile', 'recent', 'custom', 'weights', 'ach']), Store.keys()]);
  S.daySet = new Set(keys.filter((k) => /^d_\d{8}$/.test(k)));
  S.ach = parse(v.ach, {});
  S.profile = { ...DEFAULT_PROFILE, ...parse(v.profile, {}) };
  S.recent = parse(v.recent, []);
  S.custom = parse(v.custom, []);
  S.weights = parse(v.weights, []);
  const stripKeys = Array.from({ length: 21 }, (_, i) => dayKey(addDays(startOfDay(new Date()), -i))).filter((k) => S.daySet.has(k));
  const stripVals = await Store.get(stripKeys);
  for (const k of stripKeys) S.strip.set(k, totalsOf(parse(stripVals[k], { e: [] }).e || []).k);
  // Свежие настройки с сервера (не дольше 2,5 с) — чтобы заглушка и баннер работали сразу.
  await Promise.all([loadDay(new Date()), loadServerConfig(2500)]);
  if (CFG.maintenance.on && !isAdmin()) return showMaintenance();
  render();
  if (CFG.welcome || !S.profile.onboarded) showWelcome();
  // Повторная проверка при возвращении в приложение и раз в минуту.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshConfig(); });
  setInterval(refreshConfig, 60000);
  if (API_URL && inTelegram) fetch(API_URL + '/api/open', { method: 'POST', body: tg.initData }).catch(() => {});
}

function showMaintenance() {
  $('#tabs').innerHTML = '';
  $('#app').innerHTML = `<div class="maint"><div class="logo-big">${LOGO}</div><h2>${esc(CFG.title)}</h2><p>${esc(CFG.maintenance.text)}</p>
    <div class="version" data-a="secret">версия ${APP_VERSION}</div></div>`;
}

function applyTheme() {
  const dark = tg && tg.colorScheme ? tg.colorScheme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const bg = dark ? '#0a1322' : '#edf4ff';
  try { tg.setHeaderColor(bg); tg.setBackgroundColor(bg); } catch {}
  try { if (tg.isVersionAtLeast('7.10')) tg.setBottomBarColor(bg); } catch {}
}
init();
