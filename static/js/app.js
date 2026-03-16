/* DashView - Frontend Application */

// State
let currentFile = null;
let mapInstance = null;
let mapTrack = null;
let mapMarker = null;
let minimapInstance = null;
let minimapMarker = null;
let minimapTrack = null;
let isMapVisible = false;
let isOverlayVisible = true;
let isPiPVisible = false;
let pipUserDisabled = false; // true when user explicitly turned off PiP
let playbackSpeeds = [0.5, 1, 1.5, 2, 4];
let currentSpeedIdx = 1;
let allFiles = [];
let filteredFiles = [];
let gpsData = [];  // Current GPS points
let gsensorData = []; // Current G-sensor data
let settings = {};
let dashcamConfig = null;  // Raw config sections from config.ini
let configSchema = null;   // Schema with descriptions

// Elements
const video = document.getElementById('video-player');
const pipVideo = document.getElementById('pip-video');
const fileList = document.getElementById('file-list');
const emptyState = document.getElementById('empty-state');
const welcomeScreen = document.getElementById('welcome-screen');
const playerArea = document.getElementById('player-area');
const overlay = document.getElementById('video-overlay');

// Init
document.addEventListener('DOMContentLoaded', async () => {
    await loadSettingsFromServer();
    loadConfig();
    loadFiles();
    loadDashcamInfo();
    triggerTracksBuild();
    setupVideoEvents();
    setupProgressBar();
    setupFilterEvents();
    setupKeyboard();
    setupPiPDrag();

    // G-sensor graph hover tooltip
    setupGraphHover();
    setupSeekPreview();

    // Redraw G-sensor graph on resize
    window.addEventListener('resize', () => {
        if (gsensorData.length > 0) drawGSensorGraph(gsensorData);
        if (mapInstance) mapInstance.invalidateSize();
    });
});

// --- Settings ---

async function loadSettingsFromServer() {
    const res = await fetch('/api/settings');
    settings = await res.json();
    applySettings();
}

function applySettings() {
    // Apply to UI toggles in settings modal
    document.querySelectorAll('[data-key]').forEach(el => {
        const key = el.dataset.key;
        if (!(key in settings)) return;
        if (el.type === 'checkbox') {
            el.checked = settings[key];
        } else if (el.type === 'range') {
            el.value = settings[key];
            // Update range value display
            const valueEl = el.nextElementSibling;
            if (valueEl && valueEl.classList.contains('range-value')) {
                valueEl.textContent = settings[key];
            }
        } else if (el.tagName === 'SELECT') {
            el.value = settings[key];
        }
    });

    // Apply theme
    applyTheme();

    // Apply overlay visibility
    updateOverlayVisibility();

    // Apply G-sensor graph height
    const dataPanel = document.getElementById('data-panel');
    if (dataPanel && settings.gsensor_graph_height) {
        dataPanel.style.height = settings.gsensor_graph_height + 'px';
    }

    // Apply speed unit display
    const unitEl = document.getElementById('hud-speed-unit');
    if (unitEl) {
        unitEl.textContent = getSpeedUnitLabel();
    }
}

function applyTheme() {
    const theme = settings.theme || 'auto';
    let resolved;
    if (theme === 'auto') {
        resolved = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } else {
        resolved = theme;
    }
    document.documentElement.setAttribute('data-theme', resolved);
}

// Listen for system theme changes when in auto mode
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if ((settings.theme || 'auto') === 'auto') applyTheme();
});

function getSpeedUnitLabel() {
    switch (settings.speed_unit) {
        case 'mph': return 'mph';
        case 'kn': return 'kn';
        case 'ms': return 'm/s';
        default: return 'km/h';
    }
}

function convertSpeed(kmh) {
    switch (settings.speed_unit) {
        case 'mph': return kmh * 0.621371;
        case 'kn': return kmh * 0.539957;
        case 'ms': return kmh / 3.6;
        default: return kmh;
    }
}

function showSettings() {
    applySettings();
    document.getElementById('settings-modal').style.display = 'flex';

    // Live update range displays (use property to avoid stacking)
    document.querySelectorAll('.range-input').forEach(el => {
        el.oninput = () => {
            const valueEl = el.nextElementSibling;
            if (valueEl && valueEl.classList.contains('range-value')) {
                valueEl.textContent = el.value;
            }
        };
    });
}

function closeSettings() {
    document.getElementById('settings-modal').style.display = 'none';
}

async function saveAndCloseSettings() {
    // Gather all settings from form
    const data = {};
    document.querySelectorAll('[data-key]').forEach(el => {
        const key = el.dataset.key;
        if (el.type === 'checkbox') {
            data[key] = el.checked;
        } else if (el.type === 'range') {
            data[key] = parseFloat(el.value);
        } else if (el.tagName === 'SELECT') {
            data[key] = el.value;
        }
    });

    const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    settings = await res.json();
    applySettings();
    closeSettings();
    showToast('Settings saved');

    // Re-render overlays with new settings
    if (gpsData.length > 0) syncOverlays();
    if (gsensorData.length > 0) {
        drawGSensorGraph(gsensorData);
    }
}

async function resetSettings() {
    const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _reset: true }),
    });
    settings = await res.json();
    applySettings();
    showToast('Settings reset to defaults');
}

// --- API ---

async function loadConfig() {
    const res = await fetch('/api/config');
    const data = await res.json();
    document.getElementById('current-folder').textContent = data.root;
    document.getElementById('folder-input').value = data.root;
}

async function loadFiles() {
    const category = getActiveFilter('type-filter');
    const camera = getActiveFilter('camera-filter');
    const date = document.getElementById('date-filter').value;

    const params = new URLSearchParams();
    if (category !== 'all') params.set('category', category);
    if (camera !== 'all') params.set('camera', camera);
    if (date) params.set('date', date);

    const res = await fetch('/api/files?' + params);
    const data = await res.json();

    allFiles = data.files;
    filteredFiles = data.files;
    applyTimeRangeFilter();
    updateDateFilter(data.dates);
    loadStats();
}

async function loadStats() {
    const res = await fetch('/api/stats');
    const data = await res.json();
    document.getElementById('stat-files').textContent = data.total_files;
    document.getElementById('stat-size').textContent = data.total_size;
}

// --- Rendering ---

function renderFileList(files) {
    if (files.length === 0) {
        fileList.innerHTML = '';
        fileList.appendChild(emptyState);
        emptyState.style.display = 'flex';
        return;
    }

    emptyState.style.display = 'none';
    let html = '';
    let lastDate = '';

    for (const f of files) {
        if (f.date !== lastDate) {
            lastDate = f.date;
            html += `<div style="padding:6px 16px;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;background:var(--bg-tertiary);border-bottom:1px solid var(--border);">${formatDate(f.date)}</div>`;
        }

        const isActive = currentFile && currentFile.path === f.path;
        const showThumbs = settings.show_thumbnails !== false;
        const batchCb = batchMode
            ? `<input type="checkbox" class="batch-cb" ${batchSelected.has(f.path) ? 'checked' : ''} onclick="event.stopPropagation(); toggleBatchFile('${f.path.replace(/'/g, "\\'")}', this.checked)">`
            : '';
        html += `
            <div class="file-item ${isActive ? 'active' : ''}" onclick="playFile(${JSON.stringify(f).replace(/"/g, '&quot;')})">
                ${batchCb}
                <div class="file-type-indicator ${f.category}"></div>
                ${showThumbs ? `<img class="file-thumb" src="/api/thumb/${encodeURIComponent(f.path)}" loading="lazy" alt="">` : ''}
                <div class="file-details">
                    <div class="file-name">${f.time} — ${f.type_label}</div>
                    <div class="file-meta">
                        <span>${f.size_human}</span>
                        <span>${f.camera}</span>
                    </div>
                    <div class="file-badges">
                        ${f.has_pair ? '<span class="file-badge dual">2CH</span>' : ''}
                        ${f.has_gps ? '<span class="file-badge gps">GPS</span>' : ''}
                        ${f.has_gsensor ? '<span class="file-badge gsensor">G</span>' : ''}
                    </div>
                </div>
            </div>
        `;
    }

    fileList.innerHTML = html;
}

function updateDateFilter(dates) {
    const select = document.getElementById('date-filter');
    const current = select.value;
    // Also check saved filter for date
    let savedDate = current;
    try {
        const saved = JSON.parse(localStorage.getItem('dashview_filters'));
        if (saved && saved.date && !current) savedDate = saved.date;
    } catch (e) {}

    select.innerHTML = '<option value="">All dates</option>';
    for (const d of dates) {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = formatDate(d);
        if (d === savedDate) opt.selected = true;
        select.appendChild(opt);
    }
}

function formatDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// --- Playback ---

function playFile(file) {
    currentFile = file;
    gpsData = [];
    gsensorData = [];
    trimIn = null;
    trimOut = null;
    updateTrimUI();
    welcomeScreen.style.display = 'none';
    playerArea.style.display = 'flex';

    // Close sidebar on mobile
    if (window.innerWidth <= 900) {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebar-overlay').classList.remove('open');
    }

    // Update info bar
    const typeBadge = document.getElementById('player-type-badge');
    typeBadge.textContent = file.category.charAt(0).toUpperCase() + file.category.slice(1);
    typeBadge.className = 'badge ' + file.category;

    document.getElementById('player-camera-badge').textContent =
        file.camera.charAt(0).toUpperCase() + file.camera.slice(1);
    document.getElementById('player-datetime').textContent =
        `${formatDate(file.date)} at ${file.time}`;

    // Load video
    video.src = '/api/video/' + encodeURIComponent(file.path);
    video.load();
    video.play().catch(() => {});

    // Load preview strip for seek bar hover
    loadPreviewStrip(file.path);

    // Load rear camera for PiP if viewing front
    loadPiPVideo(file);

    // Re-show PiP if it was visible
    if (isPiPVisible) {
        const pipContainer = document.getElementById('pip-container');
        if (pipVideo.src) {
            pipContainer.style.display = 'block';
        }
    }

    // Update file list highlighting
    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
    const items = document.querySelectorAll('.file-item');
    items.forEach(el => {
        if (el.querySelector('.file-name')?.textContent.includes(file.time)) {
            el.classList.add('active');
        }
    });

    // Load GPS data
    if (file.has_gps) {
        loadGPS(file.path);
    } else {
        document.getElementById('video-hud').style.display = 'none';
        document.getElementById('hud-minimap').style.display = 'none';
    }

    // Load G-sensor data
    if (file.has_gsensor) {
        loadGSensor(file.path);
    } else {
        document.getElementById('data-panel').style.display = 'none';
        document.getElementById('hud-gsensor').style.display = 'none';
    }
}

// --- PiP (Picture-in-Picture for rear camera) ---

