/**
 * Бот «Калории» — Cloudflare Worker (бесплатный план).
 *
 * Переменные окружения (Settings → Variables and Secrets):
 *   BOT_TOKEN       — токен от @BotFather (тип Secret)
 *   OWNER_ID        — ваш числовой Telegram ID (узнать: @userinfobot)
 *   WEBHOOK_SECRET  — любая длинная случайная строка (тип Secret)
 *   APP_URL         — (необязательно) адрес мини-приложения
 * Привязки (Bindings):
 *   DB              — KV namespace (хранит список пользователей)
 *   AI              — Workers AI (для распознавания фото, голоса и ИИ-помощника)
 * Триггер (Triggers → Cron): "* * * * *" — нужен для рассылки и напоминаний.
 *
 * После публикации откройте в браузере: https://<адрес-воркера>/setup?secret=<WEBHOOK_SECRET>
 */

const DEFAULT_APP_URL = 'https://danivasilets-cell.github.io/kalorii-bot/';
const BATCH = 40; // сообщений рассылки за один запуск (лимит бесплатного плана — 50 запросов)
const enc = new TextEncoder();

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/api/') && req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (url.pathname === '/api/open' && req.method === 'POST') return cors(await apiOpen(req, env));
    if (url.pathname === '/api/config' && req.method === 'GET') return cors(json((await env.DB.get('config', 'json')) || {}));
    if (url.pathname === '/api/config' && req.method === 'POST') return cors(await apiSaveConfig(req, env));
    if (url.pathname === '/api/stats' && req.method === 'POST') return cors(await apiStats(req, env));
    if (url.pathname === '/api/admin/setup' && req.method === 'POST') {
      const { error } = await ownerFromBody(req, env);
      if (error) return cors(error);
      const res = await setup(new URL(`${url.origin}/setup?secret=${encodeURIComponent(env.WEBHOOK_SECRET || '')}`), env);
      return cors(json({ ok: res.status === 200, text: await res.text() }, 200));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const routes = { '/api/ai/photo': apiAiPhoto, '/api/ai/parse': apiAiParse, '/api/ai/voice': apiAiVoice, '/api/ai/chat': apiAiChat, '/api/reminders': apiReminders, '/api/export': apiExport, '/api/log': apiLog,
        '/api/sync': apiSync, '/api/pending': apiPending, '/api/fast': apiFast, '/api/ref': apiRef, '/api/challenge': apiChallenge, '/api/share-photo': apiSharePhoto };
      const fn = routes[url.pathname];
      if (fn) {
        try { return cors(await fn(req, env)); }
        catch (e) { console.log('api error', url.pathname, e && e.stack); return cors(json({ ok: false, error: 'Ошибка сервера' }, 500)); }
      }
    }

    if (url.pathname === '/setup') return setup(url, env);

    if (url.pathname === '/webhook' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await req.json();
      ctx.waitUntil(handleUpdate(update, env, ctx).catch((e) => console.log('update error', e && e.stack)));
      return new Response('ok');
    }

    return new Response('Kalorii bot is running ✅');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      // Бесплатный план — до 50 внешних запросов за запуск: сначала напоминания, остаток — рассылке.
      let used = 0;
      if (new Date().getUTCMinutes() % 30 === 0) { try { await env.DB.put('cron:last', String(Date.now())); } catch {} }
      try { await processScheduled(env); } catch (e) { console.log('scheduled bc error', e && e.stack); }
      try { used = await processOneOff(env, 20); } catch (e) { console.log('one-off error', e && e.stack); }
      try { used += await processReminders(env, 45 - used); } catch (e) { console.log('reminders error', e && e.stack); }
      try { if (used < 40) await processBroadcast(env, 45 - used); } catch (e) { console.log('broadcast error', e && e.stack); }
    })());
  },
};

// ---------------- Telegram API ----------------
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}
const send = (env, chat_id, text, extra = {}) =>
  tg(env, 'sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const appUrl = (env) => env.APP_URL || DEFAULT_APP_URL;
const isOwner = (env, id) => String(id) === String(env.OWNER_ID);
const fmtDate = (ts) => new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const userLabel = (m) => `${esc(m.n || 'Без имени')}${m.u ? ' @' + esc(m.u) : ''}`;

function openAppKeyboard(env, text = BOT_TR.uk.open) {
  return { inline_keyboard: [[{ text, web_app: { url: appUrl(env) } }]] };
}

// ---------------- Пользователи (KV) ----------------
// Ключ u:<id>, вся информация — в metadata, чтобы список читался без лишних запросов.
// m = { n: имя, u: username, j: дата первого входа, s: последняя активность, o: открытий приложения, b: заблокировал бота }
async function touchUser(env, from, { open = false } = {}) {
  if (!from || !from.id || from.is_bot) return null;
  const key = `u:${from.id}`;
  const now = Date.now();
  const { metadata: old } = await env.DB.getWithMetadata(key);
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 64);
  const m = { ...(old || {}), n: name, u: from.username || '', s: now };
  if (!old) { m.j = now; m.o = 0; }
  if (open) m.o = (m.o || 0) + 1;
  delete m.b;
  // Бесплатный KV — 1000 записей в день, поэтому пишем только когда что-то реально поменялось.
  const changed = !old || open || old.n !== m.n || old.u !== m.u || old.b || now - (old.s || 0) > 6 * 3600e3;
  if (changed) await env.DB.put(key, '1', { metadata: m });
  return { m, isNew: !old };
}

