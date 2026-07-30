function getStreamCapableAddons(type, id) {
    return state.addons.filter(function(addon) {
        return addonSupportsResource(addon, ['stream'], type, id);
    });
}

function getSubtitleCapableAddons(type, id) {
    return state.addons.filter(function(addon) {
        return addonSupportsResource(addon, ['subtitles', 'subtitle'], type, id);
    });
}

function addonBaseUrl(transportUrl) {
    var cleanTransport = canonicalizeAddonUrl(transportUrl);

    if (!cleanTransport || cleanTransport.indexOf('http') !== 0) {
        return null;
    }

    return cleanTransport;
}

function getStreamBehaviorHints(streamEntry) {
    var raw = streamEntry && streamEntry.raw ? streamEntry.raw : null;
    return raw && raw.behaviorHints ? raw.behaviorHints : {};
}

function deriveFilenameFromUrl(url) {
    var cleanUrl;
    var filename = '';

    if (!url) {
        return '';
    }

    cleanUrl = String(url).split('#')[0].split('?')[0];
    filename = cleanUrl.slice(cleanUrl.lastIndexOf('/') + 1);

    try {
        return decodeURIComponent(filename);
    } catch (error) {
        return filename;
    }
}

function buildSubtitleExtraArgs(streamEntry) {
    var raw = streamEntry && streamEntry.raw ? streamEntry.raw : null;
    var hints = getStreamBehaviorHints(streamEntry);
    var parts = [];
    var videoHash = hints.videoHash || raw && raw.videoHash || '';
    var videoSize = hints.videoSize || raw && raw.videoSize || '';
    var filename = hints.filename || raw && raw.filename || deriveFilenameFromUrl(raw && raw.url);

    if (videoHash) {
        parts.push('videoHash=' + encodeURIComponent(String(videoHash)));
    }
    if (videoSize) {
        parts.push('videoSize=' + encodeURIComponent(String(videoSize)));
    }
    if (filename) {
        parts.push('filename=' + encodeURIComponent(String(filename)));
    }

    return parts.join('&');
}

function buildSubtitleTrackLabel(track, addonName, index) {
    var info = track || {};
    var baseLabel = info.label || info.name || '';
    var language = info.lang || info.language || '';
    var normalized = normalizeTrackLabel('subtitle', {
        language: language,
        label: baseLabel
    }, index);

    if (addonName && normalized.indexOf(addonName) === -1) {
        return normalized + ' • ' + addonName;
    }

    return normalized;
}

function normalizeAddonSubtitleTracks(addonName, baseUrl, subtitles, idPrefix) {
    var safeAddonName = addonName.replace(/[^a-z0-9]+/ig, '-').toLowerCase();
    var safePrefix = String(idPrefix || 'result').replace(/[^a-z0-9]+/ig, '-').toLowerCase();

    return (subtitles || []).map(function(track, index) {
        var url = track && (track.url || track.src || track.file);

        if (!url) {
            return null;
        }
        if (!isEnglishSubtitleEntry(track)) {
            return null;
        }

        return {
            id: 'subtitle-ext-addon-' + safeAddonName + '-' + safePrefix + '-' + index,
            index: index,
            kind: 'external',
            url: resolveUrl(baseUrl, url),
            headers: getSubtitleRequestHeaders(null, track),
            language: track.lang || track.language || track.languageCode || track.iso639_1 || track.iso639_2 || track.ISO639 || '',
            label: buildSubtitleTrackLabel(track, addonName, index)
        };
    }).filter(Boolean);
}

function normalizeSubtitleLookupId(value) {
    var raw = String(value || '').trim();
    var head = raw.split(':')[0];

    return head || raw;
}

function buildSubtitleIdCandidates(type, videoId) {
    var candidates = [];

    function push(value) {
        var normalized = String(value || '').trim();

        if (!normalized || candidates.indexOf(normalized) !== -1) {
            return;
        }

        candidates.push(normalized);
    }

    if (normalizeAddonType(type) === 'series') {
        push(videoId);
    }

    push(state.selectedItem && state.selectedItem.id);
    push(normalizeSubtitleLookupId(state.selectedItem && state.selectedItem.id));
    push(normalizeSubtitleLookupId(videoId));

    return candidates;
}

function fetchSubtitlesFromAddon(addon, type, videoId, streamEntry) {
    var baseUrl = addonBaseUrl(addon.transportUrl);
    var addonName = addon.manifest && addon.manifest.name ? addon.manifest.name : 'Addon';
    var extraArgs = buildSubtitleExtraArgs(streamEntry);
    var idCandidates = buildSubtitleIdCandidates(type, videoId);
    var requests = [];

    if (!baseUrl) {
        return Promise.resolve([]);
    }

    function buildSubtitleRequestUrl(id, args) {
        return baseUrl
            + '/subtitles/'
            + encodeURIComponent(type)
            + '/'
            + encodeURIComponent(id)
            + (args ? '/' + args : '')
            + '.json';
    }

    function queueRequest(id, args, key) {
        var requestUrl;

        if (!id) {
            return;
        }

        requestUrl = buildSubtitleRequestUrl(id, args);
        requests.push(scheduleRequest('subtitle', function() {
            return requestJson(requestUrl, 'GET');
        }).then(function(payload) {
            var subtitles = payload && Array.isArray(payload.subtitles)
                ? payload.subtitles
                : (payload && Array.isArray(payload.subtitle) ? payload.subtitle : []);

            return normalizeAddonSubtitleTracks(addonName, baseUrl, subtitles, key);
        }).catch(function() {
            return [];
        }));
    }

    idCandidates.forEach(function(id, index) {
        if (extraArgs) {
            queueRequest(id, extraArgs, 'stream-' + index);
        }
        queueRequest(id, '', 'id-' + index);
    });

    return Promise.all(requests).then(function(groups) {
        var tracks = [];

        groups.forEach(function(group) {
            tracks = tracks.concat(group);
        });

        return dedupeSubtitleTracks(tracks);
    });
}

function refreshSubtitleAddonsForCurrentStream() {
    var streamEntry = state.currentStream;
    var type = state.selectedType;
    var videoId = state.selectedVideo && state.selectedVideo.id;
    var subtitleAddons;
    var requestId;

    if (!streamEntry || !type || !videoId) {
        state.addonSubtitleTracks = [];
        updateExternalSubtitleTracks();
        renderTrackSelectors();
        return Promise.resolve();
    }

    subtitleAddons = getSubtitleCapableAddons(type, videoId);
    requestId = state.subtitleRequestId + 1;
    state.subtitleRequestId = requestId;
    state.addonSubtitleTracks = [];
    updateExternalSubtitleTracks();
    renderTrackSelectors();

    if (!subtitleAddons.length) {
        return Promise.resolve();
    }

    return Promise.all(subtitleAddons.map(function(addon) {
        return fetchSubtitlesFromAddon(addon, type, videoId, streamEntry);
    })).then(function(groups) {
        if (requestId !== state.subtitleRequestId || streamEntry !== state.currentStream) {
            return;
        }

        state.addonSubtitleTracks = [];
        groups.forEach(function(group) {
            state.addonSubtitleTracks = state.addonSubtitleTracks.concat(group);
        });
        updateExternalSubtitleTracks();
        renderTrackSelectors();
        applyPreferredSubtitleSelection();
    });
}

function fetchStreamsFromAddon(addon, type, videoId) {
    var baseUrl = addonBaseUrl(addon.transportUrl);
    var addonName = addon.manifest && addon.manifest.name ? addon.manifest.name : 'Addon';

    if (!baseUrl) {
        return Promise.resolve([{
            addonName: addonName,
            playable: false,
            status: 'Unsupported transport',
            title: 'Addon transport is not web-loadable',
            description: addon.transportUrl || '',
            raw: null
        }]);
    }

    return scheduleRequest('stream', function() {
        return requestJson(baseUrl + '/stream/' + encodeURIComponent(type) + '/' + encodeURIComponent(videoId) + '.json', 'GET');
    })
        .then(function(payload) {
            var streams = payload && Array.isArray(payload.streams) ? payload.streams : [];

            if (!streams.length) {
                return [{
                    addonName: addonName,
                    playable: false,
                    status: 'No streams',
                    title: 'No streams returned',
                    description: 'This addon did not return any playable entries for the selection.',
                    raw: null
                }];
            }

            return streams.map(function(stream) {
                var title = stream.name || stream.title || stream.description || 'Unnamed stream';
                var description = stream.description || stream.title || '';
                var bridgeable = isTorrentBridgeCandidate(stream);
                var playable = !!stream.url;
                var status = playable ? 'Playable' : (bridgeable ? 'Use bridge' : 'Needs proxy');

                if (stream.behaviorHints && stream.behaviorHints.notWebReady) {
                    playable = false;
                    status = bridgeable ? 'Use bridge' : 'Not web ready';
                }

                return {
                    addonName: addonName,
                    addonBaseUrl: baseUrl,
                    playable: playable,
                    bridgeable: bridgeable,
                    status: status,
                    title: title,
                    description: description,
                    raw: stream
                };
            });
        }).catch(function(error) {
            return [{
                addonName: addonName,
                playable: false,
                status: 'Error',
                title: 'Addon request failed',
                description: error.message,
                raw: null
            }];
        });
}

function getTorrentBridgeBaseUrl() {
    return String(typeof TORRENT_BRIDGE_BASE_URL === 'undefined' ? '' : TORRENT_BRIDGE_BASE_URL)
        .replace(/\/+$/, '')
        .trim();
}

function getTorrentBridgeToken() {
    return String(typeof TORRENT_BRIDGE_TOKEN === 'undefined' ? '' : TORRENT_BRIDGE_TOKEN).trim();
}

function getStreamInfoHash(stream) {
    var raw = stream && stream.raw ? stream.raw : stream;
    var hints = raw && raw.behaviorHints ? raw.behaviorHints : {};
    var value = raw && (raw.infoHash || raw.info_hash || raw.btih)
        || hints && (hints.infoHash || hints.info_hash || hints.btih)
        || '';

    return String(value || '').trim();
}

function isTorrentBridgeCandidate(stream) {
    return !!(getTorrentBridgeBaseUrl() && getTorrentBridgeToken() && getStreamInfoHash(stream));
}

function isBridgeStreamEntry(streamEntry) {
    var raw = streamEntry && streamEntry.raw ? streamEntry.raw : {};
    var bridgeBase = getTorrentBridgeBaseUrl();
    var rawUrl = raw && raw.url ? String(raw.url) : '';
    var directUrl = raw && raw.directUrl ? String(raw.directUrl) : '';

    return !!(streamEntry && (
        streamEntry.bridgeable
        || streamEntry.bridgeJob
        || (bridgeBase && rawUrl.indexOf(bridgeBase + '/stream/') === 0)
        || (bridgeBase && rawUrl.indexOf(bridgeBase + '/transcode/') === 0)
        || (bridgeBase && directUrl.indexOf(bridgeBase + '/stream/') === 0)
    ));
}

function isCachedStreamEntry(streamEntry) {
    return !!(streamEntry
        && streamEntry.playable
        && streamEntry.raw
        && streamEntry.raw.url
        && !isBridgeStreamEntry(streamEntry));
}

function getStreamSourceMode() {
    if (state.streamSourceMode === 'bridge') {
        return 'bridge';
    }
    if (state.streamSourceMode === 'cached') {
        return 'cached';
    }
    if (state.streamFilterBridge && state.streamFilterCached === false) {
        return 'bridge';
    }
    return 'cached';
}

function syncStreamSourceFilterState(mode) {
    var normalizedMode = mode === 'bridge' ? 'bridge' : 'cached';

    state.streamSourceMode = normalizedMode;
    state.streamFilterCached = normalizedMode === 'cached';
    state.streamFilterBridge = normalizedMode === 'bridge';
    return normalizedMode;
}

function getVisibleStreams() {
    var sourceMode = syncStreamSourceFilterState(getStreamSourceMode());
    var hasClassifiedStreams = state.streams.some(function(entry) {
        return isCachedStreamEntry(entry) || isBridgeStreamEntry(entry);
    });

    return state.streams.filter(function(entry) {
        if (sourceMode === 'bridge') {
            return isBridgeStreamEntry(entry)
                || (!hasClassifiedStreams && !isCachedStreamEntry(entry) && !isBridgeStreamEntry(entry));
        }

        return isCachedStreamEntry(entry)
            || (!hasClassifiedStreams && !isCachedStreamEntry(entry) && !isBridgeStreamEntry(entry));
    });
}

function getPreferredVisibleStream() {
    var visibleStreams = getVisibleStreams();

    return visibleStreams.filter(function(entry) {
        return isCachedStreamEntry(entry);
    })[0] || visibleStreams.filter(function(entry) {
        return isBridgeStreamEntry(entry);
    })[0] || null;
}

function updateStreamFilterToggleUi() {
    var cachedButton = byId('streamCachedToggle');
    var bridgeButton = byId('streamBridgeToggle');
    var sourceMode = syncStreamSourceFilterState(getStreamSourceMode());
    var cachedEnabled = sourceMode === 'cached';
    var bridgeEnabled = sourceMode === 'bridge';

    if (cachedButton) {
        cachedButton.classList.toggle('is-selected', cachedEnabled);
        cachedButton.setAttribute('aria-pressed', cachedEnabled ? 'true' : 'false');
    }
    if (bridgeButton) {
        bridgeButton.classList.toggle('is-selected', bridgeEnabled);
        bridgeButton.setAttribute('aria-pressed', bridgeEnabled ? 'true' : 'false');
    }
}

function setStreamSourceFilter(kind) {
    syncStreamSourceFilterState(kind);
    renderStreamList();
    focusCurrent();
}

function getTorrentBridgeJobKey(streamEntry) {
    var hash = getStreamInfoHash(streamEntry);
    var fileIdx = streamEntry && streamEntry.raw && typeof streamEntry.raw.fileIdx !== 'undefined'
        ? String(streamEntry.raw.fileIdx)
        : '';

    return hash ? hash + ':' + fileIdx : '';
}

