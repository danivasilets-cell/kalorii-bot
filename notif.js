'use strict';
/* ============================================================
   Окна: действия с приёмом пищи, вода (история, стакан), напоминания.
   ============================================================ */

function mealMenuSheet(m) {
  const meal = MEALS.find((x) => x.id === m);
  const items = () => S.data.e.filter((e) => e.m === m);
  const st = { target: addDays(startOfDay(new Date()), sameDay(S.day, startOfDay(new Date())) ? 1 : 0), tm: m };
  return {
    title: meal.t,
    compact: true,
    render: () => {
      const t = totalsOf(items());
      return `<div class="card food-card"><div class="ic">${meal.i}</div><div><b>${meal.t}: ${n0(t.k)} ккал</b><small>${items().length} ${plural(items().length, 'продукт', 'продукта', 'продуктов')} · Б ${n0(t.p)} Ж ${n0(t.f)} У ${n0(t.c)}</small></div></div>
        <div class="list">
          <button class="row" data-a="mmFav"><div class="fic">⭐</div><div class="main"><div class="title">Сохранить как блюдо</div><div class="sub">Чтобы добавлять одним касанием</div></div></button>
          <button class="row" data-a="mmClear"><div class="fic">🗑</div><div class="main"><div class="title" style="color:var(--danger)">Очистить приём пищи</div></div></button>
        </div>
        <div class="section-h"><span>Скопировать в другой день</span></div>
        <div class="chips daypick">${Array.from({ length: 15 }, (_, i) => addDays(startOfDay(new Date()), i - 7)).map((d) => `<button class="chip ${sameDay(d, st.target) ? 'on' : ''}" data-a="mmDay" data-d="${isoDate(d)}">${sameDay(d, startOfDay(new Date())) ? 'Сегодня' : `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`}</button>`).join('')}</div>
        <div class="list"><div class="field">${mealSeg(st.tm)}</div></div>
        <button class="btn" data-a="mmCopy">Скопировать</button>`;
    },
    actions: {
      mmDay(d) { st.target = parseIso(d.d); refreshSheet(); },
      meal(d) { st.tm = d.m; refreshSheet(); },
      mmFav: lock(async () => {
        const list = items();
        await saveDish({ id: Date.now().toString(36), n: `${meal.t} ${dateText(S.day)}`, sv: 1, ing: list.map((e) => ({ ...plainFood(e), g: e.g })) });
        haptic('success'); toast('⭐ Сохранено — переименовать можно в «Питание → Избранное»'); closeSheet();
      }),
      mmClear: lock(async () => {
        const ok = await new Promise((res) => { try { tg.showConfirm(`Удалить все записи «${meal.t}»?`, res); } catch { res(window.confirm(`Удалить все записи «${meal.t}»?`)); } });
        if (!ok) return;
        S.data.e = S.data.e.filter((e) => e.m !== m);
        closeSheet(); render(); await saveDay();
      }),
      mmCopy: lock(async () => {
        const list = items().map((e, i) => ({ ...e, m: st.tm, t: new Date(st.target.getFullYear(), st.target.getMonth(), st.target.getDate(), new Date(e.t || Date.now()).getHours(), new Date(e.t || Date.now()).getMinutes()).getTime() + i }));
        if (sameDay(st.target, S.day)) { S.data.e.push(...list); await saveDay(); }
        else {
          const k = dayKey(st.target);
          const v = await Store.get([k]);
          const d = parse(v[k], { e: [], w: 0 });
          d.e.push(...list);
          await Store.set(k, JSON.stringify(d));
          S.daySet.add(k); S.strip.set(k, totalsOf(d.e).k); S.daysCache = null;
        }
        haptic('success'); toast(`Скопировано на ${dayTitle(st.target).toLowerCase()}`); closeSheet(); render();
      }),
    },
  };
}

