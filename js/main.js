let appState = {
    currentRoute: 'home', // 'home', 'category', 'movie', 'genre', 'country', 'year', 'search', 'watch'
    currentPage: 1,
    totalPages: 1,
    currentCategory: '', // slug (phim-le, phim-bo, etc.)
    currentSlug: '',    // movie slug
    currentEpisodeLink: '', // m3u8 link for current playing episode
    currentEpisodeName: '', // name of current playing episode
    currentGenre: '',
    currentCountry: '',
    currentYear: '',
    currentLanguage: '',
    currentKeyword: '',
    currentServerData: [], // Store server data for movie detail
    activeEpisodeElement: null // Keep track of the currently playing episode card for highlighting
};

let hlsInstance = null;
let searchTimeout; // For delayed search input

// --- Ads regex list from the provided script ---
const adsRegexList = [
    new RegExp(
        "(?<!#EXT-X-DISCONTINUITY[\\s\\S]*)#EXT-X-DISCONTINUITY\\n(?:.*?\\n){18,24}#EXT-X-DISCONTINUITY\\n(?![\\s\\S]*#EXT-X-DISCONTINUITY)",
        "g"
    ),
    /#EXT-X-DISCONTINUITY\n(?:#EXT-X-KEY:METHOD=NONE\n(?:.*\n){18,24})?#EXT-X-DISCONTINUITY\n|convertv7\//g,
    /#EXT-X-DISCONTINUITY\n#EXTINF:3\.920000,\n.*\n#EXTINF:0\.760000,\n.*\n#EXTINF:2\.000000,\n.*\n#EXTINF:2\.500000,\n.*\n#EXTINF:2\.000000,\n.*\n#EXTINF:2\.420000,\n.*\n#EXTINF:2\.000000,\n.*\n#EXTINF:0\.780000,\n.*\n#EXTINF:1\.960000,\n.*\n#EXTINF:2\.000000,\n.*\n#EXTINF:1\.760000,\n.*\n#EXTINF:3\.200000,\n.*\n#EXTINF:2\.000000,\n.*\n#EXTINF:1\.360000,\n.*\n#EXTINF:2\.000000,\n.*\n#EXTINF:2\.000000,\n.*\n#EXTINF:0\.720000,\.*/g,
];

// Check if playlist contains ads
function isContainAds(playlist) {
    return adsRegexList.some((regex) => {
        regex.lastIndex = 0; // Reset regex lastIndex for consistent testing
        return regex.test(playlist);
    });
}

