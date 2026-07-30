function fetchCurrentSupabaseUser() {
    if (!state.authKey) {
        return Promise.resolve(null);
    }

    return requestSupabaseWithSession('/auth/v1/user', 'GET').then(function(payload) {
        return payload && payload.user ? payload.user : payload;
    });
}

function fetchCurrentSupabaseUserForToken(token) {
    if (!token) {
        return Promise.resolve(null);
    }

    return requestSupabaseWithToken('/auth/v1/user', 'GET', null, token).then(function(payload) {
        return payload && payload.user ? payload.user : payload;
    }).catch(function() {
        return null;
    });
}

function fetchEffectiveOwnerId() {
    if (!state.authKey) {
        state.ownerId = null;
        return Promise.resolve(null);
    }
    if (state.ownerId) {
        return Promise.resolve(state.ownerId);
    }

    return requestSupabaseWithSession('/rest/v1/rpc/get_sync_owner', 'POST', {}).then(function(payload) {
        state.ownerId = payload;
        return payload;
    });
}

function fetchAddonUrlsFromNuvio() {
    if (!state.authKey) {
        return Promise.resolve(DEFAULT_ADDON_URLS.slice());
    }

    return fetchEffectiveOwnerId().then(function(ownerId) {
        if (!ownerId) {
            return DEFAULT_ADDON_URLS.slice();
        }

        return requestSupabaseWithSession(
            '/rest/v1/addons?user_id=eq.' + encodeURIComponent(ownerId) + '&profile_id=eq.1&select=url,sort_order&order=sort_order.asc',
            'GET'
        ).then(function(rows) {
            var urls = extractAddonUrls(rows);

            if (urls.length) {
                return urls;
            }

            return DEFAULT_ADDON_URLS.slice();
        }).catch(function(error) {
            if (!isMissingSupabaseResource(error)) {
                throw error;
            }

            return requestSupabaseWithSession(
                '/rest/v1/tv_addons?owner_id=eq.' + encodeURIComponent(ownerId) + '&select=base_url,position&order=position.asc',
                'GET'
            ).then(function(rows) {
                var urls = extractAddonUrls(rows);

                if (urls.length) {
                    return urls;
                }

                return DEFAULT_ADDON_URLS.slice();
            }).catch(function(tvError) {
                if (!isMissingSupabaseResource(tvError)) {
                    throw tvError;
                }

                return requestSupabaseWithSession('/rest/v1/rpc/sync_pull_addons', 'POST', {
                    p_profile_id: 1
                }).then(function(rows) {
                    var urls = extractAddonUrls(rows);

                    if (urls.length) {
                        return urls;
                    }

                    return DEFAULT_ADDON_URLS.slice();
                }).catch(function() {
                    return DEFAULT_ADDON_URLS.slice();
                });
            });
        });
    });
}

function buildWatchProgressKey(kind, itemId, video) {
    var normalizedKind = normalizeAddonType(kind);
    var season;
    var episode;

    if (normalizedKind !== 'series') {
        return itemId || '';
    }

    season = getVideoSeason(video);
    episode = getVideoEpisode(video);
    return itemId + '_s' + season + 'e' + episode;
}

function buildWatchVideoId(kind, itemId, video) {
    var normalizedKind = normalizeAddonType(kind);

    if (normalizedKind !== 'series') {
        return itemId || '';
    }

    return video && video.id
        ? video.id
        : itemId + ':' + getVideoSeason(video) + ':' + getVideoEpisode(video);
}

function buildNuvioMetadataAddonPayload() {
    return state.addons.map(function(addon, index) {
        var url = addon && addon.transportUrl ? addonBaseUrl(addon.transportUrl) : addon && addon.id || '';

        return {
            id: addon && addon.id ? addon.id : 'addon-' + index,
            url: url,
            name: addon && addon.manifest && addon.manifest.name ? addon.manifest.name : 'Addon',
            enabled: true,
            sort_order: index,
            profile_id: NUVIO_PROFILE_ID
        };
    }).filter(function(addon) {
        return !!addon.url;
    });
}

function resolveWatchProgressMetadata(rows) {
    var items = (rows || []).map(function(row) {
        return {
            progress_key: row.progress_key,
            content_id: row.content_id,
            content_type: row.content_type
        };
    }).filter(function(item) {
        return item.progress_key && item.content_id && item.content_type;
    });

    if (!items.length) {
        return Promise.resolve({});
    }

    return requestJson(NUVIO_API_BASE + '/api/addons/resolve-watch-metadata', 'POST', {
        items: items,
        addons: buildNuvioMetadataAddonPayload()
    }).then(function(payload) {
        return payload && payload.resolved ? payload.resolved : {};
    }).catch(function(error) {
        console.log('Nuvio watch metadata resolve failed', error.message);
        return resolveWatchProgressMetadataFromAddons(items);
    });
}

function resolveWatchProgressMetadataFromAddons(items) {
    var resolved = {};

    return Promise.all((items || []).map(function(item) {
        var type = normalizeAddonType(item.content_type);

        if (!type || !item.content_id || !item.progress_key) {
            return null;
        }

        return fetchMetaFromAddons(type, item.content_id).then(function(meta) {
            if (!meta) {
                return null;
            }

            resolved[item.progress_key] = {
                name: meta.name || item.content_id,
                poster: meta.poster || '',
                background: meta.background || meta.poster || '',
                description: meta.description || '',
                from_addon: ''
            };
            return null;
        }).catch(function() {
            return null;
        });
    })).then(function() {
        return resolved;
    });
}

function rowToContinueEntry(row, metadata) {
    var kind = normalizeAddonType(row && row.content_type);
    var resolved = metadata && row ? metadata[row.progress_key] : null;
    var item;
    var video = null;

    if (!row || !kind || !row.content_id) {
        return null;
    }

    item = {
        id: row.content_id,
        name: resolved && resolved.name ? resolved.name : row.content_id,
        poster: resolved && resolved.poster ? resolved.poster : '',
        background: resolved && resolved.background ? resolved.background : resolved && resolved.poster || '',
        description: resolved && resolved.description ? resolved.description : '',
        releaseInfo: '',
        year: '',
        imdbRating: '',
        genres: resolved && Array.isArray(resolved.genres) ? resolved.genres.slice() : resolved && resolved.genres || []
    };

    if (kind === 'series') {
        video = {
            id: row.video_id || row.content_id + ':' + row.season + ':' + row.episode,
            title: '',
            season: row.season,
            episode: row.episode
        };
    } else {
        video = {
            id: row.video_id || row.content_id,
            title: item.name
        };
    }

    return normalizeContinueEntry({
        kind: kind,
        item: item,
        video: video,
        progressKey: row.progress_key,
        position: typeof row.position === 'number' ? row.position : 0,
        duration: typeof row.duration === 'number' ? row.duration : 0,
        lastWatched: row.last_watched,
        updatedAt: row.last_watched ? new Date(row.last_watched).toISOString() : null
    });
}

function rowToLibraryEntry(row) {
    var kind = normalizeAddonType(row && row.content_type);

    if (!row || !kind || !row.content_id) {
        return null;
    }

    return normalizeLibraryEntry({
        kind: kind,
        item: {
            id: row.content_id,
            name: row.name || row.content_id,
            poster: row.poster || '',
            background: row.background || row.poster || '',
            description: row.description || '',
            releaseInfo: row.release_info || '',
            year: row.release_info || '',
            imdbRating: row.imdb_rating,
            genres: Array.isArray(row.genres) ? row.genres.slice() : row.genres || []
        },
        addedAt: row && (row.created_at || row.added_at),
        updatedAt: row && row.updated_at,
        backendId: row.id,
        userId: row.user_id,
        posterShape: row.poster_shape,
        genres: row.genres,
        addonBaseUrl: row.addon_base_url,
        createdAt: row.created_at
    });
}

function fetchContinueWatchingFromNuvio() {
    if (!state.authKey) {
        return Promise.resolve(false);
    }

    return requestSupabaseWithSession('/rest/v1/rpc/sync_pull_watch_progress', 'POST', {
        p_profile_id: NUVIO_PROFILE_ID,
        p_limit: WATCH_PROGRESS_PULL_LIMIT
    }).then(function(rows) {
        var progressRows = Array.isArray(rows) ? rows : [];

        if (!progressRows.length) {
            return false;
        }

        return resolveWatchProgressMetadata(progressRows).then(function(metadata) {
            var localByKey = {};
            var entries = progressRows.map(function(row) {
                return rowToContinueEntry(row, metadata);
            }).filter(Boolean);

            if (!entries.length) {
                return false;
            }
            state.continueWatching.forEach(function(entry) {
                var key = continueEntryKey(entry);
                if (key && entry.stream) {
                    localByKey[key] = entry.stream;
                }
            });
            entries.forEach(function(entry) {
                var key = continueEntryKey(entry);
                if (key && !entry.stream && localByKey[key]) {
                    entry.stream = localByKey[key];
                }
            });
            mergeWatchedEpisodeEntries(entries);
            state.continueWatching = dedupeEntries(entries, normalizeContinueEntry, CONTINUE_WATCHING_LIMIT);
            saveContinueWatching();
            renderContinueWatching();
            if (typeof renderEpisodeBrowserForMode === 'function') {
                renderEpisodeBrowserForMode();
            }
            return true;
        });
    }).catch(function(error) {
        if (!isMissingSupabaseResource(error)) {
            console.log('Nuvio watch history sync unavailable', error.message);
        }
        return false;
    });
}

function fetchLibraryFromNuvio() {
    if (!state.authKey) {
        return Promise.resolve(false);
    }

    return requestSupabaseWithSession('/rest/v1/rpc/sync_pull_library', 'POST', {
        p_limit: LIBRARY_PULL_LIMIT,
        p_offset: 0,
        p_profile_id: NUVIO_PROFILE_ID
    }).then(function(rows) {
        var entries = (Array.isArray(rows) ? rows : []).map(rowToLibraryEntry).filter(Boolean);

        if (!entries.length) {
            state.libraryItems = [];
            saveLibraryItems();
            renderLibraryView();
            updateLibraryButtonUi();
            return true;
        }

        state.libraryItems = dedupeEntries(entries, normalizeLibraryEntry, LIBRARY_LIMIT);
        saveLibraryItems();
        renderLibraryView();
        updateLibraryButtonUi();
        return true;
    }).catch(function(error) {
        if (!isMissingSupabaseResource(error)) {
            console.log('Nuvio library sync unavailable', error.message);
        }
        return false;
    });
}