function requestTorrentBridge(path, method, body) {
    return requestJsonWithHeaders(
        getTorrentBridgeBaseUrl() + path,
        method || 'GET',
        body,
        {
            Authorization: 'Bearer ' + getTorrentBridgeToken()
        }
    );
}

function getTorrentBridgePayloadMetadata(streamEntry) {
    var item = state.selectedItem || {};
    var video = state.selectedVideo || {};
    var raw = streamEntry && streamEntry.raw ? streamEntry.raw : {};
    var metadata = {
        itemId: item.id || '',
        itemName: item.name || '',
        itemType: state.selectedType || '',
        poster: item.poster || '',
        background: item.background || item.poster || '',
        videoId: video.id || '',
        videoTitle: video.title || video.name || '',
        streamTitle: raw.title || raw.name || streamEntry && streamEntry.title || ''
    };

    if (state.selectedType === 'series') {
        metadata.season = getVideoSeason(video);
        metadata.episode = getVideoEpisode(video);
    }

    return metadata;
}

function getTorrentBridgePayload(streamEntry) {
    var raw = streamEntry && streamEntry.raw ? streamEntry.raw : {};
    var payload = {
        infoHash: getStreamInfoHash(streamEntry),
        metadata: getTorrentBridgePayloadMetadata(streamEntry)
    };

    if (raw.magnet) {
        payload.magnet = raw.magnet;
    }
    if (typeof raw.fileIdx !== 'undefined') {
        payload.fileIndex = raw.fileIdx;
    }
    if (raw.title || raw.name) {
        payload.title = raw.title || raw.name;
    }

    return payload;
}

function formatTorrentBridgeProgress(job) {
    var progress = job && typeof job.progress === 'number'
        ? Math.max(0, Math.min(100, Math.round(job.progress * 100)))
        : 0;
    var stateLabel = job && job.state ? String(job.state) : 'starting';

    return 'Bridge caching ' + progress + '% (' + stateLabel + ')';
}

function updateTorrentBridgeEntry(streamEntry, job) {
    var playback = job && job.playback && job.playback.url ? job.playback : null;
    var playbackUrl = job && (job.playbackUrl || playback && playback.url || job.streamUrl);

    streamEntry.bridgeJob = job;
    if (job && job.ready && playbackUrl) {
        streamEntry.playable = true;
        streamEntry.bridgeable = false;
        streamEntry.status = playback && playback.mode === 'transcode'
            ? 'Live transcode'
            : playback && playback.mode === 'remux'
                ? 'Lossless remux'
                : 'Playable';
        streamEntry.raw = cloneStreamRaw(streamEntry.raw) || streamEntry.raw || {};
        streamEntry.raw.url = playbackUrl;
        if (job.streamUrl && job.streamUrl !== playbackUrl) {
            streamEntry.raw.directUrl = job.streamUrl;
        }
        if (playback) {
            streamEntry.raw.playbackMode = playback.mode;
            streamEntry.raw.playbackQuality = playback.quality;
            streamEntry.raw.playbackReasons = playback.reasons;
            streamEntry.raw.playbackLive = !!playback.live;
            streamEntry.raw.fileProgress = playback.fileProgress;
        }
        if (Array.isArray(job.subtitles)) {
            streamEntry.raw.subtitles = job.subtitles;
        }
        streamEntry.description = playback && playback.reasons && playback.reasons.length
            ? playback.reasons.join(' ')
            : streamEntry.description || 'Torrent bridge stream is ready.';
        return;
    }

    streamEntry.playable = false;
    streamEntry.bridgeable = true;
    streamEntry.status = formatTorrentBridgeProgress(job);
}

function setTorrentBridgePlayerStatus(streamEntry, message) {
    state.currentStream = {
        addonName: streamEntry.addonName || '',
        playable: false,
        placeholder: true,
        status: message,
        title: streamEntry.title || 'Preparing stream',
        description: streamEntry.description || 'Waiting for the torrent bridge to buffer enough data.'
    };
    renderPlayerState();
    setPlayerStatus(message);
    showPlayerChrome(true);
}

function shouldShowTorrentBridgeInPlayer(streamKey) {
    var jobState = state.torrentBridgeJobs[streamKey];
    return !!(jobState && jobState.playerMode);
}

function renderTorrentBridgeState(streamEntry, streamKey) {
    var message = streamEntry.status || 'Bridge caching...';

    if (shouldShowTorrentBridgeInPlayer(streamKey)) {
        if (state.resumeAutoplayInPlayer) {
            setResumeLookupPlayerStatus(message);
        } else {
            setTorrentBridgePlayerStatus(streamEntry, message);
        }
        return;
    }

    if (state.currentView !== 'addons') {
        setView('addons', {
            focusRegion: 'main',
            resetMain: false,
            pushHistory: false
        });
    }
    state.detailMode = 'sources';
    setAddonsMessage(message, null);
    renderStreamList();
}

function pollTorrentBridge(streamEntry, streamKey) {
    var hash = getStreamInfoHash(streamEntry);
    var fileIdx = streamEntry && streamEntry.raw && typeof streamEntry.raw.fileIdx !== 'undefined'
        ? streamEntry.raw.fileIdx
        : null;
    var path = '/api/torrents/' + encodeURIComponent(hash);

    if (fileIdx !== null) {
        path += '?fileIndex=' + encodeURIComponent(String(fileIdx));
    }

    return requestTorrentBridge(path, 'GET').then(function(job) {
        if (!state.torrentBridgeJobs[streamKey]) {
            return;
        }

        updateTorrentBridgeEntry(streamEntry, job);
        renderTorrentBridgeState(streamEntry, streamKey);
        if (job && job.ready && job.streamUrl) {
            openStream(streamEntry);
            delete state.torrentBridgeJobs[streamKey];
            return;
        }

        state.torrentBridgeJobs[streamKey].timer = setTimeout(function() {
            pollTorrentBridge(streamEntry, streamKey);
        }, 3000);
    }).catch(function(error) {
        streamEntry.status = 'Bridge error';
        streamEntry.description = error.message;
        renderTorrentBridgeState(streamEntry, streamKey);
        delete state.torrentBridgeJobs[streamKey];
    });
}

function openTorrentBridgeStream(streamEntry) {
    var streamKey = getTorrentBridgeJobKey(streamEntry);

    if (!streamEntry || !isTorrentBridgeCandidate(streamEntry) || !streamKey) {
        openStream(streamEntry);
        return;
    }

    if (state.torrentBridgeJobs[streamKey]) {
        return;
    }

    state.torrentBridgeJobs[streamKey] = {
        startedAt: Date.now(),
        timer: null,
        playerMode: state.currentView === 'player' || state.resumeAutoplayInPlayer
    };
    streamEntry.status = 'Bridge starting...';
    renderTorrentBridgeState(streamEntry, streamKey);

    requestTorrentBridge('/api/torrents', 'POST', getTorrentBridgePayload(streamEntry)).then(function(job) {
        updateTorrentBridgeEntry(streamEntry, job);
        renderTorrentBridgeState(streamEntry, streamKey);
        if (job && job.ready && job.streamUrl) {
            openStream(streamEntry);
            delete state.torrentBridgeJobs[streamKey];
            return;
        }
        state.torrentBridgeJobs[streamKey].timer = setTimeout(function() {
            pollTorrentBridge(streamEntry, streamKey);
        }, 3000);
    }).catch(function(error) {
        streamEntry.status = 'Bridge error';
        streamEntry.description = error.message;
        renderTorrentBridgeState(streamEntry, streamKey);
        delete state.torrentBridgeJobs[streamKey];
    });
}

function openPlayableOrBridgeStream(streamEntry) {
    if (streamEntry && streamEntry.bridgeable) {
        openTorrentBridgeStream(streamEntry);
        return;
    }

    openStream(streamEntry);
}

function getSeasonEpisodeCount(season) {
    return state.allSeriesVideos.filter(function(video) {
        return getVideoSeason(video) === season;
    }).length;
}

function getEpisodeBrowserRowCount() {
    if (state.selectedType !== 'series' || state.detailMode !== 'episodes') {
        return 0;
    }

    return Math.max(state.availableSeasons.length, state.selectedEpisodes.length);
}

function getVisibleDetailActionRowCount() {
    return queryAll('#detailActions .action-button, #detailTrailerControls .action-button').some(function(button) {
        return isVisibleControl(button);
    }) ? 1 : 0;
}

function getVisibleStreamFilterRowCount() {
    return queryAll('#streamSourceToggle .library-toggle-button').some(function(button) {
        return isVisibleControl(button);
    }) ? 1 : 0;
}

function getFirstStreamMainRow() {
    return getVisibleDetailActionRowCount() + getEpisodeBrowserRowCount() + getVisibleStreamFilterRowCount();
}

function getSelectedEpisodeMainRow() {
    var episodeIndex = 0;

    if (state.selectedVideo && state.selectedVideo.id) {
        state.selectedEpisodes.some(function(video, index) {
            if (video && video.id === state.selectedVideo.id) {
                episodeIndex = index;
                return true;
            }
            return false;
        });
    }

    return getVisibleDetailActionRowCount() + episodeIndex;
}

function isEpisodeBrowserNavigationActive() {
    return state.currentView === 'addons'
        && state.detailMode === 'episodes'
        && state.focusRegion === 'main';
}

function getEpisodeBrowserStartRow() {
    return getVisibleDetailActionRowCount();
}

function getFocusedEpisodeIndex() {
    var index = state.mainRow - getEpisodeBrowserStartRow();
    var seasonExists = !!state.availableSeasons[index];

    if (!isEpisodeBrowserNavigationActive() || index < 0 || index >= state.selectedEpisodes.length) {
        return -1;
    }

    return state.mainCol === (seasonExists ? 1 : 0) ? index : -1;
}

function getFocusedSeasonIndex() {
    var index = state.mainRow - getEpisodeBrowserStartRow();

    if (!isEpisodeBrowserNavigationActive() || index < 0 || index >= state.availableSeasons.length) {
        return -1;
    }

    return state.mainCol === 0 ? index : -1;
}

function focusEpisodeBrowserEpisode(index) {
    var episodes = state.selectedEpisodes;
    var seasons = state.availableSeasons;
    var safeIndex;

    if (!episodes.length) {
        return false;
    }

    safeIndex = Math.max(0, Math.min(index, episodes.length - 1));
    state.mainRow = getEpisodeBrowserStartRow() + safeIndex;
    state.mainCol = seasons[safeIndex] ? 1 : 0;
    focusCurrent();
    return true;
}

function focusEpisodeBrowserSeason(index) {
    var seasons = state.availableSeasons;
    var safeIndex;

    if (!seasons.length) {
        return false;
    }

    safeIndex = Math.max(0, Math.min(index, seasons.length - 1));
    state.mainRow = getEpisodeBrowserStartRow() + safeIndex;
    state.mainCol = 0;
    focusCurrent();
    return true;
}

function moveEpisodeBrowserVertical(direction) {
    var episodeIndex;
    var seasonIndex;
    var targetIndex;

    if (!isEpisodeBrowserNavigationActive()) {
        return false;
    }

    episodeIndex = getFocusedEpisodeIndex();
    if (episodeIndex !== -1) {
        targetIndex = episodeIndex + direction;
        if (targetIndex >= 0 && targetIndex < state.selectedEpisodes.length) {
            return focusEpisodeBrowserEpisode(targetIndex);
        }
        return false;
    }

    seasonIndex = getFocusedSeasonIndex();
    if (seasonIndex !== -1) {
        targetIndex = seasonIndex + direction;
        if (targetIndex >= 0 && targetIndex < state.availableSeasons.length) {
            return focusEpisodeBrowserSeason(targetIndex);
        }
        return false;
    }

    return false;
}

function moveEpisodeBrowserHorizontal(direction) {
    var episodeIndex;
    var seasonIndex;

    if (!isEpisodeBrowserNavigationActive()) {
        return false;
    }

    episodeIndex = getFocusedEpisodeIndex();
    if (direction < 0 && episodeIndex !== -1) {
        return focusEpisodeBrowserSeason(episodeIndex);
    }

    seasonIndex = getFocusedSeasonIndex();
    if (direction > 0 && seasonIndex !== -1) {
        return focusEpisodeBrowserEpisode(seasonIndex);
    }

    return false;
}

function applyDetailMode() {
    var hasSelection = !!state.selectedItem;
    var isSeries = state.selectedType === 'series';
    var showDetails = !hasSelection || !isSeries || state.detailMode === 'details';
    var showEpisodes = hasSelection && isSeries && state.detailMode === 'episodes';
    var showStreams = hasSelection && state.detailMode === 'sources';
    var detailHero = byId('detailHeroRow');
    var episodeSection = byId('episodeSection');
    var streamSection = byId('streamSection');

    if (detailHero) {
        detailHero.style.display = showDetails ? '' : 'none';
    }
    if (episodeSection) {
        episodeSection.style.display = showEpisodes && state.selectedEpisodes.length ? '' : 'none';
    }
    if (streamSection) {
        streamSection.style.display = showStreams ? '' : 'none';
    }
    markFocusRegistryDirty();
}

function getVideoTitle(video) {
    return video && (video.title || video.name) || 'Episode';
}

function getVideoDescription(video) {
    return video && (
        video.overview ||
        video.description ||
        video.summary ||
        video.plot ||
        video.synopsis
    ) || state.selectedItem && state.selectedItem.description || 'No episode description was returned for this title.';
}

function getVideoThumbnail(video) {
    return video && (
        video.thumbnail ||
        video.thumbnailUrl ||
        video.poster ||
        video.background ||
        video.image
    ) || state.selectedItem && (state.selectedItem.background || state.selectedItem.poster) || '';
}

function formatVideoRuntime(video) {
    var value = video && (video.runtime || video.duration || video.length);
    var minutes;

    if (typeof value === 'number' && !isNaN(value)) {
        minutes = value > 1000 ? Math.round(value / 60000) : Math.round(value);
        return minutes ? '(' + minutes + 'm)' : '';
    }

    if (typeof value === 'string' && value) {
        if (/^\d+$/.test(value)) {
            minutes = parseInt(value, 10);
            return minutes ? '(' + minutes + 'm)' : '';
        }
        return value.charAt(0) === '(' ? value : '(' + value + ')';
    }

    return '';
}