function loadPiPVideo(file) {
    // Clear any previous PiP state
    pipVideo.pause();
    pipVideo.removeAttribute('src');
    pipVideo.load();

    // Determine other camera type
    const otherCamera = file.camera === 'front' ? 'R' : 'F';
    const baseName = file.filename.replace(/[FR]\.mp4$/i, '');
    const otherFilename = baseName + otherCamera + '.mp4';

    // Build path: same directory as current file
    const dirPart = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/') + 1) : '';
    const otherPath = dirPart + otherFilename;

    const pipLabel = file.camera === 'front' ? 'REAR' : 'FRONT';
    document.getElementById('pip-container').querySelector('.pip-label').textContent = pipLabel;

    const pipUrl = '/api/video/' + encodeURIComponent(otherPath);

    // Check if the paired file exists
    fetch(pipUrl, { method: 'HEAD' }).then(res => {
        if (!res.ok) {
            // No paired file — hide PiP, don't count as user-disabled
            document.getElementById('pip-container').style.display = 'none';
            document.getElementById('toggle-pip-btn').classList.remove('active');
            isPiPVisible = false;
            return;
        }

        pipVideo.src = pipUrl;
        pipVideo.load();

        pipVideo.onloadedmetadata = () => {
            pipVideo.currentTime = video.currentTime;
            // Auto-enable PiP if user hasn't explicitly disabled it
            if (!pipUserDisabled) {
                isPiPVisible = true;
            }
            if (isPiPVisible) {
                document.getElementById('pip-container').style.display = 'block';
                document.getElementById('toggle-pip-btn').classList.add('active');
                if (!video.paused) pipVideo.play().catch(() => {});
            }
        };

        pipVideo.onerror = () => {
            document.getElementById('pip-container').style.display = 'none';
            document.getElementById('toggle-pip-btn').classList.remove('active');
            isPiPVisible = false;
        };
    }).catch(() => {
        document.getElementById('pip-container').style.display = 'none';
        isPiPVisible = false;
    });
}

function togglePiP() {
    isPiPVisible = !isPiPVisible;
    pipUserDisabled = !isPiPVisible; // user explicitly toggled it off
    const container = document.getElementById('pip-container');
    const btn = document.getElementById('toggle-pip-btn');

    if (isPiPVisible && pipVideo.src) {
        container.style.display = 'block';
        btn.classList.add('active');
        pipVideo.currentTime = video.currentTime;
        if (!video.paused) pipVideo.play().catch(() => {});
    } else {
        container.style.display = 'none';
        btn.classList.remove('active');
        isPiPVisible = false;
    }
}

function setupPiPDrag() {
    const pip = document.getElementById('pip-container');
    const resizeHandle = document.getElementById('pip-resize');
    let dragging = false;
    let resizing = false;
    let startX, startY, startLeft, startTop, startW, startH;

    // Drag to move
    pip.addEventListener('mousedown', (e) => {
        if (e.target === resizeHandle || e.target.closest('#pip-resize')) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = pip.offsetLeft;
        startTop = pip.offsetTop;
        e.preventDefault();
    });

    // Resize from corner handle
    resizeHandle.addEventListener('mousedown', (e) => {
        resizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startW = pip.offsetWidth;
        startH = pip.offsetHeight;
        e.preventDefault();
        e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
        if (dragging) {
            pip.style.left = (startLeft + e.clientX - startX) + 'px';
            pip.style.top = (startTop + e.clientY - startY) + 'px';
            pip.style.right = 'auto';
            pip.style.bottom = 'auto';
        } else if (resizing) {
            const newW = Math.max(160, startW + e.clientX - startX);
            const newH = Math.round(newW * 9 / 16); // maintain 16:9
            pip.style.width = newW + 'px';
            pip.style.height = newH + 'px';
        }
    });

    document.addEventListener('mouseup', () => {
        dragging = false;
        resizing = false;
    });
}

function togglePlay() {
    if (video.paused) {
        video.play();
    } else {
        video.pause();
    }
}

function skipTime(seconds) {
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
}

function cycleSpeed() {
    currentSpeedIdx = (currentSpeedIdx + 1) % playbackSpeeds.length;
    const speed = playbackSpeeds[currentSpeedIdx];
    video.playbackRate = speed;
    pipVideo.playbackRate = speed;
    document.getElementById('speed-btn').textContent = speed + 'x';
}

function toggleFullscreen() {
    if (document.fullscreenElement) {
        document.exitFullscreen();
        playerArea.classList.remove('fullscreen');
    } else {
        playerArea.requestFullscreen();
        playerArea.classList.add('fullscreen');
    }
}

function toggleOverlays() {
    isOverlayVisible = !isOverlayVisible;
    const btn = document.getElementById('toggle-overlay-btn');
    btn.classList.toggle('active', isOverlayVisible);
    updateOverlayVisibility();
}

function updateOverlayVisibility() {
    const show = isOverlayVisible;
    const hud = document.getElementById('video-hud');
    const gsensorHud = document.getElementById('hud-gsensor');
    const minimap = document.getElementById('hud-minimap');

    if (show && gpsData.length > 0) {
        hud.style.display = 'flex';
        hud.style.opacity = settings.overlay_opacity || 0.85;
        hud.style.transform = `scale(${settings.overlay_scale || 1})`;

        if (settings.overlay_minimap) {
            minimap.style.display = 'block';
            minimap.style.opacity = settings.overlay_opacity || 0.85;
            if (minimapInstance) {
                setTimeout(() => minimapInstance.invalidateSize(), 50);
            }
        } else {
            minimap.style.display = 'none';
        }
    } else {
        hud.style.display = 'none';
        minimap.style.display = 'none';
    }

    if (show && gsensorData.length > 0 && settings.overlay_gsensor) {
        gsensorHud.style.display = 'flex';
        gsensorHud.style.opacity = settings.overlay_opacity || 0.85;
        gsensorHud.style.transform = `scale(${settings.overlay_scale || 1})`;
    } else {
        gsensorHud.style.display = 'none';
    }

    // Per-element toggles
    document.getElementById('hud-speed').style.display = settings.overlay_speed ? '' : 'none';
    document.getElementById('hud-coords').style.display = settings.overlay_coordinates ? '' : 'none';
    document.getElementById('hud-heading').style.display = settings.overlay_heading ? '' : 'none';
    document.getElementById('hud-altitude').style.display = settings.overlay_altitude ? '' : 'none';
}

// --- Video Events ---

function setupVideoEvents() {
    video.addEventListener('play', () => {
        updatePlayButton(true);
        overlay.classList.remove('visible');
        // Sync PiP
        if (isPiPVisible && pipVideo.src) {
            pipVideo.currentTime = video.currentTime;
            pipVideo.play().catch(() => {});
        }
    });

    video.addEventListener('pause', () => {
        updatePlayButton(false);
        overlay.classList.add('visible');
        if (pipVideo.src) pipVideo.pause();
    });

    video.addEventListener('ended', () => {
        updatePlayButton(false);
        overlay.classList.add('visible');
        if (pipVideo.src) pipVideo.pause();
        if (settings.auto_play_next) playNextFile();
    });

    video.addEventListener('timeupdate', () => {
        updateProgress();
        syncOverlays();
        syncPiP();
    });

    video.addEventListener('seeked', () => {
        syncOverlays();
        if (pipVideo.src) {
            pipVideo.currentTime = video.currentTime;
        }
    });

    video.addEventListener('loadedmetadata', () => {
        document.getElementById('time-duration').textContent = formatTime(video.duration);
    });

    video.addEventListener('progress', () => {
        if (video.buffered.length > 0) {
            const buffered = video.buffered.end(video.buffered.length - 1) / video.duration * 100;
            document.getElementById('progress-buffered').style.width = buffered + '%';
        }
    });

    document.getElementById('video-wrapper').addEventListener('click', (e) => {
        // Don't toggle play when clicking overlays/HUD/PiP
        if (e.target === video || e.target.closest('.video-overlay')) {
            togglePlay();
        }
    });

    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement) {
            playerArea.classList.remove('fullscreen');
        }
    });
}

function syncPiP() {
    if (!isPiPVisible || !pipVideo.src || !video.duration) return;
    // Keep PiP within 0.3s of main video
    if (Math.abs(pipVideo.currentTime - video.currentTime) > 0.3) {
        pipVideo.currentTime = video.currentTime;
    }
}

// --- Time-synced overlay updates ---

function syncOverlays() {
    if (!video.duration) return;
    const progress = video.currentTime / video.duration;

    // Sync GPS overlay
    if (gpsData.length > 0) {
        const point = getInterpolatedGPSPoint(progress);
        if (point) {
            // Speed
            const speed = convertSpeed(point.speed || 0);
            document.getElementById('hud-speed-value').textContent = Math.round(speed);
            document.getElementById('hud-speed-unit').textContent = getSpeedUnitLabel();

            // Coordinates
            document.getElementById('hud-lat').textContent = point.lat.toFixed(5);
            document.getElementById('hud-lng').textContent = point.lng.toFixed(5);

            // Heading
            if (point.heading !== undefined && point.heading !== null) {
                const needle = document.getElementById('hud-compass-needle');
                needle.setAttribute('transform', `rotate(${point.heading} 20 20)`);
                document.getElementById('hud-heading-value').textContent = Math.round(point.heading) + '\u00B0';
            }

            // Altitude
            if (point.alt !== undefined && point.alt !== null) {
                document.getElementById('hud-alt-value').textContent = Math.round(point.alt);
                if (settings.overlay_altitude) {
                    document.getElementById('hud-altitude').style.display = '';
                }
            }

            // Update map marker position
            updateMapMarker(point);
            updateMinimapMarker(point);
        }
    }

    // Sync G-sensor overlay
    if (gsensorData.length > 0) {
        const idx = Math.min(Math.floor(progress * gsensorData.length), gsensorData.length - 1);
        const g = gsensorData[idx];
        if (g) {
            document.getElementById('hud-gx').textContent = g.x.toFixed(2);
            document.getElementById('hud-gy').textContent = g.y.toFixed(2);
            document.getElementById('hud-gz').textContent = g.z.toFixed(2);
            drawGDial(g);
        }

        // Update cursor on G-sensor graph
        const cursor = document.getElementById('gsensor-cursor');
        const graphWrap = cursor.parentElement;
        cursor.style.left = (progress * graphWrap.offsetWidth) + 'px';
        cursor.style.display = 'block';
    }
}