function waterLogSheet() {
  const st = { week: null };
  loadDays(7).then((d) => { st.week = d; if (sheets[sheets.length - 1] === sheet) refreshSheet(); });
  const g = goals(S.profile);
  const sheet = {
    title: 'Вода',
    render: () => `<div class="card"><div class="water-big"><b>${n0(S.data.w)}</b><span>из ${n0(g.water)} мл</span></div>
        <div class="bar"><i style="width:${Math.min(100, (S.data.w / g.water) * 100)}%;background:linear-gradient(90deg,#7fd8ff,#2a9df4)"></i></div></div>
      <div class="section-h"><span>За неделю</span>${st.week ? `<span>в среднем ${n0(avg(st.week.filter((d) => d.w > 0).map((d) => d.w)))} мл</span>` : ''}</div>
      <div class="card">${st.week ? barChart(st.week.map((d) => d.w), { goal: g.water, labels: st.week.map((d) => ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.date.getDay()]), color: 'url(#gWater)', overColor: 'url(#gWater)', unit: 'мл', height: 140 }) : '<div class="spinner" style="margin:20px auto"></div>'}</div>
      <div class="section-h"><span>${dayTitle(S.day)}</span></div>
      <div class="list">${(S.data.wl || []).slice().reverse().map(([ts, ml]) => `<div class="row"><div class="fic">${ml > 0 ? '💧' : '↩️'}</div><div class="main"><div class="title">${ml > 0 ? '+' : ''}${n0(ml)} мл</div></div><div class="val">${new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div></div>`).join('')
        || '<div class="row"><div class="main sub">Записей пока нет</div></div>'}</div>
      <div class="water-quick big">${[100, 200, 300, 500].map((v) => `<button data-a="wlAdd" data-v="${v}">+${v} мл</button>`).join('')}</div>`,
    actions: { wlAdd: lock(async (d) => { await setWater(S.data.w + +d.v); refreshSheet(); }) },
  };
  return sheet;
}

function glassSheet() {
  const st = { v: S.profile.glass || 250 };
  return {
    title: 'Объём стакана',
    compact: true,
    render: () => `<div class="chips daypick">${[150, 200, 250, 300, 330, 400, 500].map((v) => `<button class="chip ${st.v === v ? 'on' : ''}" data-a="gl" data-v="${v}">${v} мл</button>`).join('')}</div>
      <div class="list"><div class="field"><label>Свой объём</label><input id="glassIn" inputmode="numeric" value="${st.v}"><span class="unit">мл</span></div></div>
      <button class="btn" data-a="glSave">Сохранить</button>`,
    mount(el) { el.querySelector('#glassIn').addEventListener('input', (e) => { st.v = num(e.target.value); }); },
    actions: {
      gl(d) { st.v = +d.v; refreshSheet(); },
      async glSave() {
        if (st.v < 50 || st.v > 1000) return toast('От 50 до 1000 мл');
        S.profile.glass = Math.round(st.v); closeSheet(); render(); await saveProfile();
      },
    },
  };
}

// ---------- Напоминания (отправляет бот по расписанию) ----------
const REMINDER_TYPES = [
  ['diary', '📝', 'Заполнить дневник', 'Вечером, если забыли записать еду'],
  ['water', '💧', 'Выпить воды', 'До 3 раз в день'],
  ['weight', '⚖️', 'Внести вес', 'Раз в неделю'],
  ['stats', '📊', 'Статистика дня', 'Сколько осталось до нормы'],
  ['plan', '🗓', 'План питания', 'Посмотреть меню на завтра'],
];
const DEFAULT_REM = { diary: { on: false, t: '20:30' }, water: { on: false, ts: ['11:00', '15:00', '18:00'] }, weight: { on: false, t: '08:30', dow: 1 }, stats: { on: false, t: '21:30' }, plan: { on: false, t: '19:00' } };
function notifSheet() {
  const st = { loading: true, items: JSON.parse(JSON.stringify(DEFAULT_REM)), msg: '', saving: false };
  const load = async () => {
    if (!API_URL || !inTelegram) { st.loading = false; st.msg = 'Напоминания работают в приложении внутри Telegram.'; return refreshSheet(); }
    try {
      const r = await fetch(API_URL + '/api/reminders', { method: 'POST', body: JSON.stringify({ initData: tg.initData }) }).then((x) => x.json());
      if (r.ok && r.settings && r.settings.items) for (const k of Object.keys(DEFAULT_REM)) st.items[k] = { ...DEFAULT_REM[k], ...r.settings.items[k] };
      if (!r.ok) st.msg = r.error || '';
    } catch { st.msg = 'Нет связи с сервером'; }
    st.loading = false; refreshSheet();
  };
  load();
  return {
    title: 'Напоминания',
    render: () => st.loading ? skeleton(3) : `<p class="hint" style="margin:0 6px 12px">Бот пришлёт сообщение в выбранное время. Отключайте ненужное — без штрафов и давления 🙂</p>
      <div class="list">${REMINDER_TYPES.map(([k, ic, t, sub]) => {
        const it = st.items[k];
        return `<button class="row" data-a="rmToggle" data-k="${k}"><div class="fic">${ic}</div><div class="main"><div class="title">${t}</div><div class="sub">${sub}</div></div><span class="switch ${it.on ? 'on' : ''}"><i></i></span></button>
          ${it.on ? `<div class="field rm-times">${k === 'water' ? it.ts.map((x, i) => `<input type="time" data-rmw="${i}" value="${x}">`).join('') : `<input type="time" data-rmt="${k}" value="${it.t}">`}
            ${k === 'weight' ? `<div class="seg mini">${['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((d, i) => `<button data-a="rmDow" data-v="${(i + 1) % 7}" class="${it.dow % 7 === (i + 1) % 7 ? 'on' : ''}">${d}</button>`).join('')}</div>` : ''}</div>` : ''}`;
      }).join('')}</div>
      ${st.msg ? `<div class="card admin-msg">${esc(st.msg)}</div>` : ''}
      <button class="btn" data-a="rmSave" ${st.saving ? 'disabled' : ''}>${st.saving ? 'Сохраняем…' : 'Сохранить'}</button>
      <p class="hint" style="text-align:center">Чтобы бот мог писать, у вас должен быть открыт чат с ним (нажата кнопка «Старт»).</p>`,
    mount(el) {
      el.querySelectorAll('[data-rmt]').forEach((i) => i.addEventListener('change', () => { st.items[i.dataset.rmt].t = i.value; }));
      el.querySelectorAll('[data-rmw]').forEach((i) => i.addEventListener('change', () => { st.items.water.ts[+i.dataset.rmw] = i.value; }));
    },
    actions: {
      rmToggle(d) { st.items[d.k].on = !st.items[d.k].on; haptic(); refreshSheet(); },
      rmDow(d) { st.items.weight.dow = +d.v; refreshSheet(); },
      rmSave: lock(async () => {
        if (!API_URL || !inTelegram) return toast('Доступно в Telegram');
        st.saving = true; st.msg = ''; refreshSheet();
        try {
          const r = await fetch(API_URL + '/api/reminders', { method: 'POST', body: JSON.stringify({ initData: tg.initData, settings: { tz: new Date().getTimezoneOffset(), items: st.items } }) }).then((x) => x.json());
          st.msg = r.ok ? '✅ Напоминания сохранены' : '⚠️ ' + (r.error || 'Ошибка');
          if (r.ok) haptic('success');
        } catch { st.msg = '⚠️ Нет связи с сервером'; }
        st.saving = false; refreshSheet();
      }),
    },
  };
}
