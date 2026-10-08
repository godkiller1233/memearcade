# Memes Arcade Discord bot

Turns the arcade's idea board and player stats into slash commands. No
dependencies - it talks to Discord with the built-in `fetch`/`WebSocket`
(Node 22+) and to the arcade with the `X-Bot-Token` shared secret.

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

Stats, posting and voting act as *you*: the bot asks the server for a 7-day
session token tied to your linked account, so your level, coins and ideas show
up under your arcade name. Looking someone up (`/arcade player:name`,
`/profile player:name`) needs no link at all - it reads the same public profile
the website's player list shows, and a name that misses offers the closest
matches.

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
   (OAuth2 URL generator). No privileged intents are needed.
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
with the switch notice - and that a hidden feature still serves. It covers our
side of the protocol without a Discord token; it does not test real Discord
itself.
