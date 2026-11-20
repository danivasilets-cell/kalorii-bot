'use strict';
/* ============================================================
   ИИ-функции: распознавание еды по фото, голос/текст → продукты, ИИ-помощник.
   Сервер — Cloudflare Workers AI (см. bot/worker.js). Подпись Telegram проверяется на сервере.
   ============================================================ */

async function aiCall(path, payload) {
  if (!API_URL) return { ok: false, error: 'Сервер не подключён' };
  if (!inTelegram) return { ok: false, error: 'ИИ работает только в приложении внутри Telegram' };
  try {
    const r = await fetch(API_URL + path, { method: 'POST', body: JSON.stringify({ initData: tg.initData, ...payload }) });
    const j = await r.json().catch(() => ({ ok: false, error: 'Сервер вернул неожиданный ответ' }));
    if (!j.ok) logError(`ai ${path}: ${j.error}`);
    return j;
  } catch (e) { return { ok: false, error: 'Нет связи с сервером' }; }
}

// ---------- Поиск продукта в базе по свободному названию ----------
const normName = (t) => String(t).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]+/g, ' ').trim();
const stem = (w) => (w.length > 5 ? w.slice(0, -2) : w.length > 3 ? w.slice(0, -1) : w);
const STOP_WORDS = ['на', 'с', 'со', 'из', 'в', 'и', 'по', 'под', 'для', 'без', 'от', 'до', 'или'];
// Обычные слова → самый типичный продукт базы.
const FOOD_ALIASES = [
  [/^кур(иц|очк|ятин)/, 'Куриная грудка варёная'], [/^грудк/, 'Куриная грудка варёная'], [/^молок/, 'Молоко 2,5%'], [/^кефир/, 'Кефир 2,5%'],
  [/^сметан/, 'Сметана 15%'], [/^творог|^творож/, 'Творог 5%'], [/^рис/, 'Рис белый варёный'], [/^макарон|^паст[аыу]$|^спагетт/, 'Макароны варёные'],
  [/^картош|^картофел/, 'Картофель варёный'], [/^пюре/, 'Картофельное пюре'], [/^яйц|^яиц/, 'Яйцо куриное'], [/^хлеб/, 'Хлеб белый'], [/^батон/, 'Батон нарезной'],
  [/^сыр[ауом]?$/, 'Сыр твёрдый'], [/^кофе/, 'Кофе чёрный (американо)'], [/^ча[йяю]/, 'Чай без сахара'], [/^гречк|^гречн/, 'Гречка варёная'],
  [/^овсянк|^овсян/, 'Овсянка на воде'], [/^говядин/, 'Говядина варёная'], [/^свинин/, 'Свинина варёная'], [/^рыб/, 'Минтай'], [/^йогурт/, 'Йогурт натуральный 2%'],
  [/^масл[оа]$/, 'Масло сливочное 82%'], [/^салат$/, 'Салат из свежих овощей с маслом'], [/^суп/, 'Суп куриный с лапшой'], [/^пельмен/, 'Пельмени варёные'],
];
function matchFood(name) {
  const clean = normName(name).split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.includes(w));
  if (clean.length === 1 && !/\d/.test(name)) {
    const al = FOOD_ALIASES.find(([re]) => re.test(clean[0]));
    if (al) { const f = BUILTIN.find((x) => x.n === al[1]); if (f) return f; }
  }
  const nums = (String(name).match(/\d+([.,]\d+)?/g) || []).map((x) => x.replace('.', ','));
  const q = clean.map(stem);
  if (!q.length) return null;
  let best = null, bestScore = 0;
  const pool = [...(CFG.foods || []).map((f) => ({ ...f, star: true })), ...S.custom, ...S.recent, ...BUILTIN];
  for (const f of pool) {
    const nm = normName(f.n), words = nm.split(/\s+/);
    let hit = 0;
    for (const s of q) if (words.some((w) => w.length > 2 && w.startsWith(s))) hit++;
    // Должно совпасть большинство значимых слов запроса, и первое слово продукта — с одним из них.
    const firstOk = words[0].startsWith(q[0]);
    if (!hit || hit / q.length < (firstOk ? 0.5 : 0.6) || !q.some((s) => words[0].startsWith(s))) continue;
    const score = hit / q.length - 0.04 * Math.max(0, words.length - q.length) + (words[0].startsWith(q[0]) ? 0.15 : 0) + (nums.some((x) => f.n.includes(x)) ? 0.2 : 0);
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return best;
}

