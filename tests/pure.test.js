const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const scriptOrder = [
  'js/config-state.js',
  'js/platform-dom.js',
  'js/player.js',
  'js/navigation-focus.js',
  'js/catalogs-addons.js',
  'js/auth-sync.js',
  'js/detail-streams.js',
  'js/search-rendering.js'
];

const sandbox = {
  console,
  Promise,
  Date,
  Math,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Error,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  window: {
    location: { search: '' }
  },
  document: {
    getElementById() {
      throw new Error('DOM access is not available in pure tests');
    },
    querySelectorAll() {
      return [];
    }
  },
  localStorage: {
    getItem() { return null; },
    setItem() {},
    removeItem() {}
  }
};

vm.createContext(sandbox);
scriptOrder.forEach((relativePath) => {
  const filename = path.join(root, relativePath);
  vm.runInContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
});

function testSubtitleParsing() {
  const cues = sandbox.parseSubtitleFile(`WEBVTT

1
00:00:01.000 --> 00:00:03.500
Hello <i>TV</i>

00:00:04,000 --> 00:00:05,250
Second line`);

  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].start, 1000);
  assert.strictEqual(cues[0].end, 3500);
  assert.strictEqual(cues[0].text, 'Hello TV');
  assert.strictEqual(cues[1].start, 4000);
  assert.strictEqual(cues[1].end, 5250);
  assert.strictEqual(cues[1].text, 'Second line');
}

function testContinueDedupe() {
  const entries = sandbox.dedupeEntries([
    {
      kind: 'movie',
      item: { id: 'tt1', name: 'First' },
      position: 10,
      duration: 100
    },
    {
      kind: 'movie',
      item: { id: 'tt1', name: 'Duplicate' },
      position: 90,
      duration: 100
    },
    {
      kind: 'series',
      item: { id: 'tt2', name: 'Show' },
      video: { id: 'tt2:1:1', season: 1, episode: 1 }
    }
  ], sandbox.normalizeContinueEntry, 10);

  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].item.name, 'First');
  assert.strictEqual(entries[1].video.season, 1);
}

function testWatchedEpisodeTracking() {
  const show = { id: 'ttshow', name: 'Show' };
  const first = { id: 'ttshow:1:1', season: 1, episode: 1, title: 'Pilot' };
  const second = { id: 'ttshow:1:2', season: 1, episode: 2, title: 'Second' };

  sandbox.state.selectedItem = show;
  sandbox.state.selectedType = 'series';
  sandbox.state.watchedEpisodes = [];
  sandbox.state.continueWatching = [];

  sandbox.mergeWatchedEpisodeEntries([{
    kind: 'series',
    item: show,
    video: first,
    position: 120,
    duration: 1800
  }]);

  assert.strictEqual(sandbox.isWatchedEpisode(first), true);
  assert.strictEqual(sandbox.isWatchedEpisode(second), false);

  sandbox.mergeWatchedEpisodeEntries([{
    kind: 'series',
    item: show,
    video: { season: 1, episode: 2 },
    lastWatched: Date.now()
  }]);

  assert.strictEqual(sandbox.isWatchedEpisode(second), true);
  assert.strictEqual(sandbox.state.watchedEpisodes.length, 2);

  sandbox.state.selectedItem = null;
  sandbox.state.selectedType = null;
  sandbox.state.watchedEpisodes = [];
  sandbox.state.continueWatching = [];
}

function testCatalogSelectionAndUrls() {
  const cinemetaAddon = {
    transportUrl: 'https://v3-cinemeta.strem.io/manifest.json'
  };
  const otherAddon = {
    transportUrl: 'https://example.com/addon/manifest.json'
  };
  const preferred = sandbox.selectPreferredCatalogOption([
    { label: 'Other', catalogId: 'popular', supportsSearch: true, addon: otherAddon },
    { label: 'Top', catalogId: 'top', supportsSearch: false, addon: cinemetaAddon }
  ]);

  assert.strictEqual(preferred.catalogId, 'top');

  const url = sandbox.buildCatalogRequestUrl({
    addon: cinemetaAddon,
    type: 'movie',
    catalogId: 'top',
    supportsSkip: true,
    extraArgs: { genre: 'Action' }
  }, 50, { search: 'space' });

  assert.strictEqual(
    url,
    'https://v3-cinemeta.strem.io/catalog/movie/top/genre=Action&search=space&skip=50.json'
  );
}

