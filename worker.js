// ============================================================
// MOVIE UPDATE HD
// Telegram Movie Filter Bot
// Cloudflare Workers + D1
// ============================================================

const BOT_NAME = "Movie Update HD";

const SHOP_URL = "https://t.me/loot_dells";

const OWNER_URL = "https://t.me/share_kb";

const MOVIE_GROUP_URL = "https://t.me/MovieUpdateHD";

const DELETE_AFTER = 300;


// ============================================================
// TELEGRAM API
// ============================================================

async function telegram(env, method, payload = {}) {

  const url =
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;

  const response = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json"
    },

    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!data.ok) {

    throw new Error(
      data.description || "Telegram API error"
    );
  }

  return data.result;
}


// ============================================================
// HTML ESCAPE
// ============================================================

function escapeHTML(value = "") {

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(data, status = 200) {

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}


// ============================================================
// SCHEMA
// ============================================================

async function ensureSchema(env) {

  await env.DB.prepare(`
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
  `).run();


  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_movies_title
    ON movies(title)
  `).run();


  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_movies_channel
    ON movies(channel_id)
  `).run();


  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_movies_channel_title
    ON movies(channel_id, title)
  `).run();


  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      username TEXT DEFAULT '',
      first_name TEXT DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch())
    )
  `).run();


  await env.DB.prepare(`
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
  `).run();


  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_group_sources_chat
    ON group_sources(chat_id)
  `).run();


  await env.DB.prepare(`
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
  `).run();


  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_index_jobs_status
    ON index_jobs(status)
  `).run();


  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS delete_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      delete_at INTEGER NOT NULL
    )
  `).run();


  // ----------------------------------------------------------
  // Try adding source_username to older databases
  // ----------------------------------------------------------

  try {

    await env.DB.prepare(`
      ALTER TABLE movies
      ADD COLUMN source_username TEXT DEFAULT ''
    `).run();

  } catch (_) {
    // Column already exists.
  }
}


// ============================================================
// USER SAVE
// ============================================================

async function saveUser(env, user) {

  if (!user) return;

  try {

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

  } catch (error) {

    console.log(
      "saveUser error:",
      error.message
    );
  }
}


// ============================================================
// JOIN CHECK
// ============================================================

async function isJoined(env, userId) {

  try {

    const member = await telegram(
      env,
      "getChatMember",
      {
        chat_id: "@loot_dells",
        user_id: userId
      }
    );

    return [
      "creator",
      "administrator",
      "member"
    ].includes(member.status);

  } catch (_) {

    return false;
  }
}


// ============================================================
// JOIN MESSAGE
// ============================================================

async function sendJoinMessage(env, chatId) {

  return telegram(
    env,
    "sendMessage",
    {
      chat_id: chatId,

      text:
        `<b>🔐 JOIN REQUIRED</b>\n\n` +
        `<b>Please join our shopping channel first.</b>\n\n` +
        `<b>After joining, send your movie name again.</b>`,

      parse_mode: "HTML",

      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🛍️ JOIN CHANNEL",
              url: SHOP_URL
            }
          ]
        ]
      }
    }
  );
}


// ============================================================
// SHOPPING BUTTON
// ============================================================

function shoppingButton() {

  return [
    {
      text: "🔗 CLICK HERE",
      url: SHOP_URL
    }
  ];
}


// ============================================================
// TEMP MESSAGE
// ============================================================

async function sendTempMessage(
  env,
  chatId,
  text,
  replyMarkup = null
) {

  const keyboard = [
    shoppingButton()
  ];

  if (
    replyMarkup &&
    replyMarkup.inline_keyboard
  ) {

    keyboard.push(
      ...replyMarkup.inline_keyboard
    );
  }

  const result = await telegram(
    env,
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",

      reply_markup: {
        inline_keyboard: keyboard
      }
    }
  );


  await queueDelete(
    env,
    chatId,
    result.message_id
  );


  return result;
}


// ============================================================
// DELETE QUEUE
// ============================================================

async function queueDelete(
  env,
  chatId,
  messageId
) {

  const deleteAt =
    Math.floor(Date.now() / 1000) +
    DELETE_AFTER;

  await env.DB.prepare(`
    INSERT INTO delete_queue
    (chat_id, message_id, delete_at)
    VALUES (?, ?, ?)
  `)
    .bind(
      String(chatId),
      Number(messageId),
      deleteAt
    )
    .run();
}


// ============================================================
// DELETE MESSAGE
// ============================================================

async function safeDelete(
  env,
  chatId,
  messageId
) {

  try {

    await telegram(
      env,
      "deleteMessage",
      {
        chat_id: chatId,
        message_id: messageId
      }
    );

  } catch (_) {}
}


// ============================================================
// PARSE MOVIE TITLE
// ============================================================

function extractMovieData(
  text,
  fallbackTitle = "Movie"
) {

  text = String(text || "").trim();

  const lines = text
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);


  let title =
    lines.length
      ? lines[0]
      : fallbackTitle;


  const prefixes = [
    "movie:",
    "movie -",
    "movie",
    "title:",
    "title -",
    "film:",
    "film -"
  ];


  const lower =
    title.toLowerCase();


  for (const prefix of prefixes) {

    if (lower.startsWith(prefix)) {

      title =
        title
          .slice(prefix.length)
          .trim();

      break;
    }
  }


  let language = "";
  let quality = "";
  let size = "";


  const languageList = [
    "hindi",
    "english",
    "bengali",
    "bangla",
    "tamil",
    "telugu",
    "malayalam",
    "kannada",
    "marathi",
    "punjabi",
    "gujarati",
    "urdu"
  ];


  const lowerText =
    text.toLowerCase();


  for (const lang of languageList) {

    if (lowerText.includes(lang)) {

      language =
        lang.charAt(0).toUpperCase() +
        lang.slice(1);

      break;
    }
  }


  const qualityMatch =
    lowerText.match(
      /\b(2160p|4k|1440p|1080p|720p|480p|360p|240p|web-dl|webdl|bluray|blu-ray|webrip|hdrip|hdcam|cam)\b/
    );


  if (qualityMatch) {

    quality =
      qualityMatch[1].toUpperCase();
  }


  const sizeMatch =
    text.match(
      /(\d+(?:\.\d+)?)\s*(GB|MB|KB)/i
    );


  if (sizeMatch) {

    size =
      `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}`;
  }


  return {
    title: title || fallbackTitle,
    language,
    quality,
    size
  };
}


// ============================================================
// GET SOURCE FOR GROUP
// ============================================================

async function getGroupSource(
  env,
  chatId
) {

  return env.DB.prepare(`
    SELECT *
    FROM group_sources
    WHERE chat_id = ?
    LIMIT 1
  `)
    .bind(String(chatId))
    .first();
}


// ============================================================
// CHECK ADMIN
// ============================================================

async function isAdmin(
  env,
  chatId,
  userId
) {

  try {

    const member =
      await telegram(
        env,
        "getChatMember",
        {
          chat_id: chatId,
          user_id: userId
        }
      );


    return [
      "creator",
      "administrator"
    ].includes(member.status);

  } catch (_) {

    return false;
  }
}


// ============================================================
// GET CHAT
// ============================================================

async function getChat(
  env,
  chatId
) {

  return telegram(
    env,
    "getChat",
    {
      chat_id: chatId
    }
  );
}


// ============================================================
// PARSE SOURCE
// ============================================================

async function resolveSource(
  env,
  source
) {

  source =
    String(source || "").trim();

  if (!source) {
    throw new Error(
      "Source channel is required."
    );
  }


  let chat;


  try {

    chat =
      await getChat(
        env,
        source
      );

  } catch (error) {

    throw new Error(
      "I could not access this Source Channel. Make sure the bot is added as an administrator."
    );
  }


  return {
    id: String(chat.id),

    username:
      chat.username
        ? `@${chat.username}`
        : "",

    title:
      chat.title ||
      chat.first_name ||
      "Source Channel"
  };
}


// ============================================================
// SET SOURCE
// ============================================================

async function setSourceCommand(
  env,
  message,
  sourceText
) {

  const chatId =
    String(message.chat.id);


  if (
    message.chat.type !== "group" &&
    message.chat.type !== "supergroup"
  ) {

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "<b>⚠️ Use /setsource inside your group.</b>",
        parse_mode: "HTML"
      }
    );

    return;
  }


  const admin =
    await isAdmin(
      env,
      chatId,
      message.from.id
    );


  if (!admin) {

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "<b>❌ Only group administrators can set the Source Channel.</b>",
        parse_mode: "HTML"
      }
    );

    return;
  }


  if (!sourceText) {

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "<b>❌ Please provide a Source Channel.</b>\n\n" +
          "<b>Example:</b>\n" +
          "<code>/setsource @yourchannel</code>",
        parse_mode: "HTML"
      }
    );

    return;
  }


  let source;

  try {

    source =
      await resolveSource(
        env,
        sourceText
      );

  } catch (error) {

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `<b>❌ ${escapeHTML(error.message)}</b>`,
        parse_mode: "HTML"
      }
    );

    return;
  }


  const existing =
    await env.DB.prepare(`
      SELECT *
      FROM group_sources
      WHERE chat_id = ?
      LIMIT 1
    `)
      .bind(chatId)
      .first();


  // ----------------------------------------------------------
  // Save source
  // ----------------------------------------------------------

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
      chatId,
      message.chat.title || "",
      source.id,
      source.username,
      source.title
    )
    .run();


  // ----------------------------------------------------------
  // Check whether source already has movies
  // ----------------------------------------------------------

  const movieCount =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM movies
      WHERE channel_id = ?
    `)
      .bind(source.id)
      .first();


  const existingJob =
    await env.DB.prepare(`
      SELECT *
      FROM index_jobs
      WHERE source_channel_id = ?
      AND status IN ('pending', 'running')
      ORDER BY id DESC
      LIMIT 1
    `)
      .bind(source.id)
      .first();


  let statusText;


  if (Number(movieCount?.count || 0) > 0) {

    statusText =
      "ALREADY INDEXED";

  } else if (existingJob) {

    statusText =
      "INDEXING QUEUED";

  } else {

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
        chatId,
        source.id,
        source.username,
        source.title
      )
      .run();

    statusText =
      "INDEXING QUEUED";
  }


  await telegram(
    env,
    "sendMessage",
    {
      chat_id: chatId,

      text:
        `<b>✅ SOURCE CHANNEL SET</b>\n\n` +

        `<b>📢 Channel:</b>\n` +
        `<b>${escapeHTML(source.title)}</b>\n\n` +

        `<b>🔗 Username:</b>\n` +
        `<b>${escapeHTML(source.username || "Private Channel")}</b>\n\n` +

        `<b>📊 INDEX STATUS:</b>\n` +
        `<b>${statusText}</b>\n\n` +

        `<b>🤖 Movie search will use this Source Channel.</b>`,

      parse_mode: "HTML"
    }
  );
}


