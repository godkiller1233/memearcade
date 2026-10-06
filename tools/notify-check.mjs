#!/usr/bin/env node
/**
 * Idea-notify rules, as table-driven unit checks.
 *
 *   npm run notifycheck
 *
 * The decision lives in a pure function (server/lib/notify.js), so the whole
 * status x note matrix can be walked in-process: no server, no sockets, no
 * data dir, no ports. Rows are read off an explicit grid rather than derived
 * from the implementation, and each row asserts the exact message - or the
 * silence - it promises.
 */
import { ideaNotify } from '../server/lib/notify.js';

let failures = 0;
let passed = 0;
const check = (ok, label, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(` FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
};

const TITLE = 'Roadmap idea';
const AUTHOR = 'u-author';
const ACTOR = { id: 'u-owner', name: 'owner' };

/** Every status an idea can be in, in the order the board lists them. */
const STATUSES = ['open', 'planned', 'in-progress', 'done', 'declined'];

/** One move per status: each status leads, and each is the destination once. */
const MOVES = STATUSES.map((from, i) => ({ from, to: STATUSES[(i + 1) % STATUSES.length] }));

/** What the admin note was before the save, and what it is after. */
const NOTE_STEPS = [
  { name: 'no note untouched', before: null, after: null },
  { name: 'note added', before: null, after: 'Looks good.' },
  { name: 'same note re-saved', before: 'Looks good.', after: 'Looks good.' },
  { name: 'note rewritten', before: 'Looks good.', after: 'Changed my mind.' },
  { name: 'note cleared', before: 'Looks good.', after: null },
];

/**
 * The grid itself, written out to be read rather than computed: rows are what
 * the save did to the status, columns follow NOTE_STEPS.
 *   silent - no message at all
 *   status - the move alone
 *   note   - the note ping alone
 *   both   - the move, with its Note line
 */
const DECISION = {
  still: ['silent', 'note', 'silent', 'note', 'silent'],
  moved: ['status', 'both', 'status', 'both', 'status'],
};

/** The message a category promises, spelled out for the row to match. */
function expectedText(category, { label, afterNote }) {
  const moved = `💡 Your idea "${TITLE}" is now ${label}.`;
  const pinged = `💡 Staff left a note on your idea "${TITLE}".`;
  if (category === 'status') return moved;
  if (category === 'note') return pinged;
  return `${moved} Note: “${afterNote}”`;
}

/** Run one matrix row through the pure decision, as an ordinary authored idea. */
const decide = ({ beforeStatus, afterStatus, note, from = AUTHOR, actor = ACTOR, title = TITLE }) => ideaNotify(
  { id: 's-1', title, from, status: afterStatus, adminNote: note.after },
  { status: beforeStatus, note: note.before },
  actor,
);

/** The same save on an idea that names no author at all. */
const authorless = (from) => ideaNotify(
  { id: 's-1', title: TITLE, from, status: 'planned', adminNote: 'Looks good.' },
  { status: 'open', note: null },
  ACTOR,
);

/* ------------------------------------------------------------------ *
 * the matrix: 5 status rows x 5 note steps, still and moved
 * ------------------------------------------------------------------ */

const label = (status) => (status === 'in-progress' ? 'in progress' : status);

for (const moved of [false, true]) {
  const rows = moved ? MOVES.map((m) => [m.from, m.to]) : STATUSES.map((s) => [s, s]);
  for (const [beforeStatus, afterStatus] of rows) {
    NOTE_STEPS.forEach((note, i) => {
      const category = DECISION[moved ? 'moved' : 'still'][i];
      const rowLabel = `${moved ? `${beforeStatus} -> ${afterStatus}` : `${afterStatus} kept`}, ${note.name}`;
      const result = decide({ beforeStatus, afterStatus, note });
      if (category === 'silent') {
        check(result === null, `${rowLabel} stays silent`, JSON.stringify(result));
        return;
      }
      const want = expectedText(category, { label: label(afterStatus), afterNote: note.after });
      check(result?.text === want, `${rowLabel} sends the ${category} message`, `${JSON.stringify(result?.text)} != ${JSON.stringify(want)}`);
    });
  }
}

/* ------------------------------------------------------------------ *
 * routing and payload
 * ------------------------------------------------------------------ */

const addedMove = { beforeStatus: 'open', afterStatus: 'planned', note: NOTE_STEPS[1] };
const both = decide(addedMove);
check(both?.to === AUTHOR && both?.kind === 'suggestion-update',
  'the message goes to the author as a suggestion-update', JSON.stringify({ to: both?.to, kind: both?.kind }));
check(both?.meta?.suggestionId === 's-1' && both?.meta?.title === TITLE && both?.meta?.status === 'planned',
  'the payload carries the idea id, its full title and the new status', JSON.stringify(both?.meta));
check(both?.meta?.note === 'Looks good.',
  'the payload carries the note the move wrote', JSON.stringify(both?.meta?.note));

// A cleared note must not ride along in the payload of the move it accompanied.
const clearedMove = decide({ beforeStatus: 'in-progress', afterStatus: 'done', note: NOTE_STEPS[4] });
check(clearedMove?.meta?.note === null && clearedMove?.text === '💡 Your idea "Roadmap idea" is now done.',
  'a cleared note is null in the payload, not the text it cleared', JSON.stringify(clearedMove?.meta?.note));

/* ------------------------------------------------------------------ *
 * who hears about it
 * ------------------------------------------------------------------ */

check(authorless(null) === null, 'an idea with no author tells nobody', JSON.stringify(authorless(null)));
check(authorless(undefined) === null, 'an idea whose author is missing tells nobody', JSON.stringify(authorless(undefined)));
check(decide({ ...addedMove, actor: { id: AUTHOR, name: 'author' } }) === null,
  'staff editing their own idea are not pinged');
check(decide({ ...addedMove, actor: { id: null, name: 'system' } }) !== null,
  'an idea with an author still pings when the actor has no id to match');

/* ------------------------------------------------------------------ *
 * boundaries
 * ------------------------------------------------------------------ */

const longTitle = 'T'.repeat(61);
const cutTitle = decide({ ...addedMove, title: longTitle });
check(cutTitle?.text.includes(`${'T'.repeat(59)}…`) && !cutTitle.text.includes(longTitle) && cutTitle.meta.title === longTitle,
  'a long title is cut in the message and kept whole in the payload', cutTitle?.text.slice(0, 80));
const edgeTitle = 'T'.repeat(60);
check(decide({ ...addedMove, title: edgeTitle })?.text.includes(edgeTitle),
  'a title of exactly 60 characters is left alone');
const longNote = 'N'.repeat(141);
const cutNote = decide({ beforeStatus: 'open', afterStatus: 'planned', note: { before: null, after: longNote } });
check(cutNote?.text.includes(`Note: “${'N'.repeat(139)}…”`) && cutNote.meta.note === longNote,
  'a long note is cut in the message and kept whole in the payload', cutNote?.text.slice(0, 80));
const edgeNote = 'N'.repeat(140);
check(decide({ beforeStatus: 'open', afterStatus: 'planned', note: { before: null, after: edgeNote } })?.text.includes(`Note: “${edgeNote}”`),
  'a note of exactly 140 characters is left alone');

/* ------------------------------------------------------------------ *
 * purity
 * ------------------------------------------------------------------ */

const frozenSuggestion = { id: 's-1', title: TITLE, from: AUTHOR, status: 'planned', adminNote: 'Looks good.' };
const frozenBefore = { status: 'open', note: null };
const frozenActor = { id: 'u-owner', name: 'owner' };
const beforeCopy = JSON.stringify({ frozenSuggestion, frozenBefore, frozenActor });
ideaNotify(frozenSuggestion, frozenBefore, frozenActor);
check(JSON.stringify({ frozenSuggestion, frozenBefore, frozenActor }) === beforeCopy,
  'the decision never mutates what it is given');
check(ideaNotify({ id: 's-1', title: TITLE, from: AUTHOR, status: 'open', adminNote: null }, { status: 'open', note: null }, ACTOR) === null,
  'a save that changes nothing is exactly null');

console.log(`\n${failures ? `✗ ${failures} failure(s), ${passed} passed` : `✓ all ${passed} notify checks passed`}\n`);
process.exit(failures ? 1 : 0);
