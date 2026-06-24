#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const readline = require('readline');
const childProcess = require('child_process');
const os = require('os');
const zlib = require('zlib');

const port = Number(process.env.PORT || 8791);
const host = process.env.HOST || '0.0.0.0';
const dataDir = process.env.IMDB_DATA_DIR || path.join(__dirname, '..', '.cache', 'imdb');
const cacheVersion = 4;
const minVotes = Number(process.env.IMDB_MIN_VOTES || 10000);
const weightedVoteAnchor = Number(process.env.IMDB_WEIGHTED_VOTE_ANCHOR || 25000);
const weightedMeanRating = Number(process.env.IMDB_WEIGHTED_MEAN_RATING || 6.8);
const imdbApiBaseUrl = (process.env.IMDB_API_BASE_URL || 'https://api.imdbapi.dev').replace(/\/+$/, '');
const imdbApiExcludedCountryCodes = parseCsvSet(process.env.IMDB_API_EXCLUDED_COUNTRY_CODES || 'IN');
const imdbApiBatchConcurrency = Math.max(1, Number(process.env.IMDB_API_BATCH_CONCURRENCY || 1) || 1);
const enrichArtwork = process.env.IMDB_ENRICH_ARTWORK === '1';
const maxResults = Number(process.env.IMDB_MAX_RESULTS || 250);
const tmdbApiBaseUrl = (process.env.TMDB_API_BASE_URL || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
const tmdbImageBaseUrl = (process.env.TMDB_IMAGE_BASE_URL || 'https://image.tmdb.org/t/p').replace(/\/+$/, '');
const tmdbReadAccessToken = process.env.TMDB_READ_ACCESS_TOKEN || process.env.TMDB_V4_READ_ACCESS_TOKEN || '';
const tmdbApiKey = process.env.TMDB_API_KEY || '';
const tmdbCacheTtlMs = Math.max(60 * 60 * 1000, Number(process.env.TMDB_CACHE_TTL_MS || 24 * 60 * 60 * 1000) || 24 * 60 * 60 * 1000);
const tmdbBlockbusterMinVotes = Math.max(0, Number(process.env.TMDB_BLOCKBUSTER_MIN_VOTES || 500) || 500);
const basicsUrl = process.env.IMDB_BASICS_URL || 'https://datasets.imdbws.com/title.basics.tsv.gz';
const ratingsUrl = process.env.IMDB_RATINGS_URL || 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const cinemetaBaseUrl = (process.env.CINEMETA_META_BASE_URL || 'https://v3-cinemeta.strem.io').replace(/\/+$/, '');
const indexPath = path.join(dataDir, 'catalog-index.json');
const artworkPath = path.join(dataDir, 'catalog-artwork.json');
const imdbApiTitleCachePath = path.join(dataDir, 'imdbapi-title-cache.json');
const tmdbCachePath = path.join(dataDir, 'tmdb-cache.json');
const basicsPath = path.join(dataDir, 'title.basics.tsv.gz');
const ratingsPath = path.join(dataDir, 'title.ratings.tsv.gz');
const homeYtDlpPython = path.join(os.homedir(), '.cache', 'nuvio-yt-dlp-venv', 'bin', 'python');
const ytDlpPython = process.env.YT_DLP_PYTHON || (fs.existsSync(homeYtDlpPython) ? homeYtDlpPython : 'python3');
const trailerStreamCacheTtlMs = Math.max(60 * 1000, Number(process.env.TRAILER_STREAM_CACHE_TTL_MS || 10 * 60 * 1000) || 10 * 60 * 1000);
const trailerMaxHeight = Math.max(0, Number(process.env.TRAILER_MAX_HEIGHT || 0) || 0);

let catalogIndexPromise = null;
let artworkCachePromise = null;
let imdbApiTitleCachePromise = null;
let tmdbCachePromise = null;
const trailerStreamCache = {};

const tmdbMovieGenreIds = {
  Action: 28,
  Adventure: 12,
  Animation: 16,
  Comedy: 35,
  Crime: 80,
  Documentary: 99,
  Drama: 18,
  Family: 10751,
  Fantasy: 14,
  History: 36,
  Horror: 27,
  Mystery: 9648,
  Romance: 10749,
  'Sci-Fi': 878,
  'Science Fiction': 878,
  Thriller: 53,
  War: 10752,
  Western: 37
};
const tmdbMovieGenreNamesById = Object.keys(tmdbMovieGenreIds).reduce((output, name) => {
  output[String(tmdbMovieGenreIds[name])] = name === 'Science Fiction' ? 'Sci-Fi' : name;
  return output;
}, {});

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character];
  });
}

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function downloadFile(url, targetPath) {
  return new Promise((resolve, reject) => {
    const target = fs.createWriteStream(targetPath);

    function request(nextUrl) {
      const client = nextUrl.startsWith('http://') ? http : https;

      client.get(nextUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          request(new URL(response.headers.location, nextUrl).toString());
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed for ${nextUrl}: HTTP ${response.statusCode}`));
          return;
        }

        response.pipe(target);
      }).on('error', reject);
    }

    target.on('finish', () => target.close(resolve));
    target.on('error', reject);
    request(url);
  });
}

async function ensureFile(url, targetPath) {
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
    return;
  }

  console.log(`Downloading ${url}`);
  await downloadFile(url, targetPath);
}

function parseTsvLine(line) {
  return line.split('\t').map((value) => value === '\\N' ? '' : value);
}

function parseCsvSet(value) {
  const set = new Set();

  String(value || '').split(',').forEach((item) => {
    const normalized = String(item || '').trim().toLowerCase();

    if (normalized) {
      set.add(normalized);
    }
  });

  return set;
}

function getSetKey(set) {
  return Array.from(set || []).sort().join(',');
}

function normalizeGenre(value) {
  return String(value || '').trim();
}

function normalizeType(type) {
  return type === 'series' ? 'series' : 'movie';
}

function titleTypeMatches(type, titleType) {
  return type === 'series'
    ? titleType === 'tvSeries' || titleType === 'tvMiniSeries'
    : titleType === 'movie';
}

function getDefaultPosterUrl(entry) {
  return `https://images.metahub.space/poster/small/${entry.id}/img`;
}

function getDefaultBackgroundUrl(entry) {
  return `https://images.metahub.space/background/medium/${entry.id}/img`;
}

function getDefaultLogoUrl(entry) {
  return `https://images.metahub.space/logo/medium/${entry.id}/img`;
}

function getWeightedRatingScore(rating, votes) {
  const voteCount = Number(votes || 0);
  const averageRating = Number(rating || 0);
  const anchor = weightedVoteAnchor > 0 ? weightedVoteAnchor : 1;

  return (voteCount / (voteCount + anchor)) * averageRating
    + (anchor / (voteCount + anchor)) * weightedMeanRating;
}

function getImdbApiImageUrl(image) {
  return image && image.url ? image.url : '';
}

function getPreviewImageUrl(url) {
  const value = String(url || '');

  if (!value) {
    return '';
  }

  if (/m\.media-amazon\.com\/images\//i.test(value)) {
    return value.replace(/(\._V1)(?:_[^.]*)?(\.[a-z0-9]+)(\?.*)?$/i, `$1_SX185$2$3`);
  }

  if (/image\.tmdb\.org\/t\/p\/w\d+\//i.test(value)) {
    return value.replace(/\/w\d+\//i, '/w185/');
  }

  return value;
}

function getImdbApiBackgroundUrl(title) {
  return getImdbApiImageUrl(title && title.primaryImage);
}

function getImdbApiRuntimeMinutes(title) {
  return title && title.runtimeSeconds ? Math.round(Number(title.runtimeSeconds) / 60) : null;
}

function getImdbApiRating(title) {
  return title && title.rating && typeof title.rating.aggregateRating === 'number'
    ? Number(title.rating.aggregateRating.toFixed(1))
    : null;
}

function getImdbApiVoteCount(title) {
  return title && title.rating && typeof title.rating.voteCount === 'number'
    ? title.rating.voteCount
    : null;
}

function titleHasExcludedCountry(title) {
  return Array.isArray(title && title.originCountries) && title.originCountries.some((country) => {
    return imdbApiExcludedCountryCodes.has(String(country && country.code || '').trim().toLowerCase());
  });
}

function getImdbApiGenres(title, fallbackEntry) {
  if (Array.isArray(title && title.genres) && title.genres.length) {
    return title.genres.map(normalizeGenre).filter(Boolean);
  }

  return Array.isArray(fallbackEntry && fallbackEntry.genres) ? fallbackEntry.genres : [];
}

function toMeta(entry, artwork) {
  const art = artwork || {};

  return {
    id: entry.id,
    imdb_id: entry.id,
    type: entry.type,
    name: entry.name,
    poster: art.poster || getDefaultPosterUrl(entry),
    posterPreview: getPreviewImageUrl(art.poster) || art.poster || getDefaultPosterUrl(entry),
    background: art.background || getDefaultBackgroundUrl(entry),
    logo: art.logo || getDefaultLogoUrl(entry),
    description: art.description || '',
    releaseInfo: entry.releaseInfo,
    year: entry.year,
    imdbRating: entry.imdbRating,
    imdbVotes: entry.votes,
    imdbScore: entry.imdbScore,
    runtime: entry.runtime,
    genres: entry.genres,
    genre: entry.genres
  };
}

function imdbApiTitleToMeta(title, fallbackEntry) {
  const entry = fallbackEntry || {};
  const rating = getImdbApiRating(title);
  const votes = getImdbApiVoteCount(title);
  const poster = getImdbApiImageUrl(title && title.primaryImage);
  const posterPreview = getPreviewImageUrl(poster);
  const background = getImdbApiBackgroundUrl(title);
  const year = title && title.startYear ? String(title.startYear) : entry.year;
  const genres = getImdbApiGenres(title, entry);

  return {
    id: title && title.id || entry.id,
    imdb_id: title && title.id || entry.id,
    type: entry.type,
    name: title && title.primaryTitle || entry.name,
    poster: poster || getDefaultPosterUrl(entry),
    posterPreview: posterPreview || poster || getDefaultPosterUrl(entry),
    background: background || poster || getDefaultBackgroundUrl(entry),
    logo: entry.logo || getDefaultLogoUrl(entry),
    description: title && title.plot || '',
    releaseInfo: year,
    year: year,
    imdbRating: rating || entry.imdbRating,
    imdbVotes: votes || entry.votes,
    imdbScore: entry.imdbScore,
    runtime: getImdbApiRuntimeMinutes(title) || entry.runtime,
    genres: genres,
    genre: genres
  };
}

function readJsonFile(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (error) {
    console.warn(`Ignoring invalid cache ${filePath}: ${error.message}`);
  }

  return fallback;
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJsonUrl(url, options = {}, redirectCount = 0, attempt = 0) {
  const headers = options && options.headers ? options.headers : {};

  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https;
    const req = client.get(url, { headers: headers }, (response) => {
      let body = '';

      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirectCount < 5) {
        response.resume();
        requestJsonUrl(new URL(response.headers.location, url).toString(), options, redirectCount + 1).then(resolve, reject);
        return;
      }

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          if (response.statusCode === 429 && attempt < 3) {
            delay(750 * (attempt + 1)).then(() => {
              requestJsonUrl(url, options, redirectCount, attempt + 1).then(resolve, reject);
            });
            return;
          }

          const error = new Error(`HTTP ${response.statusCode}`);
          error.status = response.statusCode;
          error.body = body;
          reject(error);
          return;
        }

        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.setTimeout(10000, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', reject);
  });
}

async function getArtworkCache() {
  if (!artworkCachePromise) {
    artworkCachePromise = Promise.resolve(readJsonFile(artworkPath, {}));
  }

  return artworkCachePromise;
}

async function getImdbApiTitleCache() {
  if (!imdbApiTitleCachePromise) {
    imdbApiTitleCachePromise = Promise.resolve(readJsonFile(imdbApiTitleCachePath, {}));
  }

  return imdbApiTitleCachePromise;
}

async function getTmdbCache() {
  ensureDataDir();
  if (!tmdbCachePromise) {
    tmdbCachePromise = Promise.resolve(readJsonFile(tmdbCachePath, {
      discover: {},
      movies: {},
      tv: {},
      find: {}
    }));
  }

  return tmdbCachePromise;
}

function writeTmdbCache(cache) {
  writeJsonFile(tmdbCachePath, cache || {});
}

function hasTmdbCredentials() {
  return !!(tmdbReadAccessToken || tmdbApiKey);
}

function isFreshCacheEntry(entry) {
  return !!(entry && entry.cachedAt && Date.now() - entry.cachedAt < tmdbCacheTtlMs);
}

function tmdbImageUrl(pathValue, size) {
  return pathValue ? `${tmdbImageBaseUrl}/${size || 'w500'}${pathValue}` : '';
}

function tmdbGenreIdForLabel(label) {
  const normalized = String(label || '').trim().toLowerCase();
  const key = Object.keys(tmdbMovieGenreIds).filter((name) => {
    return name.toLowerCase() === normalized;
  })[0];

  return key ? tmdbMovieGenreIds[key] : null;
}

async function requestTmdbJson(pathname, params = {}) {
  const url = new URL(pathname.charAt(0) === '/' ? tmdbApiBaseUrl + pathname : pathname);
  const headers = {};

  if (!hasTmdbCredentials()) {
    throw new Error('TMDb credentials are not configured');
  }

  Object.keys(params || {}).forEach((key) => {
    if (params[key] !== null && typeof params[key] !== 'undefined' && params[key] !== '') {
      url.searchParams.set(key, String(params[key]));
    }
  });

  if (tmdbReadAccessToken) {
    headers.Authorization = `Bearer ${tmdbReadAccessToken}`;
  } else if (tmdbApiKey) {
    url.searchParams.set('api_key', tmdbApiKey);
  }

  return requestJsonUrl(url.toString(), { headers: headers });
}

async function getTmdbDiscoverPage(params) {
  const cache = await getTmdbCache();
  const key = JSON.stringify(params || {});
  const cached = cache.discover && cache.discover[key];

  if (isFreshCacheEntry(cached)) {
    return cached.payload;
  }

  const payload = await requestTmdbJson('/discover/movie', params);
  cache.discover = cache.discover || {};
  cache.discover[key] = {
    cachedAt: Date.now(),
    payload: payload
  };
  writeTmdbCache(cache);
  return payload;
}

async function getTmdbMovieDetails(tmdbId) {
  const cache = await getTmdbCache();
  const key = String(tmdbId || '');
  const cached = cache.movies && cache.movies[key];

  if (!key) {
    return null;
  }
  if (isFreshCacheEntry(cached)) {
    return cached.payload;
  }

  const payload = await requestTmdbJson(`/movie/${encodeURIComponent(key)}`, {
    append_to_response: 'external_ids,videos',
    language: 'en-US'
  });
  cache.movies = cache.movies || {};
  cache.movies[key] = {
    cachedAt: Date.now(),
    payload: payload
  };
  writeTmdbCache(cache);
  return payload;
}

async function getTmdbSeriesDetails(tmdbId) {
  const cache = await getTmdbCache();
  const key = String(tmdbId || '');
  const cached = cache.tv && cache.tv[key];

  if (!key) {
    return null;
  }
  if (isFreshCacheEntry(cached)) {
    return cached.payload;
  }

  const payload = await requestTmdbJson(`/tv/${encodeURIComponent(key)}`, {
    append_to_response: 'external_ids,videos',
    language: 'en-US'
  });
  cache.tv = cache.tv || {};
  cache.tv[key] = {
    cachedAt: Date.now(),
    payload: payload
  };
  writeTmdbCache(cache);
  return payload;
}

async function findTmdbMovieByImdbId(imdbId) {
  const cache = await getTmdbCache();
  const key = String(imdbId || '');
  const cached = cache.find && cache.find[key];

  if (!key) {
    return null;
  }
  if (isFreshCacheEntry(cached)) {
    return cached.payload;
  }

  const payload = await requestTmdbJson(`/find/${encodeURIComponent(key)}`, {
    external_source: 'imdb_id',
    language: 'en-US'
  });
  const movie = payload && Array.isArray(payload.movie_results) && payload.movie_results.length
    ? payload.movie_results[0]
    : null;

  cache.find = cache.find || {};
  cache.find[key] = {
    cachedAt: Date.now(),
    payload: movie
  };
  writeTmdbCache(cache);
  return movie;
}

async function findTmdbSeriesByImdbId(imdbId) {
  const cache = await getTmdbCache();
  const key = `series:${String(imdbId || '')}`;
  const cached = cache.find && cache.find[key];

  if (!imdbId) {
    return null;
  }
  if (isFreshCacheEntry(cached)) {
    return cached.payload;
  }

  const payload = await requestTmdbJson(`/find/${encodeURIComponent(String(imdbId))}`, {
    external_source: 'imdb_id',
    language: 'en-US'
  });
  const series = payload && Array.isArray(payload.tv_results) && payload.tv_results.length
    ? payload.tv_results[0]
    : null;

  cache.find = cache.find || {};
  cache.find[key] = {
    cachedAt: Date.now(),
    payload: series
  };
  writeTmdbCache(cache);
  return series;
}

function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array((items || []).length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  return Promise.all(Array.from({
    length: Math.min(Math.max(1, concurrency || 1), items.length)
  }, worker)).then(() => results);
}

function getIndexEntry(index, type, id) {
  return ((index && index[type]) || []).find((entry) => entry && entry.id === id) || null;
}

function getTmdbMovieGenres(movie, details) {
  if (Array.isArray(details && details.genres) && details.genres.length) {
    return details.genres.map((genre) => normalizeGenre(genre && genre.name)).filter(Boolean);
  }

  return (Array.isArray(movie && movie.genre_ids) ? movie.genre_ids : []).map((genreId) => {
    return tmdbMovieGenreNamesById[String(genreId)] || '';
  }).filter(Boolean);
}

function chooseTmdbTrailer(videosPayload) {
  const videos = Array.isArray(videosPayload && videosPayload.results) ? videosPayload.results : [];
  const youtubeVideos = videos.filter((video) => {
    return video
      && String(video.site || '').toLowerCase() === 'youtube'
      && video.key;
  });
  const preferred = youtubeVideos.find((video) => {
    return String(video.type || '').toLowerCase() === 'trailer'
      && (video.official || /official/i.test(video.name || ''));
  }) || youtubeVideos.find((video) => {
    return String(video.type || '').toLowerCase() === 'trailer';
  }) || youtubeVideos[0];

  if (!preferred) {
    return null;
  }

  return {
    site: preferred.site || 'YouTube',
    key: preferred.key,
    name: preferred.name || 'Trailer',
    type: preferred.type || '',
    official: !!preferred.official,
    url: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(preferred.key)}?enablejsapi=1&playsinline=1&rel=0&modestbranding=1&controls=0`,
    webUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(preferred.key)}`
  };
}

function buildYoutubeTrailer(key, name, type) {
  if (!key) {
    return null;
  }

  return {
    site: 'YouTube',
    key: String(key),
    name: name || 'Trailer',
    type: type || 'Trailer',
    official: false,
    url: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(String(key))}?enablejsapi=1&playsinline=1&rel=0&modestbranding=1&controls=0`,
    webUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(String(key))}`
  };
}

function chooseCinemetaTrailer(meta) {
  const trailerStreams = Array.isArray(meta && meta.trailerStreams) ? meta.trailerStreams : [];
  const trailers = Array.isArray(meta && meta.trailers) ? meta.trailers : [];
  const streamTrailer = trailerStreams.find((trailer) => trailer && trailer.ytId);
  const trailer = trailers.find((item) => item && item.source);

  if (streamTrailer) {
    return buildYoutubeTrailer(streamTrailer.ytId, streamTrailer.title || meta && meta.name || 'Trailer', 'Trailer');
  }
  if (trailer) {
    return buildYoutubeTrailer(trailer.source, meta && meta.name || 'Trailer', trailer.type || 'Trailer');
  }

  return null;
}

async function getCinemetaTrailerForImdbId(type, id) {
  const payload = await requestJsonUrl(`${cinemetaBaseUrl}/meta/${encodeURIComponent(normalizeType(type))}/${encodeURIComponent(id)}.json`);
  const meta = payload && payload.meta ? payload.meta : payload;

  return chooseCinemetaTrailer(meta);
}

function tmdbTitleHasExcludedCountry(details) {
  const countries = [];

  (Array.isArray(details && details.production_countries) ? details.production_countries : []).forEach((country) => {
    if (country && country.iso_3166_1) {
      countries.push(country.iso_3166_1);
    }
  });
  (Array.isArray(details && details.origin_country) ? details.origin_country : []).forEach((country) => {
    countries.push(country);
  });

  return countries.some((country) => imdbApiExcludedCountryCodes.has(String(country || '').trim().toLowerCase()));
}

function normalizeTmdbMovieToMeta(movie, details, indexEntry) {
  const imdbId = details && details.external_ids && details.external_ids.imdb_id || '';
  const entry = indexEntry || {
    id: imdbId,
    type: 'movie',
    name: details && details.title || movie && movie.title || '',
    year: '',
    releaseInfo: '',
    genres: []
  };
  const releaseDate = details && details.release_date || movie && movie.release_date || '';
  const year = releaseDate ? String(releaseDate).slice(0, 4) : entry.year || '';
  const poster = tmdbImageUrl(details && details.poster_path || movie && movie.poster_path, 'w342');
  const posterPreview = tmdbImageUrl(details && details.poster_path || movie && movie.poster_path, 'w185');
  const background = tmdbImageUrl(details && details.backdrop_path || movie && movie.backdrop_path, 'w1280');
  const genres = getTmdbMovieGenres(movie, details);

  if (!imdbId) {
    return null;
  }

  return {
    id: imdbId,
    imdb_id: imdbId,
    type: 'movie',
    name: details && details.title || movie && movie.title || entry.name,
    poster: poster || getDefaultPosterUrl(entry),
    posterPreview: posterPreview || poster || getDefaultPosterUrl(entry),
    background: background || poster || getDefaultBackgroundUrl(entry),
    logo: getDefaultLogoUrl(entry),
    description: details && details.overview || movie && movie.overview || '',
    releaseInfo: year,
    year: year,
    imdbRating: entry.imdbRating || Number(Number(movie && movie.vote_average || 0).toFixed(1)) || null,
    imdbVotes: entry.votes || movie && movie.vote_count || null,
    imdbScore: entry.imdbScore || null,
    runtime: details && details.runtime || entry.runtime || null,
    genres: genres.length ? genres : entry.genres || [],
    genre: genres.length ? genres : entry.genres || [],
    trailer: chooseTmdbTrailer(details && details.videos),
    tmdbId: movie && movie.id || details && details.id || null,
    tmdbRevenue: details && details.revenue || 0,
    tmdbPopularity: movie && movie.popularity || details && details.popularity || 0,
    source: 'tmdb-revenue'
  };
}

async function getTmdbTrailerForImdbId(type, id) {
  let title;
  let details;

  if (!hasTmdbCredentials() || !id) {
    return null;
  }

  if (normalizeType(type) === 'series') {
    title = await findTmdbSeriesByImdbId(id);
    details = title && title.id ? await getTmdbSeriesDetails(title.id) : null;
  } else {
    title = await findTmdbMovieByImdbId(id);
    details = title && title.id ? await getTmdbMovieDetails(title.id) : null;
  }

  return chooseTmdbTrailer(details && details.videos);
}

async function getTrailerForImdbId(type, id) {
  let trailer = null;

  if (hasTmdbCredentials()) {
    try {
      trailer = await getTmdbTrailerForImdbId(type, id);
    } catch (error) {
      trailer = null;
    }
  }
  if (trailer) {
    return trailer;
  }

  try {
    return await getCinemetaTrailerForImdbId(type, id);
  } catch (error) {
    return null;
  }
}

async function getFallbackBlockbusterCatalog(index, skip, limit, filters) {
  const filtered = (index.movie || []).filter((item) => {
    return itemMatchesRating(item, filters && filters.rating)
      && itemMatchesGenre(item, filters && filters.genre)
      && itemMatchesYear(item, filters && filters.year);
  }).sort((left, right) => {
    if (right.votes !== left.votes) return right.votes - left.votes;
    if (right.imdbScore !== left.imdbScore) return right.imdbScore - left.imdbScore;
    if (right.imdbRating !== left.imdbRating) return right.imdbRating - left.imdbRating;
    return String(left.name).localeCompare(String(right.name));
  });
  const page = await getPagedCatalogEntries('movie', filtered, skip, limit, filters || {});

  return {
    metas: page.items.map((item) => item.meta || imdbApiTitleToMeta(item.apiTitle, item.entry)),
    hasMore: page.hasMore,
    limit: page.scanned,
    nextSkip: page.nextSkip,
    rateLimited: page.rateLimited,
    total: filtered.length,
    source: 'imdb-datasets-votes-fallback'
  };
}

async function getTmdbBlockbusterCatalog(index, skip, limit, filters) {
  const metas = [];
  let consumed = 0;
  let pageNumber = Math.floor(skip / 20) + 1;
  let pageOffset = skip % 20;
  let totalResults = null;
  let totalPages = null;
  let rateLimited = false;

  while (metas.length < limit && pageNumber <= 500) {
    const params = {
      sort_by: 'revenue.desc',
      include_adult: 'false',
      include_video: 'false',
      language: 'en-US',
      page: pageNumber,
      'vote_count.gte': tmdbBlockbusterMinVotes
    };
    const genreId = tmdbGenreIdForLabel(filters && filters.genre);
    let payload;
    let candidates;

    if (filters && filters.year) {
      params.primary_release_year = filters.year;
    }
    if (genreId) {
      params.with_genres = genreId;
    }

    try {
      payload = await getTmdbDiscoverPage(params);
    } catch (error) {
      if (error && error.status === 429) {
        rateLimited = true;
      }
      throw error;
    }

    candidates = (Array.isArray(payload && payload.results) ? payload.results : []).slice(pageOffset);
    totalResults = typeof payload.total_results === 'number' ? payload.total_results : totalResults;
    totalPages = typeof payload.total_pages === 'number' ? Math.min(payload.total_pages, 500) : totalPages;
    if (!candidates.length) {
      break;
    }

    await mapWithConcurrency(candidates, 4, async (movie) => {
      let details;
      let meta;
      let entry;

      if (metas.length >= limit) {
        return;
      }

      consumed += 1;
      try {
        details = await getTmdbMovieDetails(movie && movie.id);
      } catch (error) {
        return;
      }
      if (!details || tmdbTitleHasExcludedCountry(details)) {
        return;
      }

      entry = getIndexEntry(index, 'movie', details.external_ids && details.external_ids.imdb_id);
      meta = normalizeTmdbMovieToMeta(movie, details, entry);
      if (!meta) {
        return;
      }
      if (
        !itemMatchesRating(meta, filters && filters.rating)
        || !itemMatchesGenre(meta, filters && filters.genre)
        || !itemMatchesYear(meta, filters && filters.year)
      ) {
        return;
      }

      metas.push(meta);
    });

    pageOffset = 0;
    if (metas.length >= limit || totalPages && pageNumber >= totalPages) {
      break;
    }
    pageNumber += 1;
  }

  return {
    metas: metas.slice(0, limit),
    hasMore: totalPages ? pageNumber < totalPages || metas.length >= limit : false,
    limit: consumed,
    nextSkip: skip + consumed,
    rateLimited: rateLimited,
    total: totalResults,
    source: 'tmdb-revenue'
  };
}

async function getBlockbusterCatalog(index, skip, limit, filters) {
  if (!hasTmdbCredentials()) {
    return getFallbackBlockbusterCatalog(index, skip, limit, filters);
  }

  try {
    return await getTmdbBlockbusterCatalog(index, skip, limit, filters);
  } catch (error) {
    console.warn(`TMDb blockbuster catalog failed, falling back to IMDb votes: ${error.message}`);
    return getFallbackBlockbusterCatalog(index, skip, limit, filters);
  }
}

async function fetchImdbApiTitleBatch(ids) {
  const uniqueIds = Array.from(new Set((ids || []).filter(Boolean))).slice(0, 5);

  if (!uniqueIds.length) {
    return {};
  }

  const url = imdbApiBaseUrl + '/titles:batchGet?' + uniqueIds.map((id) => {
    return 'titleIds=' + encodeURIComponent(id);
  }).join('&');
  const payload = await requestJsonUrl(url);
  const titles = Array.isArray(payload && payload.titles) ? payload.titles : [];
  const byId = {};

  titles.forEach((title) => {
    if (title && title.id) {
      byId[title.id] = title;
    }
  });

  return byId;
}

async function getImdbApiTitles(entries) {
  const cache = await getImdbApiTitleCache();
  const output = {};
  const missing = [];
  const chunks = [];
  let changed = false;

  (entries || []).forEach((entry) => {
    if (!entry || !entry.id) {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(cache, entry.id)) {
      output[entry.id] = cache[entry.id];
      return;
    }
    missing.push(entry.id);
  });

  for (let index = 0; index < missing.length; index += 5) {
    chunks.push(missing.slice(index, index + 5));
  }

  async function worker() {
    while (chunks.length) {
      const chunk = chunks.shift();
      let fetched;

      try {
        fetched = await fetchImdbApiTitleBatch(chunk);
      } catch (error) {
        if (error && error.status === 429) {
          output.__rateLimited = true;
          chunks.length = 0;
          return;
        }
        throw error;
      }

      chunk.forEach((id) => {
        cache[id] = fetched[id] || null;
        output[id] = cache[id];
        changed = true;
      });
    }
  }

  if (chunks.length) {
    await Promise.all(Array.from({ length: Math.min(imdbApiBatchConcurrency, chunks.length) }, worker));
  }

  if (changed) {
    writeJsonFile(imdbApiTitleCachePath, cache);
  }

  return output;
}

async function getImdbApiTitleById(id) {
  const key = String(id || '');

  if (!key) {
    return null;
  }

  const titles = await getImdbApiTitles([{ id: key }]);
  return Object.prototype.hasOwnProperty.call(titles, key) ? titles[key] : null;
}

async function fetchCinemetaArtwork(type, id) {
  const payload = await requestJsonUrl(`${cinemetaBaseUrl}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
  const meta = payload && payload.meta ? payload.meta : payload;

  if (!meta || !Object.keys(meta).length) {
    return {
      poster: '',
      background: '',
      logo: '',
      description: '',
      country: ''
    };
  }

  return {
    poster: meta.poster || '',
    background: meta.background || meta.poster || '',
    logo: meta.logo || '',
    description: meta.description || '',
    country: meta.country || ''
  };
}

async function getCachedCinemetaArtwork(type, id) {
  const cache = await getArtworkCache();
  const key = `${type}:${id}`;
  let artwork = cache[key];

  if (artwork) {
    return artwork;
  }

  try {
    artwork = await fetchCinemetaArtwork(type, id);
  } catch (error) {
    artwork = {
      poster: '',
      background: '',
      logo: '',
      description: '',
      country: ''
    };
  }

  artwork.checkedAt = new Date().toISOString();
  cache[key] = artwork;
  writeJsonFile(artworkPath, cache);
  return artwork;
}

async function enrichMetasWithArtwork(type, entries) {
  const metas = new Array(entries.length);
  let cursor = 0;

  async function worker() {
    while (cursor < entries.length) {
      const index = cursor;
      const entry = entries[index];

      cursor += 1;
      metas[index] = toMeta(entry, await getCachedCinemetaArtwork(type, entry.id));
    }
  }

  await Promise.all(Array.from({ length: Math.min(6, entries.length) }, worker));
  return metas;
}

async function readRatings() {
  const ratings = new Map();
  const stream = fs.createReadStream(ratingsPath).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let first = true;

  for await (const line of rl) {
    let parts;
    let rating;
    let votes;

    if (first) {
      first = false;
      continue;
    }
    if (!line) {
      continue;
    }

    parts = parseTsvLine(line);
    rating = Number(parts[1] || 0);
    votes = Number(parts[2] || 0);
    if (!parts[0] || !rating || votes < minVotes) {
      continue;
    }

    ratings.set(parts[0], {
      rating: rating,
      votes: votes
    });
  }

  return ratings;
}

async function buildIndex() {
  const ratings = await readRatings();
  const index = {
    cacheVersion: cacheVersion,
    generatedAt: new Date().toISOString(),
    minVotes: minVotes,
    weightedVoteAnchor: weightedVoteAnchor,
    weightedMeanRating: weightedMeanRating,
    imdbApiBaseUrl: imdbApiBaseUrl,
    imdbApiExcludedCountryCodes: getSetKey(imdbApiExcludedCountryCodes),
    movie: [],
    series: []
  };
  const stream = fs.createReadStream(basicsPath).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let first = true;

  for await (const line of rl) {
    let parts;
    let rating;
    let titleType;
    let type;
    let genres;
    let year;
    let runtime;

    if (first) {
      first = false;
      continue;
    }
    if (!line) {
      continue;
    }

    parts = parseTsvLine(line);
    rating = ratings.get(parts[0]);
    titleType = parts[1];
    if (!rating || parts[4] === '1') {
      continue;
    }

    if (titleTypeMatches('movie', titleType)) {
      type = 'movie';
    } else if (titleTypeMatches('series', titleType)) {
      type = 'series';
    } else {
      continue;
    }

    genres = (parts[8] || '').split(',').map(normalizeGenre).filter(Boolean);
    year = parts[5] || '';
    runtime = Number(parts[7] || 0) || null;
    index[type].push({
      id: parts[0],
      type: type,
      name: parts[2] || parts[3] || parts[0],
      year: year,
      releaseInfo: type === 'series' && parts[6] ? `${year}-${parts[6]}` : year,
      runtime: runtime,
      genres: genres,
      imdbRating: Number(rating.rating.toFixed(1)),
      imdbScore: Number(getWeightedRatingScore(rating.rating, rating.votes).toFixed(4)),
      votes: rating.votes
    });
  }

  ['movie', 'series'].forEach((type) => {
    index[type].sort((left, right) => {
      if (right.imdbScore !== left.imdbScore) return right.imdbScore - left.imdbScore;
      if (right.imdbRating !== left.imdbRating) return right.imdbRating - left.imdbRating;
      if (right.votes !== left.votes) return right.votes - left.votes;
      return String(left.name).localeCompare(String(right.name));
    });
  });

  fs.writeFileSync(indexPath, JSON.stringify(index));
  return index;
}

async function getCatalogIndex() {
  if (!catalogIndexPromise) {
    catalogIndexPromise = (async () => {
      let cachedIndex;

      ensureDataDir();
      if (fs.existsSync(indexPath)) {
        cachedIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        if (
          cachedIndex.cacheVersion === cacheVersion
          && cachedIndex.minVotes === minVotes
          && cachedIndex.weightedVoteAnchor === weightedVoteAnchor
          && cachedIndex.weightedMeanRating === weightedMeanRating
          && cachedIndex.imdbApiBaseUrl === imdbApiBaseUrl
          && cachedIndex.imdbApiExcludedCountryCodes === getSetKey(imdbApiExcludedCountryCodes)
        ) {
          return cachedIndex;
        }

        console.log('IMDb cache settings changed, rebuilding catalog index');
      }

      await ensureFile(basicsUrl, basicsPath);
      await ensureFile(ratingsUrl, ratingsPath);
      return buildIndex();
    })();
  }

  return catalogIndexPromise;
}

function itemMatchesGenre(item, genre) {
  const target = String(genre || '').toLowerCase();

  if (!target) {
    return true;
  }

  return (item.genres || []).some((value) => {
    const normalized = String(value || '').toLowerCase();
    return normalized === target || normalized.split(/\s*(?:&|\/|\+|\band\b)\s*/).indexOf(target) !== -1;
  });
}

function itemMatchesYear(item, year) {
  return !year || String(item.year || '') === String(year);
}

function itemMatchesRating(item, rating) {
  const min = Number(rating || 0);

  if (!min) {
    return true;
  }

  return item.imdbRating >= min && item.imdbRating < min + 1;
}

async function getPagedCatalogEntries(type, filtered, skip, limit, filters) {
  const items = [];
  let cursor = skip;
  let scanned = 0;
  let rateLimited = false;

  while (cursor < filtered.length && items.length < limit) {
    const batchSize = Math.max(10, Math.min(35, limit - items.length + 15));
    const candidates = filtered.slice(cursor, cursor + batchSize);
    const apiTitles = await getImdbApiTitles(candidates);
    let consumed = 0;

    candidates.some((entry) => {
      consumed += 1;
      if (!Object.prototype.hasOwnProperty.call(apiTitles, entry.id)) {
        return false;
      }

      const apiTitle = apiTitles[entry.id];
      const meta = apiTitle ? imdbApiTitleToMeta(apiTitle, entry) : null;

      if (
        !apiTitle
        || titleHasExcludedCountry(apiTitle)
        || !itemMatchesRating(meta, filters && filters.rating)
        || !itemMatchesGenre(meta, filters && filters.genre)
        || !itemMatchesYear(meta, filters && filters.year)
      ) {
        return false;
      }

      items.push({
        entry: entry,
        apiTitle: apiTitle,
        meta: meta
      });
      return items.length >= limit;
    });

    cursor += consumed;
    scanned += consumed;

    if (apiTitles.__rateLimited) {
      rateLimited = true;
      break;
    }
  }

  return {
    items: items,
    scanned: scanned,
    nextSkip: skip + scanned,
    hasMore: cursor < filtered.length,
    rateLimited: rateLimited
  };
}

function normalizeRelatedTitleRoot(value) {
  let text = String(value || '').toLowerCase();

  text = text.replace(/&/g, ' and ');
  text = (text.split(/\s*[:\-–—]\s*/)[0] || text);
  text = text.replace(/\([^)]*\)/g, ' ');
  text = text.replace(/\b(part|chapter|volume|vol|episode|book|season)\s+[ivxlcdm\d]+$/g, ' ');
  text = text.replace(/\b[ivxlcdm]{2,}$|\b\d+$/g, ' ');
  text = text.replace(/[^a-z0-9]+/g, ' ');
  text = text.replace(/^\s*(the|a|an)\s+/g, '');
  text = text.replace(/\s+/g, ' ').trim();

  return text.length >= 4 ? text : '';
}

function getYearDistanceScore(leftYear, rightYear) {
  const left = Number(leftYear || 0) || 0;
  const right = Number(rightYear || 0) || 0;

  if (!left || !right) {
    return 0;
  }

  return Math.max(0, 24 - Math.abs(left - right));
}

function scoreRelatedEntry(source, candidate) {
  const sourceRoot = normalizeRelatedTitleRoot(source && source.name);
  const candidateRoot = normalizeRelatedTitleRoot(candidate && candidate.name);
  const sourceGenres = new Set((source && source.genres || []).map((genre) => String(genre || '').toLowerCase()));
  const candidateGenres = candidate && candidate.genres || [];
  let score = 0;

  if (
    sourceRoot
    && candidateRoot
    && (
      sourceRoot === candidateRoot
      || candidateRoot.startsWith(`${sourceRoot} `)
      || sourceRoot.startsWith(`${candidateRoot} `)
    )
  ) {
    score += 120;
  }

  candidateGenres.forEach((genre) => {
    if (sourceGenres.has(String(genre || '').toLowerCase())) {
      score += 18;
    }
  });

  score += getYearDistanceScore(source && source.year, candidate && candidate.year);
  if (source && source.imdbRating && candidate && candidate.imdbRating) {
    score += Math.max(0, 16 - Math.abs(source.imdbRating - candidate.imdbRating) * 8);
  }
  if (candidate && candidate.votes) {
    score += Math.min(14, Math.log10(candidate.votes) * 2);
  }

  return score;
}

async function getRelatedCatalog(index, type, id, limit) {
  const normalizedType = normalizeType(type);
  let source = getIndexEntry(index, normalizedType, id);
  const candidates = [];
  const candidateLimit = Math.max(limit * 3, 30);
  const items = [];

  if (!source) {
    const apiTitle = await getImdbApiTitleById(id);

    if (apiTitle && !titleHasExcludedCountry(apiTitle)) {
      source = imdbApiTitleToMeta(apiTitle, {
        id: id,
        type: normalizedType,
        name: apiTitle.primaryTitle || apiTitle.originalTitle || id,
        year: apiTitle.startYear ? String(apiTitle.startYear) : '',
        genres: []
      });
    }
    if (!source) {
      return {
        metas: [],
        hasMore: false,
        source: 'related-index-miss'
      };
    }
  }

  (index[normalizedType] || []).forEach((entry) => {
    const score = entry && entry.id !== id ? scoreRelatedEntry(source, entry) : 0;

    if (score > 0) {
      candidates.push({
        entry: entry,
        score: score
      });
    }
  });

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if ((right.entry.votes || 0) !== (left.entry.votes || 0)) return (right.entry.votes || 0) - (left.entry.votes || 0);
    return String(left.entry.name).localeCompare(String(right.entry.name));
  });

  const topEntries = candidates.slice(0, candidateLimit).map((candidate) => candidate.entry);
  const apiTitles = await getImdbApiTitles(topEntries);

  for (const entry of topEntries) {
    const apiTitle = Object.prototype.hasOwnProperty.call(apiTitles, entry.id) ? apiTitles[entry.id] : null;

    if (apiTitle && titleHasExcludedCountry(apiTitle)) {
      continue;
    }
    items.push(imdbApiTitleToMeta(apiTitle, entry));
    if (items.length >= limit) {
      break;
    }
  }

  return {
    metas: items,
    hasMore: candidates.length > topEntries.length,
    source: 'related-index',
    total: candidates.length
  };
}

async function handleCatalog(req, res, parsedUrl) {
  const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
  const type = normalizeType(pathParts[1]);
  const rating = parsedUrl.searchParams.get('rating') || '';
  const genre = parsedUrl.searchParams.get('genre') || '';
  const year = parsedUrl.searchParams.get('year') || '';
  const blockbuster = type === 'movie' && parsedUrl.searchParams.get('blockbuster') === '1';
  const skip = Math.max(0, Number(parsedUrl.searchParams.get('skip') || 0) || 0);
  const limit = Math.max(1, Math.min(maxResults, Number(parsedUrl.searchParams.get('limit') || 50) || 50));
  const index = await getCatalogIndex();

  if (blockbuster) {
    const page = await getBlockbusterCatalog(index, skip, limit, {
      rating: rating,
      genre: genre,
      year: year
    });

    sendJson(res, 200, {
      metas: page.metas,
      hasMore: page.hasMore,
      skip: skip,
      limit: page.limit,
      requestedLimit: limit,
      nextSkip: page.nextSkip,
      rateLimited: page.rateLimited,
      total: page.total,
      source: page.source,
      generatedAt: index.generatedAt,
      minVotes: index.minVotes,
      tmdbConfigured: hasTmdbCredentials(),
      tmdbBlockbusterMinVotes: tmdbBlockbusterMinVotes,
      weightedVoteAnchor: index.weightedVoteAnchor,
      imdbApiExcludedCountryCodes: index.imdbApiExcludedCountryCodes
    });
    return;
  }

  const filtered = (index[type] || []).filter((item) => {
    return itemMatchesRating(item, rating) && itemMatchesGenre(item, genre) && itemMatchesYear(item, year);
  });
  const page = await getPagedCatalogEntries(type, filtered, skip, limit, {
    rating: rating,
    genre: genre,
    year: year
  });
  const metas = page.items.map((item) => item.meta || imdbApiTitleToMeta(item.apiTitle, item.entry));

  if (enrichArtwork) {
    const fallbackEntries = page.items.filter((item) => {
      return !getImdbApiImageUrl(item.apiTitle && item.apiTitle.primaryImage);
    }).map((item) => item.entry);
    const fallbackById = {};

    if (fallbackEntries.length) {
      (await enrichMetasWithArtwork(type, fallbackEntries)).forEach((meta) => {
        fallbackById[meta.id] = meta;
      });
      metas.forEach((meta) => {
        const fallback = fallbackById[meta.id];

        if (fallback) {
          meta.poster = fallback.poster || meta.poster;
          meta.background = fallback.background || meta.background;
          meta.logo = fallback.logo || meta.logo;
          meta.description = meta.description || fallback.description;
        }
      });
    }
  }

  sendJson(res, 200, {
    metas: metas,
    hasMore: page.hasMore,
    skip: skip,
    limit: page.scanned,
    requestedLimit: limit,
    nextSkip: page.nextSkip,
    rateLimited: page.rateLimited,
    total: filtered.length,
    source: 'imdbapi-dev+imdb-datasets',
    generatedAt: index.generatedAt,
    minVotes: index.minVotes,
    weightedVoteAnchor: index.weightedVoteAnchor,
    imdbApiExcludedCountryCodes: index.imdbApiExcludedCountryCodes
  });
}

async function handleTrailer(req, res, parsedUrl) {
  const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
  const type = normalizeType(pathParts[1]);
  const id = pathParts[2] || '';
  const trailer = await getTrailerForImdbId(type, id);

  sendJson(res, 200, {
    trailer: trailer,
    source: trailer && trailer.site ? 'trailer-metadata' : '',
    tmdbConfigured: hasTmdbCredentials()
  });
}

function selectProgressiveTrailerFormat(info) {
  const formats = Array.isArray(info && info.formats) ? info.formats : [];
  const usable = formats.filter((format) => {
    const protocol = String(format.protocol || '').toLowerCase();
    const ext = String(format.ext || '').toLowerCase();
    const acodec = String(format.acodec || '').toLowerCase();
    const vcodec = String(format.vcodec || '').toLowerCase();
    const height = Number(format.height || 0);

    return format.url
      && (!protocol || protocol.indexOf('http') === 0)
      && (!trailerMaxHeight || !height || height <= trailerMaxHeight)
      && ext === 'mp4'
      && acodec && acodec !== 'none'
      && vcodec && vcodec !== 'none';
  });

  usable.sort((left, right) => {
    const leftHeight = Number(left.height || 0);
    const rightHeight = Number(right.height || 0);
    const leftBitrate = Number(left.tbr || left.vbr || 0);
    const rightBitrate = Number(right.tbr || right.vbr || 0);

    if (rightHeight !== leftHeight) {
      return rightHeight - leftHeight;
    }
    return rightBitrate - leftBitrate;
  });

  return usable[0] || null;
}

function resolveYoutubeTrailerStream(key) {
  const safeKey = String(key || '').replace(/[^A-Za-z0-9_-]/g, '');
  const cacheEntry = trailerStreamCache[safeKey];
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(safeKey)}`;

  if (!safeKey) {
    return Promise.reject(new Error('Missing YouTube key'));
  }
  if (cacheEntry && cacheEntry.expiresAt > Date.now()) {
    return Promise.resolve(cacheEntry.payload);
  }

  return new Promise((resolve, reject) => {
    childProcess.execFile(ytDlpPython, [
      '-m',
      'yt_dlp',
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--format',
      trailerMaxHeight
        ? `best[ext=mp4][vcodec!=none][acodec!=none][height<=${trailerMaxHeight}]/best[vcodec!=none][acodec!=none][height<=${trailerMaxHeight}]`
        : 'best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]',
      watchUrl
    ], {
      timeout: 30000,
      maxBuffer: 24 * 1024 * 1024
    }, (error, stdout, stderr) => {
      let info;
      let format;
      let payload;

      if (error) {
        reject(new Error(stderr && stderr.trim() || error.message || 'Trailer resolver failed'));
        return;
      }

      try {
        info = JSON.parse(stdout);
      } catch (parseError) {
        reject(new Error('Trailer resolver returned invalid JSON'));
        return;
      }

      format = selectProgressiveTrailerFormat(info);
      if (!format || !format.url) {
        reject(new Error('No progressive MP4 trailer format was found'));
        return;
      }

      payload = {
        url: format.url,
        duration: Number(info.duration || 0) || Number(format.duration || 0) || 0,
        title: info.title || '',
        width: Number(format.width || 0) || 0,
        height: Number(format.height || 0) || 0,
        ext: format.ext || 'mp4',
        source: 'yt-dlp'
      };
      trailerStreamCache[safeKey] = {
        expiresAt: Date.now() + trailerStreamCacheTtlMs,
        payload: payload
      };
      resolve(payload);
    });
  });
}

async function handleTrailerStream(req, res, parsedUrl) {
  const key = String(parsedUrl.searchParams.get('key') || '').replace(/[^A-Za-z0-9_-]/g, '');
  const payload = await resolveYoutubeTrailerStream(key);

  sendJson(res, 200, payload);
}

function handleTrailerPlayer(req, res, parsedUrl) {
  const key = String(parsedUrl.searchParams.get('key') || '').replace(/[^A-Za-z0-9_-]/g, '');
  const title = escapeHtml(parsedUrl.searchParams.get('title') || 'Trailer');
  const origin = `${parsedUrl.protocol}//${parsedUrl.host}`;
  const embedUrl = key
    ? `https://www.youtube.com/embed/${encodeURIComponent(key)}?enablejsapi=1&playsinline=1&rel=0&modestbranding=1&controls=0&iv_load_policy=3&autoplay=1&origin=${encodeURIComponent(origin)}`
    : '';

  if (!key) {
    sendHtml(res, 400, '<!doctype html><title>Trailer unavailable</title><body>Trailer unavailable</body>');
    return;
  }

  sendHtml(res, 200, `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <title>${title}</title>
  <style>
    html, body, #player {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      left: 0;
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: #000;
    }
    iframe {
      display: block;
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      left: 0;
      width: 100%;
      height: 100%;
      min-width: 100%;
      min-height: 100%;
      border: 0;
      background: #000;
    }
  </style>
</head>
<body>
  <div id="player">
    <iframe id="youtubeFrame" title="${title}" src="${embedUrl}" width="100%" height="100%" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
  </div>
  <script>
    (function() {
      var frame = document.getElementById('youtubeFrame');
      function syncSize() {
        var width = window.innerWidth || document.documentElement.clientWidth || document.body.clientWidth || 1280;
        var height = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight || 720;
        frame.style.width = width + 'px';
        frame.style.height = height + 'px';
        frame.setAttribute('width', String(width));
        frame.setAttribute('height', String(height));
      }
      function parse(data) {
        if (typeof data !== 'string') {
          return data;
        }
        try {
          return JSON.parse(data);
        } catch (error) {
          return null;
        }
      }
      function sendToYoutube(message) {
        if (!frame || !frame.contentWindow) {
          return;
        }
        frame.contentWindow.postMessage(JSON.stringify(message), '*');
      }
      window.addEventListener('message', function(event) {
        var data = parse(event.data);
        if (!data) {
          return;
        }
        if (event.source === frame.contentWindow) {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage(JSON.stringify(data), '*');
          }
          return;
        }
        if (data.event === 'command') {
          sendToYoutube(data);
        }
      });
      frame.addEventListener('load', function() {
        syncSize();
        sendToYoutube({ event: 'listening' });
        setTimeout(function() {
          sendToYoutube({ event: 'command', func: 'playVideo', args: [] });
        }, 300);
      });
      window.addEventListener('resize', syncSize);
      syncSize();
      setInterval(function() {
        sendToYoutube({ event: 'command', func: 'getCurrentTime', args: [] });
        sendToYoutube({ event: 'command', func: 'getDuration', args: [] });
      }, 1000);
    }());
  </script>
</body>
</html>`);
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,OPTIONS'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/health') {
    getCatalogIndex().then((index) => {
      sendJson(res, 200, {
        ok: true,
        generatedAt: index.generatedAt,
        movieCount: index.movie.length,
        seriesCount: index.series.length,
        tmdbConfigured: hasTmdbCredentials(),
        tmdbBlockbusterMinVotes: tmdbBlockbusterMinVotes
      });
    }).catch((error) => {
      sendJson(res, 500, { ok: false, error: { message: error.message } });
    });
    return;
  }

  if (req.method === 'GET' && /^\/catalog\/(movie|series)$/.test(parsedUrl.pathname)) {
    handleCatalog(req, res, parsedUrl).catch((error) => {
      sendJson(res, 500, { error: { message: error.message } });
    });
    return;
  }

  if (req.method === 'GET' && /^\/related\/(movie|series)\/[^/]+$/.test(parsedUrl.pathname)) {
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
    const type = normalizeType(pathParts[1]);
    const id = pathParts[2];
    const limit = Math.max(1, Math.min(maxResults, Number(parsedUrl.searchParams.get('limit') || 12) || 12));

    getCatalogIndex().then((index) => {
      return getRelatedCatalog(index, type, id, limit);
    }).then((payload) => {
      sendJson(res, 200, Object.assign({}, payload, {
        id: id,
        type: type,
        limit: limit,
        requestedLimit: limit
      }));
    }).catch((error) => {
      sendJson(res, 500, { error: { message: error.message } });
    });
    return;
  }

  if (req.method === 'GET' && /^\/trailer\/(movie|series)\/[^/]+$/.test(parsedUrl.pathname)) {
    handleTrailer(req, res, parsedUrl).catch((error) => {
      sendJson(res, 500, { error: { message: error.message } });
    });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/trailer-stream') {
    handleTrailerStream(req, res, parsedUrl).catch((error) => {
      sendJson(res, 502, { error: { message: error.message } });
    });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/trailer-player') {
    handleTrailerPlayer(req, res, parsedUrl);
    return;
  }

  sendJson(res, 404, { error: { message: 'Not found' } });
});

server.listen(port, host, () => {
  console.log(`IMDb catalog API listening on http://${host}:${port}`);
  console.log(`Using data directory ${dataDir}`);
});
