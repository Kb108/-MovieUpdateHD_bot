// ============================================================
// MOVIE UPDATE HD - TELEGRAM MOVIE FILTER BOT
// Cloudflare Workers + D1
// ============================================================

// ========================= CONFIG ============================

const BOT_NAME = "Movie Update HD";

const SHOP_URL = "https://t.me/loot_dells";
const OWNER_URL = "https://t.me/share_kb";
const MOVIE_GROUP_URL = "https://t.me/MovieUpdateHD";

const DELETE_AFTER = 300; // 5 minutes

// ============================================================
// CLOUDFLARE ENTRY
// ============================================================

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // --------------------------------------------------------
      // HEALTH
      // --------------------------------------------------------

      if (request.method === "GET" && path === "/") {
        return json({
          ok: true,
          bot: BOT_NAME,
          status: "running",
          time: new Date().toISOString()
        });
      }

      if (request.method === "GET" && path === "/health") {
        return json({
          ok: true,
          status: "healthy"
        });
      }

      // --------------------------------------------------------
      // WEBHOOK INFO
      // IMPORTANT: No D1 required here
      // --------------------------------------------------------

      if (request.method === "GET" && path === "/webhook-info") {
        return await webhookInfo(env);
      }

      // --------------------------------------------------------
      // SET WEBHOOK
      // IMPORTANT: No D1 required here
      // --------------------------------------------------------

      if (request.method === "GET" && path === "/setwebhook") {
        return await setWebhook(request, env);
      }

      // --------------------------------------------------------
      // TELEGRAM WEBHOOK
      // --------------------------------------------------------

      if (request.method === "POST" && path === "/webhook") {
        return await handleWebhook(request, env, ctx);
      }

      // --------------------------------------------------------
      // PYROGRAM INDEXER API
      // --------------------------------------------------------

      if (request.method === "POST" && path === "/index") {
        return await indexAPI(request, env);
      }

      if (request.method === "GET" && path === "/index-job") {
        return await getIndexJob(request, env);
      }

      if (request.method === "POST" && path === "/index-job/update") {
        return await updateIndexJob(request, env);
      }

      if (request.method === "GET" && path === "/index-status") {
        return await indexStatus(request, env);
      }

      return text("Not Found", 404);

    } catch (error) {
      console.error("FETCH ERROR:", error);

      return json({
        ok: false,
        error: error?.message || String(error)
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      cleanup(env).catch(error => {
        console.error("CLEANUP ERROR:", error);
      })
    );
  }
};


// ============================================================
// BASIC RESPONSE HELPERS
// ============================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type": "application/json; charset=UTF-8"
      }
    }
  );
}

function text(data, status = 200) {
  return new Response(data, {
    status,
    headers: {
      "content-type": "text/plain; charset=UTF-8"
    }
  });
}


// ============================================================
// TELEGRAM API
// ============================================================

async function telegram(env, method, payload = {}) {
  if (!env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN secret is missing");
  }

  const url =
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!data.ok) {
    console.error("TELEGRAM ERROR:", method, data);
  }

  return data;
}


// ============================================================
// WEBHOOK
// ============================================================

async function setWebhook(request, env) {
  const webhookURL =
    new URL("/webhook", request.url).toString();

  const result = await telegram(env, "setWebhook", {
    url: webhookURL,
    allowed_updates: [
      "message",
      "channel_post",
      "callback_query",
      "inline_query"
    ],
    drop_pending_updates: false
  });

  return json({
    webhook_url: webhookURL,
    telegram: result
  });
}


async function webhookInfo(env) {
  const result = await telegram(env, "getWebhookInfo");

  return json(result);
}


// ============================================================
// WEBHOOK HANDLER
// ============================================================

async function handleWebhook(request, env, ctx) {
  let update;

  try {
    update = await request.json();
  } catch {
    return json({
      ok: false,
      error: "Invalid JSON"
    }, 400);
  }

  // Always acknowledge Telegram quickly.
  ctx.waitUntil(
    processUpdate(update, env).catch(error => {
      console.error("UPDATE ERROR:", error);
    })
  );

  return json({
    ok: true
  });
}


// ============================================================
// UPDATE PROCESSOR
// ============================================================

async function processUpdate(update, env) {
  await ensureSchema(env);

  // ----------------------------------------------------------
  // NORMAL MESSAGE
  // ----------------------------------------------------------

  if (update.message) {
    await handleMessage(update.message, env);
    return;
  }

  // ----------------------------------------------------------
  // CHANNEL POST
  // ----------------------------------------------------------

  if (update.channel_post) {
    await handleChannelPost(update.channel_post, env);
    return;
  }

  // ----------------------------------------------------------
  // CALLBACK
  // ----------------------------------------------------------

  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }

  // ----------------------------------------------------------
  // INLINE QUERY
  // ----------------------------------------------------------

  if (update.inline_query) {
    await handleInlineQuery(update.inline_query, env);
    return;
  }
}


// ============================================================
// DATABASE SCHEMA
// ============================================================