function continueEntryToWatchProgressPayload(entry) {
    var normalized = normalizeContinueEntry(entry);
    var contentId = normalized && normalized.item ? normalized.item.id : '';
    var video = normalized ? normalized.video : null;
    var kind = normalized ? normalizeAddonType(normalized.kind) : '';

    return {
        progress_key: normalized.progressKey || buildWatchProgressKey(kind, contentId, video),
        content_id: contentId,
        content_type: kind,
        video_id: buildWatchVideoId(kind, contentId, video),
        season: kind === 'series' && video ? getVideoSeason(video) : null,
        episode: kind === 'series' && video ? getVideoEpisode(video) : null,
        position: typeof normalized.position === 'number' ? normalized.position : 0,
        duration: typeof normalized.duration === 'number' ? normalized.duration : 0,
        last_watched: normalized.lastWatched || Date.now()
    };
}

function pushContinueWatchingToNuvio(entry) {
    var normalized = normalizeContinueEntry(entry);

    if (!state.authKey || !normalized) {
        return Promise.resolve(false);
    }

    return requestSupabaseWithSession('/rest/v1/rpc/sync_push_watch_progress', 'POST', {
        p_entries: [continueEntryToWatchProgressPayload(normalized)],
        p_profile_id: NUVIO_PROFILE_ID
    }).then(function() {
        return true;
    }).catch(function(error) {
        if (!isMissingSupabaseResource(error)) {
            console.log('Nuvio watch history update failed', error.message);
        }
        return false;
    });
}

function deleteContinueWatchingFromNuvio(entry) {
    var normalized = normalizeContinueEntry(entry);
    var progressKey;

    if (!state.authKey || !normalized) {
        return Promise.resolve(false);
    }

    progressKey = normalized.progressKey || buildWatchProgressKey(normalized.kind, normalized.item.id, normalized.video);
    return requestSupabaseWithSession('/rest/v1/rpc/sync_delete_watch_progress', 'POST', {
        p_keys: [progressKey, normalized.item.id],
        p_profile_id: NUVIO_PROFILE_ID
    }).then(function() {
        return true;
    }).catch(function(error) {
        if (!isMissingSupabaseResource(error)) {
            console.log('Nuvio watch history delete failed', error.message);
        }
        return false;
    });
}

function libraryEntryToNuvioPayload(entry) {
    var normalized = normalizeLibraryEntry(entry);
    var item = normalized && normalized.item ? normalized.item : {};
    var rating = item.imdbRating;
    var payload = {
        content_id: item.id || '',
        content_type: normalizeAddonType(normalized && normalized.kind),
        name: item.name || item.id || '',
        poster: item.poster || '',
        poster_shape: normalized && normalized.posterShape || 'POSTER',
        background: item.background || item.poster || '',
        description: item.description || '',
        release_info: item.releaseInfo || item.year || '',
        imdb_rating: typeof rating === 'number' ? rating : rating ? parseFloat(rating) || null : null,
        genres: normalized && Array.isArray(normalized.genres) ? normalized.genres : [],
        addon_base_url: normalized && normalized.addonBaseUrl || null,
        added_at: normalized && typeof normalized.addedAt === 'number' ? normalized.addedAt : 0
    };

    if (normalized && normalized.backendId) {
        payload.id = normalized.backendId;
    }
    if (normalized && normalized.userId) {
        payload.user_id = normalized.userId;
    }
    if (normalized && normalized.createdAt) {
        payload.created_at = normalized.createdAt;
    }
    if (normalized && normalized.updatedAt) {
        payload.updated_at = normalized.updatedAt;
    }
    payload.profile_id = NUVIO_PROFILE_ID;

    return payload;
}

function syncLibraryToNuvio() {
    if (!state.authKey) {
        return Promise.resolve(false);
    }

    return requestSupabaseWithSession('/rest/v1/rpc/sync_push_library', 'POST', {
        p_items: state.libraryItems.map(libraryEntryToNuvioPayload),
        p_profile_id: NUVIO_PROFILE_ID
    }).then(function() {
        return true;
    }).catch(function(error) {
        if (!isMissingSupabaseResource(error)) {
            console.log('Nuvio library update failed', error.message);
        }
        return false;
    });
}

function syncNuvioUserData() {
    return Promise.all([
        fetchContinueWatchingFromNuvio(),
        fetchLibraryFromNuvio()
    ]).then(function() {
        renderContinueWatching();
        renderLibraryView();
    });
}

function fetchAddonDefinition(baseUrl) {
    var cleanBaseUrl = canonicalizeAddonUrl(baseUrl);

    if (!cleanBaseUrl) {
        return Promise.resolve(null);
    }

    return scheduleRequest('catalog', function() {
        return requestJson(buildAddonTransportUrl(cleanBaseUrl), 'GET');
    }).catch(function() {
        var fallback = buildBuiltinAddonManifest(cleanBaseUrl);

        if (!fallback) {
            return null;
        }

        return fallback;
    }).then(function(manifest) {
        if (!manifest) {
            return null;
        }

        return normalizeAddonManifest(cleanBaseUrl, manifest);
    });
}

function refreshSessionIfNeeded() {
    if (!state.authKey && !state.refreshToken) {
        return Promise.resolve(false);
    }

    if (!state.refreshToken) {
        return fetchCurrentSupabaseUserForToken(state.authKey).then(function(user) {
            if (user) {
                state.user = user;
                localStorage.setItem(STORAGE_USER, JSON.stringify(user));
                updateUserPanel();
                return true;
            }

            return false;
        }).catch(function() {
            return false;
        });
    }

    return requestSupabaseAuth('/auth/v1/token?grant_type=refresh_token', 'POST', {
        refresh_token: state.refreshToken
    }).then(function(payload) {
        if (!payload || !payload.access_token) {
            throw new Error('No access token returned');
        }

        state.authKey = payload.access_token;
        state.refreshToken = payload.refresh_token || state.refreshToken;
        localStorage.setItem(STORAGE_AUTH, state.authKey);
        if (state.refreshToken) {
            localStorage.setItem(STORAGE_REFRESH, state.refreshToken);
        }
        state.ownerId = null;

        return fetchCurrentSupabaseUserForToken(state.authKey).then(function(user) {
            if (user) {
                state.user = user;
                localStorage.setItem(STORAGE_USER, JSON.stringify(user));
            }
            updateUserPanel();
            return true;
        });
    }).catch(function() {
        storeSession(null, null, null);
        return false;
    });
}

function fetchCatalogManifest() {
    var movieOptions = buildCatalogOptions('movie');
    var seriesOptions = buildCatalogOptions('series');
    var selectedMovie = getSelectedBrowseOption('movie');
    var selectedSeries = getSelectedBrowseOption('series');
    var preferredMovie = selectedMovie && movieOptions.some(function(option) {
        return option.key === selectedMovie.key;
    }) ? selectedMovie : selectPreferredCatalogOption(movieOptions);
    var preferredSeries = selectedSeries && seriesOptions.some(function(option) {
        return option.key === selectedSeries.key;
    }) ? selectedSeries : selectPreferredCatalogOption(seriesOptions);
    var movieYearStillExists;
    var seriesYearStillExists;

    state.movieGenres = movieOptions;
    state.seriesGenres = seriesOptions;
    if (preferredMovie && isYearBrowseOption(preferredMovie)) {
        setSelectedYearBrowseKey('movie', preferredMovie.key);
        preferredMovie = selectPreferredCatalogOption(movieOptions.filter(function(option) {
            return !isYearBrowseOption(option);
        }));
    }
    if (preferredSeries && isYearBrowseOption(preferredSeries)) {
        setSelectedYearBrowseKey('series', preferredSeries.key);
        preferredSeries = selectPreferredCatalogOption(seriesOptions.filter(function(option) {
            return !isYearBrowseOption(option);
        }));
    }
    movieYearStillExists = !getSelectedYearBrowseKey('movie') || movieOptions.some(function(option) {
        return option.key === getSelectedYearBrowseKey('movie') && isYearBrowseOption(option);
    });
    seriesYearStillExists = !getSelectedYearBrowseKey('series') || seriesOptions.some(function(option) {
        return option.key === getSelectedYearBrowseKey('series') && isYearBrowseOption(option);
    });
    if (!movieYearStillExists) {
        setSelectedYearBrowseKey('movie', '');
    }
    if (!seriesYearStillExists) {
        setSelectedYearBrowseKey('series', '');
    }
    setSelectedBrowseKey('movie', preferredMovie ? preferredMovie.key : '');
    setSelectedBrowseKey('series', preferredSeries ? preferredSeries.key : '');
    renderBrowseGenreRows();

    return Promise.resolve({
        movies: movieOptions,
        series: seriesOptions
    });
}