// ============================================================
// SOURCE COMMAND
// ============================================================

async function sourceCommand(
  env,
  message
) {

  const chatId =
    String(message.chat.id);


  const source =
    await getGroupSource(
      env,
      chatId
    );


  if (!source) {

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,

        text:
          "<b>📢 NO SOURCE CHANNEL SET</b>\n\n" +
          "<b>An administrator can set one using:</b>\n\n" +
          "<code>/setsource @channel</code>",

        parse_mode: "HTML"
      }
    );

    return;
  }


  const job =
    await env.DB.prepare(`
      SELECT *
      FROM index_jobs
      WHERE source_channel_id = ?
      ORDER BY id DESC
      LIMIT 1
    `)
      .bind(source.source_channel_id)
      .first();


  let status =
    "READY";


  if (job) {

    if (job.status === "pending") {
      status = "INDEXING QUEUED";
    }

    else if (job.status === "running") {
      status = "INDEXING";
    }

    else if (job.status === "failed") {
      status = "INDEXING FAILED";
    }

    else if (job.status === "completed") {
      status = "READY";
    }
  }


  const count =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM movies
      WHERE channel_id = ?
    `)
      .bind(source.source_channel_id)
      .first();


  await telegram(
    env,
    "sendMessage",
    {
      chat_id: chatId,

      text:
        `<b>📢 CURRENT SOURCE CHANNEL</b>\n\n` +

        `<b>Channel:</b>\n` +
        `<b>${escapeHTML(source.source_title)}</b>\n\n` +

        `<b>Username:</b>\n` +
        `<b>${escapeHTML(source.source_username || "Private Channel")}</b>\n\n` +

        `<b>📊 INDEX STATUS:</b>\n` +
        `<b>${status}</b>\n\n` +

        `<b>🎬 Indexed Movies:</b> ` +
        `<b>${Number(count?.count || 0)}</b>\n\n` +

        `<b>🤖 Movie search buttons open Movie Update HD Bot.</b>\n\n` +

        `<b>🗑️ To remove this Source Channel:</b>\n` +
        `<code>/removesource</code>`,

      parse_mode: "HTML"
    }
  );
}


// ============================================================
// REMOVE SOURCE
// ============================================================

async function removeSourceCommand(
  env,
  message
) {

  const chatId =
    String(message.chat.id);


  if (
    message.chat.type !== "group" &&
    message.chat.type !== "supergroup"
  ) {

    return;
  }


  const admin =
    await isAdmin(
      env,
      chatId,
      message.from.id
    );


  if (!admin) {

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,

        text:
          "<b>❌ Only group administrators can remove the Source Channel.</b>",

        parse_mode: "HTML"
      }
    );

    return;
  }


  await env.DB.prepare(`
    DELETE FROM group_sources
    WHERE chat_id = ?
  `)
    .bind(chatId)
    .run();


  await env.DB.prepare(`
    DELETE FROM index_jobs
    WHERE chat_id = ?
    AND status IN ('pending', 'running')
  `)
    .bind(chatId)
    .run();


  await telegram(
    env,
    "sendMessage",
    {
      chat_id: chatId,

      text:
        "<b>✅ SOURCE CHANNEL REMOVED</b>\n\n" +
        "<b>You can set a new Source Channel using:</b>\n\n" +
        "<code>/setsource @channel</code>",

      parse_mode: "HTML"
    }
  );
}


// ============================================================
// MOVIE SEARCH
// ============================================================

async function searchMovies(
  env,
  message,
  query
) {

  const chatId =
    String(message.chat.id);


  query =
    String(query || "").trim();


  if (!query) {

    await sendTempMessage(
      env,
      chatId,

      `<b>🔎 SEARCH MOVIES</b>\n\n` +
      `<b>Type a movie name.</b>\n\n` +
      `<b>Example:</b>\n` +
      `<code>KGF</code>`,

      null
    );

    return;
  }


  const source =
    await getGroupSource(
      env,
      chatId
    );


  if (!source) {

    await sendTempMessage(
      env,
      chatId,

      `<b>⚠️ NO SOURCE CHANNEL</b>\n\n` +
      `<b>This group does not have a Source Channel yet.</b>\n\n` +
      `<b>An administrator can set one using:</b>\n` +
      `<code>/setsource @channel</code>`,

      null
    );

    return;
  }


  const joined =
    await isJoined(
      env,
      message.from.id
    );


  if (!joined) {

    await sendJoinMessage(
      env,
      chatId
    );

    return;
  }


  const words =
    query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);


  let sql =
    `SELECT *
     FROM movies
     WHERE channel_id = ?`;


  const bindings =
    [source.source_channel_id];


  for (const word of words) {

    sql +=
      ` AND LOWER(title) LIKE ?`;

    bindings.push(
      `%${word}%`
    );
  }


  sql +=
    ` ORDER BY id DESC LIMIT 20`;


  const result =
    await env.DB
      .prepare(sql)
      .bind(...bindings)
      .all();


  const movies =
    result.results || [];


  if (!movies.length) {

    await sendTempMessage(
      env,
      chatId,

      `<b>❌ MOVIE NOT FOUND</b>\n\n` +
      `<b>Search:</b> ${escapeHTML(query)}\n\n` +
      `<b>Try another movie name.</b>`,

      null
    );

    return;
  }


  let text =
    `<b>🎬 SEARCH RESULTS</b>\n\n` +

    `<b>🔎 ${escapeHTML(query)}</b>\n\n` +

    `<b>📌 Found ${movies.length} result(s)</b>\n\n` +

    `<b>🛍️ AMAZON &amp; FLIPKART OFFERS</b>\n\n` +

    `<b>👇 Select a movie below:</b>\n\n` +

    `<b>⏱️ This message will be deleted automatically after 5 minutes.</b>`;


  const buttons = [];


  for (const movie of movies) {

    buttons.push([
      {
        text:
          `🎬 ${movie.title}`,

        url:
          await movieDeepLink(
            env,
            movie.id
          )
      }
    ]);
  }


  await sendTempMessage(
    env,
    chatId,
    text,

    {
      inline_keyboard:
        buttons
    }
  );
}


// ============================================================
// MOVIE DEEP LINK
// ============================================================

async function movieDeepLink(
  env,
  movieId
) {

  const me =
    await telegram(
      env,
      "getMe"
    );


  return (
    `https://t.me/${me.username}` +
    `?start=movie_${movieId}`
  );
}


