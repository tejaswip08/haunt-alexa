# Haunt for Alexa+

Interactive horror stories you **talk** your way through. Haunt is a self-hosted **MCP server** (spec 2025-11-25,
Streamable HTTP) plus an **Agent Skill**, so Alexa+ can create, narrate and branch a story from a single sentence.
Scenes are written by Amazon Bedrock (Claude) and narrated by Amazon Polly.

This repo is the Alexa+ part of Haunt only: the MCP server, the skill, the Alexa skill code and a web simulator of
an Echo Show / Echo device at **`/alexa`** so anyone can try it without hardware.

## Try it in 2 minutes (offline, no AWS)

```bash
npm install
npm run dev:mock
```

Open <http://localhost:5173/alexa>. Everything runs on your machine with mock story writing and browser speech.

## Run with real Bedrock + Polly

```bash
cp .env.example .env      # then set AWS_PROFILE / AWS_REGION, HAUNT_PROVIDER=bedrock, HAUNT_TTS=polly
npm run dev
```

Credentials come from the standard AWS chain (for example `aws sso login --profile haunt` and
`AWS_PROFILE=haunt` in `.env`). No keys live in this repo.

## What's in `/alexa`

A simulated **Echo Show** (switch to the screenless **Echo** speaker with the device switch). Every screen works by
touch and by voice. Press the mic (that's "Alexa, …") and speak.

| Tab | What it shows | MCP tool |
| --- | --- | --- |
| Home | Featured and community stories | `list_library`, `play_episode` |
| Community | Stories shared by listeners | `list_library`, `play_episode` |
| My Stories | Stories you started on this device (saved in the browser) | `resume_story` |
| Create | Sub-genre, your idea, length, fear level, language | `start_story` |
| Profile | Device profile | none |

During a story, your answers go to `answer_story`, and "stop" / "end the story" goes to `end_story`.

### Voice commands

- **Navigate:** "open community", "my stories", "go to create", "go home", "go back"
- **Play:** "play the first one", "play *&lt;title&gt;*"
- **Continue:** "continue my last story", "resume *&lt;title&gt;*"
- **Create, all at once:** "Create a terrifying cosmic horror story in Hindi about a lighthouse, and start it"
- **Create, one field at a time:** "haunted house", "make it long", "very scary", "in Tamil",
  "my idea is a door that won't stay shut", then "generate"
- **Just ask:** "Tell me a scary story about the last train from an empty station"

## MCP server

| Endpoint | Who it's for |
| --- | --- |
| `POST /mcp` | External clients such as Alexa+ or MCP Inspector. Bearer token from `HAUNT_MCP_TOKENS`; open on localhost in development when unset. |
| `POST /api/mcp` | The first-party `/alexa` simulator. |

Tools: `start_story`, `answer_story`, `end_story`, `resume_story`, `list_library`, `play_episode`.
Scenes also render as an MCP Apps view (`ui://haunt/scene-*`). The Agent Skill is in [`skills/haunt`](skills/haunt).

## Layout

| Path | What |
| --- | --- |
| `apps/server` | MCP server, story engine, REST API for the simulator |
| `apps/web` | Website and the `/alexa` device simulator |
| `apps/views` | MCP Apps scene views |
| `apps/alexa-skill` | Alexa skill (Lambda + APL screens) |
| `packages/firetales` | Story model and sub-genres |
| `packages/scene-fx` | Scene sound and visual effects |
| `skills/haunt` | Agent Skill |
| `deploy` | AWS deployment notes and templates |

## Checks

```bash
npm run typecheck
npm test
```

## License

See [LICENSE](LICENSE). Haunt is an independent project built for the Amazon Developer Hackathon and is not
affiliated with or endorsed by Amazon. Stories are AI-generated fiction.