function renderBrowseGenreRows() {
    function getBrowseTypeFromContainer(containerId) {
        return containerId === 'movieGenreRow' ? 'movie' : 'series';
    }

    function renderYearFilters(container, type, yearOptions, activeKey, onSelect) {
        var label;
        var stack;
        var start;
        var visibleOptions;
        var open;
        var collapsedIndex;

        if (!yearOptions.length) {
            return;
        }

        open = isYearFilterOpen(type);
        if (open) {
            start = getOpenYearWindowStartForRender(type, yearOptions);
            visibleOptions = yearOptions.slice(start, start + YEAR_FILTER_WINDOW_SIZE);
        } else {
            collapsedIndex = getCollapsedYearIndex(type, yearOptions, activeKey);
            start = collapsedIndex;
            visibleOptions = [yearOptions[collapsedIndex]];
        }

        label = document.createElement('span');
        label.className = 'year-filter-label';
        label.textContent = 'Year';
        container.appendChild(label);

        stack = document.createElement('div');
        stack.className = 'year-filter-stack';
        if (!open) {
            stack.classList.add('is-year-filter-collapsed');
        }
        stack.setAttribute('data-year-filter-type', type);

        visibleOptions.forEach(function(option, index) {
            var button = document.createElement('button');
            var optionIndex = start + index;

            button.className = 'genre-chip is-year-filter';
            button.type = 'button';
            button.setAttribute('tabindex', '-1');
            button.setAttribute('data-year-filter-type', type);
            button.setAttribute('data-year-index', String(optionIndex));
            button.setAttribute('data-year-total', String(yearOptions.length));
            button.setAttribute('aria-expanded', open ? 'true' : 'false');
            button.textContent = option.label;
            button.setAttribute('aria-label', open ? 'Year ' + option.label : 'Choose year. Current ' + option.label);
            if (option.key === activeKey) {
                button.classList.add('is-selected');
            }
            if (!open) {
                button.classList.add('is-year-collapsed');
            }
            if (open && optionIndex === start && start > 0) {
                button.classList.add('is-year-window-edge');
            }
            if (open && optionIndex === start + visibleOptions.length - 1 && optionIndex < yearOptions.length - 1) {
                button.classList.add('is-year-window-edge');
            }
            button.addEventListener('click', function() {
                if (!isYearFilterOpen(type)) {
                    setRatingFilterOpen(type, false);
                    setYearFocusIndex(type, optionIndex);
                    setYearWindowStart(type, clampYearWindowStart(optionIndex - 1, yearOptions.length));
                    setYearFilterOpen(type, true);
                    renderBrowseGenreRows();
                    focusYearFilter(type, optionIndex);
                    return;
                }

                setYearFilterOpen(type, false);
                setRatingFilterOpen(type, false);
                setYearFocusIndex(type, optionIndex);
                onSelect(option);
                renderBrowseGenreRows();
                focusYearFilter(type, optionIndex);
            });
            stack.appendChild(button);
        });

        container.appendChild(stack);
    }

    function renderRatingFilters(container, type, ratingOptions, activeKey, onSelect) {
        var label;
        var stack;
        var start;
        var visibleOptions;
        var open;
        var collapsedIndex;

        if (!ratingOptions.length) {
            return;
        }

        open = isRatingFilterOpen(type);
        if (open) {
            start = getOpenRatingWindowStartForRender(type, ratingOptions);
            visibleOptions = ratingOptions.slice(start, start + YEAR_FILTER_WINDOW_SIZE);
        } else {
            collapsedIndex = getCollapsedRatingIndex(type, ratingOptions, activeKey);
            start = collapsedIndex;
            visibleOptions = [ratingOptions[collapsedIndex]];
        }

        label = document.createElement('span');
        label.className = 'year-filter-label rating-filter-label';
        label.textContent = 'IMDb';
        container.appendChild(label);

        stack = document.createElement('div');
        stack.className = 'year-filter-stack rating-filter-stack';
        if (!open) {
            stack.classList.add('is-year-filter-collapsed', 'is-rating-filter-collapsed');
        }
        stack.setAttribute('data-rating-filter-type', type);

        visibleOptions.forEach(function(option, index) {
            var button = document.createElement('button');
            var optionIndex = start + index;

            button.className = 'genre-chip is-rating-filter';
            button.type = 'button';
            button.setAttribute('tabindex', '-1');
            button.setAttribute('data-rating-filter-type', type);
            button.setAttribute('data-rating-index', String(optionIndex));
            button.setAttribute('data-rating-total', String(ratingOptions.length));
            button.setAttribute('aria-expanded', open ? 'true' : 'false');
            button.textContent = option.label;
            button.setAttribute('aria-label', open ? 'IMDb rating ' + option.label : 'Choose IMDb rating. Current ' + option.label);
            if (option.key === activeKey) {
                button.classList.add('is-selected');
            }
            if (!open) {
                button.classList.add('is-rating-collapsed');
            }
            if (open && optionIndex === start && start > 0) {
                button.classList.add('is-rating-window-edge');
            }
            if (open && optionIndex === start + visibleOptions.length - 1 && optionIndex < ratingOptions.length - 1) {
                button.classList.add('is-rating-window-edge');
            }
            button.addEventListener('click', function() {
                if (!isRatingFilterOpen(type)) {
                    setYearFilterOpen(type, false);
                    setRatingFocusIndex(type, optionIndex);
                    setRatingWindowStart(type, clampRatingWindowStart(optionIndex - 1, ratingOptions.length));
                    setRatingFilterOpen(type, true);
                    renderBrowseGenreRows();
                    focusRatingFilter(type, optionIndex);
                    return;
                }

                setRatingFilterOpen(type, false);
                setRatingFocusIndex(type, optionIndex);
                onSelect(option);
                renderBrowseGenreRows();
                focusRatingFilter(type, optionIndex);
            });
            stack.appendChild(button);
        });

        container.appendChild(stack);
    }

    function renderRow(containerId, options, activeKey, onSelect) {
        var container = byId(containerId);
        var fragment = document.createDocumentFragment();
        var type = getBrowseTypeFromContainer(containerId);
        var activeYearKey = getSelectedYearBrowseKey(type);
        var activeRatingKey = getSelectedRatingBrowseKey(type);
        var normalOptions = options.filter(function(option) {
            return !isYearBrowseOption(option) && !isRatingBrowseOption(option);
        });
        var yearOptions = getYearFilterOptionsForRender(type, options);
        var ratingOptions = getRatingFilterOptionsForRender(type);
        var previousGroup = '';
        container.innerHTML = '';

        normalOptions.forEach(function(option) {
            var group = option.filterGroup || 'catalog';
            var button = document.createElement('button');
            button.className = 'genre-chip is-' + group + '-filter';
            button.type = 'button';
            button.setAttribute('tabindex', '-1');
            if (option.key === activeKey) {
                button.classList.add('is-selected');
            }
            if (previousGroup && previousGroup !== group) {
                button.classList.add('is-filter-group-start');
            }
            previousGroup = group;
            button.textContent = option.label;
            button.addEventListener('click', function() {
                setYearFilterOpen(type, false);
                setRatingFilterOpen(type, false);
                onSelect(option);
            });
            fragment.appendChild(button);
        });

        renderYearFilters(fragment, type, yearOptions, activeYearKey, function(option) {
            setRatingFilterOpen(type, false);
            setSelectedYearBrowseKey(type, option.key);
            resetBrowsePaging(type);
            fetchBrowseCatalog(type, false);
        });
        renderRatingFilters(fragment, type, ratingOptions, activeRatingKey, function(option) {
            setYearFilterOpen(type, false);
            setSelectedRatingBrowseKey(type, option.key);
            resetBrowsePaging(type);
            fetchBrowseCatalog(type, false);
        });
        container.appendChild(fragment);
    }

    renderRow('movieGenreRow', state.movieGenres, state.selectedMovieGenre, function(option) {
        setSelectedBrowseKey('movie', option.key);
        resetBrowsePaging('movie');
        fetchBrowseCatalog('movie', false);
    });

    renderRow('seriesGenreRow', state.seriesGenres, state.selectedSeriesGenre, function(option) {
        setSelectedBrowseKey('series', option.key);
        resetBrowsePaging('series');
        fetchBrowseCatalog('series', false);
    });
    markFocusRegistryDirty();
}

function moveFocusedYearFilter(direction) {
    var active = document.activeElement;
    var type = active && active.getAttribute ? active.getAttribute('data-year-filter-type') : '';
    var currentIndex;
    var nextIndex;
    var yearOptions;
    var start;
    var nextStart;
    var nextButton;
    var row;
    var nextCol;

    if (!type) {
        type = getCurrentBrowseType();
    }
    if (!type || !isYearFilterOpen(type)) {
        return false;
    }

    currentIndex = active && active.classList && active.classList.contains('is-year-filter')
        ? Number(active.getAttribute('data-year-index'))
        : getYearFocusIndex(type);
    if (currentIndex !== currentIndex) {
        currentIndex = getYearFocusIndex(type);
    }

    yearOptions = getYearFilterOptionsForRender(type, getBrowseOptions(type));
    nextIndex = currentIndex + direction;

    if (!yearOptions.length || currentIndex !== currentIndex) {
        return false;
    }
    if (nextIndex < 0 || nextIndex >= yearOptions.length) {
        return true;
    }
    setYearFocusIndex(type, nextIndex);

    start = clampYearWindowStart(getYearWindowStart(type), yearOptions.length);
    nextStart = clampYearWindowStart(nextIndex - Math.floor(YEAR_FILTER_WINDOW_SIZE / 2), yearOptions.length);
    nextStart = clampYearWindowStart(nextStart, yearOptions.length);

    if (nextStart !== start) {
        setYearWindowStart(type, nextStart);
        renderBrowseGenreRows();
    }

    row = getMainRows()[0] || [];
    nextButton = null;
    row.some(function(button) {
        if (button && button.classList && button.classList.contains('is-year-filter') && button.getAttribute('data-year-index') === String(nextIndex)) {
            nextButton = button;
            return true;
        }

        return false;
    });
    if (!nextButton) {
        renderBrowseGenreRows();
        focusYearFilter(type, nextIndex);
        return true;
    }

    nextCol = row.indexOf(nextButton);
    if (nextCol >= 0) {
        state.mainRow = 0;
        state.mainCol = nextCol;
    }
    focusCurrent();
    return true;
}

function exitFocusedYearFilter(direction) {
    var active = document.activeElement;
    var type = active && active.getAttribute ? active.getAttribute('data-year-filter-type') : '';
    var row;
    var currentCol;
    var nextCol;

    if (!type || !active.classList || !active.classList.contains('is-year-filter')) {
        return false;
    }

    row = getMainRows()[0] || [];
    currentCol = row.indexOf(active);
    if (currentCol < 0) {
        return false;
    }

    if (direction < 0) {
        setYearFilterOpen(type, false);
        nextCol = currentCol - 1;
        while (nextCol >= 0 && row[nextCol].classList.contains('is-year-filter')) {
            nextCol -= 1;
        }
        if (nextCol >= 0) {
            state.mainRow = 0;
            state.mainCol = nextCol;
            renderBrowseGenreRows();
            focusCurrent();
        } else {
            renderBrowseGenreRows();
            focusYearFilter(type, getCollapsedYearIndex(type, getYearFilterOptionsForRender(type, getBrowseOptions(type)), getSelectedYearBrowseKey(type)));
        }
        return true;
    }

    setYearFilterOpen(type, false);
    nextCol = currentCol + 1;
    while (nextCol < row.length && row[nextCol].classList.contains('is-year-filter')) {
        nextCol += 1;
    }
    if (nextCol < row.length) {
        state.mainRow = 0;
        state.mainCol = nextCol;
        renderBrowseGenreRows();
        focusCurrent();
    } else {
        renderBrowseGenreRows();
        focusYearFilter(type, getCollapsedYearIndex(type, getYearFilterOptionsForRender(type, getBrowseOptions(type)), getSelectedYearBrowseKey(type)));
    }
    return true;
}