async function ensureSchema(env) {
  if (!env.DB) {
    throw new Error("D1 binding DB is missing");
  }

  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS movies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        language TEXT DEFAULT '',
        quality TEXT DEFAULT '',
        size TEXT DEFAULT '',
        poster TEXT DEFAULT '',
        channel_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        source_username TEXT DEFAULT '',
        created_at INTEGER DEFAULT (unixepoch())
      )
    `),

    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_movies_title
      ON movies(title)
    `),

    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_movies_channel
      ON movies(channel_id)
    `),

    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_movies_channel_title
      ON movies(channel_id, title)
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE NOT NULL,
        username TEXT DEFAULT '',
        first_name TEXT DEFAULT '',
        created_at INTEGER DEFAULT (unixepoch())
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS group_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT UNIQUE NOT NULL,
        chat_title TEXT DEFAULT '',
        source_channel_id TEXT NOT NULL,
        source_username TEXT DEFAULT '',
        source_title TEXT DEFAULT '',
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      )
    `),

    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_group_sources_chat
      ON group_sources(chat_id)
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS index_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        source_channel_id TEXT NOT NULL,
        source_username TEXT DEFAULT '',
        source_title TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        total_indexed INTEGER DEFAULT 0,
        last_message_id INTEGER DEFAULT 0,
        error TEXT DEFAULT '',
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS delete_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        delete_at INTEGER NOT NULL
      )
    `)
  ]);
}


// ============================================================
// USER SAVE
// ============================================================

async function saveUser(message, env) {
  const user = message.from;

  if (!user) return;

  await env.DB.prepare(`
    INSERT INTO users
    (telegram_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id)
    DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `)
    .bind(
      String(user.id),
      user.username || "",
      user.first_name || ""
    )
    .run();
}


// ============================================================
// MESSAGE HANDLER
// ============================================================

async function handleMessage(message, env) {
  await saveUser(message, env);

  const chat = message.chat;

  // ----------------------------------------------------------
  // PRIVATE CHAT
  // ----------------------------------------------------------

  if (chat.type === "private") {
    await handlePrivateMessage(message, env);
    return;
  }

  // ----------------------------------------------------------
  // GROUP / SUPERGROUP
  // ----------------------------------------------------------

  if (
    chat.type === "group" ||
    chat.type === "supergroup"
  ) {
    await handleGroupMessage(message, env);
    return;
  }
}


// ============================================================
// PRIVATE MESSAGE
// ============================================================

async function handlePrivateMessage(message, env) {
  const textValue = message.text || "";

  // ----------------------------------------------------------
  // START
  // ----------------------------------------------------------

  if (textValue.startsWith("/start")) {
    const parameter =
      textValue.split(" ")[1] || "";

    if (parameter.startsWith("movie_")) {
      const movieId =
        Number(parameter.replace("movie_", ""));

      if (movieId) {
        await deliverMovieFromDeepLink(
          message,
          movieId,
          env
        );
        return;
      }
    }

    await sendStart(message.chat.id, env);
    return;
  }

  // ----------------------------------------------------------
  // HELP
  // ----------------------------------------------------------

  if (textValue === "/help") {
    await sendHelp(message.chat.id, env);
    return;
  }

  // ----------------------------------------------------------
  // ABOUT
  // ----------------------------------------------------------

  if (textValue === "/about") {
    await sendAbout(message.chat.id, env);
    return;
  }

  // ----------------------------------------------------------
  // SOURCE
  // ----------------------------------------------------------

  if (
    textValue === "/source" ||
    textValue === "/mysource"
  ) {
    await sendSource(message.chat.id, env);
    return;
  }

  // ----------------------------------------------------------
  // REMOVE SOURCE
  // ----------------------------------------------------------

  if (textValue === "/removesource") {
    await removeSource(message.chat.id, env);
    return;
  }

  // ----------------------------------------------------------
  // SET SOURCE
  // ----------------------------------------------------------

  if (textValue.startsWith("/setsource")) {
    await setSourceCommand(
      message,
      textValue,
      env
    );
    return;
  }

  // ----------------------------------------------------------
  // NORMAL PRIVATE SEARCH
  // ----------------------------------------------------------

  if (textValue.trim()) {
    await sendText(
      message.chat.id,
      `<b>🔎 SEARCH</b>\n\n<b>Please search movies from your group.</b>`,
      env
    );
  }
}


// ============================================================
// GROUP MESSAGE
// ============================================================

async function handleGroupMessage(message, env) {
  const textValue =
    (message.text || "").trim();

  if (!textValue) return;

  // ----------------------------------------------------------
  // START
  // ----------------------------------------------------------

  if (textValue.startsWith("/start")) {
    await sendStart(message.chat.id, env);
    return;
  }

  // ----------------------------------------------------------
  // COMMANDS
  // ----------------------------------------------------------

  if (textValue === "/help") {
    await sendHelp(message.chat.id, env);
    return;
  }

  if (textValue === "/about") {
    await sendAbout(message.chat.id, env);
    return;
  }

  if (
    textValue === "/source" ||
    textValue === "/mysource"
  ) {
    await sendSource(message.chat.id, env);
    return;
  }

  if (textValue === "/removesource") {
    await removeSource(message.chat.id, env);
    return;
  }

  if (textValue.startsWith("/setsource")) {
    await setSourceCommand(
      message,
      textValue,
      env
    );
    return;
  }

  // ----------------------------------------------------------
  // IGNORE OTHER COMMANDS
  // ----------------------------------------------------------

  if (textValue.startsWith("/")) {
    return;
  }

  // ----------------------------------------------------------
  // SEARCH
  // ----------------------------------------------------------

  await searchMovies(
    message.chat.id,
    textValue,
    env
  );
}


// ============================================================
// START MENU
// ============================================================

async function sendStart(chatId, env) {
  const me = await telegram(env, "getMe");

  const username =
    me?.result?.username || "";

  const addGroupURL =
    `https://t.me/${username}?startgroup=true`;

  const textValue = `
<b>🎬 MOVIE UPDATE HD</b>

<b>Your Movie Search Bot</b>

<b>➕ Add me to your group and set your own source channel.</b>

<b>🔎 Search movies directly inside your group.</b>
`;

  const keyboard = [
    [
      {
        text: "➕ ADD YOUR GROUP",
        url: addGroupURL
      }
    ],
    [
      {
        text: "📢 SOURCE",
        callback_data: "source"
      },
      {
        text: "⚙️ SET SOURCE",
        callback_data: "setsource_help"
      }
    ],
    [
      {
        text: "❓ HELP",
        callback_data: "help"
      },
      {
        text: "✨ ABOUT",
        callback_data: "about"
      }
    ],
    [
      {
        text: "🛍️ SHOPPING OFFERS",
        url: SHOP_URL
      }
    ],
    [
      {
        text: "👑 OWNER",
        url: OWNER_URL
      }
    ]
  ];

  const result = await telegram(env, "sendMessage", {
    chat_id: chatId,
    text: textValue,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: keyboard
    }
  });

  if (result?.result?.message_id) {
    await queueDelete(
      chatId,
      result.result.message_id,
      env
    );
  }
}


