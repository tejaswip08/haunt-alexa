// The loading state for a story list: a caption and placeholder cards with the same proportions as the real cards.
// Shown only for the first load. A refresh keeps the existing list on screen.

const CARD_COUNT = 3;

export function StoryListSkeleton({ caption = "Summoning your stories…", count = CARD_COUNT }: { caption?: string; count?: number }) {
  return (
    <div className="story-skeleton" role="status" aria-label={caption}>
      <p className="story-skeleton-caption">{caption}</p>
      <div className="story-skeleton-grid">
        {Array.from({ length: count }, (_, i) => (
          <div className="story-skeleton-card" key={i} style={{ animationDelay: `${Math.min(i, 5) * 110}ms` }} aria-hidden="true">
            <div className="story-skeleton-cover" />
            <div className="story-skeleton-line short" />
            <div className="story-skeleton-line title" />
            <div className="story-skeleton-line wide" />
          </div>
        ))}
      </div>
    </div>
  );
}
