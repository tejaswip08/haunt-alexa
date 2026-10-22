# Haunt (Alexa skill): welcome, sign-in and the story experience

The Alexa display version of Haunt: welcome, QR sign-in, and the story experience ported from the TV app in this repository (`apps/tv`) (Home, Create, Play mode, Story player, Listen mode). Voice-only devices are on hold.

- **Voice-only devices:** Alexa says *"Welcome to Haunt. Every story here is told only once, and never the same way twice. Will you listen?"*
- **Display devices** (Echo Show, Fire TV, Developer Console simulator): Alexa says the same line and shows an APL welcome screen. The screen has a moonlit graveyard with a dead tree, drifting fog, a fading-in **HAUNT** title, and *"Welcome to Haunt. Every story is told only once."*

The skill picks the response by checking whether the request's `supportedInterfaces` includes `Alexa.Presentation.APL` (see `supportsApl` in `lambda/src/index.ts`).

### Sign-in (display devices)

When the user taps **Continue** on the welcome screen (or says "continue" or "yes"), display devices show a sign-in screen that matches the Fire TV app's login screen (`apps/tv/src/screens/LoginScreen.tsx`). It uses the same Ashford House art, HAUNT logo, tagline, colors and **Scan with your phone** QR panel.

- The QR code opens `https://haunt.example/activate?code=XXXX-XXXX`, the same device-code pattern and placeholder URL as the Fire TV mock.
- **Continue as Guest** and **New Code** work by tap, or by voice ("continue as guest", "new code").
- The screen stays up for 2 minutes without keeping the microphone open.
- Layout adapts: side-by-side on landscape screens (Echo Show 5/8/10/15, Fire TV), stacked on portrait Echo Show 15 and round Echo Spot.

**Mock only:** there's no auth backend, so scanning the code opens a placeholder page and the skill never learns the phone approved it. Like the Fire TV app, real sign-in needs a small device-code service (e.g. Lambda + DynamoDB in front of Cognito).

**Voice-only devices:** sign-in is on hold. "Yes" still gives the placeholder "your first story is still being written" reply.

### Story experience (display devices)

Ported from `apps/tv`, same content and design:

- **Home:** hero for the selected story, rails (Continue, Featured, Trending, Most Liked, Community, Short Scares, Many Endings) and the Create rail. Tap a card to show it in the hero, tap again (or **Play**) to open it. Only *The Ashford House* is playable, as on the TV.
- **Create:** sub-genre, idea, setting, length, fear level, language, then **Generate My Story**. The story server isn't reachable from Alexa yet, so Generate shows "The story didn't start" and keeps the request.
- **Play mode:** *Play with choices* or *Listen without choices*.
- **Story player:** Alexa narrates each scene (character lines in their own voice), clues and inventory, locked choices, endings with your path and the endings count, pause menu. Choose by tap or by saying the number.
- **Listen mode:** the first-choice path plays straight through, one scene at a time, then the ending.

Scene art is the live app's SVGs converted to APL vector graphics: `python3 scripts/convert_art.py` (sources in `assets/art/`, output `lambda/src/art/art.json`).

Saving stories and the AI story server are not connected yet.

## Project layout

```
ask-resources.json                     ASK CLI config (optional deploy path)
skill-package/
  skill.json                           manifest: APL interface enabled
  interactionModels/custom/en-US.json  invocation name "haunt stories", ContinueIntent, GuestIntent, NewCodeIntent + built-ins
lambda/
  src/index.ts                         request handlers (TypeScript)
  src/signIn.ts                        device code + QR code as an APL vector graphic
  src/screens.ts                       story screens: documents, data and speech
  src/content/, src/story/engine.ts    catalog, Ashford House script, story engine (from apps/tv)
  src/art/art.json                     scene art as APL vector graphics (generated)
  src/apl/home|create|playmode|player|listen|generating.json, base.json (shared pieces)
  src/apl/welcome.json                 APL welcome document (vector art, no image hosting needed)
  src/apl/login.json                   APL sign-in document (Fire TV login layout)
  index.js                             Lambda entry shim -> dist/index.js
  test/launch.test.js                  welcome + sign-in tests (voice-only and display)
```

## Build and test locally

Requires Node.js 18 or later.

```bash
cd lambda
npm install
npm test          # compiles TypeScript, then checks both launch paths
npm run package   # builds ../haunt-lambda.zip for upload
```

## Set up in the Alexa Developer Console (no AWS account or Echo device needed)

1. Go to <https://developer.amazon.com/alexa/console/ask> and click **Create Skill**.
   - Name: `Haunt`. Locale: English (US).
   - Type: **Other → Custom**. Hosting: **Alexa-hosted (Node.js)**. Template: **Start from scratch**.
2. **Build → Interaction Model → JSON Editor**: paste the contents of `skill-package/interactionModels/custom/en-US.json`, then click **Save** and **Build skill**.
3. **Build → Interfaces**: turn on **Alexa Presentation Language** and tick the hub and TV device types, then click **Save**. Rebuild the model if the console asks you to.
4. **Code** tab: click **Import Code**, pick `haunt-lambda.zip` (don't extract it), tick the top-level checkbox to select all files, and click **Next** to import. The zip contains a `lambda/` folder, which is what the console requires. Then click **Deploy**.

### Preview and test on your laptop

1. **Test** tab: set *Skill testing is enabled in* to **Development**.
2. Tick **Device Display**, then type or say `open haunt stories`.
   - You hear the welcome message.
   - The welcome screen renders under the simulator. Use the device dropdown to switch between Echo Show sizes, the round Echo Spot, and TV.
3. Click **Continue** on the welcome screen (or type `continue` or `yes`). The sign-in screen appears with a QR code. Try `new code` (the code changes) and `continue as guest`. You can also click the on-screen buttons.
4. **Voice-only check:** in **Skill I/O**, copy the JSON Input, open the **Manual JSON** tab, and paste it. Delete the `"Alexa.Presentation.APL": {...}` entry under `context.System.device.supportedInterfaces`, then click **Invoke**. The response contains speech and no `RenderDocument` directive, which is exactly what a speaker without a screen receives. `npm test` checks the same thing locally.

### Faster visual iteration (optional)

To tweak the screen without redeploying, open **Build → Multimodal Responses → Visual → Create**. Paste `lambda/src/apl/welcome.json` into the APL editor and this into **Data**:

```json
{ "welcome": { "title": "HAUNT", "subtitle": "Welcome to Haunt. Every story is told only once." } }
```

The authoring tool previews every viewport live, including the fog and title animations. Copy any changes back into `welcome.json`, then run `npm run package` and re-import.

## Alternative: deploy with the ASK CLI to your own AWS account

```bash
npm install -g ask-cli
ask configure                     # links your Amazon developer + AWS accounts
(cd lambda && npm install && npm run build)
ask deploy                        # creates the skill + Lambda from this folder
```

## Notes

- The invocation name is "haunt stories". A one-word name like "haunt" gets treated as a general Alexa search ("Here's what I found.") instead of opening the skill.
- Don't edit `dist/` by hand. It is generated from `src/` by `npm run build`.
