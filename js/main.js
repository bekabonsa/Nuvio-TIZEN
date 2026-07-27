function bindNav() {
    queryAll('.nav-item').forEach(function(item) {
        item.addEventListener('click', function() {
            setView(item.getAttribute('data-view'), {
                focusRegion: 'main',
                resetMain: true,
                pushHistory: false
            });
            setTimeout(focusCurrent, 0);
        });
    });
}

function bindHomeActions() {
    byId('homeLoginButton').addEventListener('click', function() {
        if (!state.featuredItem || !state.featuredKind) {
            return;
        }
        prepareSelection(state.featuredItem, state.featuredKind, {
            autoplayFirst: true
        });
    });

    byId('homeMoviesButton').addEventListener('click', function() {
        if (!state.featuredItem || !state.featuredKind) {
            return;
        }
        prepareSelection(state.featuredItem, state.featuredKind);
    });

    byId('homeSeriesButton').addEventListener('click', function() {
        setView('search', {
            focusRegion: 'main',
            resetMain: true
        });
        setTimeout(focusCurrent, 0);
    });
}

function bindDetailActions() {
    byId('detailPlayButton').addEventListener('click', function() {
        var playable = getPreferredVisibleStream();

        if (playable) {
            openPlayableOrBridgeStream(playable);
            return;
        }

        if (state.selectedItem && state.selectedType && state.selectedVideo) {
            state.autoplayPending = true;
            loadStreamsForSelection();
            return;
        }

        setAddonsMessage('Choose a title first.', 'error');
    });

    byId('detailTrailerButton').addEventListener('click', function() {
        openDetailTrailer();
    });

    byId('detailTrailerBackButton').addEventListener('click', function() {
        seekDetailTrailerBy(-10);
    });

    byId('detailTrailerToggleButton').addEventListener('click', function() {
        toggleDetailTrailerPlayback();
    });

    byId('detailTrailerForwardButton').addEventListener('click', function() {
        seekDetailTrailerBy(10);
    });

    byId('detailTrailerCloseButton').addEventListener('click', function() {
        closeDetailTrailer();
    });

    byId('detailEpisodesButton').addEventListener('click', function() {
        if (state.selectedType !== 'series') {
            return;
        }

        state.detailMode = 'episodes';
        renderAddons();
        state.focusRegion = 'main';
        state.mainRow = getSelectedEpisodeMainRow();
        state.mainCol = state.availableSeasons.length && state.selectedEpisodes.length ? 1 : 0;
        focusCurrent();
    });

    byId('detailSourcesButton').addEventListener('click', function() {
        if (!state.selectedItem || !state.selectedType || !state.selectedVideo) {
            setAddonsMessage('Choose a title first.', 'error');
            return;
        }

        state.detailMode = 'sources';
        renderAddons();
        loadStreamsForSelection({
            focusStreams: true
        });
    });

    byId('detailLibraryButton').addEventListener('click', function() {
        addSelectedToLibrary();
    });
}

function bindSearch() {
    renderSearchKeyboard();
    renderSearchSuggestions();
    syncSearchDisplay();
}

function bindBrowse() {
    byId('movieLoadMoreButton').addEventListener('click', function() {
        if (getBrowseLoadingMore('movie') || !getBrowseCanLoadMore('movie')) {
            return;
        }
        fetchBrowseCatalog('movie', true);
    });

    byId('seriesLoadMoreButton').addEventListener('click', function() {
        if (getBrowseLoadingMore('series') || !getBrowseCanLoadMore('series')) {
            return;
        }
        fetchBrowseCatalog('series', true);
    });
}

function bindLibrary() {
    byId('librarySavedToggle').addEventListener('click', function() {
        setLibraryMode('saved');
        state.focusRegion = 'main';
        state.mainRow = 0;
        state.mainCol = 0;
        focusCurrent();
    });

    byId('libraryDownloadsToggle').addEventListener('click', function() {
        setLibraryMode('downloads');
        state.focusRegion = 'main';
        state.mainRow = 0;
        state.mainCol = 1;
        focusCurrent();
    });

    byId('downloadedLibraryRefreshButton').addEventListener('click', function() {
        refreshDownloadedLibrary(true);
    });
}

function bindStreamFilters() {
    byId('streamCachedToggle').addEventListener('click', function() {
        setStreamSourceFilter('cached');
    });

    byId('streamBridgeToggle').addEventListener('click', function() {
        setStreamSourceFilter('bridge');
    });
}