function formatEpisodeCode(video) {
    return 'S' + getVideoSeason(video) + ':E' + (getVideoEpisode(video) || '?');
}

function renderEpisodeRail() {
    var rail = byId('episodeRail');
    var section = byId('episodeSection');
    var fragment = document.createDocumentFragment();

    rail.innerHTML = '';

    if (!state.selectedEpisodes.length) {
        section.style.display = 'none';
        markFocusRegistryDirty();
        return;
    }

    section.style.display = 'block';
    byId('episodeBrowserTitle').textContent = formatSeasonLabel(state.selectedSeason);
    byId('episodeBrowserCount').textContent = state.selectedEpisodes.length + ' episode' + (state.selectedEpisodes.length === 1 ? '' : 's');
    warmEpisodeArtwork(state.selectedEpisodes, 0, 8);

    state.selectedEpisodes.forEach(function(video, index) {
        var button = document.createElement('button');
        var thumb = document.createElement('div');
        var thumbImg = document.createElement('img');
        var thumbLabel = document.createElement('span');
        var copy = document.createElement('div');
        var title = document.createElement('div');
        var description = document.createElement('p');
        var runtime = document.createElement('div');
        var imageUrl = getVideoThumbnail(video);
        var watched = isWatchedEpisode(video);
        var watchedIcon;

        button.className = 'episode-card';
        if (watched) {
            button.classList.add('is-watched');
        }
        button.type = 'button';
        button.setAttribute('tabindex', '-1');
        button.setAttribute('aria-label', (watched ? 'Watched. ' : '') + getVideoTitle(video));

        thumb.className = 'episode-thumb';
        if (imageUrl) {
            thumb.classList.add('is-loading');
            thumbImg.decoding = 'async';
            thumbImg.loading = index < 5 ? 'eager' : 'lazy';
            thumbImg.onload = function() {
                thumb.classList.remove('is-loading');
                thumb.classList.add('is-loaded');
            };
            thumbImg.onerror = function() {
                thumb.classList.remove('is-loading');
                thumb.classList.add('is-empty');
            };
            thumbImg.src = imageUrl;
            thumbImg.alt = getVideoTitle(video);
            if (thumbImg.complete && (thumbImg.naturalWidth || thumbImg.naturalHeight)) {
                thumb.classList.remove('is-loading');
                thumb.classList.add('is-loaded');
            }
            thumb.appendChild(thumbImg);
        } else {
            thumb.classList.add('is-empty');
            thumb.textContent = formatEpisodeCode(video);
        }
        thumbLabel.className = 'episode-thumb-label';
        thumbLabel.textContent = formatEpisodeCode(video);
        thumb.appendChild(thumbLabel);
        if (watched) {
            watchedIcon = document.createElement('span');
            watchedIcon.className = 'episode-watched-icon';
            watchedIcon.setAttribute('aria-hidden', 'true');
            thumb.appendChild(watchedIcon);
        }

        copy.className = 'episode-copy';
        title.className = 'episode-title';
        title.textContent = getVideoTitle(video);
        description.className = 'episode-description';
        description.textContent = getVideoDescription(video);
        runtime.className = 'episode-runtime';
        runtime.textContent = formatVideoRuntime(video);

        copy.appendChild(title);
        copy.appendChild(description);
        if (runtime.textContent) {
            copy.appendChild(runtime);
        }

        button.appendChild(thumb);
        button.appendChild(copy);
        button.addEventListener('click', function() {
            state.selectedVideo = video;
            state.selectedSeason = getVideoSeason(video);
            state.detailMode = 'sources';
            state.streams = [];
            renderEpisodeBrowserForMode();
            renderStreamList();
            applyDetailMode();
            loadStreamsForSelection({
                focusStreams: true
            });
        });
        fragment.appendChild(button);
    });
    rail.appendChild(fragment);
    markFocusRegistryDirty();
}

function renderSeasonRail() {
    var rail = byId('seasonRail');
    var section = byId('seasonSection');
    var fragment = document.createDocumentFragment();

    rail.innerHTML = '';

    if (state.selectedType !== 'series' || !state.availableSeasons.length) {
        section.style.display = 'none';
        markFocusRegistryDirty();
        return;
    }

    section.style.display = 'block';
    byId('episodeShowTitle').textContent = state.selectedItem && state.selectedItem.name || 'Series';
    byId('episodeShowMeta').textContent = [
        state.selectedItem && (state.selectedItem.year || state.selectedItem.releaseInfo),
        state.availableSeasons.length + ' season' + (state.availableSeasons.length === 1 ? '' : 's')
    ].filter(Boolean).join(' • ');

    state.availableSeasons.forEach(function(season) {
        var button = document.createElement('button');
        var label = document.createElement('span');
        var count = document.createElement('span');
        var episodeCount = getSeasonEpisodeCount(season);

        button.className = 'season-chip';
        button.type = 'button';
        button.setAttribute('tabindex', '-1');
        if (state.selectedSeason === season) {
            button.classList.add('is-selected');
        }
        label.textContent = formatSeasonLabel(season);
        count.textContent = episodeCount + ' episode' + (episodeCount === 1 ? '' : 's');
        button.appendChild(label);
        button.appendChild(count);
        button.addEventListener('click', function() {
            if (state.selectedSeason === season) {
                return;
            }
            state.selectedSeason = season;
            updateSelectedEpisodesForSeason();
            state.streams = [];
            state.detailMode = 'episodes';
            renderAddons();
            if (!state.selectedVideo) {
                setAddonsMessage('No episodes were returned for this season.', 'error');
                return;
            }
        });
        fragment.appendChild(button);
    });
    rail.appendChild(fragment);
    markFocusRegistryDirty();
}

function renderStreamList() {
    var list = byId('streamList');
    var streamCount = byId('streamCount');
    var visibleStreams = getVisibleStreams();
    var fragment = document.createDocumentFragment();
    var empty;

    updateStreamFilterToggleUi();
    if (streamCount) {
        streamCount.textContent = visibleStreams.length === state.streams.length
            ? visibleStreams.length + ' shown'
            : visibleStreams.length + ' of ' + state.streams.length + ' shown';
    }
    list.innerHTML = '';

    if (!state.streams.length) {
        applyDetailMode();
        markFocusRegistryDirty();
        return;
    }

    if (!visibleStreams.length) {
        empty = document.createElement('p');
        empty.className = 'stream-empty-state';
        empty.textContent = 'No streams match the selected filters.';
        list.appendChild(empty);
        applyDetailMode();
        markFocusRegistryDirty();
        return;
    }

    visibleStreams.forEach(function(streamEntry) {
        var button = document.createElement('button');
        var main = document.createElement('div');
        var body = document.createElement('div');
        var badge = document.createElement('div');
        var title = document.createElement('div');
        var addon = document.createElement('div');
        var note = document.createElement('div');

        button.className = 'stream-card';
        button.type = 'button';
        button.setAttribute('tabindex', '-1');
        button.addEventListener('click', function() {
            openPlayableOrBridgeStream(streamEntry);
        });

        main.className = 'stream-card-main';
        body.className = 'stream-card-body';
        badge.className = 'stream-badge';
        title.className = 'stream-card-title';
        addon.className = 'stream-card-addon';
        note.className = 'stream-card-note';

        title.textContent = streamEntry.title;
        addon.textContent = streamEntry.addonName;
        note.textContent = streamEntry.description || 'No extra stream description.';
        badge.textContent = streamEntry.status;

        if (!streamEntry.playable && !streamEntry.bridgeable) {
            badge.classList.add('is-error');
        }

        body.appendChild(title);
        body.appendChild(addon);
        body.appendChild(note);
        main.appendChild(body);
        main.appendChild(badge);
        button.appendChild(main);
        fragment.appendChild(button);
    });

    list.appendChild(fragment);
    applyDetailMode();
    markFocusRegistryDirty();
}

function renderEpisodeBrowserForMode() {
    if (state.selectedType === 'series' && state.detailMode === 'episodes') {
        renderSeasonRail();
        renderEpisodeRail();
        return;
    }

    if (byId('seasonRail')) {
        byId('seasonRail').innerHTML = '';
    }
    if (byId('episodeRail')) {
        byId('episodeRail').innerHTML = '';
    }
    if (byId('episodeSection')) {
        byId('episodeSection').style.display = 'none';
    }
    markFocusRegistryDirty();
}

function getSelectedKindLabel() {
    return state.selectedType === 'series' ? 'Series' : 'Movie';
}

function getSelectedBrowseKey() {
    return state.selectedType === 'series' ? 'series' : 'movies';
}

function getSelectedVideoSummary() {
    if (state.selectedType === 'series') {
        return state.selectedVideo
            ? (formatSeasonLabel(getVideoSeason(state.selectedVideo)) + ' • Episode ' + (getVideoEpisode(state.selectedVideo) || '?'))
            : 'Choose an episode';
    }

    return 'Movie';
}

function getSelectedItemMetaLine() {
    var item = state.selectedItem;
    var fallback = formatMetaLine(item, getSelectedKindLabel());

    return formatHomeActiveMetaLine(item, state.selectedType, getSelectedBrowseKey()) || fallback;
}

function applySelectedItemFallbacks(fallbackItem) {
    if (!state.selectedItem || !fallbackItem) {
        return;
    }

    state.selectedItem.id = state.selectedItem.id || fallbackItem.id;
    state.selectedItem.name = state.selectedItem.name || fallbackItem.name;
    state.selectedItem.poster = state.selectedItem.poster || fallbackItem.poster;
    state.selectedItem.background = state.selectedItem.background || fallbackItem.background || fallbackItem.poster;
    state.selectedItem.description = state.selectedItem.description || fallbackItem.description;
    state.selectedItem.releaseInfo = state.selectedItem.releaseInfo || fallbackItem.releaseInfo;
    state.selectedItem.year = state.selectedItem.year || fallbackItem.year;
    state.selectedItem.imdbRating = state.selectedItem.imdbRating || fallbackItem.imdbRating;
    if (!getItemGenreLabel(state.selectedItem) && fallbackItem.genres) {
        state.selectedItem.genres = fallbackItem.genres.slice();
    }
    if (!getItemGenreLabel(state.selectedItem) && fallbackItem.genre) {
        state.selectedItem.genre = fallbackItem.genre;
    }
}

function getImdbApiBaseUrl() {
    return String(typeof IMDB_API_BASE_URL === 'undefined' ? '' : IMDB_API_BASE_URL)
        .replace(/\/+$/, '');
}

function getImdbApiDetailKey(type, id) {
    return String(type || '') + ':' + String(id || '');
}

function getImdbApiTitleImageUrl(title) {
    return title && title.primaryImage && title.primaryImage.url ? title.primaryImage.url : '';
}

function getImdbApiTitleRating(title) {
    return title && title.rating && typeof title.rating.aggregateRating === 'number'
        ? Number(title.rating.aggregateRating.toFixed(1))
        : null;
}

function getImdbApiTitleVoteCount(title) {
    return title && title.rating && typeof title.rating.voteCount === 'number'
        ? title.rating.voteCount
        : null;
}

function getImdbApiTitleRuntime(title) {
    return title && title.runtimeSeconds ? Math.round(Number(title.runtimeSeconds) / 60) : null;
}

function getImdbApiTitleYear(title) {
    return title && title.startYear ? String(title.startYear) : '';
}

function getImdbApiTitleReleaseInfo(title, fallbackItem) {
    var startYear = title && title.startYear ? String(title.startYear) : '';
    var endYear = title && title.endYear ? String(title.endYear) : '';

    if (startYear && endYear && startYear !== endYear) {
        return startYear + '-' + endYear;
    }
    return startYear || fallbackItem && fallbackItem.releaseInfo || fallbackItem && fallbackItem.year || '';
}

function requestImdbApiTitle(id) {
    var baseUrl = getImdbApiBaseUrl();
    var key = String(id || '');

    if (!baseUrl || !key) {
        return Promise.resolve(null);
    }
    if (Object.prototype.hasOwnProperty.call(imdbApiTitleCache, key)) {
        return Promise.resolve(imdbApiTitleCache[key]);
    }
    if (imdbApiTitlePending[key]) {
        return imdbApiTitlePending[key];
    }

    imdbApiTitlePending[key] = scheduleRequest('meta', function() {
        return requestJson(baseUrl + '/titles/' + encodeURIComponent(key), 'GET');
    }).then(function(payload) {
        imdbApiTitleCache[key] = payload || null;
        delete imdbApiTitlePending[key];
        return imdbApiTitleCache[key];
    }).catch(function(error) {
        delete imdbApiTitlePending[key];
        throw error;
    });

    return imdbApiTitlePending[key];
}

function requestImdbApiCredits(id) {
    var baseUrl = getImdbApiBaseUrl();
    var key = String(id || '');
    var limit = Math.max(1, Math.min(50, Number(DETAIL_CAST_LIMIT || 10) || 10));
    var url;

    if (!baseUrl || !key) {
        return Promise.resolve(null);
    }
    if (Object.prototype.hasOwnProperty.call(imdbApiCreditsCache, key)) {
        return Promise.resolve(imdbApiCreditsCache[key]);
    }
    if (imdbApiCreditsPending[key]) {
        return imdbApiCreditsPending[key];
    }

    url = baseUrl
        + '/titles/'
        + encodeURIComponent(key)
        + '/credits?pageSize='
        + encodeURIComponent(String(limit))
        + '&categories=actor&categories=actress';

    imdbApiCreditsPending[key] = scheduleRequest('meta', function() {
        return requestJson(url, 'GET');
    }).then(function(payload) {
        imdbApiCreditsCache[key] = payload || null;
        delete imdbApiCreditsPending[key];
        return imdbApiCreditsCache[key];
    }).catch(function(error) {
        delete imdbApiCreditsPending[key];
        throw error;
    });

    return imdbApiCreditsPending[key];
}