function getInterpolatedGPSPoint(progress) {
    if (gpsData.length === 0) return null;

    // If points have timestamps, use them for accurate sync
    const hasTimestamps = gpsData[0].time_ms !== null && gpsData[0].time_ms !== undefined;
    if (hasTimestamps && gpsData.length >= 2) {
        // Normalize timestamps to be relative to the first point
        const t0 = gpsData[0].time_ms;
        const tEnd = gpsData[gpsData.length - 1].time_ms;
        const gpsDuration = tEnd - t0;

        if (gpsDuration > 0) {
            // Map video progress to GPS timeline
            const currentGpsTime = t0 + progress * gpsDuration;

            // Find surrounding points
            let before = gpsData[0], after = gpsData[gpsData.length - 1];
            for (let i = 0; i < gpsData.length - 1; i++) {
                if (gpsData[i].time_ms <= currentGpsTime && gpsData[i + 1].time_ms > currentGpsTime) {
                    before = gpsData[i];
                    after = gpsData[i + 1];
                    break;
                }
            }
            const range = after.time_ms - before.time_ms;
            if (range <= 0) return before;
            const t = (currentGpsTime - before.time_ms) / range;
            return interpolatePoints(before, after, Math.max(0, Math.min(1, t)));
        }
    }

    // Fall back to even distribution across video duration
    const exactIdx = progress * (gpsData.length - 1);
    const idx = Math.floor(exactIdx);
    const t = exactIdx - idx;

    if (idx >= gpsData.length - 1) return gpsData[gpsData.length - 1];
    return interpolatePoints(gpsData[idx], gpsData[idx + 1], t);
}

function interpolatePoints(a, b, t) {
    return {
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
        speed: (a.speed || 0) + ((b.speed || 0) - (a.speed || 0)) * t,
        heading: interpolateAngle(a.heading, b.heading, t),
        alt: a.alt !== undefined && b.alt !== undefined ?
            a.alt + (b.alt - a.alt) * t : (a.alt || b.alt || null),
    };
}

function interpolateAngle(a, b, t) {
    if (a === undefined || a === null || b === undefined || b === null) return a || b || null;
    let diff = b - a;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    return (a + diff * t + 360) % 360;
}

// --- G-sensor dial (mini force visualizer) ---

function drawGDial(g) {
    const canvas = document.getElementById('hud-g-dial');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const s = 60;
    canvas.width = s * 2;
    canvas.height = s * 2;
    ctx.scale(2, 2);

    const cx = s / 2, cy = s / 2, r = s / 2 - 4;
    ctx.clearRect(0, 0, s, s);

    // Background circle
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Crosshair
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();

    // Force dot (X = left/right, Y = forward/back)
    const maxG = 3;
    const dx = Math.max(-1, Math.min(1, g.y / maxG)) * r;
    const dy = Math.max(-1, Math.min(1, -g.x / maxG)) * r;

    ctx.beginPath();
    ctx.arc(cx + dx, cy + dy, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#6366f1';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
}

// --- Progress / Time ---

function updatePlayButton(playing) {
    const icon = document.getElementById('play-icon');
    if (playing) {
        icon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    } else {
        icon.innerHTML = '<path d="M8 5v14l11-7z"/>';
    }
    const largeBtn = document.getElementById('play-btn-large');
    if (playing) {
        largeBtn.innerHTML = '<svg width="60" height="60" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    } else {
        largeBtn.innerHTML = '<svg width="60" height="60" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    }
}

function updateProgress() {
    if (!video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    document.getElementById('progress-played').style.width = pct + '%';
    document.getElementById('progress-handle').style.left = pct + '%';
    document.getElementById('time-current').textContent = formatTime(video.currentTime);
}

function formatTime(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function playNextFile() {
    if (!currentFile || filteredFiles.length === 0) return;
    const idx = filteredFiles.findIndex(f => f.path === currentFile.path);
    if (idx < 0) return;

    // If PiP or dual view is active, skip rear files — play next front
    for (let i = idx + 1; i < filteredFiles.length; i++) {
        const next = filteredFiles[i];
        if ((isPiPVisible || isDualView) && next.camera === 'rear') continue;
        playFile(next);
        return;
    }
}

// --- Progress Bar ---

function setupProgressBar() {
    const container = document.getElementById('progress-container');
    let dragging = false;

    function seek(e) {
        const rect = container.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        video.currentTime = pct * video.duration;
    }

    container.addEventListener('mousedown', (e) => {
        dragging = true;
        seek(e);
    });

    document.addEventListener('mousemove', (e) => {
        if (dragging) seek(e);
    });

    document.addEventListener('mouseup', () => { dragging = false; });
}

// --- Filters ---

function setupFilterEvents() {
    // Restore saved filters
    restoreFilters();

    document.querySelectorAll('.filter-chips').forEach(group => {
        group.addEventListener('click', (e) => {
            const chip = e.target.closest('.chip');
            if (!chip) return;
            group.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            saveFilters();
            loadFiles();
        });
    });

    document.getElementById('date-filter').addEventListener('change', () => {
        saveFilters();
        loadFiles();
    });

    // Time range filter
    document.getElementById('time-from').addEventListener('change', () => {
        saveFilters();
        applyTimeRangeFilter();
    });
    document.getElementById('time-to').addEventListener('change', () => {
        saveFilters();
        applyTimeRangeFilter();
    });
}

function saveFilters() {
    const filters = {
        type: getActiveFilter('type-filter'),
        camera: getActiveFilter('camera-filter'),
        date: document.getElementById('date-filter').value,
        timeFrom: document.getElementById('time-from').value,
        timeTo: document.getElementById('time-to').value,
    };
    localStorage.setItem('dashview_filters', JSON.stringify(filters));
}

function restoreFilters() {
    try {
        const saved = JSON.parse(localStorage.getItem('dashview_filters'));
        if (!saved) return;

        // Restore type filter
        if (saved.type) {
            const typeGroup = document.getElementById('type-filter');
            typeGroup.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            const match = typeGroup.querySelector(`[data-value="${saved.type}"]`);
            if (match) match.classList.add('active');
        }

        // Restore camera filter
        if (saved.camera) {
            const camGroup = document.getElementById('camera-filter');
            camGroup.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            const match = camGroup.querySelector(`[data-value="${saved.camera}"]`);
            if (match) match.classList.add('active');
        }

        // Restore date (will be applied after dates load)
        if (saved.date) {
            document.getElementById('date-filter').value = saved.date;
        }

        // Restore time range
        if (saved.timeFrom) document.getElementById('time-from').value = saved.timeFrom;
        if (saved.timeTo) document.getElementById('time-to').value = saved.timeTo;
        if (saved.timeFrom || saved.timeTo) {
            document.getElementById('time-range-clear').style.display = '';
        }
    } catch (e) {}
}

function applyTimeRangeFilter() {
    const fromEl = document.getElementById('time-from');
    const toEl = document.getElementById('time-to');
    const clearBtn = document.getElementById('time-range-clear');
    const from = fromEl.value; // "HH:MM" or ""
    const to = toEl.value;

    clearBtn.style.display = (from || to) ? '' : 'none';

    if (!from && !to) {
        filteredFiles = allFiles;
    } else {
        filteredFiles = allFiles.filter(f => {
            const t = f.time; // "HH:MM:SS"
            if (from && t < from) return false;
            if (to && t > to + ':59') return false;
            return true;
        });
    }

    renderFileList(filteredFiles);
}

function clearTimeRange() {
    document.getElementById('time-from').value = '';
    document.getElementById('time-to').value = '';
    document.getElementById('time-range-clear').style.display = 'none';
    saveFilters();
    filteredFiles = allFiles;
    renderFileList(filteredFiles);
}

function getActiveFilter(groupId) {
    const group = document.getElementById(groupId);
    const active = group.querySelector('.chip.active');
    return active ? active.dataset.value : 'all';
}

// --- Map (side panel) ---

function toggleMap() {
    isMapVisible = !isMapVisible;
    const panel = document.getElementById('map-panel');
    const btn = document.getElementById('toggle-map-btn');

    if (isMapVisible) {
        panel.style.display = 'block';
        btn.classList.add('active');
        // Defer map init/resize to after the browser has laid out the panel
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (!mapInstance) {
                    initMap();
                } else {
                    mapInstance.invalidateSize();
                }
                if (gpsData.length > 0) renderMapTrack();
            });
        });
    } else {
        panel.style.display = 'none';
        btn.classList.remove('active');
    }
}

function initMap() {
    mapInstance = L.map('map', {
        zoomControl: true,
        attributionControl: true,
    }).setView([38.8977, -77.0365], 13); // Default: White House, Washington DC

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?language=en', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19,
        language: 'en',
    }).addTo(mapInstance);

    setTimeout(() => mapInstance.invalidateSize(), 100);
}

function renderMapTrack() {
    if (!mapInstance || gpsData.length === 0) return;

    if (mapTrack) { mapInstance.removeLayer(mapTrack); mapTrack = null; }
    if (mapMarker) { mapInstance.removeLayer(mapMarker); mapMarker = null; }

    const latlngs = gpsData.map(p => [p.lat, p.lng]);

    mapTrack = L.polyline(latlngs, {
        color: '#6366f1', weight: 3, opacity: 0.8,
    }).addTo(mapInstance);

    mapMarker = L.circleMarker(latlngs[0], {
        radius: 7, fillColor: '#34d399', fillOpacity: 1,
        color: '#fff', weight: 2,
    }).addTo(mapInstance);

    mapInstance.fitBounds(mapTrack.getBounds(), { padding: [30, 30] });
}

function updateMapMarker(point) {
    if (!mapMarker || !mapInstance) return;
    mapMarker.setLatLng([point.lat, point.lng]);
}

// --- Mini-map (overlay on video) ---

function initMinimap() {
    if (minimapInstance) return;

    const size = settings.minimap_size || 200;
    const container = document.getElementById('hud-minimap');
    container.style.width = size + 'px';
    container.style.height = size + 'px';

    minimapInstance = L.map('minimap', {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        boxZoom: false,
        keyboard: false,
    }).setView([38.8977, -77.0365], settings.minimap_zoom || 16); // Default: White House, Washington DC

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?language=en', {
        maxZoom: 19,
        language: 'en',
    }).addTo(minimapInstance);

    setTimeout(() => minimapInstance.invalidateSize(), 150);
}

function renderMinimapTrack() {
    if (!minimapInstance || gpsData.length === 0) return;

    if (minimapTrack) { minimapInstance.removeLayer(minimapTrack); minimapTrack = null; }
    if (minimapMarker) { minimapInstance.removeLayer(minimapMarker); minimapMarker = null; }

    const latlngs = gpsData.map(p => [p.lat, p.lng]);

    minimapTrack = L.polyline(latlngs, {
        color: '#6366f1', weight: 2, opacity: 0.6,
    }).addTo(minimapInstance);

    minimapMarker = L.circleMarker(latlngs[0], {
        radius: 5, fillColor: '#34d399', fillOpacity: 1,
        color: '#fff', weight: 2,
    }).addTo(minimapInstance);

    minimapInstance.setView(latlngs[0], settings.minimap_zoom || 16);
}

