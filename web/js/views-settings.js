/** Profile and Settings views (the admin console lives in views-admin.js). */
import { el, btn, pill, avatar, toast, modal, timeAgo } from './dom.js';
import { state, setSettings, KEYBIND_ACTIONS, THEMES, bindKeyCapture } from './store.js';
import { api } from './api.js';
import { rt } from './realtime.js';
import { toggleMusic, setTrack, TRACKS, sfx, listMusicFiles } from './audio.js';

/* ------------------------------------------------------------------ *
 * profile
 * ------------------------------------------------------------------ */

export function profileView(mount) {
  const me = state.me;
  if (!me) return;
  const avatarInput = el('input', { class: 'input', value: me.avatar || '🙂', maxlength: 4, style: { width: '90px' } });
  const bioInput = el('textarea', { class: 'input area', maxlength: 240, value: me.bio || '' });

  mount.appendChild(el('div', { class: 'card' },
    el('div', { class: 'row' },
      avatar(me, 56),
      el('div', {},
        el('h1', { text: me.name }),
        el('div', { class: 'row' }, pill(`level ${me.level}`), pill(`${me.xp} xp`), pill(`${me.coins} 🪙`), me.role !== 'user' ? pill(me.role, 'good') : null, pill(`joined ${timeAgo(me.createdAt)}`)),
      ),
    ),
    el('div', { class: 'stat-grid' },
      stat('Games', me.stats?.games ?? 0),
      stat('Wins', me.stats?.wins ?? 0),
      stat('Losses', me.stats?.losses ?? 0),
      stat('Draws', me.stats?.draws ?? 0),
      stat('Win streak', me.stats?.streak ?? 0),
      stat('Best streak', me.stats?.bestStreak ?? 0),
    ),
  ));

  mount.appendChild(el('div', { class: 'card' },
    el('h3', { text: 'Edit profile' }),
    el('div', { class: 'row' }, el('span', { class: 'muted', text: 'Avatar emoji:' }), avatarInput),
    el('label', {}, 'Bio', bioInput),
    btn('Save profile', async () => {
      try {
        const res = await api.post('/api/profile', { avatar: avatarInput.value, bio: bioInput.value });
        state.me.avatar = res.user.avatar;
        state.me.bio = res.user.bio;
        toast('Profile saved', 'good');
        window.__render();
      } catch (err) {
        toast(err.message, 'bad');
      }
    }, { variant: 'primary' }),
  ));

  const byGame = me.stats?.byGame || {};
  const played = Object.entries(byGame).sort((a, b) => b[1] - a[1]);
  mount.appendChild(el('div', { class: 'card' },
    el('h3', { text: 'Games you have played' }),
    played.length ? el('div', { class: 'row' }, played.map(([id, n]) => {
      const game = state.catalog.find((g) => g.id === id);
      return pill(`${game?.icon || '🎮'} ${game?.name || id} ×${n}`);
    })) : el('p', { class: 'muted', text: 'Nothing yet - go play something!' }),
  ));

  api.get(`/api/users/${me.id}`).then((res) => {
    if (res.achievements?.length) {
      mount.appendChild(el('div', { class: 'card' }, el('h3', { text: 'Achievements' }),
        el('div', { class: 'row' }, res.achievements.map((a) => pill(`${a.icon} ${a.name}`, 'good')))));
    }
  }).catch(() => {});
}

function stat(label, value) {
  return el('div', { class: 'stat' }, el('div', { class: 'stat-num', text: String(value) }), el('div', { class: 'muted small', text: label }));
}

/* ------------------------------------------------------------------ *
 * settings
 * ------------------------------------------------------------------ */