function testBrowsePaging() {
  const movieTop = {
    addon: { transportUrl: 'https://v3-cinemeta.strem.io/manifest.json' },
    type: 'movie',
    catalogId: 'top',
    supportsSkip: true
  };
  const seriesTop = {
    addon: { transportUrl: 'https://v3-cinemeta.strem.io/manifest.json' },
    type: 'series',
    catalogId: 'top',
    supportsSkip: true
  };
  const movieAction = {
    addon: { transportUrl: 'https://v3-cinemeta.strem.io/manifest.json' },
    type: 'movie',
    catalogId: 'top',
    filterGroup: 'genre',
    extraArgs: { genre: 'Action' },
    supportsSkip: true
  };

  assert.strictEqual(sandbox.usesLocalBrowsePaging(movieTop, 100), true);
  assert.strictEqual(sandbox.usesLocalBrowsePaging(seriesTop, 0), true);
  assert.strictEqual(sandbox.usesLocalBrowsePaging(seriesTop, 50), false);
  assert.strictEqual(sandbox.usesLocalBrowsePaging(movieAction, 0), false);
  assert.strictEqual(sandbox.supportsRemoteBrowsePaging(movieAction), true);
  assert.strictEqual(sandbox.usesCinemetaBrowseExpansion(movieAction), false);
  assert.strictEqual(sandbox.getBrowseRequestSkip(seriesTop, 51), 50);
  assert.deepStrictEqual(sandbox.trimToFullBrowseRows([1, 2, 3, 4, 5, 6, 7]), [1, 2, 3, 4, 5]);
}

function testBrowseGenreFiltering() {
  const actionOption = {
    label: 'Action',
    filterGroup: 'genre',
    extraArgs: { genre: 'Action' }
  };
  const items = [
    { id: 'tt-action', name: 'Action Match', genres: ['Action', 'Drama'] },
    { id: 'tt-drama', name: 'Drama Only', genres: ['Drama'] },
    { id: 'tt-string', name: 'String Genres', genre: 'Action, Thriller' },
    { id: 'tt-compound', name: 'Compound Genres', genres: ['Sci-Fi & Fantasy', 'Action & Adventure', 'Drama'] }
  ];

  assert.deepStrictEqual(
    Array.from(sandbox.filterItemsForBrowseOption(items, actionOption).map((item) => item.id)),
    ['tt-action', 'tt-string', 'tt-compound']
  );
  assert.strictEqual(
    sandbox.getItemGenreLabel(items[3], ''),
    'Sci-Fi & Fantasy / Action & Adventure'
  );
}

function testYearFilterDefaultAll() {
  const yearOption = {
    key: 'year-2026',
    label: '2026',
    filterGroup: 'year'
  };
  const yearOptions = sandbox.getYearFilterOptionsForRender('movie', [yearOption]);

  sandbox.state.selectedMovieYear = '';
  assert.deepStrictEqual(Array.from(yearOptions.map((option) => option.label)), ['All', '2026']);
  assert.strictEqual(sandbox.getSelectedYearBrowseOption('movie'), null);
  assert.strictEqual(sandbox.getCollapsedYearIndex('movie', yearOptions, sandbox.getSelectedYearBrowseKey('movie')), 0);

  sandbox.state.selectedMovieYear = yearOption.key;
  assert.strictEqual(sandbox.getCollapsedYearIndex('movie', yearOptions, sandbox.getSelectedYearBrowseKey('movie')), 1);
  sandbox.state.selectedMovieYear = '';
}

function testImdbRatingFilter() {
  const cinemetaAddon = { transportUrl: 'https://v3-cinemeta.strem.io/manifest.json' };
  const movieOption = {
    key: 'popular',
    label: 'Popular',
    addon: cinemetaAddon,
    type: 'movie',
    catalogId: 'top',
    filterGroup: 'catalog'
  };
  const actionOption = {
    key: 'action',
    label: 'Action',
    addon: cinemetaAddon,
    type: 'movie',
    catalogId: 'top',
    filterGroup: 'genre',
    extraArgs: { genre: 'Action' }
  };
  const ratingSourceOption = {
    key: 'featured',
    label: 'Featured',
    addon: cinemetaAddon,
    type: 'movie',
    catalogId: 'imdbRating',
    filterGroup: 'catalog',
    supportsSkip: true
  };
  const ratingOptions = sandbox.getRatingFilterOptionsForRender('movie');
  const ratingSeven = ratingOptions.filter((option) => option.label === '7')[0];
  const items = [
    { id: 'tt-69', name: 'Below', imdbRating: '6.9' },
    { id: 'tt-70', name: 'Match Low', imdbRating: '7.0' },
    { id: 'tt-78', name: 'Match High', imdbRating: 7.8 },
    { id: 'tt-80', name: 'Too High', imdbRating: '8.0' },
    { id: 'tt-none', name: 'No Rating' }
  ];

  sandbox.state.movieGenres = [movieOption, actionOption, ratingSourceOption];
  sandbox.state.selectedMovieGenre = movieOption.key;
  sandbox.state.selectedMovieRating = '';
  assert.deepStrictEqual(Array.from(ratingOptions.map((option) => option.label)), ['All', '9', '8', '7', '6', '5', '4', '3', '2', '1']);
  assert.strictEqual(sandbox.getSelectedRatingBrowseOption('movie'), null);
  assert.strictEqual(sandbox.getCollapsedRatingIndex('movie', ratingOptions, sandbox.getSelectedRatingBrowseKey('movie')), 0);

  sandbox.state.selectedMovieRating = ratingSeven.key;
  assert.strictEqual(sandbox.getCollapsedRatingIndex('movie', ratingOptions, sandbox.getSelectedRatingBrowseKey('movie')), 3);
  assert.deepStrictEqual(
    Array.from(sandbox.filterItemsForBrowseOption(items, movieOption).map((item) => item.id)),
    ['tt-70', 'tt-78']
  );
  assert.strictEqual(sandbox.getSelectedBrowseLabel('movie'), 'Popular • IMDb 7');

  sandbox.state.selectedMovieGenre = actionOption.key;
  const combined = sandbox.getSelectedRatingCombinedOptions('movie');
  assert.strictEqual(combined.genreLabel, 'Action');
  assert.strictEqual(
    sandbox.buildImdbCatalogApiUrl('movie', combined, 50, 50),
    'http://10.0.0.10:8791/catalog/movie?rating=7&genre=Action&skip=50&limit=50'
  );

  sandbox.state.selectedMovieRating = '';
  sandbox.state.movieGenres = [];
  sandbox.state.selectedMovieGenre = '';
}