function updateMinimapMarker(point) {
    if (!minimapMarker || !minimapInstance) return;
    minimapMarker.setLatLng([point.lat, point.lng]);
    minimapInstance.panTo([point.lat, point.lng], { animate: false });
}

// --- GPS Loading ---

async function loadGPS(filepath) {
    const res = await fetch('/api/gps/' + encodeURIComponent(filepath));
    const data = await res.json();

    if (!data.available || data.points.length === 0) {
        gpsData = [];
        document.getElementById('video-hud').style.display = 'none';
        document.getElementById('hud-minimap').style.display = 'none';
        return;
    }

    gpsData = data.points;

    // Show overlays
    if (isOverlayVisible) {
        document.getElementById('video-hud').style.display = 'flex';
        updateOverlayVisibility();

        if (settings.overlay_minimap) {
            document.getElementById('hud-minimap').style.display = 'block';
            initMinimap();
            renderMinimapTrack();
        }
    }

    // Render side-panel map track if visible
    if (isMapVisible) {
        if (!mapInstance) initMap();
        renderMapTrack();
    }
}

// --- G-Sensor ---

async function loadGSensor(filepath) {
    const res = await fetch('/api/gsensor/' + encodeURIComponent(filepath));
    const data = await res.json();

    if (!data.available || data.data.length === 0) {
        gsensorData = [];
        document.getElementById('data-panel').style.display = 'none';
        document.getElementById('hud-gsensor').style.display = 'none';
        document.getElementById('event-markers').innerHTML = '';
        return;
    }

    gsensorData = data.data;

    // Show G-sensor graph — defer draw to let the browser lay out the panel first
    const dataPanel = document.getElementById('data-panel');
    dataPanel.style.display = 'block';
    dataPanel.style.height = (settings.gsensor_graph_height || 160) + 'px';
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            drawGSensorGraph(gsensorData);
        });
    });

    // Show G-sensor overlay
    if (isOverlayVisible && settings.overlay_gsensor) {
        document.getElementById('hud-gsensor').style.display = 'flex';
    }

    // Add event markers to progress bar
    updateEventMarkers();
}

let gsensorDrawRetries = 0;

function drawGSensorGraph(data) {
    const canvas = document.getElementById('gsensor-canvas');
    if (!canvas) return;
    const wrap = canvas.parentElement;
    if (!wrap) return;

    // Force explicit pixel dimensions from the parent
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;

    // If layout hasn't happened yet, retry (max 10 times)
    if (w < 10 || h < 10) {
        if (gsensorDrawRetries < 10) {
            gsensorDrawRetries++;
            setTimeout(() => drawGSensorGraph(data), 150);
        }
        return;
    }
    gsensorDrawRetries = 0;

    // Set canvas size explicitly
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);

    ctx.clearRect(0, 0, w, h);

    // Calculate baseline using median of entire clip
    // This removes gravity/mounting bias so all axes center at zero
    const getMedian = (arr) => {
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const baseline = {
        x: getMedian(data.map(d => d.x)),
        y: getMedian(data.map(d => d.y)),
        z: getMedian(data.map(d => d.z)),
    };

    // Find the max deviation from baseline to auto-scale
    let maxDev = 0.5; // minimum range of +/- 0.5G
    for (let j = 0; j < data.length; j++) {
        maxDev = Math.max(maxDev,
            Math.abs(data[j].x - baseline.x),
            Math.abs(data[j].y - baseline.y),
            Math.abs(data[j].z - baseline.z)
        );
    }
    maxDev = Math.ceil(maxDev * 2) / 2 + 0.25; // round up to nearest 0.5G + padding

    // Zero line
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    const gridStep = maxDev > 2 ? 1 : 0.5;
    for (let gVal = gridStep; gVal <= maxDev; gVal += gridStep) {
        for (const sign of [1, -1]) {
            const y = h / 2 - (sign * gVal / maxDev) * (h / 2);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
    }

    // Scale label
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '10px sans-serif';
    ctx.fillText(`\u00B1${maxDev.toFixed(1)}G`, 4, 12);

    const colors = ['#6366f1', '#34d399', '#f87171'];

    ['x', 'y', 'z'].forEach((axis, i) => {
        ctx.strokeStyle = colors[i];
        ctx.lineWidth = 2;
        ctx.beginPath();

        const base = baseline[axis];
        const pad = 8; // pixels of padding top and bottom
        const drawH = h - pad * 2;
        for (let j = 0; j < data.length; j++) {
            const x = (j / data.length) * w;
            const val = data[j][axis] - base;
            const y = pad + drawH / 2 - (val / maxDev) * (drawH / 2);
            if (j === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    });

    // Overlay speed graph if GPS data available
    if (gpsData.length > 0) {
        drawSpeedGraph(ctx, w, h, gpsData);
    }
}

// --- Mobile Sidebar ---

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('open');
}

// Close sidebar when a file is played on mobile
// --- Seek Bar Preview ---

let previewStripUrl = null;
let previewStripLoaded = false;
const PREVIEW_FRAMES = 30;
const PREVIEW_FRAME_W = 160;
const PREVIEW_FRAME_H = 90;

function loadPreviewStrip(filePath) {
    previewStripLoaded = false;
    previewStripUrl = null;

    if (settings.show_preview_strip === false) return;

    const url = '/api/preview-strip/' + encodeURIComponent(filePath);
    const img = new Image();
    img.onload = () => {
        previewStripUrl = url;
        previewStripLoaded = true;
    };
    img.src = url;
}

function setupSeekPreview() {
    const container = document.getElementById('progress-container');
    const tooltip = document.getElementById('preview-tooltip');
    const thumb = document.getElementById('preview-thumb');
    const timeEl = document.getElementById('preview-time');

    container.addEventListener('mousemove', (e) => {
        if (!previewStripLoaded || !video.duration || settings.show_preview_strip === false) {
            tooltip.style.display = 'none';
            return;
        }

        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const progress = Math.max(0, Math.min(1, x / rect.width));
        const frameIdx = Math.min(Math.floor(progress * PREVIEW_FRAMES), PREVIEW_FRAMES - 1);

        // Position the background to show the correct frame
        thumb.style.backgroundImage = `url(${previewStripUrl})`;
        thumb.style.backgroundPosition = `-${frameIdx * PREVIEW_FRAME_W}px 0`;
        thumb.style.backgroundSize = `${PREVIEW_FRAMES * PREVIEW_FRAME_W}px ${PREVIEW_FRAME_H}px`;

        // Time label
        timeEl.textContent = formatTime(progress * video.duration);

        // Position tooltip
        tooltip.style.display = 'block';
        const tipW = PREVIEW_FRAME_W;
        let tipX = x - tipW / 2;
        tipX = Math.max(0, Math.min(rect.width - tipW, tipX));
        tooltip.style.left = tipX + 'px';
    });

    container.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
    });
}

// --- Graph Hover Tooltip ---

function setupGraphHover() {
    const wrap = document.getElementById('gsensor-graph-wrap');
    const tooltip = document.getElementById('gsensor-tooltip');
    if (!wrap || !tooltip) return;

    wrap.addEventListener('mousemove', (e) => {
        if (gsensorData.length === 0) {
            tooltip.style.display = 'none';
            return;
        }
        const rect = wrap.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const progress = x / rect.width;
        const idx = Math.min(Math.floor(progress * gsensorData.length), gsensorData.length - 1);
        const g = gsensorData[idx];
        if (!g) return;

        let html = `<span style="color:#6366f1">X ${g.x.toFixed(2)}</span> `;
        html += `<span style="color:#34d399">Y ${g.y.toFixed(2)}</span> `;
        html += `<span style="color:#f87171">Z ${g.z.toFixed(2)}</span>`;

        // Add speed if GPS available
        if (gpsData.length > 0) {
            const gpsIdx = Math.min(Math.floor(progress * gpsData.length), gpsData.length - 1);
            const p = gpsData[gpsIdx];
            if (p) {
                const speed = convertSpeed(p.speed);
                const unit = getSpeedUnitLabel();
                html += ` <span style="color:#fbbf24">${Math.round(speed)} ${unit}</span>`;
            }
        }

        // Add time
        if (video.duration) {
            const time = progress * video.duration;
            html += ` <span style="color:var(--text-muted)">${formatTime(time)}</span>`;
        }

        tooltip.innerHTML = html;
        tooltip.style.display = 'block';
        // Position tooltip near cursor, but keep within bounds
        const tipW = tooltip.offsetWidth;
        let tipX = x - tipW / 2;
        tipX = Math.max(0, Math.min(rect.width - tipW, tipX));
        tooltip.style.left = tipX + 'px';
    });

    wrap.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
    });

    // Click on graph to seek video
    wrap.addEventListener('click', (e) => {
        if (!video.duration) return;
        const rect = wrap.getBoundingClientRect();
        const progress = (e.clientX - rect.left) / rect.width;
        video.currentTime = progress * video.duration;
    });
}

// --- Folder Picker ---

async function showFolderPicker() {
    document.getElementById('folder-modal').style.display = 'flex';
    document.getElementById('folder-input').focus();

    // Load folder history
    try {
        const res = await fetch('/api/folder-history');
        const data = await res.json();
        const historyDiv = document.getElementById('folder-history');
        const listDiv = document.getElementById('folder-history-list');

        if (data.history && data.history.length > 0) {
            historyDiv.style.display = 'block';
            listDiv.innerHTML = data.history.map(path =>
                `<button class="folder-history-item" onclick="selectHistoryFolder('${path.replace(/'/g, "\\'")}')">${path}</button>`
            ).join('');
        } else {
            historyDiv.style.display = 'none';
        }
    } catch (e) {}
}

function selectHistoryFolder(path) {
    document.getElementById('folder-input').value = path;
    setFolder();
}

function closeFolderPicker() {
    document.getElementById('folder-modal').style.display = 'none';
}

async function setFolder() {
    const path = document.getElementById('folder-input').value.trim();
    if (!path) return;

    const res = await fetch('/api/set-root', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
    });

    const data = await res.json();
    if (data.error) {
        showToast('Error: ' + data.error);
        return;
    }

    document.getElementById('current-folder').textContent = data.root;
    closeFolderPicker();
    loadFiles();
    loadDashcamInfo();
    triggerTracksBuild();
    showToast('Folder updated');
}

// --- Keyboard ---

