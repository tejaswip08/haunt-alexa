// Ported from apps/tv/src/screens/CreateStoryScreen.tsx and
// services/story/StoryApi.ts. These choices become the server's start_story request.

export const SETTINGS = [
  'Surprise me',
  'Abandoned hospital',
  'Isolated cabin',
  'Old mansion',
  'Small town',
  'Ship at sea',
  'Deep woods',
  'City apartment',
] as const;

export const LENGTHS = [
  { id: 'short', label: 'Short', detail: 'About 10 min · 2 endings' },
  { id: 'standard', label: 'Standard', detail: 'About 20 min · 3 endings' },
  { id: 'epic', label: 'Epic', detail: 'Up to 30 min · 5 endings' },
] as const;

// Same three levels as the server's `intensity`. Never graphic at any level.
export const FEAR_LEVELS = [
  { id: 'eerie', label: 'Eerie', detail: 'Creepy and unsettling, gentle scares' },
  { id: 'scary', label: 'Scary', detail: 'Real danger, tense choices' },
  { id: 'terrifying', label: 'Terrifying', detail: 'Intense and relentless' },
] as const;

export const STORY_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी · Hindi' },
  { code: 'ta', label: 'தமிழ் · Tamil' },
  { code: 'te', label: 'తెలుగు · Telugu' },
  { code: 'kn', label: 'ಕನ್ನಡ · Kannada' },
  { code: 'ml', label: 'മലയാളം · Malayalam' },
  { code: 'mr', label: 'मराठी · Marathi' },
  { code: 'bn', label: 'বাংলা · Bengali' },
  { code: 'es', label: 'Español · Spanish' },
  { code: 'fr', label: 'Français · French' },
] as const;

export const IDEA_MAX_LENGTH = 200;

export interface StoryRequest {
  subgenreId: string;
  subgenreName: string;
  setting: string;
  length: string;
  fear: string;
  language: string;
  idea: string;
}
