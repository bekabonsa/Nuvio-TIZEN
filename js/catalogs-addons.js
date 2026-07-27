function normalizeCatalogPayload(payload) {
    if (!payload || !Array.isArray(payload.metas)) {
        return [];
    }
    return payload.metas.slice(0, HOME_CATALOG_LIMIT);
}

function normalizeCatalogPayloadWithLimit(payload, limit) {
    if (!payload || !Array.isArray(payload.metas)) {
        return [];
    }
    return payload.metas.slice(0, typeof limit === 'number' ? limit : 12);
}

function uniqueCatalogItems(items, limit) {
    var seen = {};
    var output = [];

    (items || []).forEach(function(item) {
        var key;

        if (!item || !item.id) {
            return;
        }

        key = item.id;
        if (seen[key]) {
            return;
        }

        seen[key] = true;
        output.push(item);
    });

    if (typeof limit === 'number') {
        return output.slice(0, limit);
    }

    return output;
}

function shuffleCatalogItems(items) {
    var output = (items || []).slice();
    var index;
    var swapIndex;
    var item;

    for (index = output.length - 1; index > 0; index -= 1) {
        swapIndex = Math.floor(Math.random() * (index + 1));
        item = output[index];
        output[index] = output[swapIndex];
        output[swapIndex] = item;
    }

    return output;
}

function trimToFullBrowseRows(items) {
    var list = items || [];
    var fullLength = list.length - (list.length % BROWSE_ROW_SIZE);

    return list.slice(0, fullLength);
}

function canonicalizeAddonUrl(url) {
    var value = String(url || '').trim().replace(/\/+$/, '');

    if (value.slice(-14) === '/manifest.json') {
        return value.slice(0, -14);
    }

    return value;
}

function buildAddonTransportUrl(baseUrl) {
    var cleanBaseUrl = canonicalizeAddonUrl(baseUrl);

    return cleanBaseUrl ? cleanBaseUrl + '/manifest.json' : '';
}

function buildBuiltinAddonManifest(baseUrl) {
    var cleanBaseUrl = canonicalizeAddonUrl(baseUrl);

    if (cleanBaseUrl === CINEMETA_BASE) {
        return {
            id: 'org.cinemeta',
            name: 'Cinemeta',
            version: 'fallback',
            description: 'Fallback Cinemeta manifest',
            resources: [
                { name: 'catalog', types: ['movie', 'series'] },
                { name: 'meta', types: ['movie', 'series'] }
            ],
            types: ['movie', 'series'],
            catalogs: [
                {
                    type: 'movie',
                    id: 'top',
                    name: 'Top',
                    extra: [{ name: 'genre', options: CINEMETA_MOVIE_GENRES.slice() }, { name: 'search' }, { name: 'skip' }]
                },
                {
                    type: 'series',
                    id: 'top',
                    name: 'Top',
                    extra: [{ name: 'genre', options: CINEMETA_SERIES_GENRES.slice() }, { name: 'search' }, { name: 'skip' }]
                },
                {
                    type: 'movie',
                    id: 'imdbRating',
                    name: 'Featured',
                    extra: [{ name: 'skip' }]
                },
                {
                    type: 'series',
                    id: 'imdbRating',
                    name: 'Featured',
                    extra: [{ name: 'skip' }]
                }
            ]
        };
    }

    if (cleanBaseUrl === OPENSUBTITLES_BASE) {
        return {
            id: 'org.opensubtitles.v3',
            name: 'OpenSubtitles v3',
            version: 'fallback',
            description: 'Fallback OpenSubtitles manifest',
            resources: [
                { name: 'subtitles', types: ['movie', 'series'] }
            ],
            types: ['movie', 'series'],
            catalogs: []
        };
    }

    if (cleanBaseUrl.indexOf('https://torrentio.strem.fun') === 0) {
        return {
            id: 'com.stremio.torrentio.addon',
            name: 'Torrentio',
            version: 'fallback',
            description: 'Fallback Torrentio manifest',
            resources: [
                { name: 'stream', types: ['movie', 'series'] }
            ],
            types: ['movie', 'series'],
            catalogs: []
        };
    }

    return null;
}

function normalizeAddonManifest(baseUrl, manifest) {
    var rawTypes = Array.isArray(manifest && manifest.types) ? manifest.types : [];
    var cleanBaseUrl = canonicalizeAddonUrl(baseUrl);
    var types = rawTypes.map(function(value) {
        return normalizeAddonType(value);
    }).filter(Boolean);
    var resources = Array.isArray(manifest && manifest.resources) ? manifest.resources : [];
    var catalogs = Array.isArray(manifest && manifest.catalogs) ? manifest.catalogs : [];

    return {
        id: manifest && manifest.id ? manifest.id : cleanBaseUrl,
        transportUrl: buildAddonTransportUrl(cleanBaseUrl),
        manifest: {
            id: manifest && manifest.id ? manifest.id : cleanBaseUrl,
            name: manifest && manifest.name ? manifest.name : cleanBaseUrl,
            version: manifest && manifest.version ? manifest.version : '0.0.0',
            description: manifest && manifest.description ? manifest.description : '',
            logo: manifest && manifest.logo ? manifest.logo : null,
            types: types,
            resources: resources.map(function(resource) {
                if (typeof resource === 'string') {
                    return {
                        name: resource,
                        types: types.slice(),
                        idPrefixes: null
                    };
                }

                return {
                    name: resource && resource.name ? resource.name : '',
                    types: Array.isArray(resource && resource.types)
                        ? resource.types.map(function(value) {
                            return normalizeAddonType(value);
                        }).filter(Boolean)
                        : types.slice(),
                    idPrefixes: Array.isArray(resource && resource.idPrefixes)
                        ? resource.idPrefixes.filter(Boolean)
                        : null
                };
            }),
            catalogs: catalogs.map(function(catalog) {
                return {
                    id: catalog && catalog.id ? catalog.id : '',
                    type: normalizeAddonType(catalog && catalog.type ? catalog.type : ''),
                    name: catalog && catalog.name ? catalog.name : (catalog && catalog.id ? catalog.id : 'Catalog'),
                    extra: Array.isArray(catalog && catalog.extra) ? catalog.extra : []
                };
            })
        }
    };
}

function buildSupabaseHeaders(token) {
    return {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + (token || SUPABASE_ANON_KEY)
    };
}

function getNuvioAuthBaseUrl() {
    var baseUrl = typeof NUVIO_AUTH_BASE_URL !== 'undefined' && NUVIO_AUTH_BASE_URL
        ? NUVIO_AUTH_BASE_URL
        : SUPABASE_URL;

    return String(baseUrl || '').replace(/\/+$/, '');
}

function extractAddonUrls(rows) {
    return (rows || []).map(function(row) {
        return row && (row.url || row.base_url) ? row.url || row.base_url : null;
    }).filter(Boolean);
}

function isMissingSupabaseResource(error) {
    var message = String(error && error.message || '');

    return message.indexOf('PGRST205') !== -1
        || message.indexOf('PGRST202') !== -1
        || message.indexOf('Could not find the table') !== -1
        || message.indexOf('Could not find the function') !== -1
        || message.indexOf('HTTP 404') === 0;
}

function stableArgsKey(args) {
    var value = args || {};

    return Object.keys(value).sort().map(function(name) {
        return name + '=' + value[name];
    }).join('&');
}

function buildCatalogOptionKey(addon, catalog, extraArgs) {
    return [
        addonBaseUrl(addon.transportUrl) || addon.id || '',
        normalizeAddonType(catalog.type),
        catalog.id || '',
        catalog.name || '',
        stableArgsKey(extraArgs)
    ].join('::');
}

function getCatalogExtraEntry(extra, name) {
    return (extra || []).filter(function(entry) {
        return entry && entry.name === name;
    })[0] || null;
}

