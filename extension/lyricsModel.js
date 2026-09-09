// SPDX-License-Identifier: MIT

import { parse as parseYaml } from './vendor/yaml/dist/public-api.js';

const LYRICSFILE_VERSION = '1.0';
const MAX_LYRICSFILE_LENGTH = 1_000_000;
const DEFAULT_FINAL_LINE_DURATION_MS = 5_000;

function requireTimestamp(value, field) {
    if (!Number.isInteger(value) || value < 0)
        throw new Error(`${field} must be a non-negative integer`);

    return value;
}

function optionalEndTimestamp(value, startMs, field) {
    if (value === undefined || value === null)
        return null;

    const endMs = requireTimestamp(value, field);
    if (endMs < startMs)
        throw new Error(`${field} must not precede its start timestamp`);

    return endMs;
}

function nextLaterStart(items, index) {
    const startMs = items[index].startMs;
    for (let next = index + 1; next < items.length; next++) {
        if (items[next].startMs > startMs)
            return items[next].startMs;
    }

    return null;
}

function inferEnds(lines, durationMs) {
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        line.endMs ??= nextLaterStart(lines, index) ??
            (durationMs > line.startMs
                ? durationMs
                : line.startMs + DEFAULT_FINAL_LINE_DURATION_MS);

        for (let wordIndex = 0; wordIndex < line.words.length; wordIndex++) {
            const word = line.words[wordIndex];
            word.endMs ??= nextLaterStart(line.words, wordIndex) ?? line.endMs;
        }
    }

    return lines;
}

function normalizeLyricsfileLine(rawLine, sourceIndex) {
    if (!rawLine || typeof rawLine !== 'object' || Array.isArray(rawLine))
        throw new Error('Every Lyricsfile line must be a mapping');
    if (typeof rawLine.text !== 'string')
        throw new Error('Every Lyricsfile line must contain text');

    const startMs = requireTimestamp(rawLine.start_ms, 'line.start_ms');
    const line = {
        text: rawLine.text,
        startMs,
        endMs: optionalEndTimestamp(rawLine.end_ms, startMs, 'line.end_ms'),
        words: [],
        sourceIndex,
    };

    if (rawLine.words === undefined || rawLine.words === null)
        return line;
    if (!Array.isArray(rawLine.words))
        throw new Error('line.words must be a sequence');

    line.words = rawLine.words.map((rawWord, wordIndex) => {
        if (!rawWord || typeof rawWord !== 'object' || Array.isArray(rawWord) ||
            typeof rawWord.text !== 'string')
            throw new Error('Every synchronized word must contain text');

        const wordStartMs = requireTimestamp(
            rawWord.start_ms, 'word.start_ms');
        return {
            text: rawWord.text,
            startMs: wordStartMs,
            endMs: optionalEndTimestamp(
                rawWord.end_ms, wordStartMs, 'word.end_ms'),
            sourceIndex: wordIndex,
        };
    }).sort((a, b) => a.startMs - b.startMs ||
        a.sourceIndex - b.sourceIndex);

    if (line.words.map(word => word.text).join('') !== line.text)
        line.words = [];

    return line;
}

export function parseLyricsfile(source) {
    if (typeof source !== 'string' || !source.trim())
        throw new Error('Lyricsfile is empty');
    if (source.length > MAX_LYRICSFILE_LENGTH)
        throw new Error('Lyricsfile exceeds the supported size');

    const rawDocument = parseYaml(source, {
        schema: 'core',
        uniqueKeys: true,
        maxAliasCount: 0,
        prettyErrors: false,
    });

    if (!rawDocument || typeof rawDocument !== 'object' ||
        Array.isArray(rawDocument))
        throw new Error('Lyricsfile root must be a mapping');
    if (rawDocument.version !== LYRICSFILE_VERSION)
        throw new Error(`Unsupported Lyricsfile version: ${rawDocument.version}`);

    const metadata = rawDocument.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        throw new Error('Lyricsfile metadata must be a mapping');

    const durationMs = metadata.duration_ms === undefined ||
        metadata.duration_ms === null
        ? 0
        : requireTimestamp(metadata.duration_ms, 'metadata.duration_ms');
    const instrumental = metadata.instrumental === true;

    if (instrumental) {
        return {
            source: 'lyricsfile',
            instrumental: true,
            durationMs,
            lines: [],
        };
    }

    if (rawDocument.lines !== undefined && !Array.isArray(rawDocument.lines))
        throw new Error('Lyricsfile lines must be a sequence');

    const lines = (rawDocument.lines ?? [])
        .map(normalizeLyricsfileLine)
        .sort((a, b) => a.startMs - b.startMs ||
            a.sourceIndex - b.sourceIndex);

    return {
        source: 'lyricsfile',
        instrumental: false,
        durationMs,
        lines: inferEnds(lines, durationMs),
    };
}

