'use strict';
/* ============================================================
   Статистика и анализ прогресса (вкладка «Статистика»)
   ============================================================ */

/** Загружает последние n дней (старые → новые). Кэшируется до следующего изменения дневника. */
async function loadDays(n) {
  if (S.daysCache && S.daysCache.n >= n) return S.daysCache.list.slice(-n);
  const today = startOfDay(new Date());
  const keys = Array.from({ length: n }, (_, i) => dayKey(addDays(today, i - n + 1)));
  const curKey = dayKey(S.day);
  const vals = await Store.get(keys.filter((k) => S.daySet.has(k) && k !== curKey));
  const list = keys.map((k) => {
    const d = k === curKey ? S.data : parse(vals[k], { e: [], w: 0 });
    return { date: keyToDate(k), key: k, e: d.e || [], w: d.w || 0, t: totalsOf(d.e || []) };
  });
  S.daysCache = { n, list };
  return list;
}

const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
const weekStart = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));

/** Средний вес по неделям: [{ start, avg, n }] */
function weeklyWeights(weights) {
  const map = new Map();
  for (const [iso, kg] of weights) {
    const ws = isoDate(weekStart(parseIso(iso)));
    const x = map.get(ws) || { start: parseIso(ws), sum: 0, n: 0 };
    x.sum += kg; x.n++;
    map.set(ws, x);
  }
  return [...map.values()].sort((a, b) => a.start - b.start).map((x) => ({ start: x.start, avg: x.sum / x.n, n: x.n }));
}

/** Скользящее среднее веса за 7 дней для каждой точки. */
function movingAvg(points) {
  return points.map(([iso]) => {
    const d = parseIso(iso), from = addDays(d, -6);
    const w = points.filter(([j]) => { const x = parseIso(j); return x >= from && x <= d; }).map((p) => p[1]);
    return [iso, avg(w)];
  });
}

function barChart(values, { goal, color = 'url(#gBar)', overColor = 'var(--fat)', labels = [], height = 170, unit = '' } = {}) {
  const W = 340, H = height, n = values.length;
  const max = Math.max(goal ? goal * 1.15 : 0, ...values, 1);
  const bw = W / n, gap = n > 40 ? 1 : n > 14 ? 2 : 4;
  const y = (v) => H - 18 - (v / max) * (H - 30);
  const every = n > 60 ? 15 : n > 20 ? 5 : n > 10 ? 2 : 1;
  const bars = values.map((v, i) => `<rect x="${i * bw + gap / 2}" y="${y(v)}" width="${Math.max(1, bw - gap)}" height="${Math.max(0, H - 18 - y(v))}" rx="${n > 40 ? 1 : 3}" fill="${goal && v > goal * 1.1 ? overColor : color}"><title>${labels[i] || ''}: ${n0(v)} ${unit}</title></rect>`).join('');
  const lab = labels.map((l, i) => (i % every === (n - 1) % every ? `<text x="${i * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${l}</text>` : '')).join('');
  const gl = goal ? `<line x1="0" x2="${W}" y1="${y(goal)}" y2="${y(goal)}" stroke="var(--hint)" stroke-dasharray="5 4"/><text x="${W}" y="${y(goal) - 4}" text-anchor="end">${n0(goal)}</text>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="gBar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b8bff"/><stop offset="1" stop-color="#27c0f2"/></linearGradient>
    <linearGradient id="gWater" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7fd8ff"/><stop offset="1" stop-color="#2a9df4"/></linearGradient></defs>${bars}${gl}${lab}</svg>`;
}