function getCinemetaGenreOptions(type, rawOptions) {
    var allowed = type === 'movie' ? CINEMETA_MOVIE_GENRES : CINEMETA_SERIES_GENRES;
    var available = Array.isArray(rawOptions) && rawOptions.length ? rawOptions : allowed;

    return available.filter(function(value) {
        return allowed.indexOf(value) !== -1;
    });
}

function getCinemetaYearOptions(rawOptions) {
    var available = Array.isArray(rawOptions) && rawOptions.length ? rawOptions : CINEMETA_YEAR_FILTERS;

    return available.filter(function(value) {
        return CINEMETA_YEAR_FILTERS.indexOf(value) !== -1;
    });
}

function mergeCatalogArgs(target, source) {
    Object.keys(source || {}).forEach(function(name) {
        target[name] = source[name];
    });
}

function isBlockbusterCatalogOption(option) {
    return !!(option
        && option.type === 'movie'
        && option.catalogId === 'blockbuster'
        && option.backendCatalog === 'tmdbBlockbuster');
}

function pushBlockbusterCatalogOption(options, labelCounts, type) {
    if (type !== 'movie' || !getImdbCatalogApiBaseUrl()) {
        return;
    }

    labelCounts.Blockbuster = (labelCounts.Blockbuster || 0) + 1;
    options.push({
        key: 'nuvio::movie::blockbuster',
        label: 'Blockbuster',
        addonName: 'Nuvio',
        addon: null,
        type: 'movie',
        catalogId: 'blockbuster',
        extraArgs: null,
        filterGroup: 'catalog',
        sortRank: 2,
        supportsSearch: false,
        supportsSkip: true,
        backendCatalog: 'tmdbBlockbuster'
    });
}

function buildCatalogOptions(type) {
    var options = [];
    var labelCounts = {};
    var preferredTypes = getCompatibleTypes(type);

    state.addons.forEach(function(addon) {
        var catalogs = addon && addon.manifest && Array.isArray(addon.manifest.catalogs)
            ? addon.manifest.catalogs
            : [];
        var addonName = addon && addon.manifest && addon.manifest.name ? addon.manifest.name : 'Addon';

        if (!addonSupportsResource(addon, ['catalog'], type)) {
            return;
        }

        catalogs.forEach(function(catalog) {
            var catalogType = normalizeAddonType(catalog && catalog.type);
            var extra = Array.isArray(catalog && catalog.extra) ? catalog.extra : [];
            var supportsSearch = extra.some(function(entry) {
                return entry && entry.name === 'search';
            });
            var supportsSkip = extra.some(function(entry) {
                return entry && entry.name === 'skip';
            });
            var genreEntry = getCatalogExtraEntry(extra, 'genre');
            var baseUrl = addonBaseUrl(addon.transportUrl);
            var isCinemeta = baseUrl === CINEMETA_BASE;
            var hasUnsupportedRequiredExtra = extra.some(function(entry) {
                return entry && entry.isRequired && entry.name !== 'genre';
            });

            function pushOption(label, extraArgs, filterGroup, sortRank) {
                labelCounts[label] = (labelCounts[label] || 0) + 1;

                options.push({
                    key: buildCatalogOptionKey(addon, catalog, extraArgs),
                    label: label,
                    addonName: addonName,
                    addon: addon,
                    type: catalogType,
                    catalogId: catalog.id,
                    extraArgs: extraArgs || null,
                    filterGroup: filterGroup || 'catalog',
                    sortRank: typeof sortRank === 'number' ? sortRank : 500,
                    supportsSearch: supportsSearch,
                    supportsSkip: supportsSkip
                });
            }

            if (!catalog || !catalog.id || preferredTypes.indexOf(catalogType) === -1) {
                return;
            }
            if (hasUnsupportedRequiredExtra) {
                return;
            }

            if (isCinemeta && catalog.id === 'top') {
                pushOption('Popular', null, 'catalog', 0);
                getCinemetaGenreOptions(catalogType, genreEntry && genreEntry.options).forEach(function(genre, index) {
                    pushOption(genre, { genre: genre }, 'genre', 20 + index);
                });
                return;
            }

            if (isCinemeta && catalog.id === 'year' && genreEntry && genreEntry.isRequired) {
                getCinemetaYearOptions(genreEntry.options).forEach(function(year, index) {
                    pushOption(year, { genre: year }, 'year', 100 + index);
                });
                return;
            }

            pushOption(catalog.name || catalog.id, null, 'catalog', catalog.id === 'imdbRating' ? 1 : 500);
        });
    });

    pushBlockbusterCatalogOption(options, labelCounts, type);

    options.sort(function(left, right) {
        if (left.sortRank !== right.sortRank) {
            return left.sortRank - right.sortRank;
        }

        return String(left.label || '').localeCompare(String(right.label || ''));
    });

    return options.map(function(option) {
        var nextOption = {
            key: option.key,
            label: option.label,
            addonName: option.addonName,
            addon: option.addon,
            type: option.type,
            catalogId: option.catalogId,
            extraArgs: option.extraArgs,
            filterGroup: option.filterGroup,
            sortRank: option.sortRank,
            supportsSearch: option.supportsSearch,
            supportsSkip: option.supportsSkip,
            backendCatalog: option.backendCatalog || ''
        };

        if (labelCounts[option.label] > 1) {
            nextOption.label = option.label + ' • ' + option.addonName;
        }

        return nextOption;
    });
}

function selectPreferredCatalogOption(options) {
    var ranked = (options || []).slice();

    ranked.sort(function(left, right) {
        function score(option) {
            var baseUrl = option && option.addon ? addonBaseUrl(option.addon.transportUrl) : '';
            var value = 0;

            if (baseUrl === CINEMETA_BASE && option.catalogId === 'top') {
                value += 20;
            }
            if (option.catalogId === 'top') {
                value += 10;
            }
            if (String(option.label || '').toLowerCase().indexOf('top') !== -1) {
                value += 4;
            }
            if (option.supportsSearch) {
                value += 2;
            }

            return value;
        }

        return score(right) - score(left);
    });

    return ranked[0] || null;
}

function getBrowseOptions(type) {
    return type === 'movie' ? state.movieGenres : state.seriesGenres;
}

function getSelectedBrowseOptionKey(type) {
    return type === 'movie' ? state.selectedMovieGenre : state.selectedSeriesGenre;
}

function setSelectedBrowseKey(type, key) {
    if (type === 'movie') {
        state.selectedMovieGenre = key;
        return;
    }

    state.selectedSeriesGenre = key;
}

function getSelectedYearBrowseKey(type) {
    return type === 'movie' ? state.selectedMovieYear : state.selectedSeriesYear;
}

function setSelectedYearBrowseKey(type, key) {
    if (type === 'movie') {
        state.selectedMovieYear = key || '';
        return;
    }

    state.selectedSeriesYear = key || '';
}

function getSelectedRatingBrowseKey(type) {
    return type === 'movie' ? state.selectedMovieRating : state.selectedSeriesRating;
}

function setSelectedRatingBrowseKey(type, key) {
    if (type === 'movie') {
        state.selectedMovieRating = key || '';
        return;
    }

    state.selectedSeriesRating = key || '';
}

function getSelectedBrowseOption(type) {
    var options = getBrowseOptions(type);
    var key = getSelectedBrowseOptionKey(type);
    var selected = options.filter(function(option) {
        return option.key === key;
    })[0];

    return selected || options[0] || null;
}

function getSelectedYearBrowseOption(type) {
    var options = getBrowseOptions(type);
    var key = getSelectedYearBrowseKey(type);

    if (!key) {
        return null;
    }

    return options.filter(function(option) {
        return option && option.key === key && isYearBrowseOption(option);
    })[0] || null;
}

function getSelectedRatingBrowseOption(type) {
    var key = getSelectedRatingBrowseKey(type);

    if (!key) {
        return null;
    }

    return getRatingFilterOptionsForRender(type).filter(function(option) {
        return option && option.key === key && isRatingBrowseOption(option);
    })[0] || null;
}

