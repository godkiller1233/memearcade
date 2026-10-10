# Needs & wants — found by playing the arcade as a user

Notes from walking the real UI (two accounts: `lookout` + `pixelpal`, a party, an
online room and a hot-seat match).  Each item says what it looked like from the
player's side, and where it stands.

## Fixed

| # | What a player hit | Cause | Fix |
|---|-------------------|-------|-----|
| 1 | **Drawings are invisible.** Gartic Phone's canvas looked dead while drawing, and every submitted drawing saved as a single dot in the top-left corner, so the reveal showed empty white boxes for every human. | `drawingPad()` stored points as `{x, y}` objects; `drawStrokes()`/`cleanStrokes()` destructure `[x, y]` pairs, so each redraw threw (`object is not iterable`) and every point serialised as `0,0`. Bots sent arrays, which is why only *players'* drawings disappeared. | Points are pairs end to end, with `pointXY()` normalising anything old or hand-built on the read side (`ui.js`, `drawing.js`). |
| 2 | **"Play" dropped you straight onto bots.** A party game is 3+ players; the card's Play button seated you against AI with no way to see people already playing. | Home cards called `startSoloGame()` directly. | Cards open the play sheet (multiplayer games only) which lists **live open rooms for that game** with host, seats and **rules**, plus party / hot-seat / bots. |
| 3 | **A room never said what it would play.** Joiners had no idea which rules the host had picked. | Room options were stored but never surfaced. | The play sheet has rule presets (stocks, timer, stage, blast zones, presets…), they ride into the room, the sheet advertises them on the room row, and the room lobby repeats them. |
| 4 | **Party "Start game" was a dead end** ("No game selected yet."). | Nothing ever sent `party.game` and the button passed no game id. | Party start opens a game picker (leader) and drops the whole party into one room on the leader's remembered rules. |
| 5 | **"Invite" from the friends list lied**: *"Invited pixelpal"* → *"You are not in a party."* | The invite was sent with no party to invite to. | Inviting now opens the party on the spot (create + invite over the same socket). |
| 6 | **The Friends tab went stale.** Accepting a request left it sitting in "Requests (1)" until a manual reload; the sidebar already updated. | The view never redrew on live data. | The friends view redraws when ids/statuses/presence actually change (typing is untouched). |
| 7 | **Enter did not send.** Prompts and captions needed a mouse. | `textareaRow()` had no key handler (input rows did). | Enter sends, Shift+Enter keeps the newline. |
| 8 | **The hot-seat hint vanished.** "Pass the device when the turn changes" disappeared on the first action. | It was appended into the stage the engine repaints. | It lives in the shell now, outside the repainted stage. |
| 9 | **The reveal read "NaN/undefined".** | The reveal view branch never set the round counters. | Reveal views carry `roundsDone`/`roundsTotal`. |
| 10 | **Leftover canvas.** In hot-seat drawing games the next seat inherited (and submitted) the previous player's strokes. | One `uiState.strokes` array shared by every seat and round. | Pads are keyed by match/round/seat, so everyone draws on an empty page. |
| 11 | **Nothing a solo game did survived a reload.** High scores, best times and runs played disappeared; only Smash remembered anything, because it books its own career. | No other engine said what a good run looked like, so the host had nothing to book. | Engines declare `meta.record` (which way the score counts, the label, whether the clock matters) and `LocalHost` books the finished run into the same per-game memory port Smash uses (`settings.games[id]`), so the record survives a reload and rides to the account. The in-game header shows it live ("best 33 strokes · fastest round 38s · 1 played · 1 won"), the results toast announces a new best, and the play sheet repeats it before you sit down. |
| 12 | **A reload mid-game was a dead end.** Nine holes in, a reload landed on the play view with "Pick a game to start playing". | The shell remembers the *view* but not the run, and the stage had nothing to show. | Long solo games (`meta.record.resume` — mini golf, sudoku) park their state while playing, and the stage now lists those runs with Continue / Discard. The game card carries a "▶ continue" badge, and Play opens on "continue or start fresh". |
| 13 | **Chess misclicks.** Selecting a piece lit up *every* move its colour had - the destinations of pieces you had not picked - and clicking one of those squares sent the move anyway, which the engine refused with "Illegal move." (found while playing a match, not while reading code). | The view keys `legal` by destination for all of the viewer's pieces, and the board highlighted a square whenever *any* piece could reach it. | A square is a target only for the piece actually selected: pick a piece and its own destinations light up, nothing else does. |
| 14 | **The status bar said "0 online"** next to a list of busy rooms. | `#status-counts` read `online` off the lobby payload, which counts tables (`{rooms, players, byGame}`) and has no `online` field; the number lives in the global stats. | The counts read the global stats (the socket's `statsGlobal`, or `/api/stats`) and fall back to the lobby payload, so the bar reads "7 online · 4 open rooms". |

## Built on request: chess match analysis (admin)

**Admin console → ♟️ Chess**, over `GET /api/admin/chess` (admin-only: a
moderator gets a 403 even though the rest of the panel is staff).  It reads
every finished chess match the arcade can still account for and answers the
questions a scoreboard cannot: how the games ended, which colour won them, which
openings get played, who beats whom, what a typical game costs in moves and
minutes, and how busy the board is day by day.

Two sources, merged by room id (a match found in both is counted once):

- **Room snapshots** (`db.data.rooms`, now keeping `startedAt` / `finishedAt` / a
  compact `result`) - the long-lived half; they outlive the audit.
- **Audit `game.finish` entries** - a rotating window (newest 2000 events across
  every game) that carries the points, the end summary and the engine's review.
  The panel says so when the window is capped.

Detail comes from a new optional engine hook, `meta.review(state)` (chess
returns end reason, colours, plies, captures, the opening plies and the last
move), so a match finished before the hook existed still counts - it just lands
in "Not recorded" for its end reason.  Nothing about a finished match is
recomputed from the engine, so history stays readable after rule changes.

Seats are merged, not replaced: a room that closes after a player walks out is
republished without them, and only the audit still names them.

## Built on request: the servers screen + the waiting-room countdown

**The Servers tab (was "Lobby") is now the table list.** It reads every open
room across every game (`GET /api/rooms`, no game filter) and shows each one
with who is hosting, how the seats are going (`2 players · 3/14 seats`), the
rules it will play by (the same `ruleSummary` the play sheet uses, filled from
the engine module) and the room code.  A filter bar narrows by game (the picker
only lists games that have a table right now), by state (filling up / in
progress), by a free seat, and by host, game or code; **Quick join** sits down at
the fullest table the filters allow, and each row's Join/Watch goes straight in.
The list stays live over the socket, and it redraws itself in place - a table
appearing does not wipe the filters or a half-typed search.

**The waiting room counts itself down and fills its own seats.** A room that is
ready - enough seats, at least one other player - arms a start clock
(`autoStartAt`, `MEMES_AUTO_START_MS`, 15s by default) and shows
"starting in N…" with a progress bar until it starts on its own.  A room sitting
alone never counts down: it shows the empty seats as dashed "open seat" chips and
says how many players it still needs.  Next to the countdown are the two ways to
fill it: **➕ Invite a friend** (pick a friend, or type a username, and they get a
`room-invite` notification that joins in one tap - the copy-link is still there
for anyone not on the list) and **🤖 Add bot**.  The countdown clears the moment
the room is left alone again, and an idle lobby is now reaped after 45 minutes
(the check existed but sat behind an early `continue`).

Rooms that sit at one player are also no longer dead air on the way in: the same
card is what a player sees the second they open a table.

## Built on request: the host still streams from a background tab

**A realtime room runs inside the host's tab, so a backgrounded or throttled host
was everyone else's problem.**  When the host tab was hidden the browser clamped
its timers, snapshots slowed to roughly one a second, and every remote seat's
interpolation buffer ran dry between frames - the match froze for the guests
while the host saw nothing wrong at all.

Three things changed:

- **The room keeps streaming in the background.**  `OnlineHost` now watches
  `visibilitychange`; while hidden it keeps stepping the world and pushing
  snapshots (a throttled browser still fires its clamped timer) instead of
  skipping the frame, and it caps how much banked time a single wake may catch up
  (`BACKGROUND_CATCHUP_MS`) so a long absence does not replay the whole gap at
  once.  It also skips the repaint while hidden - nobody is looking - and paints
  once on the way back.
- **The client buffer learns to wait for a slow stream.**  `SnapshotBuffer`'s
  ceiling now follows the observed cadence (a 1/s stream is allowed a ceiling
  above the old fixed `MAX_INTERP_DELAY`) and it grows toward it in fractions of
  the measured centre, so a sparse-but-steady stream interpolates smoothly
  instead of starving between frames.
- **Everyone is told.**  The host gets a warning when it hides the tab - a `⚠`
  title prefix, a toast on the way back that says the room kept streaming at a
  reduced rate, and a line in the play view from the moment the match starts
  ("the world runs in this tab, so keep it open").  The room is told too: a
  `room-visibility` socket op announces "hosting from a background tab - frames
  may be choppier until it is back", and a server-side watchdog
  (`STREAM_STALL_MS`) notices a host that has gone quiet outright, announces
  "stopped streaming - the match is waiting on their tab", notifies that host,
  and clears it with "streaming again" the moment snapshots resume.  A new
  `.room-alert.stream` banner carries both lines to every seat.

## Wanted next (not done)

- **Friends: party invites have no lasting home.** A missed toast is gone for
  good; an "Invites" list on the Friends tab would survive a reload.
- **Rematch from the reveal.** After Gartic Phone's reveal the room has no
  rematch button (local matches have one).
- **Room rules for the *joiner*.** A joiner cannot suggest rules — only the host
  presets them.
- **Presence on the room row.** `updatedAt` is shown indirectly; "active 3 min
  ago" would help spot abandoned rooms.
- **Spectator controls.** Spectating a realtime match works but there is no
  way to leave it from the stage header.
- **Analysis for the other games.** Chess now has a review tab (see below);
  board games, cards and party games have no per-match history worth reading
  yet.  A generic "matches" tab (the same endpoint with a game picker, and a
  `meta.review` hook for the games that want one) would cover them.
- **Records for the adversarial games.** The solo/arcade families (arcade,
  puzzle, visual, words, cards, quiz) now keep records; the board, chess,
  monopoly, drawing and party games still keep none, so their wins column does
  not exist yet.  One `record: { best: false }` line each would give them
  "N played · M won" and nothing else.
- **A memory screen.** The records are scattered per game (card badge, play
  sheet, in-game strip); a "Your records" page on the profile would put every
  best score, best time and saved run in one place.
