import * as Alexa from 'ask-sdk-core';
import { IntentRequest, RequestEnvelope, ResponseEnvelope } from 'ask-sdk-model';
import loginDocument from './apl/login.json';
import welcomeDocument from './apl/welcome.json';
import type { StoryRequest } from './content/createOptions';
import {
  COMING_SOON,
  SCRIPTS,
  TOKENS,
  createScreen,
  generatingScreen,
  homeScreen,
  listenScreen,
  playModeScreen,
  playerScreen,
  requestFromArgs,
  setValue,
  toast,
  type Screen,
} from './screens';
import { createSignInCode, qrGraphic, VERIFICATION_URI } from './signIn';
import { choose, listenTimeline, startStory, type PlayState } from './story/engine';

const WELCOME_SPEECH =
  'Welcome to Haunt. Every story here is told only once, and never the same way twice. Will you listen?';
const WELCOME_REPROMPT = 'Will you listen?';
const WELCOME_TOKEN = 'hauntWelcome';
const LOGIN_TOKEN = 'hauntLogin';

type ScreenName = 'welcome' | 'login' | 'home' | 'create' | 'generating' | 'playmode' | 'player' | 'listen';

/** Everything the skill remembers during a session. */
interface HauntSession {
  screen?: ScreenName;
  userCode?: string;
  displayName?: string;
  /** Endings discovered per story (kept for the session, like the live TV app keeps them in memory). */
  endings?: Record<string, string[]>;
  storyId?: string;
  play?: PlayState;
  sceneNumber?: number;
  /** Last Create request, kept for when the story server is connected. */
  lastRequest?: StoryRequest;
}

/** True when the requesting device can render APL (Echo Show, Fire TV, simulator display, ...). */
function supportsApl(handlerInput: Alexa.HandlerInput): boolean {
  const interfaces = Alexa.getSupportedInterfaces(handlerInput.requestEnvelope);
  return interfaces['Alexa.Presentation.APL'] !== undefined;
}

function session(handlerInput: Alexa.HandlerInput): HauntSession {
  return handlerInput.attributesManager.getSessionAttributes() as HauntSession;
}

function save(handlerInput: Alexa.HandlerInput, changes: Partial<HauntSession>) {
  handlerInput.attributesManager.setSessionAttributes({ ...session(handlerInput), ...changes });
}

function respond(handlerInput: Alexa.HandlerInput, screen: Screen) {
  const builder = handlerInput.responseBuilder;
  if (screen.speech) builder.speak(screen.speech);
  if (screen.reprompt) builder.reprompt(screen.reprompt);
  for (const directive of screen.directives) builder.addDirective(directive);
  return builder.getResponse();
}

// ---------- welcome + sign-in ----------

function welcome(handlerInput: Alexa.HandlerInput) {
  save(handlerInput, { screen: 'welcome' });
  const builder = handlerInput.responseBuilder.speak(WELCOME_SPEECH).reprompt(WELCOME_REPROMPT);
  if (supportsApl(handlerInput)) {
    builder.addDirective({
      type: 'Alexa.Presentation.APL.RenderDocument',
      token: WELCOME_TOKEN,
      document: welcomeDocument,
      datasources: {
        welcome: {
          title: 'HAUNT',
          subtitle: 'Welcome to Haunt. Every story is told only once.',
          continueLabel: 'Continue',
        },
      },
    });
  }
  return builder.getResponse();
}

/**
 * Shows the QR sign-in screen (same flow as the Fire TV LoginScreen). No reprompt and no
 * shouldEndSession, so the screen stays up without holding the microphone open.
 */
function signIn(handlerInput: Alexa.HandlerInput, speech: string) {
  const code = createSignInCode();
  save(handlerInput, { screen: 'login', userCode: code.userCode });
  return handlerInput.responseBuilder
    .speak(speech)
    .addDirective({
      type: 'Alexa.Presentation.APL.RenderDocument',
      token: LOGIN_TOKEN,
      document: { ...loginDocument, graphics: { ...loginDocument.graphics, signInQr: qrGraphic(code.qrValue) } },
      datasources: {
        login: {
          prompt: 'Scan with your phone',
          tagline: 'Every choice echoes in the dark.',
          description: 'Interactive horror stories that twist with every decision you make.',
          userCode: code.userCode,
          verificationDisplay: VERIFICATION_URI.replace(/^https:\/\//, ''),
        },
      },
    })
    .getResponse();
}

// ---------- requests → actions ----------

interface Action {
  name: string;
  args: unknown[];
}

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };

function slotValue(request: IntentRequest, slot: string): string | undefined {
  return request.intent.slots?.[slot]?.value;
}

/** A tap (SendEvent [action, ...args]) or a voice intent, read against the screen on show. */
function resolveAction(handlerInput: Alexa.HandlerInput): Action | null {
  const request = handlerInput.requestEnvelope.request;
  if (request.type === 'Alexa.Presentation.APL.UserEvent') {
    const [name, ...args] = request.arguments ?? [];
    return typeof name === 'string' ? { name, args } : null;
  }
  if (request.type !== 'IntentRequest') return null;

  const screen = session(handlerInput).screen ?? 'welcome';
  const intent = request.intent.name;
  const act = (name: string, ...args: unknown[]): Action => ({ name, args });

  switch (intent) {
    case 'AMAZON.YesIntent':
      if (screen === 'player') return act('chooseYes');
      if (screen === 'playmode') return act('mode', 'choices');
      return screen === 'welcome' ? act('continue') : null;
    case 'ContinueIntent':
    case 'AMAZON.ResumeIntent':
      return screen === 'welcome' ? act('continue') : screen === 'player' ? act('resume') : null;
    case 'GuestIntent':
      return act('guest');
    case 'NewCodeIntent':
      return screen === 'login' ? act('newCode') : null;
    case 'PlayStoryIntent':
      return act('openStory', 'ashford-house');
    case 'CreateStoryIntent':
      return act('create', '');
    case 'HomeIntent':
      return act('home');
    case 'PlayWithChoicesIntent':
      return act('mode', 'choices');
    case 'ListenModeIntent':
      return act('mode', 'listen');
    case 'ChooseIntent': {
      const n = Number(slotValue(request, 'number'));
      const ordinalId = request.intent.slots?.ordinal?.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.id;
      const ordinal = ORDINALS[ordinalId ?? slotValue(request, 'ordinal') ?? ''];
      return act('chooseNumber', Number.isFinite(n) && n > 0 ? n : ordinal ?? 0);
    }
    case 'PlayAgainIntent':
    case 'AMAZON.StartOverIntent':
      return act('playAgain');
    case 'RestartIntent':
      return act('restart');
    case 'BackIntent':
      return act('back');
    case 'AMAZON.PauseIntent':
      return act('pause');
    default:
      return null;
  }
}

// ---------- actions ----------

function script(handlerInput: Alexa.HandlerInput) {
  return SCRIPTS[session(handlerInput).storyId ?? 'ashford-house'] ?? SCRIPTS['ashford-house'];
}

function goHome(handlerInput: Alexa.HandlerInput, speech?: string) {
  const name = session(handlerInput).displayName ?? 'Guest';
  save(handlerInput, { screen: 'home', play: undefined });
  return respond(
    handlerInput,
    homeScreen(name, speech ?? 'Home. Tap a story to see it, and tap again to open it. Or say play the Ashford House, or create a story.'),
  );
}

function openStory(handlerInput: Alexa.HandlerInput, storyId: string) {
  const story = SCRIPTS[storyId];
  if (!story) return respond(handlerInput, { speech: COMING_SOON, directives: [toast(TOKENS.home, COMING_SOON)] });
  save(handlerInput, { screen: 'playmode', storyId });
  return respond(handlerInput, playModeScreen(story));
}

function showScene(handlerInput: Alexa.HandlerInput, play: PlayState, sceneNumber: number) {
  const s = script(handlerInput);
  const state = session(handlerInput);
  const endings = { ...(state.endings ?? {}) };
  const ending = s.scenes[play.sceneId].ending;
  if (ending) {
    const found = endings[s.id] ?? [];
    endings[s.id] = found.includes(ending.id) ? found : [...found, ending.id];
  }
  save(handlerInput, { screen: 'player', play, sceneNumber, endings });
  return respond(handlerInput, playerScreen(s, play, sceneNumber, endings[s.id] ?? []));
}

function startListening(handlerInput: Alexa.HandlerInput) {
  const s = script(handlerInput);
  save(handlerInput, { screen: 'listen', play: undefined });
  return respond(handlerInput, listenScreen(s, 0, session(handlerInput).endings?.[s.id] ?? []));
}

