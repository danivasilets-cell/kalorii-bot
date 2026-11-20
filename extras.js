'use strict';
/* ============================================================
   v5: подсказки к остатку, шаблоны дня, темп к цели, активность, голодание,
   замеры тела, приглашения, челленджи, карточка недели, синхронизация итогов.
   ============================================================ */

// ---------- Учёт использования функций (отправляется пачкой) ----------
const usage = {};
function track(f) { usage[f] = (usage[f] || 0) + 1; syncSoon(); }
let syncTimer = null, lastSync = 0, dayDirty = true;
function syncSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 20000); }
async function syncNow() {
  if (!API_URL || !inTelegram) return;
  const hasUsage = Object.keys(usage).length;
  if (!hasUsage && !dayDirty) return;
  if (Date.now() - lastSync < 15000) return syncSoon();
  lastSync = Date.now();
  const body = { initData: tg.initData, usage: { ...usage }, lang: LANG };
  Object.keys(usage).forEach((k) => delete usage[k]);
  if (dayDirty && S.todaySummary) { body.day = S.todaySummary; dayDirty = false; }
  try { await fetch(API_URL + '/api/sync', { method: 'POST', body: JSON.stringify(body), keepalive: true }); } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { lastSync = 0; syncNow(); } });
/** Итог сегодняшнего дня для вечернего отчёта бота. */
function updateTodaySummary() {
  if (!sameDay(S.day, startOfDay(new Date()))) return;
  const g = goals(S.profile), t = totalsOf(S.data.e);
  S.todaySummary = { date: isoDate(S.day), k: t.k, p: t.p, f: t.f, c: t.c, w: S.data.w, e: S.data.e.length, gk: g.kcal, gp: g.protein, gw: g.water, burn: S.profile.addBurn === false ? 0 : burnedOf(S.data) };
  dayDirty = true;
  syncSoon();
}

// ---------- Сожжённые калории ----------
const burnedOf = (d) => (d.a || []).reduce((s, a) => s + (a.k || 0), 0);
const dayGoal = () => goals(S.profile).kcal + (S.profile.addBurn === false ? 0 : burnedOf(S.data));
const ACTIVITIES = [
  ['Ходьба', '🚶', 3.5], ['Быстрая ходьба', '🚶‍♂️', 4.3], ['Бег', '🏃', 9.8], ['Велосипед', '🚴', 7.5], ['Плавание', '🏊', 7],
  ['Силовая тренировка', '🏋️', 5], ['ВИИТ / кроссфит', '🔥', 8], ['Йога / растяжка', '🧘', 2.5], ['Танцы', '💃', 5], ['Футбол', '⚽', 7],
  ['Лыжи', '⛷', 7], ['Уборка по дому', '🧹', 3.3],
];
function activitySheet() {
  const st = { i: 0, min: 30, steps: '', mode: 'sport' };
  const kg = S.profile.weight || 75;
  const kcal = () => (st.mode === 'steps' ? Math.round(num(st.steps) * 0.0005 * kg) : Math.round(ACTIVITIES[st.i][2] * kg * (st.min / 60)));
  return {
    title: 'Активность',
    render: () => `<div class="seg period">${[['sport', 'Тренировка'], ['steps', 'Шаги']].map(([v, t]) => `<button data-a="actMode" data-v="${v}" class="${st.mode === v ? 'on' : ''}">${t}</button>`).join('')}</div>
      ${st.mode === 'sport' ? `<div class="chips daypick">${ACTIVITIES.map(([n, e], i) => `<button class="chip ${st.i === i ? 'on' : ''}" data-a="actPick" data-i="${i}">${e} ${n}</button>`).join('')}</div>
        <div class="list"><div class="field"><label>Длительность</label><input id="actMin" inputmode="numeric" value="${st.min}"><span class="unit">мин</span></div></div>
        <div class="chips">${[15, 30, 45, 60, 90].map((m) => `<button class="chip ${st.min === m ? 'on' : ''}" data-a="actMinP" data-v="${m}">${m} мин</button>`).join('')}</div>`
      : `<div class="list"><div class="field"><label>Шагов</label><input id="actSteps" inputmode="numeric" placeholder="8000" value="${esc(st.steps)}"></div></div>`}
      <div class="card burn-res"><span>🔥</span><b id="actK">${n0(kcal())}</b><small>ккал сожжено (примерно, по весу ${n0(kg)} кг)</small></div>
      <button class="btn" data-a="actSave">Добавить</button>
      <p class="hint" style="text-align:center">${S.profile.addBurn === false ? 'Сожжённые калории не добавляются к норме (настраивается в профиле).' : 'Сожжённые калории добавятся к норме на сегодня. Если добавляете тренировки, в профиле лучше выбрать активность «Минимальная».'}</p>`,
    mount(el) {
      const up = () => { el.querySelector('#actK').textContent = n0(kcal()); };
      const m = el.querySelector('#actMin'); if (m) m.addEventListener('input', () => { st.min = num(m.value); up(); });
      const s = el.querySelector('#actSteps'); if (s) s.addEventListener('input', () => { st.steps = s.value; up(); });
    },
    actions: {
      actMode(d) { st.mode = d.v; refreshSheet(); },
      actPick(d) { st.i = +d.i; refreshSheet(); },
      actMinP(d) { st.min = +d.v; refreshSheet(); },
      actSave: lock(async () => {
        const k = kcal();
        if (!(k > 0) || k > 5000) return toast('Проверьте значения');
        const a = st.mode === 'steps' ? { n: `Шаги: ${n0(num(st.steps))}`, e: '👣', k, t: Date.now() } : { n: ACTIVITIES[st.i][0], e: ACTIVITIES[st.i][1], min: st.min, k, t: Date.now() };
        S.data.a = [...(S.data.a || []), a];
        track('activity'); haptic('success'); closeSheet(); render(); toast(`🔥 +${k} ккал к норме`);
        await saveDay();
      }),
    },
  };
}