// ============================================================
// HELP
// ============================================================

async function sendHelp(chatId, env) {
  const textValue = `
<b>❓ MOVIE UPDATE HD - HELP</b>

<b>1️⃣ Add the bot to your group.</b>

<b>2️⃣ Make the bot an admin.</b>

<b>3️⃣ Set your source channel:</b>
<code>/setsource @YourChannel</code>

<b>4️⃣ Members can simply type a movie name in the group.</b>

<b>5️⃣ The bot will search movies from that group's source.</b>

<b>6️⃣ Click a result to receive the movie privately.</b>

<b>Useful commands:</b>

<b>/setsource @channel</b>
<b>/source</b>
<b>/removesource</b>
<b>/help</b>
`;

  await sendText(
    chatId,
    textValue,
    env
  );
}


// ============================================================
// ABOUT
// ============================================================

async function sendAbout(chatId, env) {
  const textValue = `
<b>✨ ABOUT MOVIE UPDATE HD</b>

<b>Movie Update HD is a Telegram movie search system.</b>

<b>Each group can use its own source channel.</b>

<b>Search → Select → Private Delivery</b>

<b>Powered by Movie Update HD</b>
`;

  await sendText(
    chatId,
    textValue,
    env
  );
}


// ============================================================
// SEND SOURCE
// ============================================================

