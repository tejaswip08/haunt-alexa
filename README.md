# Haunt for Alexa+

**Interactive horror stories you talk your way through.** Say *"Create a terrifying cosmic horror story in Hindi about a
lighthouse that lights itself"*. Haunt writes the opening scene, narrates it, stops at the worst moment and asks what
you do next. Whatever you answer changes the story.

Haunt is a self-hosted **MCP server** (spec 2025-11-25, Streamable HTTP) with an **Agent Skill**, so Alexa+ can create,
narrate, branch, continue and end a story from a single sentence. Scenes are written by **Amazon Bedrock** (Claude) and
narrated by **Amazon Polly**. This repo also includes a full **Echo Show / Echo simulator** at `/alexa`, so you can try
the Alexa+ experience in a browser without a device.

**Live demo: <https://haunt-alexa.vercel.app/alexa>**

![The /alexa simulator: an Echo Show playing a story, next to the live MCP inspector](docs/screenshots/echo/overview-inspector.jpg)

---

## Contents

- [Try it](#try-it)
- [Screenshots](#screenshots)
- [What you can do](#what-you-can-do)
- [Talking to it](#talking-to-it)
- [How it works](#how-it-works)
- [The MCP server](#the-mcp-server)
- [Run it locally](#run-it-locally)
- [Repository layout](#repository-layout)
- [Tests](#tests)
- [Deploying](#deploying)

---

## Try it

### For judges: the quickest paths

| Way | AWS credentials? | What you get | How |
| --- | --- | --- | --- |
| **1. Live site** | No | The real deployed backend: email sign-in, community stories, Bedrock and Polly | Open <https://haunt-alexa.vercel.app/alexa> |
| **2. Offline** | No | Everything on your machine, with a scripted story writer and the browser's voice | `npm install`, then `npm run dev:mock` |
| **3. Local page, live backend** | **Yes** | Your local copy talking to the deployed backend, with Polly narration and the Bedrock assistant | Add AWS keys to `.env`, then `npm run dev:live` |
| **4. Your own AWS** | **Yes** | Everything local, with your own Bedrock and Polly | Add AWS keys to `.env`, then `npm run dev` |

For options 2 to 4, open <http://localhost:5173/alexa> once the terminal says it's ready.

> **Important: `npm run dev:live` and `npm run dev` need AWS credentials.** Without them the page still loads, but
> narration falls back to the browser's robotic voice (no Polly) and the assistant can't answer (no Bedrock).
> If you don't have AWS access, use the **live site** (1) or **offline mode** (2). See
> [AWS credentials](#aws-credentials-for-dev-and-devlive) below.

On the page, press the **mic** (that's "Alexa, …") and speak, or tap. Use the switch at the top to choose between an
**Echo Show** (with a screen) and an **Echo** (voice only).

> Community stories and creating need an account; My Stories works without one. Sign in from the Profile icon or say
> "sign in": scan the QR code with your phone, or get a code by email. In offline mode (`dev:mock`) no email is sent.
> The code appears in the terminal on a line starting `[auth:mock]`.

**Try it with MCP Inspector:** run `npm run dev`, then connect the Inspector to `http://localhost:3001/mcp`
(Streamable HTTP).

## Run it locally

You need **Node.js 22 or newer**.

```bash
git clone https://github.com/tejaswip08/haunt-alexa.git
cd haunt-alexa
npm install
```

| Command | What runs | Use it when |
| --- | --- | --- |
| `npm run dev:mock` | Server + web app. Story writer and assistant are scripted, the browser's voice narrates, and sign-in is offline (codes print in the terminal) | You want to try it with no AWS account |
| `npm run dev` | Server + web app with real **Bedrock** and **Polly**, using your AWS credentials | You have AWS access (see below) |
| `npm run dev:live` | Web app + a local server. Stories, sign-in and community come from the **deployed backend**; Polly narration and the Bedrock assistant run on the local server with **your AWS credentials** | You want the live data on your machine (needs AWS, see below) |

Then open **<http://localhost:5173/alexa>**. With `npm run dev` and `dev:mock`, the server is on port 3001
(MCP at `http://localhost:3001/mcp`).

### AWS credentials (for `dev` and `dev:live`)

`npm run dev` and `npm run dev:live` both call **Amazon Bedrock** and **Amazon Polly** from your machine, so they need
AWS credentials. (Under `dev:live` the deployed backend only narrates for signed-in users, so voice and assistant calls
go to the local server instead. Everything else still comes from the deployed backend.) `dev:mock` needs none.

1. Copy the example settings:

   ```bash
   cp .env.example .env
   ```

2. Add credentials to `.env`, using **one** of these:

   ```bash
   # a) A named profile (after `aws sso login --profile your-profile`)
   AWS_PROFILE=your-profile

   # b) Or keys pasted from the AWS access portal ("Command line or programmatic access")
   AWS_ACCESS_KEY_ID=...
   AWS_SECRET_ACCESS_KEY=...
   AWS_SESSION_TOKEN=...          # only for temporary (SSO) keys
   ```

3. Keep `AWS_REGION=us-east-1` (or a region where your Bedrock model is enabled).

The account needs access to the Bedrock models named in `.env` and to Amazon Polly. Temporary SSO keys expire after a
few hours: if the voice turns robotic or the assistant stops answering, paste fresh keys and restart. `.env` is
gitignored, so keys never go into the repo.

To check it works, with the server running:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3001/api/tts -H 'content-type: application/json' -d '{"text":"hello"}'
```

`200` means Polly is working. Any other code means the credentials are missing, expired or lack access.

### Using your own AWS (`npm run dev`)

```bash
cp .env.example .env
```

Then in `.env`:

```bash
AWS_PROFILE=your-profile        # or any standard AWS credentials
AWS_REGION=us-east-1
HAUNT_PROVIDER=bedrock
HAUNT_AGENT=bedrock
HAUNT_TTS=polly
HAUNT_AUTH=mock                 # offline sign-in codes; use Cognito ids for real email codes
NODE_ENV=development
```

Credentials come from the standard AWS chain, for example `aws sso login --profile your-profile`. Your account needs
access to the Bedrock model set in `.env` and to Amazon Polly. No keys are stored in this repo.

## Repository layout

| Path | What |
| --- | --- |
| [`apps/server`](apps/server) | MCP server, story engine, sign-in and the API |
| [`apps/web`](apps/web) | The website and the `/alexa` Echo Show / Echo simulator |
| [`apps/views`](apps/views) | MCP Apps scene views |
| [`apps/alexa-skill`](apps/alexa-skill) | Alexa skill (Lambda + APL screens) |
| [`skills/haunt`](skills/haunt) | Agent Skill for Alexa+ and other assistants |
| [`packages/firetales`](packages/firetales) | Story model and sub-genres |
| [`packages/scene-fx`](packages/scene-fx) | Scene sound and visual effects |
| [`deploy`](deploy) | AWS deployment templates and notes |
| [`docs/friction-log.md`](docs/friction-log.md) | What was hard while building on Alexa+, Bedrock and AWS |

## Tests

```bash
npm run typecheck
npm test
```

## Deploying

- **Web app (Vercel):** import this repo. [`vercel.json`](vercel.json) builds the views and the web app and forwards
  `/api` and `/activate` to the backend. Every push to `main` redeploys.
- **Backend (AWS):** `npm run build:lambda` builds the Lambda bundle. See [`deploy/DEPLOY.md`](deploy/DEPLOY.md) for the
  Lambda, API Gateway, DynamoDB and Cognito setup. The backend only answers Haunt's own sites, so add a new site's
  address to `HAUNT_STT_ORIGINS`.

## License

See [LICENSE](LICENSE). Haunt is an independent project built for the Amazon Developer Hackathon and is not affiliated
with or endorsed by Amazon. Stories are AI-generated fiction.