function getSelectedBrowseLabel(type) {
    var selected = getSelectedBrowseOption(type);
    var year = getSelectedYearBrowseOption(type);
    var rating = getSelectedRatingBrowseOption(type);
    var parts = [];

    if (selected) {
        parts.push(selected.label);
    }
    if (year) {
        parts.push(year.label);
    }
    if (rating) {
        parts.push('IMDb ' + rating.label);
    }

    return parts.length ? parts.join(' • ') : 'Unavailable';
}

function getBrowseItems(type) {
    return type === 'movie' ? state.movieBrowseItems : state.seriesBrowseItems;
}

function setBrowseItems(type, items) {
    if (type === 'movie') {
        state.movieBrowseItems = items;
        return;
    }

    state.seriesBrowseItems = items;
}

function setBrowseSkip(type, skip) {
    if (type === 'movie') {
        state.movieSkip = skip;
        return;
    }

    state.seriesSkip = skip;
}

function getBrowseSkip(type) {
    return type === 'movie' ? state.movieSkip : state.seriesSkip;
}

function getBrowseCanLoadMore(type) {
    return type === 'movie' ? state.movieBrowseCanLoadMore : state.seriesBrowseCanLoadMore;
}

function setBrowseCanLoadMore(type, canLoadMore) {
    if (type === 'movie') {
        state.movieBrowseCanLoadMore = !!canLoadMore;
        return;
    }

    state.seriesBrowseCanLoadMore = !!canLoadMore;
}

function getBrowseLoadingMore(type) {
    return type === 'movie' ? state.movieBrowseLoadingMore : state.seriesBrowseLoadingMore;
}

function setBrowseLoadingMore(type, loading) {
    if (type === 'movie') {
        state.movieBrowseLoadingMore = !!loading;
        return;
    }

    state.seriesBrowseLoadingMore = !!loading;
}

function getBrowseExpansionIndex(type) {
    return type === 'movie' ? state.movieBrowseExpansionIndex : state.seriesBrowseExpansionIndex;
}

function setBrowseExpansionIndex(type, index) {
    if (type === 'movie') {
        state.movieBrowseExpansionIndex = index;
        return;
    }

    state.seriesBrowseExpansionIndex = index;
}

function getBrowseRequestId(type) {
    return type === 'movie' ? state.movieBrowseRequestId : state.seriesBrowseRequestId;
}

function bumpBrowseRequestId(type) {
    if (type === 'movie') {
        state.movieBrowseRequestId += 1;
        return state.movieBrowseRequestId;
    }

    state.seriesBrowseRequestId += 1;
    return state.seriesBrowseRequestId;
}

function isBrowseRequestCurrent(type, requestId) {
    return getBrowseRequestId(type) === requestId;
}

function getYearWindowStart(type) {
    return type === 'movie' ? state.movieYearWindowStart : state.seriesYearWindowStart;
}

function setYearWindowStart(type, index) {
    if (type === 'movie') {
        state.movieYearWindowStart = index;
        return;
    }

    state.seriesYearWindowStart = index;
}

function isYearFilterOpen(type) {
    return type === 'movie' ? state.movieYearFilterOpen : state.seriesYearFilterOpen;
}

function setYearFilterOpen(type, open) {
    if (type === 'movie') {
        state.movieYearFilterOpen = !!open;
        return;
    }

    state.seriesYearFilterOpen = !!open;
}

function getYearFocusIndex(type) {
    return type === 'movie' ? state.movieYearFocusIndex : state.seriesYearFocusIndex;
}

function setYearFocusIndex(type, index) {
    if (type === 'movie') {
        state.movieYearFocusIndex = index;
        return;
    }

    state.seriesYearFocusIndex = index;
}

function getRatingWindowStart(type) {
    return type === 'movie' ? state.movieRatingWindowStart : state.seriesRatingWindowStart;
}

function setRatingWindowStart(type, index) {
    if (type === 'movie') {
        state.movieRatingWindowStart = index;
        return;
    }

    state.seriesRatingWindowStart = index;
}

function isRatingFilterOpen(type) {
    return type === 'movie' ? state.movieRatingFilterOpen : state.seriesRatingFilterOpen;
}

function setRatingFilterOpen(type, open) {
    if (type === 'movie') {
        state.movieRatingFilterOpen = !!open;
        return;
    }

    state.seriesRatingFilterOpen = !!open;
}

function getRatingFocusIndex(type) {
    return type === 'movie' ? state.movieRatingFocusIndex : state.seriesRatingFocusIndex;
}

function setRatingFocusIndex(type, index) {
    if (type === 'movie') {
        state.movieRatingFocusIndex = index;
        return;
    }

    state.seriesRatingFocusIndex = index;
}

function getCurrentBrowseType() {
    if (state.currentView === 'movies') {
        return 'movie';
    }
    if (state.currentView === 'series') {
        return 'series';
    }

    return '';
}

function resetBrowsePaging(type) {
    setBrowseSkip(type, 0);
    setBrowseCanLoadMore(type, true);
    setBrowseLoadingMore(type, false);
    setBrowseExpansionIndex(type, Math.floor(Math.random() * 1000));
}

function isYearBrowseOption(option) {
    return option && option.filterGroup === 'year';
}

function isRatingBrowseOption(option) {
    return option && option.filterGroup === 'rating';
}

function getAllYearBrowseOption(type) {
    return {
        key: '',
        label: 'All',
        type: type,
        catalogId: '',
        extraArgs: null,
        filterGroup: 'year',
        supportsSearch: false,
        supportsSkip: false
    };
}

function getAllRatingBrowseOption(type) {
    return {
        key: '',
        label: 'All',
        type: type,
        catalogId: '',
        extraArgs: null,
        filterGroup: 'rating',
        minRating: null,
        maxRating: null,
        supportsSearch: false,
        supportsSkip: false
    };
}

function getYearFilterOptionsForRender(type, options) {
    var yearOptions = (options || []).filter(isYearBrowseOption);

    return yearOptions.length ? [getAllYearBrowseOption(type)].concat(yearOptions) : [];
}

function getRatingFilterOptionsForRender(type) {
    return [getAllRatingBrowseOption(type)].concat(IMDB_RATING_FILTERS.map(function(value) {
        var min = parseInt(value, 10);

        return {
            key: 'rating-' + value,
            label: value,
            type: type,
            catalogId: '',
            extraArgs: null,
            filterGroup: 'rating',
            minRating: min,
            maxRating: min + 1,
            supportsSearch: false,
            supportsSkip: false
        };
    }));
}

function getYearOptionIndex(yearOptions, key) {
    var index = -1;

    (yearOptions || []).some(function(option, optionIndex) {
        if (option && option.key === key) {
            index = optionIndex;
            return true;
        }

        return false;
    });

    return index;
}

function getRatingOptionIndex(ratingOptions, key) {
    var index = -1;

    (ratingOptions || []).some(function(option, optionIndex) {
        if (option && option.key === key) {
            index = optionIndex;
            return true;
        }

        return false;
    });

    return index;
}

function clampYearWindowStart(start, yearCount) {
    var maxStart = Math.max(0, yearCount - YEAR_FILTER_WINDOW_SIZE);

    return Math.max(0, Math.min(start, maxStart));
}

function clampRatingWindowStart(start, ratingCount) {
    var maxStart = Math.max(0, ratingCount - YEAR_FILTER_WINDOW_SIZE);

    return Math.max(0, Math.min(start, maxStart));
}

function getYearWindowStartForRender(type, yearOptions, activeKey) {
    var activeIndex = getYearOptionIndex(yearOptions, activeKey);
    var start = clampYearWindowStart(getYearWindowStart(type), yearOptions.length);

    if (activeIndex >= 0 && (activeIndex < start || activeIndex >= start + YEAR_FILTER_WINDOW_SIZE)) {
        start = clampYearWindowStart(activeIndex - Math.floor(YEAR_FILTER_WINDOW_SIZE / 2), yearOptions.length);
        setYearWindowStart(type, start);
    }

    return start;
}

