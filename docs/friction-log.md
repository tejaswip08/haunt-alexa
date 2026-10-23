# Friction log

Running log for the Devpost submission (friction logs can earn up to a 10% judging bonus).
Format per entry: task, steps, expected vs. actual, severity, workaround, suggestion.

**20 entries** across Alexa+ and MCP, the Alexa Skills Kit and APL, the Alexa Developer Console, Amazon Bedrock, Amazon Cognito and AWS Lambda.

| # | Entry | Severity |
| --- | --- | --- |
| 1 | MCP Apps host: sandbox proxy needs a second origin | Medium |
| 2 | Alexa+ client protocol version vs. hackathon minimum | Low (the TypeScript SDK v2 negotiates both) |
| 3 | Alexa+ add-on docs rate-limit quick reads | Low |
| 4 | No local Alexa+ test path for non-partners | Medium for hackathon builders |
| 5 | Narrative add-ons can't control what Alexa+ says | High for storytelling and media experiences |
| 6 | 500 ms latency target vs. generated content | Medium |
| 7 | Undocumented details in the design guide | Low |
| 8 | Local Inspector and web simulator are gated | Medium for hackathon builders |
| 9 | Bedrock: model listed, but "not available for this account" | High for hackathon builders on new accounts |
| 10 | Bedrock: one model, two APIs, different access | Medium (cost us a provider rewrite) |
| 11 | Developer Console: Import Code rejects a zip without a `lambda/` root folder | Low (blocking until found) |
| 12 | A one-word invocation name opens Alexa's web search, with no warning | Medium (looks like the skill is broken) |
| 13 | Interaction model edits don't apply until Build, so "yes" fell to Fallback | Medium |
| 14 | APL: `when` is evaluated once, so state changes didn't show | Medium |
| 15 | APL: font families from resources were truncated to "…" | Low |
| 16 | APL: scrolling containers default to tiny heights, and nested scrolls fight | Medium |
| 17 | Simulator: SpeakItem and command timing didn't match a real "read along" flow | High for narrated or karaoke-style content |
| 18 | APL: 120 KB response limit with vector scene art | Low |
| 19 | Bedrock with IAM Identity Center: short sessions expire mid-demo | Low (annoying while recording demos) |
| 20 | Cognito: no device authorization grant for screenless devices, and Lambda can't hold the pairing in memory | Medium (sign-in on TVs and speakers fails at random) |

## 2026-10-15

### MCP Apps host: sandbox proxy needs a second origin
- **Task:** Render MCP App views inside our own Alexa+ simulator, served from a single URL.
- **Steps:** Followed `examples/basic-host` in modelcontextprotocol/ext-apps.
- **Expected:** A drop-in host component that works from one origin.
- **Actual:** The reference host serves `sandbox.html` from a second port/origin (double-iframe proxy). A single-URL deployment needs a second domain or a different approach.
- **Severity:** Medium
- **Workaround:** Load the view into one `sandbox="allow-scripts"` iframe via `srcdoc` (opaque origin) and connect `AppBridge` directly with `PostMessageTransport`. Works because the transport validates the message source window, not the origin.
- **Suggestion:** Document the single-iframe option for hosts that only render their own trusted views, or ship a same-origin host helper.

### Alexa+ client protocol version vs. hackathon minimum
- **Task:** Make sure our MCP server works both for the hackathon (spec 2025-11-25+) and for the real Alexa+ client.
- **Expected:** One documented protocol version.
- **Actual:** The hackathon requires 2025-11-25, while the Alexa+ "Client and App Lifecycle" doc shows the Alexa+ client initializing with `2025-03-26`.
- **Severity:** Low (the TypeScript SDK v2 negotiates both)
- **Workaround:** None needed; verified the SDK accepts 2025-03-26 and defaults to 2025-11-25.
- **Suggestion:** State in the Alexa+ docs which protocol versions the client negotiates today, and when 2025-11-25 is expected.

