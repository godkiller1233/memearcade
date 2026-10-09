/**
 * What a client may see of the site: the public config, and the catalog as one
 * account is allowed to see it.
 *
 * These live in their own module because three places need the same answer -
 * the REST handshake (/api/meta, /api/games), the realtime welcome, and the
 * live `config` push that follows an admin change.  One shape, one place to
 * change it.
 *
 * Both are per-viewer: the feature switch map arrives with the account's
 * keep-floor already applied (see shared/features.js), so a client never has to
 * reason about roles, and a kept role simply sees the feature as available.
 * `account` is null for a guest or a socket that has not identified yet, which
 * gets the strictest view.
 */
import { db } from './db.js';
import { buildStamp } from './build.js';
import { engineCatalog } from '../games.js';
import { catalogWithEngines } from '../../web/games/registry.js';
import { featureFlags, gameKept, gameState } from '../../shared/features.js';

export function publicConfig(account = null) {
  return {
    // Which build the server is serving.  A client keeps this as "the build I
    // booted from" and reloads when a later answer differs (web/js/build-watch.js),
    // which is how a shipped art or engine change ever reaches an open tab.
    build: buildStamp(),
    registrationsOpen: db.data.config.registrationsOpen,
    maintenance: db.data.config.maintenance,
    motd: db.data.config.motd,
    announcement: db.data.config.announcement,
    featured: db.data.config.featured,
    maxPartySize: db.data.config.maxPartySize,
    maxRooms: db.data.config.maxRooms,
    // Per-feature switches (on / hidden), already resolved for this viewer.
    features: featureFlags(db.data.config, new Date(), { role: account?.role }),
  };
}

/**
 * The catalog as `account` may see it.  A player loses the games an owner
 * switched off or hid; a viewer the game is kept for keeps it, annotated with
 * `hiddenFor` so a card can badge what other players are missing.  A staff
 * member who is *below* a game's keep-floor loses it like anyone else - the
 * admin console has its own list and still shows them the switch.
 */
export function catalogFor(account = null) {
  const role = account?.role;
  return catalogWithEngines(engineCatalog()).flatMap((game) => {
    const state = gameState(db.data.config, game.id);
    const hiddenFor = state.on === false ? 'off' : state.hidden === true ? 'hidden' : null;
    if (!hiddenFor) return [game];
    if (gameKept(db.data.config, game.id, role)) return [{ ...game, hiddenFor }];
    return [];
  });
}
