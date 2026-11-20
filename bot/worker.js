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
const fmtDate = (ts) => new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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
    await send(env, from.id, L.hello(esc(from.first_name || '')), { reply_markup: openAppKeyboard(env, L.open) });
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
    await send(env, from.id, L.help, { reply_markup: openAppKeyboard(env, L.open) });
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
  await touchUser(env, from);
  if (!env.OWNER_ID) return;
  const fwd = await tg(env, 'forwardMessage', { chat_id: env.OWNER_ID, from_chat_id: from.id, message_id: msg.message_id });
  const info = await send(env, env.OWNER_ID,
    `💬 Сообщение от ${userLabel({ n: [from.first_name, from.last_name].filter(Boolean).join(' '), u: from.username })} (<code>${from.id}</code>)\n` +
    `Ответьте <b>реплаем</b> на это или пересланное сообщение — ответ уйдёт пользователю.`);
  const ttl = { expirationTtl: 60 * 60 * 24 * 30 };
  if (fwd.ok) await env.DB.put(`r:${fwd.result.message_id}`, String(from.id), ttl);
  if (info.ok) await env.DB.put(`r:${info.result.message_id}`, String(from.id), ttl);
  await send(env, from.id, T(await userLang(env, from.id, from)).sent);
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

  switch (cmd) {
    case '/admin':
    case '/commands':
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
      const total = (await allUsers(env)).filter((u) => !u.m.b && !isOwner(env, u.id)).length;
      await send(env, me, '👇 Так увидят сообщение пользователи:');
      if (draft.text) await send(env, me, draft.text);
      else await tg(env, 'copyMessage', { chat_id: me, from_chat_id: me, message_id: draft.copy });
      const users = (await allUsers(env)).filter((u) => !u.m.b && !isOwner(env, u.id));
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
      const ids = (await allUsers(env)).filter((u) => !u.m.b && !isOwner(env, u.id) && seg[1](u, now)).map((u) => u.id);
      await env.DB.put('bc:job', JSON.stringify({ draft, from: me, ids, i: 0, ok: 0, fail: 0 }));
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
    commands: [
      { command: 'admin', description: '🛠 Все команды владельца' },
      { command: 'stats', description: '📊 Статистика' },
      { command: 'users', description: '👥 Пользователи' },
      { command: 'broadcast', description: '📣 Рассылка' },
      { command: 'reply', description: '💬 Написать пользователю' },
      { command: 'cancel', description: '⏹ Остановить рассылку' },
      { command: 'start', description: 'Открыть дневник' },
    ],
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
  return { body, user };
}

// ---------- Дневные лимиты ИИ на пользователя (чтобы не выйти за бесплатную квоту) ----------
const AI_LIMITS = { photo: 15, chat: 40, parse: 60, voice: 30 };
async function takeQuota(env, uid, kind) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const key = `q:${uid}:${day}`;
  const q = (await env.DB.get(key, 'json')) || {};
  const limit = isOwner(env, uid) ? AI_LIMITS[kind] * 5 : AI_LIMITS[kind];
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
  if (!(await takeQuota(env, user.id, 'photo'))) return json({ ok: false, error: `Лимит распознаваний на сегодня исчерпан (${AI_LIMITS.photo}). Попробуйте завтра.` }, 429);
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
  if (!(await takeQuota(env, user.id, 'parse'))) return json({ ok: false, error: 'Лимит на сегодня исчерпан' }, 429);
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
  if (!(await takeQuota(env, user.id, 'voice'))) return json({ ok: false, error: 'Лимит на сегодня исчерпан' }, 429);
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
  if (!(await takeQuota(env, user.id, 'chat'))) return json({ ok: false, error: `Лимит сообщений на сегодня исчерпан (${AI_LIMITS.chat}). Возвращайтесь завтра!` }, 429);
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
async function apiLog(req) {
  try {
    const t = (await req.text()).slice(0, 2000);
    console.log('client error', t);
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