function getRatingWindowStartForRender(type, ratingOptions, activeKey) {
    var activeIndex = getRatingOptionIndex(ratingOptions, activeKey);
    var start = clampRatingWindowStart(getRatingWindowStart(type), ratingOptions.length);

    if (activeIndex >= 0 && (activeIndex < start || activeIndex >= start + YEAR_FILTER_WINDOW_SIZE)) {
        start = clampRatingWindowStart(activeIndex - Math.floor(YEAR_FILTER_WINDOW_SIZE / 2), ratingOptions.length);
        setRatingWindowStart(type, start);
    }

    return start;
}

function getOpenYearWindowStartForRender(type, yearOptions) {
    var focusIndex = Math.max(0, Math.min(getYearFocusIndex(type), Math.max(0, yearOptions.length - 1)));
    var start = clampYearWindowStart(getYearWindowStart(type), yearOptions.length);

    setYearFocusIndex(type, focusIndex);
    if (focusIndex < start || focusIndex >= start + YEAR_FILTER_WINDOW_SIZE) {
        start = clampYearWindowStart(focusIndex - Math.floor(YEAR_FILTER_WINDOW_SIZE / 2), yearOptions.length);
        setYearWindowStart(type, start);
    }

    return start;
}

function getOpenRatingWindowStartForRender(type, ratingOptions) {
    var focusIndex = Math.max(0, Math.min(getRatingFocusIndex(type), Math.max(0, ratingOptions.length - 1)));
    var start = clampRatingWindowStart(getRatingWindowStart(type), ratingOptions.length);

    setRatingFocusIndex(type, focusIndex);
    if (focusIndex < start || focusIndex >= start + YEAR_FILTER_WINDOW_SIZE) {
        start = clampRatingWindowStart(focusIndex - Math.floor(YEAR_FILTER_WINDOW_SIZE / 2), ratingOptions.length);
        setRatingWindowStart(type, start);
    }

    return start;
}

function getCollapsedYearIndex(type, yearOptions, activeKey) {
    var activeIndex = getYearOptionIndex(yearOptions, activeKey);

    if (activeIndex >= 0) {
        return activeIndex;
    }

    return clampYearWindowStart(getYearWindowStart(type), yearOptions.length);
}

function getCollapsedRatingIndex(type, ratingOptions, activeKey) {
    var activeIndex = getRatingOptionIndex(ratingOptions, activeKey);

    if (activeIndex >= 0) {
        return activeIndex;
    }

    return clampRatingWindowStart(getRatingWindowStart(type), ratingOptions.length);
}

function focusYearFilter(type, yearIndex) {
    var row = getMainRows()[0] || [];
    var nextButton = null;
    var nextCol;

    row.some(function(button) {
        if (button && button.classList && button.classList.contains('is-year-filter') && button.getAttribute('data-year-index') === String(yearIndex)) {
            nextButton = button;
            return true;
        }

        return false;
    });

    if (!nextButton) {
        return false;
    }

    nextCol = row.indexOf(nextButton);
    if (nextCol >= 0) {
        state.mainRow = 0;
        state.mainCol = nextCol;
    }
    setYearFocusIndex(type, yearIndex);
    focusCurrent();
    return true;
}

function focusRatingFilter(type, ratingIndex) {
    var row = getMainRows()[0] || [];
    var nextButton = null;
    var nextCol;

    row.some(function(button) {
        if (button && button.classList && button.classList.contains('is-rating-filter') && button.getAttribute('data-rating-index') === String(ratingIndex)) {
            nextButton = button;
            return true;
        }

        return false;
    });

    if (!nextButton) {
        return false;
    }

    nextCol = row.indexOf(nextButton);
    if (nextCol >= 0) {
        state.mainRow = 0;
        state.mainCol = nextCol;
    }
    setRatingFocusIndex(type, ratingIndex);
    focusCurrent();
    return true;
}

function isCinemetaTopCatalog(option) {
    var baseUrl = option && option.addon ? addonBaseUrl(option.addon.transportUrl) : '';

    return baseUrl === CINEMETA_BASE && option.catalogId === 'top';
}

function isCinemetaGenreTopCatalog(option) {
    return isCinemetaTopCatalog(option) && !!getBrowseGenreFilterLabel(option);
}

function isCinemetaSeriesTopCatalog(option) {
    return isCinemetaTopCatalog(option) && option.type === 'series';
}

function usesLocalBrowsePaging(option, currentLength) {
    if (isCinemetaGenreTopCatalog(option)) {
        return false;
    }
    if (!isCinemetaTopCatalog(option)) {
        return false;
    }

    return option.type !== 'series' || currentLength < CINEMETA_CATALOG_PAGE_SIZE;
}

function getBrowseRequestSkip(option, currentLength) {
    if (isCinemetaSeriesTopCatalog(option)) {
        return Math.max(
            CINEMETA_CATALOG_PAGE_SIZE,
            Math.floor(currentLength / CINEMETA_CATALOG_PAGE_SIZE) * CINEMETA_CATALOG_PAGE_SIZE
        );
    }

    return currentLength;
}

function getBlockbusterBrowseLimit(append) {
    return append ? BLOCKBUSTER_LOAD_MORE_SIZE : BLOCKBUSTER_PAGE_SIZE;
}

function getRatingCombinedBrowseLimit(combined, append) {
    if (isBlockbusterCatalogOption(combined && combined.baseOption)) {
        return getBlockbusterBrowseLimit(append);
    }

    return append ? BROWSE_LOAD_MORE_SIZE : BROWSE_PAGE_SIZE;
}

function supportsRemoteBrowsePaging(option) {
    if (isBlockbusterCatalogOption(option)) {
        return true;
    }

    if (isCinemetaGenreTopCatalog(option)) {
        return !!(option && option.supportsSkip);
    }

    return option && option.supportsSkip && (!isCinemetaTopCatalog(option) || isCinemetaSeriesTopCatalog(option));
}

function usesCinemetaBrowseExpansion(option) {
    return isCinemetaBrowseExpansionOption(option) && !isCinemetaGenreTopCatalog(option);
}

function appendCatalogItems(baseItems, additions, limit) {
    return uniqueCatalogItems((baseItems || []).concat(additions || [])).slice(0, limit);
}

function getItemGenreValues(item) {
    var value = item && (item.genres || item.genre);

    if (Array.isArray(value)) {
        return value.map(function(genre) {
            return String(genre || '').replace(/^\s+|\s+$/g, '');
        }).filter(Boolean);
    }
    if (typeof value === 'string' && value) {
        return value.split(',').map(function(genre) {
            return genre.replace(/^\s+|\s+$/g, '');
        }).filter(Boolean);
    }

    return [];
}

function normalizeGenreLabel(value) {
    return String(value || '').replace(/^\s+|\s+$/g, '').toLowerCase();
}

function getGenreMatchTokens(value) {
    var normalized = normalizeGenreLabel(value);
    var tokens = [];

    function push(token) {
        token = normalizeGenreLabel(token);
        if (token && tokens.indexOf(token) === -1) {
            tokens.push(token);
        }
    }

    push(normalized);
    normalized.split(/\s*(?:&|\/|\+|\band\b)\s*/).forEach(push);

    return tokens;
}

function genreValueMatchesLabel(value, genre) {
    var target = normalizeGenreLabel(genre);

    if (!target) {
        return true;
    }

    return getGenreMatchTokens(value).indexOf(target) !== -1;
}

function getItemGenres(item) {
    var genres = [];

    getItemGenreValues(item).forEach(function(value) {
        getGenreMatchTokens(value).forEach(function(token) {
            if (genres.indexOf(token) === -1) {
                genres.push(token);
            }
        });
    });

    return genres;
}

