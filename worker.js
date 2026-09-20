// ============================================================
// MOVIE UPDATE HD - TELEGRAM MOVIE FILTER BOT
// Cloudflare Workers + D1
// ============================================================

const BOT_NAME = "Movie Update HD";

const JOIN_CHANNEL = "@loot_dells";
const JOIN_URL = "https://t.me/loot_dells";

const SHOPPING_URL = "https://t.me/loot_dells";
const OWNER_URL = "https://t.me/share_kb";
const MOVIE_GROUP_URL = "https://t.me/MovieUpdateHD";

const DELETE_AFTER = 300; // 5 minutes


// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(request, env, ctx) {

    try {

      const url = new URL(request.url);

      // --------------------------------------------------------
      // HOME
      // --------------------------------------------------------

      if (request.method === "GET" && url.pathname === "/") {
        return new Response(
          "Movie Update HD Bot is running.",
          { status: 200 }
        );
      }


      // --------------------------------------------------------
      // WEBHOOK
      // --------------------------------------------------------

      if (request.method === "POST" && url.pathname === "/webhook") {

        const update = await request.json();

        await ensureDatabase(env);

        await handleUpdate(update, env, ctx);

        return json({
          ok: true
        });
      }


      // --------------------------------------------------------
      // SET WEBHOOK
      // --------------------------------------------------------

      if (request.method === "GET" && url.pathname === "/setwebhook") {

        const result = await telegram(
          env,
          "setWebhook",
          {
            url: `${url.origin}/webhook`,
            allowed_updates: [
              "message",
              "channel_post",
              "callback_query"
            ]
          }
        );

        return json(result);
      }


      // --------------------------------------------------------
      // WEBHOOK INFO
      // --------------------------------------------------------

      if (request.method === "GET" && url.pathname === "/webhook-info") {

        const result = await telegram(
          env,
          "getWebhookInfo",
          {}
        );

        return json(result);
      }


      // --------------------------------------------------------
      // DATABASE INIT
      // --------------------------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/init-db"
      ) {

        await ensureDatabase(env);

        return json({
          ok: true,
          message: "Database initialized."
        });
      }


      // --------------------------------------------------------
      // INDEX API
      // --------------------------------------------------------

      if (
        request.method === "POST" &&
        url.pathname === "/index"
      ) {

        const secret = request.headers.get("X-Index-Secret");

        if (!env.INDEX_SECRET || secret !== env.INDEX_SECRET) {
          return json(
            {
              ok: false,
              error: "Unauthorized"
            },
            401
          );
        }

        const body = await request.json();

        const result = await indexMovie(
          body,
          env
        );

        return json({
          ok: true,
          result
        });
      }


      // --------------------------------------------------------
      // INDEX STATUS
      // --------------------------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/index-status"
      ) {

        const secret = request.headers.get("X-Index-Secret");

        if (!env.INDEX_SECRET || secret !== env.INDEX_SECRET) {
          return json(
            {
              ok: false,
              error: "Unauthorized"
            },
            401
          );
        }

        const result = await env.DB.prepare(`
          SELECT
            COUNT(*) AS total
          FROM movies
        `).first();

        return json({
          ok: true,
          total: Number(result?.total || 0)
        });
      }


      // --------------------------------------------------------
      // INDEX JOB
      // --------------------------------------------------------

      if (
        request.method === "POST" &&
        url.pathname === "/index-job"
      ) {

        const secret = request.headers.get("X-Index-Secret");

        if (!env.INDEX_SECRET || secret !== env.INDEX_SECRET) {
          return json(
            {
              ok: false,
              error: "Unauthorized"
            },
            401
          );
        }

        const body = await request.json();

        const result = await createIndexJob(
          body,
          env
        );

        return json({
          ok: true,
          result
        });
      }


      // --------------------------------------------------------
      // INDEX JOB UPDATE
      // --------------------------------------------------------

      if (
        request.method === "POST" &&
        url.pathname === "/index-job/update"
      ) {

        const secret = request.headers.get("X-Index-Secret");

        if (!env.INDEX_SECRET || secret !== env.INDEX_SECRET) {
          return json(
            {
              ok: false,
              error: "Unauthorized"
            },
            401
          );
        }

        const body = await request.json();

        const result = await updateIndexJob(
          body,
          env
        );

        return json({
          ok: true,
          result
        });
      }


      return new Response(
        "Not Found",
        {
          status: 404
        }
      );

    } catch (error) {

      console.error(
        "WORKER ERROR:",
        error?.stack || error
      );

      return json(
        {
          ok: false,
          error: String(error?.message || error)
        },
        500
      );
    }
  },


  // ==========================================================
  // CRON
  // ==========================================================

  async scheduled(event, env, ctx) {

    ctx.waitUntil(
      cleanupDeletedMessages(env)
    );

  }
};