async function allUsers(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.DB.list({ prefix: 'u:', cursor });
    for (const k of page.keys) out.push({ id: k.name.slice(2), m: k.metadata || {} });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

// ---------------- Обработка сообщений ----------------
async function handleUpdate(u, env, ctx) {
  if (u.callback_query) return handleCallback(u.callback_query, env, ctx);
  const msg = u.message;
  if (!msg || !msg.from || msg.chat.type !== 'private') return;

  const from = msg.from;
  const text = msg.text || '';
  const [cmdRaw, ...rest] = text.split(' ');
  const cmd = text.startsWith('/') ? cmdRaw.split('@')[0].toLowerCase() : '';
  const arg = rest.join(' ').trim();

  if (isOwner(env, from.id)) {
    await touchUser(env, from);
    if (await ownerCommand(env, msg, cmd, arg, ctx)) return;
  }

  const meta0 = isOwner(env, from.id) ? null : await getMeta(env, from.id);
  if (meta0 && meta0.x) {
    const L = T(await userLang(env, from.id, from));
    await send(env, from.id, L === BOT_TR.en ? '⛔️ Access restricted.' : L === BOT_TR.ru ? '⛔️ Доступ ограничен.' : '⛔️ Доступ обмежено.');
    return;
  }
  const sup = await admGet(env, 'sup', {});

  if (cmd === '/start') {
    const res = await touchUser(env, from);
    if (res && res.isNew && arg.startsWith('ref_')) await registerReferral(env, from, arg.slice(4));
    const L = T(await userLang(env, from.id, from));
    if (arg.startsWith('ch_')) {
      await send(env, from.id, L.chInvite,
        { reply_markup: { inline_keyboard: [[{ text: L.join, web_app: { url: appUrl(env) + '#ch_' + arg.slice(3).replace(/[^a-z0-9]/g, '') } }]] } });
      if (res && res.isNew && env.OWNER_ID && !isOwner(env, from.id)) await send(env, env.OWNER_ID, `🆕 Новый пользователь (челлендж): ${userLabel(res.m)} (<code>${from.id}</code>)`);
      return;
    }
    await send(env, from.id, sup.hello ? sup.hello.replace(/\{name\}/g, esc(from.first_name || '')) : L.hello(esc(from.first_name || '')), { reply_markup: openAppKeyboard(env, L.open) });
    if (false) await send(env, from.id,
      `👋 Привет, <b>${esc(from.first_name || '')}</b>!\n\n` +
      `Я помогу считать калории, белки, жиры и углеводы.\n\n` +
      `🥗 Дневник питания, рецепты и план\n📷 Распознавание еды по фото\n🎙 Голосовой ввод\n💧 Вода, ⚖️ вес и 📊 статистика\n\n` +
      `💡 Можно прямо сюда отправить голосовое «съел два яйца и кофе» или написать <code>+ банан и йогурт</code> — я разберу и предложу добавить.\n\n` +
      `Нажмите кнопку ниже, чтобы открыть дневник. Ваши записи видны только вам.`,
      { reply_markup: openAppKeyboard(env) });
    if (res && res.isNew && env.OWNER_ID && !isOwner(env, from.id)) {
      await send(env, env.OWNER_ID, `🆕 Новый пользователь: ${userLabel(res.m)} (<code>${from.id}</code>)`);
    }
    return;
  }

  if (cmd === '/help') {
    const L = T(await userLang(env, from.id, from));
    await send(env, from.id, sup.help || L.help, { reply_markup: openAppKeyboard(env, L.open) });
    if (false) await send(env, from.id,
      `ℹ️ <b>Как пользоваться</b>\n\n` +
      `1. Откройте дневник кнопкой ниже или кнопкой «Открыть» слева от поля ввода.\n` +
      `2. При первом запуске заполните анкету — приложение посчитает вашу норму.\n` +
      `3. Добавляйте еду в завтрак, обед, ужин и перекусы.\n` +
      `4. Или пришлите сюда голосовое / сообщение с «+»: <code>+ 2 яйца и 100 г гречки на обед</code>\n\n` +
      `Есть вопрос или идея? Просто напишите сюда сообщение — его прочитает автор.\n\n` +
      `👨‍💻 Разработано разработчиком <b>Danya. Vas</b> при поддержке тестировщика <b>Не указано</b>.`,
      { reply_markup: openAppKeyboard(env) });
    return;
  }

  const foodText = text.startsWith('+') ? text.slice(1).trim() : cmd === '/add' ? arg : '';
  if (msg.voice || msg.audio || foodText) {
    await touchUser(env, from);
    return handleFoodMessage(env, msg, foodText);
  }

  if (isOwner(env, from.id)) {
    await send(env, from.id, '🛠 Команды владельца — /admin\nЧтобы ответить пользователю, ответьте реплаем на его пересланное сообщение.');
    return;
  }

  // Любое другое сообщение пользователя — пересылаем владельцу.
  const tu = await touchUser(env, from);
  const Lu = T(await userLang(env, from.id, from));
  if (sup.off) {
    await send(env, from.id, Lu === BOT_TR.en ? '📭 Messages are not accepted right now.' : Lu === BOT_TR.ru ? '📭 Сейчас сообщения не принимаются.' : '📭 Зараз повідомлення не приймаються.');
    return;
  }
  if (!env.OWNER_ID) return;
  try {
    const ib = (await env.DB.get('ib', 'json')) || [];
    ib.unshift({ t: Date.now(), id: String(from.id), n: [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 40), txt: (text || (msg.photo ? '[фото]' : msg.sticker ? '[стикер]' : msg.video ? '[видео]' : msg.document ? '[файл]' : '[медиа]')).slice(0, 200) });
    await env.DB.put('ib', JSON.stringify(ib.slice(0, 30)));
  } catch {}
  if (tu && tu.m && tu.m.mu) { await send(env, from.id, sup.auto || Lu.sent); return; }
  const fwd = await tg(env, 'forwardMessage', { chat_id: env.OWNER_ID, from_chat_id: from.id, message_id: msg.message_id });
  const info = await send(env, env.OWNER_ID,
    `💬 Сообщение от ${userLabel({ n: [from.first_name, from.last_name].filter(Boolean).join(' '), u: from.username })} (<code>${from.id}</code>)\n` +
    `Ответьте <b>реплаем</b> на это или пересланное сообщение — ответ уйдёт пользователю.`);
  const ttl = { expirationTtl: 60 * 60 * 24 * 30 };
  if (fwd.ok) await env.DB.put(`r:${fwd.result.message_id}`, String(from.id), ttl);
  if (info.ok) await env.DB.put(`r:${info.result.message_id}`, String(from.id), ttl);
  await send(env, from.id, sup.auto || Lu.sent);
}

// ---------------- Команды владельца ----------------
async function ownerCommand(env, msg, cmd, arg, ctx) {
  const me = msg.chat.id;

  // Ответ пользователю реплаем на пересланное сообщение.
  if (!cmd && msg.reply_to_message) {
    const target = await env.DB.get(`r:${msg.reply_to_message.message_id}`);
    if (target) {
      const r = await tg(env, 'copyMessage', { chat_id: target, from_chat_id: me, message_id: msg.message_id });
      await send(env, me, r.ok ? '✅ Ответ отправлен' : `⚠️ Не удалось отправить: ${esc(r.description)}`);
      return true;
    }
  }

  if (await adminCommand(env, msg, cmd, arg)) return true;

  switch (cmd) {
    case '/admin':
    case '/commands': {
      const h = adminHome(env);
      await send(env, me, h.text, { reply_markup: h.kb });
      return true;
    }
    case '/admin_old':
      await send(env, me,
        `🛠 <b>Команды владельца</b>\n\n` +
        `/stats — статистика\n` +
        `/users — последние пользователи\n` +
        `/broadcast <i>текст</i> — рассылка всем\n` +
        `   или ответьте <code>/broadcast</code> на любое сообщение (фото, видео…)\n` +
        `/reply <i>id текст</i> — написать пользователю\n` +
        `/cancel — остановить рассылку\n\n` +
        `💬 Сообщения пользователей приходят сюда — отвечайте на них реплаем.`,
        { reply_markup: openAppKeyboard(env, '🥗 Открыть приложение') });
      return true;

    case '/stats': {
      const users = await allUsers(env);
      const now = Date.now(), day = 86400e3;
      const c = (f) => users.filter(f).length;
      const job = await env.DB.get('bc:job', 'json');
      await send(env, me,
        `📊 <b>Статистика</b>\n\n` +
        `👥 Всего пользователей: <b>${users.length}</b>\n` +
        `🆕 Новых за 24 ч: <b>${c((u) => now - (u.m.j || 0) < day)}</b>\n` +
        `🆕 Новых за 7 дней: <b>${c((u) => now - (u.m.j || 0) < 7 * day)}</b>\n\n` +
        `🔥 Активных за 24 ч: <b>${c((u) => now - (u.m.s || 0) < day)}</b>\n` +
        `🔥 Активных за 7 дней: <b>${c((u) => now - (u.m.s || 0) < 7 * day)}</b>\n\n` +
        `📱 Открывали приложение: <b>${c((u) => (u.m.o || 0) > 0)}</b> чел.\n` +
        `📱 Всего открытий: <b>${users.reduce((s, u) => s + (u.m.o || 0), 0)}</b>\n` +
        `🚫 Заблокировали бота: <b>${c((u) => u.m.b)}</b>\n` +
        `🤝 Пришли по приглашению: <b>${c((u) => u.m.r)}</b>\n\n` +
        `🧩 <b>Функции за 7 дней</b>\n${Object.entries(await usageLastDays(env, 7)).filter(([k]) => FEATURE_NAMES[k]).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${FEATURE_NAMES[k]}: ${v}`).join('\n') || 'пока нет данных'}` +
        (job ? `\n\n📣 Идёт рассылка: ${job.i}/${job.ids.length}` : ''));
      return true;
    }

    case '/users': {
      const users = (await allUsers(env)).sort((a, b) => (b.m.j || 0) - (a.m.j || 0));
      const n = Math.min(Math.max(parseInt(arg, 10) || 20, 1), 50);
      const lines = users.slice(0, n).map((u, i) =>
        `${i + 1}. ${userLabel(u.m)}${u.m.b ? ' 🚫' : ''}\n    <code>${u.id}</code> · с ${fmtDate(u.m.j || 0)} · 📱${u.m.o || 0}`);
      await send(env, me, `👥 <b>Последние ${lines.length} из ${users.length}</b>\n\n${lines.join('\n') || 'Пока никого'}\n\nБольше: /users 50`);
      return true;
    }

    case '/broadcast': {
      let draft;
      if (msg.reply_to_message) draft = { copy: msg.reply_to_message.message_id };
      else if (arg) draft = { text: arg };
      else {
        await send(env, me, 'Напишите <code>/broadcast текст</code> или ответьте командой <code>/broadcast</code> на сообщение, которое нужно разослать.');
        return true;
      }
      if (await env.DB.get('bc:job')) {
        await send(env, me, '⏳ Уже идёт рассылка. Дождитесь окончания или остановите: /cancel');
        return true;
      }
      await env.DB.put('bc:draft', JSON.stringify(draft), { expirationTtl: 3600 });
      const total = (await allUsers(env)).filter((u) => !u.m.b && !u.m.x && !isOwner(env, u.id)).length;
      await send(env, me, '👇 Так увидят сообщение пользователи:');
      if (draft.text) await send(env, me, draft.text);
      else await tg(env, 'copyMessage', { chat_id: me, from_chat_id: me, message_id: draft.copy });
      const users = (await allUsers(env)).filter((u) => !u.m.b && !u.m.x && !isOwner(env, u.id));
      const now = Date.now();
      const rows = Object.entries(SEGMENTS).map(([k, [t, f]]) => [{ text: `📣 ${t} (${users.filter((u) => f(u, now)).length})`, callback_data: 'bc:go:' + k }]);
      rows.push([{ text: '✖️ Отмена', callback_data: 'bc:no' }]);
      await send(env, me, `Кому отправить? Всего доступно: <b>${total}</b>`, { reply_markup: { inline_keyboard: rows } });
      return true;
    }

    case '/cancel': {
      const job = await env.DB.get('bc:job', 'json');
      await env.DB.delete('bc:job');
      await env.DB.delete('bc:draft');
      await send(env, me, job ? `⏹ Рассылка остановлена на ${job.i}/${job.ids.length}.` : 'Нечего отменять.');
      return true;
    }

    case '/reply': {
      const [id, ...words] = arg.split(' ');
      const text = words.join(' ').trim();
      if (!/^\d+$/.test(id || '') || !text) {
        await send(env, me, 'Формат: <code>/reply 123456789 текст ответа</code>\nID есть в /users.');
        return true;
      }
      const r = await send(env, id, text);
      await send(env, me, r.ok ? '✅ Отправлено' : `⚠️ Не удалось: ${esc(r.description)}`);
      return true;
    }
  }
  return false;
}

async function handleCallback(q, env, ctx) {
  const me = q.from.id;
  if (!isOwner(env, me)) return tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
  if (/^(adm|cf):/.test(q.data || '')) return adminCallback(q, env);
  const edit = (text) => tg(env, 'editMessageText', { chat_id: me, message_id: q.message.message_id, text, parse_mode: 'HTML' });

  if (q.data === 'bc:no') {
    await env.DB.delete('bc:draft');
    await edit('✖️ Рассылка отменена');
  } else if (q.data.startsWith('bc:go')) {
    const seg = SEGMENTS[q.data.split(':')[2] || 'all'] || SEGMENTS.all;
    const draft = await env.DB.get('bc:draft', 'json');
    if (!draft) {
      await edit('⌛ Черновик устарел — отправьте /broadcast заново');
    } else if (await env.DB.get('bc:job')) {
      await edit('⏳ Уже идёт рассылка');
    } else {
      const now = Date.now();
      const ids = (await allUsers(env)).filter((u) => !u.m.b && !u.m.x && !isOwner(env, u.id) && seg[1](u, now)).map((u) => u.id);
      await env.DB.put('bc:job', JSON.stringify({ draft, from: me, ids, i: 0, ok: 0, fail: 0, seg: seg[0] }));
      await env.DB.delete('bc:draft');
      await edit(`🚀 Рассылка «${seg[0]}» запущена: ${ids.length} получателей. По ${BATCH} сообщений в минуту — пришлю отчёт.`);
      await processBroadcast(env);
    }
  }
  return tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
}

// ---------------- Рассылка (порциями по cron) ----------------
async function processBroadcast(env, budget = BATCH) {
  const job = await env.DB.get('bc:job', 'json');
  if (!job) return;
  const part = job.ids.slice(job.i, job.i + Math.min(BATCH, budget));
  const blocked = [];
  for (const id of part) {
    const r = job.draft.text
      ? await send(env, id, job.draft.text)
      : await tg(env, 'copyMessage', { chat_id: id, from_chat_id: job.from, message_id: job.draft.copy });
    if (r.ok) job.ok++;
    else { job.fail++; if (r.error_code === 403) blocked.push(id); }
  }
  job.i += part.length;
  for (const id of blocked.slice(0, 20)) {
    const { metadata } = await env.DB.getWithMetadata(`u:${id}`);
    if (metadata) await env.DB.put(`u:${id}`, '1', { metadata: { ...metadata, b: true } });
  }
  if (job.i >= job.ids.length) {
    await env.DB.delete('bc:job');
    await pushHistory(env, job);
    await send(env, job.from, `✅ <b>Рассылка завершена</b>\n\nДоставлено: ${job.ok}\nНе доставлено: ${job.fail}`);
  } else {
    await env.DB.put('bc:job', JSON.stringify(job));
  }
}

// ---------------- Статистика открытий мини-приложения ----------------
async function apiOpen(req, env) {
  const initData = await req.text();
  const user = await verifyInitData(initData, env.BOT_TOKEN);
  if (!user) return new Response('bad init data', { status: 401 });
  await touchUser(env, user, { open: true });
  return new Response('ok');
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** Проверяет, что запрос пришёл из мини-приложения от владельца бота. */
async function ownerFromBody(req, env) {
  let body;
  try { body = JSON.parse(await req.text()); } catch { return { error: json({ ok: false, error: 'bad json' }, 400) }; }
  const user = await verifyInitData(body.initData, env.BOT_TOKEN);
  if (!user) return { error: json({ ok: false, error: 'Откройте приложение из Telegram' }, 401) };
  if (!isOwner(env, user.id)) return { error: json({ ok: false, error: 'Только владелец бота может менять настройки' }, 403) };
  return { body, user };
}

async function apiSaveConfig(req, env) {
  const { error, body } = await ownerFromBody(req, env);
  if (error) return error;
  const text = JSON.stringify(body.config || {});
  if (text.length > 60000) return json({ ok: false, error: 'Слишком большой конфиг' }, 413);
  await env.DB.put('config', text);
  return json({ ok: true });
}

async function apiStats(req, env) {
  const { error } = await ownerFromBody(req, env);
  if (error) return error;
  const users = await allUsers(env);
  const now = Date.now(), day = 86400e3;
  const c = (f) => users.filter(f).length;
  return json({
    ok: true,
    total: users.length,
    new24: c((u) => now - (u.m.j || 0) < day),
    new7: c((u) => now - (u.m.j || 0) < 7 * day),
    active24: c((u) => now - (u.m.s || 0) < day),
    active7: c((u) => now - (u.m.s || 0) < 7 * day),
    appUsers: c((u) => (u.m.o || 0) > 0),
    opens: users.reduce((s, u) => s + (u.m.o || 0), 0),
    blocked: c((u) => u.m.b),
    refs: c((u) => u.m.r),
    usage: Object.fromEntries(Object.entries(await usageLastDays(env, 7)).filter(([k]) => FEATURE_NAMES[k]).map(([k, v]) => [FEATURE_NAMES[k], v])),
    inactive7: c((u) => now - (u.m.s || 0) > 7 * day),
    latest: users.sort((a, b) => (b.m.j || 0) - (a.m.j || 0)).slice(0, 10).map((u) => ({ id: u.id, n: u.m.n, u: u.m.u, j: u.m.j, o: u.m.o || 0 })),
  });
}

async function verifyInitData(initData, token) {
  if (!initData || !token) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac(enc.encode('WebAppData'), token);
  const sig = [...(await hmac(secret, check))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (sig !== hash) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date') || 0) > 86400) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'content-type');
  return new Response(res.body, { status: res.status, headers: h });
}

// ---------------- Первичная настройка ----------------
async function setup(url, env) {
  if (!env.WEBHOOK_SECRET || url.searchParams.get('secret') !== env.WEBHOOK_SECRET) {
    return new Response('Нужен параметр ?secret=… (значение WEBHOOK_SECRET)', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const missing = ['BOT_TOKEN', 'OWNER_ID', 'WEBHOOK_SECRET'].filter((k) => !env[k]);
  if (!env.DB) missing.push('KV-привязка DB');
  if (missing.length) {
    return new Response('Не хватает настроек: ' + missing.join(', '), { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const results = {};
  results.webhook = await tg(env, 'setWebhook', {
    url: `${url.origin}/webhook`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  results.commands = await tg(env, 'setMyCommands', {
    commands: [{ command: 'start', description: 'Відкрити щоденник' }, { command: 'help', description: 'Допомога' }],
  });
  await tg(env, 'setMyCommands', { language_code: 'ru', commands: [{ command: 'start', description: 'Открыть дневник' }, { command: 'help', description: 'Помощь' }] });
  await tg(env, 'setMyCommands', { language_code: 'en', commands: [{ command: 'start', description: 'Open diary' }, { command: 'help', description: 'Help' }] });
  results.ownerCommands = await tg(env, 'setMyCommands', {
    scope: { type: 'chat', chat_id: Number(env.OWNER_ID) },
    commands: [...ADMIN_CMDS.map(([c, , , d]) => ({ command: c, description: d.slice(0, 250) }))].slice(0, 100),
  });
  results.menuButton = await tg(env, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Відкрити', web_app: { url: appUrl(env) } },
  });
  results.description = await tg(env, 'setMyDescription', {
    description: '🥗 Щоденник калорій прямо в Telegram.\n\nРахуйте калорії та БЖВ, воду й вагу. Розпізнавання їжі за фото й голосом, рецепти, план харчування. Безкоштовно й без реклами.\n\n👨‍💻 Розробник: Danya. Vas',
  });
  await tg(env, 'setMyDescription', { language_code: 'ru', description: '🥗 Дневник калорий прямо в Telegram.\n\nСчитайте калории и БЖУ, воду и вес. Распознавание еды по фото и голосу, рецепты, план питания. Бесплатно и без рекламы.\n\n👨‍💻 Разработчик: Danya. Vas' });
  await tg(env, 'setMyDescription', { language_code: 'en', description: '🥗 Calorie diary right in Telegram.\n\nTrack calories, macros, water and weight. Food recognition by photo and voice, recipes, meal plans. Free and ad-free.\n\n👨‍💻 Developer: Danya. Vas' });
  results.shortDescription = await tg(env, 'setMyShortDescription', { short_description: 'Щоденник калорій і БЖВ у Telegram 🥗' });
  await tg(env, 'setMyShortDescription', { language_code: 'ru', short_description: 'Дневник калорий и БЖУ в Telegram 🥗' });
  await tg(env, 'setMyShortDescription', { language_code: 'en', short_description: 'Calorie & macro diary in Telegram 🥗' });
  const ok = Object.values(results).every((r) => r.ok);
  const lines = Object.entries(results).map(([k, r]) => `${r.ok ? '✅' : '❌'} ${k}${r.ok ? '' : ': ' + r.description}`);
  return new Response(`${ok ? 'Готово! Бот настроен.' : 'Есть ошибки:'}\n\n${lines.join('\n')}`, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

// =====================================================================
//  v4: ИИ (Workers AI), напоминания, экспорт, журнал ошибок
// =====================================================================

/** Любой пользователь мини-приложения (подпись Telegram проверяется на сервере). */
async function userFromBody(req, env, maxLen = 3_000_000) {
  const text = await req.text();
  if (text.length > maxLen) return { error: json({ ok: false, error: 'Слишком большой запрос' }, 413) };
  let body;
  try { body = JSON.parse(text); } catch { return { error: json({ ok: false, error: 'Неверный формат запроса' }, 400) }; }
  const user = await verifyInitData(body.initData, env.BOT_TOKEN);
  if (!user) return { error: json({ ok: false, error: 'Откройте приложение из Telegram' }, 401) };
  if (await isBanned(env, user.id)) return { error: json({ ok: false, error: 'Доступ ограничен' }, 403) };
  return { body, user };
}

// ---------- Дневные лимиты ИИ на пользователя (чтобы не выйти за бесплатную квоту) ----------
const AI_LIMITS = { photo: 15, chat: 40, parse: 60, voice: 30 };
async function takeQuota(env, uid, kind, ai) {
  ai = ai || (await aiSettings(env));
  if (ai.off) return false;
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const key = `q:${uid}:${day}`;
  const q = (await env.DB.get(key, 'json')) || {};
  const base = (ai.limits && ai.limits[kind]) || AI_LIMITS[kind];
  const m = isOwner(env, uid) ? null : await getMeta(env, uid);
  const limit = isOwner(env, uid) ? base * 5 : m && m.v ? base * 3 : base;
  if ((q[kind] || 0) >= limit) return false;
  q[kind] = (q[kind] || 0) + 1;
  await env.DB.put(key, JSON.stringify(q), { expirationTtl: 2 * 86400 });
  return true;
}

const TEXT_MODELS = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];

async function runText(env, messages, max_tokens = 700) {
  let lastErr;
  for (const model of TEXT_MODELS) {
    try {
      const r = await env.AI.run(model, { messages, max_tokens, temperature: 0.4 });
      const out = r && (r.response ?? (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content));
      if (out) return typeof out === 'string' ? out : JSON.stringify(out);
    } catch (e) { lastErr = e; console.log('text model failed', model, e && e.message); }
  }
  throw lastErr || new Error('Модель не ответила');
}

function extractJSON(text) {
  if (!text) return null;
  const s = String(text).replace(/```json|```/g, '');
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const a = s.indexOf(open), b = s.lastIndexOf(close);
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  }
  return null;
}

const FOOD_JSON_RULES =
  'Ответ — ТОЛЬКО JSON-массив без пояснений. Каждый элемент: {"name": "название по-русски", "grams": число, "kcal": ккал на 100 г, "p": белки на 100 г, "f": жиры на 100 г, "c": углеводы на 100 г}. ' +
  'Названия — простые, как в таблицах калорийности (например "Гречка варёная", "Куриная грудка жареная"). Вес — реалистичная оценка порции в граммах.';

function cleanItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 15).map((x) => ({
    name: String(x.name || x.n || '').slice(0, 80),
    grams: Math.max(0, Math.min(3000, Number(x.grams || x.g || 0) || 0)),
    count: x.count != null ? Math.max(0, Math.min(50, Number(x.count) || 0)) : undefined,
    meal: ['b', 'l', 'd', 's'].includes(x.meal) ? x.meal : undefined,
    kcal: Number(x.kcal || x.k || 0) || 0,
    p: Number(x.p || 0) || 0, f: Number(x.f || 0) || 0, c: Number(x.c || 0) || 0,
  })).filter((x) => x.name);
}

function aiMissing() {
  return json({ ok: false, error: 'ИИ не подключён: в Cloudflare добавьте привязку Workers AI с именем AI (Settings → Bindings).' }, 503);
}

async function apiAiPhoto(req, env) {
  const { error, body, user } = await userFromBody(req, env, 4_000_000);
  if (error) return error;
  if (!env.AI) return aiMissing();
  const b64 = String(body.image || '').replace(/^data:image\/\w+;base64,/, '');
  if (b64.length < 1000) return json({ ok: false, error: 'Нет изображения' }, 400);
  { const qe = await quotaError(env, user.id, 'photo'); if (qe) return json({ ok: false, error: qe }, 429); }
  const prompt = 'Ты — нутрициолог. Определи все блюда и продукты на фото еды и оцени вес каждой порции. ' + FOOD_JSON_RULES +
    ' Если на фото нет еды — верни [].';
  let text;
  try {
    // Основная модель: Llama 4 Scout (понимает изображения).
    const r = await env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }] }],
      max_tokens: 800, temperature: 0.2,
    });
    text = r && r.response;
  } catch (e) { console.log('scout vision failed', e && e.message); }
  if (!text) {
    try {
      const bytes = [...Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))];
      const model = '@cf/meta/llama-3.2-11b-vision-instruct';
      const run = () => env.AI.run(model, { prompt, image: bytes, max_tokens: 800 });
      let r;
      try { r = await run(); } catch (e) {
        if (/agree/i.test(String(e && e.message))) { await env.AI.run(model, { prompt: 'agree' }); r = await run(); } else throw e;
      }
      text = r && r.response;
    } catch (e) {
      console.log('vision failed', e && e.stack);
      return json({ ok: false, error: 'Не удалось распознать фото. Попробуйте ещё раз.' }, 502);
    }
  }
  return json({ ok: true, items: cleanItems(extractJSON(text)) });
}

async function apiAiParse(req, env) {
  const { error, body, user } = await userFromBody(req, env, 20000);
  if (error) return error;
  if (!env.AI) return aiMissing();
  const text = String(body.text || '').slice(0, 600);
  if (!text.trim()) return json({ ok: false, error: 'Пустой запрос' }, 400);
  { const qe = await quotaError(env, user.id, 'parse'); if (qe) return json({ ok: false, error: qe }, 429); }
  const sys = 'Ты разбираешь фразу пользователя о съеденной еде. ' +
    'Ответ — ТОЛЬКО JSON-массив. Элемент: {"name": "продукт в именительном падеже, как в таблице калорийности", "grams": число или 0, "count": число штук или 0, "meal": "b"|"l"|"d"|"s"|null, "kcal": ккал на 100 г, "p": белки на 100 г, "f": жиры на 100 г, "c": углеводы на 100 г}. ' +
    'meal: b — завтрак, l — обед, d — ужин, s — перекус; null, если не сказано. Если указаны штуки (два яйца) — заполни count, а grams — общий вес. Числа словами переводи в цифры.';
  try {
    const out = await runText(env, [{ role: 'system', content: sys }, { role: 'user', content: text }], 500);
    return json({ ok: true, items: cleanItems(extractJSON(out)) });
  } catch (e) {
    console.log('parse failed', e && e.stack);
    return json({ ok: false, error: 'ИИ временно недоступен' }, 502);
  }
}

async function apiAiVoice(req, env) {
  const { error, body, user } = await userFromBody(req, env, 6_000_000);
  if (error) return error;
  if (!env.AI) return aiMissing();
  const b64 = String(body.audio || '').replace(/^data:[^,]+,/, '');
  if (b64.length < 500) return json({ ok: false, error: 'Нет записи' }, 400);
  { const qe = await quotaError(env, user.id, 'voice'); if (qe) return json({ ok: false, error: qe }, 429); }
  try {
    let r;
    try { r = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio: b64, language: 'ru' }); }
    catch (e) {
      console.log('whisper turbo failed', e && e.message);
      r = await env.AI.run('@cf/openai/whisper', { audio: [...Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))] });
    }
    return json({ ok: true, text: String((r && r.text) || '').trim() });
  } catch (e) {
    console.log('voice failed', e && e.stack);
    return json({ ok: false, error: 'Не удалось распознать речь' }, 502);
  }
}

async function apiAiChat(req, env) {
  const { error, body, user } = await userFromBody(req, env, 60000);
  if (error) return error;
  if (!env.AI) return aiMissing();
  { const qe = await quotaError(env, user.id, 'chat'); if (qe) return json({ ok: false, error: qe }, 429); }
  const ctxText = JSON.stringify(body.context || {}).slice(0, 4000);
  const history = (Array.isArray(body.messages) ? body.messages : []).slice(-8)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 1200) }))
    .filter((m) => m.content);
  if (!history.length) return json({ ok: false, error: 'Пустое сообщение' }, 400);
  const sys = [
    `Ты — дружелюбный ИИ-помощник по питанию в приложении «Калории». Отвечай на языке: ${String((body.context && body.context.language) || 'украинский').slice(0, 20)} — кратко и по делу (до 150 слов), используй списки и эмодзи умеренно.`,
    'Опирайся на данные пользователя (JSON ниже): цель, норму калорий и БЖУ, съеденное сегодня, историю и предпочтения. Считай остаток калорий из этих данных.',
    'Все расчёты калорий — приблизительные, говори об этом, когда даёшь цифры. Не выдавай оценки за точные медицинские данные.',
    'Ты не врач: не ставь диагнозы, не назначай лекарства и лечебные диеты. При болезнях, беременности, расстройствах пищевого поведения, резкой потере веса советуй обратиться к врачу.',
    'Никогда не советуй питание ниже 1200 ккал в день, голодание или опасные практики. Не стыди пользователя — поддерживай.',
    'Предлагай реальные, доступные в России продукты и блюда, с примерным весом порций и КБЖУ.',
    `Данные пользователя: ${ctxText}`,
  ].join('\n');
  try {
    const answer = await runText(env, [{ role: 'system', content: sys }, ...history], 700);
    return json({ ok: true, answer: answer.trim() });
  } catch (e) {
    console.log('chat failed', e && e.stack);
    return json({ ok: false, error: 'ИИ временно недоступен, попробуйте позже' }, 502);
  }
}

// ---------- Напоминания ----------
// rs:<uid> — настройки пользователя; rm:HHMM (UTC) — кому и что отправить в эту минуту.
const REMINDER_TEXT = {
  diary: '📝 Не забудьте записать еду в дневник — это займёт минуту.',
  water: '💧 Время выпить стакан воды!',
  weight: '⚖️ Сегодня день взвешивания. Запишите вес — утром натощак честнее всего.',
  stats: '📊 Итог дня',
  plan: '🗓 Посмотрите план питания на завтра.',
};
const toUtc = (hhmm, tz) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) return null;
  const t = (((h * 60 + m + tz) % 1440) + 1440) % 1440; // tz — смещение в минутах (как getTimezoneOffset)
  return String(Math.floor(t / 60)).padStart(2, '0') + String(t % 60).padStart(2, '0');
};
function scheduleOf(rs) {
  const out = {};
  if (!rs || !rs.items) return out;
  const add = (hhmm, type) => { const k = toUtc(hhmm, rs.tz || 0); if (k) (out[k] = out[k] || []).push(type); };
  for (const [type, it] of Object.entries(rs.items)) {
    if (!it || !it.on || !REMINDER_TEXT[type]) continue;
    if (type === 'water') (it.ts || []).slice(0, 6).forEach((t) => add(t, 'water'));
    else add(it.t, type);
  }
  return out;
}
async function apiReminders(req, env) {
  const { error, body, user } = await userFromBody(req, env, 20000);
  if (error) return error;
  const uid = String(user.id);
  const old = await env.DB.get(`rs:${uid}`, 'json');
  if (!body.settings) return json({ ok: true, settings: old });
  const s = body.settings;
  const rs = { tz: Math.max(-840, Math.min(840, Number(s.tz) || 0)), items: {} };
  for (const type of Object.keys(REMINDER_TEXT)) {
    const it = (s.items || {})[type] || {};
    rs.items[type] = { on: !!it.on, t: String(it.t || '20:00').slice(0, 5), ts: Array.isArray(it.ts) ? it.ts.map((x) => String(x).slice(0, 5)).slice(0, 6) : undefined, dow: Number(it.dow) || 1 };
  }
  const before = scheduleOf(old), after = scheduleOf(rs);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const a = JSON.stringify(before[k] || []), b = JSON.stringify(after[k] || []);
    if (a === b) continue;
    const slot = (await env.DB.get(`rm:${k}`, 'json')) || {};
    if (after[k]) slot[uid] = after[k]; else delete slot[uid];
    if (Object.keys(slot).length) await env.DB.put(`rm:${k}`, JSON.stringify(slot)); else await env.DB.delete(`rm:${k}`);
  }
  await env.DB.put(`rs:${uid}`, JSON.stringify(rs));
  return json({ ok: true });
}
/** Отправляет напоминания текущей минуты. Возвращает число использованных запросов. */
async function processReminders(env, budget) {
  const now = new Date();
  const key = String(now.getUTCHours()).padStart(2, '0') + String(now.getUTCMinutes()).padStart(2, '0');
  const slot = await env.DB.get(`rm:${key}`, 'json');
  if (!slot) return 0;
  let used = 0;
  for (const [uid, types] of Object.entries(slot)) {
    for (const type of types) {
      if (used >= budget) return used;
      if (type === 'weight') {
        const rs = await env.DB.get(`rs:${uid}`, 'json');
        const local = new Date(now.getTime() - ((rs && rs.tz) || 0) * 60000);
        if (rs && rs.items.weight && local.getUTCDay() !== (rs.items.weight.dow % 7)) continue;
      }
      const L = T(await userLang(env, uid));
      let text = L.rem[type] || REMINDER_TEXT[type];
      if (type === 'stats') {
        const rs = await env.DB.get(`rs:${uid}`, 'json');
        const sm = await env.DB.get(`sm:${uid}`, 'json');
        text = sm && sm.date === today8((rs && rs.tz) || 0) && sm.e > 0 ? summaryText(sm, L) : L.rem.empty;
      }
      const r = await send(env, uid, text, { reply_markup: openAppKeyboard(env, L.open), disable_notification: false });
      used++;
      if (!r.ok && r.error_code === 403) console.log('reminder blocked', uid);
    }
  }
  return used;
}

// ---------- Экспорт файла в чат ----------
async function apiExport(req, env) {
  const { error, body, user } = await userFromBody(req, env, 2_000_000);
  if (error) return error;
  const name = String(body.filename || 'export.csv').replace(/[^\wа-яА-ЯёЁ.\- ]/g, '_').slice(0, 60);
  const content = String(body.content || '');
  if (!content) return json({ ok: false, error: 'Пустой файл' }, 400);
  const type = name.endsWith('.html') ? 'text/html' : 'text/csv';
  const fd = new FormData();
  fd.append('chat_id', String(user.id));
  fd.append('caption', String(body.caption || '📎 Ваш экспорт из «Калорий»').slice(0, 900));
  fd.append('document', new Blob([type === 'text/csv' ? '﻿' + content : content], { type }), name);
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd }).then((x) => x.json());
  if (!r.ok) return json({ ok: false, error: r.error_code === 403 ? 'Сначала нажмите «Старт» в чате с ботом' : (r.description || 'Не удалось отправить') }, 502);
  return json({ ok: true });
}

// ---------- Журнал ошибок клиента ----------
async function apiLog(req, env) {
  try {
    const t = (await req.text()).slice(0, 2000);
    console.log('client error', t);
    let m = t;
    try { const j = JSON.parse(t); m = j.msg || j.message || j.error || j.e || t; } catch {}
    if (env && env.DB) await storeClientError(env, m);
  } catch {}
  return json({ ok: true });
}

// =====================================================================
//  v5: итог дня, еда голосом/текстом в чате, голодание, приглашения,
//      челленджи, отправка картинки, использование функций
// =====================================================================
const today8 = (tz = 0) => new Date(Date.now() - tz * 60000).toISOString().slice(0, 10);

// ---------- Синхронизация итогов дня и статистики функций ----------
const FEATURES = ['search', 'photo', 'voice', 'scan', 'chat', 'recipe', 'plan', 'dish', 'water', 'weight', 'template', 'activity', 'fast', 'measure', 'challenge', 'share', 'export', 'copy'];
async function apiSync(req, env) {
  const { error, body, user } = await userFromBody(req, env, 20000);
  if (error) return error;
  const uid = String(user.id);
  if (BOT_TR[body.lang]) {
    const { metadata } = await env.DB.getWithMetadata(`u:${uid}`);
    if (metadata && metadata.l !== body.lang) await env.DB.put(`u:${uid}`, '1', { metadata: { ...metadata, l: body.lang } });
  }
  const d = body.day;
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) {
    const n = (x, max) => Math.max(0, Math.min(max, Math.round(Number(x) || 0)));
    const sm = { date: d.date, k: n(d.k, 20000), p: n(d.p, 2000), f: n(d.f, 2000), c: n(d.c, 3000), w: n(d.w, 15000), e: n(d.e, 500),
      gk: n(d.gk, 10000), gp: n(d.gp, 1000), gw: n(d.gw, 10000), burn: n(d.burn, 10000) };
    const old = await env.DB.get(`sm:${uid}`);
    if (old !== JSON.stringify(sm)) await env.DB.put(`sm:${uid}`, JSON.stringify(sm), { expirationTtl: 3 * 86400 });
  }
  const usage = body.usage || {};
  const inc = Object.fromEntries(Object.entries(usage).filter(([k, v]) => FEATURES.includes(k) && Number(v) > 0).map(([k, v]) => [k, Math.min(200, Math.round(Number(v)))]));
  if (Object.keys(inc).length) {
    const key = `us:${today8()}`;
    const cur = (await env.DB.get(key, 'json')) || {};
    for (const [k, v] of Object.entries(inc)) cur[k] = (cur[k] || 0) + v;
    cur._sessions = (cur._sessions || 0) + 1;
    await env.DB.put(key, JSON.stringify(cur), { expirationTtl: 40 * 86400 });
  }
  return json({ ok: true });
}
async function usageLastDays(env, days = 7) {
  const tot = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
    const u = await env.DB.get(`us:${d}`, 'json');
    if (u) for (const [k, v] of Object.entries(u)) tot[k] = (tot[k] || 0) + v;
  }
  return tot;
}
const FEATURE_NAMES = { search: 'Поиск', photo: 'Фото', voice: 'Голос', scan: 'Штрихкод', chat: 'ИИ-помощник', recipe: 'Рецепты', plan: 'План', dish: 'Блюда', water: 'Вода', weight: 'Вес', template: 'Шаблоны дня', activity: 'Активность', fast: 'Голодание', measure: 'Замеры', challenge: 'Челленджи', share: 'Поделиться', export: 'Экспорт', copy: 'Копирование' };

/** Персональный итог дня для вечернего напоминания. */
function summaryText(sm, L = BOT_TR.uk) {
  const S2 = L.sum;
  const goal = (sm.gk || 0) + (sm.burn || 0);
  const pct = goal ? Math.round((sm.k / goal) * 100) : 0;
  const lit = (x) => (x / 1000).toFixed(1).replace('.', L === BOT_TR.en ? '.' : ',');
  const lines = [S2.title, '', `🔥 ${sm.k} ${S2.of} ${goal} ${S2.kcal} (${pct}%)${sm.burn ? ` · ${S2.burned} ${sm.burn}` : ''}`, `🥩 ${S2.protein} ${sm.p} ${S2.of} ${sm.gp} ${S2.g}`, `💧 ${S2.water} ${lit(sm.w)} ${S2.of} ${lit(sm.gw)} ${S2.l}`, ''];
  if (pct >= 90 && pct <= 110) lines.push(S2.ok);
  else if (pct < 90) lines.push(S2.under(goal - sm.k));
  else lines.push(S2.over);
  if (sm.gp && sm.p < sm.gp * 0.85) lines.push(S2.lowP(sm.gp - sm.p));
  if (sm.gw && sm.w < sm.gw * 0.7) lines.push(S2.lowW);
  return lines.join('\n');
}

// ---------- Еда голосовым или текстом прямо в чат ----------
async function parseFoodText(env, text) {
  const sys = 'Ты разбираешь фразу пользователя о съеденной еде. ' +
    'Ответ — ТОЛЬКО JSON-массив. Элемент: {"name": "продукт в именительном падеже, как в таблице калорийности", "grams": число или 0, "count": число штук или 0, "meal": "b"|"l"|"d"|"s"|null, "kcal": ккал на 100 г, "p": белки на 100 г, "f": жиры на 100 г, "c": углеводы на 100 г}. ' +
    'meal: b — завтрак, l — обед, d — ужин, s — перекус; null, если не сказано. Если указаны штуки — заполни count, а grams — общий вес. Числа словами переводи в цифры.';
  const out = await runText(env, [{ role: 'system', content: sys }, { role: 'user', content: String(text).slice(0, 600) }], 500);
  return cleanItems(extractJSON(out));
}
async function handleFoodMessage(env, msg, textIn) {
  const uid = msg.from.id;
  const L = T(await userLang(env, uid, msg.from));
  if (!env.AI) return send(env, uid, L.voiceOff);
  let text = textIn;
  if (!text) {
    if (!(await takeQuota(env, uid, 'voice'))) return send(env, uid, L.voiceLimit);
    const fileId = (msg.voice || msg.audio || {}).file_id;
    const f = await tg(env, 'getFile', { file_id: fileId });
    if (!f.ok) return send(env, uid, L.noFile);
    const buf = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.result.file_path}`).then((r) => r.arrayBuffer());
    let b64 = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    b64 = btoa(b64);
    try {
      let r;
      try { r = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio: b64, language: 'ru' }); }
      catch { r = await env.AI.run('@cf/openai/whisper', { audio: [...bytes] }); }
      text = String((r && r.text) || '').trim();
    } catch (e) { console.log('bot voice failed', e && e.stack); }
    if (!text) return send(env, uid, L.noVoice);
  } else if (!(await takeQuota(env, uid, 'parse'))) return send(env, uid, L.limit);
  let items = [];
  try { items = await parseFoodText(env, text); } catch (e) { console.log('bot parse failed', e && e.stack); }
  await env.DB.put(`pv:${uid}`, JSON.stringify({ text, items, at: Date.now() }), { expirationTtl: 86400 });
  const MEAL = L.meals;
  const list = items.length
    ? items.map((x) => `• ${esc(x.name)}${x.count ? ` × ${x.count}` : ''}${x.grams ? ` — ~${Math.round(x.grams)} г` : ''}${x.kcal && x.grams ? ` (≈${Math.round(x.kcal * x.grams / 100)} ккал)` : ''}`).join('\n')
    : L.noItems;
  const meal = items.find((x) => x.meal);
  await send(env, uid, `${textIn ? '✍️' : '🎙'} «${esc(text)}»\n\n${list}${meal ? `\n\n🍽 ${MEAL[meal.meal]}` : ''}\n\n${L.checkAdd}`,
    { reply_markup: { inline_keyboard: [[{ text: L.check, web_app: { url: appUrl(env) + '#pending' } }]] } });
}
async function apiPending(req, env) {
  const { error, user } = await userFromBody(req, env, 10000);
  if (error) return error;
  const pv = await env.DB.get(`pv:${user.id}`, 'json');
  if (pv) await env.DB.delete(`pv:${user.id}`);
  return json({ ok: true, pending: pv });
}

