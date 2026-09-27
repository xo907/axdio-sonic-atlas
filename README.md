# Sonic Atlas

A plugin for [Axdio](https://github.com/xo907/axdio) that turns your whole music library into a map of how it sounds,
and lets you draw journeys across it.

- **Every song is a star.** Left to right is calm to intense; bottom to top is dark to bright. The four corners are
  moods: Dreamy, Euphoric, Melancholic and Fierce. A star's colour is its musical key on the Camelot wheel, and songs
  you play a lot shine bigger.
- **Draw a journey.** Choose **Draw a journey** and drag a line across the map: start somewhere calm, climb to a peak,
  come back down. The songs along the line become a playlist, each one chosen to follow the one before in key and
  tempo, the way a DJ mixes. Play it, make it longer or shorter, or save it as a playlist.
- **Autopilot** has journeys ready to go: Warm up, Wind down, Peak and back, Sunrise, Night drive, Daydream, and
  **Somewhere new**, from the song playing now to the other side of the map.
- **Sonic twins.** Click a star (or open a song's menu anywhere in Axdio) for the songs that sound most like it,
  played in an order where each one flows into the next.
- **Find anything:** search for an artist, song or album to light up where it lives. **Liked** shows the part of the
  map you love. A faint line traces the last songs you played.
- Works in both of Axdio's players, on computers and phones (drag, pinch, tap).

Nothing leaves your server: every song is listened to once, on the server (a minute of it, from about a third of the way in), and what
Sonic Atlas works out (tempo, key, energy, brightness) is kept in `config/plugins/data/atlas`.

## Installing

Axdio 2.12 or newer. In the admin panel, open **Plugins → Add a plugin**, paste
`https://github.com/xo907/axdio-sonic-atlas`, and install it. It brings [NumPy](https://numpy.org) along, which Axdio
installs into its plugin environment.

Then the server starts mapping in the background, at low priority. A song takes 1–2 seconds from a local disk, and more
from a network or cloud mount (about 6–8 seconds on a Raspberry Pi reading an encrypted cloud drive), so a large library
takes from a few hours to a day. Stars appear as it goes. The admin panel's **Sonic Atlas** page shows how far it has got, and can
pause it or make it faster. Songs added later are mapped as the library finds them.

Listeners open the map from the account menu on computers, **Settings → Extras** on phones, or the card on the home
page.

## How it works

For each song, `analysis.py` decodes a minute with ffmpeg and measures:

| | How |
|---|---|
| Tempo | How regularly new sounds start: the autocorrelation of an onset envelope (spectral flux), 55 to 215 BPM, favouring 80 to 160 |
| Key | The strength of each pitch class, compared with the Krumhansl-Kessler major and minor profiles |
| Energy | Loudness, how many notes start each second, how much the sound changes, and tempo |
| Brightness | Where the sound's weight sits (spectral centroid), major or minor, how strong the beat is, and how noisy it is |

Energy and brightness are placed by rank, so every part of the map has songs, with some of the real distances kept.
Journeys pick, near each point of the line, the song whose key sits next to the last one on the Camelot wheel and
whose tempo is close (half and double time count), without the same artist twice in a row. Sonic twins compare all
eight measurements.

## Development

It's a folder plugin: `axdio-plugin.json` describes it, `server.py` runs in the server, `static/atlas.js` in the
player and `static/admin.js` in the admin panel (Axdio's PLUGINS.md describes all of it). To work on it, mount this
folder into an Axdio container and install it with **Add a plugin → From a folder**, then **Reinstall** it after
changes.

The measurements' tests need ffmpeg and NumPy (Axdio's image has ffmpeg):

```bash
pip install numpy
python -m unittest discover -s tests -v
```

Releases are tags named `vX.Y.Z`, the version in `axdio-plugin.json`.

## License

MIT, see [LICENSE](LICENSE).