function macroChart(days) {
  const W = 340, H = 160, n = days.length, bw = W / n, gap = n > 40 ? 1 : n > 14 ? 2 : 4;
  const max = Math.max(1, ...days.map((d) => d.t.p * 4 + d.t.f * 9 + d.t.c * 4));
  const sc = (v) => (v / max) * (H - 24);
  const bars = days.map((d, i) => {
    const p = sc(d.t.p * 4), f = sc(d.t.f * 9), c = sc(d.t.c * 4);
    const x = i * bw + gap / 2, w = Math.max(1, bw - gap);
    let yb = H - 18;
    return [['var(--prot)', p], ['var(--fat)', f], ['var(--carb)', c]].map(([col, h]) => { yb -= h; return h > 0 ? `<rect x="${x}" y="${yb}" width="${w}" height="${h}" fill="${col}"/>` : ''; }).join('');
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${bars}</svg>`;
}

function weightChart(points, from) {
  const pts = points.filter(([iso]) => parseIso(iso) >= from);
  if (pts.length < 2) return '';
  const ma = movingAvg(points).filter(([iso]) => parseIso(iso) >= from);
  const vals = pts.map((x) => x[1]);
  const lo = Math.min(...vals) - 0.6, hi = Math.max(...vals) + 0.6;
  const t0 = from.getTime(), t1 = startOfDay(new Date()).getTime();
  const W = 340, H = 180;
  const px = (iso) => 30 + ((parseIso(iso).getTime() - t0) / Math.max(t1 - t0, 1)) * (W - 40);
  const py = (v) => 10 + (1 - (v - lo) / (hi - lo)) * (H - 34);
  const line = (arr) => arr.map((p, i) => `${i ? 'L' : 'M'}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="wA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b8bff" stop-opacity=".25"/><stop offset="1" stop-color="#3b8bff" stop-opacity="0"/></linearGradient></defs>
    <text x="0" y="${py(hi - 0.6) + 4}">${n1(hi - 0.6)}</text><text x="0" y="${py(lo + 0.6) + 4}">${n1(lo + 0.6)}</text>
    <path d="${line(ma)} L${px(ma[ma.length - 1][0])},${H - 24} L${px(ma[0][0])},${H - 24} Z" fill="url(#wA)"/>
    <path d="${line(ma)}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    ${pts.map((p) => `<circle cx="${px(p[0])}" cy="${py(p[1])}" r="3.5" fill="var(--card2)" stroke="var(--accent2)" stroke-width="2"><title>${dateText(parseIso(p[0]))}: ${n1(p[1])} кг</title></circle>`).join('')}
    <text x="30" y="${H - 6}">${dateText(from)}</text><text x="${W}" y="${H - 6}" text-anchor="end">сегодня</text></svg>`;
}

function insights(days, prev, g) {
  const logged = days.filter((d) => d.t.k > 0);
  const out = [];
  if (!logged.length) return out;
  const ak = avg(logged.map((d) => d.t.k));
  out.push(['🔥', `Среднее потребление — <b>${n0(ak)} ккал</b> в день (норма ${n0(g.kcal)}).`]);
  const prevLogged = prev.filter((d) => d.t.k > 0);
  if (prevLogged.length) {
    const diff = ak - avg(prevLogged.map((d) => d.t.k));
    if (Math.abs(diff) >= 1) out.push(['📈', `По сравнению с прошлым таким же периодом: <b>${diff > 0 ? '+' : '−'}${n0(Math.abs(diff))} ккал</b> в день.`]);
  }
  const inNorm = logged.filter((d) => d.t.k >= g.kcal * 0.85 && d.t.k <= g.kcal * 1.1).length;
  out.push(['🎯', `Норма калорий выполнена <b>${inNorm} ${plural(inNorm, 'день', 'дня', 'дней')} из ${logged.length}</b> с записями.`]);
  const pDays = logged.filter((d) => d.t.p >= g.protein * 0.9).length;
  out.push(['💪', `Норма белка — <b>${pDays} из ${logged.length}</b> ${plural(logged.length, 'дня', 'дней', 'дней')}. В среднем ${n0(avg(logged.map((d) => d.t.p)))} г из ${n0(g.protein)} г.`]);
  const water = days.filter((d) => d.w > 0);
  if (water.length) out.push(['💧', `Вода — в среднем <b>${n0(avg(water.map((d) => d.w)))} мл</b> в день.`]);
  const from = days[0].date;
  const ws = S.weights.filter(([iso]) => parseIso(iso) >= addDays(from, -7));
  if (ws.length >= 2) {
    const first = avg(ws.filter(([iso]) => parseIso(iso) < addDays(from, 7)).map((x) => x[1])) || ws[0][1];
    const last = avg(ws.filter(([iso]) => parseIso(iso) > addDays(startOfDay(new Date()), -7)).map((x) => x[1])) || ws[ws.length - 1][1];
    const dw = last - first;
    out.push(['⚖️', `Средний вес изменился на <b>${dw > 0 ? '+' : ''}${n1(dw)} кг</b> (сравниваются недельные средние, а не отдельные взвешивания).`]);
  }
  const freq = new Map();
  logged.forEach((d) => d.e.forEach((e) => freq.set(e.n, (freq.get(e.n) || 0) + 1)));
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length) out.push(['🍽️', `Чаще всего вы едите: ${top.map(([n, c]) => `${esc(n)} (${c})`).join(', ')}.`]);
  return out;
}

function renderStats() {
  const n = S.statPeriod || 7;
  if (!S.daysCache || S.daysCache.n < n * 2) {
    loadDays(Math.max(14, n * 2)).then(() => { if (S.tab === 'stats') render(); });
    return `<div class="top"><h1>Статистика</h1></div>${skeleton(4)}`;
  }
  const g = goals(S.profile);
  const all = S.daysCache.list;
  const days = all.slice(-n), prev = all.slice(-n * 2, -n);
  const labels = days.map((d) => d.date.getDate());
  const logged = days.filter((d) => d.t.k > 0);
  const from = days[0].date;
  const ws = weeklyWeights(S.weights).slice(-6).reverse();
  const last = S.weights[S.weights.length - 1];
  const seg = `<div class="seg period">${[[7, '7 дней'], [30, '30 дней'], [90, '90 дней']].map(([v, t]) => `<button data-a="period" data-v="${v}" class="${n === v ? 'on' : ''}">${t}</button>`).join('')}</div>`;
  const ins = insights(days, prev, g);
  const pAvg = avg(logged.map((d) => d.t.p)), fAvg = avg(logged.map((d) => d.t.f)), cAvg = avg(logged.map((d) => d.t.c));
  const mBar = (label, v, goal, color) => `<div class="mstat"><div class="mstat-h"><span><i style="background:${color}"></i>${label}</span><b>${n0(v)} / ${n0(goal)} г</b></div><div class="bar"><i style="width:${Math.min(100, (v / Math.max(goal, 1)) * 100)}%;background:${color}"></i></div></div>`;

  return `<div class="top"><h1><span class="sub-title">Анализ прогресса</span>Статистика</h1></div>
    ${seg}
    ${!logged.length && !S.weights.length ? emptyState('📊', 'Пока мало данных', 'Добавляйте еду и вес — здесь появятся графики и выводы по вашим реальным записям.', 'quickAdd', 'Добавить еду') : ''}
    ${ins.length ? `<div class="card insights">${ins.map(([i, t]) => `<div class="ins"><span>${i}</span><p>${t}</p></div>`).join('')}</div>` : ''}

    <div class="section-h"><span>Калории по дням</span><span>${logged.length} из ${n} дн.</span></div>
    <div class="card">${barChart(days.map((d) => d.t.k), { goal: g.kcal, labels, unit: 'ккал' })}
      <div class="legend"><span><i style="background:var(--grad)"></i>в пределах нормы</span><span><i style="background:var(--fat)"></i>больше нормы на 10%+</span><span><i style="border-top:2px dashed var(--hint);height:0;border-radius:0"></i>норма</span></div></div>

    <div class="section-h"><span>Белки, жиры, углеводы</span><span>в среднем</span></div>
    <div class="card">${macroChart(days)}
      ${mBar('Белки', pAvg, g.protein, 'var(--prot)')}${mBar('Жиры', fAvg, g.fat, 'var(--fat)')}${mBar('Углеводы', cAvg, g.carbs, 'var(--carb)')}</div>

    ${paceHTML()}
    <div class="section-h"><span>Вес</span><span>${last ? n1(last[1]) + ' кг' : ''}</span></div>
    <div class="card">
      <div class="weight-add"><input id="newWeight" inputmode="decimal" placeholder="${n1(last ? last[1] : S.profile.weight)}"><span>кг</span><button class="btn" data-a="addWeight">Записать</button></div>
      ${weightChart(S.weights, from) || `<p class="hint">Добавьте минимум 2 взвешивания за период — появится график с линией среднего за 7 дней.</p>`}
      ${S.weights.length >= 2 ? `<div class="legend"><span><i style="background:var(--accent)"></i>среднее за 7 дней</span><span><i style="background:var(--card2);border:2px solid var(--accent2)"></i>взвешивания</span></div>` : ''}
    </div>
    ${ws.length ? `<div class="section-h"><span>Средний вес по неделям</span></div>
      <div class="list">${ws.map((w, i) => { const d = ws[i + 1] ? w.avg - ws[i + 1].avg : null; return `<div class="row"><div class="main"><div class="title">Неделя с ${dateText(w.start)}</div><div class="sub">${w.n} ${plural(w.n, 'взвешивание', 'взвешивания', 'взвешиваний')}</div></div>
        <div class="val">${n1(w.avg)} кг ${d != null ? `<small class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${n1(Math.abs(d))}</small>` : ''}</div></div>`; }).join('')}</div>` : ''}

    ${measHTML()}
    <div class="section-h"><span>Вода</span><span>цель ${n0(g.water)} мл</span></div>
    <div class="card">${barChart(days.map((d) => d.w), { goal: g.water, labels, color: 'url(#gWater)', overColor: 'url(#gWater)', unit: 'мл' })}</div>

    <div class="section-h"><span>Календарь</span></div>
    <div class="card">${heatmapFrom(all, g)}</div>

    <div class="section-h"><span>Последние дни</span></div>
    <div class="list">${days.slice().reverse().filter((d) => d.t.k > 0 || d.w > 0).slice(0, 14).map((d) => `<button class="row" data-a="openDay" data-d="${isoDate(d.date)}">
      <div class="main"><div class="title">${cap(WEEKDAYS[d.date.getDay()])}, ${dateText(d.date)}</div><div class="sub">Б ${n0(d.t.p)} · Ж ${n0(d.t.f)} · У ${n0(d.t.c)} · вода ${n0(d.w)} мл</div></div>
      <div class="val" style="${d.t.k > g.kcal * 1.1 ? 'color:var(--fat)' : ''}">${n0(d.t.k)} ккал</div></button>`).join('') || '<div class="row"><div class="main sub">Нет записей за период</div></div>'}</div>

    <div class="section-h"><span>Экспорт и обмен</span></div>
    <div class="list">
      <button class="row" data-a="exportCsv"><div class="fic">📊</div><div class="main"><div class="title">Экспорт в Excel (CSV)</div><div class="sub">Файл придёт в чат с ботом</div></div></button>
      <button class="row" data-a="exportReport"><div class="fic">📄</div><div class="main"><div class="title">Отчёт для печати / PDF</div><div class="sub">Откройте файл и выберите «Печать → Сохранить как PDF»</div></div></button>
      <button class="row" data-a="weekCard"><div class="fic">🖼</div><div class="main"><div class="title">Карточка недели</div><div class="sub">Красивая картинка для сторис и чатов</div></div></button>
      <button class="row" data-a="shareStats"><div class="fic">🔗</div><div class="main"><div class="title">Поделиться статистикой</div><div class="sub">Отправить итоги другу в Telegram</div></div></button>
    </div>`;
}

function heatmapFrom(list, g) {
  const today = startOfDay(new Date());
  const monday = weekStart(today);
  const start = addDays(monday, -28);
  const byDay = new Map(list.map((x) => [x.key, x.t.k]));
  const cells = [];
  for (let i = 0; i < 35; i++) {
    const d = addDays(start, i);
    const k = byDay.get(dayKey(d)) || 0;
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

// ---------- Экспорт ----------
async function exportFile(filename, content, caption) {
  if (!API_URL || !inTelegram) return toast('Экспорт работает в приложении внутри Telegram');
  toast('Готовим файл…');
  try {
    const r = await fetch(API_URL + '/api/export', { method: 'POST', body: JSON.stringify({ initData: tg.initData, filename, content, caption }) }).then((x) => x.json());
    if (r.ok) { haptic('success'); toast('📎 Файл отправлен в чат с ботом'); }
    else toast('⚠️ ' + (r.error || 'Не удалось отправить'));
  } catch { toast('⚠️ Нет связи с сервером'); }
}
async function buildCsv(n) {
  const days = await loadDays(n);
  const rows = [['Дата', 'Приём пищи', 'Продукт', 'Количество', 'Граммы', 'Ккал', 'Белки', 'Жиры', 'Углеводы', 'Вода за день, мл']];
  const MEAL = Object.fromEntries(MEALS.map((m) => [m.id, m.t]));
  const f1 = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
  for (const d of days) {
    if (!d.e.length && !d.w) continue;
    if (!d.e.length) rows.push([isoDate(d.date), '', '', '', '', '', '', '', '', d.w]);
    d.e.forEach((e) => { const x = per(e, e.g); rows.push([isoDate(d.date), MEAL[e.m] || '', e.n, qtyText(e), f1(e.g), f1(x.k), f1(x.p), f1(x.f), f1(x.c), d.w]); });
  }
  rows.push([]); rows.push(['Вес']); S.weights.forEach(([iso, kg]) => rows.push([iso, '', '', '', '', '', '', '', '', '', f1(kg)]));
  return rows.map((r) => r.map((c) => `"${tr(String(c ?? '')).replace(/"/g, '""')}"`).join(';')).join('\r\n');
}
async function buildReport(n) {
  const days = await loadDays(n);
  const g = goals(S.profile);
  const logged = days.filter((d) => d.t.k > 0);
  const ins = insights(days, [], g).map(([i, t]) => `<li>${i} ${t}</li>`).join('');
  const rows = days.slice().reverse().filter((d) => d.t.k > 0).map((d) => `<tr><td>${dateText(d.date)}</td><td>${n0(d.t.k)}</td><td>${n0(d.t.p)}</td><td>${n0(d.t.f)}</td><td>${n0(d.t.c)}</td><td>${n0(d.w)}</td></tr>`).join('');
  return tr(`<!doctype html><html lang="${LANG}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Отчёт о питании</title>
  <style>body{font:15px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:#0b1b36;max-width:760px;margin:24px auto;padding:0 16px}h1{margin:0 0 4px}p.s{color:#6b80a4;margin:0 0 20px}
  .k{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}.k div{flex:1;min-width:140px;border:1px solid #dbe6f7;border-radius:14px;padding:12px}.k b{display:block;font-size:22px}
  table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:8px;border-bottom:1px solid #e3ecf8;text-align:right}th:first-child,td:first-child{text-align:left}th{color:#6b80a4;font-weight:600}
  li{margin:6px 0}@media print{body{margin:0}}</style></head><body>
  <h1>Отчёт о питании</h1><p class="s">${dateText(days[0].date)} — ${dateText(days[days.length - 1].date)} · ${esc(CFG.title)}</p>
  <div class="k"><div><span>Норма</span><b>${n0(g.kcal)} ккал</b></div><div><span>В среднем</span><b>${n0(avg(logged.map((d) => d.t.k)))} ккал</b></div><div><span>Дней с записями</span><b>${logged.length} из ${n}</b></div></div>
  <h3>Выводы</h3><ul>${ins || '<li>Недостаточно данных</li>'}</ul>
  <h3>По дням</h3><table><tr><th>Дата</th><th>Ккал</th><th>Б, г</th><th>Ж, г</th><th>У, г</th><th>Вода, мл</th></tr>${rows}</table>
  <p class="s" style="margin-top:20px">Все значения рассчитаны по вашим записям и носят ориентировочный характер.</p></body></html>`);
}