// ============================================================
// DELIVER MOVIE
// ============================================================

async function deliverMovieFromDeepLink(
  env,
  message,
  movieId
) {

  if (
    message.chat.type !== "private"
  ) {

    return;
  }


  const joined =
    await isJoined(
      env,
      message.from.id
    );


  if (!joined) {

    await sendJoinMessage(
      env,
      message.chat.id
    );

    return;
  }


  const movie =
    await env.DB.prepare(`
      SELECT *
      FROM movies
      WHERE id = ?
      LIMIT 1
    `)
      .bind(Number(movieId))
      .first();


  if (!movie) {

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: message.chat.id,

        text:
          "<b>❌ MOVIE NOT FOUND</b>\n\n" +
          "<b>This movie is no longer available.</b>",

        parse_mode: "HTML"
      }
    );

    return;
  }


  try {

    const copied =
      await telegram(
        env,
        "copyMessage",
        {
          chat_id:
            message.chat.id,

          from_chat_id:
            movie.channel_id,

          message_id:
            movie.message_id
        }
      );


    await queueDelete(
      env,
      message.chat.id,
      copied.message_id
    );


    const warning =
      await telegram(
        env,
        "sendMessage",
        {
          chat_id:
            message.chat.id,

          text:
            `<b>🎬 MOVIE READY</b>\n\n` +

            `<b>${escapeHTML(movie.title)}</b>\n\n` +

            `<b>⏱️ This movie will be automatically deleted after 5 minutes.</b>\n\n` +

            `<b>🔎 Search Movie</b>`,

          parse_mode: "HTML",

          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🔎 SEARCH MOVIE",
                  switch_inline_query_current_chat: ""
                }
              ],
              [
                {
                  text: "🛍️ SHOPPING OFFERS",
                  url: SHOP_URL
                }
              ]
            ]
          }
        }
      );


    await queueDelete(
      env,
      message.chat.id,
      warning.message_id
    );


  } catch (error) {

    console.log(
      "Movie delivery error:",
      error.message
    );


    await telegram(
      env,
      "sendMessage",
      {
        chat_id: message.chat.id,

        text:
          "<b>❌ DELIVERY FAILED</b>\n\n" +
          "<b>The movie could not be copied from the Source Channel.</b>",

        parse_mode: "HTML"
      }
    );
  }
}