function moveFocusedRatingFilter(direction) {
    var active = document.activeElement;
    var type = active && active.getAttribute ? active.getAttribute('data-rating-filter-type') : '';
    var currentIndex;
    var nextIndex;
    var ratingOptions;
    var start;
    var nextStart;
    var nextButton;
    var row;
    var nextCol;

    if (!type) {
        type = getCurrentBrowseType();
    }
    if (!type || !isRatingFilterOpen(type)) {
        return false;
    }

    currentIndex = active && active.classList && active.classList.contains('is-rating-filter')
        ? Number(active.getAttribute('data-rating-index'))
        : getRatingFocusIndex(type);
    if (currentIndex !== currentIndex) {
        currentIndex = getRatingFocusIndex(type);
    }

    ratingOptions = getRatingFilterOptionsForRender(type);
    nextIndex = currentIndex + direction;

    if (!ratingOptions.length || currentIndex !== currentIndex) {
        return false;
    }
    if (nextIndex < 0 || nextIndex >= ratingOptions.length) {
        return true;
    }
    setRatingFocusIndex(type, nextIndex);

    start = clampRatingWindowStart(getRatingWindowStart(type), ratingOptions.length);
    nextStart = clampRatingWindowStart(nextIndex - Math.floor(YEAR_FILTER_WINDOW_SIZE / 2), ratingOptions.length);
    nextStart = clampRatingWindowStart(nextStart, ratingOptions.length);

    if (nextStart !== start) {
        setRatingWindowStart(type, nextStart);
        renderBrowseGenreRows();
    }

    row = getMainRows()[0] || [];
    nextButton = null;
    row.some(function(button) {
        if (button && button.classList && button.classList.contains('is-rating-filter') && button.getAttribute('data-rating-index') === String(nextIndex)) {
            nextButton = button;
            return true;
        }

        return false;
    });
    if (!nextButton) {
        renderBrowseGenreRows();
        focusRatingFilter(type, nextIndex);
        return true;
    }

    nextCol = row.indexOf(nextButton);
    if (nextCol >= 0) {
        state.mainRow = 0;
        state.mainCol = nextCol;
    }
    focusCurrent();
    return true;
}

function exitFocusedRatingFilter(direction) {
    var active = document.activeElement;
    var type = active && active.getAttribute ? active.getAttribute('data-rating-filter-type') : '';
    var row;
    var currentCol;
    var nextCol;

    if (!type || !active.classList || !active.classList.contains('is-rating-filter')) {
        return false;
    }

    row = getMainRows()[0] || [];
    currentCol = row.indexOf(active);
    if (currentCol < 0) {
        return false;
    }

    if (direction < 0) {
        setRatingFilterOpen(type, false);
        nextCol = currentCol - 1;
        while (nextCol >= 0 && row[nextCol].classList.contains('is-rating-filter')) {
            nextCol -= 1;
        }
        if (nextCol >= 0) {
            state.mainRow = 0;
            state.mainCol = nextCol;
            renderBrowseGenreRows();
            focusCurrent();
        } else {
            renderBrowseGenreRows();
            focusRatingFilter(type, getCollapsedRatingIndex(type, getRatingFilterOptionsForRender(type), getSelectedRatingBrowseKey(type)));
        }
        return true;
    }

    setRatingFilterOpen(type, false);
    nextCol = currentCol + 1;
    while (nextCol < row.length && row[nextCol].classList.contains('is-rating-filter')) {
        nextCol += 1;
    }
    if (nextCol < row.length) {
        state.mainRow = 0;
        state.mainCol = nextCol;
        renderBrowseGenreRows();
        focusCurrent();
    } else {
        renderBrowseGenreRows();
        focusRatingFilter(type, getCollapsedRatingIndex(type, getRatingFilterOptionsForRender(type), getSelectedRatingBrowseKey(type)));
    }
    return true;
}

function updateBrowseLoadMoreButton(type) {
    var button = byId(type === 'movie' ? 'movieLoadMoreButton' : 'seriesLoadMoreButton');
    var option = getSelectedBrowseOption(type);
    var canLoadMore = !!option && getBrowseCanLoadMore(type);
    var loading = getBrowseLoadingMore(type);
    var label = type === 'movie' ? 'Films' : 'Series';
    var text;

    if (!button) {
        return;
    }

    text = loading ? 'Loading ' + label : (canLoadMore ? 'Load More ' + label : 'No More ' + label);
    button.disabled = !canLoadMore && !loading;
    button.classList.toggle('is-loading', loading);
    button.setAttribute('aria-busy', loading ? 'true' : 'false');
    button.setAttribute('aria-disabled', loading || !canLoadMore ? 'true' : 'false');
    button.textContent = text;
    button.setAttribute('aria-label', text);
    markFocusRegistryDirty();
}

function renderBrowseViews() {
    var movieOption = getSelectedBrowseOption('movie');
    var seriesOption = getSelectedBrowseOption('series');
    var movieItems = filterItemsForBrowseOption(state.movieBrowseItems, movieOption);
    var seriesItems = filterItemsForBrowseOption(state.seriesBrowseItems, seriesOption);

    if (movieItems.length !== state.movieBrowseItems.length) {
        state.movieBrowseItems = movieItems;
    }
    if (seriesItems.length !== state.seriesBrowseItems.length) {
        state.seriesBrowseItems = seriesItems;
    }

    renderCardRows('movieGrid', movieItems, 'movie', BROWSE_ROW_SIZE);
    renderCardRows('seriesGrid', seriesItems, 'series', BROWSE_ROW_SIZE);

    byId('movieCount').textContent = movieItems.length + ' loaded • ' + getSelectedBrowseLabel('movie')
        + (getBrowseCanLoadMore('movie') ? '' : ' • end');
    byId('seriesCount').textContent = seriesItems.length + ' loaded • ' + getSelectedBrowseLabel('series')
        + (getBrowseCanLoadMore('series') ? '' : ' • end');
    updateBrowseLoadMoreButton('movie');
    updateBrowseLoadMoreButton('series');
    renderBrowseGenreRows();
}

function getLibraryCardItems() {
    return state.libraryItems.map(function(entry) {
        var item = cloneContinueItem(entry.item);

        item.__kind = entry.kind;
        return item;
    });
}

function isDownloadedLibraryMode() {
    return state.libraryMode === 'downloads';
}

function setLibraryMode(mode) {
    state.libraryMode = mode === 'downloads' ? 'downloads' : 'saved';
    renderLibraryView();
    if (isDownloadedLibraryMode()) {
        refreshDownloadedLibrary(false);
    }
}

function getDownloadedLibraryTitle(item) {
    var metadata = item && item.metadata || {};
    return metadata.itemName || item.name || 'Cached torrent';
}

function formatDownloadedEpisodeNumber(value) {
    var number = parseInt(value, 10);

    if (!number || isNaN(number)) {
        return '00';
    }

    return number < 10 ? '0' + number : String(number);
}

function getDownloadedLibrarySubtitle(item) {
    var metadata = item && item.metadata || {};
    var parts = [];

    if (metadata.itemType) {
        parts.push(metadata.itemType === 'series' ? 'Series' : 'Movie');
    }
    if (metadata.videoTitle && metadata.videoTitle !== metadata.itemName) {
        parts.push(metadata.videoTitle);
    }
    if (metadata.season || metadata.episode) {
        parts.push('S' + formatDownloadedEpisodeNumber(metadata.season) + 'E' + formatDownloadedEpisodeNumber(metadata.episode));
    }
    if (!parts.length && metadata.streamTitle) {
        parts.push(metadata.streamTitle);
    }

    return parts.join(' • ') || 'Bridge cache';
}

function formatDownloadedPercent(value) {
    var progress = typeof value === 'number' && isFinite(value) ? value : 0;
    return Math.round(Math.max(0, Math.min(1, progress)) * 100);
}

function formatDownloadedBytes(value) {
    var size = Number(value || 0);
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var index = 0;

    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }

    if (index === 0) {
        return Math.round(size) + ' ' + units[index];
    }

    return (size >= 10 ? size.toFixed(1) : size.toFixed(2)).replace(/\.0+$/, '') + ' ' + units[index];
}