// ============================================================
// DATABASE
// ============================================================

async function ensureDatabase(env) {

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
      CREATE INDEX IF NOT EXISTS idx_group_sources_source
      ON group_sources(source_channel_id)
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
    `),

    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_delete_queue_time
      ON delete_queue(delete_at)
    `)

  ]);

  // ----------------------------------------------------------
  // Migration for old database
  // ----------------------------------------------------------

  try {

    const columns = await env.DB
      .prepare(`PRAGMA table_info(movies)`)
      .all();

    const names = (columns.results || [])
      .map(x => x.name);

    if (!names.includes("source_username")) {

      await env.DB.prepare(`
        ALTER TABLE movies
        ADD COLUMN source_username TEXT DEFAULT ''
      `).run();

    }

  } catch (error) {

    console.log(
      "Migration note:",
      error?.message || error
    );

  }
}


// ============================================================
// TELEGRAM API
// ============================================================

async function telegram(env, method, payload = {}) {

  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",

      headers: {
        "content-type": "application/json"
      },

      body: JSON.stringify(payload)
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Telegram returned invalid JSON for ${method}: ${text}`
    );
  }

  if (!data.ok) {

    throw new Error(
      `Telegram API ${method} failed: ${JSON.stringify(data)}`
    );
  }

  return data.result;
}


// ============================================================
// UPDATE HANDLER
// ============================================================

async function handleUpdate(update, env, ctx) {

  // ----------------------------------------------------------
  // Channel post
  // ----------------------------------------------------------

  if (update.channel_post) {

    await handleChannelPost(
      update.channel_post,
      env
    );

    return;
  }


  // ----------------------------------------------------------
  // Callback
  // ----------------------------------------------------------

  if (update.callback_query) {

    await handleCallback(
      update.callback_query,
      env
    );

    return;
  }


  // ----------------------------------------------------------
  // Message
  // ----------------------------------------------------------

  if (update.message) {

    await handleMessage(
      update.message,
      env,
      ctx
    );

    return;
  }
}


// ============================================================
// MESSAGE HANDLER
// ============================================================

async function handleMessage(message, env, ctx) {

  const chat = message.chat;
  const from = message.from;

  if (!chat || !from) return;

  await saveUser(
    from,
    env
  );


  // ----------------------------------------------------------
  // Private / Group start
  // ----------------------------------------------------------

  if (message.text?.startsWith("/start")) {

    const parts = message.text.trim().split(/\s+/);

    const payload = parts[1] || "";

    if (
      payload.startsWith("movie_") &&
      chat.type === "private"
    ) {

      const movieId = Number(
        payload.replace("movie_", "")
      );

      if (Number.isInteger(movieId) && movieId > 0) {

        await handleMovieStart(
          message,
          movieId,
          env
        );

        return;
      }
    }

    await startCommand(
      message,
      env
    );

    return;
  }


  // ----------------------------------------------------------
  // Help
  // ----------------------------------------------------------

  if (isCommand(message.text, "/help")) {

    await helpCommand(
      message,
      env
    );

    return;
  }


  // ----------------------------------------------------------
  // About
  // ----------------------------------------------------------

  if (isCommand(message.text, "/about")) {

    await aboutCommand(
      message,
      env
    );

    return;
  }


  // ----------------------------------------------------------
  // Source
  // ----------------------------------------------------------

  if (isCommand(message.text, "/source")) {

    await sourceCommand(
      message,
      env
    );

    return;
  }


  // ----------------------------------------------------------
  // Set source
  // ----------------------------------------------------------

  if (isCommand(message.text, "/setsource")) {

    await setSourceCommand(
      message,
      env
    );

    return;
  }


  // ----------------------------------------------------------
  // Remove source
  // ----------------------------------------------------------

  if (isCommand(message.text, "/removesource")) {

    await removeSourceCommand(
      message,
      env
    );

    return;
  }


  // ----------------------------------------------------------
  // Group text search
  // ----------------------------------------------------------

  if (
    chat.type === "group" ||
    chat.type === "supergroup"
  ) {

    if (
      message.text &&
      !message.text.startsWith("/")
    ) {

      await searchMoviesInGroup(
        message,
        env
      );

      return;
    }
  }
}


// ============================================================
// START
// ============================================================

async function startCommand(message, env) {

  const text = `
<b>🎬 ${BOT_NAME}</b>

<b>Welcome to Movie Update HD!</b>

<b>🔎 Search movies directly in your group.</b>

<b>📂 Each group can have its own Source Channel.</b>

<b>⚡ Fast movie delivery</b>

<b>🗑️ Messages and delivered movies are automatically deleted after 5 minutes.</b>

<b>Use the buttons below to get started.</b>
`;

  const keyboard = {
    inline_keyboard: [

      [
        {
          text: "🔎 SEARCH MOVIES",
          url: MOVIE_GROUP_URL
        }
      ],

      [
        {
          text: "❓ HELP",
          callback_data: "help"
        },
        {
          text: "🔗 REFERRAL",
          callback_data: "referral"
        }
      ],

      [
        {
          text: "👑 OWNER",
          url: OWNER_URL
        },
        {
          text: "📢 MOVIE GROUP",
          url: MOVIE_GROUP_URL
        }
      ],

      [
        {
          text: "🛍️ AMAZON & FLIPKART OFFERS",
          url: SHOPPING_URL
        }
      ]

    ]
  };

  await telegram(
    env,
    "sendMessage",
    {
      chat_id: message.chat.id,
      text,
      parse_mode: "HTML",
      reply_markup: keyboard
    }
  );
}


// ============================================================
// HELP
// ============================================================

async function helpCommand(message, env) {

  const text = `
<b>❓ ${BOT_NAME} HELP</b>

<b>🔎 Search</b>
Send the movie name in a configured group.

<b>⚙️ Source Channel</b>
Group administrators can use:

<b>/setsource @ChannelUsername</b>

<b>/source</b>

<b>/removesource</b>

<b>📌 Important</b>
The bot only searches the Source Channel configured for that group.

<b>🗑️ Auto Delete</b>
Search results and delivered movies are automatically deleted after 5 minutes.
`;

  await sendTempMessage(
    message.chat.id,
    text,
    env,
    {}
  );
}


// ============================================================
// ABOUT
// ============================================================

async function aboutCommand(message, env) {

  const text = `
<b>ℹ️ ABOUT ${BOT_NAME}</b>

<b>Movie Update HD</b> is a Telegram movie search and delivery bot.

<b>⚡ Fast Search</b>
<b>📂 Group-wise Source</b>
<b>🎬 Movie Delivery</b>
<b>🗑️ 5 Minute Auto Delete</b>

<b>Powered by Movie Update HD</b>
`;

  await sendTempMessage(
    message.chat.id,
    text,
    env,
    {}
  );
}


// ============================================================
// SOURCE COMMAND
// ============================================================

async function sourceCommand(message, env) {

  if (
    message.chat.type !== "group" &&
    message.chat.type !== "supergroup"
  ) {

    await sendTempMessage(
      message.chat.id,
      `<b>⚙️ SOURCE SETTINGS</b>

<b>This command must be used inside a group.</b>`,
      env,
      {}
    );

    return;
  }

  const source = await getGroupSource(
    message.chat.id,
    env
  );

  if (!source) {

    await sendTempMessage(
      message.chat.id,
      `<b>⚙️ SOURCE CHANNEL</b>

<b>❌ No Source Channel is configured for this group.</b>

<b>Admin can set one using:</b>

<b>/setsource @ChannelUsername</b>`,
      env,
      {}
    );

    return;
  }

  const username = source.source_username
    ? `@${source.source_username.replace("@", "")}`
    : source.source_channel_id;

  const text = `
<b>⚙️ SOURCE CHANNEL</b>

<b>📢 Channel:</b> ${escapeHTML(username)}

<b>📌 Title:</b> ${escapeHTML(source.source_title || "Unknown")}

<b>🟢 Status:</b> Active
`;

  await sendTempMessage(
    message.chat.id,
    text,
    env,
    {}
  );
}


// ============================================================
// SET SOURCE
// ============================================================

async function setSourceCommand(message, env) {

  if (
    message.chat.type !== "group" &&
    message.chat.type !== "supergroup"
  ) {

    await sendTempMessage(
      message.chat.id,
      `<b>❌ This command can only be used in a group.</b>`,
      env,
      {}
    );

    return;
  }


  const isAdmin = await isGroupAdmin(
    message.chat.id,
    message.from.id,
    env
  );

  if (!isAdmin) {

    await sendTempMessage(
      message.chat.id,
      `<b>❌ ADMIN ONLY</b>

<b>Only group administrators can change the Source Channel.</b>`,
      env,
      {}
    );

    return;
  }


  const parts = (message.text || "")
    .trim()
    .split(/\s+/);

  if (!parts[1]) {

    await sendTempMessage(
      message.chat.id,
      `<b>⚙️ SET SOURCE CHANNEL</b>

<b>Usage:</b>

<b>/setsource @ChannelUsername</b>

<b>Example:</b>

<b>/setsource @MovieUpdateHD</b>`,
      env,
      {}
    );

    return;
  }


  let sourceInput = parts[1].trim();

  if (
    !sourceInput.startsWith("@") &&
    !sourceInput.startsWith("-100")
  ) {

    sourceInput = "@" + sourceInput;
  }


  let sourceChat;

  try {

    sourceChat = await telegram(
      env,
      "getChat",
      {
        chat_id: sourceInput
      }
    );

  } catch (error) {

    await sendTempMessage(
      message.chat.id,
      `<b>❌ SOURCE CHANNEL NOT FOUND</b>

<b>Telegram could not access:</b>

<code>${escapeHTML(sourceInput)}</code>

<b>Make sure:</b>
<b>1. The username is correct.</b>
<b>2. The bot is an administrator in the channel.</b>`,
      env,
      {}
    );

    return;
  }


  if (sourceChat.type !== "channel") {

    await sendTempMessage(
      message.chat.id,
      `<b>❌ INVALID SOURCE</b>

<b>Please provide a Telegram Channel.</b>`,
      env,
      {}
    );

    return;
  }


  const sourceChannelId = String(
    sourceChat.id
  );

  const sourceUsername =
    sourceChat.username || "";

  const sourceTitle =
    sourceChat.title || "";


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
    String(message.chat.id),
    message.chat.title || "",
    sourceChannelId,
    sourceUsername,
    sourceTitle
  )
  .run();


  await createIndexJob(
    {
      chat_id: String(message.chat.id),
      source_channel_id: sourceChannelId,
      source_username: sourceUsername,
      source_title: sourceTitle
    },
    env
  );


  const displaySource =
    sourceUsername
      ? `@${sourceUsername}`
      : sourceTitle;


  const text = `
<b>✅ SOURCE CHANNEL SET</b>

<b>📢 Channel:</b> ${escapeHTML(displaySource)}

<b>📌 Title:</b> ${escapeHTML(sourceTitle)}

<b>🟢 Status:</b> Active

<b>📥 New posts will be indexed automatically.</b>

<b>⚠️ Old channel history requires the separate Indexer service.</b>
`;

  await sendTempMessage(
    message.chat.id,
    text,
    env,
    {}
  );
}


// ============================================================
// REMOVE SOURCE
// ============================================================

async function removeSourceCommand(message, env) {

  if (
    message.chat.type !== "group" &&
    message.chat.type !== "supergroup"
  ) {
    return;
  }


  const isAdmin = await isGroupAdmin(
    message.chat.id,
    message.from.id,
    env
  );

  if (!isAdmin) {

    await sendTempMessage(
      message.chat.id,
      `<b>❌ ADMIN ONLY</b>

<b>Only group administrators can remove the Source Channel.</b>`,
      env,
      {}
    );

    return;
  }


  await env.DB.prepare(`
    DELETE FROM group_sources
    WHERE chat_id = ?
  `)
  .bind(String(message.chat.id))
  .run();


  await sendTempMessage(
    message.chat.id,
    `<b>✅ SOURCE REMOVED</b>

<b>This group no longer has a Source Channel configured.</b>`,
    env,
    {}
  );
}


// ============================================================
// GROUP SEARCH
// ============================================================

async function searchMoviesInGroup(message, env) {

  const searchText = (message.text || "")
    .trim();

  if (!searchText) return;


  const source = await getGroupSource(
    message.chat.id,
    env
  );


  if (!source) {

    await sendTempMessage(
      message.chat.id,
      `<b>⚠️ SOURCE CHANNEL NOT SET</b>

<b>This group does not have a Source Channel yet.</b>

<b>Ask an administrator to use:</b>

<b>/setsource @ChannelUsername</b>`,
      env,
      {}
    );

    return;
  }


  const searchWords = searchText
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);


  let query = `
    SELECT *
    FROM movies
    WHERE channel_id = ?
  `;

  const params = [
    source.source_channel_id
  ];


  for (const word of searchWords) {

    query += `
      AND LOWER(title) LIKE ?
    `;

    params.push(
      `%${word}%`
    );
  }


  query += `
    ORDER BY id DESC
    LIMIT 10
  `;


  const result = await env.DB
    .prepare(query)
    .bind(...params)
    .all();


  const movies = result.results || [];


  if (!movies.length) {

    await sendTempMessage(
      message.chat.id,
      `<b>❌ MOVIE NOT FOUND</b>

<b>🔎 Search:</b> ${escapeHTML(searchText)}

<b>No matching movie was found in this group's Source Channel.</b>`,
      env,
      {}
    );

    return;
  }


  const botInfo = await telegram(
    env,
    "getMe",
    {}
  );


  const botUsername =
    botInfo.username;


  const rows = movies.map(
    movie => [
      {
        text:
          `🎬 ${movie.title}`.slice(0, 64),

        url:
          `https://t.me/${botUsername}?start=movie_${movie.id}`
      }
    ]
  );


  const text = `
<b>🎬 SEARCH RESULTS</b>

<b>🔎 ${escapeHTML(searchText)}</b>

<b>📌 Found ${movies.length} result(s)</b>

<b>🛍️ AMAZON &amp; FLIPKART OFFERS</b>

<b>👇 Select a movie below:</b>

<b>⏱️ This message will be deleted automatically after 5 minutes.</b>
`;


  await sendTempMessage(
    message.chat.id,
    text,
    env,
    {
      inline_keyboard: rows
    }
  );
}