// ============================================================
// START MENU
// ============================================================

async function sendStart(
  env,
  message
) {

  const me =
    await telegram(
      env,
      "getMe"
    );


  const addGroupURL =
    `https://t.me/${me.username}` +
    `?startgroup=true&admin=delete_messages`;


  const text =
    `<b>🎬 ${BOT_NAME}</b>\n\n` +

    `<b>Search movies from your configured Source Channel.</b>\n\n` +

    `<b>Choose an option below.</b>`;


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
        callback_data: "setsource"
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


  await telegram(
    env,
    "sendMessage",
    {
      chat_id: message.chat.id,
      text,
      parse_mode: "HTML",

      reply_markup: {
        inline_keyboard:
          keyboard
      }
    }
  );
}


// ============================================================
// HELP
// ============================================================

async function sendHelp(
  env,
  chatId
) {

  await telegram(
    env,
    "sendMessage",
    {
      chat_id: chatId,

      text:
        `<b>❓ ${BOT_NAME} HELP</b>\n\n` +

        `<b>1️⃣ Add the bot to your group.</b>\n\n` +

        `<b>2️⃣ Make the bot an administrator.</b>\n\n` +

        `<b>3️⃣ Set your Source Channel:</b>\n` +
        `<code>/setsource @channel</code>\n\n` +

        `<b>4️⃣ Members can search movie names directly in the group.</b>\n\n` +

        `<b>5️⃣ Click a movie result to receive the movie privately.</b>\n\n` +

        `<b>Available Commands:</b>\n\n` +

        `<code>/source</code> - View Source Channel\n` +
        `<code>/setsource @channel</code> - Set Source\n` +
        `<code>/removesource</code> - Remove Source\n` +
        `<code>/help</code> - Help\n` +
        `<code>/about</code> - About`,

      parse_mode: "HTML"
    }
  );
}


