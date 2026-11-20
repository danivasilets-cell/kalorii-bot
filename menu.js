'use strict';
/* ============================================================
   Вкладка «Питание»: рецепты, избранные блюда, планировщик, список покупок
   Хранение (CloudStorage):
     ds_<id>        — избранное блюдо {id, n, sv, ing:[{n,k,p,f,c,g,cat}]}
     p_YYYYMMDD     — план на день [{id, kind:'r'|'f'|'d', ref, n, g, sv, m}]
     shop           — {done:{название:1}, extra:[...]}
   ============================================================ */

// ---------- Избранные блюда ----------
const dishTotals = (d) => {
  const t = d.ing.reduce((a, x) => { const v = per(x, x.g); a.k += v.k; a.p += v.p; a.f += v.f; a.c += v.c; a.w += x.g; return a; }, { k: 0, p: 0, f: 0, c: 0, w: 0 });
  const sv = Math.max(1, d.sv || 1);
  return { tot: t, per: { k: t.k / sv, p: t.p / sv, f: t.f / sv, c: t.c / sv, w: t.w / sv } };
};
const dishAsFood = (d) => {
  const { tot, per: pp } = dishTotals(d);
  const w = Math.max(tot.w, 1);
  return { n: d.n, k: tot.k / w * 100, p: tot.p / w * 100, f: tot.f / w * 100, c: tot.c / w * 100, s: Math.round(pp.w), did: d.id, emoji: '⭐', star: true };
};
async function saveDish(d) {
  S.dishes = [d, ...S.dishes.filter((x) => x.id !== d.id)];
  await Store.set('ds_' + d.id, JSON.stringify(d));
  checkAchievements();
}
async function deleteDish(id) {
  S.dishes = S.dishes.filter((x) => x.id !== id);
  await Store.remove('ds_' + id);
}

function dishEditorSheet(dish) {
  const d = dish ? JSON.parse(JSON.stringify(dish)) : { id: Date.now().toString(36), n: '', sv: 1, ing: [] };
  const totals = () => {
    const { tot, per: p } = dishTotals(d);
    return `<div class="dish-tot"><div><span>Всё блюдо</span><b>${n0(tot.k)} ккал</b><small>${n0(tot.w)} г · Б ${n0(tot.p)} Ж ${n0(tot.f)} У ${n0(tot.c)}</small></div>
      <div><span>1 порция</span><b>${n0(p.k)} ккал</b><small>${n0(p.w)} г · Б ${n0(p.p)} Ж ${n0(p.f)} У ${n0(p.c)}</small></div></div>`;
  };
  return {
    title: dish ? 'Блюдо' : 'Новое блюдо',
    render: () => `<div class="list">
        <div class="field"><input class="wide" id="dishName" placeholder="Название, например «Мой завтрак»" value="${esc(d.n)}" maxlength="60"></div>
        <div class="field"><label>Порций</label><button class="round-btn" data-a="svMinus">−</button><b class="sv-num">${d.sv}</b><button class="round-btn" data-a="svPlus">+</button></div>
      </div>
      <div class="section-h"><span>Ингредиенты</span><span>${d.ing.length}</span></div>
      <div class="list">
        ${d.ing.map((x, i) => `<div class="row"><div class="fic">${catEmoji(x)}</div><div class="main"><div class="title">${esc(x.n)}</div><div class="sub">${n0(per(x, x.g).k)} ккал</div></div>
          <input class="gram-in" data-ing="${i}" inputmode="decimal" value="${n1(x.g)}"><span class="unit">г</span><button class="link-btn" style="color:var(--danger)" data-a="ingDel" data-i="${i}">✕</button></div>`).join('')}
        <button class="row add" data-a="ingAdd"><span class="plus">+</span>Добавить ингредиент</button>
      </div>
      <div class="card" id="dishTot">${totals()}</div>
      <button class="btn" data-a="dishSave">Сохранить в избранное</button>
      ${dish ? '<button class="btn danger" data-a="dishDel">Удалить блюдо</button>' : ''}`,
    mount(el) {
      el.querySelector('#dishName').addEventListener('input', (e) => { d.n = e.target.value; });
      el.querySelectorAll('[data-ing]').forEach((inp) => inp.addEventListener('input', () => { d.ing[+inp.dataset.ing].g = num(inp.value); el.querySelector('#dishTot').innerHTML = totals(); }));
    },
    actions: {
      svMinus() { d.sv = Math.max(1, d.sv - 1); refreshSheet(); },
      svPlus() { d.sv = Math.min(50, d.sv + 1); refreshSheet(); },
      ingDel(x) { d.ing.splice(+x.i, 1); refreshSheet(); },
      ingAdd() {
        openSheet(addFoodSheet('s', { pick: (food, g) => { d.ing.push({ ...plainFood(food), g }); sheets.splice(sheets.length - 2, 2); renderSheet(); } }));
      },
      dishSave: lock(async () => {
        if (!d.n.trim()) return toast('Введите название');
        if (!d.ing.length) return toast('Добавьте хотя бы один ингредиент');
        d.n = d.n.trim();
        await saveDish(d);
        haptic('success'); toast('⭐ Блюдо сохранено');
        closeSheet(); if (!sheets.length) render();
      }),
      async dishDel() { await deleteDish(d.id); toast('Блюдо удалено'); closeSheet(); render(); },
    },
  };
}

