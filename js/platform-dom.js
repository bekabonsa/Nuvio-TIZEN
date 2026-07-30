function byId(id) {
    return document.getElementById(id);
}

function queryAll(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
}

function getRequestBucketState(bucket) {
    var key = bucket || 'default';

    if (!requestSchedulerState[key]) {
        requestSchedulerState[key] = {
            active: 0,
            queue: []
        };
    }

    return requestSchedulerState[key];
}

function pumpRequestBucket(bucket) {
    var key = bucket || 'default';
    var bucketState = getRequestBucketState(key);
    var limit = REQUEST_CONCURRENCY_LIMITS[key] || REQUEST_CONCURRENCY_LIMITS.default;
    var next;

    if (bucketState.active >= limit || !bucketState.queue.length) {
        return;
    }

    next = bucketState.queue.shift();
    bucketState.active += 1;

    Promise.resolve().then(next.task).then(function(result) {
        bucketState.active -= 1;
        next.resolve(result);
        pumpRequestBucket(key);
    }).catch(function(error) {
        bucketState.active -= 1;
        next.reject(error);
        pumpRequestBucket(key);
    });
}

function scheduleRequest(bucket, task) {
    return new Promise(function(resolve, reject) {
        var bucketState = getRequestBucketState(bucket);

        bucketState.queue.push({
            task: task,
            resolve: resolve,
            reject: reject
        });
        pumpRequestBucket(bucket);
    });
}

function isAvplayDebugEnabled() {
    return FORCE_AVPLAY_DEBUG || (window.location && window.location.search && window.location.search.indexOf('debugAvplay=1') !== -1);
}

function roundMetric(value) {
    if (typeof value !== 'number' || !isFinite(value)) {
        return value;
    }
    return Math.round(value * 100) / 100;
}

function getDebugRect(rect) {
    if (!rect) {
        return null;
    }
    return {
        left: roundMetric(rect.left),
        top: roundMetric(rect.top),
        width: roundMetric(rect.width),
        height: roundMetric(rect.height),
        right: roundMetric(rect.right),
        bottom: roundMetric(rect.bottom)
    };
}

function createAvplayDebugOverlay() {
    var overlay;

    if (!state.debugAvplay || state.debugAvplayOverlay) {
        return;
    }

    overlay = document.createElement('pre');
    overlay.id = 'avplayDebugOverlay';
    overlay.style.position = 'fixed';
    overlay.style.left = '18px';
    overlay.style.right = 'auto';
    overlay.style.top = '18px';
    overlay.style.bottom = 'auto';
    overlay.style.zIndex = '99999';
    overlay.style.maxWidth = '560px';
    overlay.style.maxHeight = '440px';
    overlay.style.margin = '0';
    overlay.style.padding = '18px';
    overlay.style.overflow = 'hidden';
    overlay.style.whiteSpace = 'pre-wrap';
    overlay.style.pointerEvents = 'none';
    overlay.style.background = 'rgba(0, 0, 0, 0.82)';
    overlay.style.color = '#fff';
    overlay.style.border = '2px solid rgba(255, 255, 255, 0.55)';
    overlay.style.font = '18px/1.22 monospace';
    document.body.appendChild(overlay);
    state.debugAvplayOverlay = overlay;
}

function renderAvplayDebugOverlay(metrics) {
    if (!state.debugAvplay) {
        return;
    }

    createAvplayDebugOverlay();
    state.lastAvplayDebugMetrics = metrics;
    window.__nuvioAvplayDebug = metrics;

    if (state.debugAvplayOverlay) {
        state.debugAvplayOverlay.textContent = JSON.stringify(metrics, null, 2);
    }

    if (window.console && typeof window.console.log === 'function') {
        window.console.log('NUVIO_AVPLAY_DEBUG', JSON.stringify(metrics));
    }
}

function clearFeaturedTransitionTimer() {
    if (!state.featuredTransitionTimer) {
        return;
    }
    clearTimeout(state.featuredTransitionTimer);
    state.featuredTransitionTimer = null;
}