// ============================================================
// ABOUT
// ============================================================

async function sendAbout(
  env,
  chatId
) {

  await telegram(
    env,
    "sendMessage",
    {
      chat_id: chatId,

      text:
        `<b>✨ ABOUT ${BOT_NAME}</b>\n\n` +

        `<b>Movie search and delivery bot.</b>\n\n` +

        `<b>Each group can use its own Source Channel.</b>\n\n` +

        `<b>Movies are delivered privately through the bot.</b>\n\n` +

        `<b>Powered by Movie Update HD</b>`,

      parse_mode: "HTML"
    }
  );
}


// ============================================================
// SET COMMANDS
// ============================================================

async function setupCommands(
  env
) {

  try {

    await telegram(
      env,
      "setMyCommands",
      {
        commands: [
          {
            command: "start",
            description: "Start Movie Update HD"
          },
          {
            command: "source",
            description: "View Source Channel"
          },
          {
            command: "setsource",
            description: "Set Source Channel"
          },
          {
            command: "removesource",
            description: "Remove Source Channel"
          },
          {
            command: "help",
            description: "Help"
          },
          {
            command: "about",
            description: "About"
          }
        ]
      }
    );

  } catch (error) {

    console.log(
      "setupCommands:",
      error.message
    );
  }
}


// ============================================================
// HANDLE COMMAND
// ============================================================

