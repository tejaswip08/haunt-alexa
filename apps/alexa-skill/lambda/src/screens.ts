import { interfaces } from 'ask-sdk-model';
import art from './art/art.json';
import baseDocument from './apl/base.json';
import createDocument from './apl/create.json';
import generatingDocument from './apl/generating.json';
import homeDocument from './apl/home.json';
import listenDocument from './apl/listen.json';
import playmodeDocument from './apl/playmode.json';
import playerDocument from './apl/player.json';
import { ashfordHouse } from './content/ashfordHouse';
import { featuredStory, formatCount, rails, subgenreById, subgenres, type Story, type Subgenre } from './content/catalog';
import { FEAR_LEVELS, IDEA_MAX_LENGTH, LENGTHS, SETTINGS, STORY_LANGUAGES, type StoryRequest } from './content/createOptions';
import { canChoose, listenTimeline, type PlayState, type StoryScript } from './story/engine';

// Turns content + play state into APL documents, datasources and speech for the
// story experience screens (ported from apps/tv).

type Directive = interfaces.alexa.presentation.apl.RenderDocumentDirective | interfaces.alexa.presentation.apl.ExecuteCommandsDirective;
type Doc = Record<string, any>;

export interface Screen {
  speech?: string;
  /** Opens the microphone after the speech. Without it the screen stays up, mic closed. */
  reprompt?: string;
  directives: Directive[];
}

export const TOKENS = {
  home: 'hauntHome',
  create: 'hauntCreate',
  generating: 'hauntGenerating',
  playmode: 'hauntPlayMode',
  player: 'hauntPlayer',
  listen: 'hauntListen',
} as const;

/** Stories with a playable script in this demo (same as the live TV app). */
export const SCRIPTS: Record<string, StoryScript> = { [ashfordHouse.id]: ashfordHouse };

const artGraphics = art as Record<string, Doc>;

/** Merge the shared base pieces and the art a screen uses into its document. */
function compose(doc: Doc, artNames: string[]): Doc {
  const base = baseDocument as Doc;
  const graphics: Doc = { ...base.graphics, ...(doc.graphics ?? {}) };
  for (const name of new Set(['shade', ...artNames])) {
    if (!artGraphics[name]) throw new Error(`Unknown art "${name}"`);
    graphics[name] = artGraphics[name];
  }
  return {
    ...doc,
    resources: [...base.resources, ...(doc.resources ?? [])],
    styles: { ...base.styles, ...(doc.styles ?? {}) },
    commands: { ...base.commands, ...(doc.commands ?? {}) },
    layouts: { ...base.layouts, ...(doc.layouts ?? {}) },
    graphics,
  };
}

function render(token: string, doc: Doc, artNames: string[], datasources: Doc): Directive {
  return { type: 'Alexa.Presentation.APL.RenderDocument', token, document: compose(doc, artNames), datasources };
}

// ShowToast is a document-defined command (base.json), which the SDK's command types don't know.
function execute(token: string, commands: Doc[]): Directive {
  return { type: 'Alexa.Presentation.APL.ExecuteCommands', token, commands } as unknown as Directive;
}

export function toast(token: string, message: string): Directive {
  return execute(token, [{ type: 'ShowToast', message }]);
}

export function setValue(token: string, componentId: string, property: string, value: unknown): Directive {
  return execute(token, [{ type: 'SetValue', componentId, property, value }]);
}

// ---------- speech ----------

export function escapeSsml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

const NARRATOR = 'Matthew';
/** Character voices: the little girl / Clara get a child's voice. */
function characterVoice(speaker: string): string {
  return /girl|clara/i.test(speaker) ? 'Ivy' : 'Joey';
}

function narrationSsml(narration: string, voice?: { speaker: string; line: string }): string {
  let out = `<voice name="${NARRATOR}">${escapeSsml(narration)}</voice>`;
  if (voice) out += `<break time="600ms"/><voice name="${characterVoice(voice.speaker)}">${escapeSsml(voice.line)}</voice>`;
  return out;
}