### Alexa+ add-on docs rate-limit quick reads
- **Task:** Read the 18-page MCP add-on design guide and toolkit docs.
- **Actual:** Opening several pages quickly triggered a "Server Busy / Continue shopping" interstitial on developer.amazon.com.
- **Severity:** Low
- **Workaround:** Read pages one at a time.
- **Suggestion:** Offer the design guide as a single page or PDF, or exempt docs pages from the retail bot check.

### No local Alexa+ test path for non-partners
- **Task:** Test the add-on against Alexa+ itself.
- **Actual:** The Alexa+ docs say the MCP Toolkit and Category SDK are available to select partners only.
- **Severity:** Medium for hackathon builders
- **Workaround:** Built our own simulated Alexa+ host (allowed by the hackathon rules).
- **Suggestion:** Give hackathon participants temporary access to the web simulator / local inspector.

### Narrative add-ons can't control what Alexa+ says
- **Task:** Have Alexa+ narrate a story scene as written.
- **Steps:** Read the MCP add-on design guide (conversation surface, display modes).
- **Expected:** A way to return verbatim speech (text, SSML or audio) for content where the wording is the product: stories, poems, scripts.
- **Actual:** "You can't script what Alexa says"; Alexa phrases its own reply from the tool data. There is no widget audio API either.
- **Severity:** High for storytelling and media experiences
- **Workaround:** Our simulator plays the narration verbatim with Amazon Polly. On real Alexa+ the narration would be paraphrased.
- **Suggestion:** A `speech` field (or SSML/audio URL) that Alexa reads verbatim for add-ons whose content is the performance, with Alexa still free to add its own framing.

### 500 ms latency target vs. generated content
- **Task:** Meet the quickstart's "round-trip query response latency of less than 500 ms" with LLM-written scenes.
- **Actual:** Generated scenes take seconds. Streaming and progress notifications aren't documented; only an interim "still working" message is suggested.
- **Severity:** Medium
- **Workaround:** `_meta.ui.invoking` status text, plus pre-written branches: while a scene plays, FireTales writes the next scene for each suggested answer, so a matching answer returns in milliseconds. Free-form answers still take seconds.
- **Suggestion:** Document a latency tier for generative add-ons, and whether MCP progress notifications or tasks are honored.

### Undocumented details in the design guide
- **Task:** Build an MCP App view that adapts to Echo Show devices.
- **Actual:** The guide says to declare supported display modes "in your tool", but names no field. `deviceClass` values and safe-area numbers aren't listed.
- **Severity:** Low
- **Workaround:** Planned: design the view at the documented 768×480 base canvas and keep it usable inline.
- **Suggestion:** Add the `_meta` field name, a `deviceClass` table and safe-area values per device.

### Local Inspector and web simulator are gated
- **Task:** Validate the add-on with Amazon's own tools.
- **Actual:** Both need `alexa-ai deploy` or the private CodeArtifact registry, which needs Private Preview access. The Local Inspector isn't on public npm.
- **Severity:** Medium for hackathon builders
- **Workaround:** Public MCP Inspector plus our own simulator.
- **Suggestion:** Publish the Local Inspector for hackathon participants; its certification checks would help every entrant.

## 2026-10-17: Amazon Bedrock

### Bedrock: model listed, but "not available for this account"
- **Task:** Run Haunt's stories on Claude Sonnet 5.5 through Amazon Bedrock on a new AWS account.
- **Steps:** `aws bedrock list-foundation-models` and `list-inference-profiles` (both list Sonnet 5.5, Opus 5.5 and Haiku 4.5), then one `converse` call per model.
- **Expected:** Listed models can be called, or a clear way to request access.
- **Actual:** For the first hours every call failed with "Your account is currently being verified". After that, Haiku 4.5 worked, but Sonnet 5.5, Sonnet 5 and Opus 5.5 returned "not available for this account… contact AWS Sales", with no self-service request in the error.
- **Severity:** High for hackathon builders on new accounts
- **Workaround:** Ran everything on Claude Haiku 4.5.
- **Suggestion:** Have `list-foundation-models` show whether the caller can invoke each model, and link a self-service access request in the error.