async function sendSource(chatId, env) {
  const row =
    await env.DB.prepare(`
      SELECT *
      FROM group_sources
      WHERE chat_id = ?
      LIMIT 1
    `)
      .bind(String(chatId))
      .first();

  if (!row) {
    await sendText(
      chatId,
      `<b>📢 SOURCE</b>\n\n<b>No source channel is configured for this group.</b>\n\n<b>Use:</b>\n<code>/setsource @YourChannel</code>`,
      env
    );

    return;
  }

  const count =
    await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM movies
      WHERE channel_id = ?
    `)
      .bind(String(row.source_channel_id))
      .first();

  const total =
    Number(count?.total || 0);

  const textValue = `
<b>📢 CURRENT SOURCE</b>

<b>Channel:</b> ${escapeHTML(
    row.source_username
      ? "@" + row.source_username
      : row.source_title || "Private Channel"
  )}

<b>Movies Indexed:</b> ${total}

<b>To change source:</b>
<code>/setsource @YourChannel</code>
`;

  await sendText(
    chatId,
    textValue,
    env
  );
}


// ============================================================
// REMOVE SOURCE
// ============================================================

async function removeSource(chatId, env) {
  await env.DB.prepare(`
    DELETE FROM group_sources
    WHERE chat_id = ?
  `)
    .bind(String(chatId))
    .run();

  await sendText(
    chatId,
    `<b>✅ SOURCE REMOVED</b>\n\n<b>This group no longer has a source channel configured.</b>`,
    env
  );
}


// ============================================================
// SET SOURCE
// ============================================================

async function setSourceCommand(
  message,
  textValue,
  env
) {
  const chat = message.chat;

  // Only group admins can set source
  if (
    chat.type !== "group" &&
    chat.type !== "supergroup"
  ) {
    await sendText(
      message.chat.id,
      `<b>⚠️ This command must be used inside a group.</b>`,
      env
    );

    return;
  }

  const admin =
    await telegram(env, "getChatMember", {
      chat_id: chat.id,
      user_id: message.from.id
    });

  const status =
    admin?.result?.status;

  if (
    status !== "administrator" &&
    status !== "creator"
  ) {
    await sendText(
      chat.id,
      `<b>⚠️ Only group administrators can set the source channel.</b>`,
      env
    );

    return;
  }

  const parts =
    textValue.split(/\s+/);

  if (!parts[1]) {
    await sendText(
      chat.id,
      `<b>⚙️ SET SOURCE</b>\n\n<b>Usage:</b>\n<code>/setsource @YourChannel</code>`,
      env
    );

    return;
  }

  let sourceInput =
    parts[1].trim();

  sourceInput =
    sourceInput.replace(/^https?:\/\/t\.me\//i, "");

  if (sourceInput.startsWith("@")) {
    sourceInput =
      sourceInput.substring(1);
  }

  // Telegram getChat
  const source =
    await telegram(env, "getChat", {
      chat_id: "@" + sourceInput
    });

  if (!source?.ok) {
    await sendText(
      chat.id,
      `<b>❌ SOURCE NOT FOUND</b>\n\n<b>Make sure the channel username is correct and the bot is added as an administrator of the source channel.</b>`,
      env
    );

    return;
  }

  const sourceChat =
    source.result;

  if (
    sourceChat.type !== "channel"
  ) {
    await sendText(
      chat.id,
      `<b>❌ INVALID SOURCE</b>\n\n<b>Please provide a Telegram channel.</b>`,
      env
    );

    return;
  }

  // Check bot admin
  const botInfo =
    await telegram(env, "getMe");

  const botId =
    botInfo?.result?.id;

  const member =
    await telegram(env, "getChatMember", {
      chat_id: sourceChat.id,
      user_id: botId
    });

  if (
    !member?.ok ||
    ![
      "administrator",
      "creator"
    ].includes(member?.result?.status)
  ) {
    await sendText(
      chat.id,
      `<b>❌ BOT IS NOT ADMIN</b>\n\n<b>Please add Movie Update HD as an administrator in the source channel.</b>`,
      env
    );

    return;
  }

  const sourceUsername =
    sourceChat.username || "";

  const sourceTitle =
    sourceChat.title || "";

  const sourceChannelId =
    String(sourceChat.id);

  // Save group source
  await env.DB.prepare(`
    INSERT INTO group_sources
    (
      chat_id,
      chat_title,
      source_channel_id,
      source_username,
      source_title,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, unixepoch())

    ON CONFLICT(chat_id)
    DO UPDATE SET
      chat_title = excluded.chat_title,
      source_channel_id = excluded.source_channel_id,
      source_username = excluded.source_username,
      source_title = excluded.source_title,
      updated_at = unixepoch()
  `)
    .bind(
      String(chat.id),
      chat.title || "",
      sourceChannelId,
      sourceUsername,
      sourceTitle
    )
    .run();

  // Check if already indexed
  const movieCount =
    await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM movies
      WHERE channel_id = ?
    `)
      .bind(sourceChannelId)
      .first();

  const total =
    Number(movieCount?.total || 0);

  if (total > 0) {
    await sendText(
      chat.id,
      `
<b>✅ SOURCE SET SUCCESSFULLY</b>

<b>Source:</b> ${
        sourceUsername
          ? "@" + escapeHTML(sourceUsername)
          : escapeHTML(sourceTitle)
      }

<b>Indexed Movies:</b> ${total}

<b>🔎 Members can now search movies in this group.</b>
`,
      env
    );

    return;
  }

  // Existing job?
  const existingJob =
    await env.DB.prepare(`
      SELECT *
      FROM index_jobs
      WHERE source_channel_id = ?
      AND status IN ('pending', 'running')
      ORDER BY id DESC
      LIMIT 1
    `)
      .bind(sourceChannelId)
      .first();

  if (!existingJob) {
    await env.DB.prepare(`
      INSERT INTO index_jobs
      (
        chat_id,
        source_channel_id,
        source_username,
        source_title,
        status
      )
      VALUES (?, ?, ?, ?, 'pending')
    `)
      .bind(
        String(chat.id),
        sourceChannelId,
        sourceUsername,
        sourceTitle
      )
      .run();
  }

  await sendText(
    chat.id,
    `
<b>✅ SOURCE SET SUCCESSFULLY</b>

<b>Source:</b> ${
      sourceUsername
        ? "@" + escapeHTML(sourceUsername)
        : escapeHTML(sourceTitle)
    }

<b>⏳ SOURCE INDEXING HAS BEEN QUEUED</b>

<b>The system will automatically index the existing source history.</b>

<b>🔎 New posts will be indexed automatically.</b>
`,
    env
  );
}


// ============================================================
// SEARCH MOVIES
// ============================================================