// ---------- Разбор фразы без ИИ (запасной вариант) ----------
const NUM_WORDS = { один: 1, одна: 1, одно: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
  сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900,
  пол: 0.5, половина: 0.5, половинку: 0.5, полтора: 1.5, полторы: 1.5 };
function localParse(text) {
  let t = ' ' + String(text).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9,;.% ]+/g, ' ').replace(/\.(?!\d)/g, ',') + ' ';
  let meal = null;
  for (const [re, m] of [[/ (на )?завтрак[а-я]* /, 'b'], [/ (на )?обед[а-я]* /, 'l'], [/ (на )?ужин[а-я]* /, 'd'], [/ (на )?перекус[а-я]* /, 's']]) if (re.test(t)) { meal = m; t = t.replace(re, ' '); }
  t = t.replace(/ (добавь|добавить|запиши|записать|я|съел|съела|выпил|выпила|сегодня|еще|ещё) /g, ' ');
  const parts = t.split(/,|;| и | плюс | а также /).map((x) => x.trim()).filter(Boolean);
  return parts.map((p) => {
    const words = p.split(/\s+/);
    let amount = 0, unit = '', name = [];
    for (const w of words) {
      if (/^\d+([.,]\d+)?$/.test(w)) { amount += parseFloat(w.replace(',', '.')); continue; }
      if (NUM_WORDS[w] != null) { amount += NUM_WORDS[w]; continue; }
      if (w === 'полкило') { amount += 500; unit = 'г'; continue; }
      if (/^(г|гр|грамм[а-я]*|кг|килограмм[а-я]*|мл|миллилитр[а-я]*|л|литр[а-я]*|шт|штук[а-я]*|ложк[а-я]*|стакан[а-я]*|порци[а-я]*|кусок|куск[а-я]*|кусочк[а-я]*|чашк[а-я]*|кружк[а-я]*|тарелк[а-я]*|миск[а-я]*)$/.test(w)) { unit = w; continue; }
      name.push(w);
    }
    let grams = 0, count = 0;
    if (/^(г|гр|грамм[а-я]*|мл|миллилитр[а-я]*)$/.test(unit)) grams = amount;
    else if (/^(кг|килограмм[а-я]*|л|литр[а-я]*)$/.test(unit)) grams = amount * 1000;
    else if (/^ложк/.test(unit)) grams = (amount || 1) * 15;
    else if (/^(стакан|чашк|кружк)/.test(unit)) grams = (amount || 1) * 200;
    else count = amount || (unit ? 1 : 0);
    return { name: name.join(' '), grams, count, meal };
  }).filter((x) => x.name);
}

/** Превращает распознанные позиции в продукты с весом. */
function resolveItems(items) {
  return items.map((it) => {
    const db = matchFood(it.name);
    let food = db ? plainFood(db) : null;
    let src = db ? 'db' : 'ai';
    if (!food && it.kcal > 0) food = { n: cap(it.name), k: it.kcal, p: it.p || 0, f: it.f || 0, c: it.c || 0 };
    if (!food) return { name: it.name, food: null, g: it.grams || 100, src: 'none', meal: it.meal };
    if (db && db.s) food.s = db.s;
    let g = it.grams || 0;
    if (it.count && (!g || it.count > 1 && food.s && Math.abs(g - it.count * food.s) > g * 0.5)) g = it.count * (food.s || 100);
    if (!g) g = food.s || 100;
    return { name: it.name, food, g: Math.round(g), src, meal: it.meal, cnt: it.count && food.s ? it.count : 0 };
  });
}