function formatDownloadedDate(timestamp) {
    var value = Number(timestamp || 0);
    var date;

    if (!value) {
        return 'Unknown date';
    }

    date = new Date(value * 1000);
    if (isNaN(date.getTime())) {
        return 'Unknown date';
    }

    return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function getDownloadedLibraryMeta(item) {
    var parts = [];
    var cachedAt = item.metadata && item.metadata.cachedAt || item.addedOn;
    var size = item.totalSize || item.size || item.file && item.file.size;

    parts.push(formatDownloadedPercent(item.progress) + '%');
    if (item.state) {
        parts.push(item.state);
    }
    if (size) {
        parts.push(formatDownloadedBytes(size));
    }
    parts.push('Added ' + formatDownloadedDate(cachedAt));
    if (item.seeds || item.seeds === 0) {
        parts.push(item.seeds + ' seeds');
    }

    return parts.join(' • ');
}

function getDownloadedLibraryFileName(item) {
    return item.file && item.file.name || item.name || '';
}

function normalizeDownloadedLibraryItems(payload) {
    var items = payload && Array.isArray(payload.items) ? payload.items : payload;
    if (!Array.isArray(items)) {
        return [];
    }

    return items.filter(function(item) {
        return item && item.hash;
    });
}

function canUseDownloadedLibrary() {
    return typeof getTorrentBridgeBaseUrl === 'function'
        && typeof getTorrentBridgeToken === 'function'
        && getTorrentBridgeBaseUrl()
        && getTorrentBridgeToken()
        && typeof requestTorrentBridge === 'function';
}

function refreshDownloadedLibrary(force) {
    if (!canUseDownloadedLibrary()) {
        state.downloadedLibraryItems = [];
        state.downloadedLibraryError = 'Torrent bridge is not configured on this app build.';
        state.downloadedLibraryLoading = false;
        renderLibraryView();
        return Promise.resolve([]);
    }

    if (state.downloadedLibraryLoading) {
        return Promise.resolve(state.downloadedLibraryItems);
    }

    if (!force && state.downloadedLibraryLoadedAt && Date.now() - state.downloadedLibraryLoadedAt < 10000) {
        return Promise.resolve(state.downloadedLibraryItems);
    }

    state.downloadedLibraryLoading = true;
    state.downloadedLibraryError = '';
    renderLibraryView();

    return requestTorrentBridge('/api/torrents', 'GET').then(function(payload) {
        state.downloadedLibraryItems = normalizeDownloadedLibraryItems(payload);
        state.downloadedLibraryLoadedAt = Date.now();
        state.downloadedLibraryLoading = false;
        state.downloadedLibraryError = '';
        renderLibraryView();
        return state.downloadedLibraryItems;
    }).catch(function(error) {
        state.downloadedLibraryLoading = false;
        state.downloadedLibraryError = error.message || 'Could not load downloaded library.';
        renderLibraryView();
        return [];
    });
}

function deleteDownloadedLibraryItem(hash) {
    if (!hash || !canUseDownloadedLibrary() || state.downloadedLibraryDeleting[hash]) {
        return;
    }

    state.downloadedLibraryDeleting[hash] = true;
    renderLibraryView();

    requestTorrentBridge('/api/torrents/' + encodeURIComponent(hash) + '?deleteFiles=1', 'DELETE').then(function() {
        delete state.downloadedLibraryDeleting[hash];
        state.downloadedLibraryItems = state.downloadedLibraryItems.filter(function(item) {
            return item.hash !== hash;
        });
        state.downloadedLibraryLoadedAt = 0;
        renderLibraryView();
        return refreshDownloadedLibrary(true);
    }).catch(function(error) {
        delete state.downloadedLibraryDeleting[hash];
        state.downloadedLibraryError = error.message || 'Could not delete cached file.';
        renderLibraryView();
    });
}

function getDownloadedLibraryFileIndex(item) {
    return item && item.file && typeof item.file.index !== 'undefined'
        ? item.file.index
        : null;
}

function buildDownloadedLibrarySelection(item) {
    var metadata = item && item.metadata || {};
    var itemType = metadata.itemType === 'series' ? 'series' : 'movie';
    var title = getDownloadedLibraryTitle(item);
    var fileName = getDownloadedLibraryFileName(item);
    var selectedItem = {
        id: metadata.itemId || item && item.hash || ('bridge:' + title),
        name: title,
        poster: metadata.poster || '',
        background: metadata.background || metadata.poster || '',
        description: metadata.streamTitle || fileName || 'Cached bridge stream',
        releaseInfo: '',
        year: ''
    };
    var selectedVideo = null;

    if (itemType === 'series') {
        selectedVideo = {
            id: metadata.videoId || ((item && item.hash || 'bridge') + ':' + String(getDownloadedLibraryFileIndex(item) || 0)),
            title: metadata.videoTitle || fileName || title,
            season: metadata.season || null,
            episode: metadata.episode || null
        };
    }

    return {
        item: selectedItem,
        type: itemType,
        video: selectedVideo
    };
}

function buildDownloadedLibraryStreamEntry(item) {
    var metadata = item && item.metadata || {};
    var title = getDownloadedLibraryTitle(item);
    var subtitle = getDownloadedLibrarySubtitle(item);
    var fileName = getDownloadedLibraryFileName(item);
    var fileIndex = getDownloadedLibraryFileIndex(item);
    var raw = {
        url: item.streamUrl,
        name: metadata.streamTitle || fileName || title,
        title: metadata.streamTitle || fileName || title,
        description: subtitle,
        infoHash: item.hash
    };

    if (Array.isArray(item.subtitles)) {
        raw.subtitles = item.subtitles;
    }

    if (fileIndex !== null) {
        raw.fileIdx = fileIndex;
    }

    return {
        addonName: 'Torrent Bridge',
        addonBaseUrl: getTorrentBridgeBaseUrl(),
        playable: true,
        bridgeable: false,
        status: 'Playable',
        title: title,
        description: [subtitle, fileName].filter(Boolean).join(' • '),
        raw: raw
    };
}

function openDownloadedLibraryStream(item) {
    var selection = buildDownloadedLibrarySelection(item);
    state.selectedItem = selection.item;
    state.selectedType = selection.type;
    state.selectedVideo = selection.video;
    state.streams = [];
    state.detailMode = 'details';
    openStream(buildDownloadedLibraryStreamEntry(item));
}

function replaceDownloadedLibraryItem(updatedItem) {
    var replaced = false;

    state.downloadedLibraryItems = state.downloadedLibraryItems.map(function(item) {
        if (item.hash === updatedItem.hash) {
            replaced = true;
            return updatedItem;
        }
        return item;
    });

    if (!replaced) {
        state.downloadedLibraryItems = [updatedItem].concat(state.downloadedLibraryItems);
    }
}

function openDownloadedLibraryItem(item) {
    var fileIndex;
    var path;

    if (!item || !item.hash || state.downloadedLibraryDeleting[item.hash]) {
        return;
    }

    if (item.streamUrl) {
        openDownloadedLibraryStream(item);
        return;
    }

    if (!canUseDownloadedLibrary()) {
        state.downloadedLibraryError = 'Torrent bridge is not configured on this app build.';
        renderLibraryView();
        return;
    }

    state.downloadedLibraryError = 'Checking cached stream status...';
    renderLibraryView();

    fileIndex = getDownloadedLibraryFileIndex(item);
    path = '/api/torrents/' + encodeURIComponent(item.hash);
    if (fileIndex !== null) {
        path += '?fileIndex=' + encodeURIComponent(String(fileIndex));
    }

    requestTorrentBridge(path, 'GET').then(function(updatedItem) {
        replaceDownloadedLibraryItem(updatedItem);
        if (updatedItem && updatedItem.streamUrl) {
            openDownloadedLibraryStream(updatedItem);
            return;
        }
        state.downloadedLibraryError = 'This cache item is still downloading and is not streamable yet.';
        renderLibraryView();
    }).catch(function(error) {
        state.downloadedLibraryError = error.message || 'Could not open cached stream.';
        renderLibraryView();
    });
}

function createDownloadedPoster(imageUrl, title) {
    var poster = document.createElement('div');
    poster.className = 'downloaded-library-poster';

    function showEmpty() {
        poster.innerHTML = '';
        poster.textContent = 'No poster';
    }

    if (!imageUrl) {
        showEmpty();
        return poster;
    }

    var img = document.createElement('img');
    img.decoding = 'async';
    img.loading = 'lazy';
    img.alt = title || 'Poster';
    img.onerror = showEmpty;
    img.src = imageUrl;
    poster.appendChild(img);
    return poster;
}

function renderDownloadedLibraryView() {
    var list = byId('downloadedLibraryList');
    var message = byId('downloadedLibraryMessage');
    var fragment = document.createDocumentFragment();
    var items = state.downloadedLibraryItems || [];

    if (!list || !message) {
        return;
    }

    list.innerHTML = '';

    if (state.downloadedLibraryLoading) {
        message.textContent = 'Loading cached files from your Oracle node...';
    } else if (state.downloadedLibraryError) {
        message.textContent = state.downloadedLibraryError;
    } else if (!items.length) {
        message.textContent = 'No bridge cache files are currently stored on your Oracle node.';
    } else {
        message.textContent = 'Bridge cache files stored on your Oracle node.';
    }

    items.forEach(function(item, index) {
        var metadata = item.metadata || {};
        var titleText = getDownloadedLibraryTitle(item);
        var row = document.createElement('div');
        var main = document.createElement('div');
        var title = document.createElement('div');
        var subtitle = document.createElement('div');
        var meta = document.createElement('div');
        var file = document.createElement('div');
        var progressRow = document.createElement('div');
        var progressRail = document.createElement('div');
        var progressFill = document.createElement('div');
        var progressLabel = document.createElement('div');
        var actions = document.createElement('div');
        var deleteButton = document.createElement('button');
        var percent = formatDownloadedPercent(item.progress);

        row.className = 'downloaded-library-row';
        row.id = 'downloadedLibraryRow' + index;
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '-1');
        row.addEventListener('click', function() {
            openDownloadedLibraryItem(item);
        });

        main.className = 'downloaded-library-main';
        title.className = 'downloaded-library-title';
        subtitle.className = 'downloaded-library-subtitle';
        meta.className = 'downloaded-library-meta';
        file.className = 'downloaded-library-file';
        progressRow.className = 'downloaded-progress-row';
        progressRail.className = 'downloaded-progress-rail';
        progressFill.className = 'downloaded-progress-fill';
        progressLabel.className = 'downloaded-progress-label';
        actions.className = 'downloaded-library-actions';
        deleteButton.className = 'action-button downloaded-delete-button';
        deleteButton.type = 'button';
        deleteButton.setAttribute('tabindex', '-1');

        title.textContent = titleText;
        subtitle.textContent = getDownloadedLibrarySubtitle(item);
        meta.textContent = getDownloadedLibraryMeta(item);
        file.textContent = getDownloadedLibraryFileName(item);
        progressFill.style.width = percent + '%';
        progressLabel.textContent = percent + '%';
        deleteButton.textContent = state.downloadedLibraryDeleting[item.hash] ? 'Deleting' : 'Delete';
        deleteButton.disabled = !!state.downloadedLibraryDeleting[item.hash];
        deleteButton.addEventListener('click', function(event) {
            event.stopPropagation();
            deleteDownloadedLibraryItem(item.hash);
        });

        progressRail.appendChild(progressFill);
        progressRow.appendChild(progressRail);
        progressRow.appendChild(progressLabel);
        main.appendChild(title);
        main.appendChild(subtitle);
        main.appendChild(progressRow);
        main.appendChild(meta);
        if (file.textContent) {
            main.appendChild(file);
        }
        actions.appendChild(deleteButton);
        row.appendChild(createDownloadedPoster(metadata.poster || metadata.background, titleText));
        row.appendChild(main);
        row.appendChild(actions);
        fragment.appendChild(row);
    });

    list.appendChild(fragment);
    markFocusRegistryDirty();
}

function renderLibraryView() {
    var items = getLibraryCardItems();
    var empty = byId('libraryEmptyState');
    var grid = byId('libraryGrid');
    var downloadedPanel = byId('downloadedLibraryPanel');
    var savedToggle = byId('librarySavedToggle');
    var downloadsToggle = byId('libraryDownloadsToggle');
    var savedMode = !isDownloadedLibraryMode();

    if (!grid) {
        return;
    }

    if (savedToggle) {
        savedToggle.classList.toggle('is-selected', savedMode);
    }
    if (downloadsToggle) {
        downloadsToggle.classList.toggle('is-selected', !savedMode);
    }

    grid.style.display = savedMode ? '' : 'none';
    if (downloadedPanel) {
        downloadedPanel.classList.toggle('is-visible', !savedMode);
    }

    if (savedMode) {
        renderCardRows('libraryGrid', items, null, LIBRARY_ROW_SIZE, {
            hideSynopsis: true
        });
        byId('libraryCount').textContent = items.length
            ? items.length + ' saved'
            : 'Nothing saved yet';
    } else {
        renderDownloadedLibraryView();
        byId('libraryCount').textContent = state.downloadedLibraryLoading
            ? 'Loading downloads'
            : state.downloadedLibraryItems.length + ' cached';
    }

    if (empty) {
        empty.textContent = savedMode
            ? 'Add films and series from their detail pages to keep them here.'
            : '';
        empty.classList.toggle('is-visible', savedMode && !items.length);
    }
}

