/** The Haunt mark (ghost) and wordmark. Same drawing as assets/brand and the favicon. */
export function Logo({ size = 28, wordmark = true, className }: { size?: number; wordmark?: boolean; className?: string }) {
  return (
    <span className={`logo${className ? ` ${className}` : ""}`}>
      <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden>
        <circle cx="32" cy="31" r="22" fill="var(--accent)" opacity="0.18" />
        <path
          d="M32 12c-9.4 0-16 7-16 16.5V50l5.3-4 5.4 4 5.3-4 5.3 4 5.4-4L48 50V28.5C48 19 41.4 12 32 12z"
          fill="var(--ink)"
        />
        <circle cx="26" cy="29" r="3.2" fill="var(--bg)" />
        <circle cx="38" cy="29" r="3.2" fill="var(--bg)" />
        <ellipse cx="32" cy="39" rx="2.8" ry="3.8" fill="var(--bg)" />
      </svg>
      {wordmark && <span className="wordmark">Haunt</span>}
    </span>
  );
}