// ---------- Рецепты ----------
const RECIPE_FILTERS = [
  ['all', 'Все'], ['завтрак', 'Завтраки'], ['обед', 'Обеды'], ['ужин', 'Ужины'], ['перекус', 'Перекусы'],
  ['k300', 'До 300 ккал'], ['k500', '300–500 ккал'], ['prot', 'Много белка'], ['lowc', 'Мало углеводов'],
];
function recipeMatches(r, f) {
  if (f === 'all') return true;
  if (f === 'k300') return r.per.k <= 300;
  if (f === 'k500') return r.per.k > 300 && r.per.k <= 500;
  if (f === 'prot') return r.per.p >= 30 || (r.per.p * 4) / r.per.k >= 0.3;
  if (f === 'lowc') return (r.per.c * 4) / Math.max(r.per.k, 1) <= 0.25;
  return r.tags.includes(f);
}
function recipeCard(r) {
  return `<button class="rcard" data-a="openRecipe" data-id="${r.id}">
    <div class="rcover"><span>${r.e}</span><em>⏱ ${r.t} мин</em></div>
    <div class="rbody"><b>${esc(r.n)}</b><small>${n0(r.per.k)} ккал · Б ${n0(r.per.p)} Ж ${n0(r.per.f)} У ${n0(r.per.c)}</small></div></button>`;
}
function recipeSheet(r) {
  return {
    title: 'Рецепт',
    render: () => `<div class="rhero"><span>${r.e}</span></div>
      <h2 class="rtitle">${esc(r.n)}</h2>
      <div class="rmeta"><span>⏱ ${r.t} мин</span><span>🍽 ${r.sv} ${plural(r.sv, 'порция', 'порции', 'порций')}</span><span>⚖️ ~${n0(r.per.w)} г</span></div>
      <div class="card">${totalsHTML(r.per)}<p class="hint" style="text-align:center">на 1 порцию · расчёт по ингредиентам, приблизительно</p></div>
      <div class="section-h"><span>Ингредиенты</span><span>на ${r.sv} ${plural(r.sv, 'порцию', 'порции', 'порций')}</span></div>
      <div class="list">${r.ing.map((x) => `<div class="row"><div class="fic">${catEmoji(x.f)}</div><div class="main"><div class="title">${esc(x.n)}</div></div><div class="val">${n0(x.g)} г</div></div>`).join('')}</div>
      <div class="section-h"><span>Приготовление</span></div>
      <div class="card steps">${r.steps.map((s, i) => `<div class="step"><b>${i + 1}</b><p>${esc(s)}</p></div>`).join('')}</div>
      <button class="btn" data-a="recipeEat">Съесть порцию → в дневник</button>
      <button class="btn ghost" data-a="recipePlan">🗓 Добавить в план</button>`,
    actions: {
      recipeEat() { openSheet(amountSheet(recipeAsFood(r), suggestedMeal())); },
      recipePlan() { openSheet(planPickSheet({ kind: 'r', ref: r.id, n: r.n, sv: 1 })); },
    },
  };
}