function testBlockbusterCatalogOption() {
  const previousApiBase = sandbox.IMDB_CATALOG_API_BASE_URL;
  const previousMovieGenres = sandbox.state.movieGenres;
  const previousSelectedMovieGenre = sandbox.state.selectedMovieGenre;
  const previousSelectedMovieYear = sandbox.state.selectedMovieYear;
  const previousSelectedMovieRating = sandbox.state.selectedMovieRating;

  try {
    sandbox.IMDB_CATALOG_API_BASE_URL = 'http://catalog.example.test';

    const options = sandbox.buildCatalogOptions('movie');
    const blockbuster = options.filter((option) => sandbox.isBlockbusterCatalogOption(option))[0];
    const yearOption = {
      key: 'year-2025',
      label: '2025',
      type: 'movie',
      filterGroup: 'year'
    };
    const ratingEight = sandbox.getRatingFilterOptionsForRender('movie').filter((option) => option.label === '8')[0];

    assert.ok(blockbuster);
    assert.strictEqual(blockbuster.label, 'Blockbuster');
    assert.strictEqual(sandbox.supportsRemoteBrowsePaging(blockbuster), true);

    sandbox.state.movieGenres = [blockbuster, yearOption];
    sandbox.state.selectedMovieGenre = blockbuster.key;
    sandbox.state.selectedMovieYear = yearOption.key;
    sandbox.state.selectedMovieRating = '';
    assert.strictEqual(
      sandbox.buildCatalogRequestUrl(blockbuster, 40, { limit: 25 }),
      'http://catalog.example.test/catalog/movie?blockbuster=1&year=2025&skip=40&limit=25'
    );

    sandbox.state.selectedMovieRating = ratingEight.key;
    assert.strictEqual(
      sandbox.buildImdbCatalogApiUrl('movie', sandbox.getSelectedRatingCombinedOptions('movie'), 50, 50),
      'http://catalog.example.test/catalog/movie?blockbuster=1&rating=8&year=2025&skip=50&limit=50'
    );
  } finally {
    sandbox.IMDB_CATALOG_API_BASE_URL = previousApiBase;
    sandbox.state.movieGenres = previousMovieGenres;
    sandbox.state.selectedMovieGenre = previousSelectedMovieGenre;
    sandbox.state.selectedMovieYear = previousSelectedMovieYear;
    sandbox.state.selectedMovieRating = previousSelectedMovieRating;
  }
}

function testDetailTrailerHelpers() {
  const previousApiBase = sandbox.IMDB_CATALOG_API_BASE_URL;
  const trailer = sandbox.normalizeDetailTrailerPayload({
    trailer: {
      site: 'YouTube',
      key: 'abc123XYZ',
      name: 'Official Trailer'
    }
  });

  assert.strictEqual(trailer.key, 'abc123XYZ');
  assert.strictEqual(sandbox.normalizeDetailTrailerPayload({ trailer: null }), null);
  assert.strictEqual(sandbox.formatTrailerTime(65), '1:05');
  try {
    sandbox.IMDB_CATALOG_API_BASE_URL = '';
    assert.strictEqual(
      sandbox.buildDetailTrailerEmbedUrl(trailer),
      'https://www.youtube.com/embed/abc123XYZ?enablejsapi=1&playsinline=1&rel=0&modestbranding=1&controls=0&iv_load_policy=3&autoplay=1'
    );
    sandbox.IMDB_CATALOG_API_BASE_URL = 'http://catalog.example.test';
    assert.strictEqual(
      sandbox.buildDetailTrailerEmbedUrl(trailer),
      'http://catalog.example.test/trailer-player?key=abc123XYZ&title=Official%20Trailer'
    );
  } finally {
    sandbox.IMDB_CATALOG_API_BASE_URL = previousApiBase;
  }
}