// ---------- Голодание: одноразовое уведомление об окончании ----------
async function apiFast(req, env) {
  const { error, body, user } = await userFromBody(req, env, 10000);
  if (error) return error;
  const uid = String(user.id);
  const prev = await env.DB.get(`fs:${uid}`);
  if (prev) {
    const slot = (await env.DB.get(`ro:${prev}`, 'json')) || {};
    delete slot[uid];
    if (Object.keys(slot).length) await env.DB.put(`ro:${prev}`, JSON.stringify(slot)); else await env.DB.delete(`ro:${prev}`);
    await env.DB.delete(`fs:${uid}`);
  }
  const at = Number(body.endAt);
  if (at && at > Date.now() && at < Date.now() + 48 * 3600e3) {
    const d = new Date(at);
    const key = String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0');
    const slot = (await env.DB.get(`ro:${key}`, 'json')) || {};
    slot[uid] = { type: 'fastEnd', at };
    await env.DB.put(`ro:${key}`, JSON.stringify(slot));
    await env.DB.put(`fs:${uid}`, key, { expirationTtl: 3 * 86400 });
  }
  return json({ ok: true });
}
async function processOneOff(env, budget) {
  const now = new Date();
  const key = String(now.getUTCHours()).padStart(2, '0') + String(now.getUTCMinutes()).padStart(2, '0');
  const slot = await env.DB.get(`ro:${key}`, 'json');
  if (!slot) return 0;
  let used = 0, changed = false;
  for (const [uid, it] of Object.entries(slot)) {
    if (Math.abs(it.at - now.getTime()) > 5 * 60000) { if (it.at < now.getTime()) { delete slot[uid]; changed = true; } continue; }
    if (used >= budget) break;
    const L = T(await userLang(env, uid));
    await send(env, uid, L.fastEnd, { reply_markup: openAppKeyboard(env, L.open) });
    used++; delete slot[uid]; changed = true;
    await env.DB.delete(`fs:${uid}`);
  }
  if (changed) { if (Object.keys(slot).length) await env.DB.put(`ro:${key}`, JSON.stringify(slot)); else await env.DB.delete(`ro:${key}`); }
  return used;
}

