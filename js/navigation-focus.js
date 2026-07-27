function updatePageHeader() {
    var meta = VIEW_META[state.currentView];
    document.body.setAttribute('data-current-view', state.currentView);
    byId('pageEyebrow').textContent = meta.eyebrow;
    byId('pageTitle').textContent = meta.title;
    byId('pageSubtitle').textContent = meta.subtitle;
}

function updateNavState() {
    var activeView = state.currentView;

    if (NAV_VIEWS.indexOf(activeView) === -1) {
        if (state.currentView === 'addons' || state.currentView === 'player') {
            activeView = state.selectedType === 'series' ? 'series' : 'movies';
        } else {
            activeView = 'home';
        }
    }

    queryAll('.nav-item').forEach(function(item) {
        item.classList.toggle('is-active', item.getAttribute('data-view') === activeView);
    });
}

function updateViewState() {
    queryAll('[data-view-panel]').forEach(function(panel) {
        panel.classList.toggle('is-active', panel.getAttribute('data-view-panel') === state.currentView);
    });
    markFocusRegistryDirty();
    updateRowEmphasis();
}

function chunkItems(items, size) {
    var rows = [];
    var index;

    for (index = 0; index < items.length; index += size) {
        rows.push(items.slice(index, index + size));
    }

    return rows;
}

function buildMainRowContainers() {
    if (state.currentView === 'home') {
        return [
            byId('homeHeroRow'),
            byId('homeContinueSection'),
            byId('homeMoviesSection'),
            byId('homeSeriesSection')
        ].filter(function(el) {
            return el && el.style.display !== 'none';
        });
    }

    if (state.currentView === 'movies') {
        var movieContainers = [byId('movieGenreSection')];
        queryAll('#movieGrid .card-row').forEach(function(row) {
            movieContainers.push(row);
        });
        movieContainers.push(byId('movieLoadSection'));
        return movieContainers.filter(Boolean);
    }

    if (state.currentView === 'library') {
        var libraryContainers = [byId('libraryShelfSection')];
        if (state.libraryMode === 'downloads') {
            queryAll('#downloadedLibraryList .downloaded-library-row').forEach(function(row) {
                libraryContainers.push(row);
            });
        } else {
            queryAll('#libraryGrid .card-row').forEach(function(row) {
                libraryContainers.push(row);
            });
        }
        return libraryContainers.filter(Boolean);
    }

    if (state.currentView === 'series') {
        var seriesContainers = [byId('seriesGenreSection')];
        queryAll('#seriesGrid .card-row').forEach(function(row) {
            seriesContainers.push(row);
        });
        seriesContainers.push(byId('seriesLoadSection'));
        return seriesContainers.filter(Boolean);
    }

    if (state.currentView === 'search') {
        var searchContainers = [];
        var keyboardRows = queryAll('#searchKeyboard .search-keyboard-row');
        var suggestionButtons = queryAll('#searchSuggestionList .search-suggestion');

        keyboardRows.forEach(function() {
            searchContainers.push(byId('searchShellSection'));
        });

        suggestionButtons.forEach(function() {
            searchContainers.push(byId('searchShellSection'));
        });

        queryAll('#searchResultGrid .card-row').forEach(function(row) {
            searchContainers.push(row);
        });

        return searchContainers.filter(Boolean);
    }

    if (state.currentView === 'addons') {
        var addonContainers = [byId('detailHeroRow')];
        var episodeBrowserRows = getEpisodeBrowserRowCount();
        var episodeRowIndex;

        if (queryAll('#detailRelatedRow .card').filter(isVisibleControl).length) {
            addonContainers.push(byId('detailRelatedSection'));
        }
        for (episodeRowIndex = 0; episodeRowIndex < episodeBrowserRows; episodeRowIndex += 1) {
            addonContainers.push(byId('episodeSection'));
        }
        if (queryAll('#streamSourceToggle .library-toggle-button').filter(isVisibleControl).length) {
            addonContainers.push(byId('streamSection'));
        }
        queryAll('#streamList .stream-card').filter(isVisibleControl).forEach(function() {
            addonContainers.push(byId('streamSection'));
        });
        return addonContainers.filter(function(el) {
            return el && el.style.display !== 'none';
        });
    }

    if (state.currentView === 'player') {
        var playerContainers = [];
        var stage = queryAll('.player-layout > section')[0];
        var side = queryAll('.player-layout > section')[1];
        var rows = buildMainRows();

        rows.forEach(function(_, index) {
            if (state.playerFullscreen) {
                playerContainers.push(stage);
                return;
            }
            playerContainers.push(index <= 1 ? stage : side);
        });

        return playerContainers.filter(Boolean);
    }

    return [
        byId('loginForm'),
        byId('loginForm'),
        byId('loginForm'),
        byId('qrLoginCard')
    ].filter(Boolean);
}