function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

        switch (e.key) {
            case ' ':
                e.preventDefault();
                togglePlay();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                skipTime(e.shiftKey ? -30 : -10);
                break;
            case 'ArrowRight':
                e.preventDefault();
                skipTime(e.shiftKey ? 30 : 10);
                break;
            case 'f':
                toggleFullscreen();
                break;
            case 'm':
                toggleMap();
                break;
            case 'h':
                toggleOverlays();
                break;
            case 'p':
                togglePiP();
                break;
            case 'ArrowUp':
                e.preventDefault();
                navigateFiles(-1);
                break;
            case 'ArrowDown':
                e.preventDefault();
                navigateFiles(1);
                break;
            case ',':
                e.preventDefault();
                skipTime(-1/30); // Frame back
                break;
            case '.':
                e.preventDefault();
                skipTime(1/30); // Frame forward
                break;
            case 's':
                takeScreenshot();
                break;
            case 'i':
                setTrimIn();
                break;
            case 'o':
                if (!e.ctrlKey && !e.metaKey) setTrimOut();
                break;
            case 'd':
                toggleDualView();
                break;
            case '?':
                toggleShortcutsHelp();
                break;
        }
    });
}

function navigateFiles(direction) {
    if (!filteredFiles.length) return;
    if (!currentFile) {
        playFile(filteredFiles[0]);
        return;
    }
    const idx = filteredFiles.findIndex(f => f.path === currentFile.path);
    const newIdx = idx + direction;
    if (newIdx >= 0 && newIdx < filteredFiles.length) {
        playFile(filteredFiles[newIdx]);
    }
}

// --- Dashcam Info ---

async function loadDashcamInfo() {
    try {
        const res = await fetch('/api/dashcam/info');
        const data = await res.json();

        if (data.version) {
            const infoPanel = document.getElementById('dashcam-info');
            infoPanel.style.display = 'block';

            const model = data.version.model || 'Unknown';
            const fw = data.version.firmware_version || '--';
            const lang = data.version.language || '';
            const configVer = data.version.config_version || '';

            document.getElementById('dashcam-model').textContent = 'DR' + model;
            document.getElementById('dashcam-fw').textContent = `FW ${fw}` + (configVer ? ` \u2022 Cfg ${configVer}` : '') + (lang ? ` \u2022 ${lang}` : '');
        }
    } catch (e) {
        // No dashcam info available
    }
}

// --- Dashcam Config Editor ---

async function showDashcamConfig() {
    document.getElementById('config-modal').style.display = 'flex';
    const editor = document.getElementById('config-editor');
    editor.innerHTML = '<div class="empty-state"><div class="loading"></div><p>Loading configuration...</p></div>';

    try {
        const res = await fetch('/api/dashcam/config');
        if (!res.ok) {
            editor.innerHTML = '<div class="empty-state"><p>Config file not found on SD card.</p><p style="font-size:12px;color:var(--text-muted);">Make sure the dashcam folder contains Config/config.ini</p></div>';
            return;
        }
        const data = await res.json();
        dashcamConfig = data.config;
        configSchema = data.schema;
        renderConfigEditor();
    } catch (e) {
        editor.innerHTML = '<div class="empty-state"><p>Failed to load config.</p></div>';
    }
}

function renderConfigEditor() {
    const editor = document.getElementById('config-editor');
    let html = '';

    for (const [sectionKey, sectionSchema] of Object.entries(configSchema)) {
        const label = sectionSchema._label || sectionKey;
        const desc = sectionSchema._description || '';

        html += `<div class="config-section">`;
        html += `<div class="config-section-header">`;
        html += `<h4>${label}</h4>`;
        if (desc) html += `<p class="config-section-desc">${desc}</p>`;
        html += `</div>`;

        for (const [key, schema] of Object.entries(sectionSchema)) {
            if (key.startsWith('_')) continue;

            // Look up value from the original ini section
            const iniSection = schema._section || sectionKey;
            const sectionData = dashcamConfig[iniSection] || {};
            const currentVal = sectionData[key] !== undefined ? sectionData[key] : '';
            const inputId = `cfg-${sectionKey}-${key}`;

            html += `<div class="config-row">`;
            html += `<div class="config-row-info">`;
            html += `<label for="${inputId}">${schema.label || key}</label>`;
            html += `<span class="config-desc">${schema.description || ''}</span>`;
            html += `</div>`;
            html += `<div class="config-row-input">`;

            if (schema.type === 'select') {
                html += `<select id="${inputId}" class="select-input select-sm" data-section="${iniSection}" data-key="${key}">`;
                for (const [optVal, optLabel] of Object.entries(schema.options)) {
                    const selected = String(currentVal) === String(optVal) ? 'selected' : '';
                    html += `<option value="${optVal}" ${selected}>${optLabel}</option>`;
                }
                html += `</select>`;
            } else if (schema.type === 'range') {
                const min = schema.min || 0;
                const max = schema.max || 10;
                html += `<div class="config-range-wrap">`;
                html += `<input type="range" id="${inputId}" class="range-input" min="${min}" max="${max}" value="${currentVal}" data-section="${iniSection}" data-key="${key}">`;
                html += `<span class="range-value config-range-val" id="${inputId}-val">${currentVal}${schema.labels && schema.labels[currentVal] ? ' (' + schema.labels[currentVal] + ')' : ''}</span>`;
                html += `</div>`;
            } else if (schema.type === 'number') {
                html += `<input type="number" id="${inputId}" class="text-input text-input-sm" value="${currentVal}" data-section="${iniSection}" data-key="${key}" min="${schema.min || 0}" max="${schema.max || 99999}">`;
            } else if (schema.type === 'password') {
                html += `<input type="password" id="${inputId}" class="text-input text-input-sm" value="${currentVal}" data-section="${iniSection}" data-key="${key}" autocomplete="off">`;
            } else if (schema.type === 'readonly') {
                html += `<span class="config-readonly">${currentVal || '--'}</span>`;
            } else {
                // text
                html += `<input type="text" id="${inputId}" class="text-input text-input-sm" value="${currentVal}" data-section="${iniSection}" data-key="${key}" placeholder="${schema.placeholder || ''}">`;
            }

            html += `</div></div>`;
        }

        html += `</div>`;
    }

    editor.innerHTML = html;

    // Wire up range value displays
    editor.querySelectorAll('input[type="range"]').forEach(el => {
        el.addEventListener('input', () => {
            const valEl = document.getElementById(el.id + '-val');
            if (valEl) {
                const sectionKey = el.dataset.section;
                const key = el.dataset.key;
                const schema = configSchema[sectionKey]?.[key];
                let display = el.value;
                if (schema?.labels && schema.labels[el.value]) {
                    display += ' (' + schema.labels[el.value] + ')';
                }
                valEl.textContent = display;
            }
        });
    });
}

async function saveDashcamConfig() {
    if (!dashcamConfig) return;

    // Gather all values from the form
    const editor = document.getElementById('config-editor');
    editor.querySelectorAll('[data-section][data-key]').forEach(el => {
        const section = el.dataset.section;
        const key = el.dataset.key;
        if (!dashcamConfig[section]) dashcamConfig[section] = {};
        dashcamConfig[section][key] = el.value;
    });

    try {
        const res = await fetch('/api/dashcam/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: dashcamConfig }),
        });

        const data = await res.json();
        if (data.success) {
            showToast('Config saved! Eject SD card safely and insert into dashcam to apply.');
            closeConfigModal();
        } else {
            showToast('Error: ' + (data.error || 'Failed to save'));
        }
    } catch (e) {
        showToast('Error saving config: ' + e.message);
    }
}

function closeConfigModal() {
    document.getElementById('config-modal').style.display = 'none';
}

// --- Trim (In/Out points) ---

let trimIn = null;  // seconds
let trimOut = null;  // seconds

function setTrimIn() {
    if (!video.duration) return;
    trimIn = video.currentTime;
    if (trimOut !== null && trimOut <= trimIn) trimOut = null;
    updateTrimUI();
    showToast(`In: ${formatTime(trimIn)}`);
}

function setTrimOut() {
    if (!video.duration) return;
    trimOut = video.currentTime;
    if (trimIn !== null && trimIn >= trimOut) trimIn = null;
    updateTrimUI();
    showToast(`Out: ${formatTime(trimOut)}`);
}

function clearTrim() {
    trimIn = null;
    trimOut = null;
    updateTrimUI();
    showToast('Trim cleared');
}

function updateTrimUI() {
    const region = document.getElementById('trim-region');
    const inHandle = document.getElementById('trim-in-handle');
    const outHandle = document.getElementById('trim-out-handle');
    const clearBtn = document.getElementById('btn-trim-clear');
    const display = document.getElementById('trim-display');
    const duration = video.duration || 1;

    const hasAny = trimIn !== null || trimOut !== null;
    clearBtn.style.display = hasAny ? '' : 'none';

    if (trimIn !== null) {
        const pct = (trimIn / duration) * 100;
        inHandle.style.display = 'block';
        inHandle.style.left = pct + '%';
    } else {
        inHandle.style.display = 'none';
    }

    if (trimOut !== null) {
        const pct = (trimOut / duration) * 100;
        outHandle.style.display = 'block';
        outHandle.style.left = pct + '%';
    } else {
        outHandle.style.display = 'none';
    }

    // Show selected region
    if (trimIn !== null || trimOut !== null) {
        const start = trimIn !== null ? (trimIn / duration) * 100 : 0;
        const end = trimOut !== null ? (trimOut / duration) * 100 : 100;
        region.style.display = 'block';
        region.style.left = start + '%';
        region.style.width = (end - start) + '%';

        // Show trim duration
        const tIn = trimIn !== null ? trimIn : 0;
        const tOut = trimOut !== null ? trimOut : duration;
        const trimDuration = tOut - tIn;
        display.style.display = '';
        display.textContent = `[${formatTime(tIn)} \u2013 ${formatTime(tOut)}] ${formatTime(trimDuration)}`;
    } else {
        region.style.display = 'none';
        display.style.display = 'none';
    }
}

// --- Frame stepping ---

function stepFrame(direction) {
    video.pause();
    // Seek by ~1 frame. Most dashcams record at 30fps.
    const frameTime = 1 / 30;
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + direction * frameTime));
}

// --- Export ---