function getDetailTrailerKey(type, id) {
    return normalizeAddonType(type) + ':' + String(id || '');
}

function buildYoutubeTrailerPayload(key, name, type) {
    if (!key) {
        return null;
    }

    return {
        key: String(key),
        name: name || 'Trailer',
        type: type || 'Trailer',
        site: 'YouTube'
    };
}

function normalizeDetailTrailerPayload(payload) {
    var meta = payload && payload.meta ? payload.meta : payload;
    var trailer = payload && payload.trailer ? payload.trailer : payload;
    var streamTrailer;
    var trailerEntry;

    if (!trailer || (!trailer.key && !trailer.url)) {
        trailer = null;
    }

    if (trailer) {
        return trailer;
    }

    streamTrailer = Array.isArray(meta && meta.trailerStreams)
        ? meta.trailerStreams.filter(function(item) {
            return item && item.ytId;
        })[0]
        : null;
    if (streamTrailer) {
        return buildYoutubeTrailerPayload(streamTrailer.ytId, streamTrailer.title || meta.name || 'Trailer', 'Trailer');
    }

    trailerEntry = Array.isArray(meta && meta.trailers)
        ? meta.trailers.filter(function(item) {
            return item && item.source;
        })[0]
        : null;
    if (trailerEntry) {
        return buildYoutubeTrailerPayload(trailerEntry.source, meta && meta.name || 'Trailer', trailerEntry.type || 'Trailer');
    }

    return null;
}

function getSelectedItemTrailerFallback() {
    return normalizeDetailTrailerPayload(state.selectedItem);
}

function requestAddonTrailer(type, id) {
    if (!id || typeof fetchMetaFromAddons !== 'function') {
        return Promise.resolve(null);
    }

    return fetchMetaFromAddons(type, id).then(function(meta) {
        return normalizeDetailTrailerPayload(meta);
    }).catch(function() {
        return null;
    });
}

function requestDetailTrailer(type, id) {
    var baseUrl = getImdbCatalogApiBaseUrl();
    var key = getDetailTrailerKey(type, id);

    if (!id) {
        return Promise.resolve(null);
    }
    if (Object.prototype.hasOwnProperty.call(detailTrailerCache, key)) {
        return Promise.resolve(detailTrailerCache[key]);
    }
    if (detailTrailerPending[key]) {
        return detailTrailerPending[key];
    }

    detailTrailerPending[key] = (baseUrl ? scheduleRequest('meta', function() {
        return requestJson(
            baseUrl
                + '/trailer/'
                + encodeURIComponent(normalizeAddonType(type))
                + '/'
                + encodeURIComponent(String(id)),
            'GET'
        );
    }).then(function(payload) {
        return normalizeDetailTrailerPayload(payload);
    }).catch(function() {
        return null;
    }) : Promise.resolve(null)).then(function(trailer) {
        if (trailer) {
            return trailer;
        }
        return requestAddonTrailer(type, id);
    }).then(function(trailer) {
        detailTrailerCache[key] = trailer || null;
        delete detailTrailerPending[key];
        return detailTrailerCache[key];
    }).catch(function(error) {
        delete detailTrailerPending[key];
        throw error;
    });

    return detailTrailerPending[key];
}

var detailTrailerPrefetchTimer = null;
var detailTrailerPrefetchKey = '';

function prefetchDetailTrailer(type, id) {
    if (!id) {
        return;
    }

    requestDetailTrailer(type, id).catch(function() {});
}

function scheduleDetailTrailerPrefetch(type, id) {
    var key = getDetailTrailerKey(type, id);

    if (!id || !key) {
        return;
    }
    if (Object.prototype.hasOwnProperty.call(detailTrailerCache, key)) {
        return;
    }

    detailTrailerPrefetchKey = key;
    if (detailTrailerPrefetchTimer) {
        clearTimeout(detailTrailerPrefetchTimer);
    }
    detailTrailerPrefetchTimer = setTimeout(function() {
        detailTrailerPrefetchTimer = null;
        if (detailTrailerPrefetchKey !== key) {
            return;
        }
        prefetchDetailTrailer(type, id);
    }, 240);
}

function getYouTubeKeyFromTrailer(trailer) {
    var match;
    var value = trailer && (trailer.key || trailer.url || trailer.webUrl) || '';

    if (trailer && trailer.key) {
        return String(trailer.key);
    }

    match = String(value).match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    return match ? match[1] : '';
}

function buildDetailTrailerEmbedUrl(trailer) {
    var key = getYouTubeKeyFromTrailer(trailer);
    var helperBaseUrl = getImdbCatalogApiBaseUrl();
    var title = trailer && trailer.name || 'Trailer';

    if (!key) {
        return trailer && trailer.url || '';
    }
    if (helperBaseUrl) {
        return helperBaseUrl
            + '/trailer-player?key='
            + encodeURIComponent(key)
            + '&title='
            + encodeURIComponent(title);
    }

    return 'https://www.youtube.com/embed/'
        + encodeURIComponent(key)
        + '?enablejsapi=1&playsinline=1&rel=0&modestbranding=1&controls=0&iv_load_policy=3&autoplay=1';
}

function requestDetailTrailerVideoStream(trailer) {
    var key = getYouTubeKeyFromTrailer(trailer);
    var helperBaseUrl = getImdbCatalogApiBaseUrl();

    if (typeof TRAILER_DIRECT_STREAM_ENABLED !== 'undefined' && !TRAILER_DIRECT_STREAM_ENABLED) {
        return Promise.reject(new Error('Direct trailer stream is disabled.'));
    }
    if (!key || !helperBaseUrl) {
        return Promise.reject(new Error('No trailer stream resolver is configured.'));
    }

    return requestJson(
        helperBaseUrl + '/trailer-stream?key=' + encodeURIComponent(key),
        'GET'
    );
}

function formatTrailerTime(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds || 0)));
    var minutes = Math.floor(total / 60);
    var remainder = total % 60;

    return minutes + ':' + (remainder < 10 ? '0' : '') + remainder;
}

function syncDetailTrailerFrameRect() {
    var artwork = byId('detailArtwork');
    var stage = byId('detailTrailerStage');
    var frame = byId('detailTrailerFrame');
    var video = byId('detailTrailerVideo');
    var rect;
    var width;
    var height;

    if (!state.detailTrailerActive || !artwork || !stage) {
        return;
    }

    width = artwork.clientWidth || 0;
    height = artwork.clientHeight || 0;
    if ((!width || !height) && artwork.getBoundingClientRect) {
        rect = artwork.getBoundingClientRect();
        width = rect && rect.width || width;
        height = rect && rect.height || height;
    }

    width = Math.max(320, Math.round(width || 1280));
    height = Math.max(180, Math.round(height || 720));

    [stage, frame, video].forEach(function(element) {
        if (!element) {
            return;
        }
        element.style.top = '0px';
        element.style.left = '0px';
        element.style.right = 'auto';
        element.style.bottom = 'auto';
        element.style.width = width + 'px';
        element.style.height = height + 'px';
    });
    if (frame) {
        frame.setAttribute('width', String(width));
        frame.setAttribute('height', String(height));
    }
    if (video) {
        video.setAttribute('width', String(width));
        video.setAttribute('height', String(height));
    }
}

function scheduleDetailTrailerFrameSync() {
    syncDetailTrailerFrameRect();
    if (state.detailTrailerSyncTimer) {
        clearTimeout(state.detailTrailerSyncTimer);
    }
    state.detailTrailerSyncTimer = setTimeout(function() {
        state.detailTrailerSyncTimer = null;
        syncDetailTrailerFrameRect();
    }, 140);
    setTimeout(syncDetailTrailerFrameRect, 420);
}

function renderDetailTrailerUi() {
    var button = byId('detailTrailerButton');
    var stage = byId('detailTrailerStage');
    var toggleButton = byId('detailTrailerToggleButton');
    var toggleGlyph = byId('detailTrailerToggleGlyph');
    var caption = byId('detailTrailerCaption');
    var hasSelection = !!state.selectedItem;
    var hasTrailer = !!state.selectedTrailer;
    var pending = !!state.detailTrailerLoading;
    var resolving = !!state.detailTrailerResolving;
    var title = state.selectedTrailer && state.selectedTrailer.name || 'Trailer';
    var timeText = state.detailTrailerDurationSeconds
        ? formatTrailerTime(state.detailTrailerCurrentSeconds) + ' / ' + formatTrailerTime(state.detailTrailerDurationSeconds)
        : '';

    if (button) {
        button.style.display = hasSelection ? '' : 'none';
        button.disabled = !hasSelection || pending || !hasTrailer;
        button.textContent = pending ? 'Trailer' : hasTrailer ? 'Trailer' : 'No Trailer';
        button.classList.toggle('is-loading', pending);
        button.setAttribute('aria-busy', pending ? 'true' : 'false');
        button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
    }
    if (stage) {
        stage.hidden = !state.detailTrailerActive;
    }
    if (toggleButton) {
        toggleButton.setAttribute('aria-label', state.detailTrailerPlaying ? 'Pause trailer' : 'Play trailer');
        toggleButton.setAttribute('title', state.detailTrailerPlaying ? 'Pause trailer' : 'Play trailer');
        toggleButton.setAttribute('data-state', state.detailTrailerPlaying ? 'pause' : 'play');
    }
    if (toggleGlyph) {
        toggleGlyph.textContent = state.detailTrailerPlaying ? '❚❚' : '▶';
    }
    if (caption) {
        caption.textContent = resolving
            ? title + ' • Loading...'
            : (timeText ? title + ' • ' + timeText : title);
    }

    markFocusRegistryDirty();
}

function readDetailTrailerVideoMetrics() {
    var video = byId('detailTrailerVideo');

    if (!video || state.detailTrailerMode !== 'video') {
        return;
    }

    if (typeof video.currentTime === 'number' && isFinite(video.currentTime)) {
        state.detailTrailerCurrentSeconds = video.currentTime;
    }
    if (typeof video.duration === 'number' && isFinite(video.duration) && video.duration > 0) {
        state.detailTrailerDurationSeconds = video.duration;
    }
    state.detailTrailerPlaying = !video.paused && !video.ended;
}

function sendDetailTrailerCommand(command, args) {
    var frame = byId('detailTrailerFrame');

    if (!frame || !frame.contentWindow || !command) {
        return;
    }

    frame.contentWindow.postMessage(JSON.stringify({
        event: 'command',
        func: command,
        args: args || []
    }), '*');
}

function stopDetailTrailerTimer() {
    if (state.detailTrailerTimer) {
        clearInterval(state.detailTrailerTimer);
        state.detailTrailerTimer = null;
    }
}

function startDetailTrailerTimer() {
    stopDetailTrailerTimer();
    state.detailTrailerTimer = setInterval(function() {
        if (state.detailTrailerMode === 'video') {
            readDetailTrailerVideoMetrics();
            renderDetailTrailerUi();
            return;
        }

        sendDetailTrailerCommand('getCurrentTime');
        sendDetailTrailerCommand('getDuration');
    }, 1000);
}

function resetDetailTrailerSurfaces() {
    var frame = byId('detailTrailerFrame');
    var video = byId('detailTrailerVideo');

    if (frame) {
        frame.classList.add('is-hidden');
        frame.removeAttribute('src');
    }
    if (video) {
        try {
            video.pause();
        } catch (error) {
            // no-op
        }
        video.classList.add('is-hidden');
        video.removeAttribute('src');
        try {
            video.load();
        } catch (loadError) {
            // no-op
        }
    }
}

function closeDetailTrailer() {
    stopDetailTrailerTimer();
    if (state.detailTrailerSyncTimer) {
        clearTimeout(state.detailTrailerSyncTimer);
        state.detailTrailerSyncTimer = null;
    }
    state.detailTrailerActive = false;
    state.detailTrailerPlaying = false;
    state.detailTrailerLoaded = false;
    state.detailTrailerResolving = false;
    state.detailTrailerMode = '';
    state.detailTrailerEmbedUrl = '';
    state.detailTrailerFallbackAttempted = false;
    state.detailTrailerCurrentSeconds = 0;
    state.detailTrailerDurationSeconds = 0;
    resetDetailTrailerSurfaces();
    renderDetailTrailerUi();
    if (state.currentView === 'addons' && typeof focusCurrent === 'function') {
        setTimeout(focusCurrent, 0);
    }
}

function resetDetailTrailerState(clearTrailer) {
    closeDetailTrailer();
    state.detailTrailerRequestKey = '';
    state.detailTrailerLoading = false;
    state.detailTrailerError = '';
    if (clearTrailer) {
        state.selectedTrailer = null;
    }
    renderDetailTrailerUi();
}

function startDetailTrailerIframe(src) {
    var frame = byId('detailTrailerFrame');
    var video = byId('detailTrailerVideo');

    state.detailTrailerMode = 'iframe';
    state.detailTrailerPlaying = true;
    state.detailTrailerLoaded = false;
    state.detailTrailerResolving = false;
    if (video) {
        video.classList.add('is-hidden');
        try {
            video.pause();
        } catch (error) {
            // no-op
        }
        video.removeAttribute('src');
    }
    renderDetailTrailerUi();
    scheduleDetailTrailerFrameSync();
    if (frame) {
        frame.classList.remove('is-hidden');
        frame.setAttribute('frameborder', '0');
        frame.setAttribute('scrolling', 'no');
        frame.onload = function() {
            state.detailTrailerLoaded = true;
            scheduleDetailTrailerFrameSync();
            sendDetailTrailerCommand('playVideo');
            startDetailTrailerTimer();
            renderDetailTrailerUi();
        };
        if (frame.getAttribute('src') !== src) {
            frame.setAttribute('src', src);
        }
    }
    startDetailTrailerTimer();
    setTimeout(function() {
        scheduleDetailTrailerFrameSync();
        sendDetailTrailerCommand('playVideo');
    }, 350);
}