function buildMainRows() {
    if (state.currentView === 'home') {
        var homeRows = [];
        var actions = queryAll('#homeActions .action-button');
        var continueCards = queryAll('#continueRail .card');
        var movieCards = queryAll('#homeMovieRail .card').filter(function(card) {
            return !card.classList.contains('is-home-peek');
        });
        var seriesCards = queryAll('#homeSeriesRail .card').filter(function(card) {
            return !card.classList.contains('is-home-peek');
        });

        if (actions.length) {
            homeRows.push(actions);
        }
        if (continueCards.length) {
            homeRows.push(continueCards);
        }
        if (movieCards.length) {
            homeRows.push(movieCards);
        }
        if (seriesCards.length) {
            homeRows.push(seriesCards);
        }
        return homeRows;
    }

    if (state.currentView === 'movies') {
        var movieRows = [];
        var movieGenres = queryAll('#movieGenreRow .genre-chip');
        var movieCardRows = queryAll('#movieGrid .card-row');

        if (movieGenres.length) {
            movieRows.push(movieGenres);
        }
        movieCardRows.forEach(function(row) {
            var cards = queryAll('#' + row.id + ' .card');
            if (cards.length) {
                movieRows.push(cards);
            }
        });
        if (!movieCardRows.length) {
            var movieCards = queryAll('#movieGrid .card');
            if (movieCards.length) {
                movieRows.push(movieCards);
            }
        }
        if (!byId('movieLoadMoreButton').disabled) {
            movieRows.push([byId('movieLoadMoreButton')]);
        }
        return movieRows;
    }

    if (state.currentView === 'library') {
        var libraryRows = [];
        var libraryToggles = queryAll('#libraryToggle .library-toggle-button').filter(isVisibleControl);

        if (libraryToggles.length) {
            libraryRows.push(libraryToggles);
        }

        if (state.libraryMode === 'downloads') {
            var refreshButton = byId('downloadedLibraryRefreshButton');
            var downloadedRows = queryAll('#downloadedLibraryList .downloaded-library-row');

            if (refreshButton && isVisibleControl(refreshButton)) {
                libraryRows.push([refreshButton]);
            }

            downloadedRows.forEach(function(row) {
                var deleteButton = queryAll('#' + row.id + ' .downloaded-delete-button')[0];
                if (deleteButton && isVisibleControl(deleteButton)) {
                    libraryRows.push([row, deleteButton]);
                    return;
                }
                libraryRows.push([row]);
            });

            return libraryRows;
        }

        var libraryCardRows = queryAll('#libraryGrid .card-row');

        libraryCardRows.forEach(function(row) {
            var cards = queryAll('#' + row.id + ' .card');
            if (cards.length) {
                libraryRows.push(cards);
            }
        });

        return libraryRows;
    }

    if (state.currentView === 'series') {
        var seriesRows = [];
        var seriesGenres = queryAll('#seriesGenreRow .genre-chip');
        var seriesCardRows = queryAll('#seriesGrid .card-row');

        if (seriesGenres.length) {
            seriesRows.push(seriesGenres);
        }
        seriesCardRows.forEach(function(row) {
            var cards = queryAll('#' + row.id + ' .card');
            if (cards.length) {
                seriesRows.push(cards);
            }
        });
        if (!seriesCardRows.length) {
            var seriesCards = queryAll('#seriesGrid .card');
            if (seriesCards.length) {
                seriesRows.push(seriesCards);
            }
        }
        if (!byId('seriesLoadMoreButton').disabled) {
            seriesRows.push([byId('seriesLoadMoreButton')]);
        }
        return seriesRows;
    }

    if (state.currentView === 'search') {
        var searchRows = [];
        var keyboardRows = queryAll('#searchKeyboard .search-keyboard-row');
        var suggestionButtons = queryAll('#searchSuggestionList .search-suggestion');
        var resultRows = queryAll('#searchResultGrid .card-row');

        keyboardRows.forEach(function(row) {
            var cards = queryAll('#' + row.id + ' .card');
            var keys;
            if (cards.length) {
                return;
            }
            keys = queryAll('#' + row.id + ' .search-key');
            if (keys.length) {
                searchRows.push(keys);
            }
        });

        suggestionButtons.forEach(function(button) {
            searchRows.push([button]);
        });

        resultRows.forEach(function(row) {
            var cards = queryAll('#' + row.id + ' .card');
            if (cards.length) {
                searchRows.push(cards);
            }
        });
        return searchRows;
    }

    if (state.currentView === 'addons') {
        var addonRows = [];
        var detailActions = queryAll('#detailActions .action-button').filter(isVisibleControl);
        var trailerActions = state.detailTrailerActive
            ? queryAll('#detailTrailerControls .action-button').filter(isVisibleControl)
            : [];
        var relatedCards = queryAll('#detailRelatedRow .card').filter(isVisibleControl);
        var seasons = queryAll('#seasonRail .season-chip').filter(isVisibleControl);
        var episodes = queryAll('#episodeRail .episode-card').filter(isVisibleControl);
        var streamFilters = queryAll('#streamSourceToggle .library-toggle-button').filter(isVisibleControl);
        var streams = queryAll('#streamList .stream-card').filter(isVisibleControl);
        var browserRowCount = Math.max(seasons.length, episodes.length);
        var browserRowIndex;

        if (detailActions.length || trailerActions.length) {
            addonRows.push(detailActions.concat(trailerActions));
        }
        if (relatedCards.length) {
            addonRows.push(relatedCards);
        }

        for (browserRowIndex = 0; browserRowIndex < browserRowCount; browserRowIndex += 1) {
            var browserRow = [];
            if (seasons[browserRowIndex]) {
                browserRow.push(seasons[browserRowIndex]);
            }
            if (episodes[browserRowIndex]) {
                browserRow.push(episodes[browserRowIndex]);
            }
            if (browserRow.length) {
                addonRows.push(browserRow);
            }
        }

        if (streamFilters.length) {
            addonRows.push(streamFilters);
        }

        streams.forEach(function(streamButton) {
            addonRows.push([streamButton]);
        });

        return addonRows;
    }

    if (state.currentView === 'player') {
        var playerRows = [];
        var progressButton = byId('playerProgressButton');
        var playerActions = queryAll('#playerActions .action-button');
        var audioButtons = queryAll('#audioTrackList .track-chip');
        var subtitleButtons = queryAll('#subtitleTrackList .track-chip');

        if (state.playerFullscreen) {
            if (document.body.classList.contains('is-player-chrome-visible') && playerActions.length) {
                return [[byId('videoFrameFocus')], [progressButton], playerActions];
            }
            return [[byId('videoFrameFocus')]];
        }

        if (progressButton) {
            playerRows.push([progressButton]);
        }
        if (playerActions.length) {
            playerRows.push(playerActions);
        }
        if (audioButtons.length) {
            playerRows.push(audioButtons);
        }
        if (subtitleButtons.length) {
            playerRows.push(subtitleButtons);
        }

        return playerRows.length ? playerRows : [[byId('videoFrameFocus')]];
    }

    return [
        [byId('emailInput')],
        [byId('passwordInput')],
        [byId('loginButton'), byId('logoutButton')],
        [byId('qrRefreshButton')]
    ];
}

