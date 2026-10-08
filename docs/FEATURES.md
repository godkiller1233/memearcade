# Feature switches

Everything an owner can switch off or hide, and what each switch really does.

---

## Where it lives

**Admin console → 🎚️ Features.** The tab is admin-only (the same rung as Site,
Ideas, Audit and the bot secret), and it renders whatever
[shared/features.js](../shared/features.js) declares, so the panel can never
offer a switch the server does not know how to enforce.

The panel has three parts:

* a **filter** that narrows both lists by name, id or description;
* **Features** - one row per feature, grouped into Play / Social / Community /
  Client. Each row names what it covers (`desc`) and what flipping it removes
  (`Hides: …`);
* **Games** - one row per catalog entry, for hiding or refusing a single game.

Each row has two checkboxes, **On** and **Hidden**, and a **Kept for** picker (see
*Keep-floors* below). Everything applies at once, there is no Save button, and a
change is live for every connected client immediately (see *Propagation* below).
Every feature row also has a **🕒 Schedule…** button (see *Schedules* below).
`↺ Turn everything back on` restores every feature and game in one click, clears
every schedule and puts every keep-floor back to staff.

## The two switches

They answer different questions, which is why they are separate. "Players" below
means every role *below* the row's keep-floor (staff by default):

| | **On** | **Off** |
| --- | --- | --- |
| players | feature works | REST routes answer `403`, WebSocket ops bounce with `code: "feature-off"`, and the nav entry is gone |
| kept roles | feature works | feature still works (staff by default, so you can always switch it back on) |

| | **Shown** | **Hidden** |
| --- | --- | --- |
| players | nav entry is there | nav entry is gone, but the feature still works - a deep link, an invite link or a room code still reaches it |
| kept roles | nav entry is there | nav entry is there |

So the four states are: on + shown (normal), on + hidden (the quiet feature only
people with a link use), off + shown (a locked door - nothing reaches it except
the kept roles), off + hidden (invisible).

Off and hidden are independent: switching something off also removes its nav
entry for players, and hiding something does *not* refuse it. If you want a
feature to be neither advertised nor reachable, tick both.

## Keep-floors

Every feature and every game has a **Kept for** rung - the lowest role that still
gets it while it is off or hidden. The rungs are the account ladder:

| Rung | Who keeps the feature |
| --- | --- |
| **Players & up** | every signed-in account (guests lose it) |
| **VIP & up** | VIPs, moderators, admins, the owner |
| **Staff & up** *(default)* | moderators, admins, the owner |
| **Admins & up** | admins and the owner |
| **Owner only** | just the owner |

One rule covers both switches *and* every schedule: a role at or above the floor
keeps the feature whatever you do to the switches, and a role below it loses the
feature the moment a switch or a window closes it. So "keep chat for VIPs while
players lose it" is simply **chat off + Kept for: VIP & up**. Guests never keep
anything - they are not on the ladder.

A refused caller is told the truth about the floor: with the default staff rung
the message stays the old arcade-wide "Chat channels is turned off on this
arcade.", and with a higher floor it becomes "Chat channels is kept for VIPs - it
is turned off for your account." A deep link shows the same explanation. The
panel badges an off row with who still gets it (`off for players`, `off except
VIP+`, `off for guests`, …), and the summary line counts role-kept rows.

**Staff keep access by default**, so an owner can never lock themselves out with
a switch. Raising the floor above staff (Admin or Owner only) is a deliberate
choice and *does* lock those rungs out of that feature - but never out of the
admin console, which is a separate staff gate, so the switch can always be undone.

Games carry a keep-floor too, in the same **Kept for** picker: an off game kept
for VIPs stays in a VIP's library (badged as off for everyone else), and an off
game kept for players stays for them.

## Display-only switches

One row says **display only**: the *Game library* tab. The catalog feeds the
home page, every game picker and the Discord bot, so refusing `/api/games` would
break the shell instead of closing a door. Its switch closes the Games tab (and
the side *Quick play* block, and the home *Browse all games* button) while the
list itself stays served. To stop a specific game use its row in **Games**, and
to stop play altogether use **Online rooms**.

## Schedules

A feature can also close itself at set times - "chat is closed 22:00-08:00",
"rooms only open on weekends". Open a row's **🕒 Schedule…** button:

* **Close on a schedule** - the master switch for the window. Off keeps the days
  and times you picked but closes nothing.
* **Days** - the days the window *opens*. A Friday 22:00-08:00 window therefore
  runs into Saturday morning, which the editor's preview line says in words.
* **Closes at / Reopens at** - wall-clock local times. The window reopens at the
  "Reopens at" minute exactly, and `00:00` + `00:00` means the whole day.
* **Clear schedule** removes the window entirely.

