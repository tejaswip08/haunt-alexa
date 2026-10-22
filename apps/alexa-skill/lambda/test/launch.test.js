const { test } = require('node:test');
const assert = require('node:assert');
const { handler } = require('..');

const APL = { 'Alexa.Presentation.APL': { runtime: { maxVersion: '2023.3' } } };
const VOICE_ONLY = { AudioPlayer: {} };

function envelope(supportedInterfaces, request, attributes = {}) {
  return {
    version: '1.0',
    session: {
      new: request.type === 'LaunchRequest',
      sessionId: 'amzn1.echo-api.session.test',
      application: { applicationId: 'amzn1.ask.skill.test' },
      user: { userId: 'amzn1.ask.account.test' },
      attributes,
    },
    context: {
      System: {
        application: { applicationId: 'amzn1.ask.skill.test' },
        user: { userId: 'amzn1.ask.account.test' },
        device: { deviceId: 'amzn1.ask.device.test', supportedInterfaces },
        apiEndpoint: 'https://api.amazonalexa.com',
      },
    },
    request: {
      requestId: 'amzn1.echo-api.request.test',
      timestamp: new Date().toISOString(),
      locale: 'en-US',
      ...request,
    },
  };
}

const launch = { type: 'LaunchRequest' };
const intent = (name, slots) => ({ type: 'IntentRequest', intent: { name, confirmationStatus: 'NONE', slots } });
const tap = (...args) => ({ type: 'Alexa.Presentation.APL.UserEvent', token: 'test', arguments: args });

/** Sends a request on a display device, carrying session attributes forward like Alexa does. */
async function send(request, attributes = {}, interfaces = APL) {
  const result = await handler(envelope(interfaces, request, attributes));
  return { ...result.response, attributes: result.sessionAttributes ?? {}, size: JSON.stringify(result).length };
}

const render = (response) => response.directives?.find((d) => d.type === 'Alexa.Presentation.APL.RenderDocument');
const execute = (response) => response.directives?.find((d) => d.type === 'Alexa.Presentation.APL.ExecuteCommands');

const WELCOME =
  '<speak>Welcome to Haunt. Every story here is told only once, and never the same way twice. Will you listen?</speak>';

// Alexa rejects responses over this size; keep a margin.
const MAX_RESPONSE_BYTES = 110_000;

test('voice-only device: speaks welcome, no APL directive', async () => {
  const response = await send(launch, {}, VOICE_ONLY);
  assert.strictEqual(response.outputSpeech.ssml, WELCOME);
  assert.strictEqual(response.shouldEndSession, false);
  assert.strictEqual(response.directives, undefined);
});

test('display device: speaks welcome and renders the welcome screen with a Continue button', async () => {
  const response = await send(launch);
  assert.strictEqual(response.outputSpeech.ssml, WELCOME);
  const directive = render(response);
  assert.strictEqual(directive.datasources.welcome.continueLabel, 'Continue');
  const content = directive.document.mainTemplate.items[0].items.find((item) => item.type === 'Container');
  const button = content.items.find((item) => item.id === 'hauntContinue');
  assert.deepStrictEqual(button.onPress[0], { type: 'SendEvent', arguments: ['continue'] });
});