// ============================================================
// MOVIE START / DELIVERY
// ============================================================

async function handleMovieStart(
  message,
  movieId,
  env
) {

  const userId =
    message.from.id;


  const joined =
    await isUserJoined(
      userId,
      env
    );


  if (!joined) {

    const text = `
<b>🔐 JOIN REQUIRED</b>

<b>Please join our channel before receiving the movie.</b>

<b>After joining, press CHECK JOINED.</b>
`;

    const keyboard = {
      inline_keyboard: [

        [
          {
            text: "📢 JOIN CHANNEL",
            url: JOIN_URL
          }
        ],

        [
          {
            text: "✅ CHECK JOINED",
            callback_data: `checkjoin_${movieId}`
          }
        ]

      ]
    };


    await telegram(
      env,
      "sendMessage",
      {
        chat_id: message.chat.id,
        text,
        parse_mode: "HTML",
        reply_markup: keyboard
      }
    );

    return;
  }


  await deliverMovie(
    message.chat.id,
    movieId,
    env
  );
}


// ============================================================
// DELIVER MOVIE
// ============================================================

async function deliverMovie(
  chatId,
  movieId,
  env
) {

  const movie = await env.DB
    .prepare(`
      SELECT *
      FROM movies
      WHERE id = ?
      LIMIT 1
    `)
    .bind(movieId)
    .first();


  if (!movie) {

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `<b>❌ MOVIE NOT FOUND</b>\n\n<b>This movie record no longer exists.</b>`,
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
          chat_id: chatId,
          from_chat_id: movie.channel_id,
          message_id: movie.message_id
        }
      );


    await queueDelete(
      chatId,
      copied.message_id,
      env
    );


    const warning =
      await telegram(
        env,
        "sendMessage",
        {
          chat_id: chatId,

          text: `
<b>🎬 MOVIE READY</b>

<b>${escapeHTML(movie.title)}</b>

<b>⏱️ This movie will be automatically deleted after 5 minutes.</b>
`,

          parse_mode: "HTML"
        }
      );


    await queueDelete(
      chatId,
      warning.message_id,
      env
    );


  } catch (error) {

    console.error(
      "MOVIE DELIVERY ERROR:",
      error?.stack || error
    );


    const failed =
      await telegram(
        env,
        "sendMessage",
        {
          chat_id: chatId,

          text: `
<b>❌ MOVIE DELIVERY FAILED</b>

<b>The movie could not be delivered right now.</b>

<b>Please try again later.</b>
`,

          parse_mode: "HTML"
        }
      );


    await queueDelete(
      chatId,
      failed.message_id,
      env
    );
  }
}


