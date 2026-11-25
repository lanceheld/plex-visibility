# Plex Visibility

[![Quality gate status](https://sonarcloud.io/api/project_badges/measure?project=lanceheld_plex-visibility&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=lanceheld_plex-visibility)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=lanceheld_plex-visibility&metric=coverage)](https://sonarcloud.io/summary/new_code?id=lanceheld_plex-visibility)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=lanceheld_plex-visibility&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=lanceheld_plex-visibility)
[![Security issues](https://sonarcloud.io/api/project_badges/measure?project=lanceheld_plex-visibility&metric=software_quality_security_issues)](https://sonarcloud.io/summary/new_code?id=lanceheld_plex-visibility)
[![Donate with Venmo](https://img.shields.io/badge/Venmo-donate-008CFF?logo=venmo&logoColor=white)](https://venmo.com/u/lanceheld)

Watches your Plex Media Server's **Remote Access** status and alerts you when the server stops being reachable from outside your network, and again when it recovers. It's one Docker container with a web UI for setup, history, and choosing where alerts go.

> **Why not a Plex plugin?** Plex retired its plugin framework in 2018–2019, and current servers no longer load plugins. The supported approach is a small service that talks to the Plex HTTP API, which is what this is.

## Quick start

```sh
docker compose up -d
```

This pulls `ghcr.io/lanceheld/plex-visibility:stable`. To build from source instead, run `docker compose up -d --build`.

Open <http://localhost:8080>, go to **Settings**, then:

1. **Log in as admin** with the default password `admin`. You'll be asked to choose a new password straight away.
2. **Sign in with Plex.** This finds your server and stores a token scoped to it. You can also enter an address and token by hand.
3. **Add a destination.** Search about 180 services (email, ntfy, Pushover, Telegram, Discord, Slack, and others), fill in the URL, and send a test.
4. **Optional but recommended: add a heartbeat URL.** See [the blind spot](#the-blind-spot-and-the-heartbeat).

### Admin password

Settings and everything that changes them need the admin password. The status page stays viewable without logging in.

- The password is stored as a scrypt hash in `/config/plex-visibility/auth.json`. Changing it signs out all other browsers.
- Repeated wrong passwords from one address are locked out for a while.
- **Forgot it?** Stop the container, delete `config/plex-visibility/auth.json`, and start it again. The password goes back to `admin`.

## How it works

Plex already tests its own reachability: plex.tv periodically connects back to your public IP and port and records whether it got through. The server shows that result at `GET /myplex/account`, the same data behind _Settings → Remote Access_ ("Fully accessible outside your network"). The monitor reads it on a schedule and classifies the result:

| State                   | Meaning                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Reachable               | `mappingState=mapped`                                                              |
| Not reachable remotely  | Server is up, but plex.tv can't reach it (port forward, UPnP, CGNAT, IP change, …) |
| Signed out of plex.tv   | Remote access can't work until the server is signed back in                        |
| Server not responding   | The monitor can't reach the Plex server at all                                     |
| Can't sign in to server | The stored token was rejected; sign in again                                       |

Alerts are debounced. You get **one** alert after N consecutive bad checks, optional "still down" reminders, a new alert if the reason changes, and a **recovery** message with the outage length.

### Inside the container

The image is built on the official [apprise-api](https://github.com/caronc/apprise-api) image (`caronc/apprise`), with Node added. Its supervisord runs everything:

- **apprise-api** (nginx + gunicorn): delivers notifications. It listens on `127.0.0.1:8000` only, so it isn't exposed.
- **plex-visibility** (Node/TypeScript): the monitor loop, the API, and the React UI on port `8080`.

Destination URLs are stored on the server and only shown masked in the UI. The Plex token is never sent to the browser.

### The blind spot, and the heartbeat

If the power, the host, or your internet connection goes down, the monitor can't send anything, and that's often exactly when remote access breaks. To cover it, create a free [healthchecks.io](https://healthchecks.io) check (or an Uptime Kuma push monitor) and paste its URL under **Settings → Heartbeat**. The monitor pings it after every check, and healthchecks.io alerts you if the pings stop.

## Images

Images are published to `ghcr.io/lanceheld/plex-visibility` for `linux/amd64` and `linux/arm64`:

| Tag                | Built from                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `stable`           | The latest published GitHub release                                                                     |
| `1.2.3`            | Release `v1.2.3`                                                                                        |
| `latest`           | The latest commit on `main` (snapshot)                                                                  |
| `1.2.3-4-gabc1234` | A specific snapshot: 4 commits after `v1.2.3`, at commit `abc1234` (`0.0.0-…` before the first release) |

Use `stable` unless you want unreleased changes.

Releases (`stable` and version tags) are also published to Docker Hub. Snapshots are on GHCR only.

## Configuration

Everything is set in the UI and saved to `/config/plex-visibility/settings.json` (the `./config` volume). Environment variables:

| Variable                                                 | Default   |                                                                                                                          |
| -------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                                                   | `8080`    | Web UI port inside the container                                                                                         |
| `PUID` / `PGID`                                          | `1000`    | User the processes run as, so `./config` is owned by you                                                                 |
| `TZ`                                                     | `Etc/UTC` | Time zone for logs                                                                                                       |
| `PLEX_URL`, `PLEX_TOKEN`, `NOTIFY_URLS`, `HEARTBEAT_URL` |           | Optional: pre-fill settings on **first** start only, for headless setups. `NOTIFY_URLS` is space-separated Apprise URLs. |

**Networking:** the monitor needs to reach Plex at the address you pick, usually its LAN address (the sign-in flow lists local addresses first). If Plex runs on the same host with host networking, you can instead use `network_mode: host` and `http://localhost:32400`.

## Support

If Plex Visibility is useful to you, you can support its development with a donation through [Venmo](https://venmo.com/u/lanceheld). Thank you!

## Development

Requires Node 22+.

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

Layout:

- `server/src`: Hono API, monitor loop (`service.ts`), alert state machine (`monitor.ts`), Plex status (`plex.ts`) and sign-in (`plexAuth.ts`), apprise client (`notify.ts`)
- `web/src`: React + Tailwind UI
- `Dockerfile`: builds both, then layers Node and the app onto `caronc/apprise`