function isSelectedInLibrary() {
    var key;

    if (!state.selectedItem || !state.selectedType) {
        return false;
    }

    key = state.selectedType + ':' + state.selectedItem.id;
    return state.libraryItems.some(function(entry) {
        return continueEntryKey(entry) === key;
    });
}

function updateLibraryButtonUi() {
    var button = byId('detailLibraryButton');
    var selected = !!(state.selectedItem && state.selectedType);
    var saved = selected && isSelectedInLibrary();

    if (!button) {
        return;
    }

    button.disabled = !selected;
    button.classList.toggle('is-saved', saved);
    button.setAttribute('aria-label', saved ? 'Remove from library' : 'Add to library');
    button.title = saved ? 'Remove this title from your library' : 'Add this title to your library';
}

function addSelectedToLibrary() {
    var snapshot;
    var key;

    if (!state.selectedItem || !state.selectedType) {
        setAddonsMessage('Choose a title first.', 'error');
        updateLibraryButtonUi();
        return;
    }

    snapshot = {
        kind: state.selectedType,
        item: cloneContinueItem(state.selectedItem),
        addedAt: new Date().toISOString()
    };
    key = continueEntryKey(snapshot);

    if (isSelectedInLibrary()) {
        removeSelectedFromLibrary();
        return;
    }

    state.libraryItems = [snapshot].concat(state.libraryItems.filter(function(entry) {
        return continueEntryKey(entry) !== key;
    })).slice(0, LIBRARY_LIMIT);

    saveLibraryItems();
    renderLibraryView();
    updateLibraryButtonUi();
    setAddonsMessage('Added to your library.', 'success');
    syncLibraryToNuvio();
}

function removeSelectedFromLibrary() {
    var key;

    if (!state.selectedItem || !state.selectedType) {
        setAddonsMessage('Choose a title first.', 'error');
        updateLibraryButtonUi();
        return;
    }

    key = state.selectedType + ':' + state.selectedItem.id;
    state.libraryItems = state.libraryItems.filter(function(entry) {
        return continueEntryKey(entry) !== key;
    });

    saveLibraryItems();
    renderLibraryView();
    updateLibraryButtonUi();
    setAddonsMessage('Removed from your library.', 'success');
    syncLibraryToNuvio();
}

function fetchBrowseCatalog(type, append) {
    var option = getSelectedBrowseOption(type);
    var ratingCombined = getSelectedRatingCombinedOptions(type);
    var yearCombined = isBlockbusterCatalogOption(option) ? null : getSelectedYearCombinedOptions(type);
    var currentItems = getBrowseItems(type);
    var visibleSkip = append ? currentItems.length : 0;
    var storedSkip = append ? getBrowseSkip(type) : 0;
    var useLocalPaging = usesLocalBrowsePaging(option, visibleSkip);
    var requestSkip = useLocalPaging ? 0 : getBrowseRequestSkip(option, storedSkip || visibleSkip);
    var genreFilter = getBrowseGenreFilterLabel(option);
    var ratingFilter = getSelectedRatingBrowseOption(type);
    var requestLimit = isBlockbusterCatalogOption(option)
        ? getBlockbusterBrowseLimit(append)
        : genreFilter && isCinemetaTopCatalog(option)
        ? CINEMETA_CATALOG_PAGE_SIZE
        : ratingFilter
        ? CINEMETA_CATALOG_PAGE_SIZE
        : append && isCinemetaSeriesTopCatalog(option) && !useLocalPaging
        ? CINEMETA_CATALOG_PAGE_SIZE
        : (append ? BROWSE_LOAD_MORE_SIZE : BROWSE_PAGE_SIZE);
    var requestId;

    function finishAppendLoading() {
        if (append && isBrowseRequestCurrent(type, requestId)) {
            setBrowseLoadingMore(type, false);
            updateBrowseLoadMoreButton(type);
        }
    }

    if (append && getBrowseLoadingMore(type)) {
        return Promise.resolve();
    }
    requestId = bumpBrowseRequestId(type);
    if (append) {
        setBrowseLoadingMore(type, true);
        updateBrowseLoadMoreButton(type);
    }

    if (!option) {
        setBrowseItems(type, []);
        setBrowseCanLoadMore(type, false);
        finishAppendLoading();
        renderBrowseViews();
        updateConnectionStatus('No addon catalogs are available for ' + type + '.', false, true);
        return Promise.resolve();
    }

    if (ratingCombined) {
        updateConnectionStatus('Loading ' + type + ' browse...', false, false);
        return fetchRatingCombinedBrowse(type, ratingCombined, currentItems, append, storedSkip).then(function(result) {
            if (!isBrowseRequestCurrent(type, requestId)) {
                return;
            }
            setBrowseItems(type, result.items);
            setBrowseSkip(type, result.nextSkip);
            setBrowseCanLoadMore(type, result.canLoadMore);
            if (append && result.items.length === currentItems.length) {
                updateConnectionStatus('No more full rows are available in this catalog.', false, true);
            } else {
                updateConnectionStatus('Addon catalogs ready', true, false);
            }
            renderBrowseViews();
            if ((type === 'movie' && state.currentView === 'movies') || (type === 'series' && state.currentView === 'series')) {
                setTimeout(focusCurrent, 0);
            }
            finishAppendLoading();
            scheduleBrowsePrefetch(type);
        }).catch(function(error) {
            if (!isBrowseRequestCurrent(type, requestId)) {
                return;
            }
            finishAppendLoading();
            updateConnectionStatus('Catalog error: ' + error.message, false, true);
        });
    }

    if (yearCombined) {
        updateConnectionStatus('Loading ' + type + ' browse...', false, false);
        return fetchYearCombinedBrowse(type, yearCombined.baseOption, yearCombined.yearOption, currentItems, append).then(function(result) {
            if (!isBrowseRequestCurrent(type, requestId)) {
                return;
            }
            setBrowseItems(type, result.items);
            setBrowseSkip(type, result.items.length);
            setBrowseCanLoadMore(type, result.canLoadMore);
            if (append && result.items.length === currentItems.length) {
                updateConnectionStatus('No more full rows are available in this catalog.', false, true);
            } else {
                updateConnectionStatus('Addon catalogs ready', true, false);
            }
            renderBrowseViews();
            if ((type === 'movie' && state.currentView === 'movies') || (type === 'series' && state.currentView === 'series')) {
                setTimeout(focusCurrent, 0);
            }
            finishAppendLoading();
            scheduleBrowsePrefetch(type);
        }).catch(function(error) {
            if (!isBrowseRequestCurrent(type, requestId)) {
                return;
            }
            finishAppendLoading();
            updateConnectionStatus('Catalog error: ' + error.message, false, true);
        });
    }

    if (append && usesCinemetaBrowseExpansion(option)) {
        updateConnectionStatus('Loading ' + type + ' browse...', false, false);
        return fetchCinemetaBrowseAppend(type, option, currentItems).then(function(result) {
            if (!isBrowseRequestCurrent(type, requestId)) {
                return;
            }
            setBrowseItems(type, result.items);
            setBrowseSkip(type, result.items.length);
            setBrowseCanLoadMore(type, result.canLoadMore);
            setBrowseExpansionIndex(type, getBrowseExpansionIndex(type) + result.consumedSources);
            renderBrowseViews();
            updateConnectionStatus(
                result.items.length === currentItems.length
                    ? 'No more full rows are available in this catalog.'
                    : 'Addon catalogs ready',
                result.items.length !== currentItems.length,
                result.items.length === currentItems.length
            );
            if ((type === 'movie' && state.currentView === 'movies') || (type === 'series' && state.currentView === 'series')) {
                setTimeout(focusCurrent, 0);
            }
            finishAppendLoading();
            scheduleBrowsePrefetch(type);
        }).catch(function(error) {
            if (!isBrowseRequestCurrent(type, requestId)) {
                return;
            }
            finishAppendLoading();
            updateConnectionStatus('Catalog error: ' + error.message, false, true);
        });
    }

    if (append && !useLocalPaging && !supportsRemoteBrowsePaging(option)) {
        setBrowseCanLoadMore(type, false);
        finishAppendLoading();
        renderBrowseViews();
        updateConnectionStatus('This catalog does not support loading more items.', false, true);
        return Promise.resolve();
    }

    updateConnectionStatus('Loading ' + type + ' browse...', false, false);

    return requestBrowseCatalogPayload(option, requestSkip, isBlockbusterCatalogOption(option) ? {
        limit: requestLimit
    } : null).then(function(payload) {
        if (!isBrowseRequestCurrent(type, requestId)) {
            return;
        }
        var rawItems = useLocalPaging
            ? uniqueCatalogItems(payload && Array.isArray(payload.metas) ? payload.metas : [])
            : uniqueCatalogItems(normalizeCatalogPayloadWithLimit(payload, requestLimit));
        var normalized = orderItemsForBrowseOption(rawItems, option);
        var filtered = filterItemsForBrowseOption(normalized, option);
        var items = useLocalPaging ? filtered.slice(visibleSkip, visibleSkip + requestLimit) : filtered.slice(0, requestLimit);
        var nextItems = trimToFullBrowseRows(append ? uniqueCatalogItems(currentItems.concat(items)) : items);
        var remainingLocalItems = filtered.length - nextItems.length;
        var remoteNextSkip = payload && typeof payload.nextSkip === 'number'
            ? payload.nextSkip
            : requestSkip + rawItems.length;
        var canLoadMore = useLocalPaging
            ? remainingLocalItems >= BROWSE_ROW_SIZE || isCinemetaSeriesTopCatalog(option)
            : supportsRemoteBrowsePaging(option) && (
                payload && typeof payload.hasMore === 'boolean'
                    ? payload.hasMore && rawItems.length > 0
                    : genreFilter
                    ? rawItems.length > 0
                    : ratingFilter
                    ? rawItems.length > 0
                    : (!append || nextItems.length > currentItems.length)
            );

        setBrowseItems(type, nextItems);
        setBrowseSkip(type, useLocalPaging ? nextItems.length : remoteNextSkip);
        setBrowseCanLoadMore(type, canLoadMore);
        if (append && nextItems.length === currentItems.length) {
            updateConnectionStatus('No more full rows are available in this catalog.', false, true);
        } else {
            updateConnectionStatus('Addon catalogs ready', true, false);
        }
        renderBrowseViews();
        if ((type === 'movie' && state.currentView === 'movies') || (type === 'series' && state.currentView === 'series')) {
            setTimeout(focusCurrent, 0);
        }
        finishAppendLoading();
        scheduleBrowsePrefetch(type);
    }).catch(function(error) {
        if (!isBrowseRequestCurrent(type, requestId)) {
            return;
        }
        finishAppendLoading();
        updateConnectionStatus('Catalog error: ' + error.message, false, true);
    });
}