function markFocusRegistryDirty() {
    if (!state.focusRegistry) {
        return;
    }

    state.focusRegistry.dirty = true;
}

function rebuildFocusRegistry() {
    if (!state.focusRegistry) {
        state.focusRegistry = {
            view: '',
            rows: [],
            rowContainers: [],
            dirty: true
        };
    }

    state.focusRegistry.view = state.currentView;
    state.focusRegistry.rows = buildMainRows();
    state.focusRegistry.rowContainers = buildMainRowContainers();
    state.focusRegistry.dirty = false;
}

function getFocusRegistry() {
    if (!state.focusRegistry || state.focusRegistry.dirty || state.focusRegistry.view !== state.currentView) {
        rebuildFocusRegistry();
    }

    return state.focusRegistry;
}

function getMainRows() {
    return getFocusRegistry().rows;
}

function getMainRowContainers() {
    return getFocusRegistry().rowContainers;
}

function buildContinueEntries() {
    return state.continueWatching.map(function(entry) {
        return {
            item: entry.item,
            kind: entry.kind,
            continueEntry: entry,
            continueProgress: getContinueProgress(entry),
            metaText: entry.kind === 'series' && entry.video
                ? 'Resume • Season ' + entry.video.season + ' • Episode ' + entry.video.episode
                : 'Resume watching'
        };
    });
}

function getContinueProgress(entry) {
    var position = entry && typeof entry.position === 'number' ? Math.max(0, entry.position) : 0;
    var duration = entry && typeof entry.duration === 'number' ? Math.max(0, entry.duration) : 0;
    var remaining;
    var percent;

    if (!duration || !position) {
        return null;
    }

    remaining = Math.max(0, duration - position);
    percent = Math.max(0, Math.min(100, (position / duration) * 100));

    return {
        percent: percent,
        currentLabel: formatPlaybackTime(position * 1000),
        durationLabel: formatPlaybackTime(duration * 1000),
        remainingLabel: remaining > 0 ? formatContinueRemainingTime(remaining) : 'Almost done'
    };
}

function formatContinueRemainingTime(seconds) {
    var totalMinutes = Math.max(1, Math.ceil((seconds || 0) / 60));
    var hours = Math.floor(totalMinutes / 60);
    var minutes = totalMinutes % 60;

    if (hours > 0 && minutes > 0) {
        return hours + 'h ' + minutes + 'm left';
    }
    if (hours > 0) {
        return hours + 'h left';
    }

    return totalMinutes + 'm left';
}

function getHomeRailDescriptors() {
    var descriptors = [];

    if (state.continueWatching.length) {
        descriptors.push({
            key: 'continue',
            containerId: 'continueRail',
            entries: buildContinueEntries()
        });
    }

    descriptors.push({
        key: 'movies',
        containerId: 'homeMovieRail',
        entries: state.movies.slice(0, HOME_CATALOG_LIMIT).map(function(item) {
            return { item: item, kind: 'movie' };
        })
    });

    descriptors.push({
        key: 'series',
        containerId: 'homeSeriesRail',
        entries: state.series.slice(0, HOME_CATALOG_LIMIT).map(function(item) {
            return { item: item, kind: 'series' };
        })
    });

    return descriptors;
}