// ---------- Приглашения ----------
async function botUsername(env) {
  const cached = await env.DB.get('bot:me');
  if (cached) return cached;
  const r = await tg(env, 'getMe', {});
  const name = r.ok ? r.result.username : '';
  if (name) await env.DB.put('bot:me', name, { expirationTtl: 86400 });
  return name;
}
async function apiRef(req, env) {
  const { error, user } = await userFromBody(req, env, 10000);
  if (error) return error;
  const name = await botUsername(env);
  const count = Number(await env.DB.get(`rc:${user.id}`)) || 0;
  return json({ ok: true, count, link: name ? `https://t.me/${name}?start=ref_${user.id}` : '', bot: name });
}
async function registerReferral(env, newUser, refId) {
  if (!/^\d+$/.test(refId) || String(refId) === String(newUser.id)) return;
  const key = `u:${newUser.id}`;
  const { metadata } = await env.DB.getWithMetadata(key);
  if (!metadata || metadata.r) return;
  await env.DB.put(key, '1', { metadata: { ...metadata, r: refId } });
  const count = (Number(await env.DB.get(`rc:${refId}`)) || 0) + 1;
  await env.DB.put(`rc:${refId}`, String(count));
  await send(env, refId, T(await userLang(env, refId)).refJoined(esc(newUser.first_name || '🙂'), count));
}

// ---------- Челленджи ----------
const CH_TYPES = { water: '💧 Пить норму воды', log: '📝 Заполнять дневник', protein: '💪 Норма белка', kcal: '🎯 Уложиться в норму калорий', nosweet: '🍬 Без сладкого' };
const newId = () => Math.random().toString(36).slice(2, 8);
async function apiChallenge(req, env) {
  const { error, body, user } = await userFromBody(req, env, 10000);
  if (error) return error;
  const uid = String(user.id);
  const name = String(user.first_name || 'Участник').slice(0, 30);
  const myKey = `uc:${uid}`;
  const mine = (await env.DB.get(myKey, 'json')) || [];
  const load = (id) => env.DB.get(`ch:${id}`, 'json');
  const save = (c) => env.DB.put(`ch:${c.id}`, JSON.stringify(c), { expirationTtl: 120 * 86400 });
  const link = async (id) => { const n = await botUsername(env); return n ? `https://t.me/${n}?start=ch_${id}` : ''; };
  const act = body.action;
  if (act === 'create') {
    if (!CH_TYPES[body.type]) return json({ ok: false, error: 'Неизвестный тип' }, 400);
    if (mine.length >= 10) return json({ ok: false, error: 'Можно участвовать максимум в 10 челленджах' }, 400);
    const days = [7, 14, 30].includes(Number(body.days)) ? Number(body.days) : 7;
    const start = /^\d{4}-\d{2}-\d{2}$/.test(body.start || '') ? body.start : today8();
    const c = { id: newId(), type: body.type, title: CH_TYPES[body.type], days, start, owner: uid, members: { [uid]: { n: name, done: {} } } };
    await save(c);
    await env.DB.put(myKey, JSON.stringify([c.id, ...mine]));
    return json({ ok: true, challenge: c, link: await link(c.id) });
  }
  if (act === 'join') {
    const c = await load(String(body.id || ''));
    if (!c) return json({ ok: false, error: 'Челлендж не найден или завершён' }, 404);
    if (!c.members[uid]) {
      if (Object.keys(c.members).length >= 50) return json({ ok: false, error: 'В челлендже уже 50 участников' }, 400);
      c.members[uid] = { n: name, done: {} };
      await save(c);
      if (c.owner !== uid) { const ol = await userLang(env, c.owner); await send(env, c.owner, T(ol).chJoined(esc(name), esc((CH_TITLES[ol] || {})[c.type] || c.title))); }
    }
    if (!mine.includes(c.id)) await env.DB.put(myKey, JSON.stringify([c.id, ...mine].slice(0, 10)));
    return json({ ok: true, challenge: c, link: await link(c.id) });
  }
  if (act === 'mark') {
    const c = await load(String(body.id || ''));
    if (!c || !c.members[uid]) return json({ ok: false, error: 'Нет такого челленджа' }, 404);
    const date = String(body.date || '');
    const s = new Date(c.start + 'T00:00:00Z'), d = new Date(date + 'T00:00:00Z');
    const idx = Math.round((d - s) / 86400e3);
    if (!(idx >= 0 && idx < c.days)) return json({ ok: false, error: 'Дата вне челленджа' }, 400);
    const done = c.members[uid].done;
    if (body.done) done[date] = 1; else delete done[date];
    await save(c);
    return json({ ok: true, challenge: c });
  }
  if (act === 'leave') {
    const c = await load(String(body.id || ''));
    if (c && c.members[uid]) { delete c.members[uid]; if (Object.keys(c.members).length) await save(c); else await env.DB.delete(`ch:${c.id}`); }
    await env.DB.put(myKey, JSON.stringify(mine.filter((x) => x !== body.id)));
    return json({ ok: true });
  }
  // list
  const list = [];
  for (const id of mine) { const c = await load(id); if (c) list.push({ ...c, link: await link(id) }); }
  if (list.length !== mine.length) await env.DB.put(myKey, JSON.stringify(list.map((c) => c.id)));
  return json({ ok: true, list });
}

// ---------- Картинка в чат (итоги недели) ----------
async function apiSharePhoto(req, env) {
  const { error, body, user } = await userFromBody(req, env, 3_000_000);
  if (error) return error;
  const b64 = String(body.image || '').replace(/^data:image\/\w+;base64,/, '');
  if (b64.length < 1000) return json({ ok: false, error: 'Нет изображения' }, 400);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const fd = new FormData();
  fd.append('chat_id', String(user.id));
  fd.append('caption', String(body.caption || '').slice(0, 900));
  fd.append('photo', new Blob([bytes], { type: 'image/png' }), 'week.png');
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: fd }).then((x) => x.json());
  if (!r.ok) return json({ ok: false, error: r.error_code === 403 ? 'Сначала нажмите «Старт» в чате с ботом' : (r.description || 'Не удалось отправить') }, 502);
  return json({ ok: true });
}

// ---------- Сегменты рассылки ----------
const SEGMENTS = {
  all: ['Всем', () => true],
  inactive: ['Неактивным 7+ дней', (u, now) => now - (u.m.s || 0) > 7 * 86400e3],
  new: ['Новым за 7 дней', (u, now) => now - (u.m.j || 0) < 7 * 86400e3],
  active: ['Активным за 7 дней', (u, now) => now - (u.m.s || 0) < 7 * 86400e3],
  app: ['Кто открывал приложение', (u) => (u.m.o || 0) > 0],
  noapp: ['Не открывали приложение', (u) => !((u.m.o || 0) > 0)],
  uk: ['🇺🇦 Украинский язык', (u) => (u.m.l || 'uk') === 'uk'],
  ru: ['💩 Русский язык', (u) => u.m.l === 'ru'],
  en: ['🇬🇧 Английский язык', (u) => u.m.l === 'en'],
  vip: ['⭐ VIP', (u) => !!u.m.v],
  refs: ['Пришли по приглашению', (u) => !!u.m.r],
};

// =====================================================================
//  Языки бота: украинский (основной), русский, английский
// =====================================================================
const BOT_TR = {
  uk: {
    open: '🥗 Відкрити щоденник', join: '🏁 Приєднатися', check: '✅ Перевірити й додати',
    hello: (n) => `👋 Привіт, <b>${n}</b>!\n\nЯ допоможу рахувати калорії, білки, жири та вуглеводи.\n\n🥗 Щоденник харчування, рецепти й план\n📷 Розпізнавання їжі за фото\n🎙 Голосове введення\n💧 Вода, ⚖️ вага і 📊 статистика\n\n💡 Можна просто сюди надіслати голосове «з'їв два яйця й каву» або написати <code>+ банан і йогурт</code> — я розберу й запропоную додати.\n\nНатисніть кнопку нижче, щоб відкрити щоденник. Ваші записи бачите лише ви.`,
    help: `ℹ️ <b>Як користуватися</b>\n\n1. Відкрийте щоденник кнопкою нижче або кнопкою «Відкрити» ліворуч від поля введення.\n2. Під час першого запуску заповніть анкету — застосунок розрахує вашу норму.\n3. Додавайте їжу в сніданок, обід, вечерю й перекуси.\n4. Або надішліть сюди голосове / повідомлення з «+»: <code>+ 2 яйця і 100 г гречки на обід</code>\n\nЄ питання чи ідея? Просто напишіть сюди — повідомлення прочитає автор.\n\n👨‍💻 Розроблено розробником <b>Danya. Vas</b> за підтримки тестувальника <b>Не вказано</b>.`,
    sent: '✉️ Повідомлення передано автору. Відповідь прийде сюди.',
    chInvite: '🏁 Вас запросили в челендж! Відкрийте застосунок, щоб приєднатися 👇',
    voiceOff: 'Голосове введення поки не підключене. Відкрийте щоденник кнопкою «Відкрити».',
    voiceLimit: 'Ліміт голосових на сьогодні вичерпано. Відкрийте щоденник, щоб додати вручну.',
    limit: 'Ліміт на сьогодні вичерпано.',
    noFile: 'Не вдалося отримати голосове 😕',
    noVoice: 'Не розібрав голосове 😕 Спробуйте ще раз або напишіть текстом: <code>+ два яйця і кава</code>',
    noItems: 'Не вдалося виділити продукти — перевірте в застосунку.',
    checkAdd: 'Перевірте вагу й додайте в щоденник 👇',
    meals: { b: 'сніданок', l: 'обід', d: 'вечеря', s: 'перекус' },
    rem: { diary: '📝 Не забудьте записати їжу в щоденник — це займе хвилину.', water: '💧 Час випити склянку води!', weight: '⚖️ Сьогодні день зважування. Запишіть вагу — вранці натщесерце найчесніше.', plan: '🗓 Перегляньте план харчування на завтра.', empty: '📝 Сьогодні в щоденнику поки порожньо. Запишіть, що їли, — це займе хвилину 🙂' },
    fastEnd: '⏰ Голодування завершено — вікно харчування відкрите! Почніть із білка та овочів 🥗',
    refJoined: (n, c) => `🎉 За вашим запрошенням приєднався ${n}! Усього запрошено: ${c}.`,
    chJoined: (n, t) => `🏁 ${n} приєднався до челенджу «${t}»!`,
    sum: { title: '📊 <b>Підсумок дня</b>', kcal: 'ккал', burned: 'спалено', protein: 'Білки', water: 'Вода', of: 'з', g: 'г', l: 'л', ok: 'Чудовий баланс — так тримати 👍', under: (x) => `Є запас ${x} ккал — не забудьте повечеряти 🙂`, over: 'Трохи більше норми — нічого страшного, завтра новий день 💪', lowP: (x) => `Білка не вистачило ~${x} г — додайте сир, яйця або курку.`, lowW: 'Води замало — випийте склянку перед сном 💧' },
  },
  ru: {
    open: '🥗 Открыть дневник', join: '🏁 Присоединиться', check: '✅ Проверить и добавить',
    hello: (n) => `👋 Привет, <b>${n}</b>!\n\nЯ помогу считать калории, белки, жиры и углеводы.\n\n🥗 Дневник питания, рецепты и план\n📷 Распознавание еды по фото\n🎙 Голосовой ввод\n💧 Вода, ⚖️ вес и 📊 статистика\n\n💡 Можно прямо сюда отправить голосовое «съел два яйца и кофе» или написать <code>+ банан и йогурт</code> — я разберу и предложу добавить.\n\nНажмите кнопку ниже, чтобы открыть дневник. Ваши записи видны только вам.`,
    help: `ℹ️ <b>Как пользоваться</b>\n\n1. Откройте дневник кнопкой ниже или кнопкой «Открыть» слева от поля ввода.\n2. При первом запуске заполните анкету — приложение посчитает вашу норму.\n3. Добавляйте еду в завтрак, обед, ужин и перекусы.\n4. Или пришлите сюда голосовое / сообщение с «+»: <code>+ 2 яйца и 100 г гречки на обед</code>\n\nЕсть вопрос или идея? Просто напишите сюда сообщение — его прочитает автор.\n\n👨‍💻 Разработано разработчиком <b>Danya. Vas</b> при поддержке тестировщика <b>Не указано</b>.`,
    sent: '✉️ Сообщение передано автору. Ответ придёт сюда.',
    chInvite: '🏁 Вас пригласили в челлендж! Откройте приложение, чтобы присоединиться 👇',
    voiceOff: 'Голосовой ввод пока не подключён. Откройте дневник кнопкой «Открыть».',
    voiceLimit: 'Лимит голосовых на сегодня исчерпан. Откройте дневник, чтобы добавить вручную.',
    limit: 'Лимит на сегодня исчерпан.',
    noFile: 'Не удалось получить голосовое 😕',
    noVoice: 'Не разобрал голосовое 😕 Попробуйте ещё раз или напишите текстом: <code>+ два яйца и кофе</code>',
    noItems: 'Не удалось выделить продукты — проверьте в приложении.',
    checkAdd: 'Проверьте вес и добавьте в дневник 👇',
    meals: { b: 'завтрак', l: 'обед', d: 'ужин', s: 'перекус' },
    rem: { diary: '📝 Не забудьте записать еду в дневник — это займёт минуту.', water: '💧 Время выпить стакан воды!', weight: '⚖️ Сегодня день взвешивания. Запишите вес — утром натощак честнее всего.', plan: '🗓 Посмотрите план питания на завтра.', empty: '📝 Сегодня в дневнике пока пусто. Запишите, что ели, — это займёт минуту 🙂' },
    fastEnd: '⏰ Голодание завершено — окно питания открыто! Начните с белка и овощей 🥗',
    refJoined: (n, c) => `🎉 По вашему приглашению присоединился ${n}! Всего приглашено: ${c}.`,
    chJoined: (n, t) => `🏁 ${n} присоединился к челленджу «${t}»!`,
    sum: { title: '📊 <b>Итог дня</b>', kcal: 'ккал', burned: 'сожжено', protein: 'Белки', water: 'Вода', of: 'из', g: 'г', l: 'л', ok: 'Отличный баланс — так держать 👍', under: (x) => `Есть запас ${x} ккал — не забудьте поужинать 🙂`, over: 'Немного больше нормы — ничего страшного, завтра новый день 💪', lowP: (x) => `Белка не хватило ~${x} г — добавьте творог, яйца или курицу.`, lowW: 'Воды маловато — выпейте стакан перед сном 💧' },
  },
  en: {
    open: '🥗 Open diary', join: '🏁 Join', check: '✅ Review and add',
    hello: (n) => `👋 Hi, <b>${n}</b>!\n\nI’ll help you track calories, protein, fat and carbs.\n\n🥗 Food diary, recipes and meal plan\n📷 Food recognition from photos\n🎙 Voice input\n💧 Water, ⚖️ weight and 📊 stats\n\n💡 You can send me a voice message like “two eggs and coffee” or write <code>+ banana and yogurt</code> — I’ll parse it and offer to add it.\n\nTap the button below to open your diary. Your entries are visible only to you.`,
    help: `ℹ️ <b>How to use</b>\n\n1. Open the diary with the button below or the “Open” button next to the input field.\n2. On first launch fill in the questionnaire — the app will calculate your goals.\n3. Add food to breakfast, lunch, dinner and snacks.\n4. Or send a voice message / a message starting with “+”: <code>+ 2 eggs and 100 g buckwheat for lunch</code>\n\nQuestions or ideas? Just write here — the author will read it.\n\n👨‍💻 Developed by <b>Danya. Vas</b> with the support of tester <b>Not specified</b>.`,
    sent: '✉️ Your message was sent to the author. The reply will come here.',
    chInvite: '🏁 You’ve been invited to a challenge! Open the app to join 👇',
    voiceOff: 'Voice input isn’t connected yet. Open the diary with the “Open” button.',
    voiceLimit: 'Today’s voice limit is reached. Open the diary to add manually.',
    limit: 'Today’s limit is reached.',
    noFile: 'Couldn’t get the voice message 😕',
    noVoice: 'Couldn’t understand the voice message 😕 Try again or type: <code>+ two eggs and coffee</code>',
    noItems: 'Couldn’t detect foods — please check in the app.',
    checkAdd: 'Check the amounts and add to your diary 👇',
    meals: { b: 'breakfast', l: 'lunch', d: 'dinner', s: 'snack' },
    rem: { diary: '📝 Don’t forget to log your food — it takes a minute.', water: '💧 Time for a glass of water!', weight: '⚖️ It’s weigh-in day. Log your weight — in the morning before eating is best.', plan: '🗓 Check your meal plan for tomorrow.', empty: '📝 Your diary is empty today. Log what you ate — it takes a minute 🙂' },
    fastEnd: '⏰ Fast complete — your eating window is open! Start with protein and veggies 🥗',
    refJoined: (n, c) => `🎉 ${n} joined via your invite! Total invited: ${c}.`,
    chJoined: (n, t) => `🏁 ${n} joined the “${t}” challenge!`,
    sum: { title: '📊 <b>Daily summary</b>', kcal: 'kcal', burned: 'burned', protein: 'Protein', water: 'Water', of: 'of', g: 'g', l: 'L', ok: 'Great balance — keep it up 👍', under: (x) => `You have ${x} kcal left — don’t skip dinner 🙂`, over: 'A bit over your goal — no worries, tomorrow is a new day 💪', lowP: (x) => `You were ~${x} g short on protein — add cottage cheese, eggs or chicken.`, lowW: 'Not much water today — have a glass before bed 💧' },
  },
};
const CH_TITLES = {
  uk: { water: '💧 Пити норму води', log: '📝 Заповнювати щоденник', protein: '💪 Норма білка', kcal: '🎯 Вкластися в норму калорій', nosweet: '🍬 Без солодкого' },
  en: { water: '💧 Drink your water goal', log: '📝 Log your diary', protein: '💪 Protein goal', kcal: '🎯 Stay within calorie goal', nosweet: '🍬 No sweets' },
};
const mapLangCode = (c) => (/^uk/.test(c || '') ? 'uk' : /^(ru|be|kk)/.test(c || '') ? 'ru' : c ? 'en' : 'uk');
async function userLang(env, uid, from) {
  const cfg = await env.DB.get('config', 'json');
  if (cfg && BOT_TR[cfg.forceLang]) return cfg.forceLang;
  const { metadata } = await env.DB.getWithMetadata(`u:${uid}`);
  if (metadata && metadata.l && BOT_TR[metadata.l]) return metadata.l;
  return mapLangCode(from && from.language_code);
}
const T = (lang) => BOT_TR[lang] || BOT_TR.uk;