function fetchCatalogs() {
    updateConnectionStatus('Loading catalogs...', false, false);

    return fetchCatalogManifest().then(function() {
        var movieOption = getSelectedBrowseOption('movie');
        var seriesOption = getSelectedBrowseOption('series');
        var movieRequest = movieOption
            ? requestBrowseCatalogPayload(movieOption, 0).catch(function() {
                return { metas: [] };
            })
            : Promise.resolve({ metas: [] });
        var seriesRequest = seriesOption
            ? requestBrowseCatalogPayload(seriesOption, 0).catch(function() {
                return { metas: [] };
            })
            : Promise.resolve({ metas: [] });

        return Promise.all([movieRequest, seriesRequest]).then(function(results) {
            var movieRawItems = uniqueCatalogItems(normalizeCatalogPayloadWithLimit(results[0], CINEMETA_CATALOG_PAGE_SIZE));
            var seriesRawItems = uniqueCatalogItems(normalizeCatalogPayloadWithLimit(results[1], CINEMETA_CATALOG_PAGE_SIZE));
            var movieItems = orderItemsForBrowseOption(movieRawItems, movieOption);
            var seriesItems = orderItemsForBrowseOption(seriesRawItems, seriesOption);

            state.movies = uniqueCatalogItems(normalizeCatalogPayload(results[0]), HOME_CATALOG_LIMIT);
            state.series = uniqueCatalogItems(normalizeCatalogPayload(results[1]), HOME_CATALOG_LIMIT);
            state.movieBrowseItems = trimToFullBrowseRows(filterItemsForBrowseOption(movieItems, movieOption).slice(0, BROWSE_PAGE_SIZE));
            state.seriesBrowseItems = trimToFullBrowseRows(filterItemsForBrowseOption(seriesItems, seriesOption).slice(0, BROWSE_PAGE_SIZE));
            setBrowseSkip('movie', movieRawItems.length);
            setBrowseSkip('series', seriesRawItems.length);
            renderCatalogViews();
            renderBrowseViews();
            scheduleBrowsePrefetch('movie');
            scheduleBrowsePrefetch('series');

            if (!state.movies.length && !state.series.length) {
                updateConnectionStatus('No addon catalogs are available yet.', false, true);
                return;
            }

            updateConnectionStatus('Addon catalogs ready', true, false);
            focusCurrent();
        });
    }).catch(function(error) {
        updateConnectionStatus('Catalog error: ' + error.message, false, true);
        setLoginMessage('Catalog fetch failed: ' + error.message, 'error');
    });
}

function getQrAuthHeaders() {
    return {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + (state.qrAuthAccessToken || SUPABASE_ANON_KEY)
    };
}

function extractQrSessionTokens(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    return {
        accessToken: payload.access_token || payload.accessToken || (payload.session && payload.session.access_token) || null,
        refreshToken: payload.refresh_token || payload.refreshToken || (payload.session && payload.session.refresh_token) || null
    };
}

function generateQrDeviceNonce() {
    var bytes;
    var binary = '';

    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
    }

    bytes = new Uint8Array(24);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        window.crypto.getRandomValues(bytes);
    } else {
        bytes = Array.prototype.map.call(bytes, function() {
            return Math.floor(Math.random() * 256);
        });
    }

    Array.prototype.forEach.call(bytes, function(value) {
        binary += String.fromCharCode(value);
    });

    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function clearQrLoginTimers() {
    if (state.qrPollTimer) {
        clearInterval(state.qrPollTimer);
        state.qrPollTimer = null;
    }
    if (state.qrExpiresTimer) {
        clearInterval(state.qrExpiresTimer);
        state.qrExpiresTimer = null;
    }
}

function setQrExpiryMessage(text) {
    var el = byId('qrLoginExpiry');
    if (!el) {
        return;
    }
    el.textContent = text;
}

function renderQrLoginSignedIn() {
    var image = byId('qrLoginImage');
    var code = byId('qrLoginCode');

    clearQrLoginTimers();
    state.qrStarting = false;
    state.qrCode = null;
    state.qrLoginUrl = '';
    state.qrDeviceNonce = '';
    state.qrExpiresAt = 0;

    if (image) {
        image.removeAttribute('src');
        image.classList.remove('is-ready');
    }
    if (code) {
        code.textContent = 'TV already connected';
    }
    setQrExpiryMessage('Use Refresh QR to connect a different account from your phone.');
    setQrLoginMessage('QR login is available, but this TV already has a Nuvio session.', 'success');
}

function renderQrLoginPlaceholder(codeText, expiryText, helperText, tone) {
    var image = byId('qrLoginImage');
    var code = byId('qrLoginCode');

    if (image) {
        image.removeAttribute('src');
        image.classList.remove('is-ready');
    }
    if (code) {
        code.textContent = codeText;
    }
    setQrExpiryMessage(expiryText);
    setQrLoginMessage(helperText, tone);
}

function renderQrLoginSession(session) {
    var image = byId('qrLoginImage');
    var code = byId('qrLoginCode');

    if (image) {
        image.src = session.qrImageUrl;
        image.classList.add('is-ready');
    }
    if (code) {
        code.textContent = 'Code: ' + session.code;
    }
    setQrLoginMessage('Scan the QR code with your phone and approve the Nuvio sign-in.', null);
}

function refreshQrCountdown() {
    var remainingSeconds;

    if (!state.qrExpiresAt) {
        setQrExpiryMessage('Waiting for a fresh QR session.');
        return;
    }

    remainingSeconds = Math.max(0, Math.ceil((state.qrExpiresAt - Date.now()) / 1000));
    if (!remainingSeconds) {
        setQrExpiryMessage('This QR code expired. Refresh it to continue.');
        return;
    }

    setQrExpiryMessage('Expires in ' + remainingSeconds + 's');
}

function startQrCountdown() {
    if (state.qrExpiresTimer) {
        clearInterval(state.qrExpiresTimer);
        state.qrExpiresTimer = null;
    }
    refreshQrCountdown();
    state.qrExpiresTimer = setInterval(refreshQrCountdown, 1000);
}

function ensureQrAnonymousSession() {
    var baseHeaders = {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY
    };

    if (state.qrAuthAccessToken) {
        return Promise.resolve(state.qrAuthAccessToken);
    }

    return requestJsonWithHeaders(getNuvioAuthBaseUrl() + '/auth/v1/signup', 'POST', {
        data: {
            tv_client: 'nuvio-tv-shell'
        }
    }, baseHeaders).catch(function() {
        return requestJsonWithHeaders(getNuvioAuthBaseUrl() + '/auth/v1/token?grant_type=anonymous', 'POST', {}, baseHeaders);
    }).then(function(payload) {
        var tokens = extractQrSessionTokens(payload);

        if (!tokens || !tokens.accessToken) {
            throw new Error('QR auth bootstrap did not return a session token');
        }

        state.qrAuthAccessToken = tokens.accessToken;
        state.qrAuthRefreshToken = tokens.refreshToken || null;
        return tokens.accessToken;
    });
}

function startQrRpc(deviceNonce, includeDeviceName) {
    var body = {
        p_device_nonce: deviceNonce,
        p_redirect_base_url: TV_LOGIN_REDIRECT_BASE_URL
    };

    if (includeDeviceName) {
        body.p_device_name = 'Nuvio TV Shell';
    }

    return requestJsonWithHeaders(
        getNuvioAuthBaseUrl() + '/rest/v1/rpc/start_tv_login_session',
        'POST',
        body,
        getQrAuthHeaders()
    ).then(function(payload) {
        return Array.isArray(payload) ? payload[0] : payload;
    });
}

function extractQrApprovedSession(result) {
    var candidates = [
        result,
        result && result.data,
        result && result.result,
        result && result.session,
        result && result.nuvio,
        result && result.nuvioSession,
        result && result.nuvio_session,
        result && result.credentials
    ];
    var found = null;

    candidates.some(function(candidate) {
        var accessToken;
        var refreshToken;
        var user;

        if (Array.isArray(candidate)) {
            candidate = candidate[0];
        }
        if (!candidate || typeof candidate !== 'object') {
            return false;
        }

        accessToken = candidate.accessToken
            || candidate.access_token
            || candidate.authKey
            || candidate.auth_key
            || (candidate.session && candidate.session.access_token)
            || (candidate.nuvio && candidate.nuvio.accessToken)
            || (candidate.nuvio && candidate.nuvio.access_token)
            || (candidate.credentials && candidate.credentials.accessToken)
            || (candidate.credentials && candidate.credentials.access_token)
            || null;
        refreshToken = candidate.refreshToken
            || candidate.refresh_token
            || (candidate.session && candidate.session.refresh_token)
            || (candidate.nuvio && candidate.nuvio.refreshToken)
            || (candidate.nuvio && candidate.nuvio.refresh_token)
            || (candidate.credentials && candidate.credentials.refreshToken)
            || (candidate.credentials && candidate.credentials.refresh_token)
            || null;
        user = candidate.user
            || candidate.profile
            || candidate.nuvioUser
            || candidate.nuvio_user
            || (candidate.nuvio && candidate.nuvio.user)
            || (candidate.credentials && candidate.credentials.user)
            || null;

        if (!accessToken) {
            return false;
        }

        found = {
            accessToken: accessToken,
            refreshToken: refreshToken,
            user: user || null
        };
        return true;
    });

    return found;
}

