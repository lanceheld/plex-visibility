# Plex Visibility

[![Quality gate status](https://sonarcloud.io/api/project_badges/measure?project=lanceheld_plex-visibility&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=lanceheld_plex-visibility)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=lanceheld_plex-visibility&metric=coverage)](https://sonarcloud.io/summary/new_code?id=lanceheld_plex-visibility)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=lanceheld_plex-visibility&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=lanceheld_plex-visibility)
[![Security issues](https://sonarcloud.io/api/project_badges/measure?project=lanceheld_plex-visibility&metric=software_quality_security_issues)](https://sonarcloud.io/summary/new_code?id=lanceheld_plex-visibility)
[![Donate with Venmo](https://img.shields.io/badge/Venmo-donate-008CFF?logo=venmo&logoColor=white)](https://venmo.com/u/lanceheld)

**Get a notification when your Plex server stops being reachable from outside your home, and another when it's back.**

If you share your Plex library with family and friends, or watch it away from home, you've probably had remote access quietly break: a router update undoes your port forward, your internet provider changes your IP address, or UPnP stops working. Usually you only find out when someone tells you Plex isn't working.

Plex Visibility watches for this and tells you right away. It runs as a single Docker container, and you set everything up in a web page. No config files required.

## Contents

1. [How it works](#how-it-works)
2. [What you need](#what-you-need)
3. [Install](#install)
4. [Set it up](#set-it-up)
5. [What the statuses mean](#what-the-statuses-mean)
6. [When you get alerts](#when-you-get-alerts)
7. [Covering the blind spot: the heartbeat](#covering-the-blind-spot-the-heartbeat)
8. [Protecting Settings with a PIN](#protecting-settings-with-a-pin)
9. [Advanced configuration](#advanced-configuration)
10. [Updating and choosing a version](#updating-and-choosing-a-version)
11. [Support the project](#support-the-project)
12. [For developers](#for-developers)

## How it works

Plex already checks its own remote access. Every so often, Plex's online service (plex.tv) tries to connect back to your server from the internet and records whether it got through. That's the result you see in Plex under **Settings → Remote Access** ("Fully accessible outside your network").

Plex Visibility asks your Plex server for that result on a regular schedule. When it changes from good to bad, or bad to good, you get a notification by email, phone push, chat app, or whatever you prefer.

> **Why isn't this a Plex plugin?** Plex retired plugins in 2018–2019, and current servers no longer load them. A small companion app that talks to your Plex server is the supported way to do this.

## What you need

- A computer that runs Docker with Docker Compose. This can be the same machine as Plex, or another one on your network (a NAS, a Raspberry Pi, or a home server). Both regular PCs (x86/amd64) and ARM devices (arm64) are supported.
- A Plex account that owns the Plex server you want to watch.
- Somewhere to receive alerts. About 180 services are supported, including email, ntfy, Pushover, Telegram, Discord and Slack.

## Install

1. Make a folder for Plex Visibility and download [`docker-compose.yml`](docker-compose.yml) into it.
2. In the file, set `TZ` to your time zone (for example `America/New_York`). If you're on Linux, set `PUID` and `PGID` to your own user and group IDs (run `id` to find them) so you own the files it saves.
3. From that folder, run:

   ```sh
   docker compose up -d
   ```

4. Open <http://localhost:8080> in a browser. If Plex Visibility is on another machine, use that machine's address instead of `localhost`, for example `http://192.168.1.20:8080`.

Your settings and history are saved in a `config` folder next to `docker-compose.yml`, so they survive restarts and updates.

## Set it up

In the web page, open **Settings** and work through these steps:

1. **Sign in with Plex.** This finds your server and connects to it. Choose the address on your home network (these are listed first). If you'd rather, you can type in the server address and a Plex token yourself.
2. **Add a destination**, which is where alerts are sent. Search for your service (for example "Pushover" or "email"), fill in the details, and send a test to make sure it arrives. You can add more than one.
3. **Add a heartbeat (recommended).** This catches the one situation Plex Visibility can't report on its own. See [the heartbeat](#covering-the-blind-spot-the-heartbeat).
4. **Set a PIN (recommended).** This stops other people on your network from changing your settings. See [Protecting Settings with a PIN](#protecting-settings-with-a-pin).

That's it. The main page shows your server's current status and a history of past problems.

## What the statuses mean

| Status                  | What it means and what to check                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reachable               | Everything's fine. Plex can be reached from the internet.                                                                                                                     |
| Not reachable remotely  | Your Plex server is running, but plex.tv can't reach it from outside. Common causes: a lost port forward, UPnP failing, a new public IP address, or CGNAT from your provider. |
| Signed out of plex.tv   | Your Plex server has been signed out of your Plex account. Remote access can't work until you sign it back in from Plex's settings.                                           |
| Server not responding   | Plex Visibility can't reach your Plex server at all. Plex may be stopped, or its address may have changed.                                                                    |
| Can't sign in to server | Your Plex server rejected the saved sign-in. Go to **Settings** and sign in with Plex again.                                                                                  |

## When you get alerts

Plex Visibility is designed not to spam you over a momentary glitch:

- You get **one** alert after several checks in a row have failed, not on the first failure.
- If you turn them on, you get **"still down" reminders** while the problem lasts.
- If the reason changes (for example from "not reachable remotely" to "server not responding"), you get a new alert.
- When things are fixed, you get a **recovery** message that says how long the outage lasted.

## Covering the blind spot: the heartbeat

There's one problem Plex Visibility can't warn you about by itself: if the power, the machine it runs on, or your whole internet connection goes down, it has no way to send a message. That's often exactly when remote access breaks.

A heartbeat covers this. You set up a free check with an outside service that expects to hear from Plex Visibility regularly and alerts _you_ if it goes quiet.

1. Create a free account at [healthchecks.io](https://healthchecks.io) and add a check. (An Uptime Kuma "push" monitor works too.)
2. Copy the check's ping URL.
3. Paste it into **Settings → Heartbeat** in Plex Visibility.

Plex Visibility pings that URL after every check. If the pings stop, healthchecks.io notifies you.

## Protecting Settings with a PIN

Without a PIN, anyone on your network who can open the Plex Visibility page can change its settings or download a backup, and the backup includes your Plex sign-in token. Set a PIN unless you're the only one who can reach the page. The status page stays viewable without the PIN.

- **Set, change or remove the PIN** under **Settings → Security**. It's a 6-digit code, like the one Plex itself uses. Changing it signs out every other browser.
- **Too many wrong guesses** lock out further attempts for a while.
- **Forgot your PIN?** Choose **Forgot PIN?** and sign in with the Plex account that owns the server. This removes the PIN so you can set a new one. People you share your server with can't do this. As a safety measure, your alert destinations get a message whenever the PIN is removed this way.
- **Can't use the Plex sign-in** (for example, you haven't connected a server yet)? Stop the container, delete the file `config/plex-visibility/auth.json`, and start it again. The PIN is removed. (The PIN itself is stored as a secure hash, never as the plain number.)

## Advanced configuration

Most people won't need anything in this section.

### Settings in `docker-compose.yml`

| Setting         | Default   | What it does                                                                           |
| --------------- | --------- | -------------------------------------------------------------------------------------- |
| `TZ`            | `Etc/UTC` | Your time zone, used for times in the logs.                                            |
| `PUID` / `PGID` | `1000`    | The user and group Plex Visibility runs as, so the files in `config` are owned by you. |
| `PORT`          | `8080`    | The port the web page uses inside the container.                                       |
| `UPDATE_CHECK`  | `true`    | Set to `false` to stop checking GitHub for new releases.                               |

To open the web page on a different port, change the left-hand number under `ports` (for example `'9090:8080'`).

### Setting up without the web page

If you manage your setup entirely through files, you can pre-fill the settings with these. They're only read the **first** time the container starts. After that, use the web page.

| Setting         | What it does                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `PLEX_URL`      | Your Plex server's address, for example `http://192.168.1.10:32400`.                               |
| `PLEX_TOKEN`    | A Plex token for that server.                                                                      |
| `NOTIFY_URLS`   | Alert destinations as [Apprise URLs](https://github.com/caronc/apprise/wiki), separated by spaces. |
| `HEARTBEAT_URL` | Your heartbeat ping URL.                                                                           |

All settings you make in the web page are saved to `config/plex-visibility/settings.json`.

### Networking

Plex Visibility needs to reach your Plex server at the address you choose, usually its address on your home network. If Plex runs on the same machine and uses host networking, you can instead add `network_mode: host` to `docker-compose.yml` and use `http://localhost:32400` as the Plex address.

### Privacy and what's inside the container

Your Plex token never leaves the server side of Plex Visibility; it's never sent to your browser. Alert destination details are shown masked in the web page.

The container runs two things:

- **Plex Visibility** itself: the monitor and the web page, on port 8080.
- **[Apprise](https://github.com/caronc/apprise-api)**: the open-source tool that sends notifications to all those services. It's only reachable from inside the container.

## Updating and choosing a version

Plex Visibility checks GitHub for new releases twice a day. When one is out, a banner at the top of the page links to its release notes. Dismissing the banner hides it until the next release.

To update to the newest release, from the folder with `docker-compose.yml` run:

```sh
docker compose pull
docker compose up -d
```

Images are published to `ghcr.io/lanceheld/plex-visibility`. Releases are also published to Docker Hub. You choose which version you get with the tag at the end of the `image:` line in `docker-compose.yml`:

| Tag                | What you get                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `stable`           | The latest official release. **Use this unless you have a reason not to.**                                      |
| `1.2.3`            | A specific release, which never changes. Useful if you want to update only when you choose.                     |
| `latest`           | The newest, unreleased development version. May contain bugs. (GitHub only.)                                    |
| `1.2.3-4-gabc1234` | One specific development version, here 4 changes after release 1.2.3. Mostly useful for testing. (GitHub only.) |

## Support the project

If Plex Visibility is useful to you, you can support its development with a donation through [Venmo](https://venmo.com/u/lanceheld). Thank you!

## For developers

This section is for people who want to change the code.

### Build from source

```sh
docker compose up -d --build
```

### Local development

Requires Node 22 or newer. Alternatively, open the repository in its dev container (VS Code: **Dev Containers: Reopen in Container**), which includes Node, Docker, Claude Code and the GitHub CLI, and runs `npm ci` when created. Run `claude` and `gh auth login` once inside to sign in; both logins are kept across rebuilds.

```sh
npm install
npm test            # server unit tests
npm run lint        # oxlint
npm run format      # prettier
npm run typecheck
```

To run locally against a real apprise-api, start one with `docker run -p 127.0.0.1:8000:8000 caronc/apprise`, then:

```sh
DATA_DIR=./config/plex-visibility npm run dev   # API on :8080, UI with hot reload on :5173
```

### How it fits together

The monitor reads the `mappingState` field from the Plex server's `GET /myplex/account` endpoint (`mapped` means reachable). The Docker image is built on the official `caronc/apprise` image with Node added, and its supervisord runs both apprise-api (nginx + gunicorn, bound to `127.0.0.1:8000`) and the Node app.

- `server/src`: Hono API, monitor loop (`service.ts`), alert state machine (`monitor.ts`), Plex status (`plex.ts`) and sign-in (`plexAuth.ts`), Apprise client (`notify.ts`)
- `web/src`: React + Tailwind UI
- `Dockerfile`: builds both, then layers Node and the app onto `caronc/apprise`