async function searchMovies(
  chatId,
  query,
  env
) {
  const source =
    await env.DB.prepare(`
      SELECT *
      FROM group_sources
      WHERE chat_id = ?
      LIMIT 1
    `)
      .bind(String(chatId))
      .first();

  if (!source) {
    const result =
      await sendTempMessage(
        chatId,
        `
<b>⚠️ NO SOURCE CONFIGURED</b>

<b>This group does not have a source channel yet.</b>

<b>Group admins can use:</b>
<code>/setsource @YourChannel</code>
`,
        env,
        true
      );

    return;
  }

  const cleanQuery =
    query.trim();

  if (!cleanQuery) return;

  const like =
    `%${cleanQuery}%`;

  const result =
    await env.DB.prepare(`
      SELECT *
      FROM movies
      WHERE channel_id = ?
      AND title LIKE ? COLLATE NOCASE
      ORDER BY
        CASE
          WHEN title = ? COLLATE NOCASE THEN 0
          WHEN title LIKE ? COLLATE NOCASE THEN 1
          ELSE 2
        END,
        id DESC
      LIMIT 20
    `)
      .bind(
        String(source.source_channel_id),
        like,
        cleanQuery,
        cleanQuery + "%"
      )
      .all();

  const movies =
    result?.results || [];

  if (!movies.length) {
    await sendTempMessage(
      chatId,
      `
<b>🔎 SEARCH RESULTS</b>

<b>🔎 ${escapeHTML(cleanQuery)}</b>

<b>❌ No movie found.</b>

<b>Try another movie name.</b>
`,
      env,
      true
    );

    return;
  }

  let textValue = `
<b>🎬 SEARCH RESULTS</b>

<b>🔎 ${escapeHTML(cleanQuery)}</b>

<b>📌 Found ${movies.length} result(s)</b>

<b>🛍️ AMAZON &amp; FLIPKART OFFERS</b>

<b>👇 Select a movie below:</b>

<b>⏱️ This message will be deleted automatically after 5 minutes.</b>
`;

  const buttons = [];

  // Shopping button FIRST
  buttons.push([
    {
      text: "🔗 CLICK HERE",
      url: SHOP_URL
    }
  ]);

  for (const movie of movies) {
    buttons.push([
      {
        text: `🎬 ${truncate(movie.title, 60)}`,
        url: await movieDeepLink(
          movie.id,
          env
        )
      }
    ]);
  }

  const sent =
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: textValue,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: buttons
      }
    });

  if (sent?.result?.message_id) {
    await queueDelete(
      chatId,
      sent.result.message_id,
      env
    );
  }
}


// ============================================================
// MOVIE DEEP LINK
// ============================================================

async function movieDeepLink(
  movieId,
  env
) {
  const me =
    await telegram(env, "getMe");

  const username =
    me?.result?.username;

  if (!username) {
    throw new Error(
      "Bot username unavailable"
    );
  }

  return `https://t.me/${username}?start=movie_${movieId}`;
}


// ============================================================
// DELIVER MOVIE PRIVATELY
// ============================================================

async function deliverMovieFromDeepLink(
  message,
  movieId,
  env
) {
  const chatId =
    message.chat.id;

  // ----------------------------------------------------------
  // JOIN CHECK
  // ----------------------------------------------------------

  const joined =
    await checkJoin(
      chatId,
      env
    );

  if (!joined) {
    const sent =
      await telegram(env, "sendMessage", {
        chat_id: chatId,
        text: `
<b>🔒 JOIN REQUIRED</b>

<b>Please join our offer channel before receiving the movie.</b>
`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🛍️ JOIN CHANNEL",
                url: SHOP_URL
              }
            ],
            [
              {
                text: "✅ CHECK JOIN",
                callback_data: `checkjoin_${movieId}`
              }
            ]
          ]
        }
      });

    if (sent?.result?.message_id) {
      await queueDelete(
        chatId,
        sent.result.message_id,
        env
      );
    }

    return;
  }

  const movie =
    await env.DB.prepare(`
      SELECT *
      FROM movies
      WHERE id = ?
      LIMIT 1
    `)
      .bind(movieId)
      .first();

  if (!movie) {
    await sendText(
      chatId,
      `<b>❌ MOVIE NOT FOUND</b>\n\n<b>This movie may have been removed from the index.</b>`,
      env
    );

    return;
  }

  // ----------------------------------------------------------
  // COPY SOURCE MESSAGE
  // ----------------------------------------------------------

  const copied =
    await telegram(env, "copyMessage", {
      chat_id: chatId,
      from_chat_id: movie.channel_id,
      message_id: movie.message_id
    });

  if (!copied?.ok) {
    console.error(
      "COPY MESSAGE ERROR:",
      copied
    );

    await sendText(
      chatId,
      `<b>❌ DELIVERY FAILED</b>\n\n<b>The movie could not be delivered right now.</b>`,
      env
    );

    return;
  }

  const copiedMessageId =
    copied.result?.message_id;

  if (copiedMessageId) {
    await queueDelete(
      chatId,
      copiedMessageId,
      env
    );
  }

  const notice =
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: `
<b>🎬 ${escapeHTML(movie.title)}</b>

<b>✅ Movie delivered successfully.</b>

<b>⏱️ This message will be deleted automatically after 5 minutes.</b>
`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔎 SEARCH MOVIES",
              url: `https://t.me/${(await getBotUsername(env))}?start=search`
            }
          ],
          [
            {
              text: "🛍️ SHOPPING OFFERS",
              url: SHOP_URL
            }
          ],
          [
            {
              text: "📢 MOVIE GROUP",
              url: MOVIE_GROUP_URL
            }
          ]
        ]
      }
    });

  if (notice?.result?.message_id) {
    await queueDelete(
      chatId,
      notice.result.message_id,
      env
    );
  }
}