function startDetailTrailerVideo(payload) {
    var frame = byId('detailTrailerFrame');
    var video = byId('detailTrailerVideo');
    var playPromise;

    if (!video || !payload || !payload.url) {
        startDetailTrailerIframe(state.detailTrailerEmbedUrl);
        return;
    }

    stopDetailTrailerTimer();
    if (frame) {
        frame.classList.add('is-hidden');
        frame.removeAttribute('src');
    }
    state.detailTrailerMode = 'video';
    state.detailTrailerPlaying = true;
    state.detailTrailerLoaded = false;
    state.detailTrailerResolving = false;
    state.detailTrailerDurationSeconds = Number(payload.duration || 0) || 0;
    state.detailTrailerCurrentSeconds = 0;
    video.classList.remove('is-hidden');
    video.onloadedmetadata = function() {
        state.detailTrailerLoaded = true;
        readDetailTrailerVideoMetrics();
        renderDetailTrailerUi();
    };
    video.ontimeupdate = function() {
        readDetailTrailerVideoMetrics();
        renderDetailTrailerUi();
    };
    video.onplay = function() {
        state.detailTrailerPlaying = true;
        renderDetailTrailerUi();
    };
    video.onpause = function() {
        state.detailTrailerPlaying = false;
        readDetailTrailerVideoMetrics();
        renderDetailTrailerUi();
    };
    video.onended = function() {
        readDetailTrailerVideoMetrics();
        closeDetailTrailer();
    };
    video.onerror = function() {
        if (!state.detailTrailerFallbackAttempted && state.detailTrailerEmbedUrl) {
            state.detailTrailerFallbackAttempted = true;
            startDetailTrailerIframe(state.detailTrailerEmbedUrl);
            return;
        }
        state.detailTrailerPlaying = false;
        state.detailTrailerResolving = false;
        setAddonsMessage('Trailer playback failed.', 'error');
        renderDetailTrailerUi();
    };
    if (video.getAttribute('src') !== payload.url) {
        video.setAttribute('src', payload.url);
        video.load();
    }
    scheduleDetailTrailerFrameSync();
    renderDetailTrailerUi();
    startDetailTrailerTimer();
    playPromise = video.play();
    if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(function() {
            state.detailTrailerPlaying = true;
            readDetailTrailerVideoMetrics();
            renderDetailTrailerUi();
        }).catch(function() {
            if (!state.detailTrailerFallbackAttempted && state.detailTrailerEmbedUrl) {
                state.detailTrailerFallbackAttempted = true;
                startDetailTrailerIframe(state.detailTrailerEmbedUrl);
            }
        });
    }
}

function openDetailTrailer() {
    var src;

    if (!state.selectedTrailer) {
        setAddonsMessage(state.detailTrailerLoading ? 'Loading trailer...' : 'No trailer was found for this title.', 'error');
        return;
    }

    src = buildDetailTrailerEmbedUrl(state.selectedTrailer);
    if (!src) {
        setAddonsMessage('This trailer cannot be played here.', 'error');
        return;
    }

    stopDetailTrailerTimer();
    resetDetailTrailerSurfaces();
    state.detailTrailerActive = true;
    state.detailTrailerPlaying = false;
    state.detailTrailerLoaded = false;
    state.detailTrailerResolving = true;
    state.detailTrailerMode = '';
    state.detailTrailerEmbedUrl = src;
    state.detailTrailerFallbackAttempted = false;
    state.detailTrailerCurrentSeconds = 0;
    state.detailTrailerDurationSeconds = 0;
    renderDetailTrailerUi();
    scheduleDetailTrailerFrameSync();

    requestDetailTrailerVideoStream(state.selectedTrailer).then(function(payload) {
        if (!state.detailTrailerActive || state.detailTrailerEmbedUrl !== src) {
            return;
        }
        startDetailTrailerVideo(payload);
    }).catch(function() {
        if (!state.detailTrailerActive || state.detailTrailerEmbedUrl !== src) {
            return;
        }
        startDetailTrailerIframe(src);
    });
}

function toggleDetailTrailerPlayback() {
    var video = byId('detailTrailerVideo');
    var playPromise;

    if (!state.detailTrailerActive) {
        openDetailTrailer();
        return;
    }
    if (state.detailTrailerMode === 'video' && video) {
        if (!video.paused && !video.ended) {
            video.pause();
            state.detailTrailerPlaying = false;
            renderDetailTrailerUi();
            return;
        }
        playPromise = video.play();
        state.detailTrailerPlaying = true;
        renderDetailTrailerUi();
        if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(function() {
                state.detailTrailerPlaying = false;
                renderDetailTrailerUi();
            });
        }
        return;
    }

    if (state.detailTrailerPlaying) {
        sendDetailTrailerCommand('pauseVideo');
        state.detailTrailerPlaying = false;
    } else {
        sendDetailTrailerCommand('playVideo');
        state.detailTrailerPlaying = true;
    }
    renderDetailTrailerUi();
}

function seekDetailTrailerBy(seconds) {
    var nextTime;
    var video = byId('detailTrailerVideo');

    if (!state.detailTrailerActive) {
        return;
    }

    nextTime = Math.max(0, Number(state.detailTrailerCurrentSeconds || 0) + Number(seconds || 0));
    if (state.detailTrailerDurationSeconds) {
        nextTime = Math.min(Number(state.detailTrailerDurationSeconds), nextTime);
    }
    state.detailTrailerCurrentSeconds = nextTime;
    if (state.detailTrailerMode === 'video' && video) {
        try {
            video.currentTime = nextTime;
        } catch (error) {
            // no-op
        }
        readDetailTrailerVideoMetrics();
        renderDetailTrailerUi();
        return;
    }
    sendDetailTrailerCommand('seekTo', [nextTime, true]);
    renderDetailTrailerUi();
}

function handleDetailTrailerMessage(event) {
    var data = event && event.data;
    var info;

    if (!state.detailTrailerActive || !data) {
        return;
    }
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch (error) {
            return;
        }
    }
    if (!data || data.event !== 'infoDelivery') {
        return;
    }

    info = data.info || {};
    if (typeof info.currentTime === 'number') {
        state.detailTrailerCurrentSeconds = info.currentTime;
    }
    if (typeof info.duration === 'number') {
        state.detailTrailerDurationSeconds = info.duration;
    }
    if (typeof info.playerState === 'number') {
        if (info.playerState === 0) {
            closeDetailTrailer();
            return;
        }
        state.detailTrailerPlaying = info.playerState === 1;
    }
    renderDetailTrailerUi();
}

function loadTrailerForSelection(type, id) {
    var requestKey = getDetailTrailerKey(type, id);
    var itemTrailer = getSelectedItemTrailerFallback();

    state.detailTrailerRequestKey = requestKey;
    state.detailTrailerLoading = true;
    state.detailTrailerError = '';
    state.selectedTrailer = itemTrailer;
    renderDetailTrailerUi();

    return requestDetailTrailer(type, id).then(function(trailer) {
        if (state.detailTrailerRequestKey !== requestKey) {
            return;
        }

        state.selectedTrailer = trailer || itemTrailer || getSelectedItemTrailerFallback() || null;
        state.detailTrailerLoading = false;
        renderDetailTrailerUi();
    }).catch(function(error) {
        if (state.detailTrailerRequestKey !== requestKey) {
            return;
        }

        state.detailTrailerLoading = false;
        state.detailTrailerError = error && error.message || 'Trailer request failed';
        state.selectedTrailer = itemTrailer || getSelectedItemTrailerFallback() || null;
        renderDetailTrailerUi();
    });
}

if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('message', handleDetailTrailerMessage);
    window.addEventListener('resize', function() {
        if (state.detailTrailerActive) {
            scheduleDetailTrailerFrameSync();
        }
    });
}

function mergeImdbApiTitleIntoItem(item, title) {
    var output = {};
    var poster = getImdbApiTitleImageUrl(title);
    var rating = getImdbApiTitleRating(title);
    var votes = getImdbApiTitleVoteCount(title);
    var runtime = getImdbApiTitleRuntime(title);
    var genres = Array.isArray(title && title.genres) ? title.genres.filter(Boolean) : [];

    Object.keys(item || {}).forEach(function(key) {
        output[key] = item[key];
    });

    if (!title) {
        return output;
    }

    output.id = output.id || title.id;
    output.imdb_id = output.imdb_id || title.id;
    output.name = output.name || title.primaryTitle || title.originalTitle;
    output.poster = output.poster || poster;
    output.background = output.background || poster;
    output.description = output.description || title.plot;
    output.releaseInfo = getImdbApiTitleReleaseInfo(title, output);
    output.year = output.year || getImdbApiTitleYear(title);
    if (rating !== null) {
        output.imdbRating = rating;
    }
    if (votes !== null) {
        output.imdbVotes = votes;
    }
    if (runtime) {
        output.runtime = output.runtime || runtime;
    }
    if (genres.length) {
        output.genres = genres;
        output.genre = genres;
    }

    return output;
}

function applySelectedImdbApiTitleToSelection() {
    if (!state.selectedItem || !state.selectedImdbApiTitle) {
        return;
    }

    state.selectedItem = mergeImdbApiTitleIntoItem(state.selectedItem, state.selectedImdbApiTitle);
}

function getCastImageUrl(credit) {
    return getSmallRemoteImageUrl(credit && credit.name && credit.name.primaryImage && credit.name.primaryImage.url);
}

function getSmallRemoteImageUrl(url) {
    var value = String(url || '');

    if (!value) {
        return '';
    }
    if (/m\.media-amazon\.com\/images\//i.test(value)) {
        return value.replace(/(\._V1)(?:_[^.]*)?(\.[a-z0-9]+)(\?.*)?$/i, '$1_SX160$2$3');
    }
    if (/image\.tmdb\.org\/t\/p\/(?:original|w\d+)\//i.test(value)) {
        return value.replace(/\/(?:original|w\d+)\//i, '/w185/');
    }

    return value;
}

function getCastInitials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);

    if (!parts.length) {
        return '?';
    }

    return parts.slice(0, 2).map(function(part) {
        return part.charAt(0).toUpperCase();
    }).join('');
}

function normalizeImdbApiCast(payload) {
    var seen = {};
    var limit = Math.max(1, Number(DETAIL_CAST_LIMIT || 10) || 10);
    var credits = payload && Array.isArray(payload.credits) ? payload.credits : [];
    var cast = [];

    credits.some(function(credit) {
        var name = credit && credit.name;
        var id = name && (name.id || name.displayName);
        var role;

        if (!name || !name.displayName || !id || seen[id]) {
            return false;
        }

        seen[id] = true;
        role = Array.isArray(credit.characters) && credit.characters.length
            ? credit.characters.join(', ')
            : credit.category || '';
        cast.push({
            id: id,
            name: name.displayName,
            image: getCastImageUrl(credit),
            role: role
        });

        return cast.length >= limit;
    });

    return cast;
}

function normalizeImdbApiTitleStars(title) {
    var limit = Math.max(1, Number(DETAIL_CAST_LIMIT || 10) || 10);
    var stars = title && Array.isArray(title.stars) ? title.stars : [];

    return stars.slice(0, limit).map(function(star) {
        return {
            id: star.id || star.displayName,
            name: star.displayName || '',
            image: getSmallRemoteImageUrl(star.primaryImage && star.primaryImage.url),
            role: ''
        };
    }).filter(function(member) {
        return !!member.name;
    });
}

function getCastRenderKey(cast) {
    return (cast || []).map(function(member) {
        return [
            member && member.id || '',
            member && member.name || '',
            member && member.image || '',
            member && member.role || ''
        ].join('~');
    }).join('|');
}

function renderDetailCast() {
    var section = byId('detailCastSection');
    var row = byId('detailCastRow');
    var renderKey;
    var fragment;

    if (!section || !row) {
        return;
    }

    if (!state.selectedItem || !state.selectedCast || !state.selectedCast.length) {
        row.innerHTML = '';
        row.setAttribute('data-cast-render-key', '');
        section.hidden = true;
        return;
    }

    section.hidden = false;
    renderKey = getCastRenderKey(state.selectedCast);
    if (row.getAttribute('data-cast-render-key') === renderKey && row.children.length === state.selectedCast.length) {
        return;
    }

    row.innerHTML = '';
    fragment = document.createDocumentFragment();
    state.selectedCast.forEach(function(member, index) {
        var wrapper = document.createElement('div');
        var avatar = document.createElement('div');
        var name = document.createElement('div');
        var role = document.createElement('div');
        var image;

        wrapper.className = 'cast-member';
        avatar.className = 'cast-avatar';
        if (member.image) {
            image = document.createElement('img');
            image.decoding = 'async';
            image.loading = 'eager';
            image.setAttribute('fetchpriority', index < 6 ? 'high' : 'auto');
            image.alt = member.name;
            image.src = member.image;
            image.onerror = function() {
                avatar.innerHTML = '';
                avatar.textContent = getCastInitials(member.name);
            };
            avatar.appendChild(image);
        } else {
            avatar.textContent = getCastInitials(member.name);
        }

        name.className = 'cast-name';
        name.textContent = member.name;
        role.className = 'cast-role';
        role.textContent = member.role || '';

        wrapper.appendChild(avatar);
        wrapper.appendChild(name);
        if (role.textContent) {
            wrapper.appendChild(role);
        }
        fragment.appendChild(wrapper);
    });
    row.appendChild(fragment);
    row.setAttribute('data-cast-render-key', renderKey);
}

function getDetailRelatedKey(type, id) {
    return normalizeAddonType(type) + ':' + String(id || '');
}

function normalizeRelatedTitleRoot(value) {
    var text = String(value || '').toLowerCase();

    text = text.replace(/&/g, ' and ');
    text = text.split(/\s*[:\-–—]\s*/)[0] || text;
    text = text.replace(/\([^)]*\)/g, ' ');
    text = text.replace(/\b(part|chapter|volume|vol|episode|book|season)\s+[ivxlcdm\d]+$/g, ' ');
    text = text.replace(/\b[ivxlcdm]{2,}|\b\d+$/g, ' ');
    text = text.replace(/[^a-z0-9]+/g, ' ');
    text = text.replace(/^\s*(the|a|an)\s+/g, '');
    text = text.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');

    return text.length >= 4 ? text : '';
}

