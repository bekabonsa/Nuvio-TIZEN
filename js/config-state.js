var CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
var OPENSUBTITLES_BASE = 'https://opensubtitles-v3.strem.io';
var DEFAULT_ADDON_URLS = [CINEMETA_BASE, OPENSUBTITLES_BASE];
var LOCAL_ADDON_URLS = [];
var DEFAULT_STREAM_SOURCE_MODE = 'torrentio-rd';
var STREAM_REQUEST_TIMEOUT_MS = 12000;
var STREAM_SOURCE_FILTERS = [
    {
        id: 'torrentio-rd',
        label: 'TorrentioRD',
        type: 'addon',
        urlIncludes: ['torrentio.strem.fun', 'realdebrid='],
        alwaysVisible: true
    },
    {
        id: 'comet',
        label: 'Comet',
        type: 'addon',
        urlIncludes: ['comet.elfhosted.com'],
        alwaysVisible: true
    },
    {
        id: 'bridge',
        label: 'Bridge',
        type: 'bridge',
        alwaysVisible: true
    }
];
var NUVIO_API_BASE = 'https://nuvio.tv';
var SUPABASE_URL = 'https://dpyhjjcoabcglfmgecug.supabase.co';
var NUVIO_AUTH_BASE_URL = SUPABASE_URL;
var NUVIO_DEFAULT_LOGIN_EMAIL = '';
var NUVIO_DEFAULT_LOGIN_PASSWORD = '';
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRweWhqamNvYWJjZ2xmbWdlY3VnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3ODYyNDcsImV4cCI6MjA4NjM2MjI0N30.U-3QSNDdpsnvRk_7ZL419AFTOtggHJJcmkodxeXjbkg';
var TV_LOGIN_REDIRECT_BASE_URL = 'https://nuvioapp.space/tv-login';
var AUDIO_TRANSCODER_BASE_URL = 'http://10.0.0.10:8787';
var IMDB_CATALOG_API_BASE_URL = 'http://10.0.0.10:8791';
var IMDB_API_BASE_URL = 'https://api.imdbapi.dev';
var TRAILER_DIRECT_STREAM_ENABLED = true;
var TORRENT_BRIDGE_BASE_URL = '';
var TORRENT_BRIDGE_TOKEN = '';
var STORAGE_AUTH = 'nuvio.accessToken';
var STORAGE_REFRESH = 'nuvio.refreshToken';
var STORAGE_USER = 'nuvio.user';
var STORAGE_CONTINUE = 'nuviotizen.continueWatching';
var STORAGE_WATCHED_EPISODES = 'nuviotizen.watchedEpisodes';
var STORAGE_LIBRARY = 'nuviotizen.library';
function buildDescendingYearList(startYear, endYear) {
    var years = [];
    var year;

    for (year = startYear; year >= endYear; year -= 1) {
        years.push(String(year));
    }

    return years;
}