### Bedrock: one model, two APIs, different access
- **Task:** Call Claude Haiku 4.5 from the Anthropic SDK for Bedrock (`AnthropicBedrockMantle`), which the project already used.
- **Actual:** The same account could call Haiku 4.5 through `bedrock-runtime` Converse (`us.anthropic.claude-haiku-4-5-20251001-v1:0`), but the Anthropic-compatible endpoint returned "not available for this account" for `anthropic.claude-haiku-4-5`, and "does not exist" for the inference-profile id.
- **Severity:** Medium (cost us a provider rewrite)
- **Workaround:** Added a Converse-based provider and assistant, switchable with `HAUNT_BEDROCK_API=converse`.
- **Suggestion:** Document which endpoint each model and account tier can use, and use the same model ids on both.

## 2026-10-18 to 2026-10-22: the Echo Show skill (Alexa Skills Kit, APL, Developer Console)

### Developer Console: Import Code rejects a zip without a `lambda/` root folder
- **Task:** Import our compiled Node.js skill into an Alexa-hosted skill.
- **Steps:** Code tab → Import Code → picked a zip of `index.js`, `package.json` and `dist/`.
- **Expected:** The files land in the skill's `lambda` folder.
- **Actual:** The import failed with a generic error. Only a zip whose top level is a `lambda/` folder is accepted, which isn't stated on the import dialog.
- **Severity:** Low (blocking until found)
- **Workaround:** Our `npm run package` zips `lambda/index.js`, `lambda/package.json` and `lambda/dist` from the parent folder.
- **Suggestion:** Say "the zip must contain a top-level `lambda/` folder" in the dialog, and show which path was wrong.

### A one-word invocation name opens Alexa's web search, with no warning
- **Task:** Open the skill in the Test tab with "open haunt".
- **Expected:** The skill launches, or the console warns that the name is too generic.
- **Actual:** Alexa answered "Here's what I found" from a general search. The console accepted "haunt" as the invocation name without a warning.
- **Severity:** Medium (looks like the skill is broken)
- **Workaround:** Renamed the invocation to "haunt stories".
- **Suggestion:** Warn at save time when an invocation name is a common word that general search is likely to capture.

### Interaction model edits don't apply until Build, so "yes" fell to Fallback
- **Task:** Add YesIntent and our custom intents in the JSON editor.
- **Actual:** After saving, "yes" still routed to `AMAZON.FallbackIntent`. The model only takes effect after **Build skill**, and the Test tab gives no hint that it's testing the previous build.
- **Severity:** Medium
- **Workaround:** Save, then Build, after every model change.
- **Suggestion:** Show "unbuilt changes" in the Test tab, or offer to build before testing.

### APL: `when` is evaluated once, so state changes didn't show
- **Task:** Show a check mark, radio dots and a pause overlay that change with user input (SetValue on bind variables).
- **Actual:** Components using `when` never appeared or disappeared after the first render. `when` is evaluated only when the component is inflated; this is easy to miss in the docs.
- **Severity:** Medium
- **Workaround:** Use `display: "${cond ? 'normal' : 'none'}"` for anything that changes at runtime.
- **Suggestion:** Put a note on the `when` docs, and have the authoring tool warn when `when` references a bind variable that SetValue changes.

### APL: font families from resources were truncated to "…"
- **Task:** Define `@display` / `@body` font resources and use them across documents.
- **Actual:** Text using the resource names rendered truncated with an ellipsis on Echo Show viewports; literal family names worked.
- **Severity:** Low
- **Workaround:** Literal `"Bookerly"` and `"Amazon Ember Display"` everywhere.
- **Suggestion:** Clarify whether `fontFamily` may come from a string resource, and render a visible fallback instead of truncating.