// ============================================================
// JOIN CHECK
// ============================================================

async function isUserJoined(
  userId,
  env
) {

  try {

    const member =
      await telegram(
        env,
        "getChatMember",
        {
          chat_id: JOIN_CHANNEL,
          user_id: userId
        }
      );


    return [
      "creator",
      "administrator",
      "member"
    ].includes(member.status);

  } catch (error) {

    console.error(
      "JOIN CHECK ERROR:",
      error?.message || error
    );

    return false;
  }
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

  const userId =
    callback.from?.id;


  await telegram(
    env,
    "answerCallbackQuery",
    {
      callback_query_id:
        callback.id
    }
  );


  if (data === "help") {

    await helpCommand(
      {
        chat: callback.message.chat
      },
      env
    );

    return;
  }


  if (data === "referral") {

    const text = `
<b>🔗 REFERRAL</b>

<b>Invite your friends to use ${BOT_NAME}.</b>

<b>More referral features can be added later.</b>
`;

    await sendTempMessage(
      chatId,
      text,
      env,
      {}
    );

    return;
  }


  if (data.startsWith("checkjoin_")) {

    const movieId =
      Number(
        data.replace("checkjoin_", "")
      );


    const joined =
      await isUserJoined(
        userId,
        env
      );


    if (!joined) {

      await telegram(
        env,
        "sendMessage",
        {
          chat_id: chatId,

          text: `
<b>❌ NOT JOINED YET</b>

<b>Please join the channel first, then press CHECK JOINED again.</b>
`,

          parse_mode: "HTML"
        }
      );

      return;
    }


    await deliverMovie(
      chatId,
      movieId,
      env
    );

    return;
  }
}