function getHomeRailDescriptorForMainRow(rowIndex) {
    if (state.currentView !== 'home' || rowIndex <= 0) {
        return null;
    }

    return getHomeRailDescriptors()[rowIndex - 1] || null;
}

function getHomeRailDescriptorByKey(key) {
    return getHomeRailDescriptors().filter(function(descriptor) {
        return descriptor.key === key;
    })[0] || null;
}

function getHomeActiveMetaCacheKey(kind, item) {
    return kind && item && item.id ? kind + ':' + item.id : '';
}

function mergeHomeActiveMeta(item, kind) {
    var cacheKey = getHomeActiveMetaCacheKey(kind, item);
    var meta = cacheKey ? homeActiveMetaCache[cacheKey] : null;
    var merged = {};
    var prop;

    if (!meta) {
        return item;
    }

    for (prop in item) {
        if (Object.prototype.hasOwnProperty.call(item, prop)) {
            merged[prop] = item[prop];
        }
    }
    for (prop in meta) {
        if (Object.prototype.hasOwnProperty.call(meta, prop)) {
            merged[prop] = meta[prop];
        }
    }

    merged.id = item.id;
    merged.name = meta.name || item.name;
    merged.poster = item.poster || meta.poster;
    merged.background = item.background || meta.background || meta.poster;

    return merged;
}

function hasHomeActiveMetaDetails(item, key) {
    return !!(
        item && (
            item.runtime ||
            item.runtimeMins ||
            item.runtimeMinutes ||
            item.duration ||
            item.length
        )
    ) && !!getItemGenreLabel(item, getHomeGenreFallback(key));
}

function scheduleHomeActiveMetaEnrichment(entry, key) {
    var item = entry && entry.item;
    var kind = entry && entry.kind;
    var cacheKey = getHomeActiveMetaCacheKey(kind, item);

    if ((key !== 'movies' && key !== 'series') || !cacheKey || hasHomeActiveMetaDetails(item, key)) {
        return;
    }
    if (Object.prototype.hasOwnProperty.call(homeActiveMetaCache, cacheKey) || homeActiveMetaPending[cacheKey]) {
        return;
    }

    homeActiveMetaPending[cacheKey] = true;
    fetchMetaFromAddons(kind, item.id).then(function(meta) {
        var descriptor;

        homeActiveMetaCache[cacheKey] = meta || null;
        homeActiveMetaPending[cacheKey] = false;
        if (state.currentView !== 'home') {
            return;
        }

        descriptor = getHomeRailDescriptorByKey(key);
        if (descriptor && state.homeRailIndices[key] >= 0) {
            renderSingleHomeRail(descriptor);
            setTimeout(focusCurrent, 0);
        }
    }).catch(function() {
        homeActiveMetaCache[cacheKey] = null;
        homeActiveMetaPending[cacheKey] = false;
    });
}

function getSearchPaneInfo() {
    var keyboardRows = SEARCH_KEYBOARD_ROWS.length;
    var suggestionCount = (state.searchSuggestions.length ? state.searchSuggestions : getDefaultSearchSuggestions()).length;
    var resultRows = Math.ceil(state.searchResults.length / 4);
    var leftRowCount = keyboardRows + suggestionCount;

    return {
        keyboardRows: keyboardRows,
        suggestionCount: suggestionCount,
        resultRows: resultRows,
        leftRowCount: leftRowCount,
        firstResultRow: leftRowCount
    };
}

function clampMainFocus(rows) {
    if (!rows.length) {
        state.mainRow = 0;
        state.mainCol = 0;
        return;
    }

    if (state.mainRow < 0) {
        state.mainRow = 0;
    }
    if (state.mainRow >= rows.length) {
        state.mainRow = rows.length - 1;
    }
    if (state.mainCol < 0) {
        state.mainCol = 0;
    }
    if (state.mainCol >= rows[state.mainRow].length) {
        state.mainCol = rows[state.mainRow].length - 1;
    }
}

function scrollElementIntoView(el) {
    var parent = el ? el.parentNode : null;

    if (parent && parent.classList && (
        parent.classList.contains('rail') ||
        parent.classList.contains('card-row') ||
        parent.classList.contains('nav-list') ||
        parent.classList.contains('season-rail') ||
        parent.classList.contains('episode-rail') ||
        parent.classList.contains('detail-related-row') ||
        parent.classList.contains('genre-chip-row') ||
        parent.classList.contains('search-keyboard-row') ||
        parent.classList.contains('search-suggestion-list') ||
        parent.id === 'playerActions' ||
        parent.id === 'searchScopeGroup'
    )) {
        var isRelatedRow = parent.classList.contains('detail-related-row');
        var margin = isRelatedRow
            ? Math.min(150, Math.max(72, Math.floor(parent.clientWidth * 0.1)))
            : 18;
        var left = el.offsetLeft - margin;
        var right = el.offsetLeft + el.offsetWidth + margin;
        var maxScroll = isRelatedRow
            ? Math.max(0, parent.scrollWidth - parent.clientWidth)
            : 0;
        var targetScroll;

        if (left < parent.scrollLeft) {
            targetScroll = left;
        } else if (right > parent.scrollLeft + parent.clientWidth) {
            targetScroll = right - parent.clientWidth;
        }

        if (typeof targetScroll === 'number') {
            if (isRelatedRow) {
                targetScroll = Math.max(0, Math.min(maxScroll, targetScroll));
            }
            parent.scrollLeft = targetScroll;
        }
    }
}