function chooseByIndex(handlerInput: Alexa.HandlerInput, index: number) {
  const s = script(handlerInput);
  const { play, sceneNumber = 1 } = session(handlerInput);
  if (!play) return startPlaying(handlerInput);
  const scene = s.scenes[play.sceneId];
  const choice = index === -1 ? scene.choices.at(-1) : scene.choices[index - 1];
  if (!choice) {
    const count = scene.choices.length;
    return respond(handlerInput, { speech: `Pick a number from one to ${count}.`, reprompt: 'Which one?', directives: [] });
  }
  const next = choose(s, play, choice);
  if (next === play) {
    const reason = `That path is locked. It needs the ${s.items[choice.requires!].name}.`;
    return respond(handlerInput, { speech: reason, reprompt: 'Pick another choice.', directives: [toast(TOKENS.player, reason)] });
  }
  return showScene(handlerInput, next, sceneNumber + 1);
}

function startPlaying(handlerInput: Alexa.HandlerInput) {
  return showScene(handlerInput, startStory(script(handlerInput)), 1);
}

function perform(handlerInput: Alexa.HandlerInput, action: Action) {
  const state = session(handlerInput);
  const screen = state.screen ?? 'welcome';
  const [arg] = action.args;

  switch (action.name) {
    case 'continue':
      return signIn(handlerInput, 'Scan the code on your screen with your phone to sign in. Or say, continue as guest.');
    case 'newCode':
      return signIn(handlerInput, "Here's a new code.");
    case 'guest':
      save(handlerInput, { displayName: 'Guest', userCode: undefined });
      return goHome(
        handlerInput,
        "You're in as a guest. Tonight's featured story is The Ashford House. Tap a story to see it, tap again to open it, or say create a story.",
      );
    case 'home':
      return goHome(handlerInput);
    case 'comingSoon':
      return respond(handlerInput, { speech: COMING_SOON, directives: [toast(TOKENS.home, COMING_SOON)] });
    case 'openStory':
    case 'playAshford':
      return openStory(handlerInput, typeof arg === 'string' && arg ? arg : 'ashford-house');
    case 'create':
      save(handlerInput, { screen: 'create' });
      return respond(handlerInput, createScreen(typeof arg === 'string' ? arg : undefined));
    case 'changeSettings':
      save(handlerInput, { screen: 'create' });
      return respond(handlerInput, createScreen(state.lastRequest?.subgenreId));
    case 'generate': {
      const request = requestFromArgs(action.args);
      save(handlerInput, { screen: 'generating', lastRequest: request });
      return respond(handlerInput, generatingScreen(request));
    }
    case 'mode':
      if (!state.storyId && screen !== 'playmode') save(handlerInput, { storyId: 'ashford-house' });
      return arg === 'listen' ? startListening(handlerInput) : startPlaying(handlerInput);
    case 'choose': {
      const s = script(handlerInput);
      const scene = state.play ? s.scenes[state.play.sceneId] : undefined;
      const index = scene ? scene.choices.findIndex((c) => c.id === arg) : -1;
      return index >= 0 ? chooseByIndex(handlerInput, index + 1) : startPlaying(handlerInput);
    }
    case 'chooseNumber':
      if (screen !== 'player') break;
      return chooseByIndex(handlerInput, Number(arg));
    case 'chooseYes': {
      const s = script(handlerInput);
      const scene = state.play ? s.scenes[state.play.sceneId] : undefined;
      const index = scene ? scene.choices.findIndex((c) => /^[“"]?yes/i.test(c.label)) : -1;
      if (index >= 0) return chooseByIndex(handlerInput, index + 1);
      break;
    }
    case 'restart':
      return screen === 'listen' ? startListening(handlerInput) : startPlaying(handlerInput);
    case 'playAgain':
      // As on the TV: Play Again asks how to play again.
      return openStory(handlerInput, state.storyId ?? 'ashford-house');
    case 'listenNext': {
      if (screen !== 'listen') break;
      const s = script(handlerInput);
      const { segments } = listenTimeline(s);
      const index = Math.max(0, Number(arg) || 0);
      let found = state.endings?.[s.id] ?? [];
      const endingId = segments[segments.length - 1].scene.ending?.id;
      if (index >= segments.length && endingId && !found.includes(endingId)) {
        found = [...found, endingId];
        save(handlerInput, { endings: { ...state.endings, [s.id]: found } });
      }
      return respond(handlerInput, listenScreen(s, index, found));
    }
    case 'pause':
      if (screen === 'player') return respond(handlerInput, { directives: [setValue(TOKENS.player, 'playerRoot', 'paused', true)] });
      break;
    case 'resume':
      if (screen === 'player') return respond(handlerInput, { directives: [setValue(TOKENS.player, 'playerRoot', 'paused', false)] });
      break;
    case 'back':
      if (screen === 'generating') return perform(handlerInput, { name: 'changeSettings', args: [] });
      if (screen === 'login') return welcome(handlerInput);
      return goHome(handlerInput);
  }
  return helpFor(handlerInput, "I can't do that here.");
}

function helpFor(handlerInput: Alexa.HandlerInput, lead = '') {
  const screen = session(handlerInput).screen ?? 'welcome';
  const help: Record<ScreenName, [string, string]> = {
    welcome: ['Haunt tells interactive horror stories. Say continue, or tap Continue, to begin.', WELCOME_REPROMPT],
    login: ['Scan the code on your screen with your phone to sign in. Say new code for a fresh one, or continue as guest.', 'Say new code, or continue as guest.'],
    home: ['Tap a story to see it, and tap again to open it. Or say play the Ashford House, or create a story.', 'Say play the Ashford House, or create a story.'],
    create: ['Pick a sub-genre and options on screen, then tap Generate My Story. Or say go home.', 'Say go home, or tap Generate My Story.'],
    generating: ['Say play the Ashford House, or change settings.', 'Say play the Ashford House, or change settings.'],
    playmode: ['Say play with choices to decide what happens, or just listen to hear it straight through.', 'Say play with choices, or just listen.'],
    player: ['Say the number of a choice, or tap it. Say pause, restart the story, or go home at any time.', 'Which choice?'],
    listen: ['The narrator is telling the story. Say restart the story, or go home.', 'Say restart the story, or go home.'],
  };
  const [speech, reprompt] = help[screen];
  return handlerInput.responseBuilder.speak(`${lead} ${speech}`.trim()).reprompt(reprompt).getResponse();
}

// ---------- handlers ----------

const LaunchRequestHandler: Alexa.RequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  handle(handlerInput) {
    return welcome(handlerInput);
  },
};

// Voice-only devices: the story experience needs a screen for now (sign-in and stories are on hold).
const VoiceOnlyHandler: Alexa.RequestHandler = {
  canHandle(handlerInput) {
    return !supportsApl(handlerInput) && resolveAction(handlerInput) !== null;
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak('Your first story is still being written. It will be ready soon. Until then, sleep well.')
      .withShouldEndSession(true)
      .getResponse();
  },
};

const ActionHandler: Alexa.RequestHandler = {
  canHandle(handlerInput) {
    return resolveAction(handlerInput) !== null;
  },
  handle(handlerInput) {
    return perform(handlerInput, resolveAction(handlerInput)!);
  },
};

const NoIntentHandler: Alexa.RequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.NoIntent';
  },
  handle(handlerInput) {
    const screen = session(handlerInput).screen;
    if (screen && screen !== 'welcome') return helpFor(handlerInput);
    return handlerInput.responseBuilder.speak('Very well. The darkness will wait for you. Goodbye.').withShouldEndSession(true).getResponse();
  },
};