// ============================================================
// CHANNEL POST AUTO INDEX
// ============================================================

async function handleChannelPost(
  post,
  env
) {

  const channelId =
    String(post.chat.id);


  const source =
    await env.DB
      .prepare(`
        SELECT *
        FROM group_sources
        WHERE source_channel_id = ?
        LIMIT 1
      `)
      .bind(channelId)
      .first();


  // If no group uses this source, still index the movie.
  // This allows another group to configure it later.

  const title =
    extractMovieTitle(post);


  if (!title) {
    return;
  }


  await indexMovie(
    {
      title,
      language: "",
      quality: extractQuality(post),
      size: extractSize(post),
      poster: extractPoster(post),
      channel_id: channelId,
      message_id: post.message_id,
      source_username:
        post.chat.username || ""
    },
    env
  );
}


// ============================================================
// MOVIE INDEX
// ============================================================

async function indexMovie(
  data,
  env
) {

  if (
    !data.title ||
    !data.channel_id ||
    !data.message_id
  ) {

    throw new Error(
      "Missing title, channel_id or message_id"
    );
  }


  // Prevent exact duplicate
  const existing =
    await env.DB
      .prepare(`
        SELECT id
        FROM movies
        WHERE channel_id = ?
        AND message_id = ?
        LIMIT 1
      `)
      .bind(
        String(data.channel_id),
        Number(data.message_id)
      )
      .first();


  if (existing) {

    await env.DB.prepare(`
      UPDATE movies
      SET
        title = ?,
        language = ?,
        quality = ?,
        size = ?,
        poster = ?,
        source_username = ?
      WHERE id = ?
    `)
    .bind(
      cleanTitle(data.title),
      data.language || "",
      data.quality || "",
      data.size || "",
      data.poster || "",
      data.source_username || "",
      existing.id
    )
    .run();


    return {
      id: existing.id,
      updated: true
    };
  }


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
      cleanTitle(data.title),
      data.language || "",
      data.quality || "",
      data.size || "",
      data.poster || "",
      String(data.channel_id),
      Number(data.message_id),
      data.source_username || ""
    )
    .run();


  return {
    id: result.meta.last_row_id,
    created: true
  };
}