// ---------- План питания ----------
const planKey = (d) => 'p_' + dayKey(d).slice(2);
async function loadPlan(d) {
  const k = planKey(d);
  if (S.plan.has(k)) return S.plan.get(k);
  const v = await Store.get([k]);
  const list = parse(v[k], []);
  S.plan.set(k, list);
  return list;
}
async function savePlan(d, list) {
  const k = planKey(d);
  S.plan.set(k, list);
  if (list.length) await Store.set(k, JSON.stringify(list)); else await Store.remove(k);
}
function planItemFood(it) {
  if (it.kind === 'r') { const r = recipeById(it.ref); return r ? recipeAsFood(r) : null; }
  if (it.kind === 'd') { const d = S.dishes.find((x) => x.id === it.ref); return d ? dishAsFood(d) : null; }
  return it.food || null;
}
function planItemTotals(it) {
  const f = planItemFood(it);
  if (!f) return { k: 0, p: 0, f: 0, c: 0 };
  const g = it.kind === 'f' ? it.g : (f.s || 100) * (it.sv || 1);
  return per(f, g);
}
function planPickSheet(item) {
  const st = { day: addDays(startOfDay(new Date()), 1), m: item.m || 'l', sv: item.sv || 1 };
  return {
    title: 'В план',
    render: () => `<div class="card food-card"><div class="ic">🗓</div><div><b>${esc(item.n)}</b><small>Выберите день и приём пищи</small></div></div>
      <div class="chips daypick">${Array.from({ length: 14 }, (_, i) => addDays(startOfDay(new Date()), i)).map((d, i) => `<button class="chip ${sameDay(d, st.day) ? 'on' : ''}" data-a="pd" data-d="${isoDate(d)}">${planPickSheet.dayLabel(d, i)}</button>`).join('')}</div>
      <div class="list"><div class="field">${mealSeg(st.m)}</div>
        ${item.kind !== 'f' ? `<div class="field"><label>Порций</label><button class="round-btn" data-a="svm">−</button><b class="sv-num">${n1(st.sv)}</b><button class="round-btn" data-a="svp">+</button></div>` : ''}</div>
      <button class="btn" data-a="pAdd">Добавить в план</button>`,
    actions: {
      pd(d) { st.day = parseIso(d.d); refreshSheet(); },
      meal(d) { st.m = d.m; refreshSheet(); },
      svm() { st.sv = Math.max(0.5, st.sv - 0.5); refreshSheet(); },
      svp() { st.sv = Math.min(10, st.sv + 0.5); refreshSheet(); },
      pAdd: lock(async () => {
        const list = await loadPlan(st.day);
        list.push({ ...item, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), m: st.m, sv: st.sv });
        await savePlan(st.day, list);
        haptic('success'); toast(`🗓 Добавлено в план: ${dayTitle(st.day).toLowerCase()}`);
        closeSheet();
        if (S.tab === 'menu') render();
      }),
    },
  };
}
// Подпись дня в выборе даты.
planPickSheet.dayLabel = (d, i) => (i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : `${['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.getDay()]} ${d.getDate()}`);

function planMoveSheet(fromDay, item) {
  return {
    title: 'Перенести',
    compact: true,
    render: () => `<div class="card food-card"><div class="ic">↪️</div><div><b>${esc(item.n)}</b><small>Куда перенести?</small></div></div>
      <div class="chips daypick">${Array.from({ length: 14 }, (_, i) => addDays(startOfDay(new Date()), i)).map((d, i) => `<button class="chip ${sameDay(d, fromDay) ? 'on' : ''}" data-a="mv" data-d="${isoDate(d)}">${planPickSheet.dayLabel(d, i)}</button>`).join('')}</div>`,
    actions: {
      mv: lock(async (d) => {
        const to = parseIso(d.d);
        if (sameDay(to, fromDay)) return closeSheet();
        const a = await loadPlan(fromDay), b = await loadPlan(to);
        await savePlan(fromDay, a.filter((x) => x.id !== item.id));
        b.push(item);
        await savePlan(to, b);
        haptic('success'); toast('Перенесено'); closeSheet(); render();
      }),
    },
  };
}