var CINEMETA_MOVIE_GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Horror', 'Sci-Fi', 'Thriller'];
var CINEMETA_MOVIE_EXPANSION_GENRES = ['Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western'];
var CINEMETA_SERIES_GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Drama', 'Fantasy', 'Sci-Fi'];
var CINEMETA_SERIES_EXPANSION_GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Drama', 'Fantasy', 'Sci-Fi'];
var CINEMETA_YEAR_FILTERS = buildDescendingYearList(2026, 1960);
var CINEMETA_EXPANSION_YEAR_FILTERS = buildDescendingYearList(2026, 1960);
var IMDB_RATING_FILTERS = ['9', '8', '7', '6', '5', '4', '3', '2', '1'];
var YEAR_FILTER_WINDOW_SIZE = 3;
var CINEMETA_MOVIE_SEARCH_SEEDS = ['the', 'love', 'life', 'night', 'day', 'man', 'girl', 'dark', 'city', 'family', 'last', 'first', 'new', 'old', 'house', 'king', 'school', 'space', 'star', 'time', 'game', 'home'];
var CINEMETA_SERIES_SEARCH_SEEDS = ['the', 'love', 'life', 'night', 'day', 'war', 'dark', 'city', 'family', 'first', 'new', 'old', 'house', 'queen', 'school', 'doctor', 'space', 'star', 'time', 'secret', 'story', 'game', 'home'];
var NAV_VIEWS = ['search', 'home', 'library', 'series', 'movies', 'login'];
var FEATURED_ROTATION_MS = 9000;
var FEATURED_FADE_MS = 180;
var HOME_CATALOG_LIMIT = 60;
var CONTINUE_WATCHING_LIMIT = 20;
var WATCHED_EPISODE_LIMIT = 500;
var WATCH_PROGRESS_PULL_LIMIT = 50;
var NUVIO_PROFILE_ID = 1;
var LIBRARY_LIMIT = 120;
var LIBRARY_PULL_LIMIT = 500;
var LIBRARY_ROW_SIZE = 6;
var HOME_ARTWORK_PRELOAD_COUNT = 4;
var ARTWORK_PRELOAD_LIMIT = 24;
var BROWSE_ROW_SIZE = 5;
var BROWSE_PAGE_SIZE = 25;
var BROWSE_LOAD_MORE_SIZE = BROWSE_PAGE_SIZE * 2;
var BLOCKBUSTER_PAGE_SIZE = 60;
var BLOCKBUSTER_LOAD_MORE_SIZE = 150;
var CINEMETA_CATALOG_PAGE_SIZE = 50;
var BROWSE_EXPANSION_BATCH_SIZE = 4;
var RATING_BROWSE_SCAN_PAGE_LIMIT = 20;
var DETAIL_CAST_LIMIT = 10;
var DETAIL_RELATED_LIMIT = 12;
var FORCE_AVPLAY_DEBUG = false;
var PLAYER_SCRUB_INITIAL_NUDGE_MS = 5000;
var PLAYER_SCRUB_TICK_MS = 50;
var artworkPreloadCache = {};
var artworkPreloadOrder = [];
var browseCatalogPayloadCache = {};
var browseCatalogPayloadPending = {};
var browseArtworkMetaCache = {};
var browseArtworkMetaPending = {};
var browsePrefetchTimers = {};
var homeActiveMetaCache = {};
var homeActiveMetaPending = {};
var imdbApiTitleCache = {};
var imdbApiCreditsCache = {};
var imdbApiTitlePending = {};
var imdbApiCreditsPending = {};
var detailRelatedCache = {};
var detailRelatedPending = {};
var detailTrailerCache = {};
var detailTrailerPending = {};
var REQUEST_CONCURRENCY_LIMITS = {
    catalog: 2,
    meta: 2,
    subtitle: 2,
    stream: 2,
    default: 4
};
var requestSchedulerState = {};
var SEARCH_KEYBOARD_ROWS = [
    ['a', 'b', 'c', 'd', 'e', 'f'],
    ['g', 'h', 'i', 'j', 'k', 'l'],
    ['m', 'n', 'o', 'p', 'q', 'r'],
    ['s', 't', 'u', 'v', 'w', 'x'],
    ['y', 'z', '1', '2', '3', '4'],
    ['5', '6', '7', '8', '9', '0'],
    ['space', 'backspace', 'clear']
];
var VIEW_META = {
    home: {
        eyebrow: 'Discover',
        title: 'Home',
        subtitle: 'Featured picks, continue watching, and curated rows shaped for TV browsing.'
    },
    movies: {
        eyebrow: 'Catalog',
        title: 'Films',
        subtitle: 'Browse linked film catalogs and drill into sources without leaving the TV flow.'
    },
    library: {
        eyebrow: 'Saved',
        title: 'Library',
        subtitle: 'Your saved films and series from this TV and synced Nuvio account.'
    },
    series: {
        eyebrow: 'Catalog',
        title: 'Series',
        subtitle: 'Browse linked show catalogs, then move into seasons, episodes, and installed addon sources.'
    },
    search: {
        eyebrow: 'Discover',
        title: 'Search',
        subtitle: 'Search linked addon catalogs for films and series.'
    },
    addons: {
        eyebrow: 'Details',
        title: 'Details',
        subtitle: 'Selection summary, seasons, episodes, and the sources available from your installed addons.'
    },
    player: {
        eyebrow: 'Playback',
        title: 'Player',
        subtitle: 'Native playback with TV overlay controls and direct addon stream support.'
    },
    login: {
        eyebrow: 'Account',
        title: 'My Nuvio',
        subtitle: 'Connect your Nuvio account, restore your synced session, and use your linked addons.'
    }
};