// ============================================================
// INDEX JOB
// ============================================================

async function createIndexJob(
  data,
  env
) {

  if (
    !data.chat_id ||
    !data.source_channel_id
  ) {

    return {
      created: false
    };
  }


  const result =
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
      String(data.chat_id),
      String(data.source_channel_id),
      data.source_username || "",
      data.source_title || ""
    )
    .run();


  return {
    id: result.meta.last_row_id
  };
}


// ============================================================
// UPDATE INDEX JOB
// ============================================================

async function updateIndexJob(
  data,
  env
) {

  if (!data.id) {

    throw new Error(
      "Job ID is required"
    );
  }


  await env.DB.prepare(`
    UPDATE index_jobs
    SET
      status = COALESCE(?, status),
      total_indexed = COALESCE(?, total_indexed),
      last_message_id = COALESCE(?, last_message_id),
      error = COALESCE(?, error),
      updated_at = unixepoch()
    WHERE id = ?
  `)
  .bind(
    data.status ?? null,
    data.total_indexed ?? null,
    data.last_message_id ?? null,
    data.error ?? null,
    data.id
  )
  .run();


  return {
    updated: true
  };
}


// ============================================================
// GROUP SOURCE
// ============================================================

async function getGroupSource(
  chatId,
  env
) {

  return await env.DB
    .prepare(`
      SELECT *
      FROM group_sources
      WHERE chat_id = ?
      LIMIT 1
    `)
    .bind(String(chatId))
    .first();
}