function scoreLocalRelatedItem(candidate, selected) {
    var selectedRoot = normalizeRelatedTitleRoot(selected && selected.name);
    var candidateRoot = normalizeRelatedTitleRoot(candidate && candidate.name);
    var selectedGenres = typeof getItemGenreValues === 'function' ? getItemGenreValues(selected) : [];
    var candidateGenres = typeof getItemGenreValues === 'function' ? getItemGenreValues(candidate) : [];
    var selectedYear = parseInt(selected && (selected.year || selected.releaseInfo), 10) || 0;
    var candidateYear = parseInt(candidate && (candidate.year || candidate.releaseInfo), 10) || 0;
    var selectedRating = getItemImdbRatingNumber(selected);
    var candidateRating = getItemImdbRatingNumber(candidate);
    var score = 0;

    if (selectedRoot && candidateRoot && (selectedRoot === candidateRoot || candidateRoot.indexOf(selectedRoot + ' ') === 0 || selectedRoot.indexOf(candidateRoot + ' ') === 0)) {
        score += 120;
    }
    candidateGenres.forEach(function(genre) {
        if (selectedGenres.some(function(value) {
            return typeof genreValueMatchesLabel === 'function' ? genreValueMatchesLabel(value, genre) : String(value).toLowerCase() === String(genre).toLowerCase();
        })) {
            score += 18;
        }
    });
    if (selectedYear && candidateYear) {
        score += Math.max(0, 24 - Math.abs(selectedYear - candidateYear));
    }
    if (selectedRating && candidateRating) {
        score += Math.max(0, 16 - Math.abs(selectedRating - candidateRating) * 8);
    }

    return score;
}

function getLocalRelatedCandidates(type, id, limit) {
    var selected = state.selectedItem || {};
    var normalizedType = normalizeAddonType(type);
    var pools = normalizedType === 'series'
        ? [state.seriesBrowseItems, state.series, state.searchSeries]
        : [state.movieBrowseItems, state.movies, state.searchMovies];
    var seen = {};
    var candidates = [];

    state.libraryItems.forEach(function(entry) {
        if (normalizeAddonType(entry && entry.kind) === normalizedType && entry.item) {
            pools.push([entry.item]);
        }
    });

    pools.forEach(function(pool) {
        (pool || []).forEach(function(item) {
            var score;

            if (!item || !item.id || item.id === id || seen[item.id]) {
                return;
            }
            seen[item.id] = true;
            score = scoreLocalRelatedItem(item, selected);
            if (score <= 0) {
                return;
            }
            candidates.push({
                item: item,
                score: score
            });
        });
    });

    return candidates.sort(function(left, right) {
        return right.score - left.score;
    }).slice(0, limit).map(function(candidate) {
        var item = {};
        Object.keys(candidate.item).forEach(function(key) {
            item[key] = candidate.item[key];
        });
        item.__kind = normalizedType;
        return item;
    });
}

function normalizeRelatedItems(payload, type) {
    var normalizedType = normalizeAddonType(type);
    var items = payload && Array.isArray(payload.metas) ? payload.metas : [];

    return uniqueCatalogItems(items, DETAIL_RELATED_LIMIT).map(function(item) {
        item.__kind = normalizedType;
        return item;
    });
}

function getRelatedRenderKey(kind, items) {
    return normalizeAddonType(kind) + ':' + (items || []).map(function(item) {
        return item && item.id ? String(item.id) : '';
    }).join('|');
}

function requestDetailRelated(type, id) {
    var options = arguments[2] || {};
    var baseUrl = getImdbCatalogApiBaseUrl();
    var normalizedType = normalizeAddonType(type);
    var key = getDetailRelatedKey(normalizedType, id);
    var limit = Math.max(1, Number(DETAIL_RELATED_LIMIT || 12) || 12);
    var force = !!options.force;

    if (!id) {
        return Promise.resolve([]);
    }
    if (!force && Object.prototype.hasOwnProperty.call(detailRelatedCache, key)) {
        return Promise.resolve(detailRelatedCache[key]);
    }
    if (detailRelatedPending[key]) {
        return detailRelatedPending[key];
    }

    detailRelatedPending[key] = (baseUrl ? scheduleRequest('meta', function() {
        return requestJson(
            baseUrl
                + '/related/'
                + encodeURIComponent(normalizedType)
                + '/'
                + encodeURIComponent(String(id))
                + '?limit='
                + encodeURIComponent(String(limit)),
            'GET'
        );
    }).then(function(payload) {
        var remoteItems = normalizeRelatedItems(payload, normalizedType);
        return remoteItems.length ? remoteItems : getLocalRelatedCandidates(normalizedType, id, limit);
    }).catch(function() {
        return getLocalRelatedCandidates(normalizedType, id, limit);
    }) : Promise.resolve(getLocalRelatedCandidates(normalizedType, id, limit))).then(function(items) {
        items = items || [];
        if (items.length) {
            detailRelatedCache[key] = items;
        } else {
            delete detailRelatedCache[key];
        }
        delete detailRelatedPending[key];
        return items;
    }).catch(function(error) {
        delete detailRelatedPending[key];
        throw error;
    });

    return detailRelatedPending[key];
}

function formatRelatedMeta(item, kind) {
    var parts = [];
    var year = item && (item.year || item.releaseInfo);
    var rating = getItemImdbRatingNumber(item);
    var genre = typeof getItemGenreLabel === 'function' ? getItemGenreLabel(item, '') : '';

    if (year) {
        parts.push(String(year).slice(0, 4));
    }
    if (rating) {
        parts.push('IMDb ' + (rating.toFixed ? rating.toFixed(1) : String(rating)));
    }
    if (genre) {
        parts.push(genre.split(',')[0]);
    }

    return parts.join(' • ') || (kind === 'series' ? 'Series' : 'Movie');
}

function renderDetailRelated() {
    var section = byId('detailRelatedSection');
    var row = byId('detailRelatedRow');
    var title = byId('detailRelatedTitle');
    var kicker = byId('detailRelatedKicker');
    var count = byId('detailRelatedCount');
    var kind = normalizeAddonType(state.selectedType);
    var items = state.selectedRelatedItems || [];
    var renderKey;
    var fragment;

    if (!section || !row) {
        return;
    }

    if (!state.selectedItem || state.detailMode !== 'details' || !items.length || typeof createCard !== 'function') {
        row.innerHTML = '';
        row.setAttribute('data-related-render-key', '');
        section.hidden = true;
        markFocusRegistryDirty();
        return;
    }

    section.hidden = false;
    if (kicker) {
        kicker.textContent = 'More Like This';
    }
    if (title) {
        title.textContent = kind === 'series' ? 'Related series' : 'Related films';
    }
    if (count) {
        count.textContent = items.length + ' pick' + (items.length === 1 ? '' : 's');
    }

    renderKey = getRelatedRenderKey(kind, items);
    if (row.getAttribute('data-related-render-key') === renderKey && row.children.length === items.length) {
        return;
    }

    row.innerHTML = '';
    fragment = document.createDocumentFragment();
    items.forEach(function(item) {
        fragment.appendChild(createCard(item, item.__kind || kind, {
            className: 'related-card',
            hideSynopsis: true,
            disableTrailerPrefetch: true,
            metaText: formatRelatedMeta(item, item.__kind || kind),
            imageUrl: item.poster || item.posterPreview || item.background,
            fallbackImageUrl: item.background || item.poster
        }));
    });
    row.appendChild(fragment);
    row.setAttribute('data-related-render-key', renderKey);
    markFocusRegistryDirty();
}

function loadRelatedForSelection(type, id) {
    var options = arguments[2] || {};
    var requestKey = getDetailRelatedKey(type, id);

    state.detailRelatedRequestKey = requestKey;
    state.detailRelatedLoading = true;
    renderDetailRelated();

    return requestDetailRelated(type, id, options).then(function(items) {
        if (state.detailRelatedRequestKey !== requestKey) {
            return;
        }
        state.selectedRelatedItems = items || [];
        state.detailRelatedLoading = false;
        renderDetailRelated();
    }).catch(function() {
        if (state.detailRelatedRequestKey !== requestKey) {
            return;
        }
        state.selectedRelatedItems = [];
        state.detailRelatedLoading = false;
        renderDetailRelated();
    });
}

function loadImdbApiSelectionDetails(type, id) {
    var requestKey = getImdbApiDetailKey(type, id);

    requestImdbApiTitle(id).then(function(title) {
        if (state.selectedDetailRequestKey !== requestKey) {
            return;
        }

        state.selectedImdbApiTitle = title || null;
        if (!state.selectedCast.length) {
            state.selectedCast = normalizeImdbApiTitleStars(title);
        }
        applySelectedImdbApiTitleToSelection();
        renderAddons();
        if (!state.selectedRelatedItems.length && !state.detailRelatedLoading) {
            loadRelatedForSelection(type, id, {
                force: true
            });
        }
    }).catch(function() {});

    return requestImdbApiCredits(id).then(function(credits) {
        var cast;

        if (state.selectedDetailRequestKey !== requestKey) {
            return;
        }

        cast = normalizeImdbApiCast(credits);
        if (cast.length) {
            state.selectedCast = cast;
        } else if (!state.selectedCast.length) {
            state.selectedCast = normalizeImdbApiTitleStars(state.selectedImdbApiTitle);
        }
        renderAddons();
    }).catch(function() {
        if (state.selectedDetailRequestKey !== requestKey || state.selectedCast.length) {
            return;
        }

        state.selectedCast = normalizeImdbApiTitleStars(state.selectedImdbApiTitle);
        renderAddons();
    });
}

function renderAddons() {
    var detailArtwork = byId('detailArtwork');
    var selectedTypeSummary = byId('selectedTypeSummary');
    var detailPlayButton = byId('detailPlayButton');
    var detailEpisodesButton = byId('detailEpisodesButton');

    //byId('addonCount').textContent = String(state.addons.length);

    if (!state.selectedItem) {
        byId('selectedTitle').textContent = 'Nothing selected';
        byId('selectedTypeLabel').textContent = 'Choose a title';
        byId('selectedDescription').textContent = 'Pick a movie or show from the catalog pages to inspect addon streams here.';
        byId('selectedVideoLabel').textContent = 'No episode selected';
        if (selectedTypeSummary) {
            selectedTypeSummary.textContent = 'Choose a title';
        }
        detailPlayButton.textContent = 'Play';
        detailEpisodesButton.textContent = 'Episodes';
        detailEpisodesButton.style.display = 'none';
        detailEpisodesButton.disabled = true;
        detailEpisodesButton.setAttribute('aria-hidden', 'true');
        detailArtwork.style.backgroundImage = 'linear-gradient(180deg, rgba(9, 11, 17, 0.18), rgba(9, 11, 17, 0.42)), #0b0d14';
        renderDetailCast();
        renderDetailRelated();
    } else {
        byId('selectedTitle').textContent = state.selectedItem.name || 'Untitled';
        byId('selectedTypeLabel').textContent = getSelectedKindLabel();
        byId('selectedDescription').textContent =
            state.selectedItem.description ||
            state.selectedItem.releaseInfo ||
            'Installed addons and streams for the current selection appear below.';
        byId('selectedVideoLabel').textContent = getSelectedItemMetaLine();
        if (selectedTypeSummary) {
            selectedTypeSummary.textContent = getSelectedVideoSummary();
        }
        detailPlayButton.textContent = state.selectedType === 'series' ? 'Play Episode' : 'Play Movie';
        detailEpisodesButton.textContent = 'More Episodes';
        detailEpisodesButton.style.display = state.selectedType === 'series' ? '' : 'none';
        detailEpisodesButton.disabled = state.selectedType !== 'series';
        detailEpisodesButton.setAttribute('aria-hidden', state.selectedType === 'series' ? 'false' : 'true');
        detailArtwork.style.backgroundImage = state.selectedItem.background || state.selectedItem.poster
            ? 'linear-gradient(180deg, rgba(9, 11, 17, 0.18), rgba(9, 11, 17, 0.42)), url("' + (state.selectedItem.background || state.selectedItem.poster) + '")'
            : 'linear-gradient(180deg, rgba(9, 11, 17, 0.18), rgba(9, 11, 17, 0.42)), #0b0d14';
        renderDetailCast();
        renderDetailRelated();
    }

    updateLibraryButtonUi();
    renderDetailTrailerUi();
    renderEpisodeBrowserForMode();
    renderStreamList();
    applyDetailMode();
    markFocusRegistryDirty();
}

function renderPlayerState() {
    var video = byId('videoPlayer');
    var empty = byId('videoEmpty');
    var stream = state.currentStream;
    setPlayerToggleUi(false);
    setPlayerNextEpisodeUi();

    if (!stream) {
        resetTrackState();
        byId('playerTitle').textContent = 'No stream selected';
        byId('playerControlTitle').textContent = 'No stream selected';
        byId('playerAddon').textContent = '-';
        byId('playerSource').textContent = '-';
        setPlayerStatus('Idle');
        empty.classList.remove('is-hidden');
        empty.textContent = 'Pick an addon stream to open the player.';
        byId('playerDescription').textContent =
            'This player page is for direct stream URLs. Some addon entries may still require a proxy or native playback layer.';
        clearPlaybackSurface();
        renderTrackSelectors();
        setPlayerNextEpisodeUi();
        return;
    }

    byId('playerTitle').textContent = stream.title;
    byId('playerControlTitle').textContent = getPlayerContentTitle();
    byId('playerAddon').textContent = stream.addonName;
    byId('playerSource').textContent = stream.raw && stream.raw.url ? stream.raw.url : stream.status;
    byId('playerDescription').textContent =
        stream.description || 'This stream came from the selected addon source.';
    syncExternalSubtitleTracks();

    if (stream.placeholder) {
        empty.classList.remove('is-hidden');
        empty.textContent = stream.status || 'Finding stream...';
        clearPlaybackSurface();
        setPlayerStatus(stream.status || 'Finding stream...');
        renderTrackSelectors();
        setPlayerNextEpisodeUi();
        return;
    }

    if (!stream.playable || !stream.raw || !stream.raw.url) {
        empty.classList.remove('is-hidden');
        empty.textContent = 'This stream is not directly playable in the web shell. It likely needs a proxy or native playback pipeline.';
        clearPlaybackSurface();
        setPlayerStatus(stream.status);
        renderTrackSelectors();
        setPlayerNextEpisodeUi();
        return;
    }

    empty.classList.add('is-hidden');
    video.classList.remove('is-hidden');
    renderTrackSelectors();
    setPlayerNextEpisodeUi();
}