// Remove ads from playlist and ensure HTTPS URLs
async function removeAds(playlistUrl) {
    try {
        const normalizedUrl = playlistUrl.replace(/^http:/, "https:");
        const response = await fetch(normalizedUrl, {
            method: "GET",
            headers: { Referer: normalizedUrl },
            mode: "cors",
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch playlist: ${normalizedUrl} (Status: ${response.status})`);
        }
        let playlist = await response.text();

        const baseUrl = new URL(normalizedUrl);
        playlist = playlist.replace(/^[^#].*$/gm, (line) => {
            try {
                if (line.startsWith('#')) return line;
                const parsedUrl = new URL(line, baseUrl);
                parsedUrl.protocol = "https:";
                return parsedUrl.toString();
            } catch (e) {
                console.warn(`Could not parse or normalize URL: ${line}`, e);
                return line;
            }
        });

        if (playlist.includes("#EXT-X-STREAM-INF")) {
            const variantUrls = playlist
                .split('\n')
                .filter(line => !line.startsWith('#') && line.trim() !== '');
            if (variantUrls.length > 0) {
                const variantUrl = variantUrls[variantUrls.length - 1];
                const normalizedVariantUrl = variantUrl.replace(/^http:/, "https:");
                return await removeAds(normalizedVariantUrl);
            }
        }

        if (isContainAds(playlist)) {
            console.log("Ads detected! Attempting to remove...");
            playlist = adsRegexList.reduce((currentPlaylist, regex) => {
                return currentPlaylist.replaceAll(regex, "");
            }, playlist);
            console.log("Ads removal attempt finished.");
        }

        return playlist;
    } catch (error) {
        console.error("Error in removeAds:", error);
        return null;
    }
}

// --- API Endpoint Definitions ---
const API_BASE = 'https://phimapi.com';
const API_V1 = 'https://phimapi.com/v1/api';

// --- UI Toggles ---
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('hamburger-toggle').addEventListener('click', () => {
        document.querySelector('.main-nav').classList.toggle('active');
        // Close search bar if hamburger menu is opened
        document.getElementById('search-bar-mobile').classList.remove('active');
    });

    const searchToggle = document.getElementById('search-toggle');
    const searchBarMobile = document.getElementById('search-bar-mobile');
    searchToggle.addEventListener('click', () => {
        searchBarMobile.classList.toggle('active');
        // Close hamburger menu if search bar is opened
        document.querySelector('.main-nav').classList.remove('active');
        if (searchBarMobile.classList.contains('active')) {
            document.getElementById('search-input-mobile').focus();
        }
    });

    // Close mobile menu/search bar if clicked on nav link
    document.querySelector('.main-nav').addEventListener('click', (e) => {
        if (e.target.tagName === 'A') {
            document.querySelector('.main-nav').classList.remove('active');
        }
    });
    // Ensure filters are loaded
    loadGenres();
    loadCountries();
    loadYears();

    // Initial routing based on URL hash
    window.addEventListener('hashchange', router);
    router(); // Call router on initial load
});

// --- Navigation Functions (Update URL hash) ---
function navigateTo(route) {
    window.location.hash = route;
}

function loadHomePage() {
    navigateTo('home');
}

function loadCategoryPage(categorySlug) {
    navigateTo(`category/${categorySlug}`);
}

function loadMovieDetailPage(slug) {
    navigateTo(`movie/${slug}`);
}

function loadFilterPage(filterType, slug) {
    navigateTo(`${filterType}/${slug}`);
}

function loadSearchPage(keyword) {
    navigateTo(`search/${encodeURIComponent(keyword)}`);
}

function loadWatchPage(movieSlug, episodeLink, episodeName) {
    navigateTo(`watch/${movieSlug}/${btoa(episodeLink)}/${encodeURIComponent(episodeName)}`);
}

// --- Core Router Function ---
async function router() {
    const hash = window.location.hash.substring(1); // Remove '#'
    let routeParts = hash.split('/');
    const mainSection = document.getElementById('movie-list');
    const detailSection = document.getElementById('movie-detail');
    const paginationSection = document.querySelector('.pagination');
    const videoPlayer = document.getElementById('video-player');
    const moviePoster = document.getElementById('movie-poster');
    const detailParagraphs = document.querySelectorAll('#movie-detail p');
    const detailEpisodeHeading = document.querySelector('#movie-detail h3'); // "Danh sách tập" heading

    // Reset UI visibility
    mainSection.style.display = 'grid'; // Default to grid for movie list
    detailSection.style.display = 'none'; // Hide detail by default
    paginationSection.style.display = 'flex'; // Show pagination by default
    videoPlayer.style.display = 'none'; // Hide video player by default
    moviePoster.style.display = 'block'; // Show poster by default
    detailParagraphs.forEach(p => p.style.display = 'block'); // Show all detail paragraphs
    if (detailEpisodeHeading) detailEpisodeHeading.style.display = 'block'; // Show "Danh sách tập"

    // Clear active HLS instance
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
    const video = document.getElementById('player');
    video.pause();
    video.src = '';
    video.load();
    if (video.dataset.blobUrl) {
        URL.revokeObjectURL(video.dataset.blobUrl);
        delete video.dataset.blobUrl;
    }

    // Deactivate all nav links
    document.querySelectorAll('.main-nav ul li a').forEach(link => link.classList.remove('active'));

    appState.currentPage = 1; // Reset page on route change unless specified

    // Parse hash and update state
    switch (routeParts[0]) {
        case 'home':
            appState.currentRoute = 'home';
            appState.currentCategory = '';
            appState.currentKeyword = '';
            appState.currentGenre = '';
            appState.currentCountry = '';
            appState.currentYear = '';
            appState.currentLanguage = '';
            document.getElementById('section-title').textContent = 'Phim Mới Cập Nhật';
            document.querySelector('[data-nav="home"]')?.classList.add('active');
            await fetchAndDisplayMovies(`${API_BASE}/danh-sach/phim-moi-cap-nhat?page=${appState.currentPage}`, true);
            break;
        case 'category':
            appState.currentRoute = 'category';
            appState.currentCategory = routeParts[1] || '';
            appState.currentKeyword = '';
            appState.currentGenre = '';
            appState.currentCountry = '';
            appState.currentYear = '';
            appState.currentLanguage = '';

            let categoryUrl = '';
            let sectionTitle = '';
            let navSelector = '';

            switch(appState.currentCategory) {
                case 'phim-le': categoryUrl = `${API_V1}/danh-sach/phim-le`; sectionTitle = 'Phim Lẻ'; navSelector = '[data-nav="single"]'; break;
                case 'phim-bo': categoryUrl = `${API_V1}/danh-sach/phim-bo`; sectionTitle = 'Phim Bộ'; navSelector = '[data-nav="series"]'; break;
                case 'hoat-hinh': categoryUrl = `${API_V1}/danh-sach/hoat-hinh`; sectionTitle = 'Hoạt Hình'; navSelector = '[data-nav="animation"]'; break;
                case 'tv-shows': categoryUrl = `${API_V1}/danh-sach/tv-shows`; sectionTitle = 'TV Shows'; navSelector = '[data-nav="tvshows"]'; break;
                case 'phim-thuyet-minh': categoryUrl = `${API_V1}/danh-sach/phim-thuyet-minh`; sectionTitle = 'Phim Thuyết Minh'; navSelector = '[data-nav="dubbed-movies"]'; break;
                case 'phim-long-tieng': categoryUrl = `${API_V1}/danh-sach/phim-long-tieng`; sectionTitle = 'Phim Lồng Tiếng'; navSelector = '[data-nav="dubbed-series"]'; break;
                default: loadHomePage(); return; // Fallback if category is invalid
            }
            document.getElementById('section-title').textContent = sectionTitle;
            document.querySelector(navSelector)?.classList.add('active');
            await fetchAndDisplayMovies(`${categoryUrl}?page=${appState.currentPage}`);
            break;
        case 'movie':
            appState.currentRoute = 'movie';
            appState.currentSlug = routeParts[1] || '';
            mainSection.style.display = 'none';
            detailSection.style.display = 'block';
            paginationSection.style.display = 'none';
            await loadMovieDetail(appState.currentSlug);
            break;
        case 'genre':
            appState.currentRoute = 'genre';
            appState.currentGenre = routeParts[1] || '';
            appState.currentKeyword = '';
            appState.currentCountry = '';
            appState.currentYear = '';
            appState.currentLanguage = '';
            document.getElementById('genre-filter').value = appState.currentGenre;
            const genreName = document.querySelector(`#genre-filter option[value="${appState.currentGenre}"]`)?.textContent || 'Thể loại';
            document.getElementById('section-title').textContent = genreName;
            await fetchAndDisplayMovies(`${API_V1}/the-loai/${appState.currentGenre}?page=${appState.currentPage}`);
            break;
        case 'country':
            appState.currentRoute = 'country';
            appState.currentCountry = routeParts[1] || '';
            appState.currentKeyword = '';
            appState.currentGenre = '';
            appState.currentYear = '';
            appState.currentLanguage = '';
            document.getElementById('country-filter').value = appState.currentCountry;
            const countryName = document.querySelector(`#country-filter option[value="${appState.currentCountry}"]`)?.textContent || 'Quốc gia';
            document.getElementById('section-title').textContent = countryName;
            await fetchAndDisplayMovies(`${API_V1}/quoc-gia/${appState.currentCountry}?page=${appState.currentPage}`);
            break;
        case 'year':
            appState.currentRoute = 'year';
            appState.currentYear = routeParts[1] || '';
            appState.currentKeyword = '';
            appState.currentGenre = '';
            appState.currentCountry = '';
            appState.currentLanguage = '';
            document.getElementById('year-filter').value = appState.currentYear;
            document.getElementById('section-title').textContent = `Năm ${appState.currentYear}`;
            await fetchAndDisplayMovies(`${API_V1}/nam/${appState.currentYear}?page=${appState.currentPage}`);
            break;
        case 'search':
            appState.currentRoute = 'search';
            appState.currentKeyword = decodeURIComponent(routeParts[1] || '');
            appState.currentGenre = '';
            appState.currentCountry = '';
            appState.currentYear = '';
            appState.currentLanguage = '';
            document.getElementById('search-input').value = appState.currentKeyword;
            document.getElementById('search-input-mobile').value = appState.currentKeyword;
            document.getElementById('section-title').textContent = `Kết quả tìm kiếm: ${appState.currentKeyword}`;
            await fetchAndDisplayMovies(`${API_V1}/tim-kiem?keyword=${encodeURIComponent(appState.currentKeyword)}&page=${appState.currentPage}`);
            break;
        case 'watch':
            appState.currentRoute = 'watch';
            appState.currentSlug = routeParts[1] || '';
            appState.currentEpisodeLink = routeParts[2] ? atob(routeParts[2]) : ''; // Decode base64
            appState.currentEpisodeName = routeParts[3] ? decodeURIComponent(routeParts[3]) : '';
            mainSection.style.display = 'none';
            detailSection.style.display = 'block';
            paginationSection.style.display = 'none';
            // First load movie detail, then play episode
            await loadMovieDetail(appState.currentSlug, appState.currentEpisodeLink, appState.currentEpisodeName);
            break;
        default:
            navigateTo('home'); // Default to home if hash is empty or unrecognized
            break;
    }
    // Update filter selects if they are not the active route type
    if (appState.currentRoute !== 'genre') document.getElementById('genre-filter').value = '';
    if (appState.currentRoute !== 'country') document.getElementById('country-filter').value = '';
    if (appState.currentRoute !== 'year') document.getElementById('year-filter').value = '';
    if (appState.currentRoute !== 'search') {
        document.getElementById('search-input').value = '';
        document.getElementById('search-input-mobile').value = '';
    }
    document.getElementById('language-filter').value = appState.currentLanguage; // Always update language filter
}

/**
 * Fetches and displays movies from a given URL.
 * @param {string} url - The API URL to fetch movies from.
 * @param {boolean} isRootItems - Set to true if movie items are directly under 'items' and pagination directly under 'pagination' (e.g., phimapi.com/danh-sach/phim-moi-cap-nhat)
 */
async function fetchAndDisplayMovies(url, isRootItems = false) {
    const moviesContainer = document.getElementById('movie-list');
    moviesContainer.innerHTML = '<p class="loading"><i class="fas fa-spinner fa-spin"></i> Đang tải phim...</p>';

    try {
        const response = await fetch(url);
        const data = await response.json();

        let movies = [];
        let paginationData = {};

        if (isRootItems) {
            movies = data.items || [];
            paginationData = data.pagination || {};
        } else if (data.data) {
            movies = data.data.items || [];
            paginationData = data.data.params.pagination || {};
        }

        appState.totalPages = paginationData.totalPages || 1;
        appState.currentPage = paginationData.currentPage || 1; // Update current page from API response

        moviesContainer.innerHTML = '';
        if (movies.length === 0) {
            moviesContainer.innerHTML = '<p>Không tìm thấy phim nào.</p>';
            document.getElementById('prev-page').disabled = true;
            document.getElementById('next-page').disabled = true;
            document.getElementById('page-info').textContent = `Trang 0 / 0`;
            return;
        }

        movies.forEach(movie => {
            const movieCard = document.createElement('div');
            movieCard.classList.add('movie-card');
            const posterUrl = movie.poster_url.includes('http') ? movie.poster_url : `https://phimimg.com/${movie.poster_url}`;
            movieCard.innerHTML = `
                <img src="${posterUrl}" alt="Poster của ${movie.name}" onerror="this.onerror=null;this.src='https://via.placeholder.com/200x300?text=No+Image';">
                <h3>${movie.name}</h3>
            `;
            movieCard.onclick = () => loadMovieDetailPage(movie.slug);
            moviesContainer.appendChild(movieCard);
        });

        document.getElementById('page-info').textContent = `Trang ${appState.currentPage} / ${appState.totalPages}`;
        document.getElementById('prev-page').disabled = appState.currentPage === 1;
        document.getElementById('next-page').disabled = appState.currentPage >= appState.totalPages;

    } catch (error) {
        console.error('Error fetching movies:', error);
        moviesContainer.innerHTML = '<p>Không thể tải dữ liệu. Vui lòng thử lại sau.</p>';
        document.getElementById('prev-page').disabled = true;
        document.getElementById('next-page').disabled = true;
        document.getElementById('page-info').textContent = `Lỗi tải trang`;
    }
}

async function loadMovieDetail(slug, episodeLinkToPlay = null, episodeNameToPlay = null) {
    document.getElementById('movie-list').style.display = 'none';
    document.getElementById('movie-detail').style.display = 'block';
    document.querySelector('.pagination').style.display = 'none'; // Hide pagination

    const episodeListDiv = document.getElementById('episode-list');
    episodeListDiv.innerHTML = '<p class="loading"><i class="fas fa-spinner fa-spin"></i> Đang tải chi tiết phim...</p>';

    // Hide video player and show detail info by default
    document.getElementById('video-player').style.display = 'none';
    document.getElementById('movie-poster').style.display = 'block';
    document.querySelectorAll('#movie-detail p').forEach(p => p.style.display = 'block');
    document.querySelector('#movie-detail h3').style.display = 'block'; // "Danh sách tập" heading

    // Reset active episode highlight
    if (appState.activeEpisodeElement) {
        appState.activeEpisodeElement.classList.remove('active');
        appState.activeEpisodeElement = null;
    }

    try {
        const response = await fetch(`${API_BASE}/phim/${slug}`);
        const data = await response.json();
        const movie = data.movie;

        if (!movie) {
            document.getElementById('movie-detail').innerHTML = '<p>Không tìm thấy chi tiết phim.</p>';
            return;
        }

        document.getElementById('movie-title').textContent = movie.name;
        // Đảm bảo truy cập đúng thuộc tính "origin_name"
        document.getElementById('movie-original-name').textContent = movie.origin_name || 'N/A';
        document.getElementById('movie-poster').src = movie.poster_url.includes('http') ? movie.poster_url : `https://phimimg.com/${movie.poster_url}`;
        document.getElementById('movie-poster').alt = `Poster của phim ${movie.name}`;
        document.getElementById('movie-poster').onerror = function() {
            this.onerror=null;
            this.src='https://via.placeholder.com/300x450?text=No+Image';
        };

        document.getElementById('movie-year').textContent = movie.year || 'N/A';
        document.getElementById('movie-genres').textContent = movie.category ? movie.category.map(cat => cat.name).join(', ') : 'N/A';
        document.getElementById('movie-countries').textContent = movie.country ? movie.country.map(c => c.name).join(', ') : 'N/A';
        document.getElementById('movie-rating').textContent = movie.tmdb?.vote_average ? movie.tmdb.vote_average.toFixed(1) : 'N/A';
        document.getElementById('movie-description').textContent = movie.content || 'Không có mô tả';
        document.getElementById('movie-status').textContent = movie.episode_current || 'N/A';
        document.getElementById('movie-duration').textContent = movie.time || 'N/A';
        
        // Sửa lỗi hiển thị Đạo diễn và Diễn viên
        document.getElementById('movie-director').textContent = movie.director && movie.director.length > 0 ? movie.director.map(d => d.name).join(', ') : 'N/A';
        document.getElementById('movie-actors').textContent = movie.actor && movie.actor.length > 0 ? movie.actor.map(a => a.name).join(', ') : 'N/A';

        episodeListDiv.innerHTML = '';
        if (data.episodes && data.episodes.length > 0) {
            appState.currentServerData = data.episodes; // Store server data
            const serverTabs = document.createElement('div');
            serverTabs.classList.add('server-tabs');
            let firstServerActive = false;
            let targetServerIndex = 0; // Index of server to initially display

            data.episodes.forEach((server, index) => {
                const tab = document.createElement('button');
                tab.textContent = server.server_name;
                tab.classList.add('server-tab');

                // If an episode link is provided (from watch route), try to find its server
                if (episodeLinkToPlay && !firstServerActive) {
                    const foundInServer = server.server_data.some(ep => ep.link_m3u8 === episodeLinkToPlay);
                    if (foundInServer) {
                        tab.classList.add('active');
                        tab.setAttribute('aria-selected', 'true');
                        firstServerActive = true;
                        targetServerIndex = index;
                    }
                }
                if (!firstServerActive && index === 0) { // Default to first server if no specific episode to play
                    tab.classList.add('active');
                    tab.setAttribute('aria-selected', 'true');
                    firstServerActive = true;
                }

                tab.onclick = () => {
                    document.querySelectorAll('.server-tab').forEach(t => {
                        t.classList.remove('active');
                        t.setAttribute('aria-selected', 'false');
                    });
                    tab.classList.add('active');
                    tab.setAttribute('aria-selected', 'true');
                    displayEpisodes(server.server_data, movie.name, episodeLinkToPlay); // episodeNameToPlay is not needed here
                };
                serverTabs.appendChild(tab);
            });
            episodeListDiv.appendChild(serverTabs);

            // Display episodes for the determined active server
            if (appState.currentServerData[targetServerIndex]) {
                displayEpisodes(appState.currentServerData[targetServerIndex].server_data, movie.name, episodeLinkToPlay); // episodeNameToPlay is not needed here
            } else {
                episodeListDiv.innerHTML += '<p>Không có dữ liệu tập phim cho server này.</p>';
            }


            // If a specific episode was meant to be played from hash, play it now
            if (episodeLinkToPlay && episodeNameToPlay) {
                // Use a small delay to ensure UI updates before video starts
                setTimeout(() => {
                    playEpisode(episodeLinkToPlay, episodeNameToPlay, appState.currentSlug);
                    // Find and highlight the active episode card
                    const activeEpisodeCard = document.querySelector(`.episode-card[data-episode-link="${btoa(episodeLinkToPlay)}"]`);
                    if (activeEpisodeCard) {
                        activeEpisodeCard.classList.add('active');
                        appState.activeEpisodeElement = activeEpisodeCard;
                        activeEpisodeCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }, 100);
            }
        } else {
            episodeListDiv.textContent = 'Không có tập nào';
        }
    } catch (error) {
        console.error('Error fetching movie details:', error);
        document.getElementById('movie-detail').innerHTML = '<p>Không thể tải chi tiết phim. Vui lòng thử lại sau.</p>';
    }
}

function displayEpisodes(episodes, movieName, episodeLinkToPlay = null) {
    const episodeListDiv = document.getElementById('episode-list');
    // Remove previous grid, keep server tabs
    let existingGrid = episodeListDiv.querySelector('.episode-grid');
    if (existingGrid) existingGrid.remove();

    const episodeContainer = document.createElement('div');
    episodeContainer.classList.add('episode-grid');

    if (!episodes || episodes.length === 0) {
        episodeContainer.textContent = 'Không có tập nào cho server này.';
    } else {
        episodes.forEach(episode => {
            const episodeCard = document.createElement('div');
            episodeCard.classList.add('episode-card');
            episodeCard.textContent = episode.name;
            episodeCard.setAttribute('data-episode-link', btoa(episode.link_m3u8)); // Store encoded link for lookup
            if (episode.link_m3u8 === episodeLinkToPlay) {
                episodeCard.classList.add('active');
                appState.activeEpisodeElement = episodeCard;
            }
            episodeCard.onclick = () => {
                // Update URL hash when clicking an episode
                loadWatchPage(appState.currentSlug, episode.link_m3u8, episode.name);
                // Highlight active episode
                if (appState.activeEpisodeElement) {
                    appState.activeEpisodeElement.classList.remove('active');
                }
                episodeCard.classList.add('active');
                appState.activeEpisodeElement = episodeCard;
            };
            episodeContainer.appendChild(episodeCard);
        });
    }
    episodeListDiv.appendChild(episodeContainer);
}


async function playEpisode(url, title, movieSlug) {
    const video = document.getElementById('player');
    appState.currentEpisodeLink = url;
    appState.currentEpisodeName = title;

    document.getElementById('video-player').style.display = 'block';
    document.getElementById('video-title').textContent = title;
    document.getElementById('movie-poster').style.display = 'none';
    document.querySelectorAll('#movie-detail p').forEach(p => p.style.display = 'none');
    document.querySelector('#movie-detail h3').style.display = 'none'; // Hide "Danh sách tập" heading when playing

    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }

    video.src = '';
    video.load();

    let finalSource = url;

    try {
        console.log("Attempting to remove ads from:", url);
        const cleanedPlaylist = await removeAds(url);

        if (cleanedPlaylist) {
            const blob = new Blob([cleanedPlaylist], { type: "application/vnd.apple.mpegurl" });
            finalSource = URL.createObjectURL(blob);
            console.log("Ads removed successfully, using Blob URL.");
        } else {
            finalSource = url.replace(/^http:/, "https:");
            console.warn("Could not remove ads or error occurred, falling back to original URL (HTTPS).");
        }
    } catch (error) {
        console.error("Error during ad removal process:", error);
        finalSource = url.replace(/^http:/, "https:");
    }

    if (Hls.isSupported()) {
        hlsInstance = new Hls();
        hlsInstance.loadSource(finalSource);
        hlsInstance.attachMedia(video);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
            console.log("HLS Manifest parsed, playing video.");
            video.play().catch(e => console.error("Video auto-play failed on manifest parsed:", e));
        });
        hlsInstance.on(Hls.Events.ERROR, function (event, data) {
            if (data.fatal) {
                switch(data.type) {
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        console.error("Fatal media error encountered, trying to recover:", data);
                        hlsInstance.recoverMediaError();
                        break;
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        console.error("Fatal network error encountered, retrying:", data);
                        video.src = finalSource; // Try re-setting src
                        video.load();
                        video.play().catch(e => console.error("Video auto-play failed on retry:", e));
                        break;
                    default:
                        hlsInstance.destroy();
                        hlsInstance = null;
                        console.error("HLS fatal error:", data);
                        alert('Không thể phát video này. Vui lòng thử lại sau hoặc chọn tập khác.');
                        break;
                }
            }
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = finalSource;
        video.play().catch(e => console.error("Video auto-play failed (native HLS):", e));
    } else {
        alert('Trình duyệt của bạn không hỗ trợ phát định dạng video này (HLS). Vui lòng thử trình duyệt khác.');
    }

    if (finalSource.startsWith("blob:")) {
        video.dataset.blobUrl = finalSource;
    }
}

function backToDetail() {
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
    const video = document.getElementById('player');
    video.pause();
    video.src = '';
    video.load();

    if (video.dataset.blobUrl) {
        URL.revokeObjectURL(video.dataset.blobUrl);
        delete video.dataset.blobUrl;
        console.log("Blob URL revoked.");
    }

    document.getElementById('video-player').style.display = 'none';
    document.getElementById('movie-poster').style.display = 'block';
    document.querySelectorAll('#movie-detail p').forEach(p => p.style.display = 'block');
    document.querySelector('#movie-detail h3').style.display = 'block'; // Show "Danh sách tập" heading again

    // Remove active episode highlight
    if (appState.activeEpisodeElement) {
        appState.activeEpisodeElement.classList.remove('active');
        appState.activeEpisodeElement = null;
    }
    // Navigate back to the movie detail page hash
    navigateTo(`movie/${appState.currentSlug}`);
}

// --- Filter and Search Logic ---
async function loadGenres() {
    try {
        const response = await fetch(`${API_BASE}/the-loai`);
        const data = await response.json();
        const genreFilter = document.getElementById('genre-filter');
        genreFilter.innerHTML = '<option value="">Tất cả thể loại</option>';
        if (data && Array.isArray(data)) {
            data.forEach(genre => {
                const option = document.createElement('option');
                option.value = genre.slug;
                option.textContent = genre.name;
                genreFilter.appendChild(option);
            });
        }
    } catch (error) { console.error('Error loading genres:', error); }
}

async function loadCountries() {
    try {
        const response = await fetch(`${API_BASE}/quoc-gia`);
        const data = await response.json();
        const countryFilter = document.getElementById('country-filter');
        countryFilter.innerHTML = '<option value="">Tất cả quốc gia</option>';
        if (data && Array.isArray(data)) {
            data.forEach(country => {
                const option = document.createElement('option');
                option.value = country.slug;
                option.textContent = country.name;
                countryFilter.appendChild(option);
            });
        }
    } catch (error) { console.error('Error loading countries:', error); }
}

function loadYears() {
    const yearFilter = document.getElementById('year-filter');
    yearFilter.innerHTML = '<option value="">Tất cả năm</option>';
    const currentYear = new Date().getFullYear();
    const startYear = 1970;
    for (let year = currentYear; year >= startYear; year--) {
        const option = document.createElement('option');
        option.value = year;
        option.textContent = year;
        yearFilter.appendChild(option);
    }
}

function filterAndNavigate(filterType) {
    appState.currentPage = 1; // Reset page on new filter
    let value;
    switch(filterType) {
        case 'genre':
            value = document.getElementById('genre-filter').value;
            appState.currentGenre = value;
            appState.currentCountry = ''; appState.currentYear = ''; appState.currentKeyword = ''; appState.currentLanguage = '';
            document.getElementById('country-filter').value = '';
            document.getElementById('year-filter').value = '';
            document.getElementById('search-input').value = '';
            document.getElementById('search-input-mobile').value = '';
            document.getElementById('language-filter').value = '';
            break;
        case 'country':
            value = document.getElementById('country-filter').value;
            appState.currentCountry = value;
            appState.currentGenre = ''; appState.currentYear = ''; appState.currentKeyword = ''; appState.currentLanguage = '';
            document.getElementById('genre-filter').value = '';
            document.getElementById('year-filter').value = '';
            document.getElementById('search-input').value = '';
            document.getElementById('search-input-mobile').value = '';
            document.getElementById('language-filter').value = '';
            break;
        case 'year':
            value = document.getElementById('year-filter').value;
            appState.currentYear = value;
            appState.currentGenre = ''; appState.currentCountry = ''; appState.currentKeyword = ''; appState.currentLanguage = '';
            document.getElementById('genre-filter').value = '';
            document.getElementById('country-filter').value = '';
            document.getElementById('search-input').value = '';
            document.getElementById('search-input-mobile').value = '';
            document.getElementById('language-filter').value = '';
            break;
        case 'language':
            value = document.getElementById('language-filter').value;
            appState.currentLanguage = value;
            appState.currentGenre = ''; appState.currentCountry = ''; appState.currentYear = ''; appState.currentKeyword = '';
            document.getElementById('genre-filter').value = '';
            document.getElementById('country-filter').value = '';
            document.getElementById('year-filter').value = '';
            document.getElementById('search-input').value = '';
            document.getElementById('search-input-mobile').value = '';
            break;
        default: return;
    }

    if (value === '') { // If filter is cleared
        navigateTo('home');
    } else if (filterType === 'language') {
        // Special handling for language filters that map to categories
        if (value === 'thuyet-minh') {
            navigateTo('category/phim-thuyet-minh');
        } else if (value === 'long-tieng') {
            navigateTo('category/phim-long-tieng');
        } else if (value === 'vietsub') {
            // Vietsub is generally default, navigate to home (phim-moi-cap-nhat) or a generic all movies page if one exists
            navigateTo('home');
        } else {
            // If there's a need for a generic "all movies with vietsub" or similar
            // For now, if no specific category, navigate to home.
            navigateTo('home');
        }
    } else {
        navigateTo(`${filterType}/${value}`);
    }
}

function searchMoviesDelayed() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        performSearch();
    }, 500); // Wait 500ms after typing stops
}