// ---------- Экран проверки распознанного ----------
function reviewSheet(items, meal, source) {
  const st = { meal: meal || (items.find((x) => x.meal) || {}).meal || suggestedMeal() };
  // Единица для каждой позиции: штуки, если назвали количество, мл — для напитков, иначе граммы.
  const initUnit = (x) => {
    if (!x.food) { x.u = 'г'; x.q = x.g; return; }
    x.pcw = pieceWeight(x.food) || 0;
    if (x.cnt && x.pcw) { x.u = 'шт'; x.q = x.cnt; x.g = x.q * x.pcw; }
    else if (isLiquid(x.food)) { x.u = 'мл'; x.q = Math.round(x.g / density(x.food)); }
    else { x.u = 'г'; x.q = x.g; }
  };
  items.forEach(initUnit);
  const regram = (x) => { x.g = Math.round(x.q * unitFactor(x.food || {}, x.u, x.pcw) * 10) / 10; };
  const tot = () => items.filter((x) => x.food).reduce((a, x) => { const v = per(x.food, x.g); a.k += v.k; a.p += v.p; a.f += v.f; a.c += v.c; return a; }, { k: 0, p: 0, f: 0, c: 0 });
  return {
    title: source === 'photo' ? 'Распознано на фото' : 'Проверьте продукты',
    render: () => `<div class="ai-note">🤖 Расчёт приблизительный. Проверьте продукты и вес — ничего не запишется без вашего подтверждения.</div>
      ${items.length ? `<div class="list">${items.map((x, i) => {
        const v = x.food ? per(x.food, x.g) : null;
        return `<div class="row rv"><div class="fic">${x.food ? catEmoji(x.food) : '❓'}</div>
          <div class="main"><button class="rv-name" data-a="rvReplace" data-i="${i}">${esc(x.food ? x.food.n : x.name)} <span>✎</span></button>
            <div class="sub">${v ? `${n0(v.k)} ккал · Б ${n1(v.p)} Ж ${n1(v.f)} У ${n1(v.c)}` : 'не найдено — нажмите, чтобы выбрать'}${x.src === 'ai' ? ' · <em>оценка ИИ</em>' : ''}</div></div>
          <input class="gram-in" data-rg="${i}" inputmode="decimal" value="${n1(x.q)}"><button class="unit-btn" data-a="rvUnit" data-i="${i}">${UNIT_LABEL[x.u]}</button>
          <button class="link-btn" style="color:var(--danger)" data-a="rvDel" data-i="${i}" aria-label="Удалить">✕</button></div>`;
      }).join('')}</div>` : '<div class="card"><p class="hint" style="margin:0">Ничего не распознано. Добавьте продукт вручную.</p></div>'}
      <div class="list"><button class="row add" data-a="rvAdd"><span class="plus">+</span>Добавить продукт</button></div>
      <div class="list"><div class="field">${mealSeg(st.meal)}</div></div>
      <div class="card" id="rvTot">${totalsHTML(tot())}</div>
      <button class="btn" data-a="rvSave" ${items.some((x) => x.food) ? '' : 'disabled'}>Добавить в дневник</button>`,
    mount(el) {
      el.querySelectorAll('[data-rg]').forEach((inp) => inp.addEventListener('input', () => {
        const x = items[+inp.dataset.rg]; x.q = num(inp.value); regram(x);
        el.querySelector('#rvTot').innerHTML = totalsHTML(tot());
      }));
    },
    actions: {
      meal(d) { st.meal = d.m; refreshSheet(); },
      rvDel(d) { items.splice(+d.i, 1); haptic(); refreshSheet(); },
      rvUnit(d) {
        const x = items[+d.i];
        if (!x.food) return;
        const us = unitsFor(x.food).filter((u) => u !== 'шт' || pieceWeight(x.food));
        const st2 = { u: x.u, q: x.q, pcw: x.pcw || pieceWeight(x.food) };
        switchUnit(x.food, st2, us[(us.indexOf(x.u) + 1) % us.length]);
        Object.assign(x, st2); regram(x); haptic(); refreshSheet();
      },
      rvReplace(d) {
        const it = items[+d.i];
        openSheet(addFoodSheet(st.meal, { query: it.food ? it.food.n : it.name, pick: (food, g) => { it.food = plainFood(food); it.g = g; it.src = 'db'; it.cnt = 0; initUnit(it); sheets.splice(sheets.length - 2, 2); renderSheet(); } }));
      },
      rvAdd() { openSheet(addFoodSheet(st.meal, { pick: (food, g) => { const it = { name: food.n, food: plainFood(food), g, src: 'db' }; initUnit(it); items.push(it); sheets.splice(sheets.length - 2, 2); renderSheet(); } })); },
      rvSave: lock(async () => {
        const ok = items.filter((x) => x.food && x.g > 0);
        if (!ok.length) return toast('Нет продуктов для добавления');
        const now = Date.now();
        ok.forEach((x, i) => S.data.e.push({ ...plainFood(x.food), g: x.g, m: st.meal, t: now + i, u: x.u === 'г' ? undefined : x.u, q: x.u === 'г' ? undefined : x.q }));
        for (const x of ok) await remember(x.food, x.g);
        S.profile.added = (S.profile.added || 0) + ok.length;
        haptic('success'); closeAllSheets(); render(); toast(`Добавлено: ${ok.length}`);
        await saveDay(); saveProfile();
      }),
    },
  };
}

