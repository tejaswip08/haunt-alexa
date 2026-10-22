// Ported from apps/tv/src/story/ashfordHouse.ts. Art paths are APL graphic names (see art/art.json).
import type { StoryScript } from '../story/engine';

// Hand-written demo story with real branching: two items change which choices
// are available, and there are three different endings.
//
//   arrival ─┬─ foyer ──┬─ study (journal) ─┬─ basement
//            │          └─ nursery ─────────┤
//            └─ garden (key) ── basement    └─ ending: trapped
//   basement ─┬─ crypt (needs key) ─┬─ ending: escape
//             │                     └─ ending: trapped
//             ├─ ritual (needs journal) ── ending: truth
//             └─ ending: escape

export const ashfordHouse: StoryScript = {
  id: 'ashford-house',
  title: 'The Ashford House',
  subtitle: 'An inheritance no one wanted',
  subgenreName: 'Haunted House',
  start: 'arrival',
  endingCount: 3,
  items: {
    key: { name: 'Rusted Key', icon: '🗝', description: 'Cold iron, stamped with a single letter: C.' },
    journal: {
      name: "Aunt Miriam's Journal",
      icon: '📖',
      description: 'The last page is underlined three times: “Say her name and she will rest.”',
    },
  },
  scenes: {
    arrival: {
      id: 'arrival',
      chapter: 'Chapter 1 · The Inheritance',
      location: 'Ashford House · Dusk',
      art: 'ashford-house',
      narration:
        'The taxi will not come up the drive. You walk the last mile alone, suitcase rattling over gravel, until Ashford House rises out of the fog. Your aunt has been dead for three weeks. Someone has left a light on upstairs.',
      choices: [
        { id: 'front', label: 'Go in through the front door', hint: 'The key is under the mat, as promised.', next: 'foyer' },
        { id: 'garden', label: 'Circle around to the back garden', hint: 'Something glints in the dirt.', next: 'garden' },
      ],
    },
    foyer: {
      id: 'foyer',
      chapter: 'Chapter 2 · The House Remembers',
      location: 'The Foyer',
      art: 'hallway',
      narration:
        'Dust sheets cover everything except one portrait: Aunt Miriam, and beside her a little girl you have never seen. The girl’s face has been scratched out. Somewhere above you, a music box begins to play.',
      choices: [
        { id: 'upstairs', label: 'Follow the music upstairs', hint: 'It is coming from the nursery.', next: 'nursery' },
        { id: 'study', label: 'Search your aunt’s study', hint: 'The door is ajar. A lamp is still warm.', next: 'study' },
      ],
    },
    garden: {
      id: 'garden',
      chapter: 'Chapter 2 · What Was Buried',
      location: 'The Back Garden',
      art: 'forest',
      found: 'key',
      narration:
        'Behind the house the garden has run wild. In the middle of it is a freshly dug hole, small, the size of a child. At the bottom, half-buried, lies a rusted key. The cellar hatch beside it is not locked. It is waiting.',
      choices: [
        { id: 'hatch', label: 'Climb down through the cellar hatch', hint: 'The dark smells of wet earth and lilies.', next: 'basement' },
        { id: 'front', label: 'Go back to the front door', hint: 'Better to enter like a guest.', next: 'foyer' },
      ],
    },
    study: {
      id: 'study',
      chapter: 'Chapter 3 · Miriam’s Confession',
      location: 'The Study',
      art: 'gothic',
      found: 'journal',
      narration:
        'Your aunt’s journal lies open on the desk, as if she stood up a moment ago. The handwriting grows wilder with every page. “Clara will not stay in the basement. She wants a new family. Say her name and she will rest.”',
      choices: [
        { id: 'down', label: 'Go down to the basement', hint: 'You know her name now.', next: 'basement' },
        { id: 'nursery', label: 'Go up to the nursery', hint: 'The music has stopped.', next: 'nursery' },
      ],
    },
    nursery: {
      id: 'nursery',
      chapter: 'Chapter 3 · The Nursery',
      location: 'The Nursery',
      art: 'psychological',
      narration:
        'The rocking chair is still moving. On the wall, in crayon, someone has drawn this house, Aunt Miriam, and a new figure holding the girl’s hand. It is you. A small voice speaks from inside the mirror.',
      voice: { speaker: 'A little girl', line: 'Will you stay with me? Everyone always leaves.' },
      choices: [
        { id: 'yes', label: '“Yes. I’ll stay.”', hint: 'She sounds so lonely.', next: 'end-trapped' },
        { id: 'run', label: 'Back away and run downstairs', hint: 'The stairs groan under you.', next: 'basement' },
      ],
    },
    basement: {
      id: 'basement',
      chapter: 'Chapter 4 · Below',
      location: 'The Basement',
      art: 'possession',
      narration:
        'The basement is colder than the night outside. At the far end stands a door wrapped in chains, and behind it something is knocking slowly, patiently, the way a child knocks when she knows you are home.',
      choices: [
        { id: 'unlock', label: 'Unlock the chains', hint: 'Use the rusted key.', next: 'crypt', requires: 'key' },
        { id: 'name', label: 'Read the last page aloud', hint: 'Use your aunt’s journal.', next: 'end-truth', requires: 'journal' },
        { id: 'flee', label: 'Run for the front door', hint: 'Don’t look back.', next: 'end-escape' },
      ],
    },
    crypt: {
      id: 'crypt',
      chapter: 'Chapter 5 · Clara',
      location: 'The Hidden Room',
      art: 'cult',
      narration:
        'Candles light themselves as the door swings open. In the middle of the room is a small coffin, its lid pushed aside from the inside. A cold hand slips into yours.',
      voice: { speaker: 'Clara', line: 'You came back. Hold on tight.' },
      choices: [
        { id: 'hold', label: 'Hold her hand', hint: 'It would be so easy to stay.', next: 'end-trapped' },
        { id: 'pull', label: 'Pull free and slam the door', hint: 'The candles go out all at once.', next: 'end-escape' },
      ],
    },
    'end-escape': {
      id: 'end-escape',
      chapter: 'Ending',
      location: 'The Road Out',
      art: 'cabin',
      narration:
        'You don’t stop running until the house is a black shape behind you. A car finally stops for you on the main road. Only later, in the light of a petrol station, do you notice the small handprints on the back window. From the inside.',
      choices: [],
      ending: {
        id: 'escape',
        kind: 'escape',
        title: 'The Last Light',
        epilogue: 'You escaped Ashford House. But something small and patient came with you.',
      },
    },
    'end-trapped': {
      id: 'end-trapped',
      chapter: 'Ending',
      location: 'Ashford House · Forever',
      art: 'village',
      narration:
        'The drawing on the nursery wall is finished now. Months later a young couple tour the house. They say it is lovely, if a little cold, and they never notice the two figures watching them from the upstairs window.',
      choices: [],
      ending: {
        id: 'trapped',
        kind: 'trapped',
        title: 'Forever Seven',
        epilogue: 'Clara has a new family. The house has a new ghost.',
      },
    },
    'end-truth': {
      id: 'end-truth',
      chapter: 'Ending',
      location: 'The Basement · Dawn',
      art: 'cosmic',
      narration:
        '“Clara Ashford.” The knocking stops. The chains fall away on their own and the door opens on an empty room full of morning light. For the first time in forty years, the music box upstairs is silent.',
      choices: [],
      ending: {
        id: 'truth',
        kind: 'truth',
        title: 'Rest, Clara',
        epilogue: 'You spoke her name and set her free. The best ending, and the hardest to find.',
      },
    },
  },
};