function showExportModal() {
    if (!currentFile) {
        showToast('No video selected');
        return;
    }
    document.getElementById('export-modal').style.display = 'flex';
    document.getElementById('export-file-info').textContent =
        `${currentFile.filename} (${currentFile.size_human})`;

    // Check if rear file exists for PiP option
    const otherCamera = currentFile.camera === 'front' ? 'R' : 'F';
    const baseName = currentFile.filename.replace(/[FR]\.mp4$/i, '');
    const otherFilename = baseName + otherCamera + '.mp4';
    const dirPart = currentFile.path.includes('/') ? currentFile.path.substring(0, currentFile.path.lastIndexOf('/') + 1) : '';
    const otherPath = dirPart + otherFilename;

    const pipCheckbox = document.getElementById('export-pip');
    const updateExportUI = () => {
        const pipOn = pipCheckbox.checked && !pipCheckbox.disabled;
        const redactOn = document.getElementById('export-redact-top').checked || document.getElementById('export-redact-bottom').checked;
        document.getElementById('export-pip-options').style.opacity = pipOn ? '1' : '0.4';
        document.getElementById('export-pip-scale-row').style.opacity = pipOn ? '1' : '0.4';
        document.getElementById('export-reencode-warning').style.display = (pipOn || redactOn) ? 'block' : 'none';
        document.getElementById('export-redact-size-row').style.display = redactOn ? 'flex' : 'none';
    };
    pipCheckbox.onchange = updateExportUI;
    document.getElementById('export-redact-top').onchange = updateExportUI;
    document.getElementById('export-redact-bottom').onchange = updateExportUI;

    fetch('/api/video/' + encodeURIComponent(otherPath), { method: 'HEAD' }).then(res => {
        const hasPair = res.ok;
        pipCheckbox.checked = hasPair;
        pipCheckbox.disabled = !hasPair;
        if (!hasPair) {
            document.getElementById('export-file-info').textContent += ' (no rear camera file)';
        }
        updateExportUI();
    }).catch(() => {
        pipCheckbox.checked = false;
        pipCheckbox.disabled = true;
        updateExportUI();
    });

    // Show trim section if trim points are set
    const hasTrim = trimIn !== null || trimOut !== null;
    const trimSection = document.getElementById('export-trim-section');
    trimSection.style.display = hasTrim ? 'block' : 'none';
    if (hasTrim) {
        const tIn = trimIn !== null ? trimIn : 0;
        const tOut = trimOut !== null ? trimOut : (video.duration || 60);
        const dur = tOut - tIn;
        document.getElementById('export-trim-info').textContent =
            `${formatTime(tIn)} \u2013 ${formatTime(tOut)} (${formatTime(dur)})`;
        document.getElementById('export-use-trim').checked = true;
    }

    // Reset status
    document.getElementById('export-status').style.display = 'none';
    document.getElementById('export-start-btn').disabled = false;
    document.getElementById('export-start-btn').textContent = 'Export';
}

function closeExportModal() {
    document.getElementById('export-modal').style.display = 'none';
}

async function startExport() {
    if (!currentFile) return;

    const includePip = document.getElementById('export-pip').checked;
    const removeAudio = document.getElementById('export-no-audio').checked;
    const pipPosition = document.getElementById('export-pip-position').value;
    const pipScale = parseFloat(document.getElementById('export-pip-scale').value);
    const redactTop = document.getElementById('export-redact-top').checked;
    const redactBottom = document.getElementById('export-redact-bottom').checked;
    const redactSize = parseInt(document.getElementById('export-redact-size').value);
    const useTrim = document.getElementById('export-use-trim').checked && (trimIn !== null || trimOut !== null);
    const trimStart = useTrim ? (trimIn || 0) : null;
    const trimEnd = useTrim ? (trimOut || (video.duration || null)) : null;

    // Show progress
    document.getElementById('export-status').style.display = 'flex';
    document.getElementById('export-status-text').textContent = 'Exporting... this may take a minute';
    document.getElementById('export-start-btn').disabled = true;
    document.getElementById('export-start-btn').textContent = 'Exporting...';

    try {
        const res = await fetch('/api/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file: currentFile.path,
                pip: includePip,
                no_audio: removeAudio,
                pip_position: pipPosition,
                pip_scale: pipScale,
                redact_top: redactTop,
                redact_bottom: redactBottom,
                redact_size: redactSize,
                trim_start: trimStart,
                trim_end: trimEnd,
            }),
        });

        const data = await res.json();

        if (data.success) {
            document.getElementById('export-status-text').textContent = 'Done! Downloading...';

            // Trigger download
            const a = document.createElement('a');
            a.href = data.download_url;
            a.download = data.filename;
            document.body.appendChild(a);
            a.click();
            a.remove();

            setTimeout(() => closeExportModal(), 1500);
            if (data.warning) {
                showToast(data.warning);
            } else {
                showToast('Export complete: ' + data.filename);
            }
        } else {
            document.getElementById('export-status-text').textContent = 'Error: ' + (data.error || 'Export failed');
            showToast('Export failed: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        document.getElementById('export-status-text').textContent = 'Error: ' + e.message;
        showToast('Export error: ' + e.message);
    }

    document.getElementById('export-start-btn').disabled = false;
    document.getElementById('export-start-btn').textContent = 'Export';
}

// --- View Toggle (Files vs Trips) ---

let currentView = 'files';

function setView(view) {
    currentView = view;
    document.getElementById('view-files-tab').classList.toggle('active', view === 'files');
    document.getElementById('view-trips-tab').classList.toggle('active', view === 'trips');

    if (view === 'trips') {
        loadTrips();
    } else {
        loadFiles();
    }
}

async function loadTrips() {
    const res = await fetch('/api/trips');
    const data = await res.json();
    renderTrips(data.trips);
}