// ---------- Фото ----------
function resizeImage(file, max = 1024, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть изображение')); };
    img.src = url;
  });
}
function photoSheet(meal) {
  const st = { preview: null, busy: false, error: '' };
  return {
    title: 'Распознать по фото',
    render: () => `<div class="photo-box">${st.preview ? `<img src="${st.preview}" alt="Фото еды">` : '<span>📷</span><p>Сфотографируйте тарелку сверху, при хорошем освещении</p>'}
        ${st.busy ? '<div class="photo-busy"><div class="spinner"></div>ИИ рассматривает фото…</div>' : ''}</div>
      ${st.error ? `<div class="card admin-msg">⚠️ ${esc(st.error)}</div>` : ''}
      <div class="quick">
        <label class="qbtn"><input type="file" accept="image/*" capture="environment" data-photo hidden><span>📸</span>Сделать фото<small>камера</small></label>
        <label class="qbtn"><input type="file" accept="image/*" data-photo hidden><span>🖼</span>Из галереи<small>готовый снимок</small></label>
      </div>
      <p class="hint" style="text-align:center">Результат приблизительный — его можно исправить перед сохранением.</p>`,
    mount(el) {
      el.querySelectorAll('[data-photo]').forEach((inp) => inp.addEventListener('change', async () => {
        const file = inp.files && inp.files[0];
        if (!file) return;
        st.error = ''; st.busy = true;
        try { st.preview = await resizeImage(file); } catch (e) { st.busy = false; st.error = e.message; return refreshSheet(); }
        refreshSheet();
        const r = await aiCall('/api/ai/photo', { image: st.preview });
        st.busy = false;
        if (!r.ok) { st.error = r.error || 'Не удалось распознать'; return refreshSheet(); }
        haptic('success');
        track('photo');
        sheets.pop();
        openSheet(reviewSheet(resolveItems(r.items || []), meal, 'photo'));
      }));
    },
  };
}