function prefillDefaultLoginCredentials() {
    var emailInput = byId('emailInput');
    var passwordInput = byId('passwordInput');
    var defaultEmail = typeof NUVIO_DEFAULT_LOGIN_EMAIL !== 'undefined' ? NUVIO_DEFAULT_LOGIN_EMAIL : '';
    var defaultPassword = typeof NUVIO_DEFAULT_LOGIN_PASSWORD !== 'undefined' ? NUVIO_DEFAULT_LOGIN_PASSWORD : '';

    if (emailInput && defaultEmail && !emailInput.value) {
        emailInput.value = defaultEmail;
    }
    if (passwordInput && defaultPassword && !passwordInput.value) {
        passwordInput.value = defaultPassword;
    }
}

function bindLogin() {
    prefillDefaultLoginCredentials();

    byId('loginForm').addEventListener('submit', function(event) {
        var email = byId('emailInput').value.trim();
        var password = byId('passwordInput').value;

        event.preventDefault();

        if (!email || !password) {
            setLoginMessage('Email and password are required.', 'error');
            return;
        }

        login(email, password).catch(function(error) {
            updateSessionStatus('Sign-in failed', false, true);
            setLoginMessage('Login failed: ' + error.message, 'error');
        });
    });

    byId('logoutButton').addEventListener('click', function() {
        logout().catch(function(error) {
            setLoginMessage('Logout failed: ' + error.message, 'error');
        });
    });

    byId('qrRefreshButton').addEventListener('click', function() {
        startQrLoginSession(true);
    });
}

function bindPlayer() {
    var video = byId('videoPlayer');
    var frame = byId('videoFrameFocus');
    var controller = byId('playerControllerChrome');

    controller.addEventListener('click', function(event) {
        event.stopPropagation();
    });

    byId('playerSeekBackButton').addEventListener('click', function() {
        seekCurrentPlayback(-30000);
    });

    byId('playerToggleButton').addEventListener('click', function() {
        toggleCurrentPlayback();
    });

    byId('playerSeekForwardButton').addEventListener('click', function() {
        seekCurrentPlayback(30000);
    });

    byId('playerProgressButton').addEventListener('click', function() {
        showPlayerChrome(true);
        setPlayerStatus('Hold left or right to scrub, release to seek');
    });

    byId('playerAudioButton').addEventListener('click', function() {
        cycleAudioTrack();
    });

    byId('playerSubtitleButton').addEventListener('click', function() {
        cycleSubtitleTrack();
    });

    byId('playerNextEpisodeButton').addEventListener('click', function() {
        playNextEpisode();
    });

    byId('playerFullscreenButton').addEventListener('click', function() {
        setPlayerFullscreen(!state.playerFullscreen);
    });

    frame.addEventListener('click', function() {
        toggleCurrentPlayback();
    });

    video.addEventListener('loadedmetadata', refreshPlaybackTracks);
    video.addEventListener('loadedmetadata', function() {
        readHtml5Metrics();
        applyPendingResumeSeek();
    });
    video.addEventListener('loadeddata', refreshPlaybackTracks);
    video.addEventListener('timeupdate', readHtml5Metrics);
    video.addEventListener('durationchange', refreshPlaybackTracks);
    video.addEventListener('durationchange', readHtml5Metrics);
    video.addEventListener('playing', function() {
        setPlayerToggleUi(true);
        setPlayerStatus('Playing');
        startPlaybackTicker();
        refreshPlaybackTracks();
    });
    video.addEventListener('pause', function() {
        setPlayerToggleUi(false);
        readHtml5Metrics();
        saveCurrentPlaybackProgress(true);
        if (video.currentTime > 0) {
            setPlayerStatus('Paused');
        }
    });
    video.addEventListener('waiting', function() {
        setPlayerStatus('Buffering');
    });
    video.addEventListener('ended', function() {
        stopPlaybackTicker();
        readHtml5Metrics();
        saveCurrentPlaybackProgress(true);
        setPlayerToggleUi(false);
        setPlayerStatus('Finished');
    });
    video.addEventListener('error', function() {
        stopPlaybackTicker();
        setPlayerToggleUi(false);
        setPlayerStatus('Playback error');
    });

    window.addEventListener('resize', scheduleAvplayRectSync);
}

