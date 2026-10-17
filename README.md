# Huddle: a LiveKit video-call demo

A small, responsive video-call app built on [LiveKit](https://livekit.io): join a room, see and hear others,
chat, share your screen, raise a hand, react, and record the whole call on the server.

- **Front end:** vanilla JS + CSS (no build step), Font Awesome icons, Inter / JetBrains Mono type, light and dark themes
- **Back end:** a tiny Express server that issues LiveKit access tokens and drives recording
- **Media:** a LiveKit server (WebRTC)
- **Recording:** LiveKit **Egress** writes an MP4 of the whole room to `recordings/`

**Jump to:** [Quick start (Linux / macOS / Windows)](#3-quick-start-calls-only) · [Add recording on your machine](#4-add-recording-on-your-own-machine) · [Deploy to a Linux server](#5-deploy-to-a-linux-server) · [Troubleshooting](#9-troubleshooting)

---

## 1. How it fits together

```
 Browser ──HTTPS──▶ App (Node, :8100) ──API──▶ LiveKit server (:7880) ◀──Redis──▶ Egress ──▶ recordings/*.mp4
    │                                                ▲
    └────────────── WebRTC media (:7881 / :7882) ────┘
```

| Part | What it does |
|---|---|
| **App** (`server.js` + `public/`) | Serves the page, creates join tokens, starts/stops recordings |
| **LiveKit server** | Routes audio and video between participants |
| **Redis** | Message bus between LiveKit and Egress |
| **Egress** | Joins the room as a hidden recorder and writes the MP4 (runs in Docker, headless Chrome inside) |
| **Caddy** (optional) | HTTPS in front of the app and LiveKit, with automatic certificates |

Calls need only the **app + LiveKit server**. **Redis and Egress are only for recording**, and Egress only runs on Linux
(in Docker), which is why recording is set up differently on each OS.

> **Why HTTPS matters:** browsers only allow camera and microphone on `localhost` or over HTTPS. Anything other people
> reach by address needs HTTPS. The [server setup](#5-deploy-to-a-linux-server) includes it.

### What has been tested

| Setup | Status |
|---|---|
| **Windows 11**: app + native LiveKit, recording via Docker in WSL 2 | Built and used here, end to end |
| **Linux, Docker Compose** (the full stack, also used for a server) | Tested on real Linux Docker: all services up, a room joined, a recording started, stopped and saved. **Not** tested on a bare-metal/cloud server, with a real domain, or with browsers on other machines |
| **Linux, native** (LiveKit binary + Node, calls only) | Commands checked against the official install script; not run on a fresh Linux machine |
| **macOS** (Homebrew, calls only) | Commands checked against the Homebrew formula; **not run on a Mac**. Recording on macOS is not supported here, see [4.2](#42-macos) |

If something fails on a platform marked "not run", see [Troubleshooting](#9-troubleshooting) and treat it as a likely
small fix, not a design problem.

---

## 2. Pick your path

| I want to… | Go to |
|---|---|
| Try it on my own computer (video calls, no recording) | [3. Quick start](#3-quick-start-calls-only), then pick Linux, macOS or Windows |
| Also test recording on my own computer | [4. Add recording](#4-add-recording-on-your-own-machine) |
| Run it for other people on a **Linux server** | [5. Deploy to a Linux server](#5-deploy-to-a-linux-server) |
| Skip running a media server | [8. LiveKit Cloud](#8-using-livekit-cloud-instead) |

---

## 3. Quick start (calls only)

This gets video calls working on your own computer in a few minutes, on any OS. You need **Node.js 18+**, the
**LiveKit server**, and a modern browser (Chrome, Edge, Firefox or Safari).

### 3.1 Install the tools

<details open>
<summary><b>Linux</b> (Ubuntu / Debian / Fedora / Arch …)</summary>

**Node.js** (pick one):

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Fedora
sudo dnf install -y nodejs

# Any distro, no sudo: nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# open a new terminal, then:
nvm install --lts
```

**LiveKit server**, using LiveKit's official install script (installs `livekit-server` to `/usr/local/bin`, asks for sudo):

```bash
curl -sSL https://get.livekit.io | bash
```

Or download it yourself: `livekit_<version>_linux_amd64.tar.gz` (or `arm64`, `armv7`) from
<https://github.com/livekit/livekit/releases>, extract it and put `livekit-server` on your `PATH`.

Check both: `node -v` (18 or higher) and `livekit-server --version`.
</details>

<details>
<summary><b>macOS</b> (Intel and Apple Silicon)</summary>

Install [Homebrew](https://brew.sh) if you don't have it, then:

```bash
brew install node livekit
node -v                      # 18 or higher
livekit-server --version
```

LiveKit doesn't publish a macOS download, so Homebrew (the `livekit` formula) is the route.
</details>

<details>
<summary><b>Windows 10 / 11</b></summary>

```powershell
winget install OpenJS.NodeJS.LTS        # skip if `node -v` already shows 18+
```

Download `livekit_<version>_windows_amd64.zip` from <https://github.com/livekit/livekit/releases> and unzip it, for example
to `C:\livekit-server`. Or with the GitHub CLI:

```powershell
gh release download --repo livekit/livekit -p "*windows_amd64.zip"
Expand-Archive livekit_*_windows_amd64.zip -DestinationPath C:\livekit-server
```
</details>

### 3.2 Get the app and configure it

Same on every OS, from a terminal in the project folder:

```bash
npm install
cp .env.example .env          # Windows (cmd/PowerShell): copy .env.example .env
```

`.env` already matches LiveKit's built-in development keys, so you don't need to edit it:

```ini
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
PORT=8100
```

### 3.3 Run it

Open **two terminals** in the project folder.

| | Terminal 1: LiveKit server | Terminal 2: the app |
|---|---|---|
| **Linux / macOS** | `livekit-server --dev` | `npm start` |
| **Windows** | `C:\livekit-server\livekit-server.exe --dev` | `npm start` |

You're ready when LiveKit prints `starting LiveKit server` and the app prints `Demo running at http://localhost:8100`.

Open **<http://localhost:8100>**, allow camera and mic, enter a name and room, and **Join room**. Open a second tab (or
another browser) and join the **same room name** with a different name.

Stop with `Ctrl+C` in each terminal.

> `--dev` is development mode: fixed keys (`devkey` / `secret`) and no HTTPS. It's fine on your own computer. For
> anything shared, use [section 5](#5-deploy-to-a-linux-server).

---

## 4. Add recording on your own machine

Recording uses **Egress**, which is a Linux Docker image. So on your own computer you run it either on Linux, or in WSL 2
on Windows. On macOS see below.

### 4.1 Linux

The simplest way is the same Docker Compose file used for servers, set up for local use. This runs Redis, LiveKit,
Egress and the app together, so **don't run the native LiveKit/app from section 3 at the same time** (the ports clash).

1. **Install Docker Engine + Compose v2:**
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER        # log out and back in
   docker compose version               # prints v2.x
   ```
2. **Configure** (`deploy.env` is a copy of the example):
   ```bash
   cp deploy.env.example deploy.env
   ```
   For local use, edit these lines (the example API keys are fine here):
   ```ini
   PUBLIC_LIVEKIT_URL=ws://localhost:7880
   USE_EXTERNAL_IP=false
   NODE_IP=127.0.0.1
   ```
   `NODE_IP=127.0.0.1` means only browsers on this same computer can join. To let other devices on your network join,
   set it to this machine's LAN IP, but those devices then also need HTTPS for camera access (see [5.4](#54-variations)).
3. **Start it:**
   ```bash
   docker compose --env-file deploy.env up -d --build
   ```
4. Open **<http://localhost:8100>**, join a room, and use the **record** button. Files appear in `./recordings/`.

Stop it with `docker compose --env-file deploy.env down`.

### 4.2 macOS

Calls work (section 3). **Recording on macOS is not supported or tested here.** Egress needs Linux and the Compose file
relies on host networking, which Docker Desktop on Mac doesn't provide by default. Realistic options:

| Option | How |
|---|---|
| **Record via a Linux machine** (recommended) | Run [section 5](#5-deploy-to-a-linux-server) on any Linux server, VM or spare box, and open its address from your Mac's browser. |
| **LiveKit Cloud** | Cloud includes recording. See [section 8](#8-using-livekit-cloud-instead). |
| **Experimental** | Docker Desktop 4.34+ has an opt-in **Enable host networking** setting (Settings → Resources → Network). With it on you can try the [Linux steps in 4.1](#41-linux). This is untested, and WebRTC over Docker Desktop's network layer is known to be fragile. |

### 4.3 Windows

The app and LiveKit run natively; Redis and Egress run in Docker inside WSL 2 (a Linux environment built into Windows).
This is the setup used to build and test the app.

**Extra prerequisites:** WSL 2 + Docker Engine inside it. Mirrored WSL networking needs Windows 11 22H2 or newer.
Free ports: 6379 and 9090 in addition to 7880-7882 and 8100.

**a) LiveKit config.** Copy [`config/livekit.yaml`](config/livekit.yaml) next to `livekit-server.exe`:

```yaml
redis:
  address: 127.0.0.1:6379
  db: 5
rtc:
  enable_loopback_candidate: true
```

> Keep `enable_loopback_candidate`. Without it, recordings fail with *"Start signal not received"*.

**b) WSL 2 with mirrored networking** (lets WSL and Windows share `localhost`):

```powershell
wsl --install                 # first time only; reboot if asked
```

Create or edit `%UserProfile%\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

Apply it with `wsl --shutdown`, then reopen WSL.

**c) Docker Engine inside WSL.** In your WSL distro follow <https://docs.docker.com/engine/install/ubuntu/>, then
`sudo systemctl enable --now docker`. Check with `docker ps`.

**d) Redis** (skip if you already have Redis on 6379; LiveKit uses database 5):

```bash
docker run -d --name redis --restart unless-stopped -p 6379:6379 redis:7-alpine
```

**e) Egress.** Change `YOU` and the project path to match your machine, in WSL form (`C:\Users\you\...` becomes `/mnt/c/Users/you/...`):

```bash
docker pull livekit/egress:latest

docker run -d --name egress --restart unless-stopped \
  --network host --cap-add CAP_SYS_ADMIN \
  -e EGRESS_CONFIG_FILE=/etc/egress.yaml \
  -v /mnt/c/Users/YOU/livekit-demo/egress/egress.yaml:/etc/egress.yaml:ro \
  -v /mnt/c/Users/YOU/livekit-demo/recordings:/out \
  livekit/egress:latest
```

It reads [`egress/egress.yaml`](egress/egress.yaml) and restarts automatically whenever Docker starts.

**f) Run it, in this order:**

| # | What | Command | Ready when |
|---|---|---|---|
| 1 | Redis and Egress | Already containers; after a reboot start Docker in WSL. Check `docker ps`. | both show *Up* |
| 2 | LiveKit | `.\livekit-server.exe --dev --config livekit.yaml` | `curl http://localhost:7880` prints `OK` |
| 3 | App | `npm start` | `Demo running at http://localhost:8100` |

---

## 5. Deploy to a Linux server

One `docker-compose.yml` starts Redis, LiveKit, Egress and the app, plus optional HTTPS. Use this to run Huddle for other
people.

### 5.1 Prerequisites

| Need | Notes |
|---|---|
| **A Linux server** | Any recent distro with Docker. Examples use Ubuntu 22.04/24.04. |
| **Size** | Calls only: 2 vCPU / 2 GB RAM is plenty for small rooms. **With recording: 4 vCPU / 8 GB**: each recording runs a headless Chrome (about 1.5 GB RAM and a few cores). Rough guides, not measured limits. |
| **Docker Engine + Compose v2** | `docker compose version` should work. |
| **A domain name** pointing at the server | Needed for HTTPS, and so for camera/mic on other devices. |
| **Open ports** | `80/tcp` and `443/tcp` (HTTPS), `7881/tcp` and `7882/udp` (media). Open them in the cloud provider's firewall **and** on the machine. |
| **Outbound internet** | For pulling images, HTTPS certificates, and LiveKit finding the server's public IP. |

### 5.2 Install Docker (Ubuntu)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER        # log out and back in so this takes effect
docker compose version               # should print v2.x
```

### 5.3 Configure and start

```bash
git clone <your-repo-url> huddle && cd huddle      # or copy the project folder to the server
cp deploy.env.example deploy.env
```

**Generate your own API keys** (don't keep the example values):

```bash
docker run --rm livekit/livekit-server generate-keys
# API Key:    APIxxxxxxxx
# API Secret: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Edit `deploy.env` (it holds secrets; don't commit it):

```ini
LIVEKIT_API_KEY=APIxxxxxxxx
LIVEKIT_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

DOMAIN=huddle.example.com
PUBLIC_LIVEKIT_URL=wss://huddle.example.com
USE_EXTERNAL_IP=true
```

Open the firewall (Ubuntu with `ufw`; do the same in your cloud provider's security group):

```bash
sudo ufw allow 80,443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 7882/udp
```

Point your domain's DNS **A record** at the server's public IP, then start:

```bash
docker compose --env-file deploy.env --profile https up -d --build
```

The first run pulls images and builds the app, which takes a few minutes. Check it:

```bash
docker compose --env-file deploy.env ps          # redis, livekit, egress, app, caddy: all "Up"
curl http://localhost:7880                       # prints: OK   (LiveKit)
curl -I http://localhost:8100                    # HTTP/1.1 200 (app)
```

Open **`https://huddle.example.com`** and join from two devices.

### 5.4 Variations

| Situation | What to do |
|---|---|
| **No domain, just trying it on the server itself** | Skip `--profile https`. Set `PUBLIC_LIVEKIT_URL=ws://localhost:7880`. Open `http://localhost:8100` on the server. (Camera works on `localhost` only.) |
| **Server on a LAN with no public IP** | Set `USE_EXTERNAL_IP=false` and `NODE_IP=<the server's LAN IP>`. For HTTPS without a public domain, edit `deploy/Caddyfile` and add `tls internal` inside the site block; devices must trust Caddy's local certificate. |
| **Behind NAT with a known public IP** | `USE_EXTERNAL_IP=false` and `NODE_IP=<public IP>`, and forward `7881/tcp` and `7882/udp` to the server. |
| **Your own reverse proxy (nginx, Traefik)** | Skip the `https` profile. Proxy `/rtc*` to `localhost:7880` (WebSocket) and everything else to `localhost:8100`. Keep `PUBLIC_LIVEKIT_URL=wss://your.domain`. |
| **Ports already used** | Set `APP_PORT`, `LK_PORT`, `LK_TCP_PORT`, `LK_UDP_PORT`, `REDIS_PORT` in `deploy.env`. |

### 5.5 Day-to-day operations

```bash
docker compose --env-file deploy.env logs -f livekit     # follow one service (livekit, egress, app, caddy, redis)
docker compose --env-file deploy.env ps                  # status
docker compose --env-file deploy.env restart app         # restart one service

git pull && docker compose --env-file deploy.env --profile https up -d --build     # update to new code
docker compose --env-file deploy.env --profile https down                          # stop and remove containers
```

All containers use `restart: unless-stopped`, so they come back after a reboot as long as Docker starts on boot
(`sudo systemctl enable docker`).

**Recordings** are saved to `./recordings/` next to `docker-compose.yml`, as `<room>-<date>-<time>.mp4`. Back it up and
prune it, since video files add up quickly:

```bash
find recordings -name '*.mp4' -mtime +30 -delete     # example: delete files older than 30 days
```

### 5.6 Running without Docker (advanced)

Run each piece by hand: install the `livekit-server` binary and Node as in [3.1](#31-install-the-tools), run
`npm install && npm start`, and run Egress in Docker (it has no native Linux package). Mirror the settings in
`docker-compose.yml` (keys, `redis`, ports). Compose is far less work, so use it unless you have a reason not to.

---

## 6. Using the app

**Try it:**
1. Allow camera and mic. You'll see a preview with a mic level meter.
2. Enter your name and a room (the dice button generates one), then **Join room**.
3. Open a second tab or device and join the **same room** with a different name.
4. **Invite** in the top bar copies a join link.

| Feature | How |
|---|---|
| Join preview | Camera, mic meter and device pickers before you enter |
| Layouts | Grid, speaker view (`L`), pin anyone (pin icon, double-click, or the People list) |
| 1:1 calls | You appear as a draggable picture-in-picture |
| Chat | Emoji picker, dates grouped as Today / Yesterday / date, in-app and browser notifications |
| People panel | Who is here, mic and camera state, raised hands |
| Reactions & raise hand | Floating emoji and a hand badge (`H`) |
| Screen share | Share button (hidden on phones) |
| Settings (gear) | Display name, microphone / camera / speaker, noise suppression, echo cancellation, auto gain, recordings list |
| Remembering you | Name always; last room for 2 hours; a refresh mid-call rejoins automatically |
| Themes & shortcuts | Light/dark toggle; `M` mic, `V` camera, `H` hand, `C` chat, `P` people, `L` layout, `F` fullscreen, `?` help |

### Recording

Click the **record** button (the circle; under **More** on phones). Anyone in the call can start or stop it.
Egress joins as a hidden recorder and writes one MP4 of everyone. Nobody shares their screen, and it keeps going if the
person who started it leaves.

- Everyone sees a **REC** timer and a notice. After stopping, the button shows **Saving…**, then a pop-up links to the file.
- Files are in `recordings/` as `<room>-<date>-<time>.mp4`. **Settings → Recordings in this room** lists them, and they're
  also served at `/recordings/<name>.mp4`.
- If you leave while recording, it continues until the room is empty. Stop it before you leave.

---

## 7. Configuration reference

### Quick start / Windows: `.env`

| Setting | Default | Meaning |
|---|---|---|
| `LIVEKIT_URL` | `ws://localhost:7880` | LiveKit address browsers connect to (`wss://` for HTTPS) |
| `LIVEKIT_API_URL` | derived from `LIVEKIT_URL` | Optional: how the **server** reaches LiveKit for recording |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | `devkey` / `secret` | Must match LiveKit and Egress |
| `PORT` | `8100` | App port |

Windows recording also uses `livekit.yaml` (`redis.db: 5`, `rtc.enable_loopback_candidate: true`) and `egress.yaml` (`redis.db: 5`, must match).

### Linux / Docker Compose: `deploy.env`

| Setting | Default | Meaning |
|---|---|---|
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | none (required) | Credentials shared by LiveKit, Egress and the app |
| `PUBLIC_LIVEKIT_URL` | `ws://localhost:7880` | What browsers connect to; `wss://your.domain` with HTTPS |
| `DOMAIN` | none | Your domain, for the `https` profile |
| `USE_EXTERNAL_IP` | `true` | LiveKit detects the public IP. Use `false` with `NODE_IP` for LAN/NAT/local |
| `NODE_IP` | empty | Fixed address to advertise to clients |
| `APP_PORT`, `LK_PORT`, `LK_TCP_PORT`, `LK_UDP_PORT`, `REDIS_PORT` | 8100, 7880, 7881, 7882, 6379 | Ports |
| `EGRESS_HEALTH_PORT`, `EGRESS_TEMPLATE_PORT` | 9090, 7980 | Egress internal ports |
| `LIVEKIT_VERSION`, `EGRESS_VERSION` | `latest` | Pin image versions |

### Ports

| Port | Used by | Open to the internet? |
|---|---|---|
| 80, 443 | Caddy (HTTPS) | Yes |
| 7881/tcp, 7882/udp | LiveKit media | **Yes** |
| 8100 | App | No (behind Caddy) |
| 7880 | LiveKit signalling | No (behind Caddy) |
| 6379 | Redis | **No**; Compose binds it to `127.0.0.1` |
| 9090, 7980 | Egress | No |

### Project layout

```
livekit-demo/
├─ server.js               token endpoint, recording API, static hosting
├─ public/                 index.html, styles.css, app.js (LiveKit client, layout engine, chat, recording UI)
├─ Dockerfile              builds the app image
├─ docker-compose.yml      Redis + LiveKit + Egress + app (+ Caddy) for Linux
├─ deploy.env.example      Compose settings (copy to deploy.env)
├─ deploy/Caddyfile        HTTPS reverse proxy
├─ config/livekit.yaml     LiveKit config for the Windows recording setup
├─ egress/egress.yaml      Egress config for the Windows recording setup
├─ recordings/             finished MP4s
├─ .env                    local settings (not committed)
└─ README.md
```

---

## 8. Using LiveKit Cloud instead

To skip running a server, create a free project at <https://cloud.livekit.io> and put its values in `.env`:

```ini
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_key
LIVEKIT_API_SECRET=your_secret
```

Run only the app (`npm start`). This works on every OS, including macOS. Cloud includes recording, but it can't write to
your local `recordings/` folder: point `startRoomCompositeEgress` in `server.js` at cloud storage (S3/GCS) instead. Cloud also
gives you HTTPS, which is what phones need.

---

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| **`livekit-server: command not found`** | Not installed or not on `PATH`. Linux: re-run `curl -sSL https://get.livekit.io \| bash`. macOS: `brew install livekit`. Windows: run the `.exe` by its full path. |
| **`node: command not found` or Node too old** | Install Node 18+ ([3.1](#31-install-the-tools)). With nvm, open a new terminal after installing. |
| **App says "address already in use" (8100) or LiveKit can't bind 7880** | Something is already using the port. Linux: `ss -ltnp \| grep 8100`. macOS: `lsof -i :8100`. Windows: `netstat -ano \| findstr :8100`. Stop it, or change `PORT` in `.env`. On Windows a just-stopped LiveKit can hold 7880 for about a minute. |
| **"Camera blocked"** | The browser denied access. Click the lock icon in the address bar, set Camera to Allow, reload. (macOS also: System Settings → Privacy & Security → Camera → allow your browser.) |
| **"Camera is busy"** | Another app or browser has the camera. Close it and reload. |
| **No camera prompt on a server address** | Browsers block camera/mic on plain `http://` except `localhost`. Use the HTTPS setup. |
| **Join works but no video or audio between people** | Media ports blocked. Open `7881/tcp` and `7882/udp` in **both** the cloud firewall and the machine. Check `USE_EXTERNAL_IP` / `NODE_IP`: clients must be able to reach the advertised IP. |
| **HTTPS certificate not issued** | DNS for `DOMAIN` must point at the server, and ports 80/443 must be reachable. See `docker compose logs caddy`. |
| **Record button: "Recording service is not running"** | Redis or Egress is down. Linux: `docker compose ps` and `docker compose logs egress`. Windows: in WSL run `docker start redis egress`. |
| **Recording ends with "Start signal not received"** | Egress's browser couldn't reach LiveKit. **Linux:** check `docker compose logs egress livekit`, and that `USE_EXTERNAL_IP` / `NODE_IP` match how the server is reached (`NODE_IP=127.0.0.1` for local-only). **Windows:** `enable_loopback_candidate: true` in `livekit.yaml`, `networkingMode=mirrored` in `.wslconfig` (then `wsl --shutdown`), and LiveKit must run on Windows, not inside WSL. |
| **Recordings folder stays empty** | The Egress volume path is wrong. Linux: it's `./recordings` next to `docker-compose.yml`. Windows: the `-v ...:/out` path must be the real folder in `/mnt/c/...` form. |
| **Indicator stuck, or the page acts oddly after an update** | The tab runs an old script. Hard-refresh (Ctrl/Cmd+Shift+R). The page also offers to reload when it detects an update. |
| **`docker compose` says a variable is missing** | You forgot `--env-file deploy.env`, or `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` are empty in it. |
| **Phone can't connect** | It needs the HTTPS URL, and the media ports must be reachable from the phone's network. |

Handy checks:

```bash
curl http://localhost:7880                              # LiveKit: prints OK
curl "http://localhost:8100/api/token?room=a&name=b"    # token endpoint
curl "http://localhost:8100/api/record/status?room=a"   # recording status
docker compose --env-file deploy.env logs --tail 50 egress
```

---

## 10. Before real use

This is a demo. For real users:
- **Use your own API keys** (the server steps generate them). Never ship `devkey` / `secret`.
- **Add authentication.** Today anyone can request a token for any room, and any participant can start or stop
  recording or download any room's files.
- **Always serve over HTTPS.** The Compose `https` profile does this.
- **Store recordings in object storage** (S3/GCS) and decide how long to keep them. A local folder fills up.
- **Get consent for recording** under your local laws. The app shows an indicator and a notice, but your policy may need more.
- **Consider a TURN server** for people on restrictive networks (some corporate Wi-Fi blocks UDP; LiveKit then falls back to
  TCP on 7881, which is slower). LiveKit has built-in TURN you can enable in its config.