const HelpIntentHandler: Alexa.RequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(handlerInput) {
    return helpFor(handlerInput);
  },
};

const CancelAndStopIntentHandler: Alexa.RequestHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      ['AMAZON.CancelIntent', 'AMAZON.StopIntent', 'AMAZON.NavigateHomeIntent'].includes(Alexa.getIntentName(handlerInput.requestEnvelope))
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.speak('Goodbye. Sleep well.').withShouldEndSession(true).getResponse();
  },
};

const FallbackIntentHandler: Alexa.RequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest';
  },
  handle(handlerInput) {
    return helpFor(handlerInput, "Something whispers back, but I couldn't make it out.");
  },
};

const SessionEndedRequestHandler: Alexa.RequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.getResponse();
  },
};

const ErrorHandler: Alexa.ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.error('Haunt error:', error);
    return handlerInput.responseBuilder.speak('Something went wrong in the dark. Please try again.').reprompt(WELCOME_REPROMPT).getResponse();
  },
};

export function createSkill(): Alexa.Skill {
  return Alexa.SkillBuilders.custom()
    .addRequestHandlers(
      LaunchRequestHandler,
      VoiceOnlyHandler,
      ActionHandler,
      NoIntentHandler,
      HelpIntentHandler,
      CancelAndStopIntentHandler,
      FallbackIntentHandler,
      SessionEndedRequestHandler,
    )
    .addErrorHandlers(ErrorHandler)
    .withCustomUserAgent('haunt/stories/v0.3')
    .create();
}

const skill = createSkill();

export const handler = (event: RequestEnvelope, context?: unknown): Promise<ResponseEnvelope> =>
  skill.invoke(event, context);