function testTorrentBridgeHelpers() {
  const previousBaseUrl = sandbox.TORRENT_BRIDGE_BASE_URL;
  const previousToken = sandbox.TORRENT_BRIDGE_TOKEN;
  const stream = {
    raw: {
      infoHash: '0123456789abcdef0123456789abcdef01234567',
      fileIdx: 2,
      name: 'Example'
    }
  };

  try {
    sandbox.TORRENT_BRIDGE_BASE_URL = 'http://bridge.example.test:8788/';
    sandbox.TORRENT_BRIDGE_TOKEN = 'secret';

    assert.strictEqual(sandbox.getTorrentBridgeBaseUrl(), 'http://bridge.example.test:8788');
    assert.strictEqual(sandbox.getStreamInfoHash(stream), '0123456789abcdef0123456789abcdef01234567');
    assert.strictEqual(sandbox.isTorrentBridgeCandidate(stream), true);
    assert.strictEqual(
      sandbox.getTorrentBridgeJobKey(stream),
      '0123456789abcdef0123456789abcdef01234567:2'
    );
    const payload = sandbox.getTorrentBridgePayload(stream);
    assert.strictEqual(payload.infoHash, '0123456789abcdef0123456789abcdef01234567');
    assert.strictEqual(payload.fileIndex, 2);
    assert.strictEqual(payload.title, 'Example');

    const bridgedEntry = {
      raw: {
        infoHash: '0123456789abcdef0123456789abcdef01234567',
        fileIdx: 2
      },
      description: ''
    };
    sandbox.updateTorrentBridgeEntry(bridgedEntry, {
      ready: true,
      streamUrl: 'http://bridge.example.test:8788/stream/0123456789abcdef0123456789abcdef01234567/2?token=secret',
      playbackUrl: 'http://bridge.example.test:8788/transcode/0123456789abcdef0123456789abcdef01234567/2?token=secret&mode=transcode',
      playback: {
        url: 'http://bridge.example.test:8788/transcode/0123456789abcdef0123456789abcdef01234567/2?token=secret&mode=transcode',
        mode: 'transcode',
        quality: 'high-quality-video-transcode',
        reasons: ['Dolby Vision was detected.']
      }
    });
    assert.strictEqual(bridgedEntry.playable, true);
    assert.strictEqual(bridgedEntry.status, 'Live transcode');
    assert.strictEqual(bridgedEntry.raw.url.indexOf('/transcode/'), 'http://bridge.example.test:8788'.length);
    assert.strictEqual(bridgedEntry.raw.directUrl.indexOf('/stream/'), 'http://bridge.example.test:8788'.length);
    assert.strictEqual(sandbox.isBridgeStreamEntry(bridgedEntry), true);
  } finally {
    sandbox.TORRENT_BRIDGE_BASE_URL = previousBaseUrl;
    sandbox.TORRENT_BRIDGE_TOKEN = previousToken;
  }
}

function testStreamSourceFilterMode() {
  const previousStreams = sandbox.state.streams;
  const previousMode = sandbox.state.streamSourceMode;
  const previousCached = sandbox.state.streamFilterCached;
  const previousBridge = sandbox.state.streamFilterBridge;
  const previousBaseUrl = sandbox.TORRENT_BRIDGE_BASE_URL;
  const previousToken = sandbox.TORRENT_BRIDGE_TOKEN;
  const torrentioStream = {
    title: 'TorrentioRD stream',
    playable: true,
    bridgeable: true,
    addonName: 'Torrentio',
    addonBaseUrl: 'https://torrentio.strem.fun/qualityfilter=cam%7Crealdebrid=secret',
    raw: {
      url: 'https://realdebrid.example.test/movie.mkv',
      infoHash: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd'
    }
  };
  const cometStream = {
    title: 'Comet stream',
    playable: true,
    addonName: 'Comet',
    addonBaseUrl: 'https://comet.elfhosted.com/config',
    raw: { url: 'https://comet.example.test/movie.mp4' }
  };
  const bridgeStream = {
    title: 'Bridge stream',
    playable: false,
    bridgeable: true,
    raw: { infoHash: '0123456789abcdef0123456789abcdef01234567' }
  };

  try {
    sandbox.TORRENT_BRIDGE_BASE_URL = 'http://bridge.example.test:8788';
    sandbox.TORRENT_BRIDGE_TOKEN = 'secret';
    sandbox.state.streams = [torrentioStream, cometStream, bridgeStream];

    sandbox.syncStreamSourceFilterState('torrentio-rd');
    assert.strictEqual(sandbox.state.streamSourceMode, 'torrentio-rd');
    assert.strictEqual(sandbox.state.streamFilterCached, true);
    assert.strictEqual(sandbox.state.streamFilterBridge, false);
    assert.deepStrictEqual(
      sandbox.getVisibleStreams().map((stream) => stream.title),
      ['TorrentioRD stream']
    );
    assert.strictEqual(sandbox.isCachedStreamEntry(torrentioStream), true);
    assert.strictEqual(sandbox.isBridgeStreamEntry(torrentioStream), false);

    sandbox.syncStreamSourceFilterState('comet');
    assert.strictEqual(sandbox.state.streamSourceMode, 'comet');
    assert.deepStrictEqual(
      sandbox.getVisibleStreams().map((stream) => stream.title),
      ['Comet stream']
    );

    sandbox.syncStreamSourceFilterState('bridge');
    assert.strictEqual(sandbox.state.streamSourceMode, 'bridge');
    assert.strictEqual(sandbox.state.streamFilterCached, false);
    assert.strictEqual(sandbox.state.streamFilterBridge, true);
    assert.deepStrictEqual(
      sandbox.getVisibleStreams().map((stream) => stream.title),
      ['Bridge stream']
    );

    sandbox.state.streamSourceMode = null;
    sandbox.state.streamFilterCached = false;
    sandbox.state.streamFilterBridge = true;
    assert.strictEqual(sandbox.getStreamSourceMode(), 'bridge');
    assert.deepStrictEqual(
      sandbox.getVisibleStreams().map((stream) => stream.title),
      ['Bridge stream']
    );

    sandbox.state.streamSourceMode = 'cached';
    sandbox.state.streamFilterCached = true;
    sandbox.state.streamFilterBridge = false;
    assert.strictEqual(sandbox.getStreamSourceMode(), 'torrentio-rd');
  } finally {
    sandbox.state.streams = previousStreams;
    sandbox.state.streamSourceMode = previousMode;
    sandbox.state.streamFilterCached = previousCached;
    sandbox.state.streamFilterBridge = previousBridge;
    sandbox.TORRENT_BRIDGE_BASE_URL = previousBaseUrl;
    sandbox.TORRENT_BRIDGE_TOKEN = previousToken;
  }
}