function handleLeft() {
    if (state.currentView === 'player' && !state.playerFullscreen) {
        if (state.mainRow === 0) {
            beginOrUpdateSeekPreview(-1);
            return;
        }
        if (state.mainCol > 0) {
            state.mainCol -= 1;
            focusCurrent();
        }
        return;
    }

    if (state.currentView === 'player' && state.playerFullscreen) {
        if (state.mainRow === 1) {
            beginOrUpdateSeekPreview(-1);
            return;
        }
        if (state.mainRow === 0) {
            return;
        }
        if (state.mainCol > 0) {
            state.mainCol -= 1;
            focusCurrent();
        }
        return;
    }

    if (state.currentView === 'home' && state.focusRegion === 'main' && state.mainRow > 0) {
        var homeRailLeft = getHomeRailDescriptorForMainRow(state.mainRow);
        if (homeRailLeft) {
            if (state.homeRailIndices[homeRailLeft.key] > 0) {
                state.homeRailIndices[homeRailLeft.key] -= 1;
            } else {
                state.homeRailIndices[homeRailLeft.key] = Math.max(homeRailLeft.entries.length - 1, 0);
            }
            state.homeRailMoveDirections[homeRailLeft.key] = 'right';
            state.mainCol = 0;
            renderSingleHomeRail(homeRailLeft);
            focusCurrent();
            return;
        }
    }

    if (state.focusRegion === 'nav') {
        if (state.navIndex > 0) {
            state.navIndex -= 1;
            focusCurrent();
        }
        return;
    }

    if (moveEpisodeBrowserHorizontal(-1)) {
        return;
    }

    if (exitFocusedYearFilter(-1)) {
        return;
    }
    if (exitFocusedRatingFilter(-1)) {
        return;
    }

    if (state.currentView === 'search') {
        var searchPaneInfo = getSearchPaneInfo();
        if (searchPaneInfo.resultRows && state.mainRow >= searchPaneInfo.firstResultRow && state.mainCol === 0) {
            state.mainRow = Math.min(
                Math.max(searchPaneInfo.leftRowCount - 1, 0),
                state.mainRow - searchPaneInfo.firstResultRow
            );
            state.mainCol = 0;
            focusCurrent();
            return;
        }
    }

    if (state.mainCol > 0) {
        state.mainCol -= 1;
        focusCurrent();
    }
}

function handleRight() {
    if (state.currentView === 'player' && !state.playerFullscreen) {
        if (state.mainRow === 0) {
            beginOrUpdateSeekPreview(1);
            return;
        }
        state.mainCol += 1;
        focusCurrent();
        return;
    }

    if (state.currentView === 'player' && state.playerFullscreen) {
        if (state.mainRow === 1) {
            beginOrUpdateSeekPreview(1);
            return;
        }
        if (state.mainRow === 0) {
            return;
        }
        state.mainCol += 1;
        focusCurrent();
        return;
    }

    if (state.currentView === 'home' && state.focusRegion === 'main' && state.mainRow > 0) {
        var homeRailRight = getHomeRailDescriptorForMainRow(state.mainRow);
        if (homeRailRight) {
            state.homeRailIndices[homeRailRight.key] = (state.homeRailIndices[homeRailRight.key] + 1) % homeRailRight.entries.length;
            state.homeRailMoveDirections[homeRailRight.key] = 'left';
            state.mainCol = 0;
            renderSingleHomeRail(homeRailRight);
            focusCurrent();
            return;
        }
    }

    if (state.focusRegion === 'nav') {
        if (state.navIndex < NAV_VIEWS.length - 1) {
            state.navIndex += 1;
            focusCurrent();
            return;
        }
        return;
    }

    if (moveEpisodeBrowserHorizontal(1)) {
        return;
    }

    if (exitFocusedYearFilter(1)) {
        return;
    }
    if (exitFocusedRatingFilter(1)) {
        return;
    }

    if (state.currentView === 'search') {
        var searchPaneInfo = getSearchPaneInfo();
        if (searchPaneInfo.resultRows && state.mainRow < searchPaneInfo.firstResultRow) {
            var searchRows = getMainRows();
            var currentSearchRow = searchRows[state.mainRow] || [];
            if (currentSearchRow.length && state.mainCol < currentSearchRow.length - 1) {
                state.mainCol += 1;
                focusCurrent();
                return;
            }
            state.mainRow = searchPaneInfo.firstResultRow;
            state.mainCol = 0;
            focusCurrent();
            return;
        }
    }

    state.mainCol += 1;
    focusCurrent();
}