function timestampFromMatch(match) {
    const fraction = match[3] ?? '';
    const fractionMs = fraction
        ? Number(fraction) * 10 ** (3 - fraction.length)
        : 0;

    return Number(match[1]) * 60_000 + Number(match[2]) * 1_000 + fractionMs;
}

export function parseLrc(source, durationMs = 0) {
    if (typeof source !== 'string' || !source.trim()) {
        return {
            source: 'none',
            instrumental: false,
            durationMs,
            lines: [],
        };
    }

    const lines = [];
    const timestampPattern = /^\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/;

    for (const rawLine of source.replaceAll('\r\n', '\n').split('\n')) {
        let remainder = rawLine.trim();
        const timestamps = [];
        let match;

        while ((match = timestampPattern.exec(remainder)) !== null) {
            timestamps.push(timestampFromMatch(match));
            remainder = remainder.slice(match[0].length);
        }

        for (const startMs of timestamps) {
            lines.push({
                text: remainder.trimStart(),
                startMs,
                endMs: null,
                words: [],
                sourceIndex: lines.length,
            });
        }
    }

    lines.sort((a, b) => a.startMs - b.startMs ||
        a.sourceIndex - b.sourceIndex);

    return {
        source: lines.length ? 'lrc' : 'none',
        instrumental: false,
        durationMs,
        lines: inferEnds(lines, durationMs),
    };
}

export function parseLyricsResponse(response) {
    const durationMs = Math.max(0, Math.round(Number(response?.duration) * 1_000) || 0);

    if (response?.lyricsfile) {
        try {
            const document = parseLyricsfile(response.lyricsfile);
            if (document.instrumental || document.lines.length)
                return document;
        } catch {
            // The legacy representation remains a safe compatibility fallback.
        }
    }

    if (response?.instrumental === true) {
        return {
            source: 'legacy',
            instrumental: true,
            durationMs,
            lines: [],
        };
    }

    return parseLrc(response?.syncedLyrics, durationMs);
}

function nonEmptyIndexes(lines) {
    const indexes = [];
    for (let index = 0; index < lines.length; index++) {
        if (lines[index].text.trim())
            indexes.push(index);
    }
    return indexes;
}

export function getPlaybackFrame(document, positionMs, contextLength) {
    if (document.instrumental) {
        return {
            rows: [{ kind: 'music' }],
            activeLines: [],
            music: true,
        };
    }

    const lines = document.lines;
    const activeIndexes = [];
    let blankActive = false;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.startMs <= positionMs && positionMs < line.endMs) {
            if (line.text.trim())
                activeIndexes.push(index);
            else
                blankActive = true;
        }
    }

    const lyricIndexes = nonEmptyIndexes(lines);
    const previous = lyricIndexes.filter(index => lines[index].endMs <= positionMs);
    const upcoming = lyricIndexes.filter(index => lines[index].startMs > positionMs);
    const context = Math.max(0, contextLength);
    let before;
    let after;

    if (activeIndexes.length) {
        const firstActive = Math.min(...activeIndexes);
        const lastActive = Math.max(...activeIndexes);
        before = lyricIndexes.filter(index => index < firstActive).slice(-context);
        after = lyricIndexes.filter(index => index > lastActive).slice(0, context);
    } else {
        before = previous.slice(-context);
        after = upcoming.slice(0, context);
    }

    const betweenLyrics = !activeIndexes.length && lines.length > 0;
    const music = blankActive || betweenLyrics;
    const rows = [
        ...before.map(index => ({ kind: 'context', line: lines[index], index })),
        ...activeIndexes.map(index => ({ kind: 'active', line: lines[index], index })),
        ...(music ? [{ kind: 'music' }] : []),
        ...after.map(index => ({ kind: 'context', line: lines[index], index })),
    ];

    return {
        rows,
        activeLines: activeIndexes.map(index => lines[index]),
        music,
    };
}

export function getActiveWordIndex(line, positionMs) {
    let activeIndex = -1;

    for (let index = 0; index < line.words.length; index++) {
        const word = line.words[index];
        if (word.startMs <= positionMs && positionMs < word.endMs)
            activeIndex = index;
    }

    return activeIndex;
}
