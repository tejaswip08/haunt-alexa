import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { storedMode } from '../src/me-library.ts';

describe('the mode a Continue Watching entry resumes in', () => {
  it('keeps a choices run as choices', () => {
    assert.equal(storedMode('choices'), 'choices');
  });

  it('keeps a listen run as listen', () => {
    assert.equal(storedMode('listen'), 'listen');
  });

  it('does not borrow the remembered play mode for progress saved without one', () => {
    // Regression: the remembered "choices" preference was attached to an older linear record, which then opened
    // "How do you want to play?" and restarted the story.
    assert.equal(storedMode(undefined), null);
    assert.equal(storedMode(null), null);
  });
});