function preloadFeaturedArtwork(url) {
    var src = String(url || '').trim();
    if (!src) {
        return Promise.resolve(null);
    }
    return new Promise(function(resolve, reject) {
        var image = new Image();
        var settled = false;

        function finish(error) {
            if (settled) {
                return;
            }
            settled = true;
            image.onload = null;
            image.onerror = null;
            if (error) {
                reject(error);
                return;
            }
            resolve(image);
        }

        function finalize() {
            if (typeof image.decode === 'function') {
                image.decode().then(function() {
                    finish();
                }).catch(function() {
                    finish();
                });
                return;
            }
            finish();
        }

        image.decoding = 'async';
        image.loading = 'eager';
        image.onload = finalize;
        image.onerror = function() {
            finish(new Error('Failed to preload featured artwork.'));
        };
        image.src = src;

        if (image.complete) {
            if (image.naturalWidth > 0 || image.naturalHeight > 0) {
                finalize();
            } else {
                finish(new Error('Failed to preload featured artwork.'));
            }
        }
    });
}

function rememberPreloadedArtwork(src, promise) {
    artworkPreloadCache[src] = promise;
    artworkPreloadOrder.push(src);

    while (artworkPreloadOrder.length > ARTWORK_PRELOAD_LIMIT) {
        delete artworkPreloadCache[artworkPreloadOrder.shift()];
    }
}

function warmArtworkUrl(url) {
    var src = String(url || '').trim();

    if (!src || artworkPreloadCache[src]) {
        return;
    }

    rememberPreloadedArtwork(src, preloadFeaturedArtwork(src).catch(function() {
        return null;
    }));
}

function getHomeRailArtworkUrl(entry) {
    if (!entry || !entry.item) {
        return '';
    }
    return entry.item.background || entry.item.poster || '';
}

function warmHomeRailArtwork(entries, startIndex, count) {
    getCircularHomeWindow(entries, startIndex, count).forEach(function(entry) {
        warmArtworkUrl(getHomeRailArtworkUrl(entry));
    });
}

function warmEpisodeArtwork(videos, startIndex, count) {
    var items = videos || [];
    var safeStart = Math.max(startIndex || 0, 0);
    var safeCount = Math.max(count || 0, 0);
    var index;

    for (index = safeStart; index < Math.min(items.length, safeStart + safeCount); index += 1) {
        warmArtworkUrl(getVideoThumbnail(items[index]));
    }
}

function isVisibleControl(element) {
    return !!(
        element
        && !element.disabled
        && element.style.display !== 'none'
        && element.getClientRects
        && element.getClientRects().length
    );
}

function updateConnectionStatus(text, ok, isError) {
    var el = byId('connectionStatus');
    if (!el) {
        return;
    }
    el.textContent = text;
    el.className = 'status-pill';
    if (ok) {
        el.classList.add('is-ok');
    }
    if (isError) {
        el.classList.add('is-error');
    }
}

function updateSessionStatus(text, ok, isError) {
    var el = byId('sessionStatus');
    if (!el) {
        return;
    }
    el.textContent = text;
    el.className = 'status-pill';
    if (ok) {
        el.classList.add('is-ok');
    }
    if (isError) {
        el.classList.add('is-error');
    }
}

function setLoginMessage(text, tone) {
    var el = byId('loginMessage');
    el.textContent = text;
    el.className = 'helper';
    if (tone === 'error') {
        el.classList.add('is-error');
    } else if (tone === 'success') {
        el.classList.add('is-success');
    }
}

function setQrLoginMessage(text, tone) {
    var el = byId('qrLoginMessage');
    if (!el) {
        return;
    }
    el.textContent = text;
    el.className = 'helper';
    if (tone === 'error') {
        el.classList.add('is-error');
    } else if (tone === 'success') {
        el.classList.add('is-success');
    }
}

function setAddonsMessage(text, tone) {
    var el = byId('addonsMessage');
    el.textContent = text;
    el.className = 'helper';
    if (tone === 'error') {
        el.classList.add('is-error');
    } else if (tone === 'success') {
        el.classList.add('is-success');
    }
}

function setSearchMessage(text, tone) {
    var el = byId('searchMessage');
    el.textContent = text;
    el.className = 'helper';
    if (tone === 'error') {
        el.classList.add('is-error');
    } else if (tone === 'success') {
        el.classList.add('is-success');
    }
}

function setPlayerStatus(text) {
    byId('playerStatus').textContent = text;
}

function uniqueList(items) {
    var seen = {};
    var output = [];

    items.forEach(function(item) {
        if (!item || seen[item]) {
            return;
        }
        seen[item] = true;
        output.push(item);
    });

    return output;
}

function maskToken(value) {
    var token = String(value || '').trim();

    if (!token) {
        return 'Not set';
    }
    if (token.length <= 20) {
        return token;
    }

    return token.slice(0, 10) + '…' + token.slice(-8);
}