A schedule never overrides the manual switches, it only adds closed hours:
a feature switched **off** stays off all day, and a feature that is merely
**hidden** keeps serving inside its window (nothing is advertised either way).
While a window is open the feature behaves exactly like a manual **off**: REST
answers `403`, WebSocket ops bounce with `code: "feature-off"`, the nav entry is
gone, and the row's kept roles keep access - a window closes the feature for
everyone *below* the keep-floor, exactly like the Off checkbox does. The only
difference a player might notice is the wording: "Chat is closed until 08:00 -
the arcade owner scheduled these hours, and it reopens on its own."

Windows are evaluated against the server's own clock every time a request is
served, so enforcement is never late. A small sweep (every 20 seconds, or
`MEMES_SCHEDULE_TICK_MS`) exists only to push the change to *already open*
clients, so a tab sitting on the Chat view gets its turned-off notice and its
tab back without a reload.

## Games

The **Games** rows use the same two switches and keep-floor for one catalog
entry:

* **Off** - the game leaves the catalog of everyone below its keep-floor,
  `/api/games/:id` answers `403`, and it cannot be hosted over REST or the
  WebSocket. Kept roles still see it, badged as off, and can still open it.
* **Hidden** - the game leaves those catalogs, but an invite link or a room code
  still works. Someone mid-match is never cut off: turning a game off refuses
  *new* rooms, not the one already running.

## What each feature covers

| Feature | Refused when off | Removed by hidden |
| --- | --- | --- |
| Game library | *(display only)* | Games tab, Quick play, Browse-all |
| Online rooms | hosting, joining, room codes | Lobby tab, Join buttons |
| Public lobby browser | the room list and its live refresh | Lobby tab |
| Watch live games | sitting in a live match | Spectate buttons |
| Bot players | adding server bots, solo-vs-bots fills | Fill-with-bots buttons |
| Leaderboards | score tables (`/api/leaderboard`) | nothing yet - no table view |
| Friends & presence | friend list, requests, presence | Friends tab, Online now |
| Direct messages | DM list and sending (REST and WS) | DM buttons, DM tabs |
| Chat channels | global, party and room chat, typing | Chat tab, room chat, chat dock |
| Parties | creating, joining, inviting, starting | Party card, party buttons |
| Idea board | reading, posting and voting | Ideas tab, home idea card |
| Changelog | the shipped-ideas list | Changelog tab |
| Player reports | filing a report from Settings | Report a bug button |
| Desktop downloads | the download manifest and zips | Download tab, home banner |
| Background music | the music list | Music toggle |

A switched-off feature never strands a live session: leaving a party and leaving
or finishing a room always work, so flipping a switch mid-game ends the match
politely instead of freezing it.

## Propagation

The switch map travels in the public config every client already fetches - and it
is built **per viewer**, with that account's keep-floor already applied:

* `GET /api/meta` → `config.features` (`{ id: { on, hidden, minRole } }`). A role
  at or above `minRole` is sent `on: true, hidden: false` (the feature is simply
  theirs, no window applies), everyone else gets the stored switches, plus
  `{ on: false, hidden: true, scheduled: true, until: "<ISO>" }` while a
  scheduled window has it closed, so the client can say when it reopens;
* the realtime `welcome` carries the same per-viewer shape, plus the catalog the
  caller may see;
* an admin change pushes `{ t: 'config', config, catalog }` to every open tab -
  each frame is built for that session, so a VIP's tab keeps a feature a player's
  tab just lost, live and with no reload. The catalog is rebuilt per viewer too.

The client holds no role logic of its own: it draws whatever the server sent, so
the browser can never be more permissive than the API. Nothing in the map is a
secret: a player sees the effect the moment it happens, and the floor is what
tells them it was kept for someone else.

## The Discord bot