// ============================================================
// JOIN CHECK
// ============================================================

async function checkJoin(
  userId,
  env
) {
  const result =
    await telegram(env, "getChatMember", {
      chat_id: "@loot_dells",
      user_id: userId
    });

  if (!result?.ok) {
    return false;
  }

  const status =
    result.result?.status;

  return [
    "member",
    "administrator",
    "creator"
  ].includes(status);
}


// ============================================================
// CALLBACK
// ============================================================

async function handleCallback(
  callback,
  env
) {
  const data =
    callback.data || "";

  const chatId =
    callback.message?.chat?.id;

  const messageId =
    callback.message?.message_id;

  if (!chatId) return;

  await telegram(env, "answerCallbackQuery", {
    callback_query_id: callback.id
  });

  if (data === "help") {
    await sendHelp(chatId, env);
    return;
  }

  if (data === "about") {
    await sendAbout(chatId, env);
    return;
  }

  if (data === "source") {
    await sendSource(chatId, env);
    return;
  }

  if (data === "setsource_help") {
    await sendText(
      chatId,
      `
<b>⚙️ SET SOURCE</b>

<b>Group admins can use:</b>

<code>/setsource @YourChannel</code>

<b>Make sure Movie Update HD is an administrator of the source channel.</b>
`,
      env
    );

    return;
  }

  if (data.startsWith("checkjoin_")) {
    const movieId =
      Number(data.replace("checkjoin_", ""));

    const joined =
      await checkJoin(
        callback.from.id,
        env
      );

    if (!joined) {
      await telegram(
        env,
        "answerCallbackQuery",
        {
          callback_query_id: callback.id,
          text: "❌ Please join the channel first.",
          show_alert: true
        }
      );

      return;
    }

    await telegram(
      env,
      "deleteMessage",
      {
        chat_id: chatId,
        message_id: messageId
      }
    );

    await deliverMovieFromDeepLink(
      {
        chat: {
          id: chatId
        }
      },
      movieId,
      env
    );
  }
}


// ============================================================
// INLINE SEARCH
// ============================================================

async function handleInlineQuery(
  inlineQuery,
  env
) {
  const query =
    (inlineQuery.query || "").trim();

  if (!query) {
    await telegram(
      env,
      "answerInlineQuery",
      {
        inline_query_id: inlineQuery.id,
        results: [],
        cache_time: 1
      }
    );

    return;
  }

  // Inline mode does not know which group source
  // should be used, so search globally.

  const result =
    await env.DB.prepare(`
      SELECT *
      FROM movies
      WHERE title LIKE ?
      ORDER BY id DESC
      LIMIT 20
    `)
      .bind(`%${query}%`)
      .all();

  const movies =
    result?.results || [];

  const results =
    await Promise.all(
      movies.map(async movie => ({
        type: "article",
        id: String(movie.id),
        title: movie.title,
        description:
          [
            movie.language,
            movie.quality,
            movie.size
          ]
            .filter(Boolean)
            .join(" • "),
        input_message_content: {
          message_text:
            `<b>🎬 ${escapeHTML(movie.title)}</b>\n\n<b>Click below to receive the movie.</b>`,
          parse_mode: "HTML"
        },
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🎬 GET MOVIE",
                url: await movieDeepLink(
                  movie.id,
                  env
                )
              }
            ]
          ]
        }
      }))
    );

  await telegram(
    env,
    "answerInlineQuery",
    {
      inline_query_id: inlineQuery.id,
      results,
      cache_time: 5,
      is_personal: false
    }
  );
}


// ============================================================
// CHANNEL POST
// ============================================================

async function handleChannelPost(
  message,
  env
) {
  const channelId =
    String(message.chat.id);

  const configured =
    await env.DB.prepare(`
      SELECT *
      FROM group_sources
      WHERE source_channel_id = ?
      LIMIT 1
    `)
      .bind(channelId)
      .first();

  if (!configured) {
    return;
  }

  await indexMovie(
    message,
    env
  );
}


// ============================================================
// INDEX MOVIE
// ============================================================