function normalizeAddonType(type) {
    var normalized = String(type || '').toLowerCase();

    if (normalized === 'tv') {
        return 'series';
    }

    return normalized;
}

function getCompatibleTypes(type) {
    var normalized = normalizeAddonType(type);

    if (normalized === 'series') {
        return ['series', 'tv'];
    }

    return normalized ? [normalized] : [];
}

function getResourceName(resource) {
    if (typeof resource === 'string') {
        return resource;
    }

    return resource && resource.name ? resource.name : '';
}

function getResourceTypes(resource) {
    if (typeof resource === 'string') {
        return [];
    }

    return resource && Array.isArray(resource.types)
        ? resource.types.map(function(value) {
            return normalizeAddonType(value);
        }).filter(Boolean)
        : [];
}

function getResourceIdPrefixes(resource) {
    if (typeof resource === 'string') {
        return [];
    }

    return resource && Array.isArray(resource.idPrefixes)
        ? resource.idPrefixes.filter(Boolean)
        : [];
}

function addonSupportsResource(addon, resourceNames, type, id) {
    var resources = addon && addon.manifest && addon.manifest.resources;
    var compatibleTypes = getCompatibleTypes(type);

    if (!resources || !resources.length) {
        return false;
    }

    return resources.some(function(resource) {
        var resourceName = String(getResourceName(resource) || '').toLowerCase();
        var resourceTypes = getResourceTypes(resource);
        var idPrefixes = getResourceIdPrefixes(resource);

        if (resourceNames.indexOf(resourceName) === -1) {
            return false;
        }
        if (compatibleTypes.length && resourceTypes.length) {
            return compatibleTypes.some(function(candidate) {
                return resourceTypes.indexOf(candidate) !== -1;
            });
        }
        if (idPrefixes.length && id) {
            return idPrefixes.some(function(prefix) {
                return String(id).indexOf(prefix) === 0;
            });
        }

        return true;
    });
}

function updateUserPanel() {
    var email = state.user && state.user.email ? state.user.email : 'Guest';
    var authKey = maskToken(state.authKey);

    byId('sideUserLabel').textContent = email;
    byId('topAccountLabel').textContent = email;
    byId('accountEmail').textContent = email;
    byId('authKeyLabel').textContent = authKey;
    byId('accountNote').textContent = state.authKey
        ? 'This Nuvio session is stored locally on the TV shell.'
        : 'Sign in to keep your Nuvio session active inside this TV shell.';
}

function cloneContinueItem(item) {
    var clone;

    if (!item) {
        return null;
    }

    clone = {
        id: item.id,
        name: item.name,
        poster: item.poster,
        background: item.background || item.poster,
        description: item.description,
        releaseInfo: item.releaseInfo,
        year: item.year,
        imdbRating: item.imdbRating,
        runtime: item.runtime,
        runtimeMins: item.runtimeMins,
        runtimeMinutes: item.runtimeMinutes,
        duration: item.duration,
        length: item.length
    };

    if (Array.isArray(item.genres)) {
        clone.genres = item.genres.slice();
    } else if (typeof item.genres === 'string') {
        clone.genres = item.genres;
    } else if (item.genre) {
        clone.genre = item.genre;
    }

    return clone;
}

function cloneStreamRaw(raw) {
    var clone = {};
    var keys = [
        'url',
        'externalUrl',
        'infoHash',
        'fileIdx',
        'name',
        'title',
        'description',
        'filename',
        'behaviorHints',
        'subtitles',
        'sources',
        'proxyHeaders'
    ];

    if (!raw || typeof raw !== 'object') {
        return null;
    }

    keys.forEach(function(key) {
        if (typeof raw[key] === 'undefined') {
            return;
        }

        try {
            clone[key] = JSON.parse(JSON.stringify(raw[key]));
        } catch (error) {
            clone[key] = raw[key];
        }
    });

    return clone.url || clone.externalUrl || clone.infoHash ? clone : null;
}

function cloneContinueStream(streamEntry) {
    var raw = streamEntry && streamEntry.raw ? cloneStreamRaw(streamEntry.raw) : null;

    if (!streamEntry || !raw || !raw.url) {
        return null;
    }

    return {
        addonName: streamEntry.addonName || '',
        addonBaseUrl: streamEntry.addonBaseUrl || '',
        playable: streamEntry.playable !== false,
        status: streamEntry.status || 'Playable',
        title: streamEntry.title || raw.name || raw.title || raw.description || 'Saved stream',
        description: streamEntry.description || raw.description || raw.title || '',
        raw: raw
    };
}