### APL: scrolling containers default to tiny heights, and nested scrolls fight
- **Task:** A Fire TV style Home: vertical list of rails, each a horizontal `Sequence` of story cards.
- **Actual:** A `ScrollView` without an explicit height rendered at about 100 dp. With a vertical scroller holding horizontal Sequences, vertical swipes also moved the rails; horizontal `snap` dropped the left padding.
- **Severity:** Medium
- **Workaround:** One vertical `Sequence` with explicit height and `snap: start`, horizontal Sequences without snap.
- **Suggestion:** A documented "rails" pattern (vertical list of horizontal carousels) for Echo Show, which matches Fire TV and streaming-app UIs.

### Simulator: SpeakItem and command timing didn't match a real "read along" flow
- **Task:** Listen mode: Alexa reads each scene while the matching scene is on screen.
- **Steps:** Tried SpeakItem with `ssmlToSpeech`, then a Pager with ExecuteCommands, then outputSpeech plus ExecuteCommands.
- **Actual:** In the Developer Console simulator SpeakItem was unreliable, and ExecuteCommands ran only after `outputSpeech` finished, so the screen lagged the narration by a whole scene.
- **Severity:** High for narrated or karaoke-style content
- **Workaround:** Render one scene per response with its `outputSpeech`, then `onMount` → `Idle(holdMs)` → `SendEvent` to request the next scene.
- **Suggestion:** Document speech/command ordering in the simulator vs. devices, and offer a sample for synchronised narration.

### APL: 120 KB response limit with vector scene art
- **Task:** Show Haunt's illustrated scenes without hosting images.
- **Actual:** Converting our SVG art to AVG quickly pushed documents toward the response size limit.
- **Severity:** Low
- **Workaround:** A converter script (SVG → AVG, gradients to bounding-box units, blur approximated by radial fades) and only the art each screen needs.
- **Suggestion:** An official SVG → AVG converter, or shared graphics packages that don't count against every response.

## 2026-10-22 to 2026-10-23: AWS credentials and sign-in on Lambda

### Bedrock with IAM Identity Center: short sessions expire mid-demo
- **Task:** Run the local server against Bedrock and Polly with SSO credentials.
- **Actual:** Temporary credentials copied from the access portal expired after a few hours; every call then failed with an expired-token error until new keys were pasted in.
- **Severity:** Low (annoying while recording demos)
- **Workaround:** A named profile in `~/.aws/credentials`, refreshed before recording.
- **Suggestion:** Longer default session length for developer roles, or a clearer "refresh with `aws sso login`" hint in the SDK error.

### Cognito: no device authorization grant for screenless devices, and Lambda can't hold the pairing in memory
- **Task:** Let a listener sign in on a voice-only Echo or a TV by approving a short code on their phone (the OAuth 2.0 device authorization grant), with accounts in Amazon Cognito and the server on AWS Lambda.
- **Steps:** Looked for a device-code flow in the Cognito user pool docs, built our own pairing in the Express server (`/api/auth/device/start`, `/poll`, `/approve`), deployed it to Lambda behind API Gateway, then started one code and polled it 16 times at once.
- **Expected:** A managed device-code flow in Cognito, or at least a pairing that every Lambda instance can see.
- **Actual:** Cognito has no device authorization grant, so the pairing had to be custom. Kept in memory, it lives in one Lambda instance: about half the polls came back "expired" because they reached other instances. On the device the code vanished, and on the phone "approve" failed with "code expired or isn't right", only sometimes, depending on which instance answered.
- **Severity:** Medium (sign-in on TVs and speakers fails at random)
- **Workaround:** Story answers on the device no longer depend on extra calls, and the fix (pairing codes and sessions in DynamoDB with a TTL, shared by every instance) is written up for the backend.
- **Suggestion:** Support the OAuth 2.0 device authorization grant in Cognito user pools (the standard way to sign in on Echo, Fire TV and other screenless devices), and say clearly in the Lambda docs that state kept in memory is per instance.