function setResumeLookupPlayerStatus(message) {
    var title;
    var description;

    if (!state.resumeAutoplayInPlayer) {
        return;
    }

    title = state.selectedItem && state.selectedItem.name ? state.selectedItem.name : 'Resume watching';
    description = state.selectedVideo && state.selectedVideo.title
        ? state.selectedVideo.title
        : 'Preparing your saved playback.';

    state.currentStream = {
        addonName: '',
        playable: false,
        placeholder: true,
        status: message || 'Finding stream...',
        title: title,
        description: description
    };
    renderPlayerState();
    setView('player', {
        focusRegion: 'main',
        resetMain: true
    });
    showPlayerChrome(true);
}

function failResumeLookupInPlayer(message) {
    if (!state.resumeAutoplayInPlayer) {
        return false;
    }

    state.autoplayPending = false;
    state.pendingResumePositionMs = 0;
    state.pendingResumeStream = null;
    setResumeLookupPlayerStatus(message || 'Could not resume this stream.');
    state.resumeAutoplayInPlayer = false;
    return true;
}

function startHtml5Stream(url) {
    var video = byId('videoPlayer');
    var playPromise;

    stopAvplayPlayback();
    byId('avplaySurface').classList.remove('is-active');
    video.classList.remove('is-hidden');
    state.playerMode = 'html5';
    resetWindowedAvplayFrame();

    if (video.getAttribute('src') !== url) {
        video.src = url;
        video.load();
    }

    setPlayerStatus('Loading (HTML5)');
    resetPlaybackMetrics();
    playPromise = video.play();
    if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(function() {
            state.suppressNextHtml5AbortDiagnostic = false;
            setPlayerStatus('Playing (HTML5)');
            setPlayerToggleUi(true);
            readHtml5Metrics();
            startPlaybackTicker();
            scheduleTrackRefresh();
            applyPendingResumeSeek();
        }).catch(function(error) {
            if (state.suppressNextHtml5AbortDiagnostic && error && error.name === 'AbortError') {
                state.suppressNextHtml5AbortDiagnostic = false;
                return;
            }
            state.suppressNextHtml5AbortDiagnostic = false;
            setPlayerStatus('Play blocked: ' + error.message);
            setPlayerToggleUi(false);
            appendPlayerDiagnostic('error', 'HTML5 play failed', error);
        });
    } else {
        setPlayerToggleUi(true);
        readHtml5Metrics();
        startPlaybackTicker();
        scheduleTrackRefresh();
        applyPendingResumeSeek();
    }
}

function startAvplayStream(url) {
    var video = byId('videoPlayer');
    var surface = byId('avplaySurface');

    if (!hasAvplay()) {
        appendPlayerDiagnostic('warn', 'AVPlay is unavailable, using HTML5', getUrlFilename(url) || url);
        startHtml5Stream(url);
        return;
    }

    stopHtml5Playback();
    stopAvplayPlayback();
    surface.classList.add('is-active');
    video.classList.add('is-hidden');
    state.playerMode = 'avplay';

    try {
        appendPlayerDiagnostic('info', 'Opening stream with AVPlay', getUrlFilename(url) || url);
        webapis.avplay.open(url);
        appendPlayerDiagnostic('success', 'AVPlay open accepted', getUrlFilename(url) || url);
        webapis.avplay.setListener({
            onbufferingstart: function() {
                setPlayerStatus('Buffering (AVPlay)');
            },
            onbufferingprogress: function() {
                setPlayerStatus('Buffering (AVPlay)');
            },
            onbufferingcomplete: function() {
                setPlayerStatus('Ready (AVPlay)');
                readAvplayMetrics();
                refreshPlaybackTracks();
            },
            oncurrentplaytime: function(currentTime) {
                setPlaybackMetrics(getTimelineCurrentMs(currentTime), getTimelineDurationMs(state.durationMs));
            },
            onstreamcompleted: function() {
                readAvplayMetrics();
                saveCurrentPlaybackProgress(true);
                setPlayerToggleUi(false);
                setPlayerStatus('Finished');
            },
            onerror: function(error) {
                setPlayerToggleUi(false);
                setPlayerStatus('AVPlay error: ' + error);
                appendPlayerDiagnostic('error', 'AVPlay runtime error', error);
                startHtml5Stream(url);
            }
        });

        scheduleAvplayRectSync();
        setPlayerStatus('Loading (AVPlay)');
        resetPlaybackMetrics();
        webapis.avplay.prepareAsync(function() {
            scheduleAvplayRectSync();
            try {
                webapis.avplay.play();
                setPlayerStatus('Playing (AVPlay)');
                setPlayerToggleUi(true);
                appendPlayerDiagnostic('success', 'AVPlay playback started', getUrlFilename(url) || url);
                readAvplayMetrics();
                startPlaybackTicker();
                scheduleTrackRefresh();
                applyPendingResumeSeek();
            } catch (playError) {
                setPlayerToggleUi(false);
                setPlayerStatus('AVPlay play failed');
                appendPlayerDiagnostic('error', 'AVPlay play failed', playError);
                startHtml5Stream(url);
            }
        }, function(error) {
            setPlayerToggleUi(false);
            setPlayerStatus('AVPlay prepare failed');
            appendPlayerDiagnostic('error', 'AVPlay prepare failed', error);
            startHtml5Stream(url);
        });
    } catch (error) {
        setPlayerToggleUi(false);
        setPlayerStatus('AVPlay unavailable, using HTML5');
        appendPlayerDiagnostic('error', 'AVPlay open failed', error);
        startHtml5Stream(url);
    }
}

function toggleCurrentPlayback() {
    var video = byId('videoPlayer');

    showPlayerChrome(false);

    if (!state.currentStream || !state.currentStream.playable || !state.currentStream.raw || !state.currentStream.raw.url) {
        setPlayerStatus('No playable stream selected');
        return;
    }

    if (state.playerMode === 'avplay' && hasAvplay()) {
        try {
            if (byId('playerToggleButton').getAttribute('data-state') !== 'pause') {
                webapis.avplay.play();
                setPlayerToggleUi(true);
                setPlayerStatus('Playing (AVPlay)');
            } else {
                webapis.avplay.pause();
                readAvplayMetrics();
                saveCurrentPlaybackProgress(true);
                setPlayerToggleUi(false);
                setPlayerStatus('Paused (AVPlay)');
            }
        } catch (error) {
            setPlayerStatus('AVPlay toggle failed');
        }
        return;
    }

    if (video.paused) {
        video.play().then(function() {
            setPlayerToggleUi(true);
            setPlayerStatus('Playing (HTML5)');
        }).catch(function(error) {
            setPlayerStatus('Play blocked: ' + error.message);
        });
    } else {
        video.pause();
        setPlayerToggleUi(false);
        setPlayerStatus('Paused');
    }
}

function loadCurrentStream() {
    if (!state.currentStream || !state.currentStream.playable || !state.currentStream.raw || !state.currentStream.raw.url) {
        setPlayerStatus(state.currentStream ? state.currentStream.status : 'Idle');
        return;
    }

    resetTrackState();
    resetTranscodedPlaybackState();
    syncExternalSubtitleTracks();
    renderTrackSelectors();
    refreshSubtitleAddonsForCurrentStream();

    if (hasAvplay()) {
        startAvplayStream(state.currentStream.raw.url);
    } else {
        startHtml5Stream(state.currentStream.raw.url);
    }
}

function openStream(streamEntry) {
    resetTrackState();
    clearPlayerDiagnostics();
    state.resumeAutoplayInPlayer = false;
    state.currentStream = streamEntry;
    state.lastProgressSavedAt = 0;
    state.lastProgressSavedPositionMs = 0;
    renderPlayerState();
    setView('player', {
        focusRegion: 'main',
        resetMain: true
    });
    showPlayerChrome(true);

    if (streamEntry.playable && streamEntry.raw && streamEntry.raw.url) {
        loadCurrentStream();
    } else {
        setPlayerStatus(streamEntry.status);
    }
}

function renderCatalogViews() {
    renderContinueWatching();
    renderHomeRailWindow('homeMovieRail', state.movies.slice(0, HOME_CATALOG_LIMIT).map(function(item) {
        return { item: item, kind: 'movie' };
    }), 'movies');
    renderHomeRailWindow('homeSeriesRail', state.series.slice(0, HOME_CATALOG_LIMIT).map(function(item) {
        return { item: item, kind: 'series' };
    }), 'series');

    byId('homeMovieCount').textContent = state.movies.length + ' ready';
    byId('homeSeriesCount').textContent = state.series.length + ' ready';
    refreshFeaturedRotation();
}

function fetchMetaFromAddons(type, id) {
    var eligibleAddons = state.addons.filter(function(addon) {
        return addonSupportsResource(addon, ['meta'], type, id);
    });

    function requestNext(index) {
        var addon = eligibleAddons[index];
        var baseUrl;

        if (!addon) {
            return Promise.reject(new Error('No metadata addon returned details for this title.'));
        }

        baseUrl = addonBaseUrl(addon.transportUrl);
        if (!baseUrl) {
            return requestNext(index + 1);
        }

        return scheduleRequest('meta', function() {
            return requestJson(
                baseUrl + '/meta/' + encodeURIComponent(type) + '/' + encodeURIComponent(id) + '.json',
                'GET'
            );
        }).then(function(payload) {
            var meta = payload && payload.meta ? payload.meta : payload;

            if (!meta) {
                throw new Error('Missing meta');
            }

            return meta;
        }).catch(function() {
            return requestNext(index + 1);
        });
    }

    return requestNext(0);
}

function getResumePositionMsFromEntry(entry) {
    return entry && typeof entry.position === 'number'
        ? Math.max(0, Math.round(entry.position * 1000))
        : 0;
}

function streamsMatchByUrl(left, right) {
    var leftUrl = left && left.raw && left.raw.url ? String(left.raw.url) : '';
    var rightUrl = right && right.raw && right.raw.url ? String(right.raw.url) : '';

    return !!(leftUrl && rightUrl && leftUrl === rightUrl);
}

function getPendingResumeStreamCandidate() {
    var savedStream = state.pendingResumeStream;
    var matchingStream;

    if (!savedStream || !savedStream.raw || !savedStream.raw.url) {
        return null;
    }

    matchingStream = state.streams.filter(function(entry) {
        return entry.playable && streamsMatchByUrl(entry, savedStream);
    })[0];

    if (matchingStream) {
        return matchingStream;
    }

    return savedStream.playable !== false ? savedStream : null;
}

function findResumeVideo(entry) {
    var targetVideo = entry && entry.video ? entry.video : null;
    var targetSeason;
    var targetEpisode;
    var byId;

    if (!targetVideo || !state.allSeriesVideos.length) {
        return null;
    }

    if (targetVideo.id) {
        byId = state.allSeriesVideos.filter(function(video) {
            return video.id === targetVideo.id;
        })[0];
        if (byId) {
            return byId;
        }
    }

    targetSeason = getVideoSeason(targetVideo);
    targetEpisode = getVideoEpisode(targetVideo);
    return state.allSeriesVideos.filter(function(video) {
        return getVideoSeason(video) === targetSeason && getVideoEpisode(video) === targetEpisode;
    })[0] || null;
}

function applyResumeVideoSelection(entry) {
    var video = findResumeVideo(entry);

    if (!video) {
        return false;
    }

    state.selectedSeason = getVideoSeason(video);
    state.selectedVideo = video;
    return true;
}

function resumeContinueEntry(entry) {
    var normalized = normalizeContinueEntry(entry);

    if (!normalized) {
        return;
    }
    if (resumeContinueEntryDirectly(normalized)) {
        return;
    }

    prepareSelection(normalized.item, normalized.kind, {
        autoplayFirst: true,
        resumeEntry: normalized,
        resumePositionMs: getResumePositionMsFromEntry(normalized),
        resumeInPlayer: true
    });
}

function getDirectResumeVideo(entry) {
    if (!entry || !entry.item) {
        return null;
    }

    if (entry.video && entry.video.id) {
        return {
            id: entry.video.id,
            title: entry.video.title || entry.item.name || '',
            season: getVideoSeason(entry.video),
            episode: getVideoEpisode(entry.video)
        };
    }

    if (normalizeAddonType(entry.kind) === 'movie') {
        return {
            id: entry.item.id,
            title: entry.item.name || ''
        };
    }

    return null;
}

function applySavedResumeVideoFallback(entry) {
    var video = getDirectResumeVideo(entry);

    if (!video || normalizeAddonType(entry && entry.kind) !== 'series') {
        return false;
    }

    state.allSeriesVideos = [video];
    state.availableSeasons = [getVideoSeason(video)];
    state.selectedSeason = getVideoSeason(video);
    state.selectedEpisodes = [video];
    state.selectedVideo = video;
    return true;
}

function getSeriesVideosFromMeta(meta) {
    return meta && Array.isArray(meta.videos) ? meta.videos.slice() : [];
}

function getAvailableSeasonsFromVideos(videos) {
    return uniqueList((videos || []).map(getVideoSeason)).sort(function(left, right) {
        return left - right;
    });
}

function setSeriesVideos(videos) {
    state.allSeriesVideos = (videos || []).slice();
    state.availableSeasons = getAvailableSeasonsFromVideos(state.allSeriesVideos);
}