function scrollActiveViewToTop() {
    var activeView = queryAll('.view.is-active')[0];
    window.scrollTo(0, 0);
    if (activeView) {
        activeView.scrollTop = 0;
    }
}

function getViewPanel(viewName) {
    return queryAll('[data-view-panel="' + viewName + '"]')[0] || null;
}

function isBrowseReturnView(viewName) {
    return viewName === 'movies' || viewName === 'series';
}

function captureBrowseReturnState() {
    var view = state.currentView;
    var panel;

    if (!isBrowseReturnView(view)) {
        return;
    }

    panel = getViewPanel(view);
    state.browseReturnState[view] = {
        mainRow: state.mainRow,
        mainCol: state.mainCol,
        scrollTop: panel ? panel.scrollTop : 0
    };
}

function restoreBrowseReturnState(viewName) {
    var saved = state.browseReturnState[viewName];
    var panel;

    if (!saved) {
        return false;
    }

    state.focusRegion = 'main';
    state.mainRow = saved.mainRow || 0;
    state.mainCol = saved.mainCol || 0;
    panel = getViewPanel(viewName);
    if (panel) {
        panel.scrollTop = saved.scrollTop || 0;
    }
    updateRowEmphasis();

    return true;
}

function scrollRowContainerIntoView(container) {
    var activeView = queryAll('.view.is-active')[0];
    var containerRect;
    var viewRect;
    var topDelta;
    var bottomDelta;
    var margin = 20;

    if (!activeView || !container) {
        return;
    }

    if (state.currentView === 'addons') {
        if (container.id === 'detailHeroRow') {
            if (activeView.scrollTop !== 0) {
                activeView.scrollTop = 0;
            }
            return;
        }
        if (container.id === 'detailRelatedSection') {
            var relatedTarget = Math.max(0, container.offsetTop - 22);
            if (Math.abs(activeView.scrollTop - relatedTarget) > 4) {
                activeView.scrollTop = relatedTarget;
            }
            return;
        }
    }

    if (state.mainRow === 0) {
        activeView.scrollTop = 0;
        return;
    }

    containerRect = container.getBoundingClientRect();
    viewRect = activeView.getBoundingClientRect();
    topDelta = containerRect.top - (viewRect.top + margin);
    bottomDelta = containerRect.bottom - (viewRect.bottom - margin);

    if (topDelta < 0) {
        activeView.scrollTop += topDelta;
    } else if (bottomDelta > 0) {
        activeView.scrollTop += bottomDelta;
    }
}

function updateRowEmphasis() {
    var rows = getMainRowContainers();
    var uniqueRows = [];

    rows.forEach(function(row) {
        if (row && uniqueRows.indexOf(row) === -1) {
            uniqueRows.push(row);
        }
    });

    uniqueRows.forEach(function(row) {
        row.classList.remove('is-row-current', 'is-row-near', 'is-row-far');
        if (state.focusRegion !== 'main') {
            return;
        }

        var closestDistance = Infinity;
        rows.forEach(function(mapped, index) {
            if (mapped === row) {
                closestDistance = Math.min(closestDistance, Math.abs(index - state.mainRow));
            }
        });

        if (closestDistance === 0) {
            row.classList.add('is-row-current');
        } else if (closestDistance === 1) {
            row.classList.add('is-row-near');
        } else {
            row.classList.add('is-row-far');
        }
    });
}

function focusCurrent() {
    if (state.focusRegion === 'nav') {
        var navItems = queryAll('.nav-item');
        if (!navItems.length) {
            return;
        }

        if (state.navIndex < 0) {
            state.navIndex = 0;
        }
        if (state.navIndex >= navItems.length) {
            state.navIndex = navItems.length - 1;
        }

        scrollActiveViewToTop();
        navItems[state.navIndex].focus();
        updateRowEmphasis();
        return;
    }

    var rows = getMainRows();
    clampMainFocus(rows);

    if (!rows.length || !rows[state.mainRow] || !rows[state.mainRow][state.mainCol]) {
        state.focusRegion = 'nav';
        focusCurrent();
        return;
    }

    if (state.currentView === 'home' && state.mainRow > 0) {
        state.mainCol = 0;
    }

    var rowContainers = getMainRowContainers();
    if (rowContainers[state.mainRow]) {
        scrollRowContainerIntoView(rowContainers[state.mainRow]);
    }

    rows[state.mainRow][state.mainCol].focus();
    scrollElementIntoView(rows[state.mainRow][state.mainCol]);
    updateRowEmphasis();
    if (state.currentView === 'addons' && state.detailTrailerActive && typeof scheduleDetailTrailerFrameSync === 'function') {
        setTimeout(scheduleDetailTrailerFrameSync, 0);
    }
    if (state.currentView === 'player' && state.playerFullscreen) {
        showPlayerChrome(state.mainRow > 0);
    }
    if (state.currentView === 'player' && state.playerMode === 'avplay') {
        scheduleAvplayRectSync();
    }
}