function normalizeContinueEntry(entry) {
    var item = entry && entry.item ? cloneContinueItem(entry.item) : null;
    var video = entry && entry.video ? entry.video : null;
    var stream = entry && (entry.stream || entry.streamEntry || entry.currentStream)
        ? cloneContinueStream(entry.stream || entry.streamEntry || entry.currentStream)
        : null;

    if (!entry || !item || !entry.kind || !item.id) {
        return null;
    }

    return {
        kind: entry.kind,
        item: item,
        video: video ? {
            id: video.id,
            title: video.title || video.name || '',
            season: getVideoSeason(video),
            episode: getVideoEpisode(video)
        } : null,
        progressKey: entry.progressKey || entry.progress_key || null,
        stream: stream,
        position: typeof entry.position === 'number' ? entry.position : 0,
        duration: typeof entry.duration === 'number' ? entry.duration : 0,
        lastWatched: entry.lastWatched || entry.last_watched || null,
        updatedAt: entry.updatedAt || entry.updated_at || null
    };
}

function getWatchedEpisodeEntryKey(entry) {
    var kind = normalizeAddonType(entry && entry.kind);
    var item = entry && entry.item ? entry.item : null;
    var video = entry && entry.video ? entry.video : null;

    if (kind !== 'series' || !item || !item.id || !video) {
        return '';
    }

    return entry.progressKey
        || entry.progress_key
        || (item.id + '_s' + getVideoSeason(video) + 'e' + getVideoEpisode(video));
}

function normalizeWatchedEpisodeEntry(entry) {
    var normalized = normalizeContinueEntry(entry);

    if (!normalized || normalizeAddonType(normalized.kind) !== 'series' || !normalized.video) {
        return null;
    }

    normalized.progressKey = normalized.progressKey || getWatchedEpisodeEntryKey(normalized);
    if (!normalized.progressKey) {
        return null;
    }

    return normalized;
}

function watchedEpisodeHasProgress(entry) {
    return !!(entry
        && (entry.position > 0
            || entry.duration > 0
            || entry.lastWatched
            || entry.updatedAt));
}

function dedupeWatchedEpisodeEntries(entries, limit) {
    var normalized = [];
    var seen = {};

    (entries || []).forEach(function(entry) {
        var item = normalizeWatchedEpisodeEntry(entry);
        var key;

        if (!item || !watchedEpisodeHasProgress(item)) {
            return;
        }

        key = getWatchedEpisodeEntryKey(item);
        if (!key || seen[key]) {
            return;
        }

        seen[key] = true;
        normalized.push(item);
    });

    return normalized.slice(0, limit);
}

function saveWatchedEpisodes() {
    localStorage.setItem(STORAGE_WATCHED_EPISODES, JSON.stringify(state.watchedEpisodes.slice(0, WATCHED_EPISODE_LIMIT)));
}

function mergeWatchedEpisodeEntries(entries, skipSave) {
    var merged = dedupeWatchedEpisodeEntries(
        (entries || []).concat(state.watchedEpisodes || []),
        WATCHED_EPISODE_LIMIT
    );

    state.watchedEpisodes = merged;
    if (!skipSave) {
        saveWatchedEpisodes();
    }
}

function restoreWatchedEpisodes() {
    var payload = safeJsonParse(localStorage.getItem(STORAGE_WATCHED_EPISODES));
    var source = Array.isArray(payload) ? payload : [];
    var restored = dedupeWatchedEpisodeEntries(source.concat(state.continueWatching || []), WATCHED_EPISODE_LIMIT);

    state.watchedEpisodes = restored;
    if (!Array.isArray(payload) || restored.length !== source.length) {
        saveWatchedEpisodes();
    }
}

function episodeVideosMatch(left, right) {
    if (!left || !right) {
        return false;
    }
    if (left.id && right.id && left.id === right.id) {
        return true;
    }
    return getVideoSeason(left) === getVideoSeason(right)
        && getVideoEpisode(left) === getVideoEpisode(right);
}

function watchedEpisodeMatchesVideo(entry, itemId, video) {
    var normalized = normalizeWatchedEpisodeEntry(entry);

    if (!normalized || !watchedEpisodeHasProgress(normalized) || !normalized.item || normalized.item.id !== itemId || !normalized.video) {
        return false;
    }

    return episodeVideosMatch(normalized.video, video);
}