// =====================================================================
//  v6: Панель владельца — 90+ команд (вызов: /admin)
// =====================================================================
const DAY = 86400e3;
const TZ = 'Europe/Kyiv';
const ago = (ts) => {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86400)} дн назад`;
};
const pctOf = (a, b) => (b ? Math.round((a * 100) / b) : 0) + '%';
const bar = (v, max, w = 12) => '▇'.repeat(max ? Math.max(v ? 1 : 0, Math.round((v / max) * w)) : 0) || '·';
const kyivDay = (ts) => new Date(ts).toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
const kyivHM = (ts = Date.now()) => new Date(ts).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const onOff = (a) => (/^(on|вкл|1|да|yes|true|\+)$/i.test(a || '') ? true : /^(off|выкл|0|нет|no|false|-)$/i.test(a || '') ? false : null);
const yes = (b) => (b ? '✅ вкл' : '⛔️ выкл');
const isId = (s) => /^\d{3,}$/.test(String(s || ''));

async function getCfg(env) { return (await env.DB.get('config', 'json')) || {}; }
async function setCfg(env, fn) { const c = await getCfg(env); fn(c); await env.DB.put('config', JSON.stringify(c)); return c; }
async function admGet(env, k, def) { return (await env.DB.get('adm:' + k, 'json')) || def; }
async function admSet(env, k, v) { await env.DB.put('adm:' + k, JSON.stringify(v)); }
async function getMeta(env, id) { return (await env.DB.getWithMetadata(`u:${id}`)).metadata; }
async function setMeta(env, id, fn) {
  const m0 = await getMeta(env, id);
  if (!m0) return null;
  const m = { ...m0 };
  fn(m);
  await env.DB.put(`u:${id}`, '1', { metadata: m });
  return m;
}
/** Поиск пользователя: ID, @username или часть имени. */
async function findUser(env, q) {
  q = String(q || '').trim();
  if (!q) return null;
  if (isId(q)) { const m = await getMeta(env, q); return m ? { id: q, m } : null; }
  const users = await allUsers(env);
  const s = q.replace(/^@/, '').toLowerCase();
  return users.find((u) => (u.m.u || '').toLowerCase() === s) || users.find((u) => (u.m.n || '').toLowerCase().includes(s)) || null;
}
async function listKeys(env, prefix, maxPages = 5) {
  const out = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const page = await env.DB.list({ prefix, cursor });
    out.push(...page.keys);
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}
async function sendLong(env, chat, text, extra = {}) {
  const parts = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if ((cur + line).length > 3800) { parts.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) parts.push(cur);
  for (let i = 0; i < parts.length; i++) await send(env, chat, parts[i], i === parts.length - 1 ? extra : {});
}
async function sendFile(env, chat, name, content, caption = '', type = 'text/csv') {
  const fd = new FormData();
  fd.append('chat_id', String(chat));
  if (caption) fd.append('caption', caption.slice(0, 900));
  fd.append('document', new Blob([type === 'text/csv' ? '﻿' + content : content], { type }), name);
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd }).then((x) => x.json());
}
const confirmKb = (action, param = '') => ({ inline_keyboard: [[{ text: '✅ Да, выполнить', callback_data: `cf:${action}:${param}` }, { text: '✖️ Отмена', callback_data: 'cf:no:' }]] });
const userLine = (u, extra = '') => `${userLabel(u.m)}${u.m.x ? ' ⛔️' : ''}${u.m.v ? ' ⭐' : ''}${u.m.b ? ' 🚫' : ''} · <code>${u.id}</code>${extra}`;
const usage = (fmt) => `Формат: <code>${fmt}</code>`;
const activeUsers = (users) => users.filter((u) => !u.m.b && !u.m.x);

// ---------- Лимиты ИИ и бан (используются API) ----------
async function aiSettings(env) { return admGet(env, 'ai', { off: false, limits: {} }); }
async function quotaError(env, uid, kind) {
  const ai = await aiSettings(env);
  if (ai.off) return 'ИИ временно отключён владельцем. Попробуйте позже.';
  if (!(await takeQuota(env, uid, kind, ai))) return 'Лимит на сегодня исчерпан. Попробуйте завтра.';
  return '';
}
async function isBanned(env, uid) { const m = await getMeta(env, uid); return !!(m && m.x); }

// ---------- Журнал ошибок клиента ----------
async function storeClientError(env, text) {
  const key = `le:${kyivDay(Date.now())}`;
  const arr = (await env.DB.get(key, 'json')) || [];
  if (arr.length >= 30) return; // не больше 30 записей в день — бережём лимит KV
  arr.push({ t: Date.now(), m: String(text).slice(0, 300) });
  await env.DB.put(key, JSON.stringify(arr), { expirationTtl: 7 * 86400 });
}

// ---------- Отложенная рассылка (проверяется cron) ----------
async function processScheduled(env) {
  const s = await env.DB.get('bc:sched', 'json');
  if (!s || s.at > Date.now() || (await env.DB.get('bc:job'))) return;
  const ids = activeUsers(await allUsers(env)).filter((u) => !isOwner(env, u.id)).map((u) => u.id);
  await env.DB.put('bc:job', JSON.stringify({ draft: s.draft, from: s.from, ids, i: 0, ok: 0, fail: 0, seg: 'Отложенная' }));
  await env.DB.delete('bc:sched');
  await send(env, s.from, `⏰ Отложенная рассылка запущена: ${ids.length} получателей.`);
}
async function pushHistory(env, job) {
  const h = (await env.DB.get('bc:hist', 'json')) || [];
  h.unshift({ t: Date.now(), n: job.ids.length, ok: job.ok, fail: job.fail, seg: job.seg || 'Всем', txt: job.draft.text ? job.draft.text.slice(0, 60) : '[медиа]' });
  await env.DB.put('bc:hist', JSON.stringify(h.slice(0, 15)));
}

// ---------- Группы команд ----------
const ADM_GROUPS = {
  st: '📊 Статистика',
  us: '👥 Пользователи',
  mod: '🛡 Модерация',
  bc: '📣 Рассылки',
  app: '📱 Приложение',
  food: '🍎 Продукты',
  ai: '🤖 ИИ',
  sup: '💬 Поддержка',
  bot: '🤖 Профиль бота',
  sys: '⚙️ Система',
};

/** Переключатель настройки приложения (вкл/выкл). */
const cfgToggle = (key, title) => async ({ env, arg }) => {
  const v = onOff(arg);
  const c = await getCfg(env);
  const cur = c[key] !== false;
  if (v === null) return `${title}: ${yes(cur)}\n${usage(`/${key.toLowerCase()} on|off`)}`;
  await setCfg(env, (x) => { x[key] = v; });
  return `${title}: ${yes(v)}\nУ пользователей обновится в течение минуты.`;
};
const cfgText = (key, title, fmt) => async ({ env, arg }) => {
  if (!arg) return `${title}: <b>${esc((await getCfg(env))[key] || '—')}</b>\n${usage(fmt)}`;
  await setCfg(env, (x) => { x[key] = arg.slice(0, 120); });
  return `✅ ${title}: <b>${esc(arg.slice(0, 120))}</b>`;
};

// [команда, группа, аргументы, описание, функция | null — обрабатывается в ownerCommand]
const ADMIN_CMDS = [
  ['admin', 'sys', '', 'Панель владельца — все команды', null],

  // ---------- 📊 Статистика ----------
  ['stats', 'st', '', 'Общая статистика', null],
  ['today', 'st', '', 'Сводка за сегодня', async ({ env }) => {
    const users = await allUsers(env); const d = kyivDay(Date.now());
    const u = (await env.DB.get(`us:${today8()}`, 'json')) || {};
    const isToday = (ts) => ts && kyivDay(ts) === d;
    return `📅 <b>Сегодня, ${d}</b>\n\n🆕 Новых: <b>${users.filter((x) => isToday(x.m.j)).length}</b>\n🔥 Заходили: <b>${users.filter((x) => isToday(x.m.s)).length}</b>\n` +
      `📱 Сессий в приложении: <b>${u._sessions || 0}</b>\n🧩 Действий: <b>${Object.entries(u).filter(([k]) => k[0] !== '_').reduce((s, [, v]) => s + v, 0)}</b>`;
  }],
  ['week', 'st', '', 'Новые пользователи по дням (7 дн)', async ({ env }) => {
    const users = await allUsers(env);
    const days = Array.from({ length: 7 }, (_, i) => kyivDay(Date.now() - (6 - i) * DAY));
    const cnt = days.map((d) => users.filter((u) => u.m.j && kyivDay(u.m.j) === d).length);
    const max = Math.max(...cnt);
    return `📈 <b>Новые за неделю: ${cnt.reduce((a, b) => a + b, 0)}</b>\n\n<code>${days.map((d, i) => `${d.slice(5)} ${bar(cnt[i], max)} ${cnt[i]}`).join('\n')}</code>`;
  }],
  ['month', 'st', '', 'Новые пользователи за 30 дней', async ({ env }) => {
    const users = await allUsers(env);
    const weeks = [3, 2, 1, 0].map((w) => users.filter((u) => u.m.j && Date.now() - u.m.j >= w * 7 * DAY && Date.now() - u.m.j < (w + 1) * 7 * DAY).length);
    const max = Math.max(...weeks);
    return `🗓 <b>Новые за 4 недели: ${weeks.reduce((a, b) => a + b, 0)}</b>\n\n<code>${weeks.map((n, i) => `${['3 нед. назад', '2 нед. назад', 'прошлая нед.', 'эта неделя  '][i]} ${bar(n, max)} ${n}`).join('\n')}</code>`;
  }],
  ['growth', 'st', '', 'Рост аудитории (8 недель)', async ({ env }) => {
    const users = await allUsers(env);
    const pts = Array.from({ length: 8 }, (_, i) => { const t = Date.now() - (7 - i) * 7 * DAY; return [kyivDay(t).slice(5), users.filter((u) => (u.m.j || 0) <= t).length]; });
    const max = Math.max(...pts.map((p) => p[1]));
    return `🌱 <b>Рост аудитории</b>\n\n<code>${pts.map(([d, n]) => `${d} ${bar(n, max)} ${n}`).join('\n')}</code>`;
  }],
  ['retention', 'st', '', 'Удержание: кто вернулся', async ({ env }) => {
    const users = (await allUsers(env)).filter((u) => u.m.j && Date.now() - u.m.j > DAY);
    const back1 = users.filter((u) => (u.m.s || 0) - u.m.j > DAY).length;
    const old7 = users.filter((u) => Date.now() - u.m.j > 7 * DAY);
    const live7 = old7.filter((u) => Date.now() - (u.m.s || 0) < 7 * DAY).length;
    return `🔁 <b>Удержание</b>\n\nВернулись после первого дня: <b>${back1}</b> из ${users.length} (${pctOf(back1, users.length)})\n` +
      `Старше недели и активны за 7 дн: <b>${live7}</b> из ${old7.length} (${pctOf(live7, old7.length)})`;
  }],
  ['features', 'st', '[дни]', 'Популярность функций', async ({ env, arg }) => {
    const n = Math.min(Math.max(parseInt(arg, 10) || 7, 1), 30);
    const u = Object.entries(await usageLastDays(env, n)).filter(([k]) => FEATURE_NAMES[k]).sort((a, b) => b[1] - a[1]);
    const max = u.length ? u[0][1] : 0;
    return `🧩 <b>Функции за ${n} дн</b>\n\n<code>${u.map(([k, v]) => `${FEATURE_NAMES[k].padEnd(12)} ${bar(v, max, 10)} ${v}`).join('\n') || 'нет данных'}</code>`;
  }],
  ['top', 'st', '[N]', 'Самые активные (по открытиям)', async ({ env, arg }) => {
    const n = Math.min(Math.max(parseInt(arg, 10) || 15, 1), 50);
    const users = (await allUsers(env)).sort((a, b) => (b.m.o || 0) - (a.m.o || 0)).slice(0, n);
    return `🏆 <b>Топ-${users.length} по открытиям</b>\n\n${users.map((u, i) => `${i + 1}. ${userLine(u, ` · 📱${u.m.o || 0}`)}`).join('\n') || 'Пока никого'}`;
  }],
  ['langs', 'st', '', 'Языки пользователей', async ({ env }) => {
    const users = await allUsers(env); const c = {};
    for (const u of users) c[u.m.l || '?'] = (c[u.m.l || '?'] || 0) + 1;
    const names = { uk: '🇺🇦 Українська', ru: '💩 Русский', en: '🇬🇧 English', '?': '❔ Не выбран' };
    return `🌐 <b>Языки</b>\n\n${Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${names[k] || k}: <b>${v}</b> (${pctOf(v, users.length)})`).join('\n')}\n\nЯзык для всех: /forcelang`;
  }],
  ['sources', 'st', '', 'Откуда пришли + топ пригласивших', async ({ env }) => {
    const users = await allUsers(env);
    const refs = users.filter((u) => u.m.r);
    const by = {};
    for (const u of refs) by[u.m.r] = (by[u.m.r] || 0) + 1;
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const names = Object.fromEntries(users.map((u) => [u.id, u]));
    return `🧭 <b>Источники</b>\n\nСами нашли бота: <b>${users.length - refs.length}</b>\nПо приглашению: <b>${refs.length}</b> (${pctOf(refs.length, users.length)})\n\n` +
      `🤝 <b>Топ пригласивших</b>\n${top.map(([id, n], i) => `${i + 1}. ${names[id] ? userLabel(names[id].m) : id} — ${n}`).join('\n') || 'пока никого'}`;
  }],
  ['aiusage', 'st', '', 'Расход ИИ за сегодня', async ({ env }) => {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const keys = (await listKeys(env, 'q:')).filter((k) => k.name.endsWith(':' + day));
    const tot = {}; const per = [];
    for (const k of keys.slice(0, 60)) {
      const q = (await env.DB.get(k.name, 'json')) || {};
      let s = 0;
      for (const [kind, v] of Object.entries(q)) { tot[kind] = (tot[kind] || 0) + v; s += v; }
      per.push([k.name.split(':')[1], s]);
    }
    per.sort((a, b) => b[1] - a[1]);
    return `🤖 <b>ИИ сегодня</b> (по UTC)\n\nПользователей: <b>${keys.length}</b>\n📷 Фото: ${tot.photo || 0}\n🎙 Голос: ${tot.voice || 0}\n✍️ Разбор текста: ${tot.parse || 0}\n💬 Чат: ${tot.chat || 0}\n\n` +
      `Больше всех: ${per.slice(0, 5).map(([id, n]) => `<code>${id}</code> (${n})`).join(', ') || '—'}`;
  }],
  ['diary', 'st', '', 'Кто заполнял дневник сегодня', async ({ env }) => {
    const keys = await listKeys(env, 'sm:');
    const d = new Date().toISOString().slice(0, 10);
    const rows = [];
    for (const k of keys.slice(0, 80)) { const s = await env.DB.get(k.name, 'json'); if (s && s.date >= new Date(Date.now() - DAY).toISOString().slice(0, 10)) rows.push(s); }
    const avg = (f) => (rows.length ? Math.round(rows.reduce((a, s) => a + f(s), 0) / rows.length) : 0);
    const inGoal = rows.filter((s) => s.gk && Math.abs(s.k - s.gk - (s.burn || 0)) <= (s.gk + (s.burn || 0)) * 0.1).length;
    return `📝 <b>Дневник за последние сутки</b> (${d})\n\nЗаполняли: <b>${rows.length}</b>\nСредне: ${avg((s) => s.k)} ккал · белок ${avg((s) => s.p)} г · вода ${avg((s) => s.w)} мл\nСредне записей: ${avg((s) => s.e)}\nВ норме калорий (±10%): <b>${inGoal}</b> (${pctOf(inGoal, rows.length)})`;
  }],

  // ---------- 👥 Пользователи ----------
  ['users', 'us', '[N]', 'Последние зарегистрированные', null],
  ['user', 'us', 'id|@ник|имя', 'Карточка пользователя', async ({ env, arg }) => {
    const u = await findUser(env, arg);
    if (!u) return arg ? '🤷 Не найден' : usage('/user 123456789');
    const [rc, rs, sm, note, ch] = await Promise.all([env.DB.get(`rc:${u.id}`), env.DB.get(`rs:${u.id}`, 'json'), env.DB.get(`sm:${u.id}`, 'json'), env.DB.get(`nt:${u.id}`), env.DB.get(`uc:${u.id}`, 'json')]);
    const q = (await env.DB.get(`q:${u.id}:${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`, 'json')) || {};
    const rem = rs && rs.items ? Object.entries(rs.items).filter(([, v]) => v && v.on).map(([k]) => k).join(', ') : '';
    return `👤 <b>${userLabel(u.m)}</b>\nID: <code>${u.id}</code>\n\n` +
      `📅 С нами с: ${u.m.j ? fmtDate(u.m.j) : '—'}\n👀 Последний визит: ${ago(u.m.s)}\n📱 Открытий приложения: ${u.m.o || 0}\n🌐 Язык: ${u.m.l || '—'}\n` +
      `🤝 Пригласил: ${u.m.r ? `<code>${u.m.r}</code>` : '—'} · Привёл: ${Number(rc) || 0}\n🔔 Напоминания: ${rem || '—'}\n🏁 Челленджей: ${(ch || []).length}\n` +
      `🤖 ИИ сегодня: ${Object.entries(q).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}\n` +
      (sm ? `📝 Последний день (${sm.date}): ${sm.k}/${sm.gk} ккал, вода ${sm.w} мл\n` : '') +
      `🏷 Теги: ${(u.m.t || []).join(', ') || '—'}\n` +
      `${u.m.v ? '⭐ VIP\n' : ''}${u.m.x ? `⛔️ Забанен${u.m.x !== 1 ? ': ' + esc(u.m.x) : ''}\n` : ''}${u.m.mu ? '🔇 Сообщения не пересылаются\n' : ''}${u.m.b ? '🚫 Заблокировал бота\n' : ''}` +
      (note ? `\n🗒 ${esc(note)}` : '') +
      `\n\n<code>/reply ${u.id} </code>— написать`;
  }],
  ['find', 'us', 'текст', 'Поиск по имени или @нику', async ({ env, arg }) => {
    if (!arg) return usage('/find Анна');
    const s = arg.replace(/^@/, '').toLowerCase();
    const r = (await allUsers(env)).filter((u) => (u.m.n || '').toLowerCase().includes(s) || (u.m.u || '').toLowerCase().includes(s) || u.id.includes(s)).slice(0, 30);
    return `🔎 Найдено: ${r.length}\n\n${r.map((u) => userLine(u)).join('\n') || '—'}`;
  }],
  ['recent', 'us', '[N]', 'Недавно заходившие', async ({ env, arg }) => {
    const n = Math.min(Math.max(parseInt(arg, 10) || 20, 1), 50);
    const users = (await allUsers(env)).sort((a, b) => (b.m.s || 0) - (a.m.s || 0)).slice(0, n);
    return `👀 <b>Недавно заходили</b>\n\n${users.map((u, i) => `${i + 1}. ${userLine(u, ` · ${ago(u.m.s)}`)}`).join('\n')}`;
  }],
  ['inactive', 'us', '[дни]', 'Давно не заходили', async ({ env, arg }) => {
    const d = Math.max(parseInt(arg, 10) || 14, 1);
    const r = (await allUsers(env)).filter((u) => Date.now() - (u.m.s || 0) > d * DAY).sort((a, b) => (a.m.s || 0) - (b.m.s || 0));
    return `😴 <b>Не заходили ${d}+ дн: ${r.length}</b>\n\n${r.slice(0, 30).map((u) => userLine(u, ` · ${ago(u.m.s)}`)).join('\n') || '—'}\n\nНапомнить им: /broadcast → «Неактивным»`;
  }],
  ['noapp', 'us', '', 'Ни разу не открыли приложение', async ({ env }) => {
    const r = (await allUsers(env)).filter((u) => !(u.m.o > 0));
    return `📵 <b>Не открывали приложение: ${r.length}</b>\n\n${r.slice(0, 30).map((u) => userLine(u)).join('\n') || '—'}`;
  }],
  ['refs', 'us', 'id', 'Кого привёл пользователь', async ({ env, arg }) => {
    if (!isId(arg)) return usage('/refs 123456789');
    const r = (await allUsers(env)).filter((u) => String(u.m.r) === arg);
    return `🤝 <b>Пригласил ${r.length}</b>\n\n${r.map((u) => userLine(u, ` · ${fmtDate(u.m.j || 0)}`)).join('\n') || '—'}`;
  }],
  ['note', 'us', 'id [текст | -]', 'Заметка о пользователе', async ({ env, args }) => {
    const [id, ...w] = args;
    if (!isId(id)) return usage('/note 123456789 любит гречку') + '\nУдалить: <code>/note id -</code>';
    const t = w.join(' ');
    if (!t) return `🗒 ${esc((await env.DB.get(`nt:${id}`)) || 'Заметки нет')}`;
    if (t === '-') { await env.DB.delete(`nt:${id}`); return '🗑 Заметка удалена'; }
    await env.DB.put(`nt:${id}`, t.slice(0, 1000));
    return '✅ Заметка сохранена';
  }],
  ['notes', 'us', '', 'Все заметки', async ({ env }) => {
    const keys = await listKeys(env, 'nt:');
    const rows = [];
    for (const k of keys.slice(0, 30)) rows.push(`<code>${k.name.slice(3)}</code> — ${esc(((await env.DB.get(k.name)) || '').slice(0, 80))}`);
    return `🗒 <b>Заметки (${keys.length})</b>\n\n${rows.join('\n') || '—'}`;
  }],
  ['tag', 'us', 'id тег', 'Добавить тег', async ({ env, args }) => {
    const [id, tag] = args;
    if (!isId(id) || !tag) return usage('/tag 123456789 тестер');
    const m = await setMeta(env, id, (x) => { x.t = [...new Set([...(x.t || []), tag.toLowerCase().slice(0, 16)])].slice(0, 5); });
    return m ? `🏷 Теги: ${m.t.join(', ')}` : '🤷 Пользователь не найден';
  }],
  ['untag', 'us', 'id тег', 'Убрать тег', async ({ env, args }) => {
    const [id, tag] = args;
    if (!isId(id) || !tag) return usage('/untag 123456789 тестер');
    const m = await setMeta(env, id, (x) => { x.t = (x.t || []).filter((t) => t !== tag.toLowerCase()); if (!x.t.length) delete x.t; });
    return m ? `🏷 Теги: ${(m.t || []).join(', ') || '—'}` : '🤷 Пользователь не найден';
  }],
  ['tagged', 'us', '[тег]', 'Пользователи с тегом / все теги', async ({ env, arg }) => {
    const users = await allUsers(env);
    if (!arg) {
      const c = {};
      for (const u of users) for (const t of u.m.t || []) c[t] = (c[t] || 0) + 1;
      return `🏷 <b>Теги</b>\n\n${Object.entries(c).map(([t, n]) => `${esc(t)} — ${n}`).join('\n') || 'Тегов пока нет. Добавить: /tag'}`;
    }
    const r = users.filter((u) => (u.m.t || []).includes(arg.toLowerCase()));
    return `🏷 <b>${esc(arg)}: ${r.length}</b>\n\n${r.map((u) => userLine(u)).join('\n') || '—'}`;
  }],
  ['setlang', 'us', 'id uk|ru|en', 'Сменить язык бота пользователю', async ({ env, args }) => {
    const [id, l] = args;
    if (!isId(id) || !BOT_TR[l]) return usage('/setlang 123456789 uk');
    return (await setMeta(env, id, (x) => { x.l = l; })) ? `✅ Язык бота для <code>${id}</code>: ${l}` : '🤷 Пользователь не найден';
  }],
  ['forget', 'us', 'id', 'Удалить пользователя из базы', async ({ env, me, arg }) => {
    if (!isId(arg)) return usage('/forget 123456789');
    const m = await getMeta(env, arg);
    if (!m) return '🤷 Пользователь не найден';
    await send(env, me, `Удалить ${userLabel(m)} (<code>${arg}</code>) из базы бота? Дневник в его телефоне останется.`, { reply_markup: confirmKb('forget', arg) });
  }],
  ['export', 'us', '', 'Выгрузить всех в CSV', async ({ env, me }) => {
    const users = await allUsers(env);
    const q = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
    const rows = [['id', 'имя', 'username', 'первый вход', 'последний визит', 'открытий', 'язык', 'пригласил', 'теги', 'vip', 'бан', 'заблокировал бота'].map(q).join(';')];
    for (const u of users) rows.push([u.id, u.m.n, u.m.u, u.m.j ? fmtDate(u.m.j) : '', u.m.s ? fmtDate(u.m.s) : '', u.m.o || 0, u.m.l || '', u.m.r || '', (u.m.t || []).join(' '), u.m.v ? 1 : '', u.m.x ? 1 : '', u.m.b ? 1 : ''].map(q).join(';'));
    const r = await sendFile(env, me, `users_${kyivDay(Date.now())}.csv`, rows.join('\n'), `👥 ${users.length} пользователей`);
    if (!r.ok) return `⚠️ ${esc(r.description)}`;
  }],

  // ---------- 🛡 Модерация ----------
  ['ban', 'mod', 'id [причина]', 'Забанить (бот и ИИ перестанут работать)', async ({ env, args }) => {
    const [id, ...w] = args;
    if (!isId(id)) return usage('/ban 123456789 спам');
    if (isOwner(env, id)) return '🙃 Себя забанить нельзя';
    const m = await setMeta(env, id, (x) => { x.x = w.join(' ').slice(0, 60) || 1; });
    return m ? `⛔️ ${userLabel(m)} забанен.\nСнять: <code>/unban ${id}</code>` : '🤷 Пользователь не найден';
  }],
  ['unban', 'mod', 'id', 'Разбанить', async ({ env, arg }) => {
    if (!isId(arg)) return usage('/unban 123456789');
    const m = await setMeta(env, arg, (x) => { delete x.x; });
    return m ? `✅ ${userLabel(m)} разбанен` : '🤷 Пользователь не найден';
  }],
  ['banned', 'mod', '', 'Список забаненных', async ({ env }) => {
    const r = (await allUsers(env)).filter((u) => u.m.x);
    return `⛔️ <b>Забанены: ${r.length}</b>\n\n${r.map((u) => userLine(u, u.m.x !== 1 ? ` · ${esc(u.m.x)}` : '')).join('\n') || '—'}`;
  }],
  ['vip', 'mod', 'id', 'Выдать VIP (лимиты ИИ ×3)', async ({ env, arg }) => {
    if (!isId(arg)) return usage('/vip 123456789');
    const m = await setMeta(env, arg, (x) => { x.v = 1; });
    return m ? `⭐ ${userLabel(m)} теперь VIP — лимиты ИИ ×3` : '🤷 Пользователь не найден';
  }],
  ['unvip', 'mod', 'id', 'Снять VIP', async ({ env, arg }) => {
    if (!isId(arg)) return usage('/unvip 123456789');
    const m = await setMeta(env, arg, (x) => { delete x.v; });
    return m ? `✅ VIP снят: ${userLabel(m)}` : '🤷 Пользователь не найден';
  }],
  ['vips', 'mod', '', 'Список VIP', async ({ env }) => {
    const r = (await allUsers(env)).filter((u) => u.m.v);
    return `⭐ <b>VIP: ${r.length}</b>\n\n${r.map((u) => userLine(u)).join('\n') || '—'}`;
  }],
  ['mute', 'mod', 'id', 'Не пересылать мне его сообщения', async ({ env, arg }) => {
    if (!isId(arg)) return usage('/mute 123456789');
    const m = await setMeta(env, arg, (x) => { x.mu = 1; });
    return m ? `🔇 Сообщения ${userLabel(m)} больше не пересылаются` : '🤷 Пользователь не найден';
  }],
  ['unmute', 'mod', 'id', 'Снова пересылать сообщения', async ({ env, arg }) => {
    if (!isId(arg)) return usage('/unmute 123456789');
    const m = await setMeta(env, arg, (x) => { delete x.mu; });
    return m ? `🔊 Сообщения ${userLabel(m)} снова пересылаются` : '🤷 Пользователь не найден';
  }],
  ['muted', 'mod', '', 'Список заглушённых', async ({ env }) => {
    const r = (await allUsers(env)).filter((u) => u.m.mu);
    return `🔇 <b>Заглушены: ${r.length}</b>\n\n${r.map((u) => userLine(u)).join('\n') || '—'}`;
  }],
  ['quota', 'mod', 'id [reset]', 'Лимиты ИИ пользователя / сброс', async ({ env, args }) => {
    const [id, act] = args;
    if (!isId(id)) return usage('/quota 123456789') + '\nСбросить: <code>/quota id reset</code>';
    const key = `q:${id}:${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    if (act === 'reset') { await env.DB.delete(key); return '♻️ Лимиты на сегодня сброшены'; }
    const q = (await env.DB.get(key, 'json')) || {};
    const ai = await aiSettings(env); const m = (await getMeta(env, id)) || {};
    return `🤖 <b>ИИ сегодня</b> (<code>${id}</code>)${m.v ? ' ⭐ VIP' : ''}\n\n${Object.keys(AI_LIMITS).map((k) => `${k}: ${q[k] || 0} / ${(ai.limits[k] || AI_LIMITS[k]) * (m.v ? 3 : 1)}`).join('\n')}`;
  }],
  ['blocked', 'mod', '', 'Кто заблокировал бота', async ({ env }) => {
    const r = (await allUsers(env)).filter((u) => u.m.b);
    return `🚫 <b>Заблокировали бота: ${r.length}</b>\n\n${r.slice(0, 40).map((u) => userLine(u)).join('\n') || '—'}`;
  }],

  // ---------- 📣 Рассылки ----------
  ['broadcast', 'bc', 'текст', 'Рассылка (с выбором аудитории)', null],
  ['cancel', 'bc', '', 'Остановить рассылку', null],
  ['bstatus', 'bc', '', 'Ход текущей рассылки', async ({ env }) => {
    const job = await env.DB.get('bc:job', 'json');
    const s = await env.DB.get('bc:sched', 'json');
    return (job ? `📣 Идёт рассылка «${esc(job.seg || 'Всем')}»: ${job.i}/${job.ids.length}\n✅ ${job.ok} · ❌ ${job.fail}` : '💤 Сейчас рассылки нет') +
      (s ? `\n\n⏰ Отложенная: ${fmtDate(s.at)}` : '');
  }],
  ['bhistory', 'bc', '', 'История рассылок', async ({ env }) => {
    const h = (await env.DB.get('bc:hist', 'json')) || [];
    return `🗂 <b>Последние рассылки</b>\n\n${h.map((x) => `${fmtDate(x.t)} · ${esc(x.seg)} · ✅${x.ok}/${x.n}${x.fail ? ` ❌${x.fail}` : ''}\n   «${esc(x.txt)}»`).join('\n') || 'Пока не было'}`;
  }],
  ['bsegments', 'bc', '', 'Аудитории для рассылки', async ({ env }) => {
    const users = activeUsers(await allUsers(env)).filter((u) => !isOwner(env, u.id));
    const now = Date.now();
    return `🎯 <b>Аудитории</b>\n\n${Object.values(SEGMENTS).map(([t, f]) => `${t}: <b>${users.filter((u) => f(u, now)).length}</b>`).join('\n')}`;
  }],
  ['btest', 'bc', 'текст', 'Пробная отправка себе', async ({ env, me, arg, msg }) => {
    if (msg.reply_to_message) { await tg(env, 'copyMessage', { chat_id: me, from_chat_id: me, message_id: msg.reply_to_message.message_id }); return; }
    if (!arg) return usage('/btest <b>жирный</b> текст') + '\nили ответьте /btest на сообщение';
    const r = await send(env, me, arg);
    if (!r.ok) return `⚠️ Ошибка разметки: ${esc(r.description)}`;
  }],
  ['schedule', 'bc', 'ЧЧ:ММ|+мин текст | off', 'Отложенная рассылка всем', async ({ env, me, args, msg }) => {
    const [when, ...w] = args;
    if (!when) {
      const s = await env.DB.get('bc:sched', 'json');
      return s ? `⏰ Запланирована на ${fmtDate(s.at)}: «${esc(s.draft.text ? s.draft.text.slice(0, 80) : '[медиа]')}»\nОтменить: /schedule off` : usage('/schedule 19:30 текст') + '\nили <code>/schedule +60 текст</code> (через 60 мин)\nили ответьте <code>/schedule 19:30</code> на сообщение';
    }
    if (when === 'off') { await env.DB.delete('bc:sched'); return '🗑 Отложенная рассылка отменена'; }
    let at;
    if (/^\+\d+$/.test(when)) at = Date.now() + Number(when.slice(1)) * 60000;
    else if (/^\d{1,2}:\d{2}$/.test(when)) {
      const [H, M] = when.split(':').map(Number);
      const [h, m] = kyivHM().split(':').map(Number);
      let diff = H * 60 + M - (h * 60 + m);
      if (diff <= 0) diff += 1440;
      at = Date.now() + diff * 60000;
    } else return '⚠️ Время: <code>19:30</code> (по Киеву) или <code>+60</code>';
    const draft = msg.reply_to_message ? { copy: msg.reply_to_message.message_id } : w.length ? { text: w.join(' ') } : null;
    if (!draft) return '⚠️ Добавьте текст или ответьте командой на сообщение';
    await env.DB.put('bc:sched', JSON.stringify({ at, draft, from: me }));
    return `⏰ Рассылка всем запланирована на <b>${fmtDate(at)}</b> (по Киеву).\nОтменить: /schedule off`;
  }],

  // ---------- 📱 Приложение ----------
  ['config', 'app', '', 'Текущие настройки приложения', async ({ env }) => {
    const c = await getCfg(env);
    const b = c.banner || {}; const m = c.maintenance || {};
    return `📱 <b>Настройки приложения</b>\n\n` +
      `Название: <b>${esc(c.title || 'Калории')}</b>\nТема: ${esc(c.theme || 'ice')}\nЯзык для всех: ${c.forceLang || 'выбор пользователя'}\n\n` +
      `🛠 Тех. работы: ${yes(m.on)}\n📢 Баннер: ${yes(b.on && b.text)}${b.text ? ` (${esc(b.style || 'info')}) «${esc(b.text.slice(0, 60))}»` : ''}\n` +
      `👋 Приветствие: ${yes(c.welcome !== false)}\n💡 Советы: ${yes(c.tips !== false)}\n🏆 Достижения: ${yes(c.achievements !== false)}\n🎉 Конфетти: ${yes(c.confetti !== false)}\n📋 Копирование приёмов: ${yes(c.copyMeal !== false)}\n\n` +
      `👨‍💻 Разработчик: ${esc(c.developer || 'Danya. Vas')}\n🧪 Тестировщик: ${esc(c.tester || 'Не указано')}\n⭐ Своих продуктов: ${(c.foods || []).length}`;
  }],
  ['maintenance', 'app', 'on|off [текст]', 'Технические работы (заглушка)', async ({ env, args }) => {
    const [a, ...w] = args; const v = onOff(a);
    if (v === null && !a) { const m = (await getCfg(env)).maintenance || {}; return `🛠 Тех. работы: ${yes(m.on)}\nТекст: ${esc(m.text || '—')}\n\n${usage('/maintenance on Вернёмся в 18:00')}`; }
    const text = v === null ? args.join(' ') : w.join(' ');
    await setCfg(env, (c) => { c.maintenance = { ...(c.maintenance || {}), ...(v === null ? { on: true } : { on: v }), ...(text ? { text: text.slice(0, 300) } : {}) }; });
    return v === false ? '✅ Тех. работы выключены — приложение снова доступно' : `🛠 Тех. работы <b>включены</b>. Пользователи увидят заглушку в течение минуты.${text ? `\nТекст: ${esc(text)}` : ''}\nВыключить: /maintenance off`;
  }],
  ['banner', 'app', 'текст | off', 'Баннер вверху приложения', async ({ env, arg }) => {
    if (!arg) { const b = (await getCfg(env)).banner || {}; return `📢 Баннер: ${yes(b.on)}\n${esc(b.text || '—')}\n\n${usage('/banner Новая функция — фото еды!')}\nУбрать: /banner off`; }
    if (onOff(arg) === false) { await setCfg(env, (c) => { c.banner = { ...(c.banner || {}), on: false }; }); return '✅ Баннер скрыт'; }
    await setCfg(env, (c) => { c.banner = { style: 'info', ...(c.banner || {}), on: true, text: arg.slice(0, 200) }; });
    return `📢 Баннер включён: «${esc(arg.slice(0, 200))}»\nСтиль: /bannerstyle info|promo|warn`;
  }],
  ['bannerstyle', 'app', 'info|promo|warn', 'Цвет баннера', async ({ env, arg }) => {
    if (!['info', 'promo', 'warn'].includes(arg)) return usage('/bannerstyle promo') + '\ninfo — инфо, promo — акция, warn — важно';
    await setCfg(env, (c) => { c.banner = { ...(c.banner || {}), style: arg }; });
    return `✅ Стиль баннера: ${arg}`;
  }],
  ['title', 'app', 'название', 'Название в приложении', cfgText('title', '🏷 Название', '/title Калории')],
  ['theme', 'app', 'ice|ocean|sapphire|sky', 'Цветовая тема для всех', async ({ env, arg }) => {
    const T2 = { ice: 'Лёд', ocean: 'Океан', sapphire: 'Сапфир', sky: 'Небо' };
    if (!T2[arg]) return `🎨 Тема: <b>${esc((await getCfg(env)).theme || 'ice')}</b>\n\n${Object.entries(T2).map(([k, v]) => `<code>/theme ${k}</code> — ${v}`).join('\n')}`;
    await setCfg(env, (c) => { c.theme = arg; });
    return `🎨 Тема: ${T2[arg]}`;
  }],
  ['forcelang', 'app', 'uk|ru|en|off', 'Язык для всех принудительно', async ({ env, arg }) => {
    if (!BOT_TR[arg] && onOff(arg) !== false) return `🌐 Сейчас: <b>${(await getCfg(env)).forceLang || 'выбор пользователя'}</b>\n\n${usage('/forcelang uk')}\nОтключить: /forcelang off`;
    const v = BOT_TR[arg] ? arg : '';
    await setCfg(env, (c) => { c.forceLang = v; });
    return v ? `🌐 Язык для всех: <b>${v}</b> — и в приложении, и в боте` : '🌐 Пользователи снова выбирают язык сами';
  }],
  ['reload', 'app', '', 'Перезапустить приложение у всех', async ({ env }) => {
    await setCfg(env, (c) => { c.reloadToken = Date.now(); });
    return '🔄 Команда отправлена: у всех, у кого открыто приложение, оно перезапустится в течение минуты (и подтянет свежую версию).';
  }],
  ['welcome', 'app', 'on|off', 'Экран приветствия при входе', cfgToggle('welcome', '👋 Приветствие')],
  ['welcometext', 'app', 'текст | off', 'Свой текст приветствия', async ({ env, arg }) => {
    if (!arg) return `👋 Текст: ${esc((await getCfg(env)).welcomeText || 'стандартный')}\n${usage('/welcometext Добро пожаловать!')}`;
    const v = onOff(arg) === false ? '' : arg.slice(0, 300);
    await setCfg(env, (c) => { c.welcomeText = v; });
    return v ? '✅ Текст приветствия обновлён' : '✅ Вернули стандартный текст';
  }],
  ['tips', 'app', 'on|off', 'Подсказки «осталось N ккал»', cfgToggle('tips', '💡 Советы')],
  ['achievements', 'app', 'on|off', 'Достижения', cfgToggle('achievements', '🏆 Достижения')],
  ['confetti', 'app', 'on|off', 'Конфетти', cfgToggle('confetti', '🎉 Конфетти')],
  ['copymeal', 'app', 'on|off', 'Копирование приёмов пищи', cfgToggle('copyMeal', '📋 Копирование приёмов')],
  ['developer', 'app', 'имя', 'Имя разработчика в титрах', cfgText('developer', '👨‍💻 Разработчик', '/developer Danya. Vas')],
  ['tester', 'app', 'имя', 'Имя тестировщика в титрах', cfgText('tester', '🧪 Тестировщик', '/tester Не указано')],
  ['botlink', 'app', 'ссылка', 'Ссылка на бота/канал в приложении', cfgText('botLink', '🔗 Ссылка', '/botlink https://t.me/...')],
  ['backup', 'app', '', 'Скачать настройки файлом', async ({ env, me }) => {
    const r = await sendFile(env, me, `config_${kyivDay(Date.now())}.json`, JSON.stringify(await getCfg(env), null, 2), '💾 Резервная копия настроек. Восстановить: /restore и текст файла', 'application/json');
    if (!r.ok) return `⚠️ ${esc(r.description)}`;
  }],
  ['restore', 'app', '{json}', 'Восстановить настройки из JSON', async ({ env, arg, msg }) => {
    const src = arg || (msg.reply_to_message && msg.reply_to_message.text) || '';
    let c;
    try { c = JSON.parse(src); } catch { return usage('/restore {"title":"Калории",…}') + '\nили ответьте /restore на сообщение с JSON'; }
    if (!c || typeof c !== 'object' || Array.isArray(c)) return '⚠️ Нужен JSON-объект';
    await env.DB.put('config', JSON.stringify(c));
    return '✅ Настройки восстановлены';
  }],
  ['resetconfig', 'app', '', 'Сбросить настройки к заводским', async ({ env, me }) => {
    await send(env, me, '⚠️ Сбросить все настройки приложения (баннер, тему, свои продукты, тексты)? Сначала можно сделать /backup.', { reply_markup: confirmKb('resetconfig') });
  }],

  // ---------- 🍎 Продукты ----------
  ['foods', 'food', '', 'Свои продукты (видны всем)', async ({ env }) => {
    const f = (await getCfg(env)).foods || [];
    return `⭐ <b>Свои продукты: ${f.length}</b>\n\n${f.map((x, i) => `${i + 1}. ${esc(x.n)} — ${x.k} ккал · Б${x.p} Ж${x.f} У${x.c}`).join('\n') || '—'}\n\nДобавить: /addfood`;
  }],
  ['addfood', 'food', 'Название; ккал; б; ж; у', 'Добавить продукт для всех', async ({ env, arg }) => {
    const p = arg.split(/[;|]/).map((s) => s.trim());
    const num = (s) => Math.max(0, Math.round(Number(String(s || '0').replace(',', '.')) * 10) / 10);
    if (p.length < 2 || !p[0] || !(num(p[1]) > 0)) return usage('/addfood Сырник домашний; 220; 15; 9; 20') + '\n(значения на 100 г)';
    const f = { n: p[0].slice(0, 60), k: num(p[1]), p: num(p[2]), f: num(p[3]), c: num(p[4]) };
    const c = await setCfg(env, (x) => { x.foods = [...(x.foods || []), f].slice(-200); });
    return `✅ Добавлен «${esc(f.n)}» — ${f.k} ккал. Всего своих: ${c.foods.length}`;
  }],
  ['delfood', 'food', 'N | all', 'Удалить продукт по номеру', async ({ env, arg }) => {
    const c = await getCfg(env); const f = c.foods || [];
    if (arg === 'all') { await setCfg(env, (x) => { x.foods = []; }); return `🗑 Удалено ${f.length}`; }
    const i = parseInt(arg, 10) - 1;
    if (!(i >= 0 && i < f.length)) return usage('/delfood 3') + ' (номер из /foods)';
    const [del] = f.splice(i, 1);
    await setCfg(env, (x) => { x.foods = f; });
    return `🗑 Удалён «${esc(del.n)}»`;
  }],

  // ---------- 🤖 ИИ ----------
  ['aistatus', 'ai', '', 'Состояние ИИ и лимиты', async ({ env }) => {
    const ai = await aiSettings(env);
    return `🤖 <b>ИИ</b>\n\nПривязка Workers AI: ${env.AI ? '✅ есть' : '❌ нет'}\nСостояние: ${ai.off ? '⛔️ выключен владельцем' : '✅ работает'}\n\n<b>Лимиты в день на человека</b>\n${Object.keys(AI_LIMITS).map((k) => `${k}: ${ai.limits[k] || AI_LIMITS[k]}${ai.limits[k] ? ' (изменён)' : ''}`).join('\n')}\n\nVIP — ×3, владелец — ×5`;
  }],
  ['aion', 'ai', '', 'Включить ИИ для всех', async ({ env }) => { const ai = await aiSettings(env); ai.off = false; await admSet(env, 'ai', ai); return '✅ ИИ включён'; }],
  ['aioff', 'ai', '', 'Выключить ИИ для всех', async ({ env }) => { const ai = await aiSettings(env); ai.off = true; await admSet(env, 'ai', ai); return '⛔️ ИИ выключен: фото, голос и чат временно недоступны. Включить: /aion'; }],
  ['setlimit', 'ai', 'photo|voice|parse|chat N', 'Изменить дневной лимит', async ({ env, args }) => {
    const [k, n] = args;
    if (!AI_LIMITS[k] || !(Number(n) >= 0)) return usage('/setlimit photo 25');
    const ai = await aiSettings(env); ai.limits = { ...ai.limits, [k]: Math.min(1000, Math.round(Number(n))) }; await admSet(env, 'ai', ai);
    return `✅ Лимит ${k}: ${ai.limits[k]} в день`;
  }],
  ['resetlimits', 'ai', '', 'Вернуть стандартные лимиты', async ({ env }) => { const ai = await aiSettings(env); ai.limits = {}; await admSet(env, 'ai', ai); return `♻️ Лимиты по умолчанию: ${Object.entries(AI_LIMITS).map(([k, v]) => `${k} ${v}`).join(', ')}`; }],
  ['aitest', 'ai', 'текст', 'Проверить разбор еды ИИ', async ({ env, arg }) => {
    if (!env.AI) return '❌ Привязка AI не подключена';
    if (!arg) return usage('/aitest два яйца и кофе с молоком');
    const t = Date.now();
    const items = await parseFoodText(env, arg);
    return `🧪 «${esc(arg)}» → ${Date.now() - t} мс\n\n${items.map((x) => `• ${esc(x.name)}${x.count ? ` ×${x.count}` : ''} — ${Math.round(x.grams || 0)} г, ${x.kcal || '?'} ккал/100 г`).join('\n') || 'ничего не распознано'}`;
  }],
  ['aiask', 'ai', 'вопрос', 'Задать вопрос ИИ', async ({ env, arg }) => {
    if (!env.AI) return '❌ Привязка AI не подключена';
    if (!arg) return usage('/aiask сколько белка в твороге?');
    const out = await runText(env, [{ role: 'system', content: 'Ты нутрициолог. Отвечай кратко, по-русски.' }, { role: 'user', content: arg.slice(0, 800) }], 500);
    return `🤖 ${esc(String(out).slice(0, 3500))}`;
  }],

  // ---------- 💬 Поддержка ----------
  ['reply', 'sup', 'id текст', 'Написать пользователю', null],
  ['inbox', 'sup', '[N]', 'Последние сообщения пользователей', async ({ env, arg }) => {
    const n = Math.min(Math.max(parseInt(arg, 10) || 15, 1), 30);
    const ib = ((await env.DB.get('ib', 'json')) || []).slice(0, n);
    return `📥 <b>Входящие</b>\n\n${ib.map((x) => `${fmtDate(x.t)} · ${esc(x.n)} <code>${x.id}</code>\n   ${esc(x.txt)}`).join('\n') || 'Пусто'}`;
  }],
  ['support', 'sup', 'on|off', 'Принимать сообщения от пользователей', async ({ env, arg }) => {
    const s = await admGet(env, 'sup', {}); const v = onOff(arg);
    if (v === null) return `💬 Приём сообщений: ${yes(!s.off)}\n${usage('/support off')}`;
    s.off = !v; await admSet(env, 'sup', s);
    return `💬 Приём сообщений: ${yes(v)}`;
  }],
  ['autoreply', 'sup', 'текст | off', 'Автоответ на сообщения', async ({ env, arg }) => {
    const s = await admGet(env, 'sup', {});
    if (!arg) return `🤖 Автоответ: ${esc(s.auto || 'стандартный')}\n${usage('/autoreply Спасибо! Отвечу в течение дня')}`;
    s.auto = onOff(arg) === false ? '' : arg.slice(0, 500); await admSet(env, 'sup', s);
    return s.auto ? '✅ Автоответ установлен' : '✅ Стандартный автоответ';
  }],
  ['hello', 'sup', 'текст | off', 'Своё сообщение на /start', async ({ env, arg }) => {
    const s = await admGet(env, 'sup', {});
    if (!arg) return `👋 /start: ${esc(s.hello || 'стандартное (на языке пользователя)')}\n${usage('/hello Привет! Я помогу считать калории')}`;
    s.hello = onOff(arg) === false ? '' : arg.slice(0, 1500); await admSet(env, 'sup', s);
    return s.hello ? '✅ Приветствие обновлено' : '✅ Стандартное приветствие';
  }],
  ['helptext', 'sup', 'текст | off', 'Свой текст для /help', async ({ env, arg }) => {
    const s = await admGet(env, 'sup', {});
    if (!arg) return `ℹ️ /help: ${esc(s.help || 'стандартный')}\n${usage('/helptext Как пользоваться: …')}`;
    s.help = onOff(arg) === false ? '' : arg.slice(0, 2000); await admSet(env, 'sup', s);
    return s.help ? '✅ Текст помощи обновлён' : '✅ Стандартный текст помощи';
  }],
  ['savetpl', 'sup', 'имя текст', 'Сохранить шаблон ответа', async ({ env, args }) => {
    const [name, ...w] = args;
    if (!name || !w.length) return usage('/savetpl спасибо Спасибо за отзыв! 🙌');
    const t = await admGet(env, 'tpl', {}); t[name.toLowerCase()] = w.join(' ').slice(0, 1000); await admSet(env, 'tpl', t);
    return `✅ Шаблон «${esc(name)}» сохранён. Отправить: <code>/sendtpl id ${esc(name)}</code>`;
  }],
  ['tpls', 'sup', '', 'Шаблоны ответов', async ({ env }) => {
    const t = await admGet(env, 'tpl', {});
    return `📑 <b>Шаблоны</b>\n\n${Object.entries(t).map(([k, v]) => `<b>${esc(k)}</b> — ${esc(v.slice(0, 80))}`).join('\n') || 'Пусто. Создать: /savetpl'}`;
  }],
  ['deltpl', 'sup', 'имя', 'Удалить шаблон', async ({ env, arg }) => {
    const t = await admGet(env, 'tpl', {});
    if (!t[arg.toLowerCase()]) return '🤷 Нет такого шаблона';
    delete t[arg.toLowerCase()]; await admSet(env, 'tpl', t);
    return '🗑 Удалён';
  }],
  ['sendtpl', 'sup', 'id имя', 'Отправить шаблон пользователю', async ({ env, args }) => {
    const [id, name] = args;
    const t = await admGet(env, 'tpl', {});
    if (!isId(id) || !t[(name || '').toLowerCase()]) return usage('/sendtpl 123456789 спасибо');
    const r = await send(env, id, t[name.toLowerCase()]);
    return r.ok ? '✅ Отправлено' : `⚠️ ${esc(r.description)}`;
  }],
  ['ask', 'sup', 'id вопрос', 'Спросить пользователя (с кнопкой ответа)', async ({ env, args }) => {
    const [id, ...w] = args;
    if (!isId(id) || !w.length) return usage('/ask 123456789 Как вам приложение?');
    const L = T(await userLang(env, id));
    const r = await send(env, id, `💬 ${w.join(' ')}\n\n<i>${L === BOT_TR.en ? 'Just reply with a message' : L === BOT_TR.ru ? 'Просто ответьте сообщением' : 'Просто дайте відповідь повідомленням'}</i>`);
    return r.ok ? '✅ Вопрос отправлен — ответ придёт сюда' : `⚠️ ${esc(r.description)}`;
  }],

  // ---------- 🤖 Профиль бота ----------
  ['botinfo', 'bot', '', 'Имя, описание и ссылка бота', async ({ env }) => {
    const [me, n, d, s] = await Promise.all([tg(env, 'getMe'), tg(env, 'getMyName'), tg(env, 'getMyDescription'), tg(env, 'getMyShortDescription')]);
    return `🤖 <b>${esc(n.result && n.result.name)}</b> @${esc(me.result && me.result.username)}\nID: <code>${me.result && me.result.id}</code>\n\n<b>Описание:</b>\n${esc(d.result && d.result.description)}\n\n<b>Коротко:</b> ${esc(s.result && s.result.short_description)}`;
  }],
  ['setname', 'bot', 'имя', 'Сменить имя бота', async ({ env, arg }) => {
    if (!arg) return usage('/setname Callories Kaka');
    const r = await tg(env, 'setMyName', { name: arg.slice(0, 64) });
    return r.ok ? '✅ Имя бота изменено' : `⚠️ ${esc(r.description)}`;
  }],
  ['setdesc', 'bot', 'текст', 'Описание бота (экран «Что умеет бот»)', async ({ env, arg }) => {
    if (!arg) return usage('/setdesc 🥗 Дневник калорий…');
    const r = await tg(env, 'setMyDescription', { description: arg.slice(0, 512) });
    return r.ok ? '✅ Описание обновлено (для украинского/по умолчанию)' : `⚠️ ${esc(r.description)}`;
  }],
  ['setshort', 'bot', 'текст', 'Короткое описание (в профиле)', async ({ env, arg }) => {
    if (!arg) return usage('/setshort Дневник калорий в Telegram 🥗');
    const r = await tg(env, 'setMyShortDescription', { short_description: arg.slice(0, 120) });
    return r.ok ? '✅ Короткое описание обновлено' : `⚠️ ${esc(r.description)}`;
  }],
  ['setmenu', 'bot', 'текст', 'Надпись на кнопке меню', async ({ env, arg }) => {
    if (!arg) return usage('/setmenu Відкрити');
    const r = await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: arg.slice(0, 32), web_app: { url: appUrl(env) } } });
    return r.ok ? `✅ Кнопка меню: «${esc(arg.slice(0, 32))}»` : `⚠️ ${esc(r.description)}`;
  }],
  ['setup', 'bot', '', 'Перенастроить бота (команды, вебхук)', async ({ env }) => {
    const w = await tg(env, 'getWebhookInfo');
    const url = w.result && w.result.url;
    if (!url) return '⚠️ Вебхук не установлен — откройте /setup?secret=… в браузере';
    const res = await setup(new URL(new URL(url).origin + '/setup?secret=' + encodeURIComponent(env.WEBHOOK_SECRET || '')), env);
    return `⚙️ ${esc(await res.text())}`;
  }],

  // ---------- ⚙️ Система ----------
  ['ping', 'sys', '', 'Проверка связи и версия', async ({ env }) => {
    const t = Date.now(); await env.DB.get('config'); const kv = Date.now() - t;
    const t2 = Date.now(); await tg(env, 'getMe'); const api = Date.now() - t2;
    return `🏓 Понг! Сервер ${WORKER_VERSION}\nБаза (KV): ${kv} мс\nTelegram API: ${api} мс\nВремя (Киев): ${kyivHM()}`;
  }],
  ['health', 'sys', '', 'Полная проверка сервера', async ({ env }) => {
    const [w, me, cron, cfg, job, ai] = await Promise.all([tg(env, 'getWebhookInfo'), tg(env, 'getMe'), env.DB.get('cron:last'), getCfg(env), env.DB.get('bc:job', 'json'), aiSettings(env)]);
    const wi = w.result || {};
    const cronAge = cron ? Date.now() - Number(cron) : null;
    return `🩺 <b>Проверка</b>\n\n${me.ok ? '✅' : '❌'} Токен бота\n${env.DB ? '✅' : '❌'} База KV\n${env.AI ? '✅' : '❌'} Workers AI${ai.off ? ' (выключен командой)' : ''}\n` +
      `${wi.url ? '✅' : '❌'} Вебхук${wi.pending_update_count ? ` · в очереди ${wi.pending_update_count}` : ''}\n` +
      `${wi.last_error_message ? `⚠️ Последняя ошибка вебхука: ${esc(wi.last_error_message)} (${fmtDate(wi.last_error_date * 1000)})\n` : ''}` +
      `${cronAge !== null && cronAge < 40 * 60000 ? '✅' : '⚠️'} Cron (напоминания): ${cron ? ago(Number(cron)) : 'ещё не отмечался — проверьте Triggers → Cron'}\n` +
      `${cfg.maintenance && cfg.maintenance.on ? '🛠 Включены тех. работы\n' : ''}${job ? `📣 Идёт рассылка ${job.i}/${job.ids.length}\n` : ''}`;
  }],
  ['errors', 'sys', '[clear]', 'Ошибки из приложения (3 дня)', async ({ env, arg }) => {
    const days = [0, 1, 2].map((i) => `le:${kyivDay(Date.now() - i * DAY)}`);
    if (arg === 'clear') { for (const k of days) await env.DB.delete(k); return '🧹 Журнал очищен'; }
    const all = [];
    for (const k of days) all.push(...((await env.DB.get(k, 'json')) || []));
    all.sort((a, b) => b.t - a.t);
    return `🐞 <b>Ошибки: ${all.length}</b>\n\n${all.slice(0, 15).map((e) => `${fmtDate(e.t)}\n<code>${esc(e.m.slice(0, 200))}</code>`).join('\n\n') || 'Ошибок нет 🎉'}\n\nОчистить: /errors clear`;
  }],
  ['kv', 'sys', '', 'Что хранится в базе', async ({ env }) => {
    const keys = await listKeys(env, '', 5);
    const c = {};
    for (const k of keys) { const p = k.name.includes(':') ? k.name.split(':')[0] : k.name; c[p] = (c[p] || 0) + 1; }
    const names = { u: 'пользователи', sm: 'итоги дня', rs: 'настройки напоминаний', rm: 'слоты напоминаний', q: 'лимиты ИИ', ch: 'челленджи', uc: 'мои челленджи', rc: 'счётчики приглашений', nt: 'заметки', us: 'статистика функций', le: 'журнал ошибок', r: 'связи ответов', pv: 'еда из чата', fs: 'голодание', ro: 'разовые напоминания', adm: 'настройки админа', bc: 'рассылки' };
    return `🗄 <b>База: ${keys.length}${keys.length >= 5000 ? '+' : ''} ключей</b>\n\n${Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} — ${v}${names[k] ? ` (${names[k]})` : ''}`).join('\n')}`;
  }],
  ['cron', 'sys', '', 'Когда последний раз работал cron', async ({ env }) => {
    const c = await env.DB.get('cron:last');
    return c ? `⏱ Cron работал ${ago(Number(c))} (${fmtDate(Number(c))}). Отметка ставится раз в 30 мин.` : '⚠️ Cron ещё не отмечался. Проверьте Cloudflare → Worker → Settings → Triggers → Cron <code>* * * * *</code>';
  }],
  ['reminders', 'sys', '', 'Сколько людей с напоминаниями', async ({ env }) => {
    const [rs, rm, fs] = await Promise.all([listKeys(env, 'rs:'), listKeys(env, 'rm:'), listKeys(env, 'fs:')]);
    return `🔔 <b>Напоминания</b>\n\nПользователей с напоминаниями: <b>${rs.length}</b>\nЗанятых минут в расписании: ${rm.length}\n⏳ Сейчас голодают: ${fs.length}`;
  }],
  ['challenges', 'sys', '', 'Активные челленджи', async ({ env }) => {
    const keys = await listKeys(env, 'ch:');
    const rows = [];
    for (const k of keys.slice(0, 20)) { const c = await env.DB.get(k.name, 'json'); if (c) rows.push(`${esc(c.title)} · ${c.days} дн · с ${c.start} · 👥 ${Object.keys(c.members || {}).length}`); }
    return `🏁 <b>Челленджи: ${keys.length}</b>\n\n${rows.join('\n') || '—'}`;
  }],
];
const WORKER_VERSION = '6.0';
const ADMIN_MAP = Object.fromEntries(ADMIN_CMDS.map(([c, g, a, d, fn]) => [c, { c, g, a, d, fn }]));

