// SPDX-License-Identifier: MIT

import {
    getActiveWordIndex,
    getPlaybackFrame,
    parseLrc,
    parseLyricsResponse,
    parseLyricsfile,
} from '../extension/lyricsModel.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const wordSynced = `version: '1.0'
metadata:
  title: Still Alive
  artist: Aperture Science
  duration_ms: 10000
  instrumental: false
lines:
  - text: "This was a triumph."
    start_ms: 290
    end_ms: 3840
    words:
      - text: "This "
        start_ms: 290
      - text: "was "
        start_ms: 536
      - text: "a "
        start_ms: 784
      - text: triumph.
        start_ms: 923
`;

const wordDocument = parseLyricsfile(wordSynced);
assert(wordDocument.lines[0].words.length === 4,
    'word timing should be preserved');
assert(wordDocument.lines[0].words[0].endMs === 536,
    'a missing word end should use the next word start');
assert(getActiveWordIndex(wordDocument.lines[0], 600) === 1,
    'the active word should follow playback time');

const overlapDocument = parseLyricsfile(`version: '1.0'
metadata:
  title: Two Voices
  artist: Example Duo
  instrumental: false
lines:
  - text: First voice
    start_ms: 10000
    end_ms: 15000
  - text: Second voice
    start_ms: 12000
    end_ms: 16000
`);
assert(getPlaybackFrame(overlapDocument, 13000, 1).activeLines.length === 2,
    'overlapping vocal lines should both be active');

const musicDocument = parseLyricsfile(`version: '1.0'
metadata:
  title: With Interlude
  artist: Example
  instrumental: false
lines:
  - text: Before
    start_ms: 1000
    end_ms: 2000
  - text: ''
    start_ms: 2000
    end_ms: 5000
  - text: After
    start_ms: 5000
    end_ms: 6000
`);
const musicFrame = getPlaybackFrame(musicDocument, 3000, 1);
assert(musicFrame.music, 'blank timed lines should produce a music frame');
assert(musicFrame.rows[1].kind === 'music',
    'the music symbol should sit between surrounding context');

const instrumental = parseLyricsResponse({
    instrumental: true,
    duration: 240,
    lyricsfile: `version: '1.0'
metadata:
  title: Quiet Transit
  artist: Example Ensemble
  duration_ms: 240000
  instrumental: true
`,
});
assert(instrumental.instrumental, 'whole-track instrumentals should be explicit');
assert(getPlaybackFrame(instrumental, 3000, 2).rows[0].kind === 'music',
    'instrumentals should render the music symbol');

const fallback = parseLyricsResponse({
    duration: 10,
    lyricsfile: 'version: broken',
    syncedLyrics: '[00:01.25]Fallback line',
});
assert(fallback.source === 'lrc' && fallback.lines[0].startMs === 1250,
    'invalid Lyricsfile should fall back to LRC');

const lrc = parseLrc('[00:01]One\n[00:02:5][00:03.25]Repeated', 5000);
assert(lrc.lines.length === 3 && lrc.lines[1].startMs === 2500,
    'LRC timestamps and repeated timestamps should be supported');

let rejectedUnknownVersion = false;
try {
    parseLyricsfile(`version: '2.0'\nmetadata: {title: A, artist: B}`);
} catch {
    rejectedUnknownVersion = true;
}
assert(rejectedUnknownVersion, 'unknown Lyricsfile versions should be rejected');

let rejectedAlias = false;
try {
    parseLyricsfile(`version: '1.0'
metadata: &metadata
  title: A
  artist: B
lines:
  - text: Alias
    start_ms: 0
    extra: *metadata
`);
} catch {
    rejectedAlias = true;
}
assert(rejectedAlias, 'YAML aliases should be rejected');

const mismatchedWords = parseLyricsfile(`version: '1.0'
metadata:
  title: A
  artist: B
lines:
  - text: Complete line
    start_ms: 0
    words:
      - text: Different
        start_ms: 0
`);
assert(mismatchedWords.lines[0].words.length === 0,
    'inconsistent word text should fall back to the complete line');

print('lyricsModel tests passed');