function itemMatchesGenreLabel(item, genre) {
    var target = normalizeGenreLabel(genre);

    if (!target) {
        return true;
    }

    return getItemGenreValues(item).some(function(value) {
        return genreValueMatchesLabel(value, target);
    });
}

function getBrowseGenreFilterLabel(option) {
    if (!option || option.filterGroup !== 'genre') {
        return '';
    }

    return option.extraArgs && option.extraArgs.genre
        ? String(option.extraArgs.genre)
        : String(option.label || '').split(' • ')[0];
}

function filterItemsForBrowseOption(items, option) {
    var genre = getBrowseGenreFilterLabel(option);
    var rating = option && option.type ? getSelectedRatingBrowseOption(option.type) : null;

    if (!genre && !rating) {
        return (items || []).slice();
    }

    return (items || []).filter(function(item) {
        return itemMatchesGenreLabel(item, genre) && itemMatchesRatingFilter(item, rating);
    });
}

function orderItemsForBrowseOption(items, option) {
    return getBrowseGenreFilterLabel(option)
        ? (items || []).slice()
        : shuffleCatalogItems(items);
}

function getItemImdbRatingNumber(item) {
    var value = item && item.imdbRating;
    var parsed;

    if (typeof value === 'number') {
        return value;
    }
    if (typeof value === 'string') {
        parsed = parseFloat(value);
        return isNaN(parsed) ? 0 : parsed;
    }

    return 0;
}

function itemMatchesRatingFilter(item, ratingOption) {
    var rating;
    var min;
    var max;

    if (!ratingOption || !ratingOption.key) {
        return true;
    }

    rating = getItemImdbRatingNumber(item);
    min = typeof ratingOption.minRating === 'number' ? ratingOption.minRating : parseInt(ratingOption.label, 10);
    max = typeof ratingOption.maxRating === 'number' ? ratingOption.maxRating : min + 1;

    if (!rating || isNaN(min) || isNaN(max)) {
        return false;
    }

    return rating >= min && rating < max;
}

function sortItemsForBrowseBase(items, baseOption) {
    var output = (items || []).slice();

    if (baseOption && baseOption.catalogId === 'imdbRating') {
        output.sort(function(left, right) {
            return getItemImdbRatingNumber(right) - getItemImdbRatingNumber(left);
        });
        return output;
    }

    return output;
}

function getItemYearValues(item) {
    var values = [];

    [item && item.year, item && item.releaseInfo, item && item.released].forEach(function(value) {
        (String(value || '').match(/\b(19|20)\d{2}\b/g) || []).forEach(function(year) {
            if (values.indexOf(year) === -1) {
                values.push(year);
            }
        });
    });

    return values;
}

function getImdbCatalogApiBaseUrl() {
    return String(typeof IMDB_CATALOG_API_BASE_URL === 'undefined' ? '' : IMDB_CATALOG_API_BASE_URL)
        .replace(/\/+$/, '')
        .trim();
}

function itemMatchesYearBrowseOption(item, yearOption) {
    var year = yearOption && yearOption.label ? String(yearOption.label) : '';

    if (!year) {
        return true;
    }

    return getItemYearValues(item).indexOf(year) !== -1;
}

function buildImdbCatalogApiUrl(type, combined, skip, limit) {
    var baseUrl = getImdbCatalogApiBaseUrl();
    var params = [];
    var ratingOption = combined && combined.ratingOption;
    var yearOption = combined && combined.yearOption;
    var genreLabel = combined && combined.genreLabel;
    var baseOption = combined && combined.baseOption;

    if (!baseUrl || !ratingOption) {
        return '';
    }

    if (isBlockbusterCatalogOption(baseOption)) {
        params.push('blockbuster=1');
    }
    params.push('rating=' + encodeURIComponent(String(ratingOption.label)));
    if (genreLabel) {
        params.push('genre=' + encodeURIComponent(String(genreLabel)));
    }
    if (yearOption && yearOption.label) {
        params.push('year=' + encodeURIComponent(String(yearOption.label)));
    }
    params.push('skip=' + encodeURIComponent(String(Math.max(0, skip || 0))));
    params.push('limit=' + encodeURIComponent(String(Math.max(1, limit || CINEMETA_CATALOG_PAGE_SIZE))));

    return baseUrl + '/catalog/' + encodeURIComponent(type) + '?' + params.join('&');
}

function buildBlockbusterCatalogApiUrl(type, skip, limit) {
    var baseUrl = getImdbCatalogApiBaseUrl();
    var params = [];
    var yearOption = getSelectedYearBrowseOption(type);
    var ratingOption = getSelectedRatingBrowseOption(type);

    if (!baseUrl || type !== 'movie') {
        return '';
    }

    params.push('blockbuster=1');
    if (yearOption && yearOption.label) {
        params.push('year=' + encodeURIComponent(String(yearOption.label)));
    }
    if (ratingOption && ratingOption.label) {
        params.push('rating=' + encodeURIComponent(String(ratingOption.label)));
    }
    params.push('skip=' + encodeURIComponent(String(Math.max(0, skip || 0))));
    params.push('limit=' + encodeURIComponent(String(Math.max(1, limit || getBlockbusterBrowseLimit(false)))));

    return baseUrl + '/catalog/movie?' + params.join('&');
}

function requestCatalogPayloadUrl(url) {
    if (!url) {
        return Promise.reject(new Error('No catalog URL'));
    }
    if (browseCatalogPayloadCache[url]) {
        return Promise.resolve(browseCatalogPayloadCache[url]);
    }
    if (browseCatalogPayloadPending[url]) {
        return browseCatalogPayloadPending[url];
    }

    browseCatalogPayloadPending[url] = scheduleRequest('catalog', function() {
        return requestJson(url, 'GET');
    }).then(function(payload) {
        browseCatalogPayloadCache[url] = payload;
        delete browseCatalogPayloadPending[url];
        return payload;
    }).catch(function(error) {
        delete browseCatalogPayloadPending[url];
        throw error;
    });

    return browseCatalogPayloadPending[url];
}

function requestImdbCatalogApiPayload(type, combined, skip, limit) {
    return requestCatalogPayloadUrl(buildImdbCatalogApiUrl(type, combined, skip, limit));
}

function getSelectedRatingCombinedOptions(type) {
    var ratingOption = getSelectedRatingBrowseOption(type);
    var baseOption = getSelectedBrowseOption(type);
    var yearOption = getSelectedYearBrowseOption(type);
    var genreLabel;

    if (!ratingOption) {
        return null;
    }

    if (!getImdbCatalogApiBaseUrl()) {
        return null;
    }

    genreLabel = getBrowseGenreFilterLabel(baseOption);
    return {
        baseOption: baseOption,
        yearOption: yearOption,
        ratingOption: ratingOption,
        genreLabel: genreLabel
    };
}

function itemMatchesBrowseConstraints(item, combined) {
    var baseOption = combined && combined.baseOption;
    var genreLabel = combined && combined.genreLabel;

    return itemMatchesRatingFilter(item, combined && combined.ratingOption)
        && itemMatchesYearBrowseOption(item, combined && combined.yearOption)
        && itemMatchesGenreLabel(item, genreLabel || getBrowseGenreFilterLabel(baseOption));
}

function mergeBrowseItemMetadata(item, meta) {
    var output = {};

    Object.keys(item || {}).forEach(function(key) {
        output[key] = item[key];
    });

    if (!meta) {
        return output;
    }

    output.name = output.name || meta.name;
    output.poster = meta.poster || output.poster || '';
    output.background = meta.background || meta.poster || output.background || output.poster || '';
    output.logo = meta.logo || output.logo || '';
    output.description = output.description || meta.description || '';
    output.releaseInfo = output.releaseInfo || meta.releaseInfo || '';
    output.year = output.year || meta.year || '';
    output.runtime = output.runtime || meta.runtime || '';
    if (!getItemGenreLabel(output, '') && meta.genres) {
        output.genres = Array.isArray(meta.genres) ? meta.genres.slice() : meta.genres;
    }
    if (!getItemGenreLabel(output, '') && meta.genre) {
        output.genre = meta.genre;
    }

    return output;
}

