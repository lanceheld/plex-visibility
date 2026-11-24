# Plex Visibility

Watches your Plex Media Server's **Remote Access** status and alerts you when the server stops being reachable from outside your network, and again when it recovers. It's one Docker container with a web UI for setup, history, and choosing where alerts go.

> **Why not a Plex plugin?** Plex retired its plugin framework in 2018–2019, and current servers no longer load plugins. The supported approach is a small service that talks to the Plex HTTP API, which is what this is.

## Quick start

```sh
docker compose up -d --build
```

Open <http://localhost:8080>, go to **Settings**, then:

1. **Sign in with Plex.** This finds your server and stores a token scoped to it. You can also enter an address and token by hand.
2. **Add a destination.** Search about 180 services (email, ntfy, Pushover, Telegram, Discord, Slack, and others), fill in the URL, and send a test.
3. **Optional but recommended: add a heartbeat URL.** See [the blind spot](#the-blind-spot-and-the-heartbeat).

Set `UI_PASSWORD` if anyone else can reach port 8080. The settings page can change where your alerts go.

## How it works

Plex already tests its own reachability: plex.tv periodically connects back to your public IP and port and records whether it got through. The server shows that result at `GET /myplex/account`, the same data behind *Settings → Remote Access* ("Fully accessible outside your network"). The monitor reads it on a schedule and classifies the result:

| State | Meaning |
| --- | --- |
| Reachable | `mappingState=mapped` |
| Not reachable remotely | Server is up, but plex.tv can't reach it (port forward, UPnP, CGNAT, IP change, …) |
| Signed out of plex.tv | Remote access can't work until the server is signed back in |
| Server not responding | The monitor can't reach the Plex server at all |
| Can't sign in to server | The stored token was rejected; sign in again |

Alerts are debounced. You get **one** alert after N consecutive bad checks, optional "still down" reminders, a new alert if the reason changes, and a **recovery** message with the outage length.

### Inside the container

The image is built on the official [apprise-api](https://github.com/caronc/apprise-api) image (`caronc/apprise`), with Node added. Its supervisord runs everything:

- **apprise-api** (nginx + gunicorn): delivers notifications. It listens on `127.0.0.1:8000` only, so it isn't exposed.
- **plex-visibility** (Node/TypeScript): the monitor loop, the API, and the React UI on port `8080`.

Destination URLs are stored on the server and only shown masked in the UI. The Plex token is never sent to the browser.

### The blind spot, and the heartbeat

If the power, the host, or your internet connection goes down, the monitor can't send anything, and that's often exactly when remote access breaks. To cover it, create a free [healthchecks.io](https://healthchecks.io) check (or an Uptime Kuma push monitor) and paste its URL under **Settings → Heartbeat**. The monitor pings it after every check, and healthchecks.io alerts you if the pings stop.

## Configuration

Everything is set in the UI and saved to `/config/plex-visibility/settings.json` (the `./config` volume). Environment variables:

| Variable | Default | |
| --- | --- | --- |
| `UI_PASSWORD` | *(none)* | Protects the UI and API with HTTP basic auth (any username) |
| `PORT` | `8080` | Web UI port inside the container |
| `PUID` / `PGID` | `1000` | User the processes run as, so `./config` is owned by you |
| `TZ` | `Etc/UTC` | Time zone for logs |
| `PLEX_URL`, `PLEX_TOKEN`, `NOTIFY_URLS`, `HEARTBEAT_URL` | | Optional: pre-fill settings on **first** start only, for headless setups. `NOTIFY_URLS` is space-separated Apprise URLs. |

**Networking:** the monitor needs to reach Plex at the address you pick, usually its LAN address (the sign-in flow lists local addresses first). If Plex runs on the same host with host networking, you can instead use `network_mode: host` and `http://localhost:32400`.

## Development

Requires Node 22+.

```sh
npm install
npm test            # server unit tests
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
