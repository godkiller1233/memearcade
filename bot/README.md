# Memes Arcade Discord bot

Turns the arcade's idea board and player stats into slash commands. No
dependencies - it talks to Discord with the built-in `fetch`/`WebSocket`
(Node 22+) and to the arcade with the `X-Bot-Token` shared secret. Every command
also answers to a plain message (`!memearcade <command>`), so players are not
stuck waiting for Discord to roll the slash commands out.

## Commands

| Command | What it does |
| --- | --- |
| `/arcade player:` | Your linked account's level, XP, coins and match record - or any player's public profile with `player:`. |
| `/profile player:` | The games you have played, per game, and the achievements you have earned - for your linked account or any player with `player:`. |
| `/leaderboard sort: game:` | Top players by level (default), wins or games played - or one game's board with `game:` (name or id, e.g. `pong`), which ranks by the points that game awards each match (Pong books the margin of victory) and shows games played alongside. The `game:` option autocompletes from the live catalog as you type. |
| `/ideas` | Browse the board with vote counts. Options: `sort` (top/new), `status`, `category`. |
| `/changelog` | Ideas that actually shipped, newest first - the votes they earned and the note staff left when they shipped them. |
| `/suggest title: details: category:` | Post an idea as your linked arcade account. |
| `/vote idea:` | Upvote / unvote an idea (accepts a short id prefix from `/ideas`). |
| `/link` | Connect your Discord account to your arcade account. |
| `/help` | Every command with its arguments, plus how to use them as plain messages (`!memearcade <command>`) when the slash commands have not appeared yet. Answers in the channel, needs no link. |

Stats, posting and voting act as *you*: the bot asks the server for a 7-day
session token tied to your linked account, so your level, coins and ideas show
up under your arcade name. Looking someone up (`/arcade player:name`,
`/profile player:name`) needs no link at all - it reads the same public profile
the website's player list shows, and a name that misses offers the closest
matches.

## Text fallback: `!memearcade <command>`

Global slash commands can take up to an hour to appear, and they never appear at
all if the bot was invited without the `applications.commands` scope. So every
command also answers to a plain message, with the same validation, the same
feature switches and the same linked account:

`/help` shows the same list from the slash side, with each command's arguments
and a concrete `!memearcade` example, so either entry point leads to the other.

| Message | Same as |
| --- | --- |
| `!memearcade` or `!memearcade help` | the full command list |
| `!memearcade arcade ideafan` | `/arcade player:ideafan` |
| `!memearcade profile` | `/profile` |
| `!memearcade leaderboard wins ping pong` | `/leaderboard sort:wins game:ping pong` |
| `!memearcade ideas status:open category:game` | `/ideas status:open category:game` |
| `!memearcade changelog` | `/changelog` |
| `!memearcade suggest title:Kart racing details:A top-down racer. category:game` | `/suggest title:… details:… category:game` |
| `!memearcade vote a1b2c3` | `/vote idea:a1b2c3` |
| `!memearcade link` | `/link` |

Options can be written `name:value` in any order, or positionally in the order
shown above (as with the leaderboard example). A value runs to the next known
option, so `details:` may contain spaces. `suggest` also accepts
`!memearcade suggest Kart racing | A top-down racer. | game` if you prefer pipes.

A plain message has no ephemeral flag, so a private answer - your stats, a link
code, a vote - is sent as a **DM**. If your privacy settings refuse DMs the bot
posts a short note in the channel saying so, and the answer itself (and any link
code in it) is never posted there. Public answers (`/ideas`, `/changelog`,
`/leaderboard`) reply in the channel and quote the message that asked.

Reading messages in a server needs Discord's privileged **Message Content
Intent**: tick it under *Bot → Privileged Gateway Intents* in the Developer
Portal. DMs carry their text without it, so the fallback still works there. If
the intent is off, the bot says so in its log, reconnects without it and keeps
the slash commands running - it does not go offline.

## Feature switches

The bot honours the same switches as the website (Admin console → 🎚️ Features).
A command whose feature is switched off - or scheduled off for the night -
replies with a notice naming the feature instead of serving a closed board:

> 🚪 **Idea board is turned off on this arcade.**
> It is on a schedule: it reopens *in 4 hours* (10:00 PM).

`/ideas`, `/suggest` and `/vote` need the idea board, `/changelog` needs the
changelog and `/leaderboard` needs leaderboards; `/arcade`, `/profile` and
`/link` are profile lookups and keep working. While leaderboards are off, or the
owner has hidden the game library, `/leaderboard game:` stops offering
autocomplete choices - a typed game id or name still reaches the board, like a
deep link on the site. The bot logs the arcade's switch state at boot, and reads
it again for every command (`BOT_FEATURE_TTL_MS`, default 10 seconds). If that
read ever fails the command runs anyway and the server's own refusal is the
reply - the bot can never be more open than the arcade.

## Setup

1. Create an application at <https://discord.com/developers/applications>, add a
   **Bot**, and copy its token.
2. Invite it to your server with the `bot` and `applications.commands` scopes
   (OAuth2 URL generator). Slash commands need no privileged intents; the
   `!memearcade` fallback in servers needs **Message Content Intent** (Bot →
   Privileged Gateway Intents), and works in DMs without it.
3. Start the arcade and open **Admin console -> 🤖 Discord bot** to copy the
   bot secret.
4. `cp bot/.env.example bot/.env` and fill in `DISCORD_TOKEN` and
   `ARCADE_BOT_SECRET` (see that file for the rest).
5. `npm run bot`

Set `DISCORD_GUILD_ID` while testing: guild commands appear instantly, global
ones can take up to an hour to show up the first time.

## Linking a player

`/link` gives a code; the player signs in on the website and enters it under
**Settings -> Discord bot**. The server stores the Discord-id ↔ account link and
the bot keeps a session token for it (`/api/bot/link/start` refreshes it if the
server restarts).

## Testing

`npm run botcheck` boots a scratch arcade plus a fake Discord (REST + gateway,
using the project's own WebSocket server), runs the real bot against it and
drives `/arcade`, `/profile`, `/leaderboard`, `/ideas`, `/changelog`, `/suggest`,
`/vote` and `/link`. It also closes features as the owner (idea board, changelog,
leaderboards, one scheduled window) and asserts every affected command answers
with the switch notice - and that a hidden feature still serves.

It drives the text fallback the same way: the parser's keyed and positional
forms, the channel reply (quoting the message, never pinging), the DM for a
private answer, the silence for ordinary chat and other bots, the refusal when a
player's DMs are closed, and a vote and suggestion posted as the linked account.
A second fake gateway closes the connection with 4014 unless the privileged
intent is dropped, which proves the bot reconnects and keeps serving instead of
dying on an unconfigured app.

It covers our side of the protocol without a Discord token; it does not test
real Discord itself.