The bot is not a second door around a switch. It reads the public switch map
(`GET /api/meta` → `config.features`) through a short-lived cache
(`BOT_FEATURE_TTL_MS`, default 10s), and a command whose feature is off answers
with the same notice the website shows - naming the feature, and for a scheduled
window, when it reopens (as a Discord stamp in the reader's own timezone):

> 🚪 **Idea board is turned off on this arcade.**
> It is on a schedule: it reopens *in 4 hours* (10:00 PM).

`/ideas`, `/suggest` and `/vote` need the idea board, `/changelog` needs the
changelog, `/leaderboard` needs leaderboards; `/arcade`, `/profile` and `/link`
are profile lookups and keep working. While leaderboards are off - or the owner
has hidden the game library - the `/leaderboard game:` autocomplete offers no
choices, but a typed id or name still reaches the board, the same "a deep link
still works" rule the site follows. The bot logs the switch state at boot. A
read that fails never opens anything: the command runs and the server's own
`403` becomes the reply, so the bot can never be more permissive than the arcade.

The bot calls the arcade anonymously, so it sees the strictest view: a feature
kept for VIPs reads "off" to the bot and its commands announce that, even for a
Discord member whose linked account is a VIP. The bot has no arcade role to look
at, and this failure mode is the safe one - the website and the API still serve
the kept roles exactly.

## Storage and enforcement

* Switches live in `data/db.json` under `config.features` and `config.games`.
  An empty map means "everything on, shown and kept for staff", and
  `normalizeFeatures()` / `normalizeGames()` fill in defaults and drop unknown
  ids, so an upgraded or hand-edited database always reads sanely - a database
  written before keep-floors existed keeps exactly its old staff-only behaviour.
* A keep-floor is stored on every feature/game as `minRole`, one of
  `user | vip | mod | admin | owner`; junk falls back to `mod`.
  (`normalizeKeepRole()`.) The ladder itself is `KEEP_ROLES` / `ROLE_RANK` in
  [shared/features.js](../shared/features.js), mirrored by `ROLES` in
  [server/lib/auth.js](../server/lib/auth.js).
* A schedule is stored beside its switches as
  `schedule: { enabled, days: [0-6], from: "22:00", to: "08:00" }`; a feature
  without one carries no `schedule` key. Bad days or clock text are repaired on
  read, never trusted. (`normalizeSchedule()`.)
* The REST guards are `requireFeature()` / `requireGame()` in
  [server/api.js](../server/api.js); the WebSocket guards are
  `hub.requireFeature()` in [server/realtime.js](../server/realtime.js). Both
  live in [shared/features.js](../shared/features.js), which is also what the
  panel is built from. `featureAllowed()` / `gameAllowed()` take the caller's
  role and the current time, so keep-floors and schedules are enforced everywhere
  those calls happen; `featureKept()` / `gameKept()` answer the floor alone.
  [server/lib/public-config.js](../server/lib/public-config.js) builds the
  per-viewer `config` and `catalog` that `/api/meta`, `/api/games`, the realtime
  welcome and every live push send.
* [server/lib/schedule.js](../server/lib/schedule.js) runs the sweep that
  broadcasts when a window opens or closes; `server/index.js` starts and stops
  it, and the timer is unref'd so it can never hold the process open.
* Every change is audited: `feature.toggle` / `feature.schedule` /
  `feature.roles` and `game.visibility` / `game.roles` appear in the console's
  Audit tab.

## Tests

* `npm run smoke` - an owner switches the idea board off, a player is refused
  (and staff are not), the handshake reports it, a hidden feature still answers,
  a switched-off game leaves the player catalog but stays visible to staff, a
  whole-day window closes chat for a player and a socket is refused with
  `feature-off`, a window a few seconds out closes and reopens the feature with
  an open client receiving both pushes, and every switch is restored afterwards.
  It also covers keep-floors live: the owner keeps the idea board for VIPs,
  a plain player is refused with the floor named while a promoted VIP and the
  owner keep it, each role's own handshake says so, and one chat send over the
  socket bounces for the player and goes through for the VIP.
* `npm run browser` - a scheduled close removes the player's nav entry with no
  reload, the deep link says when it comes back, the tab disappears and returns
  live as the window opens and ends, and clearing the schedule brings it back.
  The console's keep-floor picker is driven like an owner would (ladder, stored
  value, posting, badges), and a player's tab stays while chat is off but kept
  for players, leaves the moment the floor rises to VIP, shows the kept-for card
  on a deep link, and comes back when the floor drops - all live.
* `npm run botcheck` - with the idea board off, `/ideas`, `/suggest` and `/vote`
  announce it (and `/changelog` keeps serving); with the changelog off,
  `/changelog` announces; with leaderboards off, `/leaderboard` announces and the
  game autocomplete offers nothing while a typed id still works; a scheduled
  window names its reopen time; a hidden feature still serves; and restoring a
  switch brings the command back.
* `npm run permcheck` - `GET/POST /api/admin/features` and
  `POST /api/admin/games/:id` are admin-only, verified across no session, plain
  user, moderator and owner. The role keep-floor section then walks the ladder:
  a VIP-kept feature serves the VIP, the moderator and the owner while the plain
  user gets `403`, an owner-only feature locks even a moderator out, the panel is
  offered the whole ladder and counts role-kept rows, and a junk floor falls back
  to staff.
* `npm run check` - every `data-feature` in `web/index.html` is a real switch,
  the ids are unique, every feature belongs to a declared group, and the window
  resolver is checked against fixed dates (over-midnight, day selection, equal
  times, junk input, the reopen stamp and the effective flag map). The keep-floor
  resolver is checked beside it: the ladder order, normalization, `featureKept()`
  for each rung, per-viewer flag maps, a window that a kept role never sees, the
  refusal wording, and the same rules for games.
