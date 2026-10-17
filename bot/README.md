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

## The server list in the admin console

Only the bot holds the Discord token, so it reports the servers it is in to the
arcade (`POST /api/bot/guilds`) at boot, every `BOT_GUILD_REPORT_MS` after that,
and straight away when Discord sends `GUILD_CREATE` or `GUILD_DELETE`. A burst
of joins is collapsed into one report, and a guild Discord marks `unavailable`
during an outage is not treated as a leave.

**Admin console → 🤖 Discord bot → 🌐 Servers** shows that list - owned servers
first, with each one's text/announcement/forum channel count, the date it was
first seen, and an **Open in Discord** button plus a copyable `!memearcade help`.
That is the fastest way to check the bot before a match night: open the server
and try a command there, where the channels and permissions are real.

The arcade keeps a **memory** of every server the bot has been in, not just the
last report. A server missing from a complete report is marked as left (it moves
to **🕘 Previously in**, with when it left) instead of disappearing, and a server
the bot is added to again keeps its original first-seen date. The bot sends its
own total alongside the list, so a report capped at 60 servers never looks like
the bot left everything outside the slice. The memory lives in `data/db.json`,
so restarting the bot - or the site - reads it back instead of starting empty.

The panel never calls Discord itself, and the list is read-only: it cannot make
the bot say anything. A check-in older than 15 minutes is marked **stale**, and
an invite link is offered for adding the bot to another server. Channel counts
are what the bot can see, not a check that it may post in every one; a server
that hides its channels still appears, just without a number.

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

## Starting with the site

`npm start` starts the bot too. When `DISCORD_TOKEN` is in `bot/.env` (or in the
server's environment) the arcade launches `bot/index.js` once it is listening,
hands it the port it actually bound and the bot secret it is using, and stops it
on Ctrl+C. The startup banner names the bot and its pid; if it is not running,
the banner and the server log say why.

- **It restarts itself.** A dropped connection or an exit gets five attempts
  with a growing delay (1s to 30s). After that it stops trying and logs the
  cause - a rejected token, a missing intent, Node older than 22 - so the site
  does not hammer Discord with a configuration that cannot work. Fix it and
  restart the site.
- **Only one copy.** If the site is killed without a chance to clean up
  (SIGKILL, a crash, `node --watch` restarting it), the bot notices its parent
  is gone within a few seconds and exits instead of staying online as a
  duplicate that answers every command twice.
- **Turn it off** with `MEMES_BOT_AUTOSTART=off` in the site's environment or
  `bot/.env` when the bot runs somewhere else (another PC, a background worker).
  Two copies both answer interactions, so this is the switch to use.
- **Run it by hand** with `npm run bot` when the bot should outlive the site or
  talk to a deployed one. A hand-run bot reads `ARCADE_BOT_SECRET` from
  `bot/.env`; a site-started one is given the site's own secret.

## Setup

1. Create an application at <https://discord.com/developers/applications>, add a
   **Bot**, and copy its token.
2. Invite it to your server with the `bot` and `applications.commands` scopes
   (OAuth2 URL generator). Slash commands need no privileged intents; the
   `!memearcade` fallback in servers needs **Message Content Intent** (Bot →
   Privileged Gateway Intents), and works in DMs without it.
3. `cp bot/.env.example bot/.env` and fill in `DISCORD_TOKEN` (see that file for
   the rest).
4. `npm start` - the site starts the bot with it. **Admin console → 🤖 Discord
   bot** shows the server list as soon as the bot connects.

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

It also covers starting with the site: a second arcade boots with only
`DISCORD_TOKEN` in its environment, starts the bot by itself, and the fake
gateway sees it identify and report its servers using the secret the site handed
over. Stopping that arcade is checked to take the bot with it, so no duplicate
is left online.

It also covers the console's server list: the bot reads `/users/@me/guilds`,
reports it with channel counts (and leaves the count blank when a server hides
its channels), and the owner-only endpoint returns it with an invite link. Bad
ids, duplicates and over-long names are dropped or capped, a non-staff account
gets 403 and a report without the bot secret gets 401. The memory is covered
too: a complete report that omits a server marks it left, a capped one does not,
a rejoin keeps the first-seen date, a `GUILD_CREATE` is reported at once, an
`unavailable` `GUILD_DELETE` is ignored, and the whole thing is read back from
`data/db.json`.

It covers our side of the protocol without a Discord token; it does not test
real Discord itself.