// ---------- Список покупок ----------
async function shoppingList(daysAhead = 7) {
  const today = startOfDay(new Date());
  const need = new Map();
  const add = (n, g, cat) => { const x = need.get(n) || { n, g: 0, cat }; x.g += g; need.set(n, x); };
  for (let i = 0; i < daysAhead; i++) {
    for (const it of await loadPlan(addDays(today, i))) {
      if (it.kind === 'r') { const r = recipeById(it.ref); if (r) r.ing.forEach((x) => add(x.n, (x.g / r.sv) * (it.sv || 1), x.f.cat)); }
      else if (it.kind === 'd') { const d = S.dishes.find((x) => x.id === it.ref); if (d) d.ing.forEach((x) => add(x.n, (x.g / Math.max(1, d.sv)) * (it.sv || 1), x.cat)); }
      else if (it.food) add(it.food.n, it.g || 100, it.food.cat);
    }
  }
  need.delete('Вода');
  return [...need.values()].sort((a, b) => (a.cat ?? 99) - (b.cat ?? 99) || a.n.localeCompare(b.n));
}

// ---------- Отрисовка вкладки ----------
function renderMenu() {
  const sub = S.menuTab || 'recipes';
  const seg = `<div class="seg period">${[['recipes', 'Рецепты'], ['plan', 'План'], ['shop', 'Покупки'], ['fav', 'Избранное']].map(([v, t]) => `<button data-a="menuTab" data-v="${v}" class="${sub === v ? 'on' : ''}">${t}</button>`).join('')}</div>`;
  let body = '';
  if (sub === 'recipes') {
    const f = S.recipeFilter || 'all';
    const list = RECIPES.filter((r) => recipeMatches(r, f));
    body = `<div class="chips flat">${RECIPE_FILTERS.map(([v, t]) => `<button class="chip ${f === v ? 'on' : ''}" data-a="rFilter" data-v="${v}">${t}</button>`).join('')}</div>
      <div class="rgrid">${list.map(recipeCard).join('') || '<p class="hint">Нет рецептов под этот фильтр</p>'}</div>`;
  } else if (sub === 'plan') {
    if (!S.planReady) {
      Promise.all(Array.from({ length: 7 }, (_, i) => loadPlan(addDays(startOfDay(new Date()), i)))).then(() => { S.planReady = true; if (S.tab === 'menu') render(); });
      return `<div class="top"><h1>Питание</h1></div>${seg}${skeleton(3)}`;
    }
    const g = goals(S.profile);
    body = Array.from({ length: 7 }, (_, i) => addDays(startOfDay(new Date()), i)).map((d) => {
      const list = S.plan.get(planKey(d)) || [];
      const tot = list.reduce((a, it) => { const t = planItemTotals(it); a.k += t.k; a.p += t.p; return a; }, { k: 0, p: 0 });
      return `<div class="list plan-day">
        <div class="meal-h"><div class="badge">${d.getDate()}</div><div class="name">${cap(dayTitle(d))}<small>${cap(WEEKDAYS[d.getDay()])}</small></div>
          <div class="kcal">${list.length ? `${n0(tot.k)} <span>/ ${n0(g.kcal)}</span>` : ''}</div></div>
        ${MEALS.map((m) => list.filter((it) => it.m === m.id).map((it) => { const t = planItemTotals(it); const f = planItemFood(it);
          return `<div class="row"><div class="fic">${f && f.emoji ? f.emoji : m.i}</div><div class="main"><div class="title">${esc(it.n)}</div><div class="sub">${m.t} · ${it.kind === 'f' ? n0(it.g) + ' г' : n1(it.sv || 1) + ' порц.'} · ${n0(t.k)} ккал</div></div>
            <button class="link-btn" data-a="planMove" data-day="${isoDate(d)}" data-id="${it.id}" aria-label="Перенести">↪️</button>
            <button class="link-btn" style="color:var(--danger)" data-a="planDel" data-day="${isoDate(d)}" data-id="${it.id}" aria-label="Удалить">✕</button></div>`; }).join('')).join('')}
        <div class="plan-actions">
          <button class="row add" data-a="planAdd" data-day="${isoDate(d)}"><span class="plus">+</span>Добавить</button>
          ${list.length ? `<button class="row add" data-a="planToDiary" data-day="${isoDate(d)}"><span class="plus soft">✓</span>В дневник</button>` : ''}
        </div></div>`;
    }).join('');
    body += `<p class="hint" style="text-align:center">План — на 7 дней вперёд. «В дневник» перенесёт все блюда дня в записи.</p>`;
  } else if (sub === 'shop') {
    if (!S.shopList) {
      shoppingList(7).then((l) => { S.shopList = l; if (S.tab === 'menu') render(); });
      return `<div class="top"><h1>Питание</h1></div>${seg}${skeleton(3)}`;
    }
    const done = S.shop.done || {};
    const items = [...S.shopList.map((x) => ({ ...x, auto: true })), ...(S.shop.extra || []).map((n) => ({ n, extra: true }))];
    const left = items.filter((x) => !done[x.n]).length;
    body = items.length ? `<div class="card shop-head"><b>${left ? `Осталось купить: ${left}` : 'Всё куплено 🎉'}</b><small>По плану на 7 дней · вес округлён</small></div>
      <div class="list">${items.map((x) => `<button class="row shop ${done[x.n] ? 'done' : ''}" data-a="shopToggle" data-n="${esc(x.n)}">
        <span class="check">${done[x.n] ? '✓' : ''}</span><div class="main"><div class="title">${esc(x.n)}</div></div>
        <div class="val">${x.g ? (x.g >= 1000 ? n1(x.g / 1000) + ' кг' : n0(Math.ceil(x.g / 10) * 10) + ' г') : ''}</div></button>`).join('')}</div>
      <div class="list"><div class="field"><input class="wide" id="shopExtra" placeholder="Добавить свой пункт…" maxlength="60"></div>
        <button class="row add" data-a="shopAdd"><span class="plus">+</span>Добавить</button>
        ${Object.keys(done).length ? '<button class="row" data-a="shopClear"><div class="main" style="color:var(--hint)">Очистить отмеченные</div></button>' : ''}</div>`
      : emptyState('🛒', 'Список пуст', 'Добавьте блюда в план питания — список покупок соберётся автоматически.', 'menuTab', 'Открыть план', 'plan');
  } else {
    body = `${S.dishes.length ? `<div class="list">${S.dishes.map((d) => { const t = dishTotals(d); return `<button class="row" data-a="dishOpen" data-id="${d.id}"><div class="fic">⭐</div><div class="main"><div class="title">${esc(d.n)}</div>
        <div class="sub">${d.ing.length} ${plural(d.ing.length, 'ингредиент', 'ингредиента', 'ингредиентов')} · порция ${n0(t.per.k)} ккал</div></div>
        <span class="pill-btn" data-a="dishEat" data-id="${d.id}">+ Съесть</span></button>`; }).join('')}</div>`
      : emptyState('⭐', 'Нет избранных блюд', 'Соберите блюдо из нескольких продуктов — КБЖУ посчитается само, а добавлять его можно в одно касание.')}
      <button class="btn" data-a="dishNew">+ Создать блюдо</button>
      <p class="hint" style="text-align:center">Совет: любой приём пищи в дневнике можно сохранить как блюдо через меню «⋯».</p>`;
  }
  return `<div class="top"><h1><span class="sub-title">Рецепты · план · покупки</span>Питание</h1></div>${seg}${body}`;
}

