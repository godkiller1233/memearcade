/**
 * Lazy engine loader for the browser: only the family file a game needs is
 * fetched, and each module may export one engine or several.
 */
const FILES = {
  'tic-tac-toe': 'board.js',
  'ultimate-ttt': 'board.js',
  'connect-four': 'board.js',
  checkers: 'board.js',
  battleship: 'board.js',
  uno: 'cards.js',
  'go-fish': 'cards.js',
  blackjack: 'cards.js',
  chess: 'chess.js',
  'gartic-phone': 'drawing.js',
  'charades-draw': 'drawing.js',
  'meme-maker': 'meme-maker.js',
  'bad-drawing': 'drawing.js',
  monopoly: 'monopoly.js',
  trivia: 'quiz.js',
  jeopardy: 'quiz.js',
  'quiz-rush': 'quiz.js',
  'guess-character': 'quiz.js',
  'guess-the-prompt': 'quiz.js',
  'spot-difference': 'visual.js',
  'zoomed-image': 'visual.js',
  hangman: 'words.js',
  'guess-the-story': 'words.js',
  sudoku: 'puzzle.js',
  mafia: 'social.js',
  gecko: 'social.js',
  codenames: 'social.js',
  'memes-smash': 'smash.js',
  pong: 'arcade.js',
  invade: 'arcade.js',
  'rocket-bot-royale': 'arcade.js',
  'mini-golf': 'arcade.js',
  quiplash: 'party-words.js',
  'funny-answers': 'party-words.js',
  'caption-battle': 'party-words.js',
  'hot-take': 'party-words.js',
  'fake-definition': 'party-words.js',
  'emoji-story': 'party-words.js',
  'telephone-story': 'party-words.js',
  'story-builder': 'party-words.js',
  'one-word-story': 'party-words.js',
  'plot-twist': 'party-words.js',
};

const cache = new Map();

export async function loadEngine(id) {
  if (cache.has(id)) return cache.get(id);
  const file = FILES[id];
  if (!file) return null;
  const mod = await import(`./${file}`);
  let found = null;
  if (mod.default?.meta?.id === id) found = mod.default;
  if (!found) {
    for (const [key, value] of Object.entries(mod)) {
      if (key === 'default') continue;
      if (value?.meta?.id === id) {
        found = value;
        break;
      }
    }
  }
  if (!found && mod.default?.meta) found = mod.default;
  cache.set(id, found);
  return found;
}

export function engineFiles() {
  return [...new Set(Object.values(FILES))];
}

export function knownEngines() {
  return Object.keys(FILES);
}
