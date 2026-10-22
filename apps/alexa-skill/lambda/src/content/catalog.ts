// Ported from apps/tv/src/data/catalog.ts. Art paths are APL graphic names (see art/art.json).
// Mock catalog for the home and create screens. UI only — this will later come
// from the story backend. The main genre is always horror; stories differ by sub-genre.

export type SubgenreId =
  | 'paranormal'
  | 'ghost'
  | 'haunted-house'
  | 'possession'
  | 'psychological'
  | 'folk'
  | 'cosmic'
  | 'slasher'
  | 'gothic'
  | 'creature'
  | 'cult'
  | 'survival';

export interface Subgenre {
  id: SubgenreId;
  name: string;
  description: string;
  art: string;
}

export const subgenres: Subgenre[] = [
  { id: 'paranormal', name: 'Paranormal', description: 'Unexplained forces, EVP static, things caught on camera.', art: 'asylum' },
  { id: 'ghost', name: 'Ghost Story', description: 'The dead who never left, and what they still want.', art: 'hallway' },
  { id: 'haunted-house', name: 'Haunted House', description: 'A place with a memory, and doors that open on their own.', art: 'ashford-house' },
  { id: 'possession', name: 'Possession', description: 'Something has moved in, and it is not leaving quietly.', art: 'possession' },
  { id: 'psychological', name: 'Psychological', description: 'Is it real, or is it you? Trust nothing, least of all yourself.', art: 'psychological' },
  { id: 'folk', name: 'Folk Horror', description: 'Old rituals, smiling villagers, and a harvest that needs you.', art: 'village' },
  { id: 'cosmic', name: 'Cosmic Horror', description: 'Truths too vast for the human mind. Sanity is a resource.', art: 'cosmic' },
  { id: 'slasher', name: 'Slasher', description: 'Someone is hunting. Every hiding place is a gamble.', art: 'cabin' },
  { id: 'gothic', name: 'Gothic', description: 'Candlelit halls, family secrets, and inheritances with a price.', art: 'gothic' },
  { id: 'creature', name: 'Creature Feature', description: 'It lives in the woods, the water, or the walls.', art: 'forest' },
  { id: 'cult', name: 'Cult', description: 'They welcomed you warmly. Leaving is another matter.', art: 'cult' },
  { id: 'survival', name: 'Survival', description: 'Stranded, hunted, outnumbered. Make it to dawn.', art: 'ship' },
];

export const subgenreById = Object.fromEntries(subgenres.map((s) => [s.id, s])) as Record<SubgenreId, Subgenre>;

export interface Story {
  id: string;
  title: string;
  subtitle: string;
  logline: string;
  subgenre: SubgenreId;
  durationMin: number;
  endings: number;
  art: string;
  /** Haunt Originals are ours; community stories were created and shared by players. */
  source: 'original' | 'community';
  author?: string;
  likes: number;
  plays: number;
  /** 0–1 when the player has an unfinished playthrough. */
  progress?: number;
}