// ============================================================
// ADMIN CHECK
// ============================================================

async function isGroupAdmin(
  chatId,
  userId,
  env
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

  } catch {

    return false;
  }
}


// ============================================================
// SAVE USER
// ============================================================

async function saveUser(
  user,
  env
) {

  try {

    await env.DB.prepare(`
      INSERT INTO users
      (
        telegram_id,
        username,
        first_name
      )
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

    console.error(
      "SAVE USER ERROR:",
      error?.message || error
    );
  }
}


// ============================================================
// TEMP MESSAGE
// ============================================================

async function sendTempMessage(
  chatId,
  text,
  env,
  replyMarkup = {}
) {

  const isGroup =
    String(chatId).startsWith("-");


  let finalMarkup =
    replyMarkup;


  if (isGroup) {

    const existingRows =
      finalMarkup?.inline_keyboard || [];


    finalMarkup = {

      inline_keyboard: [

        [
          {
            text: "🔗 CLICK HERE",
            url: SHOPPING_URL
          }
        ],

        ...existingRows

      ]

    };
  }


  const result =
    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        reply_markup: finalMarkup
      }
    );


  await queueDelete(
    chatId,
    result.message_id,
    env
  );


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

  const deleteAt =
    Math.floor(Date.now() / 1000)
    + DELETE_AFTER;


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
    deleteAt
  )
  .run();
}


// ============================================================
// CLEANUP
// ============================================================

async function cleanupDeletedMessages(
  env
) {

  const now =
    Math.floor(Date.now() / 1000);


  const result =
    await env.DB.prepare(`
      SELECT *
      FROM delete_queue
      WHERE delete_at <= ?
      ORDER BY id
      LIMIT 100
    `)
    .bind(now)
    .all();


  const rows =
    result.results || [];


  for (const row of rows) {

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

      console.log(
        "DELETE MESSAGE ERROR:",
        error?.message || error
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
// TITLE EXTRACTION
// ============================================================

function extractMovieTitle(
  post
) {

  const text =
    post.caption ||
    post.text ||
    "";


  if (text.trim()) {

    const firstLine =
      text
        .split(/\r?\n/)
        .map(x => x.trim())
        .find(Boolean);


    if (firstLine) {

      return cleanTitle(
        firstLine
      );
    }
  }


  if (post.document?.file_name) {
    return cleanTitle(
      post.document.file_name
    );
  }


  if (post.video?.file_name) {
    return cleanTitle(
      post.video.file_name
    );
  }


  return "";
}


// ============================================================
// QUALITY EXTRACTION
// ============================================================

function extractQuality(
  post
) {

  const text =
    post.caption ||
    post.text ||
    post.document?.file_name ||
    post.video?.file_name ||
    "";


  const match =
    text.match(
      /(2160p|1440p|1080p|720p|480p|360p)/i
    );


  return match
    ? match[1]
    : "";
}


// ============================================================
// SIZE EXTRACTION
// ============================================================

function extractSize(
  post
) {

  const text =
    post.caption ||
    post.text ||
    post.document?.file_name ||
    post.video?.file_name ||
    "";


  const match =
    text.match(
      /\b\d+(?:\.\d+)?\s*(?:GB|MB|KB)\b/i
    );


  return match
    ? match[0]
    : "";
}


// ============================================================
// POSTER
// ============================================================

function extractPoster(
  post
) {

  if (
    post.photo &&
    post.photo.length
  ) {

    return post.photo[
      post.photo.length - 1
    ].file_id;
  }


  return "";
}


// ============================================================
// CLEAN TITLE
// ============================================================

function cleanTitle(
  value
) {

  return String(value || "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}


// ============================================================
// COMMAND CHECK
// ============================================================

function isCommand(
  text,
  command
) {

  if (!text) return false;

  return (
    text === command ||
    text.startsWith(command + " ")
  );
}


// ============================================================
// HTML ESCAPE
// ============================================================

function escapeHTML(
  value
) {

  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8"
      }
    }
  );
}