Object.assign(actions, {
  menuTab(d) { S.menuTab = d.v || d.x; if (S.menuTab === 'shop') S.shopList = null; haptic(); render(); window.scrollTo(0, 0); },
  rFilter(d) { S.recipeFilter = d.v; haptic(); render(); },
  openRecipe(d) { openSheet(recipeSheet(recipeById(d.id))); },
  dishNew() { openSheet(dishEditorSheet(null)); },
  dishOpen(d, el, ev) { openSheet(dishEditorSheet(S.dishes.find((x) => x.id === d.id))); },
  dishEat(d) { const x = S.dishes.find((y) => y.id === d.id); if (x) openSheet(amountSheet(dishAsFood(x), suggestedMeal())); },
  async planDel(d) {
    const day = parseIso(d.day);
    await savePlan(day, (await loadPlan(day)).filter((x) => x.id !== d.id));
    S.shopList = null; haptic(); render();
  },
  async planMove(d) { const day = parseIso(d.day); const it = (await loadPlan(day)).find((x) => x.id === d.id); if (it) openSheet(planMoveSheet(day, it)); },
  planAdd(d) {
    const day = parseIso(d.day);
    openSheet(planSourceSheet(day));
  },
  planToDiary: lock(async (d) => {
    const day = parseIso(d.day);
    const list = await loadPlan(day);
    if (!sameDay(S.day, day)) await loadDay(day);
    const now = Date.now();
    let added = 0;
    list.forEach((it, i) => {
      const f = planItemFood(it);
      if (!f) return;
      const g = it.kind === 'f' ? it.g : (f.s || 100) * (it.sv || 1);
      S.data.e.push({ ...plainFood(f), g: Math.round(g), m: it.m, t: now + i, sv: it.kind === 'f' ? undefined : it.sv || 1 });
      added++;
    });
    await saveDay();
    S.profile.added = (S.profile.added || 0) + added; saveProfile();
    haptic('success'); toast(`✓ В дневник добавлено: ${added}`);
    S.tab = 'diary'; render(); window.scrollTo(0, 0);
  }),
  async shopToggle(d) {
    S.shop.done = S.shop.done || {};
    if (S.shop.done[d.n]) delete S.shop.done[d.n]; else S.shop.done[d.n] = 1;
    haptic(); render();
    await Store.set('shop', JSON.stringify(S.shop));
  },
  async shopAdd() {
    const v = ($('#shopExtra').value || '').trim();
    if (!v) return;
    S.shop.extra = [...(S.shop.extra || []), v].slice(-40);
    render();
    await Store.set('shop', JSON.stringify(S.shop));
  },
  async shopClear() {
    const done = S.shop.done || {};
    S.shop.extra = (S.shop.extra || []).filter((n) => !done[n]);
    S.shop.done = {};
    render();
    await Store.set('shop', JSON.stringify(S.shop));
  },
});