async function testBrowseRequestVersioning() {
  const previousFetchRatingCombinedBrowse = sandbox.fetchRatingCombinedBrowse;
  const previousUpdateConnectionStatus = sandbox.updateConnectionStatus;
  const previousRenderBrowseViews = sandbox.renderBrowseViews;
  const previousScheduleBrowsePrefetch = sandbox.scheduleBrowsePrefetch;
  const previousMovieGenres = sandbox.state.movieGenres;
  const previousSelectedMovieGenre = sandbox.state.selectedMovieGenre;
  const previousSelectedMovieRating = sandbox.state.selectedMovieRating;
  const previousMovieBrowseItems = sandbox.state.movieBrowseItems;
  const previousMovieBrowseRequestId = sandbox.state.movieBrowseRequestId;
  const ratingOptions = sandbox.getRatingFilterOptionsForRender('movie');
  const ratingEight = ratingOptions.filter((option) => option.label === '8')[0];
  const ratingSeven = ratingOptions.filter((option) => option.label === '7')[0];
  const movieOption = {
    key: 'popular',
    label: 'Popular',
    addon: { transportUrl: 'https://v3-cinemeta.strem.io/manifest.json' },
    type: 'movie',
    catalogId: 'top',
    filterGroup: 'catalog'
  };
  const deferred = [];

  function makeDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });

    return { promise, resolve, reject };
  }

  try {
    sandbox.state.movieGenres = [movieOption];
    sandbox.state.selectedMovieGenre = movieOption.key;
    sandbox.state.selectedMovieRating = ratingEight.key;
    sandbox.state.movieBrowseItems = [];
    sandbox.state.movieBrowseRequestId = 0;
    sandbox.updateConnectionStatus = () => {};
    sandbox.renderBrowseViews = () => {};
    sandbox.scheduleBrowsePrefetch = () => {};
    sandbox.fetchRatingCombinedBrowse = () => {
      const next = makeDeferred();
      deferred.push(next);
      return next.promise;
    };

    const firstRequest = sandbox.fetchBrowseCatalog('movie', false);
    sandbox.state.selectedMovieRating = ratingSeven.key;
    const secondRequest = sandbox.fetchBrowseCatalog('movie', false);

    assert.strictEqual(deferred.length, 2);
    deferred[1].resolve({
      items: [{ id: 'tt-new', name: 'New rating' }],
      nextSkip: 50,
      canLoadMore: false
    });
    await secondRequest;
    assert.strictEqual(sandbox.state.movieBrowseItems[0].id, 'tt-new');

    deferred[0].resolve({
      items: [{ id: 'tt-old', name: 'Old rating' }],
      nextSkip: 50,
      canLoadMore: false
    });
    await firstRequest;
    assert.strictEqual(sandbox.state.movieBrowseItems[0].id, 'tt-new');
  } finally {
    sandbox.fetchRatingCombinedBrowse = previousFetchRatingCombinedBrowse;
    sandbox.updateConnectionStatus = previousUpdateConnectionStatus;
    sandbox.renderBrowseViews = previousRenderBrowseViews;
    sandbox.scheduleBrowsePrefetch = previousScheduleBrowsePrefetch;
    sandbox.state.movieGenres = previousMovieGenres;
    sandbox.state.selectedMovieGenre = previousSelectedMovieGenre;
    sandbox.state.selectedMovieRating = previousSelectedMovieRating;
    sandbox.state.movieBrowseItems = previousMovieBrowseItems;
    sandbox.state.movieBrowseRequestId = previousMovieBrowseRequestId;
  }
}