function setView(viewName, options) {
    var navIndex = NAV_VIEWS.indexOf(viewName);
    var previousView = state.currentView;
    var shouldTrackHistory = !options || options.pushHistory !== false;

    if (previousView !== viewName && typeof clearBrowsePrefetchTimers === 'function') {
        clearBrowsePrefetchTimers();
    }

    if (previousView === 'login' && viewName !== 'login') {
        stopQrLoginSession(true);
    }

    if (previousView === 'player' && viewName !== 'player') {
        setPlayerFullscreen(false);
        stopCurrentPlayback();
    }

    if (previousView === 'addons' && viewName !== 'addons' && typeof closeDetailTrailer === 'function') {
        closeDetailTrailer();
    }

    if (previousView !== viewName && shouldTrackHistory) {
        state.viewHistory.push(previousView);
        if (state.viewHistory.length > 24) {
            state.viewHistory.shift();
        }
    }

    state.currentView = viewName;
    if (navIndex !== -1) {
        state.navIndex = navIndex;
    }

    if (!options || options.resetMain !== false) {
        state.mainRow = 0;
        state.mainCol = 0;
    }

    if (options && options.focusRegion) {
        state.focusRegion = options.focusRegion;
    }

    updateNavState();
    updateViewState();
    updatePageHeader();
    window.scrollTo(0, 0);

    if (viewName === 'home' && state.featuredRotationItems[state.featuredIndex]) {
        updateFeatured(
            state.featuredRotationItems[state.featuredIndex].item,
            state.featuredRotationItems[state.featuredIndex].label
        );
    }

    if (viewName === 'login') {
        setTimeout(function() {
            startQrLoginSession(false);
        }, 0);
    }

    if (viewName === 'player') {
        scheduleAvplayRectSync();
    }
}

function goBackOnce() {
    var previousView;
    var shouldRestoreBrowse;

    if (state.playerFullscreen) {
        setPlayerFullscreen(false);
        return;
    }

    if (state.currentView === 'addons' && state.selectedType === 'series' && state.detailMode === 'sources') {
        state.detailMode = 'episodes';
        renderAddons();
        state.focusRegion = 'main';
        state.mainRow = getSelectedEpisodeMainRow();
        state.mainCol = state.availableSeasons.length && state.selectedEpisodes.length ? 1 : 0;
        focusCurrent();
        return;
    }

    if (state.currentView === 'addons' && state.selectedType === 'series' && state.detailMode === 'episodes') {
        state.detailMode = 'details';
        renderAddons();
        state.focusRegion = 'main';
        state.mainRow = 0;
        state.mainCol = 0;
        focusCurrent();
        return;
    }

    if (state.currentView !== 'home') {
        previousView = state.viewHistory.length ? state.viewHistory.pop() : 'home';
        shouldRestoreBrowse = isBrowseReturnView(previousView) && !!state.browseReturnState[previousView];
        setView(previousView || 'home', {
            focusRegion: 'main',
            resetMain: !shouldRestoreBrowse,
            pushHistory: false
        });
        if (shouldRestoreBrowse) {
            restoreBrowseReturnState(previousView);
        }
        setTimeout(function() {
            if (shouldRestoreBrowse) {
                restoreBrowseReturnState(previousView);
            }
            focusCurrent();
        }, 0);
        return;
    }

    if (state.focusRegion === 'main') {
        state.focusRegion = 'nav';
        focusCurrent();
    }
}

function formatMetaLine(item, kind) {
    return [
        kind,
        item && (item.releaseInfo || item.year) || '',
        item && item.imdbRating ? 'IMDb ' + item.imdbRating : '',
        getItemGenreLabel(item)
    ].filter(Boolean).join(' • ');
}

function getItemRuntimeValue(item) {
    return item && (
        item.runtime ||
        item.runtimeMins ||
        item.runtimeMinutes ||
        item.duration ||
        item.length
    );
}

function formatItemRuntime(item) {
    var value = getItemRuntimeValue(item);
    var minutes;
    var hours;
    var remainder;

    if (typeof value === 'number' && !isNaN(value)) {
        minutes = value > 1000 ? Math.round(value / 60000) : Math.round(value);
    } else if (typeof value === 'string' && value) {
        if (/^\d+$/.test(value)) {
            minutes = parseInt(value, 10);
        } else {
            return value.replace(/^PT/i, '').replace(/H/i, 'h ').replace(/M/i, 'm').trim();
        }
    }

    if (!minutes) {
        return '';
    }

    hours = Math.floor(minutes / 60);
    remainder = minutes % 60;
    if (hours && remainder) {
        return hours + 'h ' + remainder + 'm';
    }
    if (hours) {
        return hours + 'h';
    }

    return minutes + 'm';
}