function performSearch() {
    const keywordDesktop = document.getElementById('search-input').value.trim();
    const keywordMobile = document.getElementById('search-input-mobile').value.trim();
    const keyword = keywordDesktop || keywordMobile; // Use whichever has content

    if (keyword === '') {
        navigateTo('home');
        return;
    }
    appState.currentKeyword = keyword;
    appState.currentPage = 1;
    // Clear other filters when searching
    appState.currentGenre = ''; appState.currentCountry = ''; appState.currentYear = ''; appState.currentLanguage = '';
    document.getElementById('genre-filter').value = '';
    document.getElementById('country-filter').value = '';
    document.getElementById('year-filter').value = '';
    document.getElementById('language-filter').value = '';

    loadSearchPage(keyword);
}


function clearFiltersAndNavigate() {
    document.getElementById('search-input').value = '';
    document.getElementById('search-input-mobile').value = '';
    document.getElementById('genre-filter').value = '';
    document.getElementById('country-filter').value = '';
    document.getElementById('year-filter').value = '';
    document.getElementById('language-filter').value = '';
    appState.currentKeyword = '';
    appState.currentGenre = '';
    appState.currentCountry = '';
    appState.currentYear = '';
    appState.currentLanguage = '';
    navigateTo('home');
}

function changePage(delta) {
    appState.currentPage += delta;
    if (appState.currentPage < 1) appState.currentPage = 1;
    if (appState.currentPage > appState.totalPages) appState.currentPage = appState.totalPages;

    let targetHash;
    // Reconstruct the hash based on current appState
    switch (appState.currentRoute) {
        case 'home':
            targetHash = `home`;
            break;
        case 'category':
            targetHash = `category/${appState.currentCategory}`;
            break;
        case 'genre':
            targetHash = `genre/${appState.currentGenre}`;
            break;
        case 'country':
            targetHash = `country/${appState.currentCountry}`;
            break;
        case 'year':
            targetHash = `year/${appState.currentYear}`;
            break;
        case 'search':
            targetHash = `search/${encodeURIComponent(appState.currentKeyword)}`;
            break;
        default:
            targetHash = `home`; // Fallback
            break;
    }
    // Append page to hash. This is not directly read by router, but useful for user to bookmark
    // The router will always reset appState.currentPage to 1 unless the route specifically passes it (e.g. from changePage)
    // So, we need to pass the current page back to the router explicitly when changing page
    window.location.hash = `${targetHash}/page/${appState.currentPage}`;

    // Re-run the router to fetch content for the new page
    router();
}