export function settingsView(mount) {
  const s = state.settings;

  mount.appendChild(el('div', { class: 'card' },
    el('h1', { text: 'Settings' }),
    el('p', { class: 'muted', text: 'Everything here is stored on your account, so the website, desktop client and Discord bot all pick it up.' }),
  ));

  /* appearance */
  mount.appendChild(el('div', { class: 'card' },
    el('h3', { text: '🎨 Appearance' }),
    el('div', { class: 'row' }, THEMES.map((t) => btn(t.name, () => { setSettings({ theme: t.id }); window.__render(); }, { cls: `sm ${s.theme === t.id ? 'primary' : ''}` }))),
    el('div', { class: 'row' },
      el('label', { class: 'row' }, 'Accent', el('input', { type: 'color', value: s.accent, onInput: (ev) => setSettings({ accent: ev.target.value }) })),
      el('label', { class: 'row' }, el('input', { type: 'checkbox', checked: s.reduceMotion, onChange: (ev) => setSettings({ reduceMotion: ev.target.checked }) }), 'Reduce motion'),
      el('label', { class: 'row' }, el('input', { type: 'checkbox', checked: s.gameplay?.largeText, onChange: (ev) => setSettings({ gameplay: { largeText: ev.target.checked } }) }), 'Larger text'),
    ),
  ));

  /* audio */
  const musicToggle = el('input', { type: 'checkbox', checked: s.audio.music, onChange: (ev) => { toggleMusic(ev.target.checked); setSettings({ audio: { music: ev.target.checked } }, { persist: false }); window.__render(); } });
  const trackSelect = el('select', { class: 'input', onChange: (ev) => { setTrack(ev.target.value); setSettings({ audio: { track: ev.target.value } }, { persist: false }); } },
    TRACKS.map((t) => el('option', { value: t.id, selected: s.audio.track === t.id, text: `${t.name} · ${t.mood} · ${t.bpm}bpm` })));
  const musicVol = el('input', { class: 'slider', type: 'range', min: 0, max: 1, step: 0.01, value: s.audio.musicVolume, onInput: (ev) => import('./audio.js').then((m) => m.setMusicVolume(Number(ev.target.value))) });
  const sfxVol = el('input', { class: 'slider', type: 'range', min: 0, max: 1, step: 0.01, value: s.audio.sfxVolume, onInput: (ev) => import('./audio.js').then((m) => m.setSfxVolume(Number(ev.target.value))) });

  mount.appendChild(el('div', { class: 'card' },
    el('h3', { text: '🔊 Music & sound' }),
    el('div', { class: 'row' }, el('label', { class: 'row' }, musicToggle, 'Background music'), el('button', { class: 'btn sm', text: 'Test sound', onClick: () => sfx('notify') })),
    el('div', { class: 'col' }, el('span', { class: 'muted small', text: 'Track (generated live - no downloads, no licensing worries)' }), trackSelect),
    el('div', { class: 'col' }, el('span', { class: 'muted small', text: 'Music volume' }), musicVol),
    el('div', { class: 'col' }, el('span', { class: 'muted small', text: 'Effects volume' }), sfxVol),
    el('p', { class: 'muted small', text: 'Want your own songs? Drop .mp3/.ogg files into web/assets/music - see docs/MUSIC-CREDITS.md for free sources.' }),
    el('div', { class: 'row', id: 'music-files' }),
  ));
  listMusicFiles().then((files) => {
    const box = document.getElementById('music-files');
    if (!box || !files.length) return;
    box.replaceChildren(...files.map((f) => btn(`▶ ${f.name}`, () => import('./audio.js').then((m) => { m.toggleMusic(false); m.playFile(f.url, state.settings.audio.musicVolume); }), { cls: 'sm' })));
  });

  /* keybinds */
  const rows = el('div', { class: 'col' },
    KEYBIND_ACTIONS.map(([action, label]) => el('div', { class: 'keybind-row' },
      el('span', { text: label }),
      bindKeyCapture(el('span'), action))),
  );
  mount.appendChild(el('div', { class: 'card' },
    el('h3', { text: '⌨️ Keybinds' }),
    el('p', { class: 'muted small', text: 'Click a binding and press the key you want. Escape cancels. These are used by the arcade games and the desktop client.' }),
    rows,
    el('div', { class: 'row' }, btn('Reset to defaults', () => {
      setSettings({ keybinds: null });
      state.settings.keybinds = {};
      import('./store.js').then((m) => setSettings({ keybinds: { ...m.DEFAULT_KEYBINDS } }));
      window.__render();
    }, { cls: 'sm' })),
  ));

  /* gameplay + privacy */
  mount.appendChild(el('div', { class: 'card' },
    el('h3', { text: '🎮 Gameplay' }),
    toggle('Confirm moves before sending', s.gameplay?.confirmMoves, (v) => setSettings({ gameplay: { confirmMoves: v } })),
    toggle('Auto-ready in party games', s.gameplay?.autoReady, (v) => setSettings({ gameplay: { autoReady: v } })),
    toggle('Show turn timers', s.gameplay?.timers !== false, (v) => setSettings({ gameplay: { timers: v } })),
    toggle('Colourblind-safe palettes', s.gameplay?.colorblindSafe, (v) => setSettings({ gameplay: { colorblindSafe: v } })),
    toggle('Low-spec mode (fewer animations)', s.gameplay?.lowSpec, (v) => setSettings({ gameplay: { lowSpec: v } })),
    el('h3', { text: '🔒 Privacy' }),
    toggle('Show me in the public lobby', s.privacy?.showInLobby !== false, (v) => setSettings({ privacy: { showInLobby: v } })),
    toggle('Allow party invites', s.privacy?.allowInvites !== false, (v) => setSettings({ privacy: { allowInvites: v } })),
    el('div', { class: 'row' }, el('span', { class: 'muted', text: 'Presence:' }),
      ...['online', 'idle', 'dnd', 'invisible'].map((p) => btn(p, () => {
        setSettings({ privacy: { presence: p } });
        rt.send({ t: 'presence', status: p });
      }, { cls: `sm ${s.privacy?.presence === p ? 'primary' : ''}` }))),
    el('div', { class: 'row' }, el('span', { class: 'muted', text: 'Who can DM you:' }),
      ...['everyone', 'friends'].map((p) => btn(p, () => setSettings({ privacy: { allowDms: p } }), { cls: `sm ${s.privacy?.allowDms === p ? 'primary' : ''}` }))),
  ));

  /* discord bot link */
  const discordCode = el('input', { class: 'input', placeholder: 'code from /link', style: { maxWidth: '220px' } });
  mount.appendChild(el('div', { class: 'card' },
    el('h3', { text: '🤖 Discord bot' }),
    el('p', { class: 'muted small', text: 'Run /link in Discord to get a code, then enter it here. The bot can then show your stats, post ideas and vote as this account.' }),
    el('div', { class: 'row' },
      discordCode,
      btn('Link Discord account', async () => {
        const code = discordCode.value.trim();
        if (!code) return toast('Paste the code the bot showed you.', 'bad');
        try {
          const res = await api.post('/api/discord/claim', { code });
          discordCode.value = '';
          toast('Discord linked - head back to /suggest in Discord.', 'good');
          return res;
        } catch (err) {
          toast(err.message || 'That code did not work.', 'bad');
          return null;
        }
      }, { variant: 'primary' })),
  ));

  /* account */
  const cur = el('input', { class: 'input', type: 'password', placeholder: 'current password' });
  const next = el('input', { class: 'input', type: 'password', placeholder: 'new password' });
  mount.appendChild(el('div', { class: 'card' },
    el('h3', { text: '🔑 Account' }),
    el('div', { class: 'row' }, cur, next, btn('Change password', async () => {
      try {
        await api.post('/api/auth/password', { current: cur.value, next: next.value });
        toast('Password changed', 'good');
        cur.value = next.value = '';
      } catch (err) {
        toast(err.message, 'bad');
      }
    }, { variant: 'primary' })),
    el('div', { class: 'row' },
      btn('Report a bug', () => {
        const input = el('textarea', { class: 'input area', placeholder: 'What happened?' });
        const handle = modal('Report a bug', el('div', { class: 'col' }, input, btn('Send to admins', async () => {
          try {
            await api.post('/api/report', { kind: 'bug', text: input.value });
            handle.close();
            toast('Thanks - the admins can see it now.', 'good');
          } catch (err) {
            toast(err.message, 'bad');
          }
        }, { variant: 'primary' })));
      }, { cls: 'sm' }),
      btn('Sign out', async () => {
        const { logout, isSignedIn } = await import('./api.js');
        await logout();
        location.reload();
      }, { cls: 'sm' }),
    ),
    el('p', { class: 'muted small', text: `Client v${state.client?.version} · server API v${state.server?.apiVersion} · ${state.degraded?.length ? `compat notes: ${state.degraded.join(', ')}` : 'fully compatible'}` }),
  ));
}

function toggle(label, checked, onChange) {
  return el('label', { class: 'row' },
    el('input', { type: 'checkbox', checked: !!checked, onChange: (ev) => onChange(ev.target.checked) }),
    label);
}