function getItemGenreLabel(item, fallbackGenre) {
    var value = item && (item.genres || item.genre);
    var genres;
    var output = [];

    function pushLabel(label) {
        var normalized = normalizeGenreLabel(label);

        if (!normalized || output.some(function(existing) {
            return normalizeGenreLabel(existing) === normalized;
        })) {
            return;
        }

        output.push(label);
    }

    if (Array.isArray(value)) {
        genres = value.map(function(genre) {
            return String(genre || '').trim();
        }).filter(Boolean);
    } else if (typeof value === 'string' && value) {
        genres = value.split(',').map(function(part) {
            return part.trim();
        }).filter(Boolean);
    } else {
        genres = [];
    }

    genres.forEach(pushLabel);
    if (output.length) {
        return output.slice(0, 2).join(' / ');
    }

    return fallbackGenre || '';
}

function getHomeGenreFallback(key) {
    var option;

    if (key !== 'movies' && key !== 'series') {
        return '';
    }

    option = getSelectedBrowseOption(key === 'movies' ? 'movie' : 'series');
    return option && option.filterGroup === 'genre' ? option.label : '';
}

function formatHomeActiveMetaLine(item, kind, key) {
    var fallbackGenre = getHomeGenreFallback(key);

    return [
        item && item.imdbRating ? 'IMDb ' + item.imdbRating : '',
        getItemGenreLabel(item, fallbackGenre),
        formatItemRuntime(item),
        item && (item.releaseInfo || item.year) || ''
    ].filter(Boolean).join(' • ') || formatMetaLine(item, kind === 'movie' ? 'Movie' : 'Series');
}

function getVideoSeason(video) {
    var season = video && (video.season || video.seasonNumber);
    if (typeof season === 'number' && !isNaN(season)) {
        return season;
    }
    if (typeof season === 'string' && season) {
        season = parseInt(season, 10);
        if (!isNaN(season)) {
            return season;
        }
    }
    return 1;
}

function getVideoEpisode(video) {
    var episode = video && (video.episode || video.number);
    if (typeof episode === 'number' && !isNaN(episode)) {
        return episode;
    }
    if (typeof episode === 'string' && episode) {
        episode = parseInt(episode, 10);
        if (!isNaN(episode)) {
            return episode;
        }
    }
    return 0;
}

function formatSeasonLabel(season) {
    return 'Season ' + season;
}

function getPlayerContentTitle() {
    var itemTitle = state.selectedItem && state.selectedItem.name ? state.selectedItem.name : '';
    var videoTitle = state.selectedVideo && (state.selectedVideo.title || state.selectedVideo.name) ? (state.selectedVideo.title || state.selectedVideo.name) : '';
    var season;
    var episode;
    var suffix;

    if (!state.selectedItem) {
        return 'No stream selected';
    }

    if (state.selectedType === 'series' && state.selectedVideo) {
        season = getVideoSeason(state.selectedVideo);
        episode = getVideoEpisode(state.selectedVideo);
        suffix = 'S' + String(season || 1) + ' E' + String(episode || '?');
        if (videoTitle && videoTitle !== itemTitle) {
            suffix += ' • ' + videoTitle;
        }
        return itemTitle + ' • ' + suffix;
    }

    return itemTitle || videoTitle || 'Now playing';
}

function buildFeaturedRotationItems() {
    var pool = [];
    var seen = {};

    function pushEntry(item, kind, label) {
        var key;

        if (!item || !item.id) {
            return;
        }

        key = kind + ':' + item.id;
        if (seen[key]) {
            return;
        }

        seen[key] = true;
        pool.push({
            item: item,
            kind: kind,
            label: label
        });
    }

    state.continueWatching.forEach(function(entry) {
        pushEntry(entry.item, entry.kind, entry.kind === 'series' ? 'Series Spotlight' : 'Movie Spotlight');
    });

    state.movies.slice(0, 8).forEach(function(item) {
        pushEntry(item, 'movie', 'Movie Spotlight');
    });

    state.series.slice(0, 8).forEach(function(item) {
        pushEntry(item, 'series', 'Series Spotlight');
    });

    return pool;
}

function refreshFeaturedRotation() {
    var previousKey = state.featuredItem && state.featuredKind
        ? (state.featuredKind + ':' + state.featuredItem.id)
        : '';
    var nextEntry;

    state.featuredRotationItems = buildFeaturedRotationItems();

    if (!state.featuredRotationItems.length) {
        state.featuredIndex = 0;
        return;
    }

    state.featuredIndex = 0;
    state.featuredRotationItems.some(function(entry, index) {
        if ((entry.kind + ':' + entry.item.id) === previousKey) {
            state.featuredIndex = index;
            return true;
        }
        return false;
    });

    nextEntry = state.featuredRotationItems[state.featuredIndex];
    if (state.currentView === 'home' || !state.featuredItem) {
        updateFeatured(nextEntry.item, nextEntry.label);
        return;
    }

    state.featuredItem = nextEntry.item;
    state.featuredKind = nextEntry.kind;
    state.featuredLabel = nextEntry.label;
    state.featuredKey = nextEntry.kind + ':' + nextEntry.item.id;
}