function testMetadataFormatting() {
  const item = {
    id: 'tt-meta',
    name: 'Metadata Film',
    releaseInfo: '2026',
    imdbRating: '7.8',
    genres: ['Action', 'Adventure', 'Drama'],
    runtime: 124
  };
  const cloned = sandbox.cloneContinueItem(item);

  assert.strictEqual(
    sandbox.formatMetaLine(item, 'Movie'),
    'Movie • 2026 • IMDb 7.8 • Action / Adventure'
  );
  assert.strictEqual(
    sandbox.formatHomeActiveMetaLine(item, 'movie', 'movies'),
    'IMDb 7.8 • Action / Adventure • 2h 4m • 2026'
  );
  sandbox.state.selectedItem = item;
  sandbox.state.selectedType = 'movie';
  assert.strictEqual(
    sandbox.getSelectedItemMetaLine(),
    'IMDb 7.8 • Action / Adventure • 2h 4m • 2026'
  );
  sandbox.state.selectedItem = null;
  sandbox.state.selectedType = null;
  assert.deepStrictEqual(cloned.genres, ['Action', 'Adventure', 'Drama']);
  assert.strictEqual(cloned.runtime, 124);
}

function testImdbApiDetailHelpers() {
  const title = {
    id: 'tt1375666',
    primaryTitle: 'Inception',
    startYear: 2010,
    runtimeSeconds: 8880,
    plot: 'A thief enters dreams.',
    genres: ['Action', 'Adventure', 'Sci-Fi'],
    primaryImage: { url: 'https://image.example/inception.jpg' },
    rating: {
      aggregateRating: 8.8,
      voteCount: 2800000
    }
  };
  const merged = sandbox.mergeImdbApiTitleIntoItem({
    id: 'tt1375666',
    type: 'movie',
    name: 'Inception',
    background: 'https://image.example/backdrop.jpg'
  }, title);
  const cast = sandbox.normalizeImdbApiCast({
    credits: [
      {
        name: {
          id: 'nm1',
          displayName: 'Leonardo DiCaprio',
          primaryImage: { url: 'https://image.example/leo.jpg' }
        },
        category: 'actor',
        characters: ['Cobb']
      },
      {
        name: {
          id: 'nm1',
          displayName: 'Leonardo DiCaprio'
        },
        category: 'actor',
        characters: ['Duplicate']
      },
      {
        name: {
          id: 'nm2',
          displayName: 'Marion Cotillard'
        },
        category: 'actress',
        characters: ['Mal']
      }
    ]
  });
  const starCast = sandbox.normalizeImdbApiTitleStars({
    stars: [
      {
        id: 'nm3',
        displayName: 'Joseph Gordon-Levitt',
        primaryImage: { url: 'https://image.example/jgl.jpg' }
      }
    ]
  });

  assert.strictEqual(merged.poster, 'https://image.example/inception.jpg');
  assert.strictEqual(merged.background, 'https://image.example/backdrop.jpg');
  assert.strictEqual(merged.imdbRating, 8.8);
  assert.strictEqual(merged.imdbVotes, 2800000);
  assert.strictEqual(merged.runtime, 148);
  assert.deepStrictEqual(merged.genres, ['Action', 'Adventure', 'Sci-Fi']);
  assert.strictEqual(cast.length, 2);
  assert.strictEqual(cast[0].image, 'https://image.example/leo.jpg');
  assert.strictEqual(cast[0].role, 'Cobb');
  assert.strictEqual(cast[1].name, 'Marion Cotillard');
  assert.strictEqual(starCast[0].name, 'Joseph Gordon-Levitt');
  assert.strictEqual(starCast[0].image, 'https://image.example/jgl.jpg');
}

async function testBrowseArtworkEnrichment() {
  const previousFetchMeta = sandbox.fetchMetaFromAddons;
  let calls = 0;

  sandbox.browseArtworkMetaCache = {};
  sandbox.browseArtworkMetaPending = {};
  sandbox.fetchMetaFromAddons = (type, id) => {
    calls += 1;
    assert.strictEqual(type, 'movie');
    return Promise.resolve({
      poster: `https://images.example/${id}/poster.jpg`,
      background: `https://images.example/${id}/background.jpg`,
      description: 'Resolved metadata',
      genres: ['Action', 'Drama']
    });
  };

  try {
    const enriched = await sandbox.enrichBrowseItemsWithArtwork('movie', [
      {
        id: 'tt-art',
        name: 'Generated Art',
        poster: 'https://live.metahub.space/poster/small/tt-art/img',
        background: 'https://live.metahub.space/background/medium/tt-art/img',
        imdbRating: 8.5,
        genres: ['Action']
      }
    ]);

    assert.strictEqual(enriched[0].poster, 'https://images.example/tt-art/poster.jpg');
    assert.strictEqual(enriched[0].background, 'https://images.example/tt-art/background.jpg');
    assert.strictEqual(enriched[0].imdbRating, 8.5);
    assert.deepStrictEqual(enriched[0].genres, ['Action']);

    await sandbox.enrichBrowseItemsWithArtwork('movie', [{ id: 'tt-art', name: 'Cached' }]);
    assert.strictEqual(calls, 1);
  } finally {
    sandbox.fetchMetaFromAddons = previousFetchMeta;
    sandbox.browseArtworkMetaCache = {};
    sandbox.browseArtworkMetaPending = {};
  }
}

