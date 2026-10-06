/**
 * Notification decisions, as pure functions.
 *
 * The API layer decides *whether* a player should hear about something and the
 * realtime hub does the sending (hub.notify). Keeping the decision here means
 * the rules can be read, and tested, without a server, a socket or a database:
 * each function returns a message to send - { to, kind, text, meta } - or null
 * for silence, and never touches its arguments.
 */

/**
 * The idea-notify rules.
 *
 * An admin save can move the status, change the note, do both or neither, and
 * the author hears about it exactly once:
 *  - moving the status pings, on its own;
 *  - writing a note pings, on its own;
 *  - writing a note *while* moving the status is one message with a Note line;
 *  - clearing a note is not an event - not on its own, and not while moving the
 *    status (the move still pings, without a Note line, and the payload's note
 *    is null rather than the text that was cleared);
 *  - re-saving a note that is already there is not an event either;
 *  - staff editing their own idea do not get pinged;
 *  - an idea with no author to tell stays silent.
 *
 * @param {{id, title, from, status, adminNote}} suggestion the idea after the save
 * @param {{status, note}} before the idea before it (note normalised to null)
 * @param {{id}} actor the staff account that saved
 * @returns {{to: string, kind: string, text: string, meta: object} | null}
 */
export function ideaNotify(suggestion, before, actor) {
  const statusChanged = suggestion.status !== before.status;
  const note = suggestion.adminNote || null;
  const noteAdded = note !== before.note && !!note;
  if (!statusChanged && !noteAdded) return null;
  if (!suggestion.from || suggestion.from === actor.id) return null;
  const label = suggestion.status === 'in-progress' ? 'in progress' : suggestion.status;
  const rawTitle = String(suggestion.title || '');
  const title = rawTitle.length > 60 ? `${rawTitle.slice(0, 59)}…` : rawTitle;
  const shortNote = note && note.length > 140 ? `${note.slice(0, 139)}…` : note;
  const parts = statusChanged
    ? [`💡 Your idea "${title}" is now ${label}.`]
    : [`💡 Staff left a note on your idea "${title}".`];
  if (noteAdded && statusChanged) parts.push(`Note: “${shortNote}”`);
  return {
    to: suggestion.from,
    kind: 'suggestion-update',
    text: parts.join(' '),
    meta: {
      suggestionId: suggestion.id,
      title: rawTitle,
      status: suggestion.status,
      note,
    },
  };
}