function ensureSeriesVideoAvailable(video) {
    if (!video || !video.id) {
        return;
    }

    if (state.allSeriesVideos.some(function(candidate) {
        return candidate && candidate.id === video.id;
    })) {
        return;
    }

    setSeriesVideos(state.allSeriesVideos.concat([video]));
}

function applyDirectSeriesResumeMetadata(entry, meta) {
    var videos = getSeriesVideosFromMeta(meta);
    var currentVideo = state.selectedVideo || getDirectResumeVideo(entry);
    var matchedVideo;

    if (!entry || !entry.item || !videos.length || !currentVideo) {
        return false;
    }

    state.selectedItem = meta || state.selectedItem || entry.item;
    applySelectedItemFallbacks(entry.item);
    applySelectedImdbApiTitleToSelection();
    setSeriesVideos(videos);

    matchedVideo = findResumeVideo({ video: currentVideo }) || findResumeVideo(entry);
    if (matchedVideo) {
        state.selectedSeason = getVideoSeason(matchedVideo);
        state.selectedVideo = matchedVideo;
    } else {
        state.selectedSeason = getVideoSeason(currentVideo);
        state.selectedVideo = currentVideo;
        ensureSeriesVideoAvailable(currentVideo);
    }

    updateSelectedEpisodesForSeason();
    return true;
}

function isSameSeriesEpisode(left, right) {
    if (!left || !right) {
        return false;
    }
    if (left.id && right.id && left.id === right.id) {
        return true;
    }
    return getVideoSeason(left) === getVideoSeason(right)
        && getVideoEpisode(left) === getVideoEpisode(right);
}

function isDirectSeriesResumeSelectionCurrent(entry, requestKey, resumeVideo) {
    return !!(entry && entry.item
        && state.selectedType === 'series'
        && state.selectedItem
        && state.selectedItem.id === entry.item.id
        && state.selectedDetailRequestKey === requestKey
        && isSameSeriesEpisode(state.selectedVideo, resumeVideo));
}

function hydrateDirectSeriesResumeMetadata(entry) {
    var requestKey;
    var resumeVideo;

    if (!entry || normalizeAddonType(entry.kind) !== 'series' || !entry.item || !entry.item.id) {
        return;
    }

    requestKey = state.selectedDetailRequestKey;
    resumeVideo = state.selectedVideo || getDirectResumeVideo(entry);
    fetchMetaFromAddons('series', entry.item.id).then(function(payload) {
        var meta = payload && payload.meta ? payload.meta : payload;

        if (!isDirectSeriesResumeSelectionCurrent(entry, requestKey, resumeVideo)) {
            return;
        }
        if (!applyDirectSeriesResumeMetadata(entry, meta)) {
            return;
        }

        setPlayerNextEpisodeUi();
        if (state.currentView === 'addons') {
            renderAddons();
        }
    }).catch(function() {
        // Direct resume already has a playable stream; metadata hydration only enables episode navigation.
    });
}

function resumeContinueEntryDirectly(entry) {
    var stream = entry && entry.stream;
    var kind = normalizeAddonType(entry && entry.kind);
    var video = getDirectResumeVideo(entry);

    if (!entry || !entry.item || !kind || !video || !stream || stream.playable === false || !stream.raw || !stream.raw.url) {
        return false;
    }

    captureBrowseReturnState();
    state.selectedItem = entry.item;
    state.selectedType = kind;
    state.selectedImdbApiTitle = null;
    state.selectedCast = [];
    state.selectedRelatedItems = [];
    state.detailRelatedLoading = false;
    state.detailRelatedRequestKey = '';
    state.selectedDetailRequestKey = getImdbApiDetailKey(kind, entry.item.id);
    state.detailMode = 'details';
    state.allSeriesVideos = kind === 'series' ? [video] : [];
    state.availableSeasons = kind === 'series' ? [getVideoSeason(video)] : [];
    state.selectedSeason = kind === 'series' ? getVideoSeason(video) : null;
    state.selectedEpisodes = kind === 'series' ? [video] : [];
    state.selectedVideo = video;
    state.streams = [stream];
    state.autoplayPending = false;
    state.pendingResumePositionMs = getResumePositionMsFromEntry(entry);
    state.pendingResumeStream = null;

    openStream(stream);
    if (kind === 'series') {
        hydrateDirectSeriesResumeMetadata(entry);
    }
    return true;
}

function prepareSelection(item, type, options) {
    var resumeEntry = options && options.resumeEntry ? normalizeContinueEntry(options.resumeEntry) : null;
    var resumePositionMs = options && typeof options.resumePositionMs === 'number'
        ? Math.max(0, options.resumePositionMs)
        : getResumePositionMsFromEntry(resumeEntry);
    var resumeInPlayer = !!(options && options.resumeInPlayer);
    var detailRequestKey;

    function loadSelectionAuxiliaryDetails() {
        if (state.selectedDetailRequestKey !== detailRequestKey) {
            return;
        }
        loadRelatedForSelection(type, item && item.id);
        setTimeout(function() {
            if (state.selectedDetailRequestKey !== detailRequestKey) {
                return;
            }
            loadTrailerForSelection(type, item && item.id);
        }, 40);
        setTimeout(function() {
            if (state.selectedDetailRequestKey !== detailRequestKey) {
                return;
            }
            loadImdbApiSelectionDetails(type, item && item.id);
        }, 90);
    }

    captureBrowseReturnState();
    resetDetailTrailerState(true);
    state.selectedItem = item;
    state.selectedType = type;
    state.selectedImdbApiTitle = null;
    state.selectedCast = [];
    state.selectedRelatedItems = [];
    state.detailRelatedLoading = false;
    state.detailRelatedRequestKey = '';
    state.selectedDetailRequestKey = getImdbApiDetailKey(type, item && item.id);
    state.detailMode = 'details';
    state.allSeriesVideos = [];
    state.availableSeasons = [];
    state.selectedSeason = null;
    state.selectedEpisodes = [];
    state.selectedVideo = null;
    state.streams = [];
    state.autoplayPending = !!(options && options.autoplayFirst);
    state.pendingResumePositionMs = state.autoplayPending ? resumePositionMs : 0;
    state.pendingResumeStream = state.autoplayPending && resumeEntry && resumeEntry.stream ? resumeEntry.stream : null;
    state.resumeAutoplayInPlayer = state.autoplayPending && resumeInPlayer;
    detailRequestKey = state.selectedDetailRequestKey;
    renderAddons();

    if (state.resumeAutoplayInPlayer) {
        setResumeLookupPlayerStatus('Finding saved stream...');
        setTimeout(loadSelectionAuxiliaryDetails, 0);
    } else {
        setView('addons', {
            focusRegion: 'main',
            resetMain: true
        });
        setAddonsMessage('Loading selection details...', null);
        setTimeout(focusCurrent, 0);
        setTimeout(loadSelectionAuxiliaryDetails, 120);
    }

    if (type === 'series') {
        fetchMetaFromAddons('series', item.id)
            .then(function(payload) {
                var meta = payload && payload.meta ? payload.meta : payload;
                var matchedResumeVideo;
                state.selectedItem = meta || item;
                applySelectedItemFallbacks(item);
                applySelectedImdbApiTitleToSelection();
                setSeriesVideos(getSeriesVideosFromMeta(meta));
                state.selectedSeason = state.availableSeasons.length ? state.availableSeasons[0] : null;
                matchedResumeVideo = applyResumeVideoSelection(resumeEntry);
                if (state.autoplayPending && resumeEntry && resumeEntry.video && !matchedResumeVideo && applySavedResumeVideoFallback(resumeEntry)) {
                    renderAddons();
                    loadStreamsForSelection();
                    return;
                }
                updateSelectedEpisodesForSeason();
                renderAddons();
                if (!state.selectedVideo) {
                    state.pendingResumePositionMs = 0;
                    state.pendingResumeStream = null;
                    if (!failResumeLookupInPlayer('No episode metadata was returned for this series.')) {
                        setAddonsMessage('No episode metadata was returned for this series.', 'error');
                    }
                    return;
                }
                if (state.autoplayPending) {
                    setResumeLookupPlayerStatus('Loading episode streams...');
                    loadStreamsForSelection();
                    return;
                }
                setAddonsMessage('Choose More Episodes to pick an episode, or Play to start the first episode.', null);
            }).catch(function(error) {
                if (state.autoplayPending && applySavedResumeVideoFallback(resumeEntry)) {
                    renderAddons();
                    setResumeLookupPlayerStatus('Loading episode streams...');
                    loadStreamsForSelection();
                    return;
                }
                renderAddons();
                if (!failResumeLookupInPlayer('Series metadata failed: ' + error.message)) {
                    setAddonsMessage('Series metadata failed: ' + error.message, 'error');
                }
            });
        return;
    }

    state.selectedVideo = {
        id: item.id,
        title: item.name
    };
    state.detailMode = 'details';
    renderAddons();
    fetchMetaFromAddons('movie', item.id)
        .then(function(payload) {
            var meta = payload && payload.meta ? payload.meta : payload;

            state.selectedItem = meta || item;
            applySelectedItemFallbacks(item);
            applySelectedImdbApiTitleToSelection();
            state.selectedVideo = {
                id: state.selectedItem.id || item.id,
                title: state.selectedItem.name || item.name
            };
            renderAddons();
            if (state.autoplayPending) {
                setResumeLookupPlayerStatus('Loading movie streams...');
                loadStreamsForSelection();
                return;
            }
            setAddonsMessage('Ready. Press Sources to load streams, or Play to start playback.', null);
        }).catch(function(error) {
            renderAddons();
            if (!state.resumeAutoplayInPlayer) {
                setAddonsMessage('Movie metadata failed: ' + error.message, 'error');
            }
            if (state.autoplayPending) {
                setResumeLookupPlayerStatus('Loading movie streams...');
                loadStreamsForSelection();
            }
        });
}

function loadStreamsForSelection(options) {
    var type = state.selectedType;
    var videoId = state.selectedVideo && state.selectedVideo.id;
    var eligibleAddons;
    var shouldFocusStreams = !!(options && options.focusStreams);

    if (!state.selectedItem || !type || !videoId) {
        state.pendingResumePositionMs = 0;
        state.pendingResumeStream = null;
        if (!failResumeLookupInPlayer('Choose a title first.')) {
            setAddonsMessage('Choose a title first.', 'error');
        }
        return Promise.resolve();
    }

    eligibleAddons = getStreamCapableAddons(type, videoId);
    if (!eligibleAddons.length) {
        var savedPlayable = state.autoplayPending ? getPendingResumeStreamCandidate() : null;
        var noAddonMessage = state.authKey
            ? 'No linked addons expose stream resources for this selection.'
            : 'No stream addons are available yet. Sign in with Nuvio to sync your addon collection.';
        state.autoplayPending = false;
        if (savedPlayable) {
            state.pendingResumeStream = null;
            openPlayableOrBridgeStream(savedPlayable);
            return Promise.resolve();
        }
        state.streams = [];
        state.pendingResumePositionMs = 0;
        state.pendingResumeStream = null;
        renderStreamList();
        if (!failResumeLookupInPlayer(noAddonMessage)) {
            setAddonsMessage(noAddonMessage, 'error');
        }
        if (shouldFocusStreams && state.selectedType === 'series') {
            state.detailMode = 'episodes';
            renderAddons();
            state.focusRegion = 'main';
            state.mainRow = getSelectedEpisodeMainRow();
            state.mainCol = state.availableSeasons.length && state.selectedEpisodes.length ? 1 : 0;
            setTimeout(focusCurrent, 0);
        }
        return Promise.resolve();
    }

    state.streams = [];
    renderStreamList();
    setResumeLookupPlayerStatus('Loading streams from ' + eligibleAddons.length + ' addon(s)...');
    setAddonsMessage('Loading streams from ' + eligibleAddons.length + ' addon(s)...', null);

    return Promise.all(eligibleAddons.map(function(addon) {
        return fetchStreamsFromAddon(addon, type, videoId);
    })).then(function(streamGroups) {
        state.streams = [];
        streamGroups.forEach(function(group) {
            state.streams = state.streams.concat(group);
        });

        renderStreamList();

        if (state.streams.length) {
            var visibleStreams = getVisibleStreams();
            setAddonsMessage(
                visibleStreams.length === state.streams.length
                    ? 'Loaded ' + state.streams.length + ' stream entries.'
                    : 'Loaded ' + visibleStreams.length + ' of ' + state.streams.length + ' stream entries.',
                'success'
            );
            if (state.autoplayPending) {
                var resumeStream = getPendingResumeStreamCandidate();
                state.autoplayPending = false;
                var playable = resumeStream || getPreferredVisibleStream();
                if (playable) {
                    state.pendingResumeStream = null;
                    openPlayableOrBridgeStream(playable);
                    return;
                }
                state.pendingResumePositionMs = 0;
                state.pendingResumeStream = null;
                if (failResumeLookupInPlayer('No directly playable stream was returned.')) {
                    return;
                }
            }
            if (shouldFocusStreams) {
                state.focusRegion = 'main';
                state.mainRow = visibleStreams.length ? getFirstStreamMainRow() : Math.max(0, getFirstStreamMainRow() - 1);
                state.mainCol = 0;
            }
            setTimeout(focusCurrent, 0);
        } else {
            var savedPlayable = state.autoplayPending ? getPendingResumeStreamCandidate() : null;
            state.autoplayPending = false;
            if (savedPlayable) {
                state.pendingResumeStream = null;
                openPlayableOrBridgeStream(savedPlayable);
                return;
            }
            state.pendingResumePositionMs = 0;
            state.pendingResumeStream = null;
            if (!failResumeLookupInPlayer('No stream entries were returned.')) {
                setAddonsMessage('No stream entries were returned.', 'error');
            }
            if (shouldFocusStreams) {
                if (state.selectedType === 'series') {
                    state.detailMode = 'episodes';
                    renderAddons();
                }
                state.focusRegion = 'main';
                state.mainRow = getSelectedEpisodeMainRow();
                state.mainCol = state.availableSeasons.length && state.selectedEpisodes.length ? 1 : 0;
                setTimeout(focusCurrent, 0);
            }
        }
    });
}