function fetchBrowseArtworkMeta(type, item) {
    var key = type + ':' + (item && item.id || '');

    if (!item || !item.id || typeof fetchMetaFromAddons !== 'function') {
        return Promise.resolve(null);
    }
    if (Object.prototype.hasOwnProperty.call(browseArtworkMetaCache, key)) {
        return Promise.resolve(browseArtworkMetaCache[key]);
    }
    if (browseArtworkMetaPending[key]) {
        return browseArtworkMetaPending[key];
    }

    browseArtworkMetaPending[key] = fetchMetaFromAddons(type, item.id).then(function(meta) {
        browseArtworkMetaCache[key] = meta || null;
        delete browseArtworkMetaPending[key];
        return browseArtworkMetaCache[key];
    }).catch(function() {
        browseArtworkMetaCache[key] = null;
        delete browseArtworkMetaPending[key];
        return null;
    });

    return browseArtworkMetaPending[key];
}

function itemNeedsBrowseArtworkMeta(item) {
    var poster = String(item && item.poster || '');
    var background = String(item && item.background || '');

    if (!poster && !background) {
        return true;
    }

    return poster.indexOf('live.metahub.space') !== -1 || background.indexOf('live.metahub.space') !== -1;
}

function enrichBrowseItemsWithArtwork(type, items) {
    if (typeof fetchMetaFromAddons !== 'function') {
        return Promise.resolve((items || []).slice());
    }

    return Promise.all((items || []).map(function(item) {
        if (!itemNeedsBrowseArtworkMeta(item)) {
            return Promise.resolve(item);
        }

        return fetchBrowseArtworkMeta(type, item).then(function(meta) {
            return mergeBrowseItemMetadata(item, meta);
        });
    }));
}

function fetchRatingCombinedBrowse(type, combined, currentItems, append, startSkip) {
    var requestPageLimit = getRatingCombinedBrowseLimit(combined, append);
    var targetLength = (append ? currentItems.length : 0) + requestPageLimit;
    var nextItems = append ? (currentItems || []).slice() : [];
    var pageIndex = 0;
    var nextSkip = append ? Math.max(0, Number(startSkip || 0) || 0) : 0;

    function result(canLoadMore) {
        return {
            items: trimToFullBrowseRows(nextItems),
            canLoadMore: canLoadMore,
            nextSkip: nextSkip
        };
    }

    function fetchNextPage() {
        if (nextItems.length >= targetLength) {
            return Promise.resolve(result(true));
        }
        if (pageIndex >= RATING_BROWSE_SCAN_PAGE_LIMIT) {
            return Promise.resolve(result(false));
        }

        var requestLimit = Math.min(requestPageLimit, Math.max(BROWSE_ROW_SIZE, targetLength - nextItems.length));

        return requestImdbCatalogApiPayload(type, combined, nextSkip, requestLimit).then(function(payload) {
            var rawItems = uniqueCatalogItems(payload && Array.isArray(payload.metas) ? payload.metas : []);
            var filtered = rawItems.filter(function(item) {
                return itemMatchesBrowseConstraints(item, combined);
            }).slice(0, Math.max(0, targetLength - nextItems.length));

            pageIndex += 1;
            nextSkip = payload && typeof payload.nextSkip === 'number'
                ? payload.nextSkip
                : nextSkip + (payload && typeof payload.limit === 'number' ? payload.limit : requestLimit);

            return enrichBrowseItemsWithArtwork(type, filtered).then(function(enriched) {
                nextItems = appendCatalogItems(nextItems, enriched, targetLength);

                if (payload && payload.rateLimited) {
                    return result(payload.hasMore !== false);
                }
                if (!rawItems.length || payload && payload.hasMore === false) {
                    return result(false);
                }

                return fetchNextPage();
            });
        });
    }

    return fetchNextPage();
}

function getSelectedYearCombinedOptions(type) {
    var baseOption = getSelectedBrowseOption(type);
    var yearOption = getSelectedYearBrowseOption(type);

    if (!yearOption) {
        return null;
    }

    return {
        baseOption: baseOption,
        yearOption: yearOption
    };
}

function fetchYearCombinedBrowse(type, baseOption, yearOption, currentItems, append) {
    var targetLength = (append ? currentItems.length : 0) + (append ? BROWSE_LOAD_MORE_SIZE : BROWSE_PAGE_SIZE);

    return requestBrowseCatalogPayload(yearOption, 0).then(function(payload) {
        var yearItems = uniqueCatalogItems(payload && Array.isArray(payload.metas) ? payload.metas : []);
        var filtered;
        var combined;
        var nextItems;

        filtered = filterItemsForBrowseOption(yearItems, baseOption);
        filtered = sortItemsForBrowseBase(filtered, baseOption);
        combined = append ? uniqueCatalogItems((currentItems || []).concat(filtered)) : filtered;
        nextItems = trimToFullBrowseRows(combined.slice(0, targetLength));

        return {
            items: nextItems,
            canLoadMore: combined.length > nextItems.length,
            totalAvailable: filtered.length
        };
    });
}

function cloneBrowseOptionWithArgs(option, label, extraArgs) {
    return {
        key: option.key + '::expansion::' + stableArgsKey(extraArgs),
        label: label,
        addonName: option.addonName,
        addon: option.addon,
        type: option.type,
        catalogId: option.catalogId,
        extraArgs: extraArgs || null,
        filterGroup: option.filterGroup,
        sortRank: option.sortRank,
        supportsSearch: option.supportsSearch,
        supportsSkip: option.supportsSkip,
        backendCatalog: option.backendCatalog || ''
    };
}

function getCinemetaExpansionGenres(type) {
    return type === 'movie' ? CINEMETA_MOVIE_EXPANSION_GENRES : CINEMETA_SERIES_EXPANSION_GENRES;
}

function isCinemetaBrowseExpansionOption(option) {
    var baseUrl = option && option.addon ? addonBaseUrl(option.addon.transportUrl) : '';

    return baseUrl === CINEMETA_BASE
        && option
        && (option.catalogId === 'top' || option.catalogId === 'imdbRating' || option.catalogId === 'year');
}

function getCinemetaBrowseExpansionOptions(type, selectedOption) {
    var options = getBrowseOptions(type);
    var searchSeeds = type === 'movie' ? CINEMETA_MOVIE_SEARCH_SEEDS : CINEMETA_SERIES_SEARCH_SEEDS;
    var output = options.filter(function(option) {
        return option
            && option.key !== (selectedOption && selectedOption.key)
            && isCinemetaBrowseExpansionOption(option);
    });
    var existingKeys = {};
    var yearTemplate = options.filter(function(option) {
        return option && isCinemetaBrowseExpansionOption(option) && option.catalogId === 'year';
    })[0];
    var genreTemplate = options.filter(function(option) {
        return option
            && isCinemetaBrowseExpansionOption(option)
            && option.catalogId === 'top'
            && !option.extraArgs;
    })[0];
    var searchTemplate = options.filter(function(option) {
        return option
            && isCinemetaBrowseExpansionOption(option)
            && option.catalogId === 'top'
            && !option.extraArgs
            && option.supportsSearch;
    })[0];

    output.forEach(function(option) {
        existingKeys[option.catalogId + '::' + stableArgsKey(option.extraArgs)] = true;
    });
    if (genreTemplate) {
        getCinemetaExpansionGenres(type).forEach(function(genre) {
            var key = 'top::genre=' + genre;

            if (!existingKeys[key]) {
                existingKeys[key] = true;
                output.push(cloneBrowseOptionWithArgs(genreTemplate, genre, { genre: genre }));
            }
        });
    }
    if (yearTemplate) {
        CINEMETA_EXPANSION_YEAR_FILTERS.forEach(function(year) {
            var key = 'year::genre=' + year;

            if (!existingKeys[key]) {
                existingKeys[key] = true;
                output.push(cloneBrowseOptionWithArgs(yearTemplate, year, { genre: year }));
            }
        });
    }
    if (searchTemplate) {
        searchSeeds.forEach(function(seed) {
            var key = 'top::search=' + seed;

            if (!existingKeys[key]) {
                existingKeys[key] = true;
                output.push(cloneBrowseOptionWithArgs(searchTemplate, seed, { search: seed }));
            }
        });
    }

    return output;
}