function adminHome(env) {
  const counts = {};
  for (const [, g] of ADMIN_CMDS) counts[g] = (counts[g] || 0) + 1;
  const keys = Object.keys(ADM_GROUPS);
  const rows = [];
  for (let i = 0; i < keys.length; i += 2) rows.push(keys.slice(i, i + 2).map((g) => ({ text: `${ADM_GROUPS[g]} · ${counts[g] || 0}`, callback_data: 'adm:' + g })));
  rows.push([{ text: '📜 Все команды списком', callback_data: 'adm:all' }]);
  rows.push([{ text: '🥗 Открыть приложение', web_app: { url: appUrl(env) } }]);
  return {
    text: `🛠 <b>Панель владельца</b>\n\nКоманд: <b>${ADMIN_CMDS.length}</b>. Выберите раздел — покажу команды с подсказками.\n\n` +
      `Быстро: /stats · /today · /health · /inbox\n💬 Сообщения пользователей приходят сюда — отвечайте на них реплаем.`,
    kb: { inline_keyboard: rows },
  };
}
function adminGroupText(g) {
  const list = ADMIN_CMDS.filter((x) => x[1] === g);
  return `${ADM_GROUPS[g]}\n\n${list.map(([c, , a, d]) => `/${c}${a ? ` <i>${esc(a)}</i>` : ''}\n   ${esc(d)}`).join('\n')}`;
}