function advanceFeaturedRotation() {
    var nextEntry;

    if (!state.featuredRotationItems.length) {
        refreshFeaturedRotation();
    }

    if (state.featuredRotationItems.length < 2) {
        if (state.featuredRotationItems[0]) {
            updateFeatured(state.featuredRotationItems[0].item, state.featuredRotationItems[0].label);
        }
        return;
    }

    state.featuredIndex = (state.featuredIndex + 1) % state.featuredRotationItems.length;
    nextEntry = state.featuredRotationItems[state.featuredIndex];
    if (state.currentView === 'home') {
        updateFeatured(nextEntry.item, nextEntry.label);
        return;
    }

    state.featuredItem = nextEntry.item;
    state.featuredKind = nextEntry.kind;
    state.featuredLabel = nextEntry.label;
    state.featuredKey = nextEntry.kind + ':' + nextEntry.item.id;
}

function startFeaturedRotation() {
    if (state.featuredTimer) {
        clearInterval(state.featuredTimer);
        state.featuredTimer = null;
    }

    state.featuredTimer = setInterval(function() {
        advanceFeaturedRotation();
    }, FEATURED_ROTATION_MS);
}

function updateSelectedEpisodesForSeason() {
    if (state.selectedType !== 'series') {
        state.selectedEpisodes = [];
        return;
    }

    state.selectedEpisodes = state.allSeriesVideos.filter(function(video) {
        return getVideoSeason(video) === state.selectedSeason;
    }).sort(function(left, right) {
        return getVideoEpisode(left) - getVideoEpisode(right);
    });

    if (!state.selectedEpisodes.length) {
        state.selectedVideo = null;
        return;
    }

    if (!state.selectedVideo || getVideoSeason(state.selectedVideo) !== state.selectedSeason) {
        state.selectedVideo = state.selectedEpisodes[0];
        return;
    }

    if (!state.selectedEpisodes.some(function(video) {
        return video.id === state.selectedVideo.id;
    })) {
        state.selectedVideo = state.selectedEpisodes[0];
    }
}

function applyFeaturedContent(item, kind, posterUrl) {
    var poster = byId('featuredPoster');
    var label = poster ? poster.querySelector('.featured-poster-label') : null;

    byId('featuredTag').textContent = kind;
    byId('featuredTitle').textContent = item.name || 'Untitled';
    byId('featuredMeta').textContent = formatMetaLine(item, kind);
    byId('featuredDescription').textContent =
        item.description ||
        item.releaseInfo ||
        'Linked addon metadata is connected. This item is being used as the featured spotlight.';

    if (!poster || !label) {
        return;
    }

    poster.style.backgroundImage = '';
    if (posterUrl) {
        poster.style.setProperty('--hero-art', 'url("' + posterUrl + '")');
        label.textContent = kind;
        return;
    }

    poster.style.removeProperty('--hero-art');
    label.textContent = 'No artwork';
}

function updateFeatured(item, kind, options) {
    var nextKey;
    var normalizedKind;
    var posterUrl;
    var poster;
    var token;
    var immediate;

    if (!item) {
        return;
    }

    options = options || {};
    nextKey = kind + ':' + (item.id || item.name || '');
    if (!options.force && state.featuredRenderedKey === nextKey) {
        state.featuredKey = nextKey;
        return;
    }

    normalizedKind = kind && kind.toLowerCase().indexOf('series') !== -1 ? 'series' : 'movie';
    posterUrl = item.background || item.poster || '';
    poster = byId('featuredPoster');

    state.featuredKey = nextKey;
    state.featuredItem = item;
    state.featuredKind = normalizedKind;
    state.featuredLabel = kind;
    state.featuredTransitionToken = Number(state.featuredTransitionToken || 0) + 1;
    token = state.featuredTransitionToken;
    immediate = Boolean(options.immediate || !state.featuredRenderedKey || !poster);

    preloadFeaturedArtwork(posterUrl).catch(function() {
        return null;
    }).then(function() {
        if (token !== state.featuredTransitionToken) {
            return;
        }

        if (!poster) {
            applyFeaturedContent(item, kind, posterUrl);
            state.featuredRenderedKey = nextKey;
            return;
        }

        if (immediate) {
            clearFeaturedTransitionTimer();
            poster.classList.remove('is-transitioning');
            applyFeaturedContent(item, kind, posterUrl);
            state.featuredRenderedKey = nextKey;
            return;
        }

        clearFeaturedTransitionTimer();
        poster.classList.add('is-transitioning');
        state.featuredTransitionTimer = setTimeout(function() {
            if (token !== state.featuredTransitionToken) {
                return;
            }
            applyFeaturedContent(item, kind, posterUrl);
            state.featuredRenderedKey = nextKey;
            requestAnimationFrame(function() {
                if (token !== state.featuredTransitionToken) {
                    return;
                }
                poster.classList.remove('is-transitioning');
            });
            state.featuredTransitionTimer = null;
        }, FEATURED_FADE_MS);
    });
}

function scheduleFeaturedUpdate(item, kind) {
    return {
        item: item,
        kind: kind
    };
}