/**
 * @typedef {Object} CatalogItem
 * @property {string} id
 * @property {string=} name
 * @property {string=} poster
 * @property {string=} background
 * @property {string=} description
 * @property {string=} releaseInfo
 * @property {string|number=} imdbRating
 * @property {(string|string[])=} genre
 * @property {string[]=} genres
 * @property {string|number=} runtime
 */

/**
 * @typedef {Object} AddonDefinition
 * @property {string} id
 * @property {string} transportUrl
 * @property {{name:string, resources:Array, catalogs:Array, types:Array}=} manifest
 * @property {boolean=} localOnly
 */

/**
 * @typedef {Object} VideoEntry
 * @property {string} id
 * @property {string=} title
 * @property {number|string=} season
 * @property {number|string=} episode
 */

/**
 * @typedef {Object} StreamEntry
 * @property {boolean} playable
 * @property {string} status
 * @property {Object=} raw
 */

/**
 * @typedef {Object} SubtitleTrack
 * @property {string} id
 * @property {string} label
 * @property {string=} language
 * @property {number=} index
 */

/**
 * @typedef {Object} ContinueWatchingEntry
 * @property {string} kind
 * @property {CatalogItem} item
 * @property {VideoEntry=} video
 * @property {number=} position
 * @property {number=} duration
 */

/**
 * @typedef {Object} AppState
 * @property {string|null} authKey
 * @property {AddonDefinition[]} addons
 * @property {ContinueWatchingEntry[]} continueWatching
 * @property {CatalogItem[]} movies
 * @property {CatalogItem[]} series
 * @property {string} currentView
 * @property {'nav'|'main'} focusRegion
 * @property {StreamEntry|null} currentStream
 */