async function adminCommand(env, msg, cmd, arg) {
  const ent = ADMIN_MAP[cmd.slice(1)];
  if (!ent || !ent.fn) return false;
  const me = msg.chat.id;
  try {
    const out = await ent.fn({ env, me, arg, args: arg.split(/\s+/).filter(Boolean), msg });
    if (out) await sendLong(env, me, out);
  } catch (e) {
    console.log('admin cmd error', cmd, e && e.stack);
    await send(env, me, `⚠️ Ошибка в ${esc(cmd)}: ${esc(e && e.message)}`);
  }
  return true;
}

async function adminCallback(q, env) {
  const me = q.from.id;
  const edit = (text, kb) => tg(env, 'editMessageText', { chat_id: me, message_id: q.message.message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}) });
  const [kind, a, p] = q.data.split(':');
  if (kind === 'adm') {
    if (a === 'home') { const h = adminHome(env); await edit(h.text, h.kb); }
    else if (a === 'all') { await sendLong(env, me, Object.keys(ADM_GROUPS).map(adminGroupText).join('\n\n')); }
    else if (ADM_GROUPS[a]) await edit(adminGroupText(a), { inline_keyboard: [[{ text: '‹ Назад к разделам', callback_data: 'adm:home' }]] });
  } else if (kind === 'cf') {
    if (a === 'no') await edit('✖️ Отменено');
    else if (a === 'resetconfig') { await env.DB.delete('config'); await edit('♻️ Настройки сброшены к заводским'); }
    else if (a === 'forget' && isId(p)) {
      await Promise.all([`u:${p}`, `nt:${p}`, `sm:${p}`, `rc:${p}`, `uc:${p}`].map((k) => env.DB.delete(k)));
      await edit(`🗑 Пользователь <code>${p}</code> удалён из базы бота`);
    }
  }
  return tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
}