async function testRatingBrowseStopsOnRateLimit() {
  const previousRequest = sandbox.requestImdbCatalogApiPayload;
  const previousEnrich = sandbox.enrichBrowseItemsWithArtwork;
  let calls = 0;

  sandbox.requestImdbCatalogApiPayload = (type, combined, skip, limit) => {
    calls += 1;
    assert.strictEqual(type, 'movie');
    assert.strictEqual(skip, 0);
    assert.ok(limit >= 5);
    return Promise.resolve({
      metas: Array.from({ length: 5 }, (_, index) => ({
        id: `tt-rate-${index}`,
        name: `Rate Limited ${index}`,
        imdbRating: 8.2,
        genres: ['Action']
      })),
      limit: 5,
      nextSkip: 5,
      hasMore: true,
      rateLimited: true
    });
  };
  sandbox.enrichBrowseItemsWithArtwork = (type, items) => Promise.resolve(items);

  try {
    const result = await sandbox.fetchRatingCombinedBrowse('movie', {
      ratingOption: {
        key: 'rating-8',
        label: '8',
        minRating: 8,
        maxRating: 9
      },
      genreLabel: 'Action'
    }, [], false);

    assert.strictEqual(calls, 1);
    assert.strictEqual(result.canLoadMore, true);
    assert.strictEqual(result.nextSkip, 5);
    assert.strictEqual(result.items.length, 5);
  } finally {
    sandbox.requestImdbCatalogApiPayload = previousRequest;
    sandbox.enrichBrowseItemsWithArtwork = previousEnrich;
  }
}

function testDtsVirtualAudioDetection() {
  const cases = [
    ['Movie DTS-HD MA5.1', 'DTS-HD MA 5.1 (detected, not exposed by TV)'],
    ['Movie DTS-HD MA 5.1', 'DTS-HD MA 5.1 (detected, not exposed by TV)'],
    ['Movie DTS:X 7.1', 'DTS:X 7.1 (detected, not exposed by TV)'],
    ['Movie DTS', 'DTS (detected, not exposed by TV)']
  ];

  cases.forEach(([title, expectedLabel]) => {
    const tracks = sandbox.detectVirtualAudioTracks({ title, raw: {} }, []);
    assert.strictEqual(tracks.length, 1);
    assert.strictEqual(tracks[0].label, expectedLabel);
    assert.strictEqual(tracks[0].virtual, true);
  });

  assert.strictEqual(
    sandbox.detectVirtualAudioTracks({ title: 'Movie AAC 5.1', raw: {} }, []).length,
    0
  );
  assert.strictEqual(
    sandbox.detectVirtualAudioTracks(
      { title: 'Movie DTS-HD MA5.1', raw: {} },
      [{ id: 'audio-0', label: 'ENG • DTS-HD MA 5.1' }]
    ).length,
    0
  );
  assert.strictEqual(
    sandbox.detectVirtualAudioTracks(
      { title: 'Movie DTS-HD MA5.1', raw: {} },
      [{ id: 'audio-0', label: 'English', codec: 'DTS-HD MA' }]
    ).length,
    0
  );

  assert.strictEqual(
    sandbox.detectVirtualAudioTracks(
      { title: 'Movie DTS-HD MA5.1', raw: {} },
      [{ id: 'audio-1', index: 1, label: 'EN', codec: '' }]
    ).length,
    1
  );
}