async function handleCommand(
  env,
  message,
  command,
  args
) {

  switch (command) {

    case "/start":

      if (
        args &&
        args.startsWith("movie_")
      ) {

        const movieId =
          args.replace(
            "movie_",
            ""
          );

        await deliverMovieFromDeepLink(
          env,
          message,
          movieId
        );

      } else {

        await sendStart(
          env,
          message
        );
      }

      break;


    case "/source":

      await sourceCommand(
        env,
        message
      );

      break;


    case "/setsource":

      await setSourceCommand(
        env,
        message,
        args
      );

      break;


    case "/removesource":

      await removeSourceCommand(
        env,
        message
      );

      break;


    case "/help":

      await sendHelp(
        env,
        message.chat.id
      );

      break;


    case "/about":

      await sendAbout(
        env,
        message.chat.id
      );

      break;
  }
}


// ============================================================
// CHANNEL POST AUTO INDEX
// ============================================================

async function handleChannelPost(
  env,
  message
) {

  const channelId =
    String(message.chat.id);


  const source =
    await env.DB.prepare(`
      SELECT *
      FROM group_sources
      WHERE source_channel_id = ?
      LIMIT 1
    `)
      .bind(channelId)
      .first();


  if (!source) {

    return;
  }


  await indexMovie(
    env,
    message
  );
}


// ============================================================
// INDEX MOVIE
// ============================================================

async function indexMovie(
  env,
  message
) {

  const channelId =
    String(message.chat.id);


  const messageId =
    Number(message.message_id || message.id);


  if (!messageId) {
    return null;
  }


  const exists =
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


  if (exists) {

    return exists.id;
  }


  const text =
    message.text ||
    message.caption ||
    "";


  const source =
    await env.DB.prepare(`
      SELECT *
      FROM group_sources
      WHERE source_channel_id = ?
      LIMIT 1
    `)
      .bind(channelId)
      .first();


  const fallbackTitle =
    source?.source_title ||
    "Movie";


  const data =
    extractMovieData(
      text,
      fallbackTitle
    );


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
        "",
        channelId,
        messageId,
        source?.source_username || ""
      )
      .run();


  return result.meta.last_row_id;
}


// ============================================================
// INLINE SEARCH
// ============================================================

async function handleInlineQuery(
  env,
  inlineQuery
) {

  const query =
    String(
      inlineQuery.query || ""
    ).trim();


  const userId =
    inlineQuery.from.id;


  const joined =
    await isJoined(
      env,
      userId
    );


  if (!joined) {

    await telegram(
      env,
      "answerInlineQuery",
      {
        inline_query_id:
          inlineQuery.id,

        cache_time: 1,

        results: [
          {
            type: "article",

            id: "join_required",

            title: "🔐 JOIN REQUIRED",

            description:
              "Join the shopping channel first.",

            input_message_content: {
              message_text:
                `<b>🔐 JOIN REQUIRED</b>\n\n` +
                `<b>Please join the shopping channel first.</b>`,
              parse_mode: "HTML"
            },

            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🛍️ JOIN CHANNEL",
                    url: SHOP_URL
                  }
                ]
              ]
            }
          }
        ]
      }
    );

    return;
  }


  if (!query) {

    await telegram(
      env,
      "answerInlineQuery",
      {
        inline_query_id:
          inlineQuery.id,

        cache_time: 1,

        results: [
          {
            type: "article",

            id: "help",

            title: "🎬 Search Movie",

            description:
              "Type a movie name.",

            input_message_content: {
              message_text:
                "<b>🎬 Movie Update HD</b>\n\n" +
                "<b>Type a movie name to search.</b>",
              parse_mode: "HTML"
            }
          }
        ]
      }
    );

    return;
  }


  const words =
    query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);


  let sql =
    `SELECT *
     FROM movies
     WHERE 1 = 1`;


  const bindings = [];


  for (const word of words) {

    sql +=
      ` AND LOWER(title) LIKE ?`;

    bindings.push(
      `%${word}%`
    );
  }


  sql +=
    ` ORDER BY id DESC LIMIT 20`;


  const result =
    await env.DB
      .prepare(sql)
      .bind(...bindings)
      .all();


  const rows =
    result.results || [];


  const results = [];


  for (const movie of rows) {

    const link =
      await movieDeepLink(
        env,
        movie.id
      );


    results.push({
      type: "article",

      id: String(movie.id),

      title:
        `🎬 ${movie.title}`,

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
          `<b>🎬 ${escapeHTML(movie.title)}</b>\n\n` +

          `<b>Movie Update HD</b>\n\n` +

          `<b>Click GET MOVIE to receive the movie privately.</b>`,

        parse_mode: "HTML"
      },

      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🎬 GET MOVIE",
              url: link
            }
          ]
        ]
      }
    });
  }


  await telegram(
    env,
    "answerInlineQuery",
    {
      inline_query_id:
        inlineQuery.id,

      cache_time: 3,

      results
    }
  );
}


// ============================================================
// CALLBACK QUERY
// ============================================================