function isWatchedEpisode(video) {
    var itemId = state.selectedItem && state.selectedItem.id;
    var entries;

    if (state.selectedType !== 'series' || !itemId || !video) {
        return false;
    }

    entries = (state.watchedEpisodes || []).concat(state.continueWatching || []);
    return entries.some(function(entry) {
        return watchedEpisodeMatchesVideo(entry, itemId, video);
    });
}

function normalizeLibraryEntry(entry) {
    var item = entry && entry.item ? cloneContinueItem(entry.item) : null;
    var genres = Array.isArray(entry && entry.genres)
        ? entry.genres.slice()
        : (typeof (entry && entry.genres) === 'string' ? entry.genres : []);

    if (!entry || !item || !entry.kind || !item.id) {
        return null;
    }

    if (genres.length && !item.genres) {
        item.genres = Array.isArray(genres) ? genres.slice() : genres;
    }

    return {
        kind: entry.kind,
        item: item,
        addedAt: typeof entry.addedAt !== 'undefined' ? entry.addedAt : entry.created_at || entry.updated_at || null,
        updatedAt: entry.updatedAt || entry.updated_at || null,
        backendId: entry.backendId || entry.id || null,
        userId: entry.userId || entry.user_id || null,
        posterShape: entry.posterShape || entry.poster_shape || 'POSTER',
        genres: genres,
        addonBaseUrl: entry.addonBaseUrl || entry.addon_base_url || null,
        createdAt: entry.createdAt || entry.created_at || null
    };
}

function continueEntryKey(entry) {
    return entry && entry.kind && entry.item && entry.item.id
        ? entry.kind + ':' + entry.item.id
        : '';
}

function dedupeEntries(entries, normalizer, limit) {
    var normalized = [];
    var seen = {};

    (entries || []).forEach(function(entry) {
        var item = normalizer(entry);
        var key;

        if (!item) {
            return;
        }

        key = continueEntryKey(item);
        if (seen[key]) {
            return;
        }

        seen[key] = true;
        normalized.push(item);
    });

    return normalized.slice(0, limit);
}

function saveContinueWatching() {
    localStorage.setItem(STORAGE_CONTINUE, JSON.stringify(state.continueWatching.slice(0, CONTINUE_WATCHING_LIMIT)));
}

function restoreContinueWatching() {
    var payload = safeJsonParse(localStorage.getItem(STORAGE_CONTINUE));
    var normalized;
    var changed = false;

    if (!Array.isArray(payload)) {
        state.continueWatching = [];
        return;
    }

    normalized = dedupeEntries(payload, normalizeContinueEntry, CONTINUE_WATCHING_LIMIT);
    changed = normalized.length !== payload.length;

    state.continueWatching = normalized;
    if (changed) {
        saveContinueWatching();
    }
}

function saveLibraryItems() {
    localStorage.setItem(STORAGE_LIBRARY, JSON.stringify(state.libraryItems.slice(0, LIBRARY_LIMIT)));
}

function restoreLibraryItems() {
    var payload = safeJsonParse(localStorage.getItem(STORAGE_LIBRARY));
    var normalized;

    if (!Array.isArray(payload)) {
        state.libraryItems = [];
        return;
    }

    normalized = dedupeEntries(payload, normalizeLibraryEntry, LIBRARY_LIMIT);
    state.libraryItems = normalized;
    if (normalized.length !== payload.length) {
        saveLibraryItems();
    }
}

function trackContinueWatching(item, kind, video) {
    var snapshot;
    var key;

    if (!item || !kind) {
        return;
    }

    snapshot = {
        kind: kind,
        item: cloneContinueItem(item),
        video: video ? {
            id: video.id,
            title: video.title || video.name || '',
            season: getVideoSeason(video),
            episode: getVideoEpisode(video)
        } : null,
        position: Math.max(0, Math.round((state.currentTimeMs || 0) / 1000)),
        duration: Math.max(0, Math.round((state.durationMs || 0) / 1000)),
        stream: cloneContinueStream(state.currentStream),
        lastWatched: Date.now()
    };
    snapshot.progressKey = buildWatchProgressKey(kind, snapshot.item.id, snapshot.video);
    key = continueEntryKey(snapshot);

    state.continueWatching = [snapshot].concat(state.continueWatching.filter(function(entry) {
        return continueEntryKey(entry) !== key;
    })).slice(0, CONTINUE_WATCHING_LIMIT);

    mergeWatchedEpisodeEntries([snapshot]);
    saveContinueWatching();
    pushContinueWatchingToNuvio(snapshot);
}