function testResumeAndTranscodedTimelineHelpers() {
  const savedStream = sandbox.cloneContinueStream({
    addonName: 'Torrentio',
    addonBaseUrl: 'https://addon.example.test',
    playable: true,
    status: 'Playable',
    title: '4K stream',
    description: 'Saved source',
    raw: {
      url: 'https://cdn.example.test/movie.mkv',
      name: '4K',
      behaviorHints: { filename: 'movie.mkv' },
      subtitles: [{ id: 'en', url: 'https://cdn.example.test/en.vtt' }]
    }
  });

  assert.strictEqual(savedStream.raw.url, 'https://cdn.example.test/movie.mkv');
  assert.strictEqual(savedStream.raw.subtitles[0].id, 'en');

  const normalizedEntry = sandbox.normalizeContinueEntry({
    kind: 'movie',
    item: { id: 'tt123', name: 'Movie' },
    video: { id: 'tt123', title: 'Movie' },
    position: 20,
    stream: savedStream
  });

  assert.strictEqual(normalizedEntry.stream.raw.url, savedStream.raw.url);

  sandbox.state.allSeriesVideos = [
    { id: 'show:1:1', season: 1, episode: 1, title: 'Pilot' },
    { id: 'show:2:3', season: 2, episode: 3, title: 'Third' }
  ];
  sandbox.state.pendingResumeStream = savedStream;
  sandbox.state.streams = [
    {
      addonName: 'Different',
      playable: true,
      title: 'Same URL returned',
      raw: { url: savedStream.raw.url }
    }
  ];

  assert.strictEqual(
    sandbox.getResumePositionMsFromEntry({ position: 123 }),
    123000
  );
  assert.strictEqual(
    sandbox.findResumeVideo({ video: { id: 'show:2:3', season: 2, episode: 3 } }).title,
    'Third'
  );
  assert.strictEqual(
    sandbox.findResumeVideo({ video: { season: 1, episode: 1 } }).title,
    'Pilot'
  );
  assert.strictEqual(
    sandbox.getPendingResumeStreamCandidate().title,
    'Same URL returned'
  );

  sandbox.state.streams = [];
  assert.strictEqual(
    sandbox.getPendingResumeStreamCandidate().title,
    '4K stream'
  );

  assert.strictEqual(
    sandbox.applySavedResumeVideoFallback({
      kind: 'series',
      item: { id: 'ttshow', name: 'Show' },
      video: { id: 'ttshow:2:3', season: 2, episode: 3, title: 'Third' }
    }),
    true
  );
  assert.strictEqual(sandbox.state.selectedVideo.id, 'ttshow:2:3');
  assert.strictEqual(sandbox.state.availableSeasons.length, 1);
  assert.strictEqual(sandbox.state.availableSeasons[0], 2);

  sandbox.state.selectedItem = { id: 'ttshow', name: 'Show' };
  sandbox.state.selectedType = 'series';
  sandbox.state.selectedVideo = { id: 'ttshow:1:1', season: 1, episode: 1, title: 'Pilot' };
  sandbox.state.selectedSeason = 1;
  sandbox.state.allSeriesVideos = [sandbox.state.selectedVideo];
  sandbox.state.availableSeasons = [1];
  sandbox.state.selectedEpisodes = [sandbox.state.selectedVideo];
  assert.strictEqual(sandbox.getNextEpisode(), null);
  assert.strictEqual(
    sandbox.applyDirectSeriesResumeMetadata({
      kind: 'series',
      item: { id: 'ttshow', name: 'Show' },
      video: { id: 'ttshow:1:1', season: 1, episode: 1, title: 'Pilot' }
    }, {
      id: 'ttshow',
      name: 'Show',
      videos: [
        { id: 'ttshow:1:1', season: 1, episode: 1, title: 'Pilot' },
        { id: 'ttshow:1:2', season: 1, episode: 2, title: 'Second' },
        { id: 'ttshow:2:1', season: 2, episode: 1, title: 'Premiere' }
      ]
    }),
    true
  );
  assert.strictEqual(sandbox.getNextEpisode().id, 'ttshow:1:2');
  assert.strictEqual(sandbox.state.availableSeasons.length, 2);

  const previousOpenStream = sandbox.openStream;
  let openedStream = null;
  sandbox.openStream = (stream) => {
    openedStream = stream;
  };
  try {
    assert.strictEqual(
      sandbox.resumeContinueEntryDirectly(normalizedEntry),
      true
    );
    assert.strictEqual(openedStream.raw.url, savedStream.raw.url);
    assert.strictEqual(sandbox.state.selectedItem.id, 'tt123');
    assert.strictEqual(sandbox.state.selectedType, 'movie');
    assert.strictEqual(sandbox.state.selectedVideo.id, 'tt123');
    assert.strictEqual(sandbox.state.pendingResumePositionMs, 20000);
  } finally {
    sandbox.openStream = previousOpenStream;
  }

  sandbox.state.transcodedPlaybackActive = true;
  sandbox.state.transcodedSourceUrl = 'https://example.test/movie.mkv';
  sandbox.state.transcodedOffsetMs = 120000;
  sandbox.state.transcodedDurationMs = 5400000;
  sandbox.state.durationMs = 5400000;

  assert.strictEqual(sandbox.getTimelineCurrentMs(30000), 150000);
  assert.strictEqual(sandbox.getTimelineDurationMs(90000), 5400000);

  sandbox.resetTranscodedPlaybackState();
  sandbox.state.allSeriesVideos = [];
  sandbox.state.pendingResumeStream = null;
  sandbox.state.streams = [];
  sandbox.state.durationMs = 0;
}

(async () => {
  const tests = [
    testSubtitleParsing,
    testContinueDedupe,
    testWatchedEpisodeTracking,
    testCatalogSelectionAndUrls,
    testBrowsePaging,
    testBrowseGenreFiltering,
    testYearFilterDefaultAll,
    testImdbRatingFilter,
    testBlockbusterCatalogOption,
    testDetailTrailerHelpers,
    testTorrentBridgeHelpers,
    testStreamSourceFilterMode,
    testBrowseRequestVersioning,
    testMetadataFormatting,
    testImdbApiDetailHelpers,
    testBrowseArtworkEnrichment,
    testRatingBrowseStopsOnRateLimit,
    testDtsVirtualAudioDetection,
    testResumeAndTranscodedTimelineHelpers
  ];

  for (const testFn of tests) {
    await testFn();
  }

  console.log('pure tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