// ---------- Голос и текст ----------
function voiceSheet(meal) {
  const st = { text: '', rec: null, recording: false, busy: false, error: '' };
  async function startRec() {
    st.error = '';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        st.recording = false; st.busy = true; refreshSheet();
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
        const r = await aiCall('/api/ai/voice', { audio: b64 });
        st.busy = false;
        if (r.ok && r.text) { st.text = r.text; refreshSheet(); parse(); }
        else { st.error = r.error || 'Не удалось распознать речь'; refreshSheet(); }
      };
      rec.start();
      st.rec = rec; st.recording = true; haptic(); refreshSheet();
      setTimeout(() => { if (st.recording) stopRec(); }, 30000);
    } catch (e) {
      st.error = 'Микрофон недоступен. Разрешите доступ или введите текстом.';
      refreshSheet();
    }
  }
  function stopRec() { if (st.rec && st.recording) st.rec.stop(); }
  async function parse() {
    const text = st.text.trim();
    if (!text) return toast('Скажите или напишите, что вы съели');
    st.busy = true; st.error = ''; refreshSheet();
    let items = null;
    const r = await aiCall('/api/ai/parse', { text });
    if (r.ok && r.items && r.items.length) items = r.items;
    if (!items) items = localParse(text);
    track('voice');
    st.busy = false;
    sheets.pop();
    openSheet(reviewSheet(resolveItems(items), meal, 'voice'));
  }
  return {
    title: 'Голосом или текстом',
    render: () => `<div class="voice">
        <button class="mic ${st.recording ? 'on' : ''}" data-a="mic" ${st.busy ? 'disabled' : ''}>${st.recording ? '⏹' : '🎙'}</button>
        <p>${st.recording ? 'Говорите… нажмите, чтобы закончить' : st.busy ? 'Обрабатываем…' : 'Нажмите и скажите, что съели'}</p>
      </div>
      ${st.error ? `<div class="card admin-msg">⚠️ ${esc(st.error)}</div>` : ''}
      <div class="list"><div class="field"><textarea id="voiceText" rows="3" placeholder="Например: два яйца, 100 г гречки и 150 г курицы на обед">${esc(st.text)}</textarea></div></div>
      <button class="btn" data-a="vParse" ${st.busy ? 'disabled' : ''}>${st.busy ? 'Разбираем…' : 'Разобрать'}</button>
      <p class="hint" style="text-align:center">Можно перечислить несколько продуктов, указать граммы, штуки, ложки и приём пищи.</p>`,
    mount(el) { el.querySelector('#voiceText').addEventListener('input', (e) => { st.text = e.target.value; }); },
    actions: { mic() { st.recording ? stopRec() : startRec(); }, vParse: parse },
  };
}

