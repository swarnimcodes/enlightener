// SPDX-License-Identifier: MIT

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {parseLyricsResponse} from './lyricsModel.js';

Gio._promisify(Soup.Session.prototype,
    'send_and_read_async', 'send_and_read_finish');

const MAX_CACHE_ENTRIES = 50;

function makeUrl(endpoint, parameters) {
    const query = Object.entries(parameters)
        .filter(([, value]) =>
            value !== '' && value !== null && value !== undefined)
        .map(([key, value]) =>
            `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');

    return `https://lrclib.net/api/${endpoint}?${query}`;
}

export class LyricsClient {
    constructor() {
        this._cache = new Map();
        this._session = new Soup.Session({timeout: 15});
    }

    getCached(cacheKey) {
        return this._cache.get(cacheKey) ?? null;
    }

    cache(cacheKey, document) {
        if (this._cache.size >= MAX_CACHE_ENTRIES) {
            const oldestKey = this._cache.keys().next().value;
            this._cache.delete(oldestKey);
        }
        this._cache.set(cacheKey, document);
    }

    abort() {
        this._session?.abort();
        this._session = null;
        this._cache.clear();
    }

    async fetch(track, cancellable) {
        let lyrics;
        const exactParameters = {
            track_name: track.title,
            artist_name: track.artist,
            album_name: track.album,
            duration: track.duration || null,
        };

        try {
            lyrics = await this._requestJson(
                makeUrl('get', exactParameters), cancellable);
        } catch (error) {
            if (this._isCancelled(error))
                throw error;
        }

        let document = parseLyricsResponse(lyrics);
        if (!document.instrumental && !document.lines.length) {
            const results = await this._requestJson(makeUrl('search', {
                track_name: track.title,
                artist_name: track.artist,
            }), cancellable);
            lyrics = this._bestSearchResult(results, track.duration);
            document = parseLyricsResponse(lyrics);
        }

        return document;
    }

    async _requestJson(url, cancellable) {
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('User-Agent', 'Enlightener/0.1');

        const bytes = await this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, cancellable);
        const status = message.get_status();

        if (status < 200 || status >= 300) {
            const error = new Error(`LRCLIB returned HTTP ${status}`);
            error.status = status;
            throw error;
        }

        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }

    _bestSearchResult(results, targetDuration) {
        if (!Array.isArray(results) || !results.length)
            return null;

        return results.toSorted((a, b) => {
            const qualityDifference = this._lyricsQuality(a) -
                this._lyricsQuality(b);
            if (qualityDifference)
                return qualityDifference;

            return Math.abs(Number(a.duration) - targetDuration) -
                Math.abs(Number(b.duration) - targetDuration);
        })[0];
    }

    _lyricsQuality(response) {
        const document = parseLyricsResponse(response);
        if (document.lines.some(line => line.words.length))
            return 0;
        if (document.lines.length)
            return 1;
        if (document.instrumental)
            return 2;
        return 3;
    }

    _isCancelled(error) {
        return error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ??
            false;
    }
}