// ---------- Подсказка «чем добрать» ----------
const SUGGEST = ['Творог 5%', 'Йогурт греческий 2%', 'Куриная грудка запечённая', 'Яйцо варёное', 'Тунец консервированный в собственном соку', 'Кефир 1%', 'Скир',
  'Индейка филе запечённое', 'Креветки варёные', 'Протеиновый коктейль на воде', 'Банан', 'Яблоко', 'Гречка варёная', 'Салат из свежих овощей с маслом',
  'Хлеб цельнозерновой', 'Сыр моцарелла', 'Лосось запечённый', 'Грецкие орехи', 'Хумус', 'Овсянка на молоке', 'Рис белый варёный', 'Омлет'];
function suggestions(leftK, leftP) {
  if (leftK < 80) return [];
  const needP = leftP > 15;
  const list = SUGGEST.map((n) => BUILTIN.find((f) => f.n === n)).filter(Boolean).map((f) => {
    let g = f.pc ? (f.pc < 70 ? f.pc * 2 : f.pc) : f.s || 150;
    if (f.k * g / 100 > leftK * 0.9) g = Math.floor((leftK * 0.9) / f.k * 100 / 10) * 10;
    if (g < 30) return null;
    const k = f.k * g / 100, p = f.p * g / 100;
    const score = needP ? p / Math.max(k, 1) * 10 + Math.min(p, leftP) / 10 : 1 - Math.abs(k - Math.min(leftK, 350)) / 350;
    return { f, g, k, p, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  const out = [], cats = new Set();
  for (const x of list) { if (cats.has(x.f.cat)) continue; cats.add(x.f.cat); out.push(x); if (out.length === 3) break; }
  return out;
}
function suggestHTML(leftK, leftP) {
  const sg = suggestions(leftK, leftP);
  if (!sg.length) return '';
  return `<div class="card suggest"><div class="sg-h">💡 Осталось <b>${n0(leftK)} ккал</b>${leftP > 5 ? ` и <b>${n0(leftP)} г белка</b>` : ''} — например:</div>
    <div class="sg-list">${sg.map((x, i) => `<button data-a="sgPick" data-i="${i}"><span>${catEmoji(x.f)}</span><b>${esc(x.f.n)}</b><small>${x.f.pc && x.g % x.f.pc === 0 ? `${x.g / x.f.pc} шт · ` : ''}${n0(x.g)} г · ${n0(x.k)} ккал · Б ${n0(x.p)}</small></button>`).join('')}</div></div>`;
}

// ---------- Шаблоны дня ----------
async function saveTemplate(name, entries) {
  const tpl = { id: Date.now().toString(36), n: name, e: entries.map((e) => { const x = { ...e }; delete x.t; return x; }) };
  let text = JSON.stringify(tpl);
  if (text.length > 4000) return toast('Слишком большой день для шаблона');
  S.templates = [tpl, ...S.templates];
  await Store.set('tp_' + tpl.id, text);
  track('template');
  return tpl;
}
function templatesSheet() {
  return {
    title: 'Шаблоны дня',
    render: () => `<p class="hint" style="margin:0 6px 12px">Сохраните обычный день целиком и добавляйте его одним касанием.</p>
      ${S.templates.length ? `<div class="list">${S.templates.map((t) => { const k = totalsOf(t.e).k; return `<div class="row"><div class="fic">📋</div><div class="main"><div class="title">${esc(t.n)}</div>
        <div class="sub">${t.e.length} ${plural(t.e.length, 'продукт', 'продукта', 'продуктов')} · ${n0(k)} ккал</div></div>
        <button class="pill-btn" data-a="tplApply" data-id="${t.id}">Добавить</button><button class="link-btn" style="color:var(--danger)" data-a="tplDel" data-id="${t.id}">✕</button></div>`; }).join('')}</div>`
        : emptyState('📋', 'Шаблонов пока нет', 'Заполните день и сохраните его как шаблон кнопкой ниже.')}
      ${S.data.e.length ? `<div class="list"><div class="field"><input class="wide" id="tplName" placeholder="Название, например «Будний день»" maxlength="40"></div>
        <button class="row add" data-a="tplSave"><span class="plus">+</span>Сохранить «${esc(dayTitle(S.day))}» как шаблон (${S.data.e.length})</button></div>` : ''}`,
    actions: {
      tplSave: lock(async () => {
        const n = ($('#tplName').value || '').trim() || `День ${dateText(S.day)}`;
        if (await saveTemplate(n, S.data.e)) { haptic('success'); toast('📋 Шаблон сохранён'); refreshSheet(); }
      }),
      tplApply: lock(async (d) => {
        const t = S.templates.find((x) => x.id === d.id);
        if (!t) return;
        const now = Date.now();
        t.e.forEach((e, i) => S.data.e.push({ ...e, t: now + i }));
        track('template'); haptic('success'); closeAllSheets(); render(); toast(`📋 Добавлено: ${t.e.length}`);
        await saveDay();
      }),
      async tplDel(d) { S.templates = S.templates.filter((x) => x.id !== d.id); await Store.remove('tp_' + d.id); refreshSheet(); },
    },
  };
}

// ---------- Темп к цели ----------
function paceInfo() {
  const p = S.profile;
  if (!p.target) return null;
  const w = S.weights;
  const cur = w.length ? w[w.length - 1][1] : p.weight;
  const diff = p.target - cur;
  if (Math.abs(diff) < 0.3) return { done: true, cur };
  const from = addDays(startOfDay(new Date()), -28);
  const pts = w.filter(([iso]) => parseIso(iso) >= from).map(([iso, kg]) => [(parseIso(iso) - from) / 864e5, kg]);
  let perWeek = null, source = '';
  if (pts.length >= 3 && pts[pts.length - 1][0] - pts[0][0] >= 7) {
    const mx = avg(pts.map((x) => x[0])), my = avg(pts.map((x) => x[1]));
    const slope = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
    perWeek = slope * 7; source = 'по динамике веса за 4 недели';
  } else if (S.daysCache) {
    const logged = S.daysCache.list.slice(-14).filter((d) => d.t.k > 0);
    if (logged.length >= 3) {
      const g = goals(p);
      perWeek = -((g.tdee - avg(logged.map((d) => d.t.k))) * 7) / 7700; source = 'по средним калориям (оценка)';
    }
  }
  if (perWeek == null) return { cur, diff, need: true };
  const toward = Math.sign(perWeek) === Math.sign(diff) && Math.abs(perWeek) > 0.02;
  const weeks = toward ? Math.abs(diff / perWeek) : null;
  return { cur, diff, perWeek, source, weeks, eta: weeks ? addDays(startOfDay(new Date()), Math.round(weeks * 7)) : null };
}
function paceHTML() {
  const x = paceInfo();
  if (!x) return `<div class="card pace"><b>🎯 Цель по весу</b><p class="hint" style="margin:6px 0 10px">Укажите желаемый вес — покажем темп и примерную дату.</p><button class="btn ghost" data-a="setTarget">Указать цель</button></div>`;
  if (x.done) return `<div class="card pace"><b>🎉 Цель достигнута!</b><p class="hint" style="margin:6px 0 0">Вес ${n1(x.cur)} кг — поздравляем. Можно поставить новую цель.</p><button class="btn ghost" style="margin:10px 0 0" data-a="setTarget">Новая цель</button></div>`;
  return `<div class="card pace"><div class="pace-h"><b>🎯 Цель: ${n1(S.profile.target)} кг</b><button class="inline-link" data-a="setTarget">изменить</button></div>
    ${x.need ? '<p class="hint" style="margin:6px 0 0">Добавьте ещё взвешиваний или записей еды — рассчитаем темп.</p>'
      : `<div class="pace-row"><div><span>Темп</span><b>${x.perWeek > 0 ? '+' : ''}${n1(x.perWeek)} кг/нед</b></div><div><span>Осталось</span><b>${n1(Math.abs(x.diff))} кг</b></div>
        <div><span>Примерно к</span><b>${x.eta ? dateText(x.eta) : '—'}</b></div></div>
        <p class="hint" style="margin:8px 0 0">${x.eta ? `При текущем темпе (${x.source}). Это прогноз, а не обещание 🙂` : 'Сейчас вес движется не к цели — попробуйте скорректировать калории на 200–300 ккал.'}${Math.abs(x.perWeek) > 1 ? ' Темп больше 1 кг в неделю — слишком быстро, лучше помедленнее.' : ''}</p>`}</div>`;
}

// ---------- Голодание ----------
const FAST_MODES = [[16, '16/8'], [14, '14/10'], [18, '18/6'], [20, '20/4']];
const fmtHM = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return `${Math.floor(m / 60)}:${pad(m % 60)}`; };
function fastHTML() {
  const f = S.profile.fast || {};
  if (!f.on) return '';
  const hours = f.h || 16;
  if (f.start) {
    const el = Date.now() - f.start, total = hours * 3600e3, k = Math.min(1, el / total);
    const C = 2 * Math.PI * 22;
    return `<div class="card fast"><div class="fring"><svg viewBox="0 0 54 54"><circle cx="27" cy="27" r="22" fill="none" stroke="var(--sep)" stroke-width="6"/>
      <circle cx="27" cy="27" r="22" fill="none" stroke="url(#gFast)" stroke-width="6" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - k)}" transform="rotate(-90 27 27)"/>
      <defs><linearGradient id="gFast"><stop offset="0" stop-color="#8a6bff"/><stop offset="1" stop-color="#3b8bff"/></linearGradient></defs></svg><span>⏳</span></div>
      <div class="main"><b>${k >= 1 ? 'Голодание завершено 🎉' : `Голодание ${fmtHM(el)} из ${hours}:00`}</b><small id="fastLeft">${k >= 1 ? 'Окно питания открыто' : `До окна питания ${fmtHM(total - el)}`}</small></div>
      <button class="pill-btn" data-a="fastStop">${k >= 1 ? 'Готово' : 'Стоп'}</button></div>`;
  }
  return `<div class="card fast"><div class="fring"><span>🍽</span></div><div class="main"><b>Окно питания · ${(FAST_MODES.find((m) => m[0] === hours) || FAST_MODES[0])[1]}</b><small>Начните голодание после последнего приёма пищи</small></div>
    <button class="pill-btn" data-a="fastStart">Начать</button></div>`;
}
async function scheduleFast(endAt) {
  if (!API_URL || !inTelegram) return;
  try { await fetch(API_URL + '/api/fast', { method: 'POST', body: JSON.stringify({ initData: tg.initData, endAt }) }); } catch {}
}
setInterval(() => { if (S.tab === 'diary' && !sheets.length && S.profile && S.profile.fast && S.profile.fast.start && document.querySelector('.card.fast')) { const y = window.scrollY; render(); window.scrollTo(0, y); } }, 60000);

// ---------- Замеры тела ----------
const MEAS = [['w', 'Талия'], ['h', 'Бёдра'], ['c', 'Грудь'], ['a', 'Рука']];
function measHTML() {
  const m = S.meas;
  const last = m[m.length - 1], first = m[0];
  const line = (key) => {
    const pts = m.filter((x) => x[1][key]).slice(-20);
    if (pts.length < 2) return '';
    const vals = pts.map((x) => x[1][key]), lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
    const W = 120, H = 34;
    const d = pts.map((x, i) => `${i ? 'L' : 'M'}${(i / (pts.length - 1)) * W},${H - ((x[1][key] - lo) / (hi - lo)) * H}`).join(' ');
    return `<svg viewBox="0 0 ${W} ${H}" class="spark"><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"/></svg>`;
  };
  return `<div class="section-h"><span>Замеры тела</span><span>см</span></div>
    <div class="card">
      <div class="meas-in">${MEAS.map(([k, t]) => `<label><span>${t}</span><input data-meas="${k}" inputmode="decimal" placeholder="${last && last[1][k] ? n1(last[1][k]) : '—'}"></label>`).join('')}</div>
      <button class="btn ghost" style="margin:12px 0 0" data-a="measSave">Сохранить замеры</button>
      ${last ? `<div class="meas-list">${MEAS.filter(([k]) => last[1][k]).map(([k, t]) => { const f0 = (m.find((x) => x[1][k]) || first)[1][k]; const dd = last[1][k] - f0;
        return `<div class="meas-row"><span>${t}</span>${line(k)}<b>${n1(last[1][k])}</b><small class="${dd < 0 ? 'down' : dd > 0 ? 'up' : ''}">${dd ? (dd > 0 ? '+' : '') + n1(dd) : ''}</small></div>`; }).join('')}</div>
        <p class="hint" style="margin:6px 0 0">Последний замер: ${dateText(parseIso(last[0]))}. Объёмы часто уходят раньше, чем вес.</p>` : ''}
    </div>`;
}

// ---------- Приглашения ----------
async function loadRef() {
  if (!API_URL || !inTelegram) return null;
  try { const r = await fetch(API_URL + '/api/ref', { method: 'POST', body: JSON.stringify({ initData: tg.initData }) }).then((x) => x.json()); if (r.ok) { S.ref = r; if (r.count !== S.profile.refCount) { S.profile.refCount = r.count; saveProfile(); checkAchievements(); } } return r; } catch { return null; }
}
function referralSheet() {
  if (!S.ref) loadRef().then(() => refreshSheet());
  return {
    title: 'Пригласить друга',
    render: () => {
      const r = S.ref;
      return `<div class="welcome"><div class="logo">${LOGO}</div><h2>Вместе веселее</h2><p>Пригласите друзей — следите за питанием вместе и соревнуйтесь в челленджах.</p></div>
        ${!API_URL || !inTelegram ? '<div class="card">Доступно в приложении внутри Telegram.</div>' : !r ? skeleton(1) : `
        <div class="card ref"><span>Ваша ссылка</span><b>${esc(r.link || 'нет ссылки')}</b><small>Приглашено друзей: <b>${r.count}</b></small></div>
        <button class="btn" data-a="refShare">📤 Отправить приглашение</button>
        <button class="btn ghost" data-a="refCopy">Скопировать ссылку</button>`}`;
    },
    actions: {
      refShare() {
        const r = S.ref; if (!r || !r.link) return;
        track('share');
        const text = `Я считаю калории в «${CFG.title}» 🥗 Распознаёт еду по фото и голосу, есть рецепты и челленджи. Присоединяйся!`;
        const link = `https://t.me/share/url?url=${encodeURIComponent(r.link)}&text=${encodeURIComponent(text)}`;
        try { tg.openTelegramLink(link); } catch { window.open(link, '_blank'); }
      },
      async refCopy() { try { await navigator.clipboard.writeText(S.ref.link); toast('Ссылка скопирована'); } catch { toast(S.ref.link); } },
    },
  };
}

// ---------- Челленджи ----------
const CH_INFO = { water: ['💧', 'Пить норму воды'], log: ['📝', 'Заполнять дневник'], protein: ['💪', 'Норма белка'], kcal: ['🎯', 'Уложиться в норму калорий'], nosweet: ['🍬', 'Без сладкого'] };
async function chApi(payload) {
  if (!API_URL || !inTelegram) return { ok: false, error: 'Доступно в приложении внутри Telegram' };
  try { return await fetch(API_URL + '/api/challenge', { method: 'POST', body: JSON.stringify({ initData: tg.initData, ...payload }) }).then((x) => x.json()); }
  catch { return { ok: false, error: 'Нет связи с сервером' }; }
}
async function loadChallenges() { const r = await chApi({ action: 'list' }); if (r.ok) { S.challenges = r.list; if (S.tab === 'diary' && !sheets.length) { const y = window.scrollY; render(); window.scrollTo(0, y); } } return r; }
const myUid = () => String((tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) || '');
const chDayIndex = (c, d = new Date()) => Math.round((startOfDay(d) - parseIso(c.start)) / 864e5);
const chActive = (c) => { const i = chDayIndex(c); return i >= 0 && i < c.days; };
/** Автоматически отмечает выполненные сегодня челленджи. */
async function autoMarkChallenges() {
  if (!S.challenges || !sameDay(S.day, startOfDay(new Date()))) return;
  const g = goals(S.profile), t = totalsOf(S.data.e), today = isoDate(new Date()), me = myUid();
  const ok = { water: S.data.w >= g.water, log: S.data.e.length >= 3, protein: t.p >= g.protein, kcal: t.k >= dayGoal() * 0.85 && t.k <= dayGoal() * 1.1 };
  for (const c of S.challenges) {
    if (!(c.type in ok) || !chActive(c) || !c.members[me]) continue;
    const done = !!c.members[me].done[today];
    if (ok[c.type] && !done) {
      const r = await chApi({ action: 'mark', id: c.id, date: today, done: true });
      if (r.ok) { Object.assign(c, r.challenge); toast(`🏁 Челлендж «${CH_INFO[c.type][1]}»: день засчитан!`); haptic('success'); }
    }
  }
}
function challengesHTML() {
  const list = (S.challenges || []).filter(chActive);
  if (!list.length) return '';
  const me = myUid(), today = isoDate(new Date());
  return `<div class="card chal-mini"><div class="sg-h">🏁 Челленджи сегодня</div>${list.map((c) => {
    const done = c.members[me] && c.members[me].done[today];
    return `<button class="chal-row" data-a="chOpen"><span>${CH_INFO[c.type][0]}</span><div class="main"><b>${CH_INFO[c.type][1]}</b><small>день ${chDayIndex(c) + 1} из ${c.days} · ${Object.keys(c.members).length} уч.</small></div><em class="${done ? 'ok' : ''}">${done ? '✓' : '…'}</em></button>`;
  }).join('')}</div>`;
}
function challengesSheet() {
  const st = { loading: !S.challenges, type: 'water', days: 7, creating: false };
  if (!S.challenges) loadChallenges().then(() => { st.loading = false; refreshSheet(); });
  const me = myUid(), today = isoDate(new Date());
  return {
    title: 'Челленджи',
    render: () => {
      if (st.loading) return skeleton(2);
      const list = S.challenges || [];
      return `${list.map((c) => {
        const idx = chDayIndex(c), active = chActive(c), finished = idx >= c.days;
        const board = Object.entries(c.members).map(([id, m]) => ({ id, n: m.n, k: Object.keys(m.done).length })).sort((a, b) => b.k - a.k);
        const mine = c.members[me] && c.members[me].done[today];
        return `<div class="card chal"><div class="chal-h"><span>${CH_INFO[c.type][0]}</span><div class="main"><b>${CH_INFO[c.type][1]}</b>
          <small>${finished ? 'Завершён' : idx < 0 ? 'Скоро старт' : `День ${idx + 1} из ${c.days}`} · с ${dateText(parseIso(c.start))}</small></div></div>
          <div class="board">${board.map((x, i) => `<div class="${x.id === me ? 'me' : ''}"><span>${['🥇', '🥈', '🥉'][i] || i + 1}</span><b>${esc(x.n)}${x.id === me ? ' (вы)' : ''}</b><div class="bar"><i style="width:${(x.k / c.days) * 100}%;background:var(--grad)"></i></div><em>${x.k}/${c.days}</em></div>`).join('')}</div>
          <div class="chal-act">
            ${active && c.type === 'nosweet' ? `<button class="pill-btn" data-a="chMark" data-id="${c.id}" data-v="${mine ? '' : '1'}">${mine ? '✓ Сегодня без сладкого' : 'Отметить: сегодня без сладкого'}</button>` : active ? `<span class="hint" style="margin:0">${mine ? '✓ Сегодня выполнено' : 'Засчитается автоматически'}</span>` : ''}
            <button class="pill-btn" data-a="chInvite" data-id="${c.id}">Пригласить</button>
            <button class="inline-link" style="color:var(--danger)" data-a="chLeave" data-id="${c.id}">Выйти</button></div></div>`;
      }).join('') || emptyState('🏁', 'Нет челленджей', 'Создайте челлендж и позовите друзей — каждый день отмечается автоматически по вашему дневнику.')}
      <div class="section-h"><span>Новый челлендж</span></div>
      <div class="chips daypick">${Object.entries(CH_INFO).map(([k, [e, t]]) => `<button class="chip ${st.type === k ? 'on' : ''}" data-a="chType" data-v="${k}">${e} ${t}</button>`).join('')}</div>
      <div class="seg period">${[7, 14, 30].map((d) => `<button data-a="chDays" data-v="${d}" class="${st.days === d ? 'on' : ''}">${d} дней</button>`).join('')}</div>
      <button class="btn" data-a="chCreate" ${st.creating ? 'disabled' : ''}>Создать и пригласить друзей</button>`;
    },
    actions: {
      chType(d) { st.type = d.v; refreshSheet(); },
      chDays(d) { st.days = +d.v; refreshSheet(); },
      chCreate: lock(async () => {
        st.creating = true; refreshSheet();
        const r = await chApi({ action: 'create', type: st.type, days: st.days, start: isoDate(new Date()) });
        st.creating = false;
        if (!r.ok) { toast('⚠️ ' + r.error); return refreshSheet(); }
        S.challenges = [{ ...r.challenge, link: r.link }, ...(S.challenges || [])];
        track('challenge'); haptic('success'); refreshSheet(); autoMarkChallenges();
        shareChallenge(S.challenges[0]);
      }),
      chInvite(d) { shareChallenge((S.challenges || []).find((c) => c.id === d.id)); },
      chMark: lock(async (d) => { const r = await chApi({ action: 'mark', id: d.id, date: today, done: !!d.v }); if (r.ok) { Object.assign(S.challenges.find((c) => c.id === d.id), r.challenge); haptic('success'); refreshSheet(); } else toast(r.error); }),
      chLeave: lock(async (d) => {
        const ok = await new Promise((res) => { try { tg.showConfirm('Выйти из челленджа?', res); } catch { res(window.confirm('Выйти из челленджа?')); } });
        if (!ok) return;
        await chApi({ action: 'leave', id: d.id }); S.challenges = S.challenges.filter((c) => c.id !== d.id); refreshSheet();
      }),
    },
  };
}
function shareChallenge(c) {
  if (!c || !c.link) return toast('Ссылка появится, когда сервер ответит');
  const text = `Присоединяйся к челленджу «${CH_INFO[c.type][1]}» на ${c.days} дней! 🏁`;
  const link = `https://t.me/share/url?url=${encodeURIComponent(c.link)}&text=${encodeURIComponent(text)}`;
  try { tg.openTelegramLink(link); } catch { window.open(link, '_blank'); }
}

// ---------- Карточка недели картинкой ----------
async function weekCard() {
  const days = await loadDays(7);
  const logged = days.filter((d) => d.t.k > 0);
  const g = goals(S.profile);
  const W = 1080, H = 1350, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const bg = x.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#1638c8'); bg.addColorStop(0.55, '#0d1f6e'); bg.addColorStop(1, '#071338');
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  const orb = (cx, cy, r, col) => { const gr = x.createRadialGradient(cx, cy, 0, cx, cy, r); gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gr; x.fillRect(0, 0, W, H); };
  orb(900, 120, 520, 'rgba(63,212,255,.55)'); orb(80, 700, 480, 'rgba(43,91,255,.5)');
  const T = (s) => tr(s);
  const font = (w, s) => `${w} ${s}px Unbounded, Manrope, -apple-system, sans-serif`;
  x.fillStyle = '#fff'; x.font = font(700, 44); x.fillText(CFG.title || 'Калории', 80, 130);
  x.globalAlpha = 0.75; x.font = font(600, 34); x.fillText(T(`Моя неделя · ${dateText(days[0].date)} — ${dateText(days[6].date)}`), 80, 190); x.globalAlpha = 1;
  x.font = font(700, 170); x.fillText(n0(avg(logged.map((d) => d.t.k))), 80, 420);
  x.font = font(600, 40); x.globalAlpha = 0.8; x.fillText(T(`ккал в день в среднем · норма ${n0(g.kcal)}`), 84, 480); x.globalAlpha = 1;
  // столбики
  const max = Math.max(g.kcal * 1.2, ...days.map((d) => d.t.k));
  days.forEach((d, i) => {
    const bw = 100, gap = 30, bx = 80 + i * (bw + gap), bh = (d.t.k / max) * 300, by = 880 - bh;
    x.fillStyle = 'rgba(255,255,255,.14)'; x.beginPath(); x.roundRect(bx, 580, bw, 300, 22); x.fill();
    const gr = x.createLinearGradient(0, by, 0, 880); gr.addColorStop(0, '#8de3ff'); gr.addColorStop(1, '#2a74f5');
    x.fillStyle = d.t.k > g.kcal * 1.1 ? '#ffb547' : gr; if (bh > 0) { x.beginPath(); x.roundRect(bx, by, bw, bh, 22); x.fill(); }
    x.fillStyle = 'rgba(255,255,255,.75)'; x.font = font(600, 30); x.textAlign = 'center'; x.fillText(T(['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.date.getDay()]), bx + bw / 2, 930); x.textAlign = 'left';
  });
  const ws = S.weights.filter(([iso]) => parseIso(iso) >= addDays(days[0].date, -3));
  const tiles = [[`🔥 ${streak()}`, plural(streak(), 'день подряд', 'дня подряд', 'дней подряд')], [`${logged.length}/7`, 'дней с записями'], [ws.length >= 2 ? `${ws[ws.length - 1][1] - ws[0][1] > 0 ? '+' : ''}${n1(ws[ws.length - 1][1] - ws[0][1])} кг` : `${n0(avg(days.filter((d) => d.w).map((d) => d.w)))} мл`, ws.length >= 2 ? 'вес за неделю' : 'воды в день']];
  tiles.forEach(([v, l], i) => {
    const tx = 80 + i * 320;
    x.fillStyle = 'rgba(255,255,255,.12)'; x.beginPath(); x.roundRect(tx, 1010, 290, 200, 36); x.fill();
    x.fillStyle = '#fff'; x.font = font(700, 54); x.fillText(v, tx + 32, 1100);
    x.globalAlpha = 0.75; x.font = font(600, 28); x.fillText(T(l), tx + 32, 1160); x.globalAlpha = 1;
  });
  x.globalAlpha = 0.6; x.font = font(600, 28); x.fillText(T('Дневник питания в Telegram'), 80, 1290); x.globalAlpha = 1;
  return c.toDataURL('image/png');
}
function weekCardSheet() {
  const st = { img: null, busy: false };
  weekCard().then((u) => { st.img = u; refreshSheet(); });
  return {
    title: 'Карточка недели',
    render: () => `${st.img ? `<img class="week-img" src="${st.img}" alt="Итоги недели">` : skeleton(2)}
      <button class="btn" data-a="wcSend" ${!st.img || st.busy ? 'disabled' : ''}>${st.busy ? 'Отправляем…' : '📩 Отправить в чат (оттуда — переслать или в сторис)'}</button>
      ${navigator.canShare ? '<button class="btn ghost" data-a="wcShare">Поделиться…</button>' : ''}`,
    actions: {
      wcSend: lock(async () => {
        if (!API_URL || !inTelegram) return toast('Доступно в приложении внутри Telegram');
        st.busy = true; refreshSheet();
        try {
          const r = await fetch(API_URL + '/api/share-photo', { method: 'POST', body: JSON.stringify({ initData: tg.initData, image: st.img, caption: `Моя неделя в «${CFG.title}» 🥗` }) }).then((x) => x.json());
          toast(r.ok ? '📩 Картинка в чате с ботом' : '⚠️ ' + r.error);
          if (r.ok) { track('share'); haptic('success'); }
        } catch { toast('⚠️ Нет связи'); }
        st.busy = false; refreshSheet();
      }),
      async wcShare() {
        try { const blob = await (await fetch(st.img)).blob(); const file = new File([blob], 'week.png', { type: 'image/png' }); await navigator.share({ files: [file], text: 'Моя неделя 🥗' }); track('share'); } catch {}
      },
    },
  };
}

// ---------- Открытие из бота: проверка распознанного, приглашение в челлендж ----------
async function handleDeepLink() {
  const h = location.hash || '';
  if (!h || !API_URL || !inTelegram) return false;
  history.replaceState(null, '', location.pathname + location.search);
  if (h === '#pending') {
    const r = await fetch(API_URL + '/api/pending', { method: 'POST', body: JSON.stringify({ initData: tg.initData }) }).then((x) => x.json()).catch(() => null);
    if (r && r.ok && r.pending) { openSheet(reviewSheet(resolveItems(r.pending.items || []), null, 'voice')); return true; }
    toast('Эта запись уже добавлена или устарела');
    return true;
  }
  if (h.startsWith('#ch_')) {
    const r = await chApi({ action: 'join', id: h.slice(4) });
    if (r.ok) { await loadChallenges(); toast(`🏁 Вы в челлендже «${CH_INFO[r.challenge.type][1]}»!`); haptic('success'); }
    else toast('⚠️ ' + r.error);
    openSheet(challengesSheet());
    return true;
  }
  return false;
}

Object.assign(actions, {
  sgPick(d) {
    const left = dayGoal() - totalsOf(S.data.e).k, leftP = goals(S.profile).protein - totalsOf(S.data.e).p;
    const x = suggestions(left, leftP)[+d.i];
    if (x) openSheet(amountSheet({ ...x.f, lg: x.g, lu: x.f.pc && x.g % x.f.pc === 0 ? 'шт' : undefined, lq: x.f.pc && x.g % x.f.pc === 0 ? x.g / x.f.pc : undefined }, suggestedMeal()));
  },
  activity() { openSheet(activitySheet()); },
  async actDel(d) { S.data.a = (S.data.a || []).filter((_, i) => i !== +d.i); render(); await saveDay(); },
  templates() { openSheet(templatesSheet()); },
  setTarget() {
    openSheet({
      title: 'Цель по весу', compact: true,
      render: () => `<div class="list"><div class="field"><label>Желаемый вес</label><input id="tgtIn" inputmode="decimal" value="${S.profile.target ? n1(S.profile.target) : ''}" placeholder="${n1(S.profile.weight)}"><span class="unit">кг</span></div></div>
        <button class="btn" data-a="tgtSave">Сохранить</button>${S.profile.target ? '<button class="btn ghost" data-a="tgtClear">Убрать цель</button>' : ''}`,
      actions: {
        async tgtSave() { const v = num($('#tgtIn').value); if (v < 30 || v > 300) return toast('Введите вес от 30 до 300 кг'); S.profile.target = v; closeSheet(); render(); await saveProfile(); },
        async tgtClear() { delete S.profile.target; closeSheet(); render(); await saveProfile(); },
      },
    });
  },
  async fastToggle() { S.profile.fast = { ...(S.profile.fast || {}), on: !(S.profile.fast && S.profile.fast.on), h: (S.profile.fast && S.profile.fast.h) || 16 }; if (!S.profile.fast.on) { S.profile.fast.start = null; scheduleFast(null); } render(); await saveProfile(); },
  async fastMode(d) { S.profile.fast = { ...(S.profile.fast || {}), h: +d.v }; render(); await saveProfile(); },
  fastStart: lock(async () => { const h = (S.profile.fast && S.profile.fast.h) || 16; S.profile.fast = { ...S.profile.fast, start: Date.now() }; track('fast'); haptic('success'); render(); toast(`⏳ Голодание ${h} ч — бот напомнит, когда окно откроется`); await saveProfile(); scheduleFast(Date.now() + h * 3600e3); }),
  fastStop: lock(async () => { S.profile.fast = { ...S.profile.fast, start: null }; render(); await saveProfile(); scheduleFast(null); }),
  measSave: lock(async () => {
    const vals = {};
    document.querySelectorAll('[data-meas]').forEach((i) => { const v = num(i.value); if (v >= 20 && v <= 250) vals[i.dataset.meas] = v; });
    if (!Object.keys(vals).length) return toast('Введите хотя бы один замер в сантиметрах');
    const today = isoDate(new Date());
    const prev = (S.meas.find((x) => x[0] === today) || [today, {}])[1];
    S.meas = S.meas.filter((x) => x[0] !== today).concat([[today, { ...prev, ...vals }]]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    while (JSON.stringify(S.meas).length > 4000) S.meas.shift();
    track('measure'); haptic('success'); render(); toast('📏 Замеры сохранены');
    await Store.set('meas', JSON.stringify(S.meas));
  }),
  invite() { openSheet(referralSheet()); },
  challenges() { openSheet(challengesSheet()); },
  chOpen() { openSheet(challengesSheet()); },
  weekCard() { openSheet(weekCardSheet()); },
  async addBurnToggle() { S.profile.addBurn = S.profile.addBurn === false; render(); await saveProfile(); },
});