// ---------- ИИ-помощник ----------
const AI_EXAMPLES = ['Что мне съесть на ужин?', 'Сколько калорий осталось?', 'Как добрать белок сегодня?', 'Составь рацион на завтра', 'Предложи низкокалорийный завтрак', 'Чем заменить курицу?'];
function mdLite(t) {
  return esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>')
    .replace(/^\s*[-•*]\s+(.+)$/gm, '<span class="li">$1</span>')
    .replace(/<\/span>\n/g, '</span>')
    .replace(/\n{2,}/g, '\n')
    .replace(/\n/g, '<br>');
}
async function aiContext() {
  const g = goals(S.profile), today = totalsOf(S.data.e);
  let week = null;
  try {
    const days = (await loadDays(7)).filter((d) => d.t.k > 0);
    if (days.length) week = { days: days.length, avgKcal: Math.round(avg(days.map((d) => d.t.k))), avgProtein: Math.round(avg(days.map((d) => d.t.p))) };
  } catch {}
  const p = S.profile;
  return {
    language: { uk: 'украинский', ru: 'русский', en: 'английский' }[LANG],
    now: new Date().toLocaleString('ru-RU', { weekday: 'long', hour: '2-digit', minute: '2-digit' }),
    profile: { sex: p.sex === 'm' ? 'мужской' : 'женский', age: p.age, height: p.height, weight: p.weight, goal: (GOALS.find((x) => x.id === p.goal) || {}).t, activity: (ACTIVITY.find((x) => x.id === p.activity) || {}).t },
    norm: { kcal: g.kcal, protein: g.protein, fat: g.fat, carbs: g.carbs, water: g.water },
    today: { kcal: Math.round(today.k), protein: Math.round(today.p), fat: Math.round(today.f), carbs: Math.round(today.c), water: S.data.w, leftKcal: Math.round(g.kcal - today.k),
      eaten: S.data.e.slice(0, 25).map((e) => `${MEALS.find((m) => m.id === e.m).t}: ${e.n} ${Math.round(e.g)} г`) },
    week,
    preferences: p.prefs || '',
    favoriteFoods: S.recent.slice(0, 10).map((f) => f.n),
  };
}
function renderAI() {
  const msgs = S.chat || [];
  return `<div class="top"><h1><span class="sub-title">Персональные советы</span>ИИ-помощник</h1>
      ${msgs.length ? '<button class="pill-btn" data-a="chatClear">Очистить</button>' : ''}</div>
    <div class="ai-note">🤖 Помощник учитывает вашу цель, норму и съеденное сегодня. Ответы — ориентировочные и не заменяют консультацию врача.</div>
    <div class="chat" id="chat">
      ${msgs.length ? msgs.map((m) => `<div class="msg ${m.role}">${m.role === 'assistant' ? mdLite(m.content) : esc(m.content)}</div>`).join('')
        : `<div class="chat-empty"><div class="bot-ava">🥗</div><b>Чем помочь?</b><p>Спросите о питании — я посмотрю на ваш дневник и подскажу.</p></div>`}
      ${S.chatBusy ? '<div class="msg assistant typing"><i></i><i></i><i></i></div>' : ''}
    </div>
    <div class="chips flat">${AI_EXAMPLES.map((q) => `<button class="chip" data-a="askAI" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    <div class="chat-input"><textarea id="chatIn" rows="1" placeholder="Спросите о питании…" maxlength="800">${esc(S.chatDraft || '')}</textarea>
      <button class="send" data-a="sendAI" ${S.chatBusy ? 'disabled' : ''} aria-label="Отправить">➤</button></div>`;
}
function mountAI() {
  const inp = $('#chatIn');
  if (inp) {
    inp.addEventListener('input', () => { S.chatDraft = inp.value; inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 120) + 'px'; });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); actions.sendAI(); } });
  }
  const chat = $('#chat');
  if (chat && (S.chat || []).length) window.scrollTo(0, document.body.scrollHeight);
}
async function askAI(text) {
  text = String(text || '').trim();
  if (!text || S.chatBusy) return;
  S.chat = [...(S.chat || []), { role: 'user', content: text }];
  S.chatDraft = ''; S.chatBusy = true; render();
  track('chat');
  const r = await aiCall('/api/ai/chat', { messages: S.chat.slice(-8), context: await aiContext() });
  S.chatBusy = false;
  S.chat.push({ role: 'assistant', content: r.ok ? r.answer : `⚠️ ${r.error || 'Ошибка'}` });
  if (r.ok) haptic('success');
  if (S.tab === 'ai') render();
  const keep = [];
  for (const m of S.chat.slice().reverse()) { keep.unshift({ role: m.role, content: m.content.slice(0, 900) }); if (JSON.stringify(keep).length > 3800) { keep.shift(); break; } }
  await Store.set('chat', JSON.stringify(keep));
}
Object.assign(actions, {
  askAI(d) { askAI(d.q); },
  sendAI() { askAI(($('#chatIn') || {}).value || S.chatDraft); },
  async chatClear() { S.chat = []; render(); await Store.remove('chat'); },
  aiPhoto() { openSheet(photoSheet(suggestedMeal())); },
  aiVoice() { openSheet(voiceSheet(suggestedMeal())); },
});
