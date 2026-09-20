// ============================================================
// START MENU
// ============================================================

async function sendStart(env, chatId) {
  const me = await telegram(env, "getMe", {});

  const username = me.ok && me.result?.username
    ? me.result.username
    : "";

  const addGroupURL = username
    ? `https://t.me/${username}?startgroup=true`
    : "https://t.me";


  const text =
`<b>🎬 MOVIE UPDATE HD</b>

<b>🔎 Search Movies Fast</b>

<b>📢 Connect Your Source Channel</b>

<b>⚡ Fast Movie Search</b>

<b>🎥 Movie Delivery Bot</b>

<b>👥 Multi-Group Support</b>

<b>🔗 Original Source Movies</b>`;


  const keyboard = {
    inline_keyboard: [

      // ADD ME TO GROUP
      [
        {
          text: "➕ ADD ME TO GROUP",
          url: addGroupURL
        }
      ],

      // SEARCH MOVIES
      [
        {
          text: "🔎 SEARCH MOVIES",
          callback_data: "menu_search"
        }
      ],

      // SOURCE + SET SOURCE
      [
        {
          text: "📢 SOURCE",
          callback_data: "menu_source"
        },
        {
          text: "⚙️ SET SOURCE",
          callback_data: "menu_setsource"
        }
      ],

      // HELP + ABOUT
      [
        {
          text: "❓ HELP",
          callback_data: "menu_help"
        },
        {
          text: "✨ ABOUT",
          callback_data: "menu_about"
        }
      ],

      // SHOPPING OFFERS
      [
        {
          text: "🛍️ SHOPPING OFFERS",
          url: SHOPPING_URL
        }
      ],

      // OWNER
      [
        {
          text: "👑 OWNER",
          url: "https://t.me/share_kb"
        }
      ]

    ]
  };


  await sendTempMessage(
    env,
    chatId,
    text,
    keyboard
  );
}
