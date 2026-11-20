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
 * Триггер (Triggers → Cron): "* * * * *" — нужен для рассылки.
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
    ctx.waitUntil(processBroadcast(env).catch((e) => console.log('broadcast error', e && e.stack)));
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

function openAppKeyboard(env, text = '🥗 Открыть дневник') {
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
    await send(env, from.id,
      `👋 Привет, <b>${esc(from.first_name || '')}</b>!\n\n` +
      `Я помогу считать калории, белки, жиры и углеводы.\n\n` +
      `🥗 Дневник питания по приёмам пищи\n💧 Учёт воды\n⚖️ График веса\n📊 История и статистика\n\n` +
      `Нажмите кнопку ниже, чтобы открыть дневник. Ваши записи видны только вам.`,
      { reply_markup: openAppKeyboard(env) });
    if (res && res.isNew && env.OWNER_ID && !isOwner(env, from.id)) {
      await send(env, env.OWNER_ID, `🆕 Новый пользователь: ${userLabel(res.m)} (<code>${from.id}</code>)`);
    }
    return;
  }

  if (cmd === '/help') {
    await send(env, from.id,
      `ℹ️ <b>Как пользоваться</b>\n\n` +
      `1. Откройте дневник кнопкой ниже или кнопкой «Открыть» слева от поля ввода.\n` +
      `2. При первом запуске заполните анкету — приложение посчитает вашу норму.\n` +
      `3. Добавляйте еду в завтрак, обед, ужин и перекусы.\n\n` +
      `Есть вопрос или идея? Просто напишите сюда сообщение — его прочитает автор.`,
      { reply_markup: openAppKeyboard(env) });
    return;
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
  await send(env, from.id, '✉️ Сообщение передано автору. Ответ придёт сюда.');
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
        `🚫 Заблокировали бота: <b>${c((u) => u.m.b)}</b>` +
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
      await send(env, me, `Отправить <b>${total}</b> пользователям?`, {
        reply_markup: { inline_keyboard: [[{ text: '✅ Отправить', callback_data: 'bc:go' }, { text: '✖️ Отмена', callback_data: 'bc:no' }]] },
      });
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
  } else if (q.data === 'bc:go') {
    const draft = await env.DB.get('bc:draft', 'json');
    if (!draft) {
      await edit('⌛ Черновик устарел — отправьте /broadcast заново');
    } else if (await env.DB.get('bc:job')) {
      await edit('⏳ Уже идёт рассылка');
    } else {
      const ids = (await allUsers(env)).filter((u) => !u.m.b && !isOwner(env, u.id)).map((u) => u.id);
      await env.DB.put('bc:job', JSON.stringify({ draft, from: me, ids, i: 0, ok: 0, fail: 0 }));
      await env.DB.delete('bc:draft');
      await edit(`🚀 Рассылка запущена: ${ids.length} получателей. По ${BATCH} сообщений в минуту — пришлю отчёт.`);
      await processBroadcast(env);
    }
  }
  return tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
}

// ---------------- Рассылка (порциями по cron) ----------------
async function processBroadcast(env) {
  const job = await env.DB.get('bc:job', 'json');
  if (!job) return;
  const part = job.ids.slice(job.i, job.i + BATCH);
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
    commands: [{ command: 'start', description: 'Открыть дневник' }, { command: 'help', description: 'Помощь' }],
  });
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
    menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: appUrl(env) } },
  });
  results.description = await tg(env, 'setMyDescription', {
    description: '🥗 Дневник калорий прямо в Telegram.\n\nСчитайте калории и БЖУ, воду и вес. Норма рассчитывается автоматически. Бесплатно и без рекламы.',
  });
  results.shortDescription = await tg(env, 'setMyShortDescription', {
    short_description: 'Дневник калорий и БЖУ в Telegram 🥗',
  });
  const ok = Object.values(results).every((r) => r.ok);
  const lines = Object.entries(results).map(([k, r]) => `${r.ok ? '✅' : '❌'} ${k}${r.ok ? '' : ': ' + r.description}`);
  return new Response(`${ok ? 'Готово! Бот настроен.' : 'Есть ошибки:'}\n\n${lines.join('\n')}`, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