async function indexMovie(
  message,
  env
) {
  const channelId =
    String(message.chat.id);

  const messageId =
    Number(message.message_id);

  if (!channelId || !messageId) {
    return null;
  }

  // Duplicate check
  const duplicate =
    await env.DB.prepare(`
      SELECT id
      FROM movies
      WHERE channel_id = ?
      AND message_id = ?
      LIMIT 1
    `)
      .bind(
        channelId,
        messageId
      )
      .first();

  if (duplicate) {
    return duplicate.id;
  }

  const textValue =
    message.text ||
    message.caption ||
    "";

  const data =
    extractMovieData(textValue);

  const source =
    await env.DB.prepare(`
      SELECT *
      FROM group_sources
      WHERE source_channel_id = ?
      LIMIT 1
    `)
      .bind(channelId)
      .first();

  const sourceUsername =
    source?.source_username || "";

  const result =
    await env.DB.prepare(`
      INSERT INTO movies
      (
        title,
        language,
        quality,
        size,
        poster,
        channel_id,
        message_id,
        source_username
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        data.title,
        data.language,
        data.quality,
        data.size,
        data.poster,
        channelId,
        messageId,
        sourceUsername
      )
      .run();

  return result?.meta?.last_row_id || null;
}


// ============================================================
// EXTRACT MOVIE DATA
// ============================================================

function extractMovieData(textValue) {
  let title = "";
  let language = "";
  let quality = "";
  let size = "";

  const lines =
    textValue
      .split(/\r?\n/)
      .map(x => x.trim())
      .filter(Boolean);

  // ----------------------------------------------------------
  // TITLE
  // ----------------------------------------------------------

  if (lines.length) {
    title = lines[0];

    title = title
      .replace(/^(movie|film|title)\s*[:\-]\s*/i, "")
      .replace(/^\[|\]$/g, "")
      .trim();
  }

  // ----------------------------------------------------------
  // LANGUAGE
  // ----------------------------------------------------------

  const langMatch =
    textValue.match(
      /(?:language|lang)\s*[:\-]\s*([^\n]+)/i
    );

  if (langMatch) {
    language =
      langMatch[1].trim();
  }

  // ----------------------------------------------------------
  // QUALITY
  // ----------------------------------------------------------

  const qualityMatch =
    textValue.match(
      /\b(2160p|4K|1080p|720p|480p|360p|WEB-DL|WEBRip|BluRay|HDRip|HDTV|CAMRip|CAM)\b/i
    );

  if (qualityMatch) {
    quality =
      qualityMatch[1];
  }

  // ----------------------------------------------------------
  // SIZE
  // ----------------------------------------------------------

  const sizeMatch =
    textValue.match(
      /(\d+(?:\.\d+)?)\s*(GB|MB|KB)/i
    );

  if (sizeMatch) {
    size =
      `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}`;
  }

  // ----------------------------------------------------------
  // REMOVE EXCESSIVE SYMBOLS
  // ----------------------------------------------------------

  title =
    title
      .replace(/[*_~`]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  if (!title) {
    title = "Movie";
  }

  return {
    title,
    language,
    quality,
    size,
    poster: ""
  };
}


// ============================================================
// INDEX API
// Used by Render / Pyrogram
// ============================================================

async function indexAPI(
  request,
  env
) {
  if (!checkIndexSecret(request, env)) {
    return json({
      ok: false,
      error: "Unauthorized"
    }, 401);
  }

  await ensureSchema(env);

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      ok: false,
      error: "Invalid JSON"
    }, 400);
  }

  const channelId =
    String(
      body.channel_id ??
      body.chat_id ??
      ""
    );

  const messageId =
    Number(
      body.message_id ??
      body.id ??
      0
    );

  if (!channelId || !messageId) {
    return json({
      ok: false,
      error: "channel_id and message_id are required"
    }, 400);
  }

  const fakeMessage = {
    chat: {
      id: channelId,
      type: "channel"
    },
    message_id: messageId,
    text: body.text || "",
    caption: body.caption || ""
  };

  const movieId =
    await indexMovie(
      fakeMessage,
      env
    );

  return json({
    ok: true,
    movie_id: movieId
  });
}


// ============================================================
// INDEX JOB GET
// ============================================================

async function getIndexJob(
  request,
  env
) {
  if (!checkIndexSecret(request, env)) {
    return json({
      ok: false,
      error: "Unauthorized"
    }, 401);
  }

  await ensureSchema(env);

  // Reset stale jobs
  await env.DB.prepare(`
    UPDATE index_jobs
    SET
      status = 'pending',
      updated_at = unixepoch()
    WHERE status = 'running'
    AND updated_at < unixepoch() - 1800
  `).run();

  const job =
    await env.DB.prepare(`
      SELECT *
      FROM index_jobs
      WHERE status = 'pending'
      ORDER BY id ASC
      LIMIT 1
    `)
      .first();

  if (!job) {
    return json({
      ok: true,
      job: null
    });
  }

  await env.DB.prepare(`
    UPDATE index_jobs
    SET
      status = 'running',
      updated_at = unixepoch()
    WHERE id = ?
  `)
    .bind(job.id)
    .run();

  return json({
    ok: true,
    job: {
      ...job,
      id: job.id,
      job_id: job.id
    }
  });
}