test('Continue (tap, voice or "yes") opens the QR sign-in screen', async () => {
  for (const request of [tap('continue'), intent('ContinueIntent'), intent('AMAZON.YesIntent')]) {
    const response = await send(request, { screen: 'welcome' });
    assert.strictEqual(render(response).token, 'hauntLogin');
    assert.match(response.attributes.userCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.strictEqual(render(response).document.graphics.signInQr.type, 'AVG');
    assert.strictEqual(response.shouldEndSession, undefined);
  }
});

test('voice-only device: story actions are on hold', async () => {
  const response = await send(intent('AMAZON.YesIntent'), { screen: 'welcome' }, VOICE_ONLY);
  assert.strictEqual(response.directives, undefined);
  assert.match(response.outputSpeech.ssml, /still being written/);
});

test('"New Code" issues a fresh code', async () => {
  const codes = new Set();
  for (let i = 0; i < 5; i++) codes.add((await send(tap('newCode'), { screen: 'login' })).attributes.userCode);
  assert.ok(codes.size > 1);
});

test('Continue as Guest opens Home with hero, rails and the Create rail', async () => {
  for (const request of [tap('guest'), intent('GuestIntent')]) {
    const response = await send(request, { screen: 'login' });
    const directive = render(response);
    assert.strictEqual(directive.token, 'hauntHome');
    const home = directive.datasources.home;
    assert.strictEqual(home.displayName, 'Guest');
    assert.strictEqual(home.heroes[0].title, 'The Ashford House');
    assert.deepStrictEqual(
      home.rails.map((r) => r.title).slice(0, 4),
      ['Continue Your Nightmare', 'Featured Tonight', 'Trending Now', 'Create Your Own · Pick a Sub-genre'],
    );
    // Every card's hero exists, and every piece of art it needs is in the document.
    for (const rail of home.rails) for (const card of rail.items) assert.ok(home.heroes[card.heroIndex], card.title);
    for (const hero of home.heroes) assert.ok(directive.document.graphics[hero.art], hero.art);
    assert.strictEqual(response.attributes.screen, 'home');
    assert.ok(response.size < MAX_RESPONSE_BYTES, `home response is ${response.size} bytes`);
  }
});

test('only The Ashford House is playable; other stories show the demo toast', async () => {
  const soon = await send(tap('comingSoon', 'saint-veronica'), { screen: 'home' });
  assert.strictEqual(execute(soon).commands[0].type, 'ShowToast');

  const open = await send(tap('openStory', 'ashford-house'), { screen: 'home' });
  assert.strictEqual(render(open).token, 'hauntPlayMode');
  assert.strictEqual(render(open).datasources.playmode.extent, '3 endings to discover');
  assert.strictEqual(open.attributes.storyId, 'ashford-house');
});

test('Create → Generate keeps the request and explains the story server is not connected', async () => {
  const create = await send(tap('create', 'cosmic'), { screen: 'home' });
  const data = render(create).datasources.create;
  assert.strictEqual(data.subgenres[data.initialSub].id, 'cosmic');

  const gen = await send(tap('generate', 6, 3, 2, 2, 0, 'a ghost on the last train'), create.attributes);
  assert.strictEqual(render(gen).token, 'hauntGenerating');
  assert.deepStrictEqual(gen.attributes.lastRequest, {
    subgenreId: 'cosmic', subgenreName: 'Cosmic Horror', setting: 'Old mansion', length: 'epic', fear: 'terrifying', language: 'en', idea: 'a ghost on the last train',
  });
  const back = await send(tap('changeSettings'), gen.attributes);
  const backData = render(back).datasources.create;
  assert.strictEqual(backData.subgenres[backData.initialSub].id, 'cosmic');
});

test('playing with choices: clues, locked choices, an ending and the endings count', async () => {
  let r = await send(tap('mode', 'choices'), { screen: 'playmode', storyId: 'ashford-house' });
  let player = render(r).datasources.player;
  assert.strictEqual(player.scene.chapter, 'Chapter 1 · The Inheritance');
  assert.strictEqual(player.choices.length, 2);
  assert.match(r.outputSpeech.ssml, /What do you do\? one: Go in through the front door\. two: Circle around/);
  assert.strictEqual(r.reprompt.outputSpeech.ssml, '<speak>Say one or two.</speak>');

  // Garden: the Rusted Key is found.
  r = await send(intent('ChooseIntent', { number: { name: 'number', value: '2' } }), r.attributes);
  player = render(r).datasources.player;
  assert.strictEqual(player.found.name, 'Rusted Key');
  assert.deepStrictEqual(player.inventory, ['Rusted Key']);
  assert.strictEqual(player.sceneNumber, 2);

  // Basement: "Read the last page aloud" is locked without the journal.
  r = await send(tap('choose', 'hatch'), r.attributes);
  player = render(r).datasources.player;
  const locked = player.choices.find((c) => c.id === 'name');
  assert.strictEqual(locked.locked, true);
  assert.strictEqual(locked.lockedReason, "Needs Aunt Miriam's Journal");
  const refused = await send(tap('choose', 'name'), r.attributes);
  assert.strictEqual(execute(refused).commands[0].type, 'ShowToast');
  assert.strictEqual(refused.attributes.play.sceneId, 'basement');

  // Unlock the chains with the key, then pull free: the escape ending.
  r = await send(tap('choose', 'unlock'), r.attributes);
  r = await send(tap('choose', 'pull'), r.attributes);
  player = render(r).datasources.player;
  assert.strictEqual(player.ending.title, 'The Last Light');
  assert.strictEqual(player.ending.found, '1 OF 3 ENDINGS DISCOVERED');
  assert.deepStrictEqual(player.ending.path, ['Circle around to the back garden', 'Climb down through the cellar hatch', 'Unlock the chains', 'Pull free and slam the door']);
  assert.match(r.outputSpeech.ssml, /The end\. The Last Light\./);
  assert.deepStrictEqual(r.attributes.endings, { 'ashford-house': ['escape'] });

  // Play Again goes back to the play-mode question, as on the TV.
  const again = await send(tap('playAgain'), r.attributes);
  assert.strictEqual(render(again).token, 'hauntPlayMode');
});

test('"yes" in the nursery picks the “Yes. I\'ll stay.” choice', async () => {
  let r = await send(tap('mode', 'choices'), { screen: 'playmode', storyId: 'ashford-house' });
  r = await send(tap('choose', 'front'), r.attributes);
  r = await send(tap('choose', 'upstairs'), r.attributes);
  r = await send(intent('AMAZON.YesIntent'), r.attributes);
  assert.strictEqual(render(r).datasources.player.ending.title, 'Forever Seven');
});

test('listen mode renders each scene while Alexa reads it, then the ending', async () => {
  let r = await send(intent('ListenModeIntent'), { screen: 'playmode', storyId: 'ashford-house' });
  let listen = render(r).datasources.listen.properties;
  assert.deepStrictEqual(listen.segments.map((s) => s.location), ['Ashford House · Dusk', 'The Foyer', 'The Nursery', 'Ashford House · Forever']);
  assert.strictEqual(listen.scene, 0);
  assert.strictEqual(listen.next, 1);
  assert.ok(listen.holdMs > 10_000, `hold is ${listen.holdMs} ms`);
  assert.match(r.outputSpeech.ssml, /The taxi will not come up the drive/);
  assert.deepStrictEqual(render(r).document.onMount[0].commands[1].arguments, ['listenNext', '${payload.listen.properties.next}']);

  for (const [i, text] of [[1, /Dust sheets cover everything/], [2, /The rocking chair is still moving/], [3, /The drawing on the nursery wall/]]) {
    r = await send(tap('listenNext', i), r.attributes);
    listen = render(r).datasources.listen.properties;
    assert.match(r.outputSpeech.ssml, text);
    assert.strictEqual(listen.scene, i);
    assert.strictEqual(listen.next, i + 1);
  }

  r = await send(tap('listenNext', 4), r.attributes);
  listen = render(r).datasources.listen.properties;
  assert.match(r.outputSpeech.ssml, /The end\. Forever Seven\./);
  assert.strictEqual(listen.scene, 4);
  assert.strictEqual(listen.next, -1);
  assert.strictEqual(listen.ending.found, '1 OF 3 ENDINGS DISCOVERED');
  assert.deepStrictEqual(r.attributes.endings, { 'ashford-house': ['trapped'] });
});

test('every story screen stays under the response size limit', async () => {
  const flows = [
    [tap('guest'), { screen: 'login' }],
    [tap('create', ''), { screen: 'home' }],
    [tap('openStory', 'ashford-house'), { screen: 'home' }],
    [tap('mode', 'choices'), { screen: 'playmode', storyId: 'ashford-house' }],
    [tap('mode', 'listen'), { screen: 'playmode', storyId: 'ashford-house' }],
  ];
  for (const [request, attributes] of flows) {
    const r = await send(request, attributes);
    assert.ok(r.size < MAX_RESPONSE_BYTES, `${render(r).token} response is ${r.size} bytes`);
  }
});