async function handleCallbackQuery(
  env,
  callback
) {

  const data =
    callback.data;


  if (
    data === "help"
  ) {

    await telegram(
      env,
      "answerCallbackQuery",
      {
        callback_query_id:
          callback.id
      }
    );


    await sendHelp(
      env,
      callback.message.chat.id
    );

    return;
  }


  if (
    data === "about"
  ) {

    await telegram(
      env,
      "answerCallbackQuery",
      {
        callback_query_id:
          callback.id
      }
    );


    await sendAbout(
      env,
      callback.message.chat.id
    );

    return;
  }


  if (
    data === "source"
  ) {

    await telegram(
      env,
      "answerCallbackQuery",
      {
        callback_query_id:
          callback.id
      }
    );


    await sourceCommand(
      env,
      callback.message
    );

    return;
  }


  if (
    data === "setsource"
  ) {

    await telegram(
      env,
      "answerCallbackQuery",
      {
        callback_query_id:
          callback.id
      }
    );


    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          callback.message.chat.id,

        text:
          `<b>⚙️ SET SOURCE CHANNEL</b>\n\n` +

          `<b>Group administrators can use:</b>\n\n` +

          `<code>/setsource @channel</code>\n\n` +

          `<b>Example:</b>\n` +
          `<code>/setsource @movie_click1</code>`,

        parse_mode: "HTML"
      }
    );

    return;
  }


  await telegram(
    env,
    "answerCallbackQuery",
    {
      callback_query_id:
        callback.id
    }
  );
}


// ============================================================
// MESSAGE HANDLER
// ============================================================

async function handleMessage(
  env,
  message
) {

  if (!message) {
    return;
  }


  if (message.from) {

    await saveUser(
      env,
      message.from
    );
  }


  const text =
    message.text ||
    message.caption ||
    "";


  if (
    text.startsWith("/")
  ) {

    const first =
      text
        .trim()
        .split(/\s+/)[0];


    const command =
      first
        .split("@")[0]
        .toLowerCase();


    const args =
      text
        .trim()
        .split(/\s+/)
        .slice(1)
        .join(" ");


    await handleCommand(
      env,
      message,
      command,
      args
    );

    return;
  }


  // ----------------------------------------------------------
  // Group movie search
  // ----------------------------------------------------------

  if (
    (
      message.chat.type === "group" ||
      message.chat.type === "supergroup"
    ) &&
    message.text
  ) {

    const query =
      message.text.trim();


    // Ignore very short messages
    if (query.length >= 2) {

      await searchMovies(
        env,
        message,
        query
      );
    }
  }
}


// ============================================================
// INDEX API
// ============================================================

async function indexAPI(
  env,
  request
) {

  const body =
    await request.json();


  const fakeMessage = {
    chat: {
      id:
        Number(body.channel_id) ||
        String(body.channel_id)
    },

    message_id:
      Number(body.message_id),

    text:
      body.text || "",

    caption:
      body.text || ""
  };


  const id =
    await indexMovie(
      env,
      fakeMessage
    );


  return json({
    ok: true,
    id
  });
}


// ============================================================
// INDEX JOB API
// ============================================================

async function getIndexJob(
  env
) {

  // ----------------------------------------------------------
  // Recover stale running jobs older than 30 minutes
  // ----------------------------------------------------------

  await env.DB.prepare(`
    UPDATE index_jobs
    SET status = 'pending',
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
    SET status = 'running',
        updated_at = unixepoch()
    WHERE id = ?
  `)
    .bind(job.id)
    .run();


  return json({
    ok: true,

    job: {
      ...job,
      status: "running"
    }
  });
}


// ============================================================
// UPDATE INDEX JOB
// ============================================================

async function updateIndexJob(
  env,
  request
) {

  const body =
    await request.json();


  const jobId =
    Number(body.job_id);


  const status =
    body.status || "running";


  await env.DB.prepare(`
    UPDATE index_jobs

    SET
      status = ?,
      total_indexed = COALESCE(?, total_indexed),
      last_message_id = COALESCE(?, last_message_id),
      error = ?,
      updated_at = unixepoch()

    WHERE id = ?
  `)
    .bind(
      status,
      body.total_indexed ?? null,
      body.last_message_id ?? null,
      body.error || "",
      jobId
    )
    .run();


  return json({
    ok: true
  });
}


// ============================================================
// WEBHOOK
// ============================================================

async function webhook(
  env,
  request
) {

  const update =
    await request.json();


  try {

    if (update.message) {

      await handleMessage(
        env,
        update.message
      );
    }


    if (update.channel_post) {

      await handleChannelPost(
        env,
        update.channel_post
      );
    }


    if (update.inline_query) {

      await handleInlineQuery(
        env,
        update.inline_query
      );
    }


    if (update.callback_query) {

      await handleCallbackQuery(
        env,
        update.callback_query
      );
    }

  } catch (error) {

    console.log(
      "Webhook error:",
      error.message
    );
  }


  return json({
    ok: true
  });
}