/** @type {AppState} */
var state = {
    authKey: null,
    refreshToken: null,
    user: null,
    ownerId: null,
    addons: [],
    continueWatching: [],
    watchedEpisodes: [],
    libraryItems: [],
    libraryMode: 'saved',
    downloadedLibraryItems: [],
    downloadedLibraryLoading: false,
    downloadedLibraryError: '',
    downloadedLibraryLoadedAt: 0,
    downloadedLibraryDeleting: {},
    movies: [],
    series: [],
    movieGenres: [],
    seriesGenres: [],
    selectedMovieGenre: '',
    selectedSeriesGenre: '',
    selectedMovieYear: '',
    selectedSeriesYear: '',
    selectedMovieRating: '',
    selectedSeriesRating: '',
    movieBrowseItems: [],
    seriesBrowseItems: [],
    movieSkip: 0,
    seriesSkip: 0,
    movieBrowseCanLoadMore: true,
    seriesBrowseCanLoadMore: true,
    movieBrowseLoadingMore: false,
    seriesBrowseLoadingMore: false,
    movieBrowseExpansionIndex: Math.floor(Math.random() * 1000),
    seriesBrowseExpansionIndex: Math.floor(Math.random() * 1000),
    movieBrowseRequestId: 0,
    seriesBrowseRequestId: 0,
    movieYearWindowStart: 0,
    seriesYearWindowStart: 0,
    movieYearFilterOpen: false,
    seriesYearFilterOpen: false,
    movieYearFocusIndex: 0,
    seriesYearFocusIndex: 0,
    movieRatingWindowStart: 0,
    seriesRatingWindowStart: 0,
    movieRatingFilterOpen: false,
    seriesRatingFilterOpen: false,
    movieRatingFocusIndex: 0,
    seriesRatingFocusIndex: 0,
    searchQuery: '',
    searchScope: 'all',
    searchMovies: [],
    searchSeries: [],
    searchResults: [],
    searchSuggestions: [],
    searchDebounceTimer: null,
    searchRequestId: 0,
    selectedItem: null,
    selectedType: null,
    selectedImdbApiTitle: null,
    selectedCast: [],
    selectedRelatedItems: [],
    detailRelatedLoading: false,
    detailRelatedRequestKey: '',
    selectedDetailRequestKey: '',
    selectedTrailer: null,
    detailTrailerRequestKey: '',
    detailTrailerLoading: false,
    detailTrailerError: '',
    detailTrailerActive: false,
    detailTrailerPlaying: false,
    detailTrailerLoaded: false,
    detailTrailerResolving: false,
    detailTrailerMode: '',
    detailTrailerEmbedUrl: '',
    detailTrailerFallbackAttempted: false,
    detailTrailerCurrentSeconds: 0,
    detailTrailerDurationSeconds: 0,
    detailTrailerTimer: null,
    detailTrailerSyncTimer: null,
    allSeriesVideos: [],
    availableSeasons: [],
    selectedSeason: null,
    selectedEpisodes: [],
    selectedVideo: null,
    detailMode: 'details',
    streams: [],
    streamSourceMode: '',
    streamFilterCached: true,
    streamFilterBridge: false,
    streamRequestId: 0,
    currentStream: null,
    torrentBridgeJobs: {},
    audioTracks: [],
    audioTrackFailures: {},
    subtitleTracks: [],
    streamSubtitleTracks: [],
    addonSubtitleTracks: [],
    externalSubtitleTracks: [],
    externalSubtitleCues: [],
    playbackDiagnostics: [],
    playbackDiagnosticKeys: {},
    activeAudioTrack: null,
    activeSubtitleTrack: 'subtitle-off',
    subtitleRequestId: 0,
    currentTimeMs: 0,
    durationMs: 0,
    pendingResumePositionMs: 0,
    pendingResumeStream: null,
    resumeAutoplayInPlayer: false,
    lastProgressSavedAt: 0,
    lastProgressSavedPositionMs: 0,
    suppressProgressSave: false,
    playbackTicker: null,
    suppressNextHtml5AbortDiagnostic: false,
    playerChromeTimer: null,
    seekPreviewActive: false,
    seekPreviewTargetMs: 0,
    seekPreviewDirection: 0,
    seekPreviewStartedAt: 0,
    seekPreviewLastTickAt: 0,
    seekPreviewTimer: null,
    playerMode: 'html5',
    playerFullscreen: false,
    transcodedPlaybackActive: false,
    transcodedSourceUrl: '',
    transcodedAudioTrack: null,
    transcodedOffsetMs: 0,
    transcodedDurationMs: 0,
    currentView: 'home',
    viewHistory: [],
    browseReturnState: {
        movies: null,
        series: null
    },
    focusRegion: 'nav',
    navIndex: 1,
    mainRow: 0,
    mainCol: 0,
    focusRegistry: {
        view: '',
        rows: [],
        rowContainers: [],
        dirty: true
    },
    featuredKey: null,
    featuredIndex: 0,
    featuredRotationItems: [],
    featuredTimer: null,
    featuredItem: null,
    featuredKind: null,
    featuredLabel: '',
    featuredRenderedKey: null,
    featuredTransitionToken: 0,
    featuredTransitionTimer: null,
    autoplayPending: false,
    qrAuthAccessToken: null,
    qrAuthRefreshToken: null,
    qrSessionId: 0,
    qrPollTimer: null,
    qrExpiresTimer: null,
    qrCode: null,
    qrLoginUrl: '',
    qrDeviceNonce: '',
    qrExpiresAt: 0,
    qrStarting: false,
    debugAvplay: false,
    debugAvplayOverlay: null,
    lastAvplayDebugMetrics: null,
    homeRailIndices: {
        continue: 0,
        movies: 0,
        series: 0
    },
    homeRailMoveDirections: {
        continue: null,
        movies: null,
        series: null
    }
};