function getRotatedOptions(options, startIndex) {
    var list = options || [];
    var offset = list.length ? startIndex % list.length : 0;

    return list.slice(offset).concat(list.slice(0, offset));
}

function getNextCinemetaSeriesPageSkips(currentLength) {
    var requestSkip = Math.max(
        CINEMETA_CATALOG_PAGE_SIZE,
        Math.floor(currentLength / CINEMETA_CATALOG_PAGE_SIZE) * CINEMETA_CATALOG_PAGE_SIZE
    );
    var pageSkips = [];
    var pageIndex;

    for (pageIndex = 0; pageIndex < BROWSE_EXPANSION_BATCH_SIZE / 2; pageIndex += 1) {
        pageSkips.push(requestSkip + (pageIndex * CINEMETA_CATALOG_PAGE_SIZE));
    }

    return pageSkips;
}

function prefetchBrowseCatalogs(type) {
    var option = getSelectedBrowseOption(type);
    var ratingCombined = getSelectedRatingCombinedOptions(type);
    var yearCombined = isBlockbusterCatalogOption(option) ? null : getSelectedYearCombinedOptions(type);
    var currentLength = getBrowseItems(type).length;
    var expansionOptions;

    if (!option || !getBrowseCanLoadMore(type) || getBrowseLoadingMore(type)) {
        return;
    }
    if (ratingCombined) {
        var ratingLimit = getRatingCombinedBrowseLimit(ratingCombined, true);
        var ratingSkip = Math.max(0, Number(getBrowseSkip(type) || currentLength || 0) || 0);

        requestImdbCatalogApiPayload(
            type,
            ratingCombined,
            ratingSkip,
            ratingLimit
        ).catch(function() {});
        return;
    }

    if (isBlockbusterCatalogOption(option)) {
        requestBrowseCatalogPayload(
            option,
            getBrowseRequestSkip(option, getBrowseSkip(type) || currentLength),
            { limit: getBlockbusterBrowseLimit(true) }
        ).catch(function() {});
        return;
    }

    if (yearCombined) {
        requestBrowseCatalogPayload(yearCombined.yearOption, 0).catch(function() {});
        if (yearCombined.baseOption && yearCombined.baseOption.filterGroup === 'genre') {
            requestBrowseCatalogPayload(yearCombined.baseOption, 0).catch(function() {});
        }
        return;
    }

    if (isCinemetaGenreTopCatalog(option)) {
        requestBrowseCatalogPayload(option, getBrowseRequestSkip(option, currentLength)).catch(function() {});
        return;
    }

    if (usesCinemetaBrowseExpansion(option)) {
        requestBrowseCatalogPayload(option, 0).catch(function() {});
        if (isCinemetaSeriesTopCatalog(option) && !option.extraArgs) {
            getNextCinemetaSeriesPageSkips(Math.max(currentLength, CINEMETA_CATALOG_PAGE_SIZE)).forEach(function(skip) {
                requestBrowseCatalogPayload(option, skip).catch(function() {});
            });
        }

        expansionOptions = getRotatedOptions(
            getCinemetaBrowseExpansionOptions(type, option),
            getBrowseExpansionIndex(type)
        ).slice(0, BROWSE_EXPANSION_BATCH_SIZE);
        expansionOptions.forEach(function(source) {
            requestBrowseCatalogPayload(source, 0).catch(function() {});
        });
        return;
    }

    if (supportsRemoteBrowsePaging(option)) {
        requestBrowseCatalogPayload(option, getBrowseRequestSkip(option, currentLength), isBlockbusterCatalogOption(option) ? {
            limit: getBlockbusterBrowseLimit(true)
        } : null).catch(function() {});
    }
}

function scheduleBrowsePrefetch(type) {
    clearTimeout(browsePrefetchTimers[type]);
    browsePrefetchTimers[type] = setTimeout(function() {
        delete browsePrefetchTimers[type];
        prefetchBrowseCatalogs(type);
    }, 900);
}

function clearBrowsePrefetchTimers() {
    Object.keys(browsePrefetchTimers).forEach(function(type) {
        clearTimeout(browsePrefetchTimers[type]);
        delete browsePrefetchTimers[type];
    });
}

function fetchCinemetaBrowseAppend(type, option, currentItems) {
    var targetLength = currentItems.length + BROWSE_LOAD_MORE_SIZE;
    var expansionOptions = getRotatedOptions(
        getCinemetaBrowseExpansionOptions(type, option),
        getBrowseExpansionIndex(type)
    );
    var nextItems = currentItems.slice();
    var expansionIndex = 0;

    function result(canLoadMore) {
        return {
            items: trimToFullBrowseRows(nextItems),
            canLoadMore: canLoadMore,
            consumedSources: expansionIndex
        };
    }

    function appendPageItems(items) {
        var beforeLength = nextItems.length;
        var filteredItems = filterItemsForBrowseOption(items, option);

        nextItems = appendCatalogItems(nextItems, filteredItems, targetLength);
        return nextItems.length > beforeLength;
    }

    function fetchSeriesRemotePages() {
        var requestSkip;
        var pageSkips = [];
        var pageIndex;

        if (nextItems.length >= targetLength) {
            return Promise.resolve(result(true));
        }

        requestSkip = Math.max(
            CINEMETA_CATALOG_PAGE_SIZE,
            Math.floor(nextItems.length / CINEMETA_CATALOG_PAGE_SIZE) * CINEMETA_CATALOG_PAGE_SIZE
        );

        for (pageIndex = 0; pageIndex < BROWSE_EXPANSION_BATCH_SIZE / 2; pageIndex += 1) {
            pageSkips.push(requestSkip + (pageIndex * CINEMETA_CATALOG_PAGE_SIZE));
        }

        return Promise.all(pageSkips.map(function(pageSkip) {
            return requestBrowseCatalogPayload(option, pageSkip).then(function(payload) {
                return payload;
            }).catch(function() {
                return null;
            });
        })).then(function(payloads) {
            payloads.forEach(function(payload) {
                var pageItems;

                if (!payload || nextItems.length >= targetLength) {
                    return;
                }

                pageItems = shuffleCatalogItems(uniqueCatalogItems(normalizeCatalogPayloadWithLimit(payload, CINEMETA_CATALOG_PAGE_SIZE)));
                appendPageItems(pageItems);
            });
            if (nextItems.length >= targetLength) {
                return result(true);
            }
            return fetchExpansionPages();
        });
    }

    function fetchExpansionPages() {
        var batch;

        if (nextItems.length >= targetLength) {
            return Promise.resolve(result(true));
        }
        if (expansionIndex >= expansionOptions.length) {
            return Promise.resolve(result(false));
        }

        batch = expansionOptions.slice(expansionIndex, expansionIndex + BROWSE_EXPANSION_BATCH_SIZE);
        expansionIndex += batch.length;

        return Promise.all(batch.map(function(source) {
            return requestBrowseCatalogPayload(source, 0).then(function(payload) {
                return payload;
            }).catch(function() {
                return null;
            });
        })).then(function(payloads) {
            payloads.forEach(function(payload) {
                var sourceItems;

                if (!payload) {
                    return;
                }

                sourceItems = shuffleCatalogItems(uniqueCatalogItems(payload && Array.isArray(payload.metas) ? payload.metas : []));
                appendPageItems(sourceItems);
            });
            return fetchExpansionPages();
        });
    }

    function fetchLocalPage() {
        return requestBrowseCatalogPayload(option, 0).then(function(payload) {
            var localItems = shuffleCatalogItems(uniqueCatalogItems(payload && Array.isArray(payload.metas) ? payload.metas : []));

            appendPageItems(localItems);
            if (nextItems.length >= targetLength) {
                return result(true);
            }
            if (isCinemetaSeriesTopCatalog(option) && !option.extraArgs && nextItems.length >= CINEMETA_CATALOG_PAGE_SIZE) {
                return fetchSeriesRemotePages();
            }

            return fetchExpansionPages();
        }).catch(function() {
            return fetchExpansionPages();
        });
    }

    if (isCinemetaSeriesTopCatalog(option) && !option.extraArgs && nextItems.length >= CINEMETA_CATALOG_PAGE_SIZE) {
        return fetchSeriesRemotePages();
    }

    return fetchLocalPage();
}

