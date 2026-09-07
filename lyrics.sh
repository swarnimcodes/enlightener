#!/usr/bin/env bash
# SPDX-License-Identifier: MIT

set -uo pipefail

player="${1:-spotify}"
lyrics_json=""
current_track_id=""

get_metadata() {
    local length_us

    title="$(playerctl --player="$player" metadata xesam:title 2>/dev/null)" ||
        return 1

    artist="$(playerctl --player="$player" metadata xesam:artist 2>/dev/null)" ||
        artist=""

    album="$(playerctl --player="$player" metadata xesam:album 2>/dev/null)" ||
        album=""

    track_id="$(playerctl --player="$player" metadata mpris:trackid 2>/dev/null)" ||
        track_id="$artist:$album:$title"

    length_us="$(playerctl --player="$player" metadata mpris:length 2>/dev/null)" ||
        length_us=0

    # MPRIS reports duration in microseconds; LRCLIB expects seconds.
    duration=$((length_us / 1000000))
}

fetch_lyrics() {
    local response

    # Try an exact match first.
    if response="$(
        curl --fail --silent -G 'https://lrclib.net/api/get' \
            -H 'User-Agent: enlightener/0.1' \
            --data-urlencode "track_name=$title" \
            --data-urlencode "artist_name=$artist" \
            --data-urlencode "album_name=$album" \
            --data-urlencode "duration=$duration"
    )"; then
        lyrics_json="$response"
        return 0
    fi

    printf 'Exact match not found; searching LRCLIB...\n' >&2

    if ! response="$(
        curl --fail --silent --show-error \
            -G 'https://lrclib.net/api/search' \
            -H 'User-Agent: enlightener/0.1' \
            --data-urlencode "track_name=$title" \
            --data-urlencode "artist_name=$artist"
    )"; then
        printf 'Failed to contact LRCLIB\n' >&2
        return 1
    fi

    # Prefer synchronized lyrics, then choose the closest duration.
    lyrics_json="$(
        jq --argjson target_duration "$duration" '
            sort_by([
                if .syncedLyrics != null then 0 else 1 end,
                (
                    (.duration - $target_duration)
                    | if . < 0 then 0 - . else . end
                )
            ])
            | first
        ' <<< "$response"
    )"

    if [[ -z "$lyrics_json" || "$lyrics_json" == "null" ]]; then
        printf 'No lyrics found for %s - %s\n' "$artist" "$title" >&2
        lyrics_json=""
        return 1
    fi
}

get_current_line() {
    local position

    position="$(playerctl --player="$player" position 2>/dev/null)" ||
        return 1

    jq -r --argjson position "$position" '
        (.syncedLyrics // "")
        | split("\n")
        | map(
            capture(
                "^\\[(?<minute>[0-9]+):(?<second>[0-9]+(?:\\.[0-9]+)?)\\]\\s*(?<text>.*)$"
            )?
            | .time = (
                (.minute | tonumber) * 60
                + (.second | tonumber)
            )
        )
        | map(select(.time <= $position))
        | last
        | .text // ""
    ' <<< "$lyrics_json"
}

if get_metadata && fetch_lyrics; then
    last_line=""

    while sleep 0.2; do
        line="$(get_current_line)" || continue

        if [[ "$line" != "$last_line" ]]; then
            printf '%s\n' "$line"
            last_line="$line"
        fi
    done
else
    printf 'Unable to get lyrics\n' >&2
    exit 1
fi