Object.assign(actions, {
  period(d) { S.statPeriod = +d.v; haptic(); render(); },
  async exportCsv() { track('export'); const n = S.statPeriod || 30; await exportFile(`kalorii_${isoDate(new Date())}.csv`, await buildCsv(Math.max(n, 30)), '📊 Дневник питания (откройте в Excel или Google Таблицах)'); },
  async exportReport() { await exportFile(`otchet_${isoDate(new Date())}.html`, await buildReport(S.statPeriod || 30), '📄 Отчёт: откройте файл и нажмите «Печать → Сохранить как PDF»'); },
  async shareStats() {
    const days = await loadDays(7);
    const logged = days.filter((d) => d.t.k > 0);
    const text = `Моя неделя в «${CFG.title}» 🥗\n🔥 Серия: ${streak()} ${plural(streak(), 'день', 'дня', 'дней')} подряд\n📊 В среднем ${n0(avg(logged.map((d) => d.t.k)))} ккал в день\n📅 Дней с записями: ${logged.length} из 7`;
    const target = CFG.botLink || location.href.split('#')[0].split('?')[0];
    const link = `https://t.me/share/url?url=${encodeURIComponent(target)}&text=${encodeURIComponent(text)}`;
    try { tg.openTelegramLink(link); } catch { window.open(link, '_blank'); }
  },
});