function renderTrips(trips) {
    if (trips.length === 0) {
        fileList.innerHTML = '<div class="empty-state"><p>No trips detected</p></div>';
        return;
    }

    const showThumbs = settings.show_thumbnails !== false;
    let html = '';
    for (const trip of trips) {
        const catBadges = Object.entries(trip.categories).map(([cat, count]) =>
            `<span class="file-badge ${cat}">${count} ${cat}</span>`
        ).join(' ');

        const thumbHtml = showThumbs
            ? `<img class="trip-thumb" src="/api/thumb/${encodeURIComponent(trip.first_path)}" loading="lazy" alt="">`
            : '';

        const pathsJson = JSON.stringify(trip.file_paths).replace(/"/g, '&quot;');
        html += `
            <div class="trip-card" data-first="${trip.first_file}" data-last="${trip.last_file}">
                <div class="trip-main" onclick="expandTrip(this.parentElement)">
                    ${thumbHtml}
                    <div class="trip-info">
                        <div class="trip-header">
                            <span class="trip-date">${formatDate(trip.date)}</span>
                            <span class="trip-time">${trip.start_time} \u2013 ${trip.end_time}</span>
                        </div>
                        <div class="trip-stats">
                            <span>${trip.clip_count} clips</span>
                            <span>${trip.duration}</span>
                            <span>${trip.size}</span>
                            ${trip.has_gps ? '<span class="file-badge gps">GPS</span>' : ''}
                        </div>
                        <div class="trip-categories">
                            ${catBadges}
                            ${trip.clip_count >= 2 ? `<button class="btn-trip-merge" onclick="event.stopPropagation(); mergeTrip(${pathsJson}, this)" title="Merge this trip into one video">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                                </svg>
                                Merge trip
                            </button>` : ''}
                        </div>
                    </div>
                </div>
                <div class="trip-files" style="display:none;"></div>
            </div>
        `;
    }
    fileList.innerHTML = html;
}

async function expandTrip(tripCard) {
    const filesDiv = tripCard.querySelector('.trip-files');

    // Toggle collapse
    if (filesDiv.style.display !== 'none') {
        filesDiv.style.display = 'none';
        tripCard.classList.remove('expanded');
        return;
    }

    tripCard.classList.add('expanded');
    filesDiv.style.display = 'block';

    // If already loaded, just show
    if (filesDiv.dataset.loaded) return;

    filesDiv.innerHTML = '<div style="padding:8px 16px;font-size:12px;color:var(--text-muted);">Loading...</div>';

    const firstFile = tripCard.dataset.first;
    const lastFile = tripCard.dataset.last;

    // Find clips in this trip from allFiles or fetch all
    const res = await fetch('/api/files');
    const data = await res.json();
    const allFilesUnfiltered = data.files;

    // Find first and last indices
    const firstIdx = allFilesUnfiltered.findIndex(f => f.filename === firstFile);
    const lastIdx = allFilesUnfiltered.findIndex(f => f.filename === lastFile);

    if (firstIdx < 0) {
        filesDiv.innerHTML = '<div style="padding:8px 16px;font-size:12px;color:var(--text-muted);">No files found</div>';
        return;
    }

    const tripFiles = allFilesUnfiltered.slice(firstIdx, lastIdx + 1).filter(f => f.camera === 'front');
    const showThumbs = settings.show_thumbnails !== false;

    let html = '';
    for (const f of tripFiles) {
        const thumbHtml = showThumbs
            ? `<img class="file-thumb" src="/api/thumb/${encodeURIComponent(f.path)}" loading="lazy" alt="">`
            : '';
        html += `
            <div class="file-item trip-file-item" onclick="playFileFromTrip(${JSON.stringify(f).replace(/"/g, '&quot;')})">
                <div class="file-type-indicator ${f.category}"></div>
                ${thumbHtml}
                <div class="file-details">
                    <div class="file-name">${f.time} — ${f.type_label}</div>
                    <div class="file-meta">
                        <span>${f.size_human}</span>
                    </div>
                    <div class="file-badges">
                        ${f.has_pair ? '<span class="file-badge dual">2CH</span>' : ''}
                        ${f.has_gps ? '<span class="file-badge gps">GPS</span>' : ''}
                        ${f.has_gsensor ? '<span class="file-badge gsensor">G</span>' : ''}
                    </div>
                </div>
            </div>
        `;
    }
    filesDiv.innerHTML = html;
    filesDiv.dataset.loaded = 'true';
}

function playFileFromTrip(file) {
    // Play without switching views — stay in trips tab
    playFile(file);
}

// --- SD Card Health ---

async function showSDHealth() {
    document.getElementById('sd-health-modal').style.display = 'flex';
    const content = document.getElementById('sd-health-content');
    content.innerHTML = '<div class="empty-state"><div class="loading"></div></div>';

    try {
        const res = await fetch('/api/sd-health');
        const data = await res.json();
        if (!data.available) {
            content.innerHTML = '<p>No files found.</p>';
            return;
        }
        renderSDHealth(data, content);
    } catch (e) {
        content.innerHTML = '<p>Failed to load SD health data.</p>';
    }
}

function renderSDHealth(data, container) {
    let html = '';

    // SD Card usage bar
    if (data.sd_total) {
        html += `
            <div class="sd-usage">
                <div class="sd-usage-bar">
                    <div class="sd-usage-fill" style="width:${data.sd_used_pct}%"></div>
                </div>
                <div class="sd-usage-labels">
                    <span>Used: ${data.sd_used_pct}%</span>
                    <span>Free: ${data.sd_free}</span>
                    <span>Total: ${data.sd_total}</span>
                </div>
            </div>
        `;
    }

    // Overview stats
    html += `
        <div class="sd-stats-grid">
            <div class="sd-stat"><span class="sd-stat-val">${data.total_files}</span><span class="sd-stat-label">Files</span></div>
            <div class="sd-stat"><span class="sd-stat-val">${data.total_size}</span><span class="sd-stat-label">Used by recordings</span></div>
            <div class="sd-stat"><span class="sd-stat-val">${data.total_duration}</span><span class="sd-stat-label">Recording time</span></div>
            <div class="sd-stat"><span class="sd-stat-val">${data.recording_days}</span><span class="sd-stat-label">Days</span></div>
        </div>
    `;

    // Category breakdown with visual bars
    const cats = data.by_category;
    const catColors = { normal: '#34d399', event: '#f87171', parking: '#fbbf24', impact: '#fb923c', manual: '#a78bfa', buffered: '#6366f1', timelapse: '#818cf8' };
    html += '<div class="sd-categories">';
    for (const [cat, info] of Object.entries(cats)) {
        const color = catColors[cat] || '#888';
        html += `
            <div class="sd-cat-row">
                <div class="sd-cat-bar-wrap">
                    <div class="sd-cat-bar" style="width:${info.pct}%;background:${color}"></div>
                </div>
                <span class="sd-cat-label" style="color:${color}">${cat}</span>
                <span class="sd-cat-info">${info.count} files \u2022 ${info.size_human} \u2022 ${info.pct}%</span>
            </div>
        `;
    }
    html += '</div>';

    // Camera split
    html += `
        <div class="sd-camera-split">
            <span>Front: ${data.by_camera.front || '0 B'}</span>
            <span>Rear: ${data.by_camera.rear || '0 B'}</span>
        </div>
    `;

    container.innerHTML = html;
}

// --- Event Markers on Progress Bar ---

function updateEventMarkers() {
    const container = document.getElementById('event-markers');
    if (!container) return;
    container.innerHTML = '';

    if (gsensorData.length < 10) return;

    // Find G-sensor peaks (spikes above threshold)
    const baseline = {
        x: getMedianOf(gsensorData.map(d => d.x)),
        y: getMedianOf(gsensorData.map(d => d.y)),
        z: getMedianOf(gsensorData.map(d => d.z)),
    };

    // Calculate magnitude of deviation for each sample
    const magnitudes = gsensorData.map(d =>
        Math.sqrt(
            Math.pow(d.x - baseline.x, 2) +
            Math.pow(d.y - baseline.y, 2) +
            Math.pow(d.z - baseline.z, 2)
        )
    );

    // Find threshold: mean + 2*stddev
    const mean = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;
    const stddev = Math.sqrt(magnitudes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / magnitudes.length);
    const threshold = mean + 2.5 * stddev;

    if (threshold < 0.3) return; // No significant events

    // Find peaks (local maxima above threshold)
    const peaks = [];
    const minGap = Math.floor(gsensorData.length * 0.02); // min 2% apart
    let lastPeakIdx = -minGap;

    for (let i = 1; i < magnitudes.length - 1; i++) {
        if (magnitudes[i] > threshold &&
            magnitudes[i] >= magnitudes[i - 1] &&
            magnitudes[i] >= magnitudes[i + 1] &&
            i - lastPeakIdx >= minGap) {
            peaks.push({ idx: i, magnitude: magnitudes[i] });
            lastPeakIdx = i;
        }
    }

    // Sort by magnitude, keep top 10
    peaks.sort((a, b) => b.magnitude - a.magnitude);
    const topPeaks = peaks.slice(0, 10);

    // Render markers
    for (const peak of topPeaks) {
        const pct = (peak.idx / gsensorData.length) * 100;
        const intensity = Math.min(1, (peak.magnitude - threshold) / (threshold * 2));
        const marker = document.createElement('div');
        marker.className = 'event-marker';
        marker.style.left = pct + '%';
        marker.style.opacity = 0.5 + intensity * 0.5;
        marker.title = `G-force spike: ${peak.magnitude.toFixed(2)}G at ${formatTime((peak.idx / gsensorData.length) * (video.duration || 60))}`;
        marker.onclick = (e) => {
            e.stopPropagation();
            video.currentTime = (peak.idx / gsensorData.length) * video.duration;
        };
        container.appendChild(marker);
    }
}

function getMedianOf(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// --- Screenshot ---

function takeScreenshot() {
    if (!video.videoWidth) {
        showToast('No video playing');
        return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    // If PiP is visible, composite it too
    if (isPiPVisible && pipVideo.src && pipVideo.videoWidth) {
        const scale = 0.25;
        const pw = video.videoWidth * scale;
        const ph = pipVideo.videoHeight * (pw / pipVideo.videoWidth);
        const margin = 10;
        ctx.drawImage(pipVideo, canvas.width - pw - margin, canvas.height - ph - margin, pw, ph);
    }

    canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = currentFile ? currentFile.filename.replace('.mp4', '') : 'screenshot';
        const time = formatTime(video.currentTime).replace(':', 'm') + 's';
        a.download = `${ts}_${time}.png`;
        a.href = url;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast('Screenshot saved');
    }, 'image/png');
}

// --- Keyboard Shortcuts Help ---

function toggleShortcutsHelp() {
    const existing = document.getElementById('shortcuts-modal');
    if (existing) {
        existing.style.display = existing.style.display === 'none' ? 'flex' : 'none';
        return;
    }
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'shortcuts-modal';
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
    modal.innerHTML = `
        <div class="modal" style="width:480px;">
            <div class="modal-header">
                <h3>Keyboard Shortcuts</h3>
                <button class="btn-icon" onclick="document.getElementById('shortcuts-modal').style.display='none'">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
            <div class="shortcuts-grid">
                <div class="shortcut-group">
                    <h4>Playback</h4>
                    <div class="shortcut-row"><kbd>Space</kbd><span>Play / Pause</span></div>
                    <div class="shortcut-row"><kbd>\u2190</kbd><span>Back 10s</span></div>
                    <div class="shortcut-row"><kbd>Shift+\u2190</kbd><span>Back 30s</span></div>
                    <div class="shortcut-row"><kbd>\u2192</kbd><span>Forward 10s</span></div>
                    <div class="shortcut-row"><kbd>Shift+\u2192</kbd><span>Forward 30s</span></div>
                    <div class="shortcut-row"><kbd>,</kbd><span>Frame back</span></div>
                    <div class="shortcut-row"><kbd>.</kbd><span>Frame forward</span></div>
                    <div class="shortcut-row"><kbd>I</kbd><span>Set in point</span></div>
                    <div class="shortcut-row"><kbd>O</kbd><span>Set out point</span></div>
                </div>
                <div class="shortcut-group">
                    <h4>Navigation</h4>
                    <div class="shortcut-row"><kbd>\u2191</kbd><span>Previous file</span></div>
                    <div class="shortcut-row"><kbd>\u2193</kbd><span>Next file</span></div>
                    <div class="shortcut-row"><kbd>F</kbd><span>Fullscreen</span></div>
                </div>
                <div class="shortcut-group">
                    <h4>Overlays & Views</h4>
                    <div class="shortcut-row"><kbd>H</kbd><span>Toggle overlays (HUD)</span></div>
                    <div class="shortcut-row"><kbd>P</kbd><span>Toggle PiP</span></div>
                    <div class="shortcut-row"><kbd>M</kbd><span>Toggle map</span></div>
                    <div class="shortcut-row"><kbd>D</kbd><span>Toggle dual view</span></div>
                    <div class="shortcut-row"><kbd>S</kbd><span>Screenshot</span></div>
                    <div class="shortcut-row"><kbd>?</kbd><span>This help</span></div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

// --- Dual View (side-by-side) ---

let isDualView = false;

function toggleDualView() {
    isDualView = !isDualView;
    const wrapper = document.getElementById('video-wrapper');
    const pipContainer = document.getElementById('pip-container');

    if (isDualView && pipVideo.src) {
        // Switch to side-by-side layout
        wrapper.classList.add('dual-view');
        pipContainer.style.display = 'block';
        pipContainer.classList.add('dual-mode');
        isPiPVisible = true;
        document.getElementById('toggle-pip-btn').classList.add('active');
        if (!video.paused) pipVideo.play().catch(() => {});
        pipVideo.currentTime = video.currentTime;
        showToast('Dual view: side by side');
    } else {
        wrapper.classList.remove('dual-view');
        pipContainer.classList.remove('dual-mode');
        isDualView = false;
        // Restore PiP to its normal floating style if it was visible
        if (isPiPVisible && pipVideo.src) {
            pipContainer.style.display = 'block';
        }
        showToast('PiP view');
    }
}

// --- Speed Graph on Timeline ---

function drawSpeedGraph(ctx, w, h, gpsPoints) {
    if (!gpsPoints || gpsPoints.length < 2) return;

    // Find max speed for scaling
    const speeds = gpsPoints.map(p => p.speed || 0);
    const maxSpeed = Math.max(10, ...speeds); // at least 10 km/h scale

    ctx.strokeStyle = 'rgba(251, 191, 36, 0.6)'; // yellow
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    for (let j = 0; j < gpsPoints.length; j++) {
        const x = (j / gpsPoints.length) * w;
        const speed = gpsPoints[j].speed || 0;
        const y = h - (speed / maxSpeed) * h * 0.8 - h * 0.1; // 10% margin top/bottom
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Max speed label
    const unit = getSpeedUnitLabel();
    const displayMax = convertSpeed(maxSpeed);
    ctx.fillStyle = 'rgba(251, 191, 36, 0.4)';
    ctx.font = '10px sans-serif';
    ctx.fillText(`${Math.round(displayMax)} ${unit}`, w - 60, 12);
}

// --- Multi-clip Merge ---

function showMergeModal() {
    document.getElementById('merge-modal').style.display = 'flex';
    mergeSelected.clear();

    // Pre-select: if current file is playing, auto-select sequential clips around it
    const files = filteredFiles.filter(f => f.camera === 'front');

    const showThumbs = settings.show_thumbnails !== false;
    let html = '';
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const thumbHtml = showThumbs
            ? `<img class="file-thumb" src="/api/thumb/${encodeURIComponent(f.path)}" loading="lazy" alt="">`
            : '';
        const isCurrentGroup = currentFile && isSequential(f, currentFile);

        html += `
            <label class="merge-item ${isCurrentGroup ? 'suggested' : ''}" data-path="${f.path}" data-idx="${i}">
                <input type="checkbox" class="merge-checkbox" value="${f.path}" onchange="updateMergeCount()">
                ${thumbHtml}
                <div class="merge-item-info">
                    <span class="merge-item-name">${f.date} ${f.time} — ${f.type_label}</span>
                    <span class="merge-item-meta">${f.size_human}</span>
                </div>
            </label>
        `;
    }
    document.getElementById('merge-list').innerHTML = html;

    // Auto-select clips from the current trip
    if (currentFile) {
        autoSelectTrip(files);
    }

    updateMergeCount();

    document.getElementById('merge-status').style.display = 'none';
    document.getElementById('merge-start-btn').disabled = false;
    document.getElementById('merge-start-btn').textContent = 'Merge & Download';
}

function isSequential(a, b) {
    // Two clips are sequential if they're within 2 minutes of each other
    return Math.abs(a.timestamp - b.timestamp) < 120;
}

function autoSelectTrip(files) {
    // Find the current file's index
    const idx = files.findIndex(f => f.filename === currentFile.filename);
    if (idx < 0) return;

    // Expand outward from current file, selecting sequential clips
    const selected = [idx];
    // Go backward
    for (let i = idx - 1; i >= 0; i--) {
        if (files[i + 1].timestamp - files[i].timestamp < 300) {
            selected.unshift(i);
        } else break;
    }
    // Go forward
    for (let i = idx + 1; i < files.length; i++) {
        if (files[i].timestamp - files[i - 1].timestamp < 300) {
            selected.push(i);
        } else break;
    }

    // Check the checkboxes
    const checkboxes = document.querySelectorAll('.merge-checkbox');
    selected.forEach(si => {
        if (checkboxes[si]) checkboxes[si].checked = true;
    });
}

function mergeSelectAll() {
    document.querySelectorAll('.merge-checkbox').forEach(cb => cb.checked = true);
    updateMergeCount();
}

function mergeSelectNone() {
    document.querySelectorAll('.merge-checkbox').forEach(cb => cb.checked = false);
    updateMergeCount();
}

function updateMergeCount() {
    const checked = document.querySelectorAll('.merge-checkbox:checked');
    const count = checked.length;
    document.getElementById('merge-count').textContent = `${count} clip${count !== 1 ? 's' : ''} selected`;
    document.getElementById('merge-start-btn').disabled = count < 2;
}

function closeMergeModal() {
    document.getElementById('merge-modal').style.display = 'none';
}

async function startMerge() {
    const checked = Array.from(document.querySelectorAll('.merge-checkbox:checked'));
    const paths = checked.map(cb => cb.value);

    if (paths.length < 2) {
        showToast('Select at least 2 clips');
        return;
    }

    const removeAudio = document.getElementById('merge-no-audio').checked;

    document.getElementById('merge-status').style.display = 'flex';
    document.getElementById('merge-status-text').textContent = `Merging ${paths.length} clips...`;
    document.getElementById('merge-start-btn').disabled = true;
    document.getElementById('merge-start-btn').textContent = 'Merging...';

    try {
        const res = await fetch('/api/merge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                files: paths,
                no_audio: removeAudio,
            }),
        });

        const data = await res.json();

        if (data.success) {
            document.getElementById('merge-status-text').textContent = `Done! ${data.size} — Downloading...`;

            const a = document.createElement('a');
            a.href = data.download_url;
            a.download = data.filename;
            document.body.appendChild(a);
            a.click();
            a.remove();

            setTimeout(() => closeMergeModal(), 2000);
            showToast(`Merged ${data.clip_count} clips: ${data.filename}`);
        } else {
            document.getElementById('merge-status-text').textContent = 'Error: ' + (data.error || 'Merge failed');
            showToast('Merge failed: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        document.getElementById('merge-status-text').textContent = 'Error: ' + e.message;
    }

    document.getElementById('merge-start-btn').disabled = false;
    document.getElementById('merge-start-btn').textContent = 'Merge & Download';
}

// --- All GPS Tracks Map ---

let tracksMapInstance = null;
let tracksPolling = null;

const catColors = {
    normal: '#34d399', event: '#f87171', parking: '#fbbf24',
    impact: '#fb923c', manual: '#a78bfa', buffered: '#6366f1',
};

function triggerTracksBuild() {
    if (settings.auto_build_gps_cache === false) return;
    // Fire and forget — starts background build on server if cache is missing
    fetch('/api/all-tracks').then(r => r.json()).then(data => {
        if (!data.ready && !data.building) {
            fetch('/api/all-tracks/build', { method: 'POST' });
        }
    }).catch(() => {});
}

async function showAllTracks() {
    document.getElementById('tracks-modal').style.display = 'flex';
    document.getElementById('tracks-count').textContent = 'Loading...';

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (!tracksMapInstance) {
                tracksMapInstance = L.map('tracks-map', {
                    zoomControl: true,
                }).setView([38.8977, -77.0365], 13);

                L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?language=en', {
                    attribution: '&copy; OSM &copy; CARTO',
                    maxZoom: 19, language: 'en',
                }).addTo(tracksMapInstance);
            } else {
                tracksMapInstance.invalidateSize();
                // Clear old tracks
                tracksMapInstance.eachLayer(layer => {
                    if (layer instanceof L.Polyline) tracksMapInstance.removeLayer(layer);
                });
            }
            checkAndLoadTracks();
        });
    });
}

async function checkAndLoadTracks() {
    try {
        const res = await fetch('/api/all-tracks');
        const data = await res.json();

        if (data.ready && data.count > 0) {
            // Cache ready — render immediately
            document.getElementById('tracks-count').textContent = `${data.count} tracks`;
            renderTracksOnMap(data.tracks);
            stopTracksPolling();
        } else if (data.building) {
            // Build in progress — show progress and poll
            updateTracksProgress(data.progress);
            startTracksPolling();
        } else {
            // No cache and not building — start build
            document.getElementById('tracks-count').textContent = 'Building GPS cache...';
            fetch('/api/all-tracks/build', { method: 'POST' });
            startTracksPolling();
        }
    } catch (e) {
        document.getElementById('tracks-count').textContent = 'Failed to load tracks';
    }
}

function updateTracksProgress(progress) {
    if (!progress) return;
    const pct = progress.pct || 0;
    const current = progress.current || 0;
    const total = progress.total || 0;
    document.getElementById('tracks-count').textContent =
        `Building GPS cache: ${current}/${total} files (${pct}%)`;
}

function startTracksPolling() {
    stopTracksPolling();
    tracksPolling = setInterval(async () => {
        try {
            const res = await fetch('/api/all-tracks');
            const data = await res.json();

            if (data.ready && data.count > 0) {
                document.getElementById('tracks-count').textContent = `${data.count} tracks`;
                renderTracksOnMap(data.tracks);
                stopTracksPolling();
            } else if (data.progress) {
                updateTracksProgress(data.progress);
            }
        } catch (e) {}
    }, 2000);
}

function stopTracksPolling() {
    if (tracksPolling) {
        clearInterval(tracksPolling);
        tracksPolling = null;
    }
}

function renderTracksOnMap(tracks) {
    const allBounds = [];

    for (const track of tracks) {
        if (track.points.length < 2) continue;
        const latlngs = track.points.map(p => [p.lat, p.lng]);
        const color = catColors[track.category] || '#6366f1';

        L.polyline(latlngs, {
            color: color, weight: 2.5, opacity: 0.5,
        }).addTo(tracksMapInstance)
          .bindPopup(`<b>${track.date} ${track.time}</b><br>${track.category} \u2014 ${track.file}`);

        allBounds.push(...latlngs);
    }

    if (allBounds.length > 0) {
        tracksMapInstance.fitBounds(allBounds, { padding: [30, 30] });
    }

    // Legend (only add once)
    if (!tracksMapInstance._legendAdded) {
        const legend = L.control({ position: 'bottomleft' });
        legend.onAdd = () => {
            const div = L.DomUtil.create('div', 'tracks-legend');
            div.innerHTML = Object.entries(catColors).map(([cat, color]) =>
                `<span style="color:${color}">\u25CF</span> ${cat}`
            ).join('&nbsp;&nbsp;');
            return div;
        };
        legend.addTo(tracksMapInstance);
        tracksMapInstance._legendAdded = true;
    }
}

function closeTracksModal() {
    document.getElementById('tracks-modal').style.display = 'none';
    stopTracksPolling();
}

// --- Batch Export ---

let batchMode = false;
let batchSelected = new Set();

function toggleBatchMode() {
    batchMode = !batchMode;
    document.getElementById('batch-toggle').classList.toggle('active', batchMode);
    document.getElementById('batch-bar').style.display = batchMode ? 'flex' : 'none';
    batchSelected.clear();
    updateBatchCount();
    // Re-render file list to show/hide checkboxes
    renderFileList(filteredFiles);
}

function batchSelectAll() {
    filteredFiles.forEach(f => batchSelected.add(f.path));
    document.querySelectorAll('.batch-cb').forEach(cb => cb.checked = true);
    updateBatchCount();
}

function batchSelectNone() {
    batchSelected.clear();
    document.querySelectorAll('.batch-cb').forEach(cb => cb.checked = false);
    updateBatchCount();
}

function toggleBatchFile(path, checked) {
    if (checked) batchSelected.add(path);
    else batchSelected.delete(path);
    updateBatchCount();
}

function updateBatchCount() {
    const n = batchSelected.size;
    document.getElementById('batch-count').textContent = `${n} selected`;
    document.getElementById('batch-export-btn').disabled = n === 0;
}

async function startBatchExport() {
    if (batchSelected.size === 0) return;

    const paths = Array.from(batchSelected);
    const btn = document.getElementById('batch-export-btn');
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = `Exporting ${paths.length}...`;

    try {
        const res = await fetch('/api/batch-export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: paths, no_audio: false }),
        });

        const data = await res.json();
        if (data.success) {
            const a = document.createElement('a');
            a.href = data.download_url;
            a.download = data.filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            showToast(`Batch export: ${data.file_count} files (${data.size})`);
        } else {
            showToast('Batch export failed: ' + (data.error || 'Unknown'));
        }
    } catch (e) {
        showToast('Batch export error: ' + e.message);
    }

    btn.disabled = false;
    btn.textContent = origText;
}

// --- Quick Trip Merge ---

async function mergeTrip(filePaths, btn) {
    if (!filePaths || filePaths.length < 2) {
        showToast('Trip has only 1 clip, nothing to merge');
        return;
    }

    const origText = btn.innerHTML;
    btn.innerHTML = '<div class="loading" style="width:14px;height:14px;border-width:2px;"></div> Merging...';
    btn.disabled = true;

    try {
        const res = await fetch('/api/merge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: filePaths, no_audio: false }),
        });

        const data = await res.json();

        if (data.success) {
            const a = document.createElement('a');
            a.href = data.download_url;
            a.download = data.filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            showToast(`Merged ${data.clip_count} clips (${data.size})`);
        } else {
            showToast('Merge failed: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        showToast('Merge error: ' + e.message);
    }

    btn.innerHTML = origText;
    btn.disabled = false;
}

// --- Toast ---

function showToast(message) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
}