function planSourceSheet(day) {
  return {
    title: 'Что запланировать?',
    compact: true,
    render: () => `<div class="quick">
        <button data-a="psRecipe"><span>📖</span>Рецепт<small>из каталога</small></button>
        <button data-a="psFood"><span>🔍</span>Продукт<small>поиск по базе</small></button>
        <button data-a="psDish"><span>⭐</span>Моё блюдо<small>из избранного</small></button>
        <button data-a="psClose"><span>✖️</span>Отмена<small>&nbsp;</small></button></div>`,
    actions: {
      psRecipe() { closeSheet(); S.menuTab = 'recipes'; render(); toast('Откройте рецепт и нажмите «Добавить в план»'); },
      psFood() {
        closeSheet();
        openSheet(addFoodSheet('l', {
          pick: async (food, g, m) => {
            const list = await loadPlan(day);
            list.push({ id: Date.now().toString(36), kind: 'f', n: food.n, food: plainFood(food), g, m });
            await savePlan(day, list);
            closeAllSheets(); S.shopList = null; toast('🗓 Добавлено в план'); render();
          },
        }));
      },
      psDish() {
        if (!S.dishes.length) { closeSheet(); S.menuTab = 'fav'; render(); return toast('Сначала создайте блюдо'); }
        sheets.pop();
        openSheet({
          title: 'Моё блюдо', compact: true,
          render: () => `<div class="list">${S.dishes.map((d) => `<button class="row" data-a="pickDish" data-id="${d.id}"><div class="fic">⭐</div><div class="main"><div class="title">${esc(d.n)}</div></div></button>`).join('')}</div>`,
          actions: { pickDish(x) { const d = S.dishes.find((y) => y.id === x.id); closeSheet(); openSheet(planPickSheet({ kind: 'd', ref: d.id, n: d.n, sv: 1 })); } },
        });
      },
      psClose() { closeSheet(); },
    },
  };
}