function handleUp() {
    if (state.currentView === 'search' && state.focusRegion === 'main') {
        var searchPaneInfo = getSearchPaneInfo();
        if (searchPaneInfo.resultRows && state.mainRow === searchPaneInfo.firstResultRow) {
            state.focusRegion = 'nav';
            focusCurrent();
            return;
        }
    }

    if (state.currentView === 'player' && state.playerFullscreen) {
        if (state.mainRow > 0) {
            state.mainRow -= 1;
            focusCurrent();
        }
        return;
    }

    if (moveEpisodeBrowserVertical(-1)) {
        return;
    }

    if (moveFocusedYearFilter(-1)) {
        return;
    }
    if (moveFocusedRatingFilter(-1)) {
        return;
    }

    if (state.focusRegion === 'nav') {
        return;
    }

    if (state.mainRow > 0) {
        state.mainRow -= 1;
        focusCurrent();
        return;
    }

    state.focusRegion = 'nav';
    focusCurrent();
}

function handleDown() {
    if (state.currentView === 'player' && state.playerFullscreen) {
        state.mainRow += 1;
        state.mainCol = 0;
        focusCurrent();
        return;
    }

    if (state.focusRegion === 'nav') {
        state.focusRegion = 'main';
        state.mainRow = 0;
        state.mainCol = 0;
        focusCurrent();
        return;
    }

    if (moveEpisodeBrowserVertical(1)) {
        return;
    }

    if (moveFocusedYearFilter(1)) {
        return;
    }
    if (moveFocusedRatingFilter(1)) {
        return;
    }

    state.mainRow += 1;
    focusCurrent();
}

function handleEnter() {
    if (state.currentView === 'player' && state.playerFullscreen) {
        if (state.mainRow === 0) {
            toggleCurrentPlayback();
        } else if (document.activeElement) {
            document.activeElement.click();
        }
        return;
    }

    if (!document.activeElement) {
        return;
    }

    if (document.activeElement.tagName === 'INPUT') {
        document.activeElement.focus();
        document.activeElement.click();
        return;
    }

    document.activeElement.click();
}

function init() {
    state.debugAvplay = isAvplayDebugEnabled();
    if (state.debugAvplay) {
        renderAvplayDebugOverlay({
            reason: 'init',
            playerMode: state.playerMode,
            fullscreen: state.playerFullscreen,
            currentView: state.currentView,
            window: {
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio || 1
            },
            screen: {
                width: screen && screen.width,
                height: screen && screen.height
            },
            timestamp: new Date().toISOString()
        });
    }

    document.addEventListener('keydown', function(event) {
        if (state.currentView === 'player' && state.playerFullscreen) {
            showPlayerChrome(false);
        }

        switch (event.keyCode) {
        case 37:
            event.preventDefault();
            handleLeft();
            return;
        case 38:
            event.preventDefault();
            handleUp();
            return;
        case 39:
            event.preventDefault();
            handleRight();
            return;
        case 40:
            event.preventDefault();
            handleDown();
            return;
        case 13:
            event.preventDefault();
            handleEnter();
            return;
        }

        if (event.keyCode === 10009) {
            event.preventDefault();
            goBackOnce();
        }
    });

    document.addEventListener('keyup', function(event) {
        if ((event.keyCode === 37 || event.keyCode === 39) && state.seekPreviewActive) {
            event.preventDefault();
            stopSeekPreview(true);
        }
    });

    bindNav();
    bindHomeActions();
    bindDetailActions();
    bindSearch();
    bindBrowse();
    bindLibrary();
    bindStreamFilters();
    bindLogin();
    bindPlayer();

    restoreStoredSession();
    restoreContinueWatching();
    restoreLibraryItems();
    updateUserPanel();
    updateNavState();
    updateViewState();
    updatePageHeader();
    renderSearchResults();
    renderContinueWatching();
    renderLibraryView();
    renderAddons();
    renderPlayerState();
    startFeaturedRotation();

    verifyStoredSession().catch(function() {
        return null;
    }).then(function() {
        return fetchInstalledAddons();
    }).then(function() {
        return syncNuvioUserData();
    }).then(function() {
        return fetchCatalogs();
    }).catch(function(error) {
        updateConnectionStatus('Startup error: ' + error.message, false, true);
    });

    setTimeout(function() {
        focusCurrent();
    }, 60);
}

window.onload = init;