/** Rough time Alexa takes to read a scene, so choices appear as the narration ends. */
function narrationMs(narration: string, voice?: { line: string }): number {
  return Math.round(narration.length * 66 + (voice ? 600 + voice.line.length * 66 : 0) + 400);
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five'];

// ---------- Home ----------

interface Hero {
  eyebrow: string;
  title: string;
  subtitle: string;
  meta: string[];
  logline: string;
  art: string;
  action: string;
  arg: string;
  actionLabel: string;
}

function storyHero(story: Story, context: string): Hero {
  const playable = Boolean(SCRIPTS[story.id]);
  return {
    eyebrow: `${context}  ·  HORROR · ${subgenreById[story.subgenre].name.toUpperCase()}`,
    title: story.title,
    subtitle: story.subtitle,
    meta: [
      `${story.durationMin} min`,
      `${story.endings} endings`,
      `♥ ${formatCount(story.likes)}`,
      `▶ ${formatCount(story.plays)} plays`,
      story.author ? `by @${story.author}` : 'Haunt Original',
    ],
    logline: story.logline,
    art: story.art,
    action: playable ? 'openStory' : 'comingSoon',
    arg: story.id,
    actionLabel: playable ? '▶  Play' : '▶  Play',
  };
}

function subgenreHero(subgenre?: Subgenre): Hero {
  return {
    eyebrow: 'CREATE YOUR OWN  ·  HORROR',
    title: subgenre ? subgenre.name : 'Your Own Nightmare',
    subtitle: 'Your story. Your choices. Your ending.',
    meta: ['AI-generated', '10–40 min', '2–5 endings'],
    logline: subgenre
      ? subgenre.description
      : 'Pick a sub-genre, a setting and how scared you want to be. Haunt writes the story live as you play.',
    art: subgenre?.art ?? 'cosmic',
    action: 'create',
    arg: subgenre?.id ?? '',
    actionLabel: '+  Create',
  };
}

// Position of the "Create your own" rail among the story rails (as on the TV).
const CREATE_RAIL_INDEX = 3;

export function homeScreen(displayName: string, speech?: string): Screen {
  const heroes: Hero[] = [storyHero(featuredStory, 'FEATURED')];
  const addHero = (hero: Hero) => heroes.push(hero) - 1;

  const storyRails = rails.map((rail) => ({
    title: rail.title,
    kind: rail.kind,
    items: rail.items.map((story, i) => {
      const context = rail.kind === 'ranked' ? `TRENDING #${i + 1}` : rail.title.toUpperCase();
      const heroIndex = rail.id === 'featured' && i === 0 ? 0 : addHero(storyHero(story, context));
      const minutesLeft = Math.max(1, Math.round(story.durationMin * (1 - (story.progress ?? 0))));
      return {
        heroIndex,
        action: SCRIPTS[story.id] ? 'openStory' : 'comingSoon',
        arg: story.id,
        title: story.title,
        subtitle: story.subtitle,
        art: story.art,
        original: story.source === 'original',
        likes: formatCount(story.likes),
        meta: rail.kind === 'continue' ? `Resume · ${minutesLeft} min left` : `${story.durationMin} min  ·  ${story.endings} endings`,
        byline: story.author ? `by @${story.author}` : 'Haunt Original',
        rank: rail.kind === 'ranked' ? i + 1 : 0,
        progress: rail.kind === 'continue' ? story.progress ?? 0 : -1,
      };
    }),
  }));

  const createRail = {
    title: 'Create Your Own · Pick a Sub-genre',
    kind: 'create',
    items: [undefined, ...subgenres].map((s) => ({
      heroIndex: addHero(subgenreHero(s)),
      action: 'create',
      arg: s?.id ?? '',
      title: s?.name ?? 'Create Custom',
      art: s?.art ?? '',
    })),
  };
  const allRails: unknown[] = [...storyRails];
  allRails.splice(CREATE_RAIL_INDEX, 0, createRail);

  const artNames = [...new Set(heroes.map((h) => h.art))];
  return {
    speech,
    directives: [
      render(TOKENS.home, homeDocument, artNames, {
        home: { displayName, initial: displayName.charAt(0).toUpperCase(), heroes, rails: allRails },
      }),
    ],
  };
}

export const COMING_SOON =
  'Demo: only “The Ashford House” is playable right now. Try Create to generate your own.';

// ---------- Create ----------

export function createScreen(initialSubgenre?: string): Screen {
  const initialSub = Math.max(0, subgenres.findIndex((s) => s.id === initialSubgenre));
  return {
    speech: 'Design your nightmare. Pick a sub-genre and how scared you want to be, then tap Generate My Story.',
    directives: [
      render(TOKENS.create, createDocument, subgenres.map((s) => s.art), {
        create: {
          initialSub,
          ideaMaxLength: IDEA_MAX_LENGTH,
          subgenres: subgenres.map((s) => ({ ...s, upper: s.name.toUpperCase() })),
          settings: SETTINGS,
          lengths: LENGTHS,
          fears: FEAR_LEVELS,
          languages: STORY_LANGUAGES.map((l) => ({ ...l, short: l.label.split(' · ').pop() })),
        },
      }),
    ],
  };
}

/** Maps the Create screen's Generate arguments (indexes + idea) to a story request. */
export function requestFromArgs(args: unknown[]): StoryRequest {
  const pick = <T>(list: readonly T[], value: unknown, fallback: number) => list[Number(value)] ?? list[fallback];
  const subgenre = pick(subgenres, args[0], 0);
  return {
    subgenreId: subgenre.id,
    subgenreName: subgenre.name,
    setting: pick(SETTINGS, args[1], 0),
    length: pick(LENGTHS, args[2], 1).id,
    fear: pick(FEAR_LEVELS, args[3], 1).id,
    language: pick(STORY_LANGUAGES, args[4], 0).code,
    idea: String(args[5] ?? '').trim().slice(0, IDEA_MAX_LENGTH),
  };
}

// ---------- Generating (no story server yet) ----------

export function generatingScreen(request: StoryRequest): Screen {
  const subgenre = subgenreById[request.subgenreId as keyof typeof subgenreById] ?? subgenres[0];
  const message =
    "Haunt writes new stories live on the Haunt story server, and it isn't connected to Alexa yet. " +
    'Your choices are saved for when it is. Until then, The Ashford House is waiting.';
  const length = LENGTHS.find((l) => l.id === request.length)!;
  const fear = FEAR_LEVELS.find((f) => f.id === request.fear)!;
  const language = STORY_LANGUAGES.find((l) => l.code === request.language)!;
  return {
    speech: `The story didn't start. ${message} Say play the Ashford House, or change settings.`,
    reprompt: 'Say play the Ashford House, or change settings.',
    directives: [
      render(TOKENS.generating, generatingDocument, [subgenre.art], {
        generating: {
          art: subgenre.art,
          subgenreName: subgenre.name.toUpperCase(),
          place: (request.setting === 'Surprise me' ? 'Surprise setting' : request.setting).toUpperCase(),
          message,
          pills: [
            ...(request.idea ? [`“${request.idea.length > 26 ? `${request.idea.slice(0, 25)}…` : request.idea}”`] : []),
            length.detail,
            fear.label,
            language.label.split(' · ').pop()!,
          ],
        },
      }),
    ],
  };
}

// ---------- Play mode ----------

export function playModeScreen(script: StoryScript): Screen {
  return {
    speech: `${escapeSsml(script.title)}. How do you want to play? Say play with choices, or just listen.`,
    reprompt: 'Say play with choices, or just listen.',
    directives: [
      render(TOKENS.playmode, playmodeDocument, [script.scenes[script.start].art], {
        playmode: {
          title: script.title,
          subtitle: script.subtitle,
          subgenreName: script.subgenreName.toUpperCase(),
          art: script.scenes[script.start].art,
          extent: `${script.endingCount} endings to discover`,
        },
      }),
    ],
  };
}

// ---------- Story player (with choices) ----------

function endingsFoundText(script: StoryScript, found: string[]): string {
  return `${found.length} of ${script.endingCount} endings discovered`.toUpperCase();
}

export function playerScreen(script: StoryScript, play: PlayState, sceneNumber: number, endingsFound: string[]): Screen {
  const scene = script.scenes[play.sceneId];
  const ending = scene.ending;
  const open = scene.choices.map((c, i) => ({ c, i })).filter(({ c }) => canChoose(play, c));
  const found = play.justFound ? script.items[play.justFound] : null;

  const choices = scene.choices.map((choice, i) => {
    const locked = !canChoose(play, choice);
    return {
      id: choice.id,
      index: i + 1,
      label: choice.label,
      hint: choice.hint ?? '',
      locked,
      lockedReason: locked ? `Needs ${script.items[choice.requires!].name}` : '',
    };
  });

  let speech = '';
  if (found) speech += `<voice name="${NARRATOR}">Clue found: ${escapeSsml(found.name)}.</voice><break time="400ms"/>`;
  speech += narrationSsml(scene.narration, scene.voice);
  let reprompt: string;
  if (ending) {
    speech +=
      `<break time="900ms"/>The end. ${escapeSsml(ending.title)}. ${escapeSsml(ending.epilogue)} ` +
      `You've discovered ${endingsFound.length} of ${script.endingCount} endings. Say play again, or go home.`;
    reprompt = 'Say play again, or go home.';
  } else {
    const list = open.map(({ c, i }) => `${NUMBER_WORDS[i + 1]}: ${escapeSsml(c.label)}`).join('. ');
    speech += `<break time="700ms"/>What do you do? ${list}.`;
    reprompt = `Say ${open.map(({ i }) => NUMBER_WORDS[i + 1]).join(' or ')}.`;
  }

  const ms = narrationMs(scene.narration, scene.voice);
  return {
    speech,
    reprompt,
    directives: [
      render(TOKENS.player, playerDocument, [scene.art], {
        player: {
          title: script.title,
          scene: {
            chapter: scene.chapter,
            location: scene.location,
            art: scene.art,
            narration: scene.narration,
            voice: scene.voice ?? null,
          },
          inventory: play.inventory.map((id) => script.items[id].name),
          sceneNumber,
          found: found ? { name: found.name, description: found.description } : null,
          choices,
          voiceHint: `Tap a choice, or say ${open.map(({ i }) => `“${NUMBER_WORDS[i + 1]}”`).join(' or ')}.`,
          ending: ending
            ? {
                title: ending.title,
                epilogue: ending.epilogue,
                found: endingsFoundText(script, endingsFound),
                path: play.path.map((step) => step.replace(/[“”]/g, '')),
              }
            : null,
          narrationMs: ending ? Math.min(ms, 4000) : ms,
          barRepeats: Math.max(1, Math.round(ms / 300)),
        },
      }),
    ],
  };
}

// ---------- Listen without choices ----------

/** Time to let Alexa finish reading a scene before moving on (a little generous, plus a short hold). */
function listenHoldMs(narration: string, voice?: { line: string }): number {
  return narrationMs(narration, voice) + 1800;
}

/**
 * "Listen without choices": the first-choice path plays straight through like an episode.
 * Each scene is rendered on its own while Alexa reads it (the same voices as the player); the
 * document then asks for the next one (listenNext). After the last scene comes the ending.
 */
export function listenScreen(script: StoryScript, index: number, endingsFound: string[]): Screen {
  const { segments } = listenTimeline(script);
  const last = segments[segments.length - 1].scene;
  const ending = last.ending!;
  const segData = segments.map((seg) => ({
    chapter: seg.scene.chapter,
    location: seg.scene.location,
    art: seg.scene.art,
    narration: seg.scene.narration,
    voice: seg.scene.voice ?? null,
    found: seg.found ? { name: script.items[seg.found].name, description: script.items[seg.found].description } : null,
    weight: Math.max(1, Math.round(seg.durationMs / 1000)),
  }));

  const atEnd = index >= segments.length;
  let speech: string;
  let holdMs = 0;
  if (atEnd) {
    speech =
      `The end. ${escapeSsml(ending.title)}. ${escapeSsml(ending.epilogue)} ` +
      `You've discovered ${endingsFound.length} of ${script.endingCount} endings. Say play again, or go home.`;
  } else {
    const seg = segments[index];
    speech = '';
    if (seg.found) speech += `<voice name="${NARRATOR}">Clue found: ${escapeSsml(script.items[seg.found].name)}.</voice><break time="400ms"/>`;
    speech += narrationSsml(seg.scene.narration, seg.scene.voice);
    holdMs = listenHoldMs(seg.scene.narration, seg.scene.voice) + (seg.found ? 2000 : 0);
  }

  return {
    speech,
    reprompt: atEnd ? 'Say play again, or go home.' : undefined,
    directives: [
      render(TOKENS.listen, listenDocument, [...new Set([...segData.map((s) => s.art), last.art])], {
        listen: {
          type: 'object',
          properties: {
            title: script.title,
            segments: segData,
            scene: Math.min(index, segments.length),
            holdMs,
            next: atEnd ? -1 : index + 1,
            ending: { title: ending.title, epilogue: ending.epilogue, art: last.art, found: endingsFoundText(script, endingsFound) },
          },
        },
      }),
    ],
  };
}