// ============================================================
// SET WEBHOOK
// ============================================================

async function setWebhook(
  env,
  request
) {

  const url =
    new URL(request.url);


  const webhookURL =
    `${url.origin}/webhook`;


  const result =
    await telegram(
      env,
      "setWebhook",
      {
        url: webhookURL,

        allowed_updates: [
          "message",
          "channel_post",
          "callback_query",
          "inline_query"
        ]
      }
    );


  await setupCommands(
    env
  );


  return json({
    ok: true,
    webhook: webhookURL,
    result
  });
}


// ============================================================
// WEBHOOK INFO
// ============================================================

async function webhookInfo(
  env
) {

  const result =
    await telegram(
      env,
      "getWebhookInfo"
    );


  return json({
    ok: true,
    result
  });
}


// ============================================================
// INDEX STATUS
// ============================================================

async function indexStatus(
  env
) {

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
    jobs:
      jobs.results || []
  });
}


// ============================================================
// CRON CLEANUP
// ============================================================

async function cleanup(
  env
) {

  const now =
    Math.floor(
      Date.now() / 1000
    );


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


  for (
    const row of
    rows.results || []
  ) {

    await safeDelete(
      env,
      row.chat_id,
      row.message_id
    );


    await env.DB.prepare(`
      DELETE FROM delete_queue
      WHERE id = ?
    `)
      .bind(row.id)
      .run();
  }
}


// ============================================================
// FETCH
// ============================================================

export default {

  async fetch(
    request,
    env
  ) {

    try {

      await ensureSchema(
        env
      );


      const url =
        new URL(request.url);


      const path =
        url.pathname;


      // ------------------------------------------------------
      // HOME
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/"
      ) {

        return new Response(
          "Movie Update HD Bot is running.",
          {
            status: 200
          }
        );
      }


      // ------------------------------------------------------
      // SET WEBHOOK
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/setwebhook"
      ) {

        return setWebhook(
          env,
          request
        );
      }


      // ------------------------------------------------------
      // WEBHOOK INFO
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/webhook-info"
      ) {

        return webhookInfo(
          env
        );
      }


      // ------------------------------------------------------
      // TELEGRAM WEBHOOK
      // ------------------------------------------------------

      if (
        request.method === "POST" &&
        path === "/webhook"
      ) {

        return webhook(
          env,
          request
        );
      }


      // ------------------------------------------------------
      // INDEX API
      // ------------------------------------------------------

      if (
        request.method === "POST" &&
        path === "/index"
      ) {

        const secret =
          request.headers.get(
            "X-Index-Secret"
          );


        if (
          secret !==
          env.INDEX_SECRET
        ) {

          return json(
            {
              ok: false,
              error: "Unauthorized"
            },
            401
          );
        }


        return indexAPI(
          env,
          request
        );
      }


      // ------------------------------------------------------
      // INDEX JOB
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/index-job"
      ) {

        const secret =
          request.headers.get(
            "X-Index-Secret"
          );


        if (
          secret !==
          env.INDEX_SECRET
        ) {

          return json(
            {
              ok: false,
              error: "Unauthorized"
            },
            401
          );
        }


        return getIndexJob(
          env
        );
      }


      // ------------------------------------------------------
      // UPDATE INDEX JOB
      // ------------------------------------------------------

      if (
        request.method === "POST" &&
        path === "/index-job/update"
      ) {

        const secret =
          request.headers.get(
            "X-Index-Secret"
          );


        if (
          secret !==
          env.INDEX_SECRET
        ) {

          return json(
            {
              ok: false,
              error: "Unauthorized"
            },
            401
          );
        }


        return updateIndexJob(
          env,
          request
        );
      }


      // ------------------------------------------------------
      // INDEX STATUS
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/index-status"
      ) {

        const secret =
          url.searchParams.get(
            "secret"
          );


        if (
          secret !==
          env.INDEX_SECRET
        ) {

          return json(
            {
              ok: false,
              error: "Unauthorized"
            },
            401
          );
        }


        return indexStatus(
          env
        );
      }


      return new Response(
        "Not Found",
        {
          status: 404
        }
      );

    } catch (error) {

      console.log(
        "Worker error:",
        error.message
      );


      return json(
        {
          ok: false,
          error: error.message
        },
        500
      );
    }
  },


  async scheduled(
    event,
    env,
    ctx
  ) {

    ctx.waitUntil(
      cleanup(env)
    );
  }
};
