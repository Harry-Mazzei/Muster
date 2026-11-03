# Muster

A parade music console for cadet and service parades. Build a parade from your own ceremonial music,
then run it with three big buttons: **GO**, **AS YOU WERE** and **STOP**. Changes and stops land on the
beat, so the band never cuts off mid-bar.

## Features

- **Run:** GO plays the next movement, or changes to it on the next beat point. STOP finishes on a beat
  point (press twice to stop at once). AS YOU WERE cancels or undoes.
- **Roll on:** a movement can roll straight into the next with no gap.
- **Practice:** a library of every track with a floating player, auto-play, repeat and fade.
- **Parades:** save as many running orders as you like, each with labels, cues, loops and transitions.
- **Beat detection:** finds the tempo and beat points of each track, including slow-to-quick changes.
  It also trims the silence at the start and end. Everything can be adjusted by hand.
- **Emergency play:** salutes and calls on a key press, plus favourites on keys 1–9.
- **Keyboard and foot pedals:** Space / Left / Esc, or a page-turner pedal (Page Down / Page Up).
- **Safe audio:** if the laptop sleeps or the browser pauses audio, Muster stops cleanly and GO carries
  on from the same spot.
- Day and night themes.

## Two ways to run it

| | Laptop app | Web version |
| --- | --- | --- |
| Where | Your Mac or Windows laptop, opened in your browser | `https://<your-username>.github.io/muster/` |
| Sign-in | None needed (only reachable from that laptop) | Google or email account (each person sees only their own), or guest mode |
| Parades and settings | In the `data` folder next to the app | In each person's account, synced between their laptops (guests: this browser only) |
| Music | In the `music` folder next to the app | Your own music in `tracks/` loads by itself (public). Anything else, choose once per laptop (stays private) |
| Internet | Never needed | Needed to sign in. Opens offline after that |

The laptop app is built by the **Build laptop apps** workflow. On GitHub, open **Actions**, choose the
latest run and download **Muster** under *Artifacts*. Unzip it, copy your music into `music/` and start it
(see `launch/README.txt`).

To build it yourself, install Go 1.24 or newer, then run `cd server && go build -o muster .`

To set up the web version, follow **[SETUP.md](SETUP.md)**.

## Privacy and security

- **Only your own music.** `tracks/` is for music you made or may share, and it's public. Ceremonial
  recordings belong to their copyright holders and stay on your laptops. `.gitignore` blocks audio
  everywhere except `tracks/`.
- **No secrets in this repository.** The values in `server/web/firebase-config.js` only name a Firebase
  project and are meant to be public. Access is controlled by the Firestore security rules (see SETUP.md):
  each signed-in person can only read and write their own parades, and nobody can see anyone else's.
- **The laptop app** only answers requests from the same computer (`localhost`) and refuses anything else.
- **The web version** never uploads music. Audio stays in the browser's own storage on each laptop.

## Project layout

```
server/            Go laptop app (serves the web folder and keeps data in files)
server/web/        The app itself: HTML, CSS and JavaScript. Also published as the web version
server/web/cloud.js   Web-version storage: Google sign-in, Firestore and in-browser music
tracks/            Your own music, published with the web version (public)
tools/analyze.js   Optional: precompute beat points for a music folder with Node + ffmpeg
launch/            Mac launcher and the guide that ships with the laptop app
```

## Licence

MIT. See [LICENSE](LICENSE). Third-party software and licences are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
