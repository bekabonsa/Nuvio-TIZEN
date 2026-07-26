# NuvioTizen

`NuvioTizen` is a Samsung Tizen TV web app prototype for a Nuvio-branded streaming shell. It is a single-page TV interface built with plain HTML, CSS, and JavaScript and packaged as a Tizen widget (`.wgt`).

The app includes:

- Nuvio account login with direct credentials and QR-based TV pairing
- Home spotlight rotation and browse rails
- Movie and series catalog browsing
- Search with an on-screen keyboard
- Detail, season, episode, and source selection flows
- Playback controls with audio and subtitle switching
- Tizen packaging through `config.xml`

## Project Layout

- [`index.html`](index.html): app shell and all view markup
- [`css/style.css`](css/style.css): TV layout, navigation, player, login, and spotlight styling
- [`js/config-state.js`](js/config-state.js): constants, shared state, caches, and typedefs
- [`js/platform-dom.js`](js/platform-dom.js): DOM helpers, request scheduling, storage normalization, and small shared utilities
- [`js/player.js`](js/player.js): playback metrics, tracks, subtitles, AVPlay/HTML5 player control, and player chrome
- [`js/navigation-focus.js`](js/navigation-focus.js): views, TV focus registry, remote navigation, home spotlight, and browse return state
- [`js/catalogs-addons.js`](js/catalogs-addons.js): addon/catalog option modeling, catalog URL building, browse paging, request helpers, and prefetch
- [`js/auth-sync.js`](js/auth-sync.js): Nuvio/Supabase auth, QR login, synced watch/library data, addon loading, and browse rendering glue
- [`js/detail-streams.js`](js/detail-streams.js): detail pages, seasons/episodes, streams, stream loading, and selection flow
- [`js/search-rendering.js`](js/search-rendering.js): search keyboard/results and shared card/rail rendering
- [`js/main.js`](js/main.js): app bootstrap, bindings, and TV key input handling
- [`config.xml`](config.xml): Tizen widget manifest and privileges
- [`images/`](images): logos and app icons
- [`NuvioTizen.wgt`](NuvioTizen.wgt): packaged widget artifact when built

## Requirements

- Samsung Tizen Studio installed
- A valid Samsung certificate profile for packaging
- Network access from the TV or emulator

This repo does not use a Node build system. The runtime app is plain static web assets, and packaging is handled by Tizen Studio.

## Build and Install

Syntax check:

```sh
for f in js/*.js; do node --check "$f"; done
```

Pure logic tests:

```sh
node tests/pure.test.js
```

Optional local browser smoke test:

```sh
node tests/browser-smoke.js
```

Set local Tizen CLI variables. Replace the placeholders with values from your own Tizen Studio setup:

```sh
set -euo pipefail

cd /path/to/StremioTest

TIZEN="${TIZEN_STUDIO_HOME:-$HOME/tizen-studio}/tools/ide/bin/tizen"
SDB="${TIZEN_STUDIO_HOME:-$HOME/tizen-studio}/tools/sdb"
TARGET="<target-name-from-sdb-devices>"
PROFILE="<security-profile-name>"
APP_ID="VtffsKLoty.NuvioTizen"
EXCLUDES=(
    ".git/*" ".git"
    ".cache/*" ".cache"
    ".metadata/*" ".metadata"
    ".vscode/*" ".vscode"
    ".gitignore"
    "tests/*" "tests"
    "scripts/*" "scripts"
    "README.md" "install_commands.txt"
)
EXCLUDE_ARGS=()
for pattern in "${EXCLUDES[@]}"; do
    EXCLUDE_ARGS+=("-e" "$pattern")
done
```

Find connected targets and available signing profiles:

```sh
"$SDB" devices
"$TIZEN" security-profiles list
```

Build, package, install, and launch the app:

```sh
rm -rf .buildResult

"$TIZEN" build-web "${EXCLUDE_ARGS[@]}" -- "$(pwd)"
"$TIZEN" package -t wgt -s "$PROFILE" -- ./.buildResult

WGT="$(ls -t .buildResult/*.wgt | head -1)"

unzip -p "$WGT" index.html | grep -q "detailCastSection"
if unzip -l "$WGT" | grep -E '(^|[[:space:]])(\.git|\.cache)(/|$)'; then
    echo "Refusing to install: WGT still contains .git or .cache files." >&2
    exit 1
fi

"$TIZEN" install -n "$(basename "$WGT")" -t "$TARGET" -- "$(dirname "$WGT")"
"$TIZEN" run -p "$APP_ID" -t "$TARGET"
```

If the target is not listed, reconnect it with the TV IP/port shown by Tizen Studio or Device Manager:

```sh
"$SDB" connect <tv-ip>:26101
```

If installation fails because the device is not permitted for the certificate, run:

```sh
"$TIZEN" install-permit -t "$TARGET"
```

The `run` command must use the full application ID from [`config.xml`](config.xml), not only the package ID.

## DTS Audio Transcode Helper

Samsung TV playback may hide DTS/DTS-HD audio tracks from AVPlay. To play a non-commentary DTS track on those TVs, run the optional helper on a machine that the TV can reach. The helper probes the original stream, chooses a DTS audio stream while avoiding commentary-labeled tracks, copies the video, and transcodes that audio to AC3.

Requirements:

- `ffmpeg` and `ffprobe` available in `PATH`
- The TV can reach the helper machine over the local network

Start the helper:

```sh
node scripts/audio-transcoder.js
```

Point the TV app at the helper by setting [`AUDIO_TRANSCODER_BASE_URL`](js/config-state.js) before packaging:

```js
var AUDIO_TRANSCODER_BASE_URL = 'http://<helper-host-ip>:8787';
```

Then rebuild, install, and launch the app. When a detected DTS/DTS-HD audio chip is selected, the app asks the helper for a stream where that DTS track is converted to AC3 and opens that returned stream in AVPlay.

## IMDb Catalog Helper

IMDb rating filters use a local helper instead of Cinemeta's sparse `imdbRating` catalog. The helper downloads IMDb's non-commercial datasets for fast candidate ordering, verifies displayed result details through `https://api.imdbapi.dev`, and exposes rating/year/genre catalog endpoints to the TV app.

Requirements:

- The TV can reach the helper machine over the local network
- Enough disk space for IMDb dataset downloads and the generated cache
- IMDb dataset use must comply with IMDb's non-commercial dataset terms

Start the helper:

```sh
node scripts/imdb-catalog-api.js
```

Point the TV app at the helper by setting [`IMDB_CATALOG_API_BASE_URL`](js/config-state.js) before packaging:

```js
var IMDB_CATALOG_API_BASE_URL = 'http://<helper-host-ip>:8791';
```

The first start can take a while because it downloads and indexes `title.basics.tsv.gz` and `title.ratings.tsv.gz`. IMDb API title details are cached as rating-filter pages are requested, and Load More continues paging through the helper.

The helper defaults are tuned to avoid inflated low-vote ratings:

```sh
IMDB_MIN_VOTES=10000 IMDB_WEIGHTED_VOTE_ANCHOR=25000 node scripts/imdb-catalog-api.js
```

- `IMDB_MIN_VOTES` removes titles with too few votes from rating-filter results.
- `IMDB_WEIGHTED_VOTE_ANCHOR` controls how strongly low-vote ratings are pulled toward the global mean before sorting.
- `IMDB_WEIGHTED_MEAN_RATING` defaults to `6.8`.
- `IMDB_API_BASE_URL` defaults to `https://api.imdbapi.dev`.
- `IMDB_API_EXCLUDED_COUNTRY_CODES` defaults to `IN` for the IMDb-rating catalog helper.
- `IMDB_API_BATCH_CONCURRENCY` defaults to `1` to avoid public API rate limits.
- `IMDB_ENRICH_ARTWORK=1` fetches Cinemeta metadata for exact artwork, but it makes uncached catalog queries slower. Leave it off for faster browsing.

Changing these settings automatically rebuilds the generated IMDb index.

The Films page also exposes a `Blockbuster` catalog through the same helper:

- With `TMDB_READ_ACCESS_TOKEN` or `TMDB_API_KEY`, `Blockbuster` uses TMDb Discover sorted by `revenue.desc`, keeps a minimum TMDb vote count, and maps results back to IMDb IDs for playback.
- Without TMDb credentials, `Blockbuster` falls back to IMDb dataset vote-count ordering, so the tab still works but is not true revenue-ranked box office data.
- `TMDB_BLOCKBUSTER_MIN_VOTES` defaults to `500`.

Example:

```sh
TMDB_READ_ACCESS_TOKEN='<tmdb-read-access-token>' node scripts/imdb-catalog-api.js
```

Trailer playback uses TMDb videos when TMDb is configured and falls back to Cinemeta trailer metadata when it is not. The app loads trailers through the helper's `/trailer-player` wrapper so Tizen has an HTTP page/referrer for YouTube embeds.

## Oracle Auth and Sync Backend

The Python bridge can also replace the Supabase auth/sync surface used by the TV app. It exposes compatible endpoints for email/password login, token refresh, current user lookup, TV QR login pairing, addon URL reads, watch progress sync, and library sync. Data is stored in SQLite at `NUVIO_AUTH_DB_PATH`, which defaults to `METADATA_ROOT/nuvio-auth.sqlite3`.

Start the bridge with a bootstrap account:

```sh
BRIDGE_TOKEN='<private-bridge-token>' \
NUVIO_AUTH_EMAIL='you@example.com' \
NUVIO_AUTH_PASSWORD='<account-password>' \
NUVIO_ADDON_URLS='https://v3-cinemeta.strem.io,https://opensubtitles-v3.strem.io' \
python3 scripts/nuvio-bridge-server.py
```

Point the TV app at the Oracle bridge in `js/local-config.js` before packaging:

```js
var NUVIO_AUTH_BASE_URL = 'https://<your-oracle-domain>';
var TV_LOGIN_REDIRECT_BASE_URL = NUVIO_AUTH_BASE_URL + '/tv-login';
```

Use HTTPS for the public Oracle host before entering account passwords from the TV or phone. The bridge stores password hashes with PBKDF2 and stores session tokens hashed in SQLite, but HTTP still exposes credentials in transit.

This does not automatically copy old Supabase data. Export/import existing `addons`, watch progress, and library rows separately if you need historical data preserved.

The QR approval page and exchange are served by the Oracle bridge. The TV app still uses its existing external QR image fallback unless the backend is extended to return a local `qr_image_url`.

## Runtime Notes

- The app is configured as a Tizen TV widget in [`config.xml`](config.xml).
- Main remote-navigation behavior is implemented in [`js/navigation-focus.js`](js/navigation-focus.js) and wired in [`js/main.js`](js/main.js).
- Spotlight, browse rails, login, and player UI are styled in [`css/style.css`](css/style.css).
- Auth and sync use [`NUVIO_AUTH_BASE_URL`](js/config-state.js), which defaults to the old Supabase project and can be overridden in `js/local-config.js`.

## Current Output

The packaged build artifact is expected at:

- [`NuvioTizen.wgt`](NuvioTizen.wgt)
