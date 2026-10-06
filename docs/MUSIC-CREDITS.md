# Music credits

Memes Arcade ships **no audio files**. All background music is generated live in
the browser with the Web Audio API (`web/js/audio.js`) - chiptune patterns built
from oscillators and envelopes. That means zero download, zero licensing
questions, and it keeps working offline.

| Track | Mood | BPM |
|---|---|---|
| Neon Runner | arcade | 128 |
| Lofi Pixel | chill | 84 |
| Hype Train | hype | 150 |
| Chip Suite | retro | 110 |
| Zen Garden | ambient | 72 |
| Boss Rush | intense | 160 |

Toggle music from the speaker icon in the top bar or **Settings → Music &
sound**. Your choice is stored on your account, so the desktop app and the
website agree.

## Adding your own songs

Drop `.mp3`, `.ogg` or `.wav` files into `web/assets/music/`. They appear in
**Settings → Music & sound** automatically (the server lists the folder at
`/api/music`), and the settings page plays them alongside the generated tracks.

Only add music you have the right to use. Free sources with clear licences:

- **Free Music Archive** (freemusicarchive.org) - filter by CC0 / CC-BY
- **Incompetech** (incompetech.com) - Kevin MacLeod, CC-BY with attribution
- **Pixabay Music** (pixabay.com/music) - Pixabay licence, no attribution needed
- **OpenGameArt** (opengameart.org) - game-focused, mixed licences

Whatever you add, **write the attribution here** before sharing the arcade
publicly:

```
filename.mp3 - Track Name by Artist - Licence (source URL)
```

Note that `web/assets/music/` is included in the **Desktop Host** download, so
anything you add ships with it. Files you would rather not redistribute should
live outside the repo.
