# Queue Bridge

A [TidaLuna](https://github.com/Inrixia/TidaLuna) plugin that lets your Twitch chat request songs for your Tidal queue, using [Streamer.bot](https://streamer.bot) as the bridge.

A viewer types `!sr <song>` in chat, the plugin finds the track on Tidal, adds it to the end of your current queue (not a playlist), and the bot replies in chat with the song and its position.

```
@viewer: !sr adidas the summer set
Bot:     @viewer, added ADIDAS - The Summer Set to the queue at #3 https://tidal.com/browse/track/422949270
```

---

## Features

- **`!sr` and `!songrequest` commands** read straight from Twitch chat.
- **Flexible requests.** Accepts `Artist - Title`, `Title by Artist`, plain search text, or a YouTube link (the video title is looked up and searched on Tidal).
- **Adds to the end of your current queue** so requests play in the order they came in, without touching your playlists.
- **Chat replies** with the song name, its queue position and a Tidal link.
- **Per-viewer cooldown**, adjustable in seconds from Tidal's plugin settings. Mods and the broadcaster are exempt.
- **Duplicate protection.** The same chat message is never queued twice.
- **Best-match search.** Fetches the top Tidal results and picks the one that best matches the request words.
- **Automatic reconnection** to Streamer.bot if the connection drops.
- **Optional WebSocket password** support.

---

## Requirements

| Requirement | Notes |
| --- | --- |
| Tidal desktop app with [TidaLuna](https://github.com/Inrixia/TidaLuna) installed | You must be logged in to Tidal. |
| [Streamer.bot](https://streamer.bot) | Connected to your Twitch account, running on the same PC as Tidal. |
| Streamer.bot WebSocket Server enabled | Default address `127.0.0.1`, port `8080`. |

---

## Installation

1. Install TidaLuna into your Tidal desktop app if you haven't already.
2. Add the **Queue Bridge** plugin through TidaLuna's plugin store, using the plugin URL from this repository's releases. See the TidaLuna documentation for the exact steps for your version.
3. Enable the plugin and open its settings (the cog icon) to check the port and cooldown (see [Settings](#settings)).

---

## Streamer.bot setup

Streamer.bot has two jobs here: it forwards chat messages to the plugin, and it posts the plugin's replies back to chat. You do **not** need a C# script or a `!sr` command.

### 1. Enable the WebSocket server

1. In Streamer.bot, go to **Servers/Clients > WebSocket Server**.
2. Set the address to `127.0.0.1` and the port to `8080` (or your own port, then update it in the plugin settings).
3. Tick **Auto Start** and click **Start Server**.
4. If you set a password, enter the same one in the plugin settings.

### 2. Create the reply action

The plugin posts chat replies by running a Streamer.bot action, so create one named **exactly**:

```
Queue Bridge Reply
```

Add a single sub-action:

- **Twitch > Chat > Send Message**
- Message text: `%message%`

No triggers are needed, because the plugin calls the action directly.

### 3. Remove any old `!sr` command

If you previously had a `!sr` command or action in Streamer.bot (for example one that used a C# script), disable it. The plugin reads `!sr` straight from chat, so an old command would cause duplicate or "usage" replies.

---

## Usage

| Chat message | What happens |
| --- | --- |
| `!sr adidas the summer set` | Searches Tidal for the words and queues the best match. |
| `!sr The Summer Set - ADIDAS` | `Artist - Title` format. |
| `!sr ADIDAS by The Summer Set` | `Title by Artist` is converted to `Artist - Title`. |
| `!sr https://www.youtube.com/watch?v=...` | Looks up the video title, tidies it up and searches Tidal for it. |
| `!songrequest <song>` | Alias for `!sr`. |

Tags such as `(Official Video)`, `[Lyric Video]`, `(Audio)`, `(HD)`, `(4K)`, `(Remastered)` and `(Visualizer)` are stripped before searching.

### Chat replies

| Situation | Reply |
| --- | --- |
| Queued, position known | `@viewer, added Song - Artist to the queue at #3 https://tidal.com/browse/track/...` |
| Queued as the next song | `... to the queue at #1 (playing next) ...` |
| Queued, position unavailable | `@viewer, added Song - Artist to the queue https://tidal.com/browse/track/...` |
| Nothing found | `❌ @viewer Could not find '<search>' on Tidal.` |
| Unreadable request | `❌ @viewer Could not parse a valid track name.` |
| Unexpected error | `❌ @viewer Something went wrong queueing that song.` |

Position `#1` means the song plays **next**. The currently playing track is not counted.

---

## Settings

Open Tidal's plugin settings and click the cog icon on **Queue Bridge**.

| Setting | Default | Description |
| --- | --- | --- |
| Streamer.bot WebSocket Port | `8080` | Port of the Streamer.bot WebSocket server. Reload the plugin after changing it. |
| Request Cooldown (seconds) | `10` | Minimum time between requests from the same viewer. Use `0` to disable. Mods and the broadcaster are exempt. Takes effect immediately. |
| Streamer.bot WebSocket Password | *(blank)* | Only needed if your Streamer.bot WebSocket server has a password. Reload the plugin after changing it. |

### Options in the source

A few options live at the top of `index.ts` rather than in the settings panel:

| Constant | Default | Description |
| --- | --- | --- |
| `COMMANDS` | `["!sr", "!songrequest"]` | Chat commands that trigger a request. |
| `REPLY_ACTION_NAME` | `"Queue Bridge Reply"` | Name of the Streamer.bot action used for replies. |
| `QUEUE_MODE` | `"last"` | `"last"` adds to the end of the queue, `"next"` adds after the current track. |
| `INCLUDE_TRACK_LINK` | `true` | Appends a Tidal link to chat replies. Set to `false` if links are blocked in your chat. |
| `SEARCH_LIMIT` | `5` | How many Tidal results are considered when picking the best match. |

---

## How it works

```
Twitch chat
    │  !sr <song>
    ▼
Streamer.bot  ──(WebSocket: ChatMessage event)──►  Queue Bridge plugin (inside Tidal)
    ▲                                                   │
    │                                                   │ 1. clean up the request
    │                                                   │ 2. search Tidal, pick the best match
    │                                                   │ 3. add the track to the queue
    │                                                   ▼
    └──(WebSocket: run "Queue Bridge Reply")────────────┘
         posts the reply in Twitch chat
```

1. The plugin connects to Streamer.bot's WebSocket server and subscribes to Twitch `ChatMessage` events.
2. When a message starts with `!sr` or `!songrequest`, the request is cleaned up (YouTube links resolved, tags stripped, `Title by Artist` reordered).
3. The plugin searches Tidal using your own logged-in session and picks the best match.
4. It adds the track's ID to the end of Tidal's play queue.
5. It works out the track's position in the queue and asks Streamer.bot to run the `Queue Bridge Reply` action to post the result in chat.

If adding to the end of the queue has no effect, the plugin falls back to adding the track after the current song, so a request is never lost.

---

## Troubleshooting

**Nothing happens when I type `!sr`**
- Check Streamer.bot is running, connected to Twitch, and the WebSocket server is started.
- Check the port in the plugin settings matches the one in Streamer.bot.
- Open Tidal's developer console and look for `[QueueBridge] Connected to Streamer.bot WebSocket!`. If you only see "Connecting..." or errors, the server isn't reachable.

**The song queues but there is no reply in chat**
- Check the action is named exactly `Queue Bridge Reply`, is enabled, and has a Send Message sub-action with `%message%`.
- Look at Streamer.bot's Log tab for an "action not found" message.

**Replies appear twice, or I get a usage message**
- An old `!sr` command or action is still enabled in Streamer.bot. Disable it.

**The reply has no queue position**
- Tidal had no active queue, which happens when you've just opened the app and nothing has played. Start playing any song and the position will appear for later requests.

**Tidal won't let me press play after the first request**
- If nothing was playing when the first request arrived, the song was added to a queue that didn't exist yet. Play any song to get playback going again.

**Requests are ignored**
- The viewer may be on cooldown. Check the cooldown setting, or set it to `0` while testing.

**"Could not find ... on Tidal"**
- Try `Artist - Title` format, or check the spelling. Songs unavailable in your Tidal region won't appear in search.

**The plugin can't connect after I set a WebSocket password**
- Make sure the password in the plugin settings matches Streamer.bot exactly, then reload the plugin.

---

## Limitations

- The plugin relies on Tidal's internal player and API as exposed through TidaLuna. A Tidal or TidaLuna update could change those and break queueing until the plugin is updated.
- Streamer.bot must run on the same PC as Tidal, because the plugin connects to `127.0.0.1`.
- Anyone in chat can make requests (subject to the cooldown). There is currently no subscriber-only or mod-only mode.
- Search picks the best text match, which may not always be the version of a song the viewer intended.

---

## Project layout

| File | Purpose |
| --- | --- |
| `index.ts` | Plugin logic: WebSocket connection, request parsing, Tidal search, queueing and chat replies. |
| `Settings.tsx` | The settings panel shown in Tidal (port, cooldown, password). |

---

## Disclaimer

This is an unofficial community plugin. It is not affiliated with or endorsed by TIDAL, Twitch, Streamer.bot or the TidaLuna project.