// ============================================================
// INDEX JOB UPDATE
// ============================================================

async function updateIndexJob(
  request,
  env
) {
  if (!checkIndexSecret(request, env)) {
    return json({
      ok: false,
      error: "Unauthorized"
    }, 401);
  }

  await ensureSchema(env);

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      ok: false,
      error: "Invalid JSON"
    }, 400);
  }

  // Accept BOTH job_id and id
  const jobId =
    Number(
      body.job_id ??
      body.id ??
      0
    );

  if (!jobId) {
    return json({
      ok: false,
      error: "job_id is required"
    }, 400);
  }

  const status =
    body.status || "running";

  const totalIndexed =
    Number(
      body.total_indexed ??
      body.total ??
      0
    );

  const lastMessageId =
    Number(
      body.last_message_id ??
      0
    );

  const error =
    body.error || "";

  await env.DB.prepare(`
    UPDATE index_jobs
    SET
      status = ?,
      total_indexed = ?,
      last_message_id = ?,
      error = ?,
      updated_at = unixepoch()
    WHERE id = ?
  `)
    .bind(
      status,
      totalIndexed,
      lastMessageId,
      error,
      jobId
    )
    .run();

  return json({
    ok: true
  });
}


// ============================================================
// INDEX STATUS
// ============================================================

async function indexStatus(
  request,
  env
) {
  if (!checkIndexSecret(request, env)) {
    return json({
      ok: false,
      error: "Unauthorized"
    }, 401);
  }

  await ensureSchema(env);

  const jobs =
    await env.DB.prepare(`
      SELECT *
      FROM index_jobs
      ORDER BY id DESC
      LIMIT 20
    `)
      .all();

  return json({
    ok: true,
    jobs: jobs?.results || []
  });
}


// ============================================================
// SECRET CHECK
// ============================================================

function checkIndexSecret(
  request,
  env
) {
  const header =
    request.headers.get(
      "X-Index-Secret"
    );

  const url =
    new URL(request.url);

  const querySecret =
    url.searchParams.get(
      "secret"
    );

  if (!env.INDEX_SECRET) {
    return false;
  }

  return (
    header === env.INDEX_SECRET ||
    querySecret === env.INDEX_SECRET
  );
}


// ============================================================
// TEMP MESSAGE
// ============================================================

async function sendTempMessage(
  chatId,
  textValue,
  env,
  shoppingButton = false
) {
  const keyboard = [];

  if (shoppingButton) {
    keyboard.push([
      {
        text: "🔗 CLICK HERE",
        url: SHOP_URL
      }
    ]);
  }

  const result =
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: textValue,
      parse_mode: "HTML",
      reply_markup: keyboard.length
        ? {
            inline_keyboard: keyboard
          }
        : undefined
    });

  if (result?.result?.message_id) {
    await queueDelete(
      chatId,
      result.result.message_id,
      env
    );
  }

  return result;
}


// ============================================================
// NORMAL TEXT
// ============================================================

async function sendText(
  chatId,
  textValue,
  env
) {
  const result =
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: textValue,
      parse_mode: "HTML"
    });

  return result;
}


// ============================================================
// DELETE QUEUE
// ============================================================

async function queueDelete(
  chatId,
  messageId,
  env
) {
  try {
    await env.DB.prepare(`
      INSERT INTO delete_queue
      (
        chat_id,
        message_id,
        delete_at
      )
      VALUES (?, ?, ?)
    `)
      .bind(
        String(chatId),
        Number(messageId),
        Math.floor(Date.now() / 1000) + DELETE_AFTER
      )
      .run();
  } catch (error) {
    console.error(
      "QUEUE DELETE ERROR:",
      error
    );
  }
}


// ============================================================
// CLEANUP
// ============================================================

async function cleanup(env) {
  await ensureSchema(env);

  const now =
    Math.floor(Date.now() / 1000);

  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM delete_queue
      WHERE delete_at <= ?
      ORDER BY id ASC
      LIMIT 100
    `)
      .bind(now)
      .all();

  const items =
    rows?.results || [];

  for (const row of items) {
    try {
      await telegram(
        env,
        "deleteMessage",
        {
          chat_id: row.chat_id,
          message_id: row.message_id
        }
      );
    } catch (error) {
      console.error(
        "DELETE MESSAGE ERROR:",
        error
      );
    }

    await env.DB.prepare(`
      DELETE FROM delete_queue
      WHERE id = ?
    `)
      .bind(row.id)
      .run();
  }
}


// ============================================================
// BOT USERNAME
// ============================================================

async function getBotUsername(env) {
  const result =
    await telegram(env, "getMe");

  return (
    result?.result?.username ||
    "Moviedeta_bot"
  );
}


// ============================================================
// HTML ESCAPE
// ============================================================

function escapeHTML(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


// ============================================================
// TRUNCATE
// ============================================================

function truncate(
  value,
  length
) {
  const textValue =
    String(value || "");

  if (textValue.length <= length) {
    return textValue;
  }

  return (
    textValue.substring(0, length - 3) +
    "..."
  );
}