function buildCatalogRequestUrl(option, skip, extraArgs) {
    var baseUrl = option && option.addon ? addonBaseUrl(option.addon.transportUrl) : '';
    var args = {};
    var parts;

    if (isBlockbusterCatalogOption(option)) {
        return buildBlockbusterCatalogApiUrl(option.type, skip, extraArgs && extraArgs.limit);
    }

    if (!baseUrl || !option) {
        return '';
    }
    mergeCatalogArgs(args, option.extraArgs || {});
    mergeCatalogArgs(args, extraArgs || {});
    if (!args || !Object.keys(args).length) {
        return skip > 0 && option.supportsSkip
            ? baseUrl + '/catalog/' + encodeURIComponent(option.type) + '/' + encodeURIComponent(option.catalogId) + '/skip=' + skip + '.json'
            : baseUrl + '/catalog/' + encodeURIComponent(option.type) + '/' + encodeURIComponent(option.catalogId) + '.json';
    }

    if (skip > 0 && option.supportsSkip && typeof args.skip === 'undefined') {
        args.skip = String(skip);
    }

    parts = Object.keys(args).map(function(name) {
        return encodeURIComponent(name) + '=' + encodeURIComponent(String(args[name]));
    });

    return baseUrl
        + '/catalog/'
        + encodeURIComponent(option.type)
        + '/'
        + encodeURIComponent(option.catalogId)
        + '/'
        + parts.join('&')
        + '.json';
}

function requestBrowseCatalogPayload(option, skip, extraArgs) {
    var url = buildCatalogRequestUrl(option, skip, extraArgs);

    if (!url) {
        return Promise.reject(new Error('No catalog URL'));
    }
    if (browseCatalogPayloadCache[url]) {
        return Promise.resolve(browseCatalogPayloadCache[url]);
    }
    if (browseCatalogPayloadPending[url]) {
        return browseCatalogPayloadPending[url];
    }

    browseCatalogPayloadPending[url] = scheduleRequest('catalog', function() {
        return requestJson(url, 'GET');
    }).then(function(payload) {
        browseCatalogPayloadCache[url] = payload;
        delete browseCatalogPayloadPending[url];
        return payload;
    }).catch(function(error) {
        delete browseCatalogPayloadPending[url];
        throw error;
    });

    return browseCatalogPayloadPending[url];
}

function normalizeHttpError(error) {
    var parsed;
    var candidates;
    var message;

    if (error instanceof Error) {
        return error.message;
    }

    if (!error) {
        return 'Request failed';
    }

    parsed = safeJsonParse(error.text);
    candidates = [
        parsed && parsed.msg,
        parsed && parsed.message,
        parsed && parsed.error_description,
        parsed && parsed.error,
        parsed && parsed.hint
    ];

    message = candidates.filter(function(value) {
        return typeof value === 'string' && value.trim();
    })[0];

    if (!message && error.text) {
        message = String(error.text).replace(/\s+/g, ' ').trim();
    }

    if (!message) {
        return 'HTTP ' + (error.status || 0);
    }

    return (error.status ? 'HTTP ' + error.status + ': ' : '') + message;
}

function requestJson(url, method, body) {
    return new Promise(function(resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open(method || 'GET', url, true);
        xhr.setRequestHeader('Accept', 'application/json');
        if (body) {
            xhr.setRequestHeader('Content-Type', 'application/json');
        }
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== 4) {
                return;
            }
            if (xhr.status < 200 || xhr.status >= 300) {
                reject(new Error('HTTP ' + xhr.status));
                return;
            }
            try {
                var payload = JSON.parse(xhr.responseText);
                if (payload && payload.error) {
                    reject(new Error(payload.error.message || 'API error'));
                    return;
                }
                if (payload && typeof payload.result !== 'undefined') {
                    resolve(payload.result);
                    return;
                }
                resolve(payload);
            } catch (error) {
                reject(new Error('Invalid JSON response'));
            }
        };
        xhr.onerror = function() {
            reject(new Error('Network request failed'));
        };
        xhr.send(body ? JSON.stringify(body) : null);
    });
}

function requestJsonWithHeaders(url, method, body, headers) {
    return new Promise(function(resolve, reject) {
        var xhr = new XMLHttpRequest();
        var payload = body ? JSON.stringify(body) : null;
        xhr.open(method || 'GET', url, true);
        xhr.setRequestHeader('Accept', 'application/json');
        if (body) {
            xhr.setRequestHeader('Content-Type', 'application/json');
        }
        Object.keys(headers || {}).forEach(function(name) {
            xhr.setRequestHeader(name, headers[name]);
        });
        xhr.onreadystatechange = function() {
            var parsed;
            if (xhr.readyState !== 4) {
                return;
            }
            if (xhr.status < 200 || xhr.status >= 300) {
                reject({
                    status: xhr.status,
                    text: xhr.responseText
                });
                return;
            }
            parsed = safeJsonParse(xhr.responseText);
            if (xhr.responseText && !parsed) {
                reject(new Error('Invalid JSON response'));
                return;
            }
            resolve(parsed);
        };
        xhr.onerror = function() {
            reject(new Error('Network request failed'));
        };
        xhr.send(payload);
    }).catch(function(error) {
        throw new Error(normalizeHttpError(error));
    });
}

function requestSupabaseAuth(path, method, body) {
    return requestJsonWithHeaders(
        getNuvioAuthBaseUrl() + path,
        method || 'GET',
        body,
        {
            apikey: SUPABASE_ANON_KEY
        }
    );
}

function requestSupabaseWithToken(path, method, body, token) {
    return requestJsonWithHeaders(
        getNuvioAuthBaseUrl() + path,
        method || 'GET',
        body,
        buildSupabaseHeaders(token)
    );
}

function requestSupabaseWithTokenHeaders(path, method, body, token, extraHeaders) {
    var headers = buildSupabaseHeaders(token);

    mergeHeaderMap(headers, extraHeaders);
    return requestJsonWithHeaders(
        getNuvioAuthBaseUrl() + path,
        method || 'GET',
        body,
        headers
    );
}

function requestSupabaseWithSession(path, method, body) {
    return requestSupabaseWithToken(path, method, body, state.authKey).catch(function(error) {
        if (!state.refreshToken || error.message.indexOf('HTTP 401') !== 0) {
            throw error;
        }

        return refreshSessionIfNeeded().then(function(refreshed) {
            if (!refreshed) {
                throw error;
            }

            return requestSupabaseWithToken(path, method, body, state.authKey);
        });
    });
}

function requestSupabaseWithSessionHeaders(path, method, body, extraHeaders) {
    return requestSupabaseWithTokenHeaders(path, method, body, state.authKey, extraHeaders).catch(function(error) {
        if (!state.refreshToken || error.message.indexOf('HTTP 401') !== 0) {
            throw error;
        }

        return refreshSessionIfNeeded().then(function(refreshed) {
            if (!refreshed) {
                throw error;
            }

            return requestSupabaseWithTokenHeaders(path, method, body, state.authKey, extraHeaders);
        });
    });
}