export const stories: Story[] = [
  {
    id: 'ashford-house',
    title: 'The Ashford House',
    subtitle: 'An inheritance no one wanted',
    logline: 'Your late aunt left you a house no one in town will go near. The lights upstairs were on before you arrived.',
    subgenre: 'haunted-house', durationMin: 20, endings: 3, art: 'ashford-house',
    source: 'original', likes: 18400, plays: 92000, progress: 0.4,
  },
  {
    id: 'saint-veronica',
    title: 'Saint Veronica',
    subtitle: 'The night shift never ended',
    logline: 'A night shift in a hospital that closed forty years ago. Room 14 is still asking for its medication.',
    subgenre: 'paranormal', durationMin: 25, endings: 4, art: 'asylum',
    source: 'original', likes: 15100, plays: 74000,
  },
  {
    id: 'hollow-pines',
    title: 'Hollow Pines',
    subtitle: 'Stay on the trail',
    logline: 'The trail markers lead deeper every time you turn back. Something is wearing your friend’s voice.',
    subgenre: 'creature', durationMin: 18, endings: 3, art: 'forest',
    source: 'original', likes: 12800, plays: 66000, progress: 0.75,
  },
  {
    id: 'the-meridian',
    title: 'The Meridian',
    subtitle: 'A ghost ship comes to port',
    logline: 'A freighter drifts into port with no crew, a full galley, and a logbook written yesterday.',
    subgenre: 'survival', durationMin: 30, endings: 5, art: 'ship',
    source: 'original', likes: 9900, plays: 41000,
  },
  {
    id: 'blackwater',
    title: 'Blackwater',
    subtitle: 'The bell rings thirteen',
    logline: 'The villagers smile at you in perfect unison. The church bell rings at hours that do not exist.',
    subgenre: 'folk', durationMin: 22, endings: 3, art: 'village',
    source: 'original', likes: 14300, plays: 58000,
  },
  {
    id: 'room-at-the-end',
    title: 'The Room at the End',
    subtitle: 'Don’t count the doors',
    logline: 'Your new apartment’s hallway has seven doors. Tonight it has eight.',
    subgenre: 'psychological', durationMin: 12, endings: 2, art: 'hallway',
    source: 'community', author: 'mara.writes', likes: 21700, plays: 103000,
  },
  {
    id: 'lake-oread',
    title: 'Lake Oread',
    subtitle: 'Last summer at the cabin',
    logline: 'Six friends, one cabin, no signal. The masked figure on the dock was not there a moment ago.',
    subgenre: 'slasher', durationMin: 16, endings: 4, art: 'cabin',
    source: 'community', author: 'nightjar', likes: 19200, plays: 88000,
  },
  {
    id: 'the-eye-above',
    title: 'The Eye Above',
    subtitle: 'Something opened in the sky',
    logline: 'The observatory picked up a signal that repeats your name. Then the stars started to move.',
    subgenre: 'cosmic', durationMin: 28, endings: 5, art: 'cosmic',
    source: 'community', author: 'void_cartographer', likes: 16600, plays: 61000,
  },
  {
    id: 'lullaby',
    title: 'Lullaby for Clara',
    subtitle: 'She still sings at night',
    logline: 'The baby monitor in the empty nursery keeps picking up a little girl humming.',
    subgenre: 'ghost', durationMin: 10, endings: 2, art: 'hallway',
    source: 'community', author: 'quietharbor', likes: 24900, plays: 131000,
  },
  {
    id: 'harvest',
    title: 'The Harvest Queen',
    subtitle: 'You have been chosen',
    logline: 'The village crowned you at the festival. Nobody will tell you what happened to last year’s queen.',
    subgenre: 'cult', durationMin: 24, endings: 3, art: 'cult',
    source: 'community', author: 'ember.ink', likes: 11200, plays: 39000,
  },
  {
    id: 'father-aldous',
    title: 'Father Aldous',
    subtitle: 'The last exorcism of St. Brigid',
    logline: 'The priest asked you to hold the candle and never let it go out. It has been flickering for an hour.',
    subgenre: 'possession', durationMin: 26, endings: 4, art: 'possession',
    source: 'community', author: 'grimoire', likes: 13700, plays: 52000,
  },
  {
    id: 'wrenfield',
    title: 'Wrenfield Manor',
    subtitle: 'A portrait that blinks',
    logline: 'You are hired to restore the family portraits. Each one you clean shows a new face — yours.',
    subgenre: 'gothic', durationMin: 21, endings: 3, art: 'gothic',
    source: 'community', author: 'velvet.crypt', likes: 8800, plays: 27000,
  },
];

const byId = Object.fromEntries(stories.map((s) => [s.id, s])) as Record<string, Story>;
const pick = (...ids: string[]) => ids.map((id) => byId[id]);

export type RailKind = 'standard' | 'ranked' | 'continue';

export interface Rail {
  id: string;
  title: string;
  kind: RailKind;
  items: Story[];
}

export const featuredStory = byId['ashford-house'];

export const rails: Rail[] = [
  { id: 'continue', title: 'Continue Your Nightmare', kind: 'continue', items: stories.filter((s) => s.progress !== undefined) },
  { id: 'featured', title: 'Featured Tonight', kind: 'standard', items: pick('ashford-house', 'saint-veronica', 'blackwater', 'the-meridian', 'hollow-pines') },
  { id: 'trending', title: 'Trending Now', kind: 'ranked', items: pick('lullaby', 'room-at-the-end', 'lake-oread', 'ashford-house', 'the-eye-above', 'father-aldous') },
  { id: 'most-liked', title: 'Most Liked', kind: 'standard', items: [...stories].sort((a, b) => b.likes - a.likes).slice(0, 8) },
  { id: 'community', title: 'Listen to Community Stories', kind: 'standard', items: stories.filter((s) => s.source === 'community') },
  { id: 'short', title: 'Short Scares · Under 15 min', kind: 'standard', items: stories.filter((s) => s.durationMin < 15) },
  { id: 'many-endings', title: 'Many Paths, Many Endings', kind: 'standard', items: stories.filter((s) => s.endings >= 4) },
];

export function formatCount(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}