function resolveQrApprovedUser(session) {
    if (session.user) {
        return Promise.resolve(session.user);
    }

    return requestSupabaseWithToken('/auth/v1/user', 'GET', null, session.accessToken).then(function(payload) {
        return payload && payload.user ? payload.user : payload;
    }).catch(function() {
        return null;
    });
}

function stopQrLoginSession(resetUi) {
    clearQrLoginTimers();
    state.qrSessionId += 1;
    state.qrStarting = false;
    state.qrCode = null;
    state.qrLoginUrl = '';
    state.qrDeviceNonce = '';
    state.qrExpiresAt = 0;

    if (resetUi && !state.authKey) {
        renderQrLoginPlaceholder(
            'Preparing QR sign-in…',
            'Waiting for a fresh QR session.',
            'Open the QR code on your phone to approve sign-in.',
            null
        );
    }
}

function exchangeQrLoginSession(sessionId) {
    return requestJsonWithHeaders(
        getNuvioAuthBaseUrl() + '/functions/v1/tv-logins-exchange',
        'POST',
        {
            code: state.qrCode,
            device_nonce: state.qrDeviceNonce
        },
        getQrAuthHeaders()
    ).then(function(result) {
        var session = extractQrApprovedSession(result);

        if (sessionId !== state.qrSessionId) {
            return null;
        }

        if (!session || !session.accessToken) {
            throw new Error('QR sign-in completed, but no Nuvio session token was returned');
        }

        return resolveQrApprovedUser(session).then(function(user) {
            storeSession(session.accessToken, session.refreshToken || null, user || session.user || null);
            updateSessionStatus('Signed in', true, false);
            setLoginMessage('Signed in successfully via QR code.', 'success');
            renderQrLoginSignedIn();
            return fetchInstalledAddons().then(function() {
                return syncNuvioUserData();
            }).then(function() {
                return fetchCatalogs();
            }).then(function() {
                setView('home', {
                    focusRegion: 'main',
                    resetMain: true
                });
            });
        });
    });
}

function pollQrLoginSession(sessionId) {
    return requestJsonWithHeaders(
        getNuvioAuthBaseUrl() + '/rest/v1/rpc/poll_tv_login_session',
        'POST',
        {
            p_code: state.qrCode,
            p_device_nonce: state.qrDeviceNonce
        },
        getQrAuthHeaders()
    ).then(function(payload) {
        var result = Array.isArray(payload) ? payload[0] : payload;
        var status = result && result.status ? result.status : null;

        if (sessionId !== state.qrSessionId || !status) {
            return;
        }

        if (status === 'approved') {
            clearQrLoginTimers();
            setQrExpiryMessage('Phone approved. Finishing TV sign-in…');
            return exchangeQrLoginSession(sessionId).catch(function(error) {
                setQrLoginMessage('QR login failed: ' + error.message, 'error');
                setQrExpiryMessage('Refresh the QR code and try again.');
            });
        }

        if (status === 'expired') {
            clearQrLoginTimers();
            setQrLoginMessage('This QR code expired. Refresh it to continue.', 'error');
            setQrExpiryMessage('Expired');
            return;
        }

        setQrLoginMessage('Waiting for phone approval…', null);
    }).catch(function(error) {
        if (sessionId !== state.qrSessionId) {
            return;
        }
        clearQrLoginTimers();
        setQrLoginMessage('QR login failed: ' + error.message, 'error');
        setQrExpiryMessage('Refresh the QR code and try again.');
    });
}

function startQrLoginSession(forceRefresh) {
    var sessionId;
    var deviceNonce;

    if (state.currentView !== 'login') {
        return Promise.resolve();
    }

    if (state.authKey && !forceRefresh) {
        renderQrLoginSignedIn();
        return Promise.resolve();
    }

    if (state.qrStarting) {
        return Promise.resolve();
    }

    stopQrLoginSession(false);
    state.qrStarting = true;
    sessionId = state.qrSessionId + 1;
    state.qrSessionId = sessionId;
    deviceNonce = generateQrDeviceNonce();
    state.qrDeviceNonce = deviceNonce;

    renderQrLoginPlaceholder(
        'Preparing QR sign-in…',
        'Creating a fresh TV login session.',
        'Open the QR code on your phone to approve sign-in.',
        null
    );

    if (byId('qrRefreshButton')) {
        byId('qrRefreshButton').disabled = true;
    }

    return ensureQrAnonymousSession().then(function() {
        return startQrRpc(deviceNonce, true).catch(function(error) {
            if (error.message && error.message.indexOf('p_device_name') !== -1) {
                return startQrRpc(deviceNonce, false);
            }
            throw error;
        });
    }).then(function(session) {
        var qrImageUrl;
        var pollSeconds;

        if (sessionId !== state.qrSessionId || !session) {
            return;
        }

        qrImageUrl = session.qr_image_url
            || 'https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=' + encodeURIComponent(session.qr_content || session.web_url || '');
        pollSeconds = Math.max(2, Number(session.poll_interval_seconds || 3));

        state.qrCode = session.code;
        state.qrLoginUrl = session.qr_content || session.web_url || '';
        state.qrExpiresAt = Date.parse(session.expires_at || '') || (Date.now() + 5 * 60 * 1000);
        state.qrStarting = false;

        renderQrLoginSession({
            code: session.code,
            qrImageUrl: qrImageUrl
        });
        startQrCountdown();
        state.qrPollTimer = setInterval(function() {
            pollQrLoginSession(sessionId);
        }, pollSeconds * 1000);
        pollQrLoginSession(sessionId);
    }).catch(function(error) {
        if (sessionId !== state.qrSessionId) {
            return;
        }
        state.qrStarting = false;
        renderQrLoginPlaceholder(
            'QR sign-in unavailable',
            'Refresh the QR code to try again.',
            'QR login failed: ' + error.message,
            'error'
        );
    }).finally(function() {
        if (byId('qrRefreshButton')) {
            byId('qrRefreshButton').disabled = false;
        }
    });
}

function storeSession(authKey, refreshToken, user) {
    state.authKey = authKey || null;
    state.refreshToken = refreshToken || null;
    state.user = user || null;
    state.ownerId = null;

    if (state.authKey) {
        localStorage.setItem(STORAGE_AUTH, state.authKey);
    } else {
        localStorage.removeItem(STORAGE_AUTH);
    }

    if (state.refreshToken) {
        localStorage.setItem(STORAGE_REFRESH, state.refreshToken);
    } else {
        localStorage.removeItem(STORAGE_REFRESH);
    }

    if (state.user) {
        localStorage.setItem(STORAGE_USER, JSON.stringify(state.user));
    } else {
        localStorage.removeItem(STORAGE_USER);
    }

    updateUserPanel();

    if (state.currentView === 'login') {
        if (state.authKey) {
            renderQrLoginSignedIn();
        } else {
            renderQrLoginPlaceholder(
                'Preparing QR sign-in…',
                'Waiting for a fresh QR session.',
                'Open the QR code on your phone to approve sign-in.',
                null
            );
        }
    }
}

function restoreStoredSession() {
    var authKey = localStorage.getItem(STORAGE_AUTH);
    var refreshToken = localStorage.getItem(STORAGE_REFRESH);
    var user = null;

    try {
        user = JSON.parse(localStorage.getItem(STORAGE_USER) || 'null');
    } catch (error) {
        user = null;
    }

    if (authKey) {
        state.authKey = authKey;
        state.refreshToken = refreshToken || null;
        state.user = user;
        updateSessionStatus('Stored session found', true, false);
    } else {
        updateSessionStatus('Signed out', false, false);
    }
}

function verifyStoredSession() {
    if (!state.authKey) {
        return Promise.resolve();
    }

    return refreshSessionIfNeeded().then(function(isValid) {
        if (!isValid) {
            throw new Error('Stored session expired');
        }

        return fetchCurrentSupabaseUser();
    }).then(function(payload) {
        state.user = payload || null;
        localStorage.setItem(STORAGE_USER, JSON.stringify(state.user));
        updateUserPanel();
        updateSessionStatus('Signed in', true, false);
        setLoginMessage('Restored existing Nuvio session.', 'success');
    }).catch(function() {
        storeSession(null, null, null);
        updateSessionStatus('Stored session expired', false, true);
        setLoginMessage('Stored session was invalid. Sign in again.', 'error');
    });
}

function login(email, password) {
    setLoginMessage('Signing in...', null);

    return requestSupabaseAuth('/auth/v1/token?grant_type=password', 'POST', {
        email: email,
        password: password
    }).then(function(payload) {
        if (!payload || !payload.access_token) {
            throw new Error('No access token returned');
        }

        return fetchCurrentSupabaseUserForToken(payload.access_token).then(function(user) {
            storeSession(payload.access_token, payload.refresh_token || null, user || payload.user || null);
            updateSessionStatus('Signed in', true, false);
            setLoginMessage('Signed in successfully.', 'success');

            return fetchInstalledAddons().then(function() {
                return syncNuvioUserData();
            }).then(function() {
                return fetchCatalogs();
            }).then(function() {
                setView('home', {
                    focusRegion: 'main',
                    resetMain: true
                });
            });
        });
    });
}

function logout() {
    storeSession(null, null, null);
    state.streams = [];
    state.currentStream = null;
    updateSessionStatus('Signed out', false, false);
    setLoginMessage('Signed out locally.', null);
    setAddonsMessage('Sign in with Nuvio to load your synced stream addons.', null);

    return fetchInstalledAddons().then(function() {
        renderAddons();
        renderPlayerState();
        return fetchCatalogs();
    }).then(function() {
        if (state.currentView === 'login') {
            startQrLoginSession(false);
        }
    });
}

function fetchInstalledAddons() {
    return fetchAddonUrlsFromNuvio().then(function(urls) {
        var uniqueUrls = uniqueList((urls || []).map(canonicalizeAddonUrl).filter(Boolean));

        return Promise.all(uniqueUrls.map(function(url) {
            return fetchAddonDefinition(url);
        }));
    }).then(function(addons) {
        state.addons = (addons || []).filter(Boolean);
        renderAddons();
        return state.addons;
    }).catch(function(error) {
        return Promise.all(DEFAULT_ADDON_URLS.map(function(url) {
            return fetchAddonDefinition(url);
        })).then(function(defaultAddons) {
            state.addons = (defaultAddons || []).filter(Boolean);
            renderAddons();
            setAddonsMessage('Could not load synced addons. Showing default catalogs only.', 'error');
            return state.addons;
        });
    });
}
