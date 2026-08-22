const MCPEBridge = {
    _targetFrameRate: null,
    _framePerfWindowStart: 0,
    _framePerfWindowCount: 0,

    getTargetFrameRate: function () {
        if (this._targetFrameRate !== null) {
            return this._targetFrameRate;
        }
        if (typeof window.__mcpeGetTargetFrameRate === 'function') {
            this._targetFrameRate = window.__mcpeGetTargetFrameRate() | 0;
            return this._targetFrameRate;
        }

        let rawValue = null;
        try {
            const params = new URLSearchParams(window.location.search || '');
            rawValue = params.get('mcpeFps') || params.get('fps');
        } catch (e) { }
        try {
            if (rawValue === null || rawValue === '') {
                rawValue = localStorage.getItem('mcpe_target_fps');
            }
        } catch (e) { }

        if (typeof rawValue === 'string') {
            const normalized = rawValue.trim().toLowerCase();
            if (normalized === 'raf' || normalized === 'native' || normalized === 'display') {
                this._targetFrameRate = 0;
                return this._targetFrameRate;
            }
            const parsed = Number(normalized);
            if (Number.isFinite(parsed)) {
                if (parsed <= 0) {
                    this._targetFrameRate = 0;
                } else {
                    this._targetFrameRate = Math.max(30, Math.min(240, parsed | 0));
                }
                return this._targetFrameRate;
            }
        }

        this._targetFrameRate = 140;
        return this._targetFrameRate;
    },

    getRenderDprCap: function () {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            return 1.0;
        }
        return 2.0;
    },

    getEffectiveDevicePixelRatio: function () {
        const dpr = window.devicePixelRatio || 1;
        const cap = this.getRenderDprCap();
        return Math.max(1, Math.min(dpr, cap));
    },

    noteFrameRendered: function () {
        const targetFps = this.getTargetFrameRate();
        if (targetFps <= 0 || !window.performance || typeof performance.now !== 'function') {
            return;
        }

        const now = performance.now();
        if (!this._framePerfWindowStart) {
            this._framePerfWindowStart = now;
            this._framePerfWindowCount = 0;
        }
        this._framePerfWindowCount++;

        const elapsed = now - this._framePerfWindowStart;
        if (elapsed < 1000) {
            return;
        }

        const fps = (this._framePerfWindowCount * 1000) / elapsed;
        window.__mcpeLastMeasuredFps = fps;
        this._framePerfWindowStart = now;
        this._framePerfWindowCount = 0;
    },

    abyssLeaderboard: {
        status: 'idle',
        entries: [],
        player: null,
        error: '',
        warning: '',
        lastScore: 0,
        lastUsername: '',
        lastUuid: '',
        _requestId: 0,

        reset: function () {
            this.status = 'idle';
            this.entries = [];
            this.player = null;
            this.error = '';
            this.warning = '';
        },

        _normalizeEntry: function (entry, fallbackRank) {
            if (!entry || typeof entry !== 'object') {
                return null;
            }
            return {
                rank: Math.max(1, Number(entry.rank || fallbackRank || 0) | 0),
                username: String(entry.username || 'Guest').slice(0, 32),
                lastScore: Math.max(0, Number(entry.lastScore || 0) | 0),
                highScore: Math.max(0, Number(entry.highScore || 0) | 0)
            };
        },

        _normalizePlayer: function (player) {
            if (!player || typeof player !== 'object') {
                return null;
            }
            return {
                rank: Math.max(1, Number(player.rank || 0) | 0),
                username: String(player.username || 'Guest').slice(0, 32),
                lastScore: Math.max(0, Number(player.lastScore || 0) | 0),
                highScore: Math.max(0, Number(player.highScore || 0) | 0)
            };
        }
    },

    // Filesystem Persistence
    // populate=true: load FROM IndexedDB into memory (first call)
    // populate=false: save FROM memory TO IndexedDB (subsequent calls)
    syncFS: function (populate) {
        return new Promise((resolve, reject) => {
            if (!window.FS || !window.FS.syncfs) {
                console.warn("Storage sync not initialized yet");
                return resolve();
            }
            const requestedPopulate = !!populate;
            if (!window._fsSyncQueue) {
                window._fsSyncQueue = [];
            }
            const runNext = (request) => {
                window._fsSyncInFlight = true;
                window.FS.syncfs(request.populate, (err) => {
                    if (err) {
                        console.error("Storage sync error:", err);
                        request.reject(err);
                    } else {
                        console.log(`Storage sync complete: ${request.populate ? 'Loaded from IndexedDB' : 'Saved to IndexedDB'}`);
                        request.resolve();
                    }
                    const next = window._fsSyncQueue.shift();
                    if (next) {
                        runNext(next);
                    } else {
                        window._fsSyncInFlight = false;
                        if (window._fsSyncQueued) {
                            window._fsSyncQueued = false;
                            setTimeout(() => {
                                MCPEBridge.syncFS(false).catch((queuedErr) => {
                                    console.error("Queued storage sync error:", queuedErr);
                                });
                            }, 0);
                        }
                    }
                });
            };
            // Guard against overlapping sync operations
            if (window._fsSyncInFlight) {
                window._fsSyncQueue.push({ populate: requestedPopulate, resolve, reject });
                if (!window._fsSyncQueueDrainScheduled) {
                    window._fsSyncQueueDrainScheduled = true;
                    const drainWhenAvailable = () => {
                        if (window._fsSyncInFlight) {
                            setTimeout(drainWhenAvailable, 0);
                            return;
                        }
                        window._fsSyncQueueDrainScheduled = false;
                        const next = window._fsSyncQueue.shift();
                        if (next) runNext(next);
                    };
                    setTimeout(drainWhenAvailable, 0);
                }
                return;
            }
            runNext({ populate: requestedPopulate, resolve, reject });
        });
    },

    // Keyboard Bridge
    keyboard: {
        visible: false,
        element: null,
        mode: 'default',
        _lastKeyTapAt: {},

        _isMultilineMode: function () {
            return this.mode === 'sign' || this.mode === 'multiline';
        },

        _applyMode: function () {
            if (!this.element) return;
            const multiline = this._isMultilineMode();
            this.element.enterKeyHint = multiline ? 'next' : 'done';
            this.element.rows = multiline ? 2 : 1;
            this.element.dataset.mode = this.mode;
        },

        setMode: function (mode) {
            this.mode = mode || 'default';
            if (!this.element) {
                this.init();
            } else {
                this._applyMode();
            }
        },

        _emitChars: function (text) {
            if (!text || !window.Module || !window.Module._onNativeChar) return;
            for (let i = 0; i < text.length; i++) {
                window.Module._onNativeChar(text.charCodeAt(i));
            }
        },

        _emitKeyTap: function (keyCode) {
            if (!keyCode || !window.Module || !window.Module._onNativeKey) return;
            const now = Date.now();
            if (this._lastKeyTapAt[keyCode] && (now - this._lastKeyTapAt[keyCode]) < 80) {
                return;
            }
            this._lastKeyTapAt[keyCode] = now;
            window.Module._onNativeKey(keyCode, 1);
            window.Module._onNativeKey(keyCode, 0);
        },

        _flushDeferredCanvasResize: function () {
            if (typeof window.__mcpeFlushDeferredCanvasResize !== 'function') {
                return;
            }
            setTimeout(function () {
                window.__mcpeFlushDeferredCanvasResize();
            }, 50);
        },


        init: function () {
            this.element = document.createElement('textarea');
            this.element.autocomplete = 'off';
            this.element.autocapitalize = 'off';
            this.element.spellcheck = false;
            this.element.wrap = 'off';
            this.element.style.position = 'fixed';
            this.element.style.left = '0px';
            this.element.style.top = '0px';
            this.element.style.width = '1px';
            this.element.style.height = '1px';
            this.element.style.opacity = '0.01';
            this.element.style.fontSize = '16px';
            this.element.style.resize = 'none';
            this.element.style.overflow = 'hidden';
            this.element.style.zIndex = '9999';
            document.body.appendChild(this.element);
            this._applyMode();

            this.element.addEventListener('input', (e) => {
                const inputType = e.inputType || '';
                const char = e.data;
                const value = this.element.value;

                if (inputType === 'deleteContentBackward') {
                    this._emitKeyTap(8);
                } else if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
                    this._emitKeyTap(13);
                } else if (char) {
                    this._emitChars(char);
                } else if (value && !char) {
                    this._emitChars(value);
                }
                this.element.value = '';
            });

            this.element.addEventListener('keydown', (e) => {
                let keyCode = 0;
                if (e.key === 'Backspace') keyCode = 8;
                else if (e.key === 'Enter') keyCode = 13;
                else if (e.key === 'Escape') keyCode = 27;
                if (keyCode > 0) {
                    this._emitKeyTap(keyCode);
                    if (keyCode === 13 && !this._isMultilineMode()) {
                        this.hide();
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }

                if (e.key === 'Backspace' || e.key === 'Enter' || e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                }
            });

            this.element.addEventListener('focus', () => {
                // Only set visible=true when focus actually succeeds.
                // This prevents resize deferral from triggering when keyboard
                // never actually opened (e.g., focus() silently ignored on mobile).
                this.visible = true;
            });

            this.element.addEventListener('blur', () => {
                // Mobile keyboards can be dismissed via the browser UI without
                // going through our explicit hideKeyboard path.
                this.visible = false;
                this._removeTapOverlay();
                this._flushDeferredCanvasResize();
            });
        },
        show: function () {
            if (!this.element) this.init();
            this._applyMode();

            // Try focusing immediately — works if we're inside a user gesture.
            // visible=true is set by the focus event handler, not here, to avoid
            // triggering resize deferral when focus silently fails on mobile.
            this.element.focus();

            // Check if focus succeeded synchronously
            if (document.activeElement === this.element) {
                this.visible = true;
            } else if (this._isTouchDevice()) {
                // On mobile, .focus() outside a user gesture is silently ignored.
                // Show a small overlay that the user can tap to bring up the keyboard.
                this._showTapOverlay();
            }
        },
        hide: function () {
            if (this.element) this.element.blur();
            this.visible = false;
            this.mode = 'default';
            this._applyMode();
            this._removeTapOverlay();
            this._flushDeferredCanvasResize();
        },
        _isTouchDevice: function () {
            try {
                if (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) return true;
                if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
            } catch (e) { }
            return false;
        },
        _showTapOverlay: function () {
            this._removeTapOverlay();
            const overlay = document.createElement('div');
            overlay.id = '_mcpe_tap_overlay';
            overlay.textContent = 'Tap to type';
            overlay.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
                'background:rgba(0,0,0,0.7);color:#fff;padding:16px 32px;border-radius:12px;' +
                'font-size:18px;font-family:sans-serif;z-index:10000;cursor:pointer;' +
                'user-select:none;-webkit-user-select:none;pointer-events:auto;';
            overlay.addEventListener('touchstart', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.element) this.element.focus();
                this._removeTapOverlay();
            }, { passive: false });
            overlay.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.element) this.element.focus();
                this._removeTapOverlay();
            });
            document.body.appendChild(overlay);
            this._tapOverlay = overlay;
        },
        _removeTapOverlay: function () {
            if (this._tapOverlay) {
                try { this._tapOverlay.remove(); } catch (e) { }
                this._tapOverlay = null;
            }
        }
    },

    // Networking Bridge (Signaling & WebRTC)
    network: {
        peer: null,
        peerId: null,

        // Performance Tracking
        stats: {
            ppsOut: 0,
            bpsOut: 0,
            ppsIn: 0,
            bpsIn: 0,
            bridgeCalls: 0,
            relaySentDirect: 0,
            relaySentQueued: 0,
            relayDropFull: 0,
            relayDropStale: 0,
            relayDropOversized: 0,
            relayDropBackpressure: 0,
            relayQueuePeakBytes: 0,
            relayQueueAgeMsP95: 0,
            relaySessionQueuedBytes: 0,
            relaySessionQueuedPackets: 0,
            relaySessionOldestAgeMs: 0,
            relayEnqueueRejected: 0,
            relayOverflowDisconnects: 0,
            relaySocketSendErrors: 0,
            relayFallbackUsed: 0,
            lastLogged: Date.now()
        },

        _initStatsTicker: function () {
            if (this._statsInterval) return;
            this._statsInterval = setInterval(() => {
                const now = Date.now();
                const delta = (now - this.stats.lastLogged) / 1000;
                if (delta < 1) return;

                const isIdle = !this.shouldLobbyBeActive() && !this.hasActivePeerConnections() && !this._relayHasBacklog() && this.stats.ppsOut === 0 && this.stats.ppsIn === 0 && this.stats.bridgeCalls === 0;
                if (isIdle) {
                    this._stopStatsTicker();
                    return;
                }

                this.stats.ppsOut = 0;
                this.stats.bpsOut = 0;
                this.stats.ppsIn = 0;
                this.stats.bpsIn = 0;
                this.stats.bridgeCalls = 0;
                this.stats.relaySentDirect = 0;
                this.stats.relaySentQueued = 0;
                this.stats.relayDropFull = 0;
                this.stats.relayDropStale = 0;
                this.stats.relayDropOversized = 0;
                this.stats.relayDropBackpressure = 0;
                this.stats.relayQueuePeakBytes = 0;
                this.stats.relayQueueAgeMsP95 = 0;
                this.stats.relaySessionQueuedBytes = 0;
                this.stats.relaySessionQueuedPackets = 0;
                this.stats.relaySessionOldestAgeMs = 0;
                this.stats.relayEnqueueRejected = 0;
                this.stats.relayOverflowDisconnects = 0;
                this.stats.relaySocketSendErrors = 0;
                this.stats.relayFallbackUsed = 0;
                this.stats.lastLogged = now;
            }, 5000);
        },


        _formatPeerDiagSummary: function () {
            const peers = Object.keys(this._peerDiagnostics || {});
            if (!peers.length) return '';
            peers.sort((a, b) => {
                const da = this._peerDiagnostics[a] || {};
                const db = this._peerDiagnostics[b] || {};
                const sa = (da.relayFallbacks || 0) + (da.duplicateIncomingRejected || 0);
                const sb = (db.relayFallbacks || 0) + (db.duplicateIncomingRejected || 0);
                return sb - sa;
            });
            const top = peers.slice(0, 2).map((peerId) => {
                const d = this._peerDiagnostics[peerId] || {};
                return `${peerId.slice(0, 8)}(d:${d.directSends || 0},rf:${d.relayFallbacks || 0},dup:${d.duplicateIncomingRejected || 0},dial:${d.dialAttempts || 0}/${d.dialCooldownSkips || 0})`;
            });
            return top.join(' ');
        },
        _stopStatsTicker: function () {
            if (!this._statsInterval) return;
            clearInterval(this._statsInterval);
            this._statsInterval = null;
        },
        ws: null,
        connections: {}, // targetFakeIp -> { conn: DataConnection, remotePort: number }
        ipToPeer: {},     // '192.168.1.x' -> peer_id
        peerToIp: {},     // peer_id -> '192.168.1.x'
        dedicatedServersById: {}, // serverId -> metadata
        dedicatedIpToServerId: {}, // fakeIp -> serverId
        dedicatedServerIdToIp: {}, // serverId -> fakeIp
        peerDisconnectState: {}, // fakeIp -> { peerId, remotePort }
        lastRemotePort: {}, // fakeIp -> last known remote port (from lobby or WebRTC)
        pendingPeerDisconnects: {}, // peerId -> timeout id
        _peerDisconnectGraceMs: 4000,
        _peerSessionState: {}, // peerId -> { state, at, reason }
        _peerDiagnostics: {}, // peerId -> counters
        _recentDialByPeer: {}, // peerId -> timestamp ms
        _dialCooldownMs: 1500,
        _maxDataChannelBufferedAmount: 512 * 1024,
        _maxDirectPeerPayloadBytes: 8 * 1024,
        _hostSocketCount: 0,
        _hasHostSocket: false,
        _cleanupAuthorized: false,
        _lastAdvertisedHost: false,
        _wsReconnectDelay: 1000,
        _wsReconnectTimer: null,
        _wsManualClose: false,
        _pageExitShutdownStarted: false,
        _shutdownDebounceTimer: null,
        _peerLibraryPromise: null,
        _peerInitPromise: null,
        _lastRelayUnavailableLog: 0,
        _maxWsBufferedAmount: 256 * 1024,
        _maxRelayQueueBytes: 512 * 1024,
        _peerVerificationGraceMs: 700,
        _maxRelayQueueAgeMs: 1500,
        _relayFlushTimer: null,
        _relayQueue: [],
        _relayQueueBytes: 0,
        _relayCapabilities: {
            protocolVersion: 1,
            binaryDedicatedUpload: false,
            received: false
        },
        _relayPressureScore: 0,
        _adaptiveWsBufferedAmount: 256 * 1024,
        _adaptiveRelayQueueBytes: 512 * 1024,
        _adaptiveRelayQueueAgeMs: 1500,
        _multiplayerIntent: {
            locating: false,
            remoteSession: false,
            publicHost: false
        },
        _joinSyncUntilByIp: {},
        _joinSyncGraceMs: 100,
        _joinWarmupQueueByIp: {},
        _joinWarmupTimerByIp: {},
        _joinWarmupAppliedByIp: {},
        _joinWarmupMaxPackets: 128,
        _nextIpSuffix: 2,
        _availableIpSuffixes: [],
        _networkHealthBanner: null,
        _networkHealthBannerHideTimer: null,
        _relayQualityByPeer: {},
        _allowUnauthenticatedPlayers: true,
        _playerHostRelayOnly: true,
        _peerTransportPlanKey: '',

        _getEffectiveIceServers: function () {
            if (Array.isArray(window.__MCPE_ICE_SERVERS) && window.__MCPE_ICE_SERVERS.length > 0) {
                return window.__MCPE_ICE_SERVERS;
            }
            return [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ];
        },

        _getConfiguredIceTransportPolicy: function () {
            if (window.__MCPE_ALLOW_DIRECT_PEERS === false) {
                return 'relay';
            }
            return window.__MCPE_ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all';
        },

        _hasTurnRelayConfig: function () {
            const iceServers = this._getEffectiveIceServers();
            for (let i = 0; i < iceServers.length; i++) {
                const entry = iceServers[i];
                if (!entry) continue;
                const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
                let hasTurnUrl = false;
                for (let j = 0; j < urls.length; j++) {
                    const url = typeof urls[j] === 'string' ? urls[j].trim() : '';
                    if (/^turns?:/i.test(url)) {
                        hasTurnUrl = true;
                        break;
                    }
                }
                if (!hasTurnUrl) continue;
                if (typeof entry.username === 'string' && entry.username &&
                    typeof entry.credential === 'string' && entry.credential) {
                    return true;
                }
            }
            return false;
        },

        _getPeerTransportPlan: function () {
            const configuredPolicy = this._getConfiguredIceTransportPolicy();
            const hasTurnRelay = this._hasTurnRelayConfig();
            const secureHostedSession = this._hasHostSocket && this._playerHostRelayOnly === true;

            if (secureHostedSession) {
                if (!hasTurnRelay) {
                    return {
                        key: 'relay-id',
                        usePeerTransport: false,
                        iceTransportPolicy: 'relay'
                    };
                }
                return {
                    key: 'peer-relay',
                    usePeerTransport: true,
                    iceTransportPolicy: 'relay'
                };
            }

            if (configuredPolicy === 'relay') {
                if (!hasTurnRelay) {
                    return {
                        key: 'relay-id',
                        usePeerTransport: false,
                        iceTransportPolicy: 'relay'
                    };
                }
                return {
                    key: 'peer-relay',
                    usePeerTransport: true,
                    iceTransportPolicy: 'relay'
                };
            }

            return {
                key: 'peer-all',
                usePeerTransport: true,
                iceTransportPolicy: 'all'
            };
        },

        _relayOnlyModeEnabled: function () {
            return this._getPeerTransportPlan().usePeerTransport !== true;
        },

        _generateRelayPeerId: function () {
            const parts = [];
            const pushHex = (value) => {
                parts.push((value >>> 0).toString(16));
            };

            if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
                const values = new Uint32Array(4);
                window.crypto.getRandomValues(values);
                for (let i = 0; i < values.length; i++) {
                    pushHex(values[i]);
                }
            } else {
                for (let i = 0; i < 4; i++) {
                    pushHex(Math.floor(Math.random() * 0xffffffff));
                }
            }

            pushHex(Date.now() & 0xffffffff);
            return `relay-${parts.join('-')}`;
        },

        _syncHostAdvertisement: function (reason) {
            const shouldAdvertise = this.shouldAdvertiseHost();
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return;
            }
            if (shouldAdvertise === this._lastAdvertisedHost) {
                return;
            }
            this._lastAdvertisedHost = shouldAdvertise;
            this.ws.send(JSON.stringify({
                type: shouldAdvertise ? 'host' : 'unhost',
                allowUnauthenticatedPlayers: this._allowUnauthenticatedPlayers !== false
            }));
        },


        _applyRuntimeRelayConfig: function () {
            const cfg = window.__MCPE_RELAY_CONFIG;
            if (!cfg || typeof cfg !== 'object') return;
            const clampInt = (value, fallback, min, max) => {
                const n = Number(value);
                if (!Number.isFinite(n)) return fallback;
                return Math.max(min, Math.min(max, Math.floor(n)));
            };
            const profile = (this._hasHostSocket && cfg.host && typeof cfg.host === 'object') ? cfg.host : cfg;
            let maxWs = clampInt(profile.maxWsBufferedAmount, this._maxWsBufferedAmount, 64 * 1024, 2 * 1024 * 1024);
            let maxQueue = clampInt(profile.maxRelayQueueBytes, this._maxRelayQueueBytes, 128 * 1024, 4 * 1024 * 1024);
            // Scale buffers for multi-player hosts: more peers = more broadcast traffic
            if (this._hasHostSocket) {
                const peerCount = Object.keys(this.connections || {}).length;
                const scale = Math.min(2.0, 1 + peerCount * 0.25);
                maxWs = Math.min(2 * 1024 * 1024, Math.floor(maxWs * scale));
                maxQueue = Math.min(4 * 1024 * 1024, Math.floor(maxQueue * scale));
            }
            this._maxWsBufferedAmount = maxWs;
            this._maxRelayQueueBytes = maxQueue;
            this._maxRelayQueueAgeMs = clampInt(profile.maxRelayQueueAgeMs, this._maxRelayQueueAgeMs, 250, 10000);
            this._joinSyncGraceMs = clampInt(profile.joinSyncGraceMs, this._joinSyncGraceMs, 0, 3000);
            this._joinWarmupMaxPackets = clampInt(profile.joinWarmupMaxPackets, this._joinWarmupMaxPackets, 0, 1024);
            this._adaptiveWsBufferedAmount = this._maxWsBufferedAmount;
            this._adaptiveRelayQueueBytes = this._maxRelayQueueBytes;
            this._adaptiveRelayQueueAgeMs = this._maxRelayQueueAgeMs;
        },

        _ensurePeerDiagnostics: function (peerId) {
            if (!peerId) return null;
            if (!this._peerDiagnostics[peerId]) {
                this._peerDiagnostics[peerId] = {
                    directSends: 0,
                    relayFallbacks: 0,
                    duplicateIncomingRejected: 0,
                    incomingAccepted: 0,
                    dialAttempts: 0,
                    dialCooldownSkips: 0
                };
            }
            return this._peerDiagnostics[peerId];
        },

        _setRelayQuality: function (peerId, mode, reason) {
            if (!peerId) return;
            const prev = this._relayQualityByPeer[peerId] || null;
            if (prev && prev.mode === mode && prev.reason === reason) return;
            this._relayQualityByPeer[peerId] = { mode: mode, reason: reason || '', at: Date.now() };
            if (prev && prev.mode === mode) return;
        },

        _showNetworkHealthWarning: function (message) {
            if (!document || !document.body) return;
            if (!this._networkHealthBanner) {
                const banner = document.createElement('div');
                banner.style.position = 'fixed';
                banner.style.top = '8px';
                banner.style.left = '8px';
                banner.style.right = '8px';
                banner.style.padding = '10px 12px';
                banner.style.background = 'rgba(140,0,0,0.92)';
                banner.style.color = '#fff';
                banner.style.font = '600 13px/1.3 sans-serif';
                banner.style.border = '1px solid rgba(255,255,255,0.35)';
                banner.style.borderRadius = '8px';
                banner.style.zIndex = '999999';
                banner.style.pointerEvents = 'none';
                banner.style.display = 'none';
                document.body.appendChild(banner);
                this._networkHealthBanner = banner;
            }
            this._networkHealthBanner.textContent = message;
            this._networkHealthBanner.style.display = 'block';
            if (this._networkHealthBannerHideTimer) {
                clearTimeout(this._networkHealthBannerHideTimer);
            }
            this._networkHealthBannerHideTimer = setTimeout(() => {
                if (this._networkHealthBanner) {
                    this._networkHealthBanner.style.display = 'none';
                }
            }, 5000);
        },

        _setPeerSessionState: function (peerId, state, reason) {
            if (!peerId) return;
            this._peerSessionState[peerId] = { state: state, at: Date.now(), reason: reason || '' };
        },

        _ensureRelayPeerEntry: function (address, peerId, remotePort) {
            if (!address) return null;

            let entry = this.connections[address];
            const normalizedPort = Number(remotePort) || (entry ? (entry.remotePort || 19132) : 19132);
            if (!entry) {
                entry = {
                    conn: null,
                    remotePort: normalizedPort,
                    peerId: peerId || null,
                    verified: !this.needsPeerVerification()
                };
                this.connections[address] = entry;
            } else {
                entry.remotePort = normalizedPort;
                if (!entry.peerId && peerId) {
                    entry.peerId = peerId;
                }
                if (!this.needsPeerVerification()) {
                    entry.verified = true;
                }
            }

            this.peerDisconnectState[address] = {
                peerId: peerId || entry.peerId || null,
                remotePort: normalizedPort
            };
            return entry;
        },

        _flushJoinWarmup: function (address) {
            const queued = this._joinWarmupQueueByIp[address];
            if (!queued || !queued.length) {
                delete this._joinWarmupQueueByIp[address];
                if (this._joinWarmupTimerByIp[address]) {
                    clearTimeout(this._joinWarmupTimerByIp[address]);
                    delete this._joinWarmupTimerByIp[address];
                }
                return;
            }
            const entry = this.connections[address];
            if (entry && entry.peerId && this.needsPeerVerification() && entry.verified !== true) {
                // Fail closed if we never received authoritative peer identity.
                this._setAuthoritativeInfo(
                    address,
                    '',
                    '',
                    '',
                    true,
                    false,
                    false,
                    'Unable to verify this player session.'
                );
                this._setConnectionVerified(address, 'peer-info-timeout');
                this.showNetworkHealthBanner('Multiplayer verification timed out. Please try joining again.');
            }
            delete this._joinWarmupQueueByIp[address];
            if (this._joinWarmupTimerByIp[address]) {
                clearTimeout(this._joinWarmupTimerByIp[address]);
                delete this._joinWarmupTimerByIp[address];
            }
            for (let i = 0; i < queued.length; i++) {
                const item = queued[i];
                if (!item) continue;
                this.receivePacket(address, item.targetPort, item.sourcePort, item.payload);
            }
        },

        _receiveWithJoinGuard: function (address, targetPort, sourcePort, payload) {
            const entry = this.connections[address];
            if (entry && entry.peerId && this.needsPeerVerification() && entry.verified !== true) {
                if (!this._joinWarmupQueueByIp[address]) {
                    this._joinWarmupQueueByIp[address] = [];
                }
                if (this._joinWarmupQueueByIp[address].length >= this._joinWarmupMaxPackets) {
                    return;
                }
                this._joinWarmupQueueByIp[address].push({
                    targetPort: targetPort,
                    sourcePort: sourcePort,
                    payload: payload
                });
                this._requestPeerVerification(entry.peerId);
                if (!this._joinWarmupTimerByIp[address]) {
                    this._joinWarmupTimerByIp[address] = setTimeout(() => {
                        delete this._joinWarmupTimerByIp[address];
                        this._flushJoinWarmup(address);
                    }, Math.max(150, this._joinSyncGraceMs));
                }
                return;
            }
            this.receivePacket(address, targetPort, sourcePort, payload);
        },

        _isConnectionUsable: function (entry) {
            if (!entry || !entry.conn) return false;
            if (entry.conn.open) return true;
            const dc = entry.conn.dataChannel;
            if (dc && dc.readyState === 'open') return true;
            return false;
        },

        _isDirectPreferredPurpose: function (purpose) {
            const text = String(purpose || '').toLowerCase();
            return text.indexOf('interaction') !== -1 ||
                text.indexOf('critical') !== -1 ||
                text.indexOf('control') !== -1 ||
                text.indexOf('combat') !== -1;
        },

        _tryDirectBroadcastFanout: function (targetPort, sourcePort, rawData, purpose) {
            if (this._relayOnlyModeEnabled()) {
                return false;
            }
            if (!this._hasHostSocket || !this._isDirectPreferredPurpose(purpose) || !rawData || rawData.length > 350) {
                return false;
            }

            const peerIds = Object.keys(this.peerToIp || {});
            if (!peerIds.length) {
                return false;
            }

            const readyEntries = [];
            for (let i = 0; i < peerIds.length; i++) {
                const peerId = peerIds[i];
                const ip = this.peerToIp[peerId];
                if (!ip) continue;

                const entry = this.connections[ip];
                const dc = entry && entry.conn ? entry.conn.dataChannel : null;
                const congested = dc && typeof dc.bufferedAmount === 'number' &&
                    dc.bufferedAmount > this._maxDataChannelBufferedAmount;
                if (!this._isConnectionUsable(entry) || congested) {
                    this.establishConnection(ip, peerId);
                    return false;
                }
                readyEntries.push(entry);
            }

            for (let i = 0; i < readyEntries.length; i++) {
                const entry = readyEntries[i];
                try {
                    const payload = new Uint8Array(4 + rawData.length);
                    const view = new DataView(payload.buffer);
                    view.setUint16(0, targetPort, true);
                    view.setUint16(2, sourcePort, true);
                    payload.set(rawData, 4);
                    entry.conn.send(payload);
                    if (entry.peerId) {
                        const diag = this._ensurePeerDiagnostics(entry.peerId);
                        if (diag) diag.directSends += 1;
                        this._setRelayQuality(entry.peerId, 'direct', 'broadcast-datachannel-send');
                    }
                } catch (err) {
                    if (entry.peerId) {
                        const diag = this._ensurePeerDiagnostics(entry.peerId);
                        if (diag) diag.relayFallbacks += 1;
                        this.establishConnection(this.peerToIp[entry.peerId], entry.peerId);
                    }
                }
            }

            return readyEntries.length > 0;
        },

        init: function () {
            this._applyRuntimeRelayConfig();

            const shouldConfirmCloseShortcut = () => {
                return !!(this.inputManager
                    && this.inputManager._shouldBlockCloseTabUnload
                    && this.inputManager._shouldBlockCloseTabUnload());
            };

            const handleBeforeUnload = (event) => {
                if (!shouldConfirmCloseShortcut()) {
                    return undefined;
                }
                if (event && typeof event.preventDefault === 'function') {
                    event.preventDefault();
                    event.returnValue = '';
                }
                return '';
            };

            const handleConfirmedPageExit = () => {
                if (this._pageExitShutdownStarted) return;
                this._pageExitShutdownStarted = true;
                this._wsManualClose = true;
                this.shutdownTransport();
            };
            const handleVisibilityResume = () => {
                if (document.hidden) {
                    return;
                }
                if (this.shouldLobbyBeActive()) {
                    this.refreshTransportState();
                    this.refreshPeerVerification('page-visible');
                }
            };

            window.addEventListener('beforeunload', handleBeforeUnload);
            window.addEventListener('pagehide', handleConfirmedPageExit);
            window.addEventListener('unload', handleConfirmedPageExit);
            document.addEventListener('visibilitychange', handleVisibilityResume);
            window.addEventListener('pageshow', handleVisibilityResume);
            window.addEventListener('focus', handleVisibilityResume);
        },

        setMultiplayerIntent: function (isLocating, isRemoteSession, isPublicHost, allowUnauthenticatedPlayers, playerHostRelayOnly) {
            const nextIntent = {
                locating: !!isLocating,
                remoteSession: !!isRemoteSession,
                publicHost: !!isPublicHost
            };
            const prevIntent = this._multiplayerIntent;
            const prevAllowUnauthenticatedPlayers = this._allowUnauthenticatedPlayers;
            const prevPlayerHostRelayOnly = this._playerHostRelayOnly;
            const startingFreshLocate = !prevIntent.locating && nextIntent.locating;
            this._allowUnauthenticatedPlayers = allowUnauthenticatedPlayers !== false;
            this._playerHostRelayOnly = playerHostRelayOnly !== false;
            if (prevIntent.locating === nextIntent.locating &&
                prevIntent.remoteSession === nextIntent.remoteSession &&
                prevIntent.publicHost === nextIntent.publicHost &&
                prevAllowUnauthenticatedPlayers === this._allowUnauthenticatedPlayers &&
                prevPlayerHostRelayOnly === this._playerHostRelayOnly) {
                return;
            }

            if (startingFreshLocate &&
                (this.ws ||
                    this.peer ||
                    this._peerInitPromise ||
                    this.hasActivePeerConnections() ||
                    this.hasTrackedPeerSessions())) {
                this.shutdownTransport();
            }

            this._multiplayerIntent = nextIntent;
            this.refreshClientProfile();
            this._syncHostAdvertisement('intent-change');
            this.refreshTransportState();
        },

        hasActivePeerConnections: function () {
            return Object.keys(this.connections).length > 0;
        },

        hasTrackedPeerSessions: function () {
            return Object.keys(this.peerDisconnectState).length > 0;
        },

        shouldLobbyBeActive: function () {
            return this._multiplayerIntent.locating ||
                this._multiplayerIntent.remoteSession ||
                this._multiplayerIntent.publicHost ||
                this.hasActivePeerConnections() ||
                this.hasTrackedPeerSessions();
        },

        shouldAdvertiseHost: function () {
            return this._hasHostSocket && this._multiplayerIntent.publicHost;
        },

        needsPeerVerification: function () {
            return this._hasHostSocket &&
                (this._multiplayerIntent.publicHost || this.hasTrackedPeerSessions());
        },

        _setAuthoritativeInfo: function (fakeIp, username, uuid, legacyUuid, guest, joinAuthorized, allowUnauthenticatedPlayers, denyMessage) {
            if (window.Module && Module.ccall) {
                Module.ccall('mcpe_setAuthoritativeInfo', 'v',
                    ['string', 'string', 'string', 'string', 'number', 'number', 'number', 'string'],
                    [
                        fakeIp,
                        username || '',
                        uuid || '',
                        legacyUuid || '',
                        guest === true ? 1 : 0,
                        joinAuthorized === false ? 0 : 1,
                        allowUnauthenticatedPlayers === false ? 0 : 1,
                        denyMessage || ''
                    ]);
            }
        },

        _clearAuthoritativeInfo: function (fakeIp) {
            if (!fakeIp || !window.Module || !Module.ccall) {
                return;
            }
            Module.ccall('mcpe_clearAuthoritativeInfo', 'v', ['string'], [fakeIp]);
        },

        _clearAllAuthoritativeInfo: function () {
            if (window.Module && Module.ccall) {
                Module.ccall('mcpe_clearAllAuthoritativeInfo', 'v', [], []);
            }
        },

        _requestPeerVerification: function (peerId) {
            if (!peerId || !this.needsPeerVerification()) {
                return;
            }
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return;
            }
            this.ws.send(JSON.stringify({ type: 'get_peer_info', peerId: peerId }));
        },

        refreshPeerVerification: function (reason) {
            if (!this.needsPeerVerification() || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return;
            }
            for (const address of Object.keys(this.connections)) {
                const entry = this.connections[address];
                if (!entry || !entry.peerId) {
                    continue;
                }
                this._requestPeerVerification(entry.peerId);
            }
        },

        refreshClientProfile: function () {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return;
            }
            this.ws.send(JSON.stringify({
                type: 'update_client_profile',
                clientUuid: window.MCPEBridge ? window.MCPEBridge.getClientUUID() : '',
                allowUnauthenticatedPlayers: this._allowUnauthenticatedPlayers !== false
            }));
        },

        setAllowUnauthenticatedPlayers: function (allow) {
            const nextValue = allow !== false;
            if (this._allowUnauthenticatedPlayers === nextValue) {
                return;
            }
            this._allowUnauthenticatedPlayers = nextValue;
            this.refreshClientProfile();
            this._syncHostAdvertisement('guest-policy-changed');
        },

        refreshTransportState: function () {
            if (!this.shouldLobbyBeActive()) {
                // Debounce: don't destroy the transport immediately.  During the
                // hostMultiplayer -> generateLevel -> _levelGenerated sequence all
                // calls happen synchronously in one JS turn, so a setTimeout
                // callback can never fire until the C++ returns.  _levelGenerated
                // will flip isPublicHost=true and cancel this timer before it runs.
                if (!this._shutdownDebounceTimer) {
                    this._shutdownDebounceTimer = setTimeout(() => {
                        this._shutdownDebounceTimer = null;
                        if (!this.shouldLobbyBeActive()) {
                            this.shutdownTransport();
                        }
                    }, 2000);
                }
                return;
            }
            if (this._shutdownDebounceTimer) {
                clearTimeout(this._shutdownDebounceTimer);
                this._shutdownDebounceTimer = null;
            }
            this.ensurePeerReady()
                .then((peerId) => {
                    if (!peerId || !this.shouldLobbyBeActive()) return;
                    this.connectLobby();
                })
                .catch((err) => {});
        },

        shutdownTransport: function () {
            if (this._shutdownDebounceTimer) {
                clearTimeout(this._shutdownDebounceTimer);
                this._shutdownDebounceTimer = null;
            }
            this._cleanupAuthorized = true;
            this._cancelReconnect();
            this.closeLobby(true);
            // Native teardown paths (leaveGame / host stop) already shut RakNet
            // down first. Avoid sending a second close notification back into
            // wasm while the client world is being destroyed.
            this.cleanupAllConnections(false);
            this._resetPeerMappings();
            this._destroyPeer();
            this._relayQueue = [];
            this._relayQueueBytes = 0;
            this._relayCapabilities = {
                protocolVersion: 1,
                binaryDedicatedUpload: false,
                received: false
            };
            this._cancelRelayFlush();
            this._stopStatsTicker();
            this._peerSessionState = {};
            this._peerDiagnostics = {};
            this._joinSyncUntilByIp = {};
            for (const ip of Object.keys(this._joinWarmupTimerByIp)) {
                clearTimeout(this._joinWarmupTimerByIp[ip]);
            }
            this._joinWarmupTimerByIp = {};
            this._joinWarmupQueueByIp = {};
            this._cleanupAuthorized = false;
        },

        _ensurePeerLibrary: function () {
            if (typeof window.Peer === 'function') {
                return Promise.resolve();
            }
            if (this._peerLibraryPromise) {
                return this._peerLibraryPromise;
            }

            this._peerLibraryPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js';
                script.onload = () => resolve();
                script.onerror = (err) => {
                    this._peerLibraryPromise = null;
                    reject(err || new Error('Failed to load PeerJS'));
                };
                document.head.appendChild(script);
            });
            return this._peerLibraryPromise;
        },

        ensurePeerReady: function () {
            const plan = this._getPeerTransportPlan();
            if (this._peerTransportPlanKey &&
                this._peerTransportPlanKey !== plan.key &&
                !this.hasActivePeerConnections() &&
                !this.hasTrackedPeerSessions()) {
                this.closeLobby(true);
                this._destroyPeer();
                this.peerId = null;
                this._peerTransportPlanKey = '';
            }

            if (this.peer && this.peerId && !this.peer.destroyed && this._peerTransportPlanKey === plan.key) {
                return Promise.resolve(this.peerId);
            }
            if (!plan.usePeerTransport && this.peerId && this._peerTransportPlanKey === plan.key) {
                return Promise.resolve(this.peerId);
            }
            if (this._peerInitPromise) {
                return this._peerInitPromise;
            }

            if (!plan.usePeerTransport) {
                this._peerInitPromise = Promise.resolve().then(() => {
                    if (!this.shouldLobbyBeActive()) {
                        this._peerInitPromise = null;
                        return null;
                    }
                    if (!this.peerId) {
                        this.peerId = this._generateRelayPeerId();
                    }
                    this._peerTransportPlanKey = plan.key;
                    const id = this.peerId;
                    this._peerInitPromise = null;
                    return id;
                });
                return this._peerInitPromise;
            }

            this._peerInitPromise = this._ensurePeerLibrary().then(() => new Promise((resolve, reject) => {
                if (!this.shouldLobbyBeActive()) {
                    this._peerInitPromise = null;
                    resolve(null);
                    return;
                }

                // Defer Peer creation to next tick to avoid blocking the main thread
                // (e.g. when toggling server visibility, the Peer constructor can freeze the UI)
                const initPeer = () => {
                    if (!this.shouldLobbyBeActive()) {
                        this._peerInitPromise = null;
                        resolve(null);
                        return;
                    }
                    const peer = new Peer({
                    debug: 1,
                    config: {
                        iceServers: this._getEffectiveIceServers(),
                        iceTransportPolicy: plan.iceTransportPolicy
                    }
                });
                let settled = false;
                this.peer = peer;
                this.peerId = null;
                this._peerTransportPlanKey = plan.key;

                peer.on('open', (id) => {
                    if (this.peer !== peer) return;
                    this.peerId = id;
                    if (!settled) {
                        settled = true;
                        this._peerInitPromise = null;
                        resolve(id);
                    }
                    if (this.shouldLobbyBeActive()) {
                        this.connectLobby();
                    } else {
                        this.shutdownTransport();
                    }
                });

                peer.on('disconnected', () => {
                    if (this.peer !== peer) return;
                    this.peerId = null;
                    this.closeLobby(false);
                    if (this.shouldLobbyBeActive() && !peer.destroyed) {
                        try {
                            peer.reconnect();
                        } catch (err) {}
                    }
                });

                peer.on('close', () => {
                    if (this.peer !== peer) return;
                    this.peer = null;
                    this.peerId = null;
                    this._peerInitPromise = null;
                    this._peerTransportPlanKey = '';
                    if (this.shouldLobbyBeActive()) {
                        setTimeout(() => this.refreshTransportState(), 500);
                    }
                });

                peer.on('error', (err) => {
                    if (this.peer !== peer) return;
                    if (err && err.type === 'peer-unavailable') {
                        const targetPeerId = err.peer || (err.message && err.message.match(/peer ([a-f0-9-]+)/i)?.[1]);
                        if (targetPeerId) {
                            const fakeIp = this.peerToIp[targetPeerId];
                            if (fakeIp) {
                                const entry = this.connections[fakeIp];
                                if (entry && entry.peerId) {
                                    this._setPeerSessionState(entry.peerId, 'relay-only', 'peer-unavailable');
                                    this._setRelayQuality(entry.peerId, 'relay', 'peer-unavailable');
                                }
                            }
                        }
                    }
                    if (!settled) {
                        settled = true;
                        this._peerInitPromise = null;
                        reject(err);
                    }
                });

                peer.on('connection', (conn) => {
                    if (this.peer !== peer) return;
                    this._setupIncomingConnection(conn);
                });
                };
                setTimeout(initPeer, 0);
            }));

            return this._peerInitPromise;
        },

        connectLobby: function () {
            if (!this.shouldLobbyBeActive() || !this.peerId) return;
            if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

            try {
                const lobbyOverride = (typeof window.MCPE_LOBBY_URL === 'string') ? window.MCPE_LOBBY_URL : null;
                const wsUrl = lobbyOverride || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
                const ws = new WebSocket(wsUrl);
                ws.binaryType = 'arraybuffer';
                this.ws = ws;
                this._wsManualClose = false;

                ws.onopen = () => {
                    this._wsReconnectDelay = 1000;
                    this._lastAdvertisedHost = false;
                    this._relayCapabilities = {
                        protocolVersion: 1,
                        binaryDedicatedUpload: false,
                        received: false
                    };
                    ws.send(JSON.stringify({
                        type: 'register_client',
                        peerId: this.peerId,
                        clientUuid: window.MCPEBridge ? window.MCPEBridge.getClientUUID() : '',
                        allowUnauthenticatedPlayers: this._allowUnauthenticatedPlayers !== false
                    }));
                    ws.send(JSON.stringify({ type: 'list_dedicated_servers' }));
                    this._syncHostAdvertisement('ws-open');
                    this.refreshPeerVerification('ws-open');
                    this._flushRelayQueue();
                    this._scheduleRelayFlush();
                };

                ws.onerror = (event) => {
                    const buffered = (typeof ws.bufferedAmount === 'number') ? ws.bufferedAmount : 0;
                    const activePeers = Object.keys(this.connections).length;
                    console.warn(
                        `[Lobby] WebSocket error (readyState=${ws.readyState}, buffered=${buffered}, ` +
                        `relayQueueBytes=${this._relayQueueBytes}, activePeers=${activePeers}).`,
                        event
                    );
                };

                ws.onclose = (event) => {
                    const closeCode = event && typeof event.code === 'number' ? event.code : 0;
                    const closeReason = event && event.reason ? String(event.reason) : '';
                    const buffered = (typeof ws.bufferedAmount === 'number') ? ws.bufferedAmount : 0;
                    const activePeers = Object.keys(this.connections).length;
                    console.warn(
                        `[Lobby] WebSocket closed during gameplay bridge. code=${closeCode || 0}` +
                        `${closeReason ? ` reason=${closeReason}` : ''}` +
                        ` buffered=${buffered} relayQueueBytes=${this._relayQueueBytes} activePeers=${activePeers}`
                    );
                    if (this.ws === ws) {
                        this.ws = null;
                    }
                    this._relayCapabilities = {
                        protocolVersion: 1,
                        binaryDedicatedUpload: false,
                        received: false
                    };
                    this._cancelRelayFlush();
                    const shouldReconnect = !this._wsManualClose && this.shouldLobbyBeActive();
                    this._wsManualClose = false;
                    if (shouldReconnect) {
                        this._scheduleReconnect();
                    }
                };

                ws.onmessage = (event) => {
                    this._handleLobbyMessage(event);
                };
            } catch (e) {
                this.ws = null;
                if (!this._wsManualClose && this.shouldLobbyBeActive()) {
                    this._scheduleReconnect();
                }
            }
        },

        closeLobby: function (manualClose) {
            this._cancelReconnect();
            const ws = this.ws;
            if (!ws) return;

            this._wsManualClose = manualClose !== false;
            this.ws = null;
            this._cancelRelayFlush();

            try {
                if (ws.readyState === WebSocket.OPEN && this.peerId && manualClose !== false) {
                    ws.send(JSON.stringify({ type: 'disconnecting', peerId: this.peerId }));
                }
                if (ws.readyState === WebSocket.OPEN && this.shouldAdvertiseHost()) {
                    ws.send(JSON.stringify({ type: 'unhost' }));
                }
            } catch (e) {}

            try {
                if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                    ws.close();
                }
            } catch (e) {}
        },

        _cancelReconnect: function () {
            if (!this._wsReconnectTimer) return;
            clearTimeout(this._wsReconnectTimer);
            this._wsReconnectTimer = null;
        },

        _scheduleReconnect: function () {
            if (!this.shouldLobbyBeActive() || this._wsReconnectTimer) return;
            // When game is running (active peers or hosting), reconnect aggressively
            // so relay stays available; avoid long outages during brief WebSocket drops
            const hasActiveSession = this.hasActivePeerConnections() || this._hasHostSocket;
            const delay = hasActiveSession ? Math.min(this._wsReconnectDelay, 500) : this._wsReconnectDelay;
            const maxDelay = hasActiveSession ? 3000 : 10000;
            this._wsReconnectTimer = setTimeout(() => {
                this._wsReconnectTimer = null;
                this._wsReconnectDelay = Math.min(this._wsReconnectDelay * 2, maxDelay);
                this.refreshTransportState();
            }, delay);
        },

        _cancelRelayFlush: function () {
            if (!this._relayFlushTimer) return;
            clearTimeout(this._relayFlushTimer);
            this._relayFlushTimer = null;
        },

        _scheduleRelayFlush: function () {
            if (this._relayFlushTimer || !this._relayHasBacklog()) return;
            this._relayFlushTimer = setTimeout(() => {
                this._relayFlushTimer = null;
                this._flushRelayQueue();
                if (this._relayHasBacklog()) {
                    this._scheduleRelayFlush();
                }
            }, 16);
        },

        _handleLobbyMessage: function (event) {
            try {
                // Binary frame from server (peer_packet / dedicated_packet in binary relay protocol)
                if (event.data instanceof ArrayBuffer) {
                    const buf = new Uint8Array(event.data);
                    if (buf.length < 6) return; // minimum: type(1)+peerIdLen(1)+peerIdMin(1)+ports(4)=7, but at least 6
                    const type = buf[0];
                    if (type === 0x03) {
                        const peerIdLen = buf[1];
                        if (buf.length < 2 + peerIdLen + 4) return;
                        let fromId = '';
                        for (let i = 0; i < peerIdLen; i++) fromId += String.fromCharCode(buf[2 + i]);
                        const view = new DataView(event.data, 2 + peerIdLen, 4);
                        const targetPort = view.getUint16(0, true);
                        const sourcePort = view.getUint16(2, true);
                        const payload = new Uint8Array(event.data, 2 + peerIdLen + 4);

                        this._cancelPendingPeerDisconnect(fromId);
                        const fakeIp = this.getFakeIp(fromId);
                        if (sourcePort) {
                            this.lastRemotePort[fakeIp] = sourcePort;
                        }
                        const relayEntry = this._ensureRelayPeerEntry(fakeIp, fromId, sourcePort);
                        this._setPeerSessionState(fromId, 'relay-open', 'lobby-peer-packet');
                        this._setRelayQuality(fromId, 'relay', 'lobby-peer-packet');
                        if (this.needsPeerVerification() && (!relayEntry || relayEntry.verified !== true)) {
                            this._requestPeerVerification(fromId);
                        }
                        this._receiveWithJoinGuard(fakeIp, targetPort, sourcePort, payload);
                        return;
                    }
                    if (type === 0x05) {
                        const serverIdLen = buf[1];
                        if (buf.length < 2 + serverIdLen + 4) return;
                        let serverId = '';
                        for (let i = 0; i < serverIdLen; i++) serverId += String.fromCharCode(buf[2 + i]);
                        const fakeIp = this.dedicatedServerIdToIp[serverId];
                        if (!fakeIp) { console.warn('[UDPProxy] No fakeIp for serverId=' + serverId); return; }
                        const view = new DataView(event.data, 2 + serverIdLen, 4);
                        const targetPort = view.getUint16(0, true);
                        const sourcePort = view.getUint16(2, true);
                        const payload = new Uint8Array(event.data, 2 + serverIdLen + 4);
                        if (!this._udpProxyLogCount) this._udpProxyLogCount = 0;
                        if (this._udpProxyLogCount < 20) {
                            this._udpProxyLogCount++;
                            console.log('[UDPProxy] IN: fakeIp=' + fakeIp + ' len=' + payload.length + ' first=' + (payload.length > 0 ? payload[0] : -1));
                        }
                        this._receiveWithJoinGuard(fakeIp, targetPort || 19132, sourcePort || 19132, payload);
                        return;
                    }
                    return;
                }

                // JSON frame (control messages: peer_info, peer_disconnected, etc.)
                const msg = JSON.parse(event.data);
                if (msg.type === 'peer_packet') {
                    return;
                } else if (msg.type === 'relay_capabilities') {
                    this._relayCapabilities = {
                        protocolVersion: Number(msg.protocolVersion) || 1,
                        binaryDedicatedUpload: msg.binaryDedicatedUpload === true,
                        received: true
                    };
                } else if (msg.type === 'dedicated_servers') {
                    this._applyDedicatedServerList(Array.isArray(msg.servers) ? msg.servers : []);
                } else if (msg.type === 'dedicated_packet') {
                    if (!msg.serverId || !Array.isArray(msg.data)) return;
                    const fakeIp = this.dedicatedServerIdToIp[msg.serverId];
                    if (!fakeIp) return;
                    const payload = new Uint8Array(msg.data);
                    this._receiveWithJoinGuard(fakeIp, msg.targetPort || 19132, msg.sourcePort || 19132, payload);
                } else if (msg.type === 'peer_info') {
                    if (!msg.peerId) return;
                    this._cancelPendingPeerDisconnect(msg.peerId);
                    const fakeIp = this.getFakeIp(msg.peerId);
                    if (msg.username !== undefined) {
                        this._setAuthoritativeInfo(
                            fakeIp,
                            msg.username || 'Steve69',
                            msg.verified === true ? (msg.mcpeUuid || "") : "",
                            msg.verified === true ? (msg.legacyMcpeUuid || "") : "",
                            msg.verified !== true,
                            msg.joinAuthorized !== false,
                            msg.allowUnauthenticatedPlayers !== false,
                            msg.denyMessage || "");
                    } else {
                        this._clearAuthoritativeInfo(fakeIp);
                    }
                    this._setConnectionVerified(fakeIp, 'lobby-peer-info');
                    this._flushJoinWarmup(fakeIp);
                } else if (msg.type === 'udp_proxy_ready') {
                    if (!msg.serverId || !msg.host) return;
                    const fakeIp = this._getDedicatedFakeIp(msg.serverId, Object.keys(this.dedicatedServerIdToIp).length);
                    const port = Number(msg.port) || 19132;
                    console.log('[UDPProxy] Ready: serverId=' + msg.serverId + ' fakeIp=' + fakeIp + ' port=' + port);
                    this.dedicatedServersById[msg.serverId] = {
                        serverId: msg.serverId, name: msg.host + ':' + port,
                        motd: 'UDP Proxy', fakeIp: fakeIp, port: port,
                        currentPlayers: 0, maxPlayers: 16, _udpProxy: true
                    };
                    this._pendingUdpProxyJoin = {
                        fakeIp: fakeIp, port: port,
                        serverId: msg.serverId, name: msg.host + ':' + port
                    };
                } else if (msg.type === 'udp_proxy_error') {
                    console.error('[UDPProxy] Error:', msg.reason);
                } else if (msg.type === 'peer_disconnected') {
                    if (!msg.peerId) return;
                    const peerId = msg.peerId;
                    const fakeIp = this.peerToIp[peerId];
                    if (fakeIp) {
                        const entry = this.connections[fakeIp];
                        if (entry && entry.conn && entry.conn.open) {
                            console.log(`[Lobby] Peer ${peerId} left the lobby, but the direct session is still active.`);
                            return;
                        }
                        console.log(`[Lobby] Peer ${peerId} left the lobby; closing session immediately for ${fakeIp}.`);
                        this._cancelPendingPeerDisconnect(peerId);
                        this._dropConnection(fakeIp, true, true);
                        this.forgetPeer(peerId);
                        return;
                    }
                    this.forgetPeer(peerId);
                }
            } catch (e) {}
        },


        _setConnectionVerified: function (address, reason) {
            const entry = this.connections[address];
            if (!entry) return;
            if (entry.verified) return;
            entry.verified = true;
        },

        _processConnectionData: function (address, data) {
            const entry = this.connections[address];
            if (!entry) return;
            if (entry.peerId) {
                this._cancelPendingPeerDisconnect(entry.peerId);
            }

            const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
            if (arr.length < 4) return;

            const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
            const targetP = view.getUint16(0, true);
            const sourceP = view.getUint16(2, true);
            const payload = new Uint8Array(arr.buffer, arr.byteOffset + 4, arr.byteLength - 4);

            entry.remotePort = sourceP;
            this.lastRemotePort[address] = sourceP;
            this.peerDisconnectState[address] = { peerId: entry.peerId || null, remotePort: sourceP };
            if (entry.peerId && this.needsPeerVerification() && entry.verified !== true) {
                this._requestPeerVerification(entry.peerId);
            }
            this._receiveWithJoinGuard(address, targetP, sourceP, payload);
        },

        _setupIncomingConnection: function (conn) {
            const fakeIp = this.getFakeIp(conn.peer);
            const existing = this.connections[fakeIp];
            const diag = this._ensurePeerDiagnostics(conn.peer);
            if (existing && existing.peerId === conn.peer && this._isConnectionUsable(existing)) {
                if (diag) diag.duplicateIncomingRejected += 1;
                try { conn.close(); } catch (e) { }
                return;
            }
            if (diag) diag.incomingAccepted += 1;
            this._cancelPendingPeerDisconnect(conn.peer);
            this._setPeerSessionState(conn.peer, 'incoming-connecting', 'incoming-connection');
            this._bindConnection(fakeIp, conn, conn.peer);
        },

        _bindConnection: function (address, conn, peerId) {
            const existing = this.connections[address];
            if (existing && existing.conn !== conn) {
                this._dropConnection(address, false);
            }

            this.connections[address] = {
                conn: conn,
                remotePort: 19132,
                peerId: peerId || null,
                verified: !this.needsPeerVerification()
            };
            this.peerDisconnectState[address] = { peerId: peerId || null, remotePort: 19132 };
            if (peerId) {
                this._cancelPendingPeerDisconnect(peerId);
            }
            if (this._hasHostSocket) this._applyRuntimeRelayConfig();

            if (this.needsPeerVerification()) {
                this._requestPeerVerification(peerId);
            }

            conn.on('open', () => {
                const entry = this.connections[address];
                if (!entry || entry.conn !== conn) return;
                if (entry.peerId) {
                    this._setPeerSessionState(entry.peerId, 'open', 'conn-open');
                    this._setRelayQuality(entry.peerId, 'direct', 'conn-open');
                }
            });

            conn.on('data', (data) => {
                const entry = this.connections[address];
                if (!entry || entry.conn !== conn) return;
                this._processConnectionData(address, data);
            });

            conn.on('close', () => {
                const entry = this.connections[address];
                if (!entry || entry.conn !== conn) return;
                this.peerDisconnectState[address] = { peerId: entry.peerId || peerId || null, remotePort: entry.remotePort || 19132 };
                if (entry.verificationTimer) {
                    clearTimeout(entry.verificationTimer);
                    entry.verificationTimer = null;
                }
                delete this.connections[address];
                delete this._joinSyncUntilByIp[address];
                if (this._joinWarmupTimerByIp[address]) {
                    clearTimeout(this._joinWarmupTimerByIp[address]);
                    delete this._joinWarmupTimerByIp[address];
                }
                delete this._joinWarmupQueueByIp[address];
                if (entry.peerId) {
                    delete this._recentDialByPeer[entry.peerId];
                    this._setPeerSessionState(entry.peerId, 'closed', 'conn-close');
                    this._setRelayQuality(entry.peerId, 'relay', 'conn-close');
                }
                console.warn(`[WebRTC] Connection closed for ${address}; falling back to relay until it reconnects.`);
                if (!this.shouldLobbyBeActive()) {
                    this.refreshTransportState();
                }
            });

            conn.on('error', (err) => {
                const entry = this.connections[address];
                if (!entry || entry.conn !== conn) return;
                this.peerDisconnectState[address] = { peerId: entry.peerId || peerId || null, remotePort: entry.remotePort || 19132 };
                if (entry.verificationTimer) {
                    clearTimeout(entry.verificationTimer);
                    entry.verificationTimer = null;
                }
                delete this.connections[address];
                delete this._joinSyncUntilByIp[address];
                if (this._joinWarmupTimerByIp[address]) {
                    clearTimeout(this._joinWarmupTimerByIp[address]);
                    delete this._joinWarmupTimerByIp[address];
                }
                delete this._joinWarmupQueueByIp[address];
                if (entry.peerId) {
                    delete this._recentDialByPeer[entry.peerId];
                    this._setPeerSessionState(entry.peerId, 'degraded', err && err.type ? err.type : 'conn-error');
                    this._setRelayQuality(entry.peerId, 'relay', err && err.type ? err.type : 'conn-error');
                }
                console.warn(`[WebRTC] Keeping session alive via relay fallback for ${address}.`);
                if (!this.shouldLobbyBeActive()) {
                    this.refreshTransportState();
                }
            });
        },

        _dropConnection: function (address, notifyNative, forgetState) {
            const entry = this.connections[address];
            const fallbackState = this.peerDisconnectState[address] || null;
            const lastPort = this.lastRemotePort[address];
            if (!entry && !fallbackState && !lastPort) return;
            const peerId = entry ? entry.peerId : (fallbackState ? fallbackState.peerId : null);
            if (peerId) {
                this._cancelPendingPeerDisconnect(peerId);
            }

            const port = lastPort || (entry ? (entry.remotePort || 19132) : (fallbackState.remotePort || 19132));
            delete this.connections[address];
            delete this._joinSyncUntilByIp[address];
            if (this._joinWarmupTimerByIp[address]) {
                clearTimeout(this._joinWarmupTimerByIp[address]);
                delete this._joinWarmupTimerByIp[address];
            }
            delete this._joinWarmupQueueByIp[address];
            this._clearAuthoritativeInfo(address);

            if (notifyNative !== false) {
                this.notifyConnectionClosed(address, port);
            }

            if (entry && entry.conn) {
                try {
                    entry.conn.close();
                } catch (e) {
                }
            }

            if (forgetState !== false) {
                delete this.peerDisconnectState[address];
            }
            if (this._hasHostSocket) this._applyRuntimeRelayConfig();
        },

        cleanupAllConnections: function (notifyNative) {
            if (notifyNative === false && !this._cleanupAuthorized) {
                return;
            }
            for (const ip of Object.keys(this.connections)) {
                this._dropConnection(ip, notifyNative);
            }
        },

        _cancelPendingPeerDisconnect: function (peerId) {
            if (!peerId || !this.pendingPeerDisconnects[peerId]) return;
            clearTimeout(this.pendingPeerDisconnects[peerId]);
            delete this.pendingPeerDisconnects[peerId];
        },

        _schedulePeerDisconnect: function (peerId, fakeIp, options) {
            if (!peerId || !fakeIp) return;
            const opts = options || {};
            this._cancelPendingPeerDisconnect(peerId);

            if (opts.immediateHide === true) {
                const fallbackState = this.peerDisconnectState[fakeIp] || null;
                const port = this.lastRemotePort[fakeIp] || (fallbackState ? (fallbackState.remotePort || 19132) : 19132);
                this._clearAuthoritativeInfo(fakeIp);
                this.notifyConnectionClosed(fakeIp, port);
            }

            const graceMs = (opts.graceMs != null && opts.graceMs >= 0) ? opts.graceMs : (this._peerDisconnectGraceMs | 0);
            this.pendingPeerDisconnects[peerId] = setTimeout(() => {
                delete this.pendingPeerDisconnects[peerId];
                const mappedIp = this.peerToIp[peerId];
                if (mappedIp !== fakeIp) {
                    return;
                }
                const entry = this.connections[fakeIp];
                if (!opts.forceDrop && entry && entry.conn && entry.conn.open) {
                    return;
                }
                this._dropConnection(fakeIp, false, true);
                this.forgetPeer(peerId);
            }, Math.max(750, graceMs));
        },

        _resetPeerMappings: function () {
            this._clearAllAuthoritativeInfo();
            for (const peerId of Object.keys(this.pendingPeerDisconnects)) {
                clearTimeout(this.pendingPeerDisconnects[peerId]);
            }
            this.pendingPeerDisconnects = {};
            this._recentDialByPeer = {};
            this._peerSessionState = {};
            this._peerDiagnostics = {};
            this._joinSyncUntilByIp = {};
            for (const ip of Object.keys(this._joinWarmupTimerByIp)) {
                clearTimeout(this._joinWarmupTimerByIp[ip]);
            }
            this._joinWarmupTimerByIp = {};
            this._joinWarmupQueueByIp = {};
            this._joinWarmupAppliedByIp = {};
            this.ipToPeer = {};
            this.peerToIp = {};
            this.peerDisconnectState = {};
            this.lastRemotePort = {};
            this._relayQualityByPeer = {};
            this._nextIpSuffix = 2;
            this._availableIpSuffixes = [];
        },

        getFakeIp: function (peerId) {
            if (this.peerToIp[peerId]) return this.peerToIp[peerId];

            const index = this._nextIpSuffix++;
            const addressSpace = 253 * 254 * 254;
            if (index >= addressSpace) {
                const fallbackIp = '10.254.254.254';
                this.ipToPeer[fallbackIp] = peerId;
                this.peerToIp[peerId] = fallbackIp;
                return fallbackIp;
            }
            const normalized = index - 2;
            const octet2 = 1 + Math.floor(normalized / (254 * 254));
            const remainder = normalized % (254 * 254);
            const octet3 = Math.floor(remainder / 254);
            const octet4 = 1 + (remainder % 254);
            const ip = `10.${octet2}.${octet3}.${octet4}`;

            this.ipToPeer[ip] = peerId;
            this.peerToIp[peerId] = ip;
            return ip;
        },

        _getDedicatedFakeIp: function (serverId, indexHint) {
            if (this.dedicatedServerIdToIp[serverId]) return this.dedicatedServerIdToIp[serverId];
            const base = typeof indexHint === 'number' ? indexHint : Object.keys(this.dedicatedServerIdToIp).length;
            const octet3 = Math.floor(base / 253);
            const octet4 = 1 + (base % 253);
            const ip = `11.0.${octet3}.${octet4}`;
            this.dedicatedServerIdToIp[serverId] = ip;
            this.dedicatedIpToServerId[ip] = serverId;
            return ip;
        },

        _applyDedicatedServerList: function (servers) {
            const preservedById = {};
            const preservedIpToId = {};
            const preservedIdToIp = {};
            for (const sid in this.dedicatedServersById) {
                const entry = this.dedicatedServersById[sid];
                if (entry && entry._udpProxy) {
                    preservedById[sid] = entry;
                    if (this.dedicatedServerIdToIp[sid]) {
                        const ip = this.dedicatedServerIdToIp[sid];
                        preservedIdToIp[sid] = ip;
                        preservedIpToId[ip] = sid;
                    }
                }
            }

            this.dedicatedServersById = preservedById;
            this.dedicatedIpToServerId = preservedIpToId;
            this.dedicatedServerIdToIp = preservedIdToIp;

            if (window.Module && typeof window.Module.ccall === 'function') {
                try {
                    window.Module.ccall('mcpe_clearDedicatedDiscoveredServers', 'void', [], []);
                } catch (e) {}
            }

            for (const sid in preservedById) {
                const entry = preservedById[sid];
                if (window.Module && typeof window.Module.ccall === 'function') {
                    try {
                        window.Module.ccall('mcpe_upsertDiscoveredServer', 'void',
                            ['string','string','string','string','number','number','number','number'],
                            [sid, entry.name, entry.motd || '', entry.fakeIp, entry.port, entry.currentPlayers || 0, entry.maxPlayers || 16, 1]);
                    } catch (e) {}
                }
            }

            for (let i = 0; i < servers.length; i++) {
                const server = servers[i];
                if (!server || !server.serverId || !server.name) continue;
                const fakeIp = this._getDedicatedFakeIp(server.serverId, i);
                this.dedicatedServersById[server.serverId] = {
                    serverId: server.serverId,
                    name: server.name,
                    motd: server.motd || '',
                    fakeIp: fakeIp,
                    port: Number(server.port) || 19132,
                    currentPlayers: Number(server.currentPlayers) || 0,
                    maxPlayers: Number(server.maxPlayers) || 16
                };
                if (window.Module && typeof window.Module.ccall === 'function') {
                    try {
                        window.Module.ccall(
                            'mcpe_upsertDiscoveredServer',
                            'void',
                            ['string', 'string', 'string', 'string', 'number', 'number', 'number', 'number'],
                            [server.serverId, server.name, server.motd || '', fakeIp, Number(server.port) || 19132, Number(server.currentPlayers) || 0, Number(server.maxPlayers) || 16, 1]
                        );
                    } catch (e) {}
                }
            }
        },

        forgetPeer: function (peerId) {
            const fakeIp = this.peerToIp[peerId];
            if (!fakeIp) return null;

            delete this.peerToIp[peerId];
            if (this.ipToPeer[fakeIp] === peerId) {
                delete this.ipToPeer[fakeIp];
            }
            this._clearAuthoritativeInfo(fakeIp);
            delete this.peerDisconnectState[fakeIp];
            delete this._joinWarmupAppliedByIp[fakeIp];
            delete this._peerDiagnostics[peerId];
            delete this._peerSessionState[peerId];
            delete this._relayQualityByPeer[peerId];
            return fakeIp;
        },



        notifyServerState: function (isHosting) {
            if (isHosting) {
                this._hostSocketCount += 1;
            } else {
                this._hostSocketCount = Math.max(0, this._hostSocketCount - 1);
            }
            this._hasHostSocket = this._hostSocketCount > 0;
            this._applyRuntimeRelayConfig();
            this._syncHostAdvertisement('socket-state');
            this.refreshTransportState();
        },

        _logRelayUnavailable: function (context) {
            const now = Date.now();
            if ((now - this._lastRelayUnavailableLog) < 30000) return;
            this._lastRelayUnavailableLog = now;
        },

        _relayHasBacklog: function () {
            return this._relayQueue.length > 0;
        },


        _inferRelayPurpose: function (targetPort, sourcePort, payload, isBroadcast) {
            const size = payload ? payload.byteLength : 0;
            if (size <= 200) return 'critical interaction packet';
            if (targetPort === 19132 || sourcePort === 19132) {
                if (size <= 320) return 'interaction packet';
                if (size <= 900) return isBroadcast ? 'state broadcast packet' : 'state relay packet';
                return isBroadcast ? 'bulk broadcast packet' : 'bulk relay packet';
            }
            if (size <= 220) return 'control packet';
            return isBroadcast ? 'broadcast packet' : 'relay packet';
        },

        _updateAdaptiveRelayLimits: function () {
            this._adaptiveWsBufferedAmount = this._maxWsBufferedAmount;
            this._adaptiveRelayQueueBytes = this._maxRelayQueueBytes;
            this._adaptiveRelayQueueAgeMs = this._maxRelayQueueAgeMs;
        },

        _canSendOnLobby: function (purpose) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
            this._updateAdaptiveRelayLimits();
            if (typeof this.ws.bufferedAmount === 'number' && this.ws.bufferedAmount > this._adaptiveWsBufferedAmount) {
                this.stats.relayDropBackpressure += 1;
                const now = Date.now();
                if (!this._lastWsBackpressureLogAt || (now - this._lastWsBackpressureLogAt) > 10000) {
                    this._lastWsBackpressureLogAt = now;
                }
                return false;
            }
            return true;
        },

        _dropStaleFromQueue: function (queue, now) {
            while (queue.length > 0 && (now - queue[0].at) > this._adaptiveRelayQueueAgeMs) {
                const stale = queue.shift();
                this.stats.relayDropStale += 1;
                this._relayQueueBytes = Math.max(0, this._relayQueueBytes - stale.payload.byteLength);
                const buffered = (this.ws && typeof this.ws.bufferedAmount === 'number') ? this.ws.bufferedAmount : 0;
            }
        },

        _enqueueRelayFrame: function (frame, purpose) {
            const payload = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
            this._updateAdaptiveRelayLimits();
            if (payload.byteLength > this._adaptiveRelayQueueBytes) {
                this.stats.relayDropOversized += 1;
                return false;
            }

            const now = Date.now();
            this._dropStaleFromQueue(this._relayQueue, now);

            while ((this._relayQueueBytes + payload.byteLength) > this._adaptiveRelayQueueBytes && this._relayQueue.length > 0) {
                const dropped = this._relayQueue.shift();
                this.stats.relayDropFull += 1;
                this._relayQueueBytes = Math.max(0, this._relayQueueBytes - dropped.payload.byteLength);
            }

            if ((this._relayQueueBytes + payload.byteLength) > this._adaptiveRelayQueueBytes) {
                this.stats.relayDropFull += 1;
                return false;
            }

            this._relayQueue.push({ payload: payload, at: now });
            this.stats.relaySentQueued += 1;
            this._relayQueueBytes += payload.byteLength;
            this.stats.relayQueuePeakBytes = Math.max(this.stats.relayQueuePeakBytes, this._relayQueueBytes);
            this._scheduleRelayFlush();
            return true;
        },

        _sendOrQueueRelayFrame: function (frame, purpose, meta) {
            const payload = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
            if (this._canSendOnLobby(purpose)) {
                try {
                    this.ws.send(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
                    this.stats.relaySentDirect += 1;
                    return true;
                } catch (err) {
                }
            }
            return this._enqueueRelayFrame(payload, purpose);
        },

        _flushRelayQueue: function () {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            if (!this._relayHasBacklog()) return;

            const now = Date.now();
            this._dropStaleFromQueue(this._relayQueue, now);

            while (this._relayQueue.length > 0) {
                if (!this._canSendOnLobby('relay queue flush')) break;
                const item = this._relayQueue.shift();
                this._relayQueueBytes = Math.max(0, this._relayQueueBytes - item.payload.byteLength);
                try {
                    this.ws.send(item.payload.buffer.slice(item.payload.byteOffset, item.payload.byteOffset + item.payload.byteLength));
                    this.stats.relaySentDirect += 1;
                } catch (err) {
                    this._relayQueue.unshift(item);
                    this._relayQueueBytes += item.payload.byteLength;
                    break;
                }
            }

            if (this._relayHasBacklog()) {
                this._scheduleRelayFlush();
            }
        },

        sendBatch: function (address, targetPort, sourcePort, batchBuffer) {
            this.stats.bridgeCalls++;
            this._initStatsTicker();

            // A batch is a series of [2B length][payload] entries
            const view = new DataView(batchBuffer.buffer, batchBuffer.byteOffset, batchBuffer.byteLength);
            let offset = 0;

            while (offset < batchBuffer.byteLength) {
                if (offset + 2 > batchBuffer.byteLength) break;
                const len = view.getUint16(offset, true);
                offset += 2;
                if (offset + len > batchBuffer.byteLength) break;
                const packetData = batchBuffer.subarray(offset, offset + len);
                offset += len;

                // Re-use sendPacket for each sub-packet in the batch
                // NOTE: this.stats.bridgeCalls is NOT incremented per sub-packet, 
                // but we DO decrement stats.bridgeCalls in sendPacket to avoid double counting 
                // if we wanted to be super precise. But here we just want the WASM->JS call count.
                this._sendPacketInternal(address, targetPort, sourcePort, packetData);
            }
        },

        // Refactored core send logic to avoid double-incrementing bridgeCalls during batch dispatch
        _sendPacketInternal: function (address, targetPort, sourcePort, data) {
            const rawData = (data instanceof Uint8Array) ? data : new Uint8Array(data);
            if (address === "255.255.255.255" || address === "0.0.0.0") {
                const purpose = this._inferRelayPurpose(targetPort, sourcePort, rawData, true);
                this.stats.ppsOut++;
                this.stats.bpsOut += rawData.length;
                if (this._tryDirectBroadcastFanout(targetPort, sourcePort, rawData, purpose)) {
                    return;
                }
                const frame = new Uint8Array(1 + 2 + 2 + rawData.length);
                frame[0] = this._hasHostSocket ? 0x04 : 0x02; // BIN_BROADCAST_LINKED or BIN_BROADCAST
                const hdr = new DataView(frame.buffer, 1, 4);
                hdr.setUint16(0, targetPort, true);
                hdr.setUint16(2, sourcePort, true);
                frame.set(rawData, 5);
                const meta = this._hasHostSocket ? { activeSession: true, sessionId: 'peer:broadcast-linked', sessionMode: 'peer' } : null;
                this._sendOrQueueRelayFrame(frame, purpose, meta);
                return;
            }

            const dedicatedServerId = this.dedicatedIpToServerId[address];
            if (dedicatedServerId) {
                if (!this._udpProxyOutLogCount) this._udpProxyOutLogCount = 0;
                if (this._udpProxyOutLogCount < 20 && dedicatedServerId.indexOf('udp-proxy') === 0) {
                    this._udpProxyOutLogCount++;
                    console.log('[UDPProxy] OUT: addr=' + address + ' port=' + targetPort + ' len=' + rawData.length + ' first=' + (rawData.length > 0 ? rawData[0] : -1));
                }
                this.stats.ppsOut++;
                this.stats.bpsOut += rawData.length;
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                    this._logRelayUnavailable(`dedicated relay for ${dedicatedServerId}`);
                    return;
                }
                const canUseBinaryDedicated = this._relayCapabilities && this._relayCapabilities.received === true &&
                    this._relayCapabilities.binaryDedicatedUpload === true;
                if (canUseBinaryDedicated) {
                    const serverIdBytes = new TextEncoder().encode(dedicatedServerId);
                    const frame = new Uint8Array(1 + 1 + serverIdBytes.length + 2 + 2 + rawData.length);
                    let off = 0;
                    frame[off++] = 0x06;
                    frame[off++] = serverIdBytes.length;
                    frame.set(serverIdBytes, off); off += serverIdBytes.length;
                    const hdr = new DataView(frame.buffer, off, 4);
                    hdr.setUint16(0, targetPort, true);
                    hdr.setUint16(2, sourcePort, true);
                    off += 4;
                    frame.set(rawData, off);
                    this._sendOrQueueRelayFrame(frame, 'dedicated gameplay packet');
                    return;
                }
                try {
                    var dataBase64 = '';
                    try {
                        var binary = '';
                        for (var i = 0; i < rawData.length; i++) {
                            binary += String.fromCharCode(rawData[i]);
                        }
                        dataBase64 = btoa(binary);
                    } catch (e) {
                        dataBase64 = '';
                    }
                    this.ws.send(JSON.stringify({
                        type: 'send_to_dedicated',
                        serverId: dedicatedServerId,
                        targetPort: targetPort,
                        sourcePort: sourcePort,
                        dataBase64: dataBase64
                    }));
                } catch (err) {
                    this.stats.relaySocketSendErrors += 1;
                }
                return;
            }

            const targetPeerId = this.ipToPeer[address];
            if (!targetPeerId) return;

            const purpose = this._inferRelayPurpose(targetPort, sourcePort, rawData, false);

            const entry = this.connections[address];
            if (!this._relayOnlyModeEnabled() &&
                entry && this._isConnectionUsable(entry)) {
                const dc = entry.conn.dataChannel;
                const congested = dc && typeof dc.bufferedAmount === 'number'
                    && dc.bufferedAmount > this._maxDataChannelBufferedAmount;
                const directPayloadLimit = (this._maxDirectPeerPayloadBytes | 0) > 0
                    ? (this._maxDirectPeerPayloadBytes | 0)
                    : (8 * 1024);
                const allowDirectPayload = rawData.length <= directPayloadLimit;
                if (!congested && allowDirectPayload) {
                    try {
                        const payload = new Uint8Array(4 + rawData.length);
                        const view = new DataView(payload.buffer);
                        view.setUint16(0, targetPort, true);
                        view.setUint16(2, sourcePort, true);
                        payload.set(rawData, 4);
                        entry.conn.send(payload);
                        const diag = this._ensurePeerDiagnostics(entry.peerId);
                        if (diag) diag.directSends += 1;
                        this._setRelayQuality(entry.peerId, 'direct', 'datachannel-send');
                        this.stats.ppsOut++;
                        this.stats.bpsOut += rawData.length;
                        return;
                    } catch (err) {
                        const diag = this._ensurePeerDiagnostics(entry.peerId);
                        if (diag) diag.relayFallbacks += 1;
                    }
                } else {
                    const diag = this._ensurePeerDiagnostics(entry.peerId);
                    if (diag) diag.relayFallbacks += 1;
                    if (!allowDirectPayload && entry.peerId) {
                        this._setRelayQuality(entry.peerId, 'relay', 'payload-too-large');
                    }
                }
            }

            this.stats.ppsOut++;
            this.stats.bpsOut += rawData.length;
            const peerIdBytes = new TextEncoder().encode(targetPeerId);
            const frame = new Uint8Array(1 + 1 + peerIdBytes.length + 2 + 2 + rawData.length);
            let off = 0;
            frame[off++] = 0x01; // BIN_SEND_TO_PEER
            frame[off++] = peerIdBytes.length;
            frame.set(peerIdBytes, off); off += peerIdBytes.length;
            const hdr = new DataView(frame.buffer, off, 4);
            hdr.setUint16(0, targetPort, true);
            hdr.setUint16(2, sourcePort, true);
            off += 4;
            frame.set(rawData, off);
            this._setRelayQuality(targetPeerId, 'relay', purpose);
            this._sendOrQueueRelayFrame(frame, purpose);
            if (!this._relayOnlyModeEnabled()) {
                this.establishConnection(address, targetPeerId);
            }
        },

        sendPacket: function (address, targetPort, sourcePort, data) {
            this.stats.bridgeCalls++;
            this._initStatsTicker();
            this._sendPacketInternal(address, targetPort, sourcePort, data);
        },


        _shouldInitiateConnection: function (targetPeerId) {
            if (!this.peerId || !targetPeerId) return true;
            return String(this.peerId) < String(targetPeerId);
        },

        establishConnection: function (address, targetPeerId) {
            if (this._relayOnlyModeEnabled()) return;
            if (this.connections[address]) return;
            if (!this.shouldLobbyBeActive()) return;
            if (!this.peer || this.peer.destroyed || this.peer.disconnected || !this.peerId) return;
            const session = this._peerSessionState[targetPeerId];
            if (session && (session.state === 'open' || session.state === 'incoming-connecting' || session.state === 'dialing')) {
                return;
            }
            if (!this._shouldInitiateConnection(targetPeerId)) {
                return;
            }
            const now = Date.now();
            const lastDial = this._recentDialByPeer[targetPeerId] || 0;
            const diag = this._ensurePeerDiagnostics(targetPeerId);
            if ((now - lastDial) < this._dialCooldownMs) {
                if (diag) diag.dialCooldownSkips += 1;
                return;
            }
            if (diag) diag.dialAttempts += 1;
            this._recentDialByPeer[targetPeerId] = now;
            this._setPeerSessionState(targetPeerId, 'dialing', 'establishConnection');
            const conn = this.peer.connect(targetPeerId, { reliable: true, serialization: 'binary' });
            this._bindConnection(address, conn, targetPeerId);
        },

        notifyConnectionClosed: function (address, port) {
            if (window.Module && typeof window.Module.ccall === 'function') {
                try {
                    window.Module.ccall('NotifyWebConnectionClosed', 'void', ['string', 'number'], [address, port]);
                } catch (e) {
                    console.error("Error in NotifyWebConnectionClosed:", e);
                }
            }
        },

        receivePacket: function (address, targetPort, sourcePort, data) {
            this.stats.ppsIn++;
            this.stats.bpsIn += data.length;
            if (window.Module && typeof window.Module.ccall === 'function' && typeof window.Module._malloc === 'function') {
                let ptr = 0;
                try {
                    const len = data.length;
                    if (len > 65535) { // Protect against massive allocation requests
                        return;
                    }
                    ptr = Module._malloc(len);
                    if (!ptr) {
                        return;
                    }
                    Module.HEAPU8.set(data, ptr);

                    Module.ccall('onIncomingPacket', 'void',
                        ['string', 'number', 'number', 'number', 'number'],
                        [address, targetPort, sourcePort, ptr, len]);
                } catch (e) {
                    console.error("Error in onIncomingPacket:", e);
                } finally {
                    if (ptr) {
                        Module._free(ptr);
                    }
                }
            } else {
                console.warn("WASM Module not fully initialized! Packet dropped.");
            }
        },

        _destroyPeer: function () {
            const peer = this.peer;
            this.peer = null;
            this.peerId = null;
            this._peerInitPromise = null;
            this._peerTransportPlanKey = '';

            if (peer && !peer.destroyed) {
                try {
                    peer.destroy();
                } catch (e) {
                }
            }
        }
    },

    // Keyboard + Mouse input manager
    // C++ is authoritative for mode selection. JS follows the selected mode.
    inputManager: {
        pointerLocked: false,
        canvas: null,
        _wasm: false,       // true once WASM module is ready
        _unlockRequested: false,
        _gameWantsPointerLock: false,
        _keyboardMouseMode: false,
        _pointerLockPending: false,
        _desiredLockState: false,
        _lastLockAttemptAt: 0,
        _lastTouchAt: 0,
        _suppressMouseUntil: 0,
        _blockedCloseShortcutUntil: 0,
        _ctrlSprintGuardUntil: 0,
        _fullscreenPending: false,
        _keyboardLockPending: false,
        _keyboardLockActive: false,
        _keyboardLockRetryAt: 0,
        _lastCanvasFocusAt: 0,
        _keyboardLockCodes: [
            'ControlLeft', 'ControlRight',
            'KeyW', 'KeyA', 'KeyS', 'KeyD',
            'Space', 'ShiftLeft', 'ShiftRight',
            'KeyE', 'KeyC', 'KeyQ', 'KeyT', 'KeyF', 'KeyX', 'KeyU',
            'Tab', 'Escape',
            'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'
        ],
        _pressedKeys: {},

        _focusCanvas: function (force) {
            if (!this.canvas) return;
            if (window.MCPEBridge && MCPEBridge.keyboard && MCPEBridge.keyboard.visible) return;
            if (document.activeElement === this.canvas) return;
            const now = Date.now();
            if (!force && now - this._lastCanvasFocusAt < 250) return;
            this._lastCanvasFocusAt = now;
            try {
                if (typeof this.canvas.focus === 'function') {
                    this.canvas.focus({ preventScroll: true });
                }
            } catch (e) {
                try {
                    this.canvas.focus();
                } catch (ignored) { }
            }
        },


        _shouldSuppressSyntheticMouse: function (e) {
            const now = Date.now();
            if (now > this._suppressMouseUntil) return false;
            if (this.pointerLocked) return false;
            if (e && e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents === true) {
                return true;
            }
            if (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) {
                return true;
            }
            return false;
        },

        _markTouchInteraction: function () {
            const now = Date.now();
            this._lastTouchAt = now;
            this._suppressMouseUntil = now + 700;
        },

        _releasePressedKeys: function () {
            const pressedKeys = this._pressedKeys;
            this._pressedKeys = {};
            this._blockedCloseShortcutUntil = 0;
            if (!this._wasm || !window.Module || !Module._onNativeKey) return;

            Object.keys(pressedKeys).forEach((key) => {
                if (pressedKeys[key] === true) {
                    Module._onNativeKey(Number(key), 0);
                }
            });
            if (window.Module && Module._onNativeInputFocusLost) {
                Module._onNativeInputFocusLost();
            }
        },

        _getFullscreenElement: function () {
            return document.fullscreenElement || document.webkitFullscreenElement || null;
        },

        _canUseKeyboardLock: function () {
            return !!(navigator.keyboard && typeof navigator.keyboard.lock === 'function');
        },

        _shouldUseKeyboardCapture: function () {
            return this._keyboardMouseMode && this._gameWantsPointerLock && this._isGameFocused();
        },

        _requestKeyboardLock: function (force) {
            if (!this._canUseKeyboardLock() || this._keyboardLockPending) return;
            if (!this._shouldUseKeyboardCapture() || !this._getFullscreenElement()) return;

            const now = Date.now();
            if (!force && now < this._keyboardLockRetryAt) return;
            this._keyboardLockRetryAt = now + 1000;
            this._keyboardLockPending = true;

            try {
                const req = navigator.keyboard.lock(this._keyboardLockCodes);
                if (req && typeof req.then === 'function') {
                    req.then(() => {
                        if (this._shouldUseKeyboardCapture() && this._getFullscreenElement()) {
                            this._keyboardLockActive = true;
                        } else {
                            this._releaseKeyboardLock();
                        }
                    }).catch(() => {
                        this._keyboardLockActive = false;
                    }).finally(() => {
                        this._keyboardLockPending = false;
                    });
                } else {
                    this._keyboardLockActive = true;
                    this._keyboardLockPending = false;
                }
            } catch (e) {
                this._keyboardLockActive = false;
                this._keyboardLockPending = false;
            }
        },

        _requestGameplayKeyboardCapture: function () {
            if (!this._shouldUseKeyboardCapture()) return;
            // Do not auto-enter browser fullscreen from ordinary gameplay clicks.
            // The same canvas gesture path also opens container/menu screens, and
            // fullscreen transitions can race that screen-open flow on desktop web.
            if (!this._getFullscreenElement()) return;
            this._requestKeyboardLock(true);
        },

        _releaseKeyboardLock: function () {
            if (!this._keyboardLockActive && !this._keyboardLockPending) return;
            this._keyboardLockActive = false;
            this._keyboardLockPending = false;
            if (navigator.keyboard && typeof navigator.keyboard.unlock === 'function') {
                try {
                    navigator.keyboard.unlock();
                } catch (e) { }
            }
        },

        _shouldBlockCloseTabUnload: function () {
            return this._keyboardMouseMode
                && this._isGameFocused()
                && (this._pressedKeys[17] === true
                    || Date.now() <= this._ctrlSprintGuardUntil
                    || Date.now() <= this._blockedCloseShortcutUntil);
        },

        init: function (canvas) {
            this.canvas = canvas;
            this._wasm = true;
            if (this.canvas && this.canvas.tabIndex < 0) {
                this.canvas.tabIndex = 0;
            }
            this._focusCanvas(true);

            // Pointer lock change listener
            document.addEventListener('pointerlockchange', () => { this._onPointerLockChange(); });
            document.addEventListener('mozpointerlockchange', () => { this._onPointerLockChange(); });
            document.addEventListener('fullscreenchange', () => { this._onFullscreenChange(); });
            document.addEventListener('webkitfullscreenchange', () => { this._onFullscreenChange(); });

            // Click canvas to re-lock pointer during kb/m gameplay.
            // On touch devices, browsers may synthesize mouse events after touch.
            // Suppress those synthetic mouse events to avoid duplicate actions (e.g. double place).
            canvas.addEventListener('touchstart', () => { this._markTouchInteraction(); }, { passive: true, capture: true });
            canvas.addEventListener('touchend', () => { this._markTouchInteraction(); }, { passive: true, capture: true });

            canvas.addEventListener('mousedown', (e) => {
                if (this._shouldSuppressSyntheticMouse(e)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    return;
                }
                this._onCanvasMouseDown(e);
            }, true);

            canvas.addEventListener('mouseup', (e) => {
                if (this._shouldSuppressSyntheticMouse(e)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    return;
                }
                this._onUserGesture();
            }, true);

            canvas.addEventListener('click', (e) => {
                if (this._shouldSuppressSyntheticMouse(e)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    return;
                }
                this._onUserGesture();
            }, true);

            // Keyboard events – global so they always fire regardless of focus
            document.addEventListener('keydown', (e) => { this._onKeyDown(e); }, true);
            document.addEventListener('keyup', (e) => { this._onKeyUp(e); }, true);
            document.addEventListener('mouseup', () => { this._onUserGesture(); });
            window.addEventListener('blur', () => { this._releasePressedKeys(); });
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    this._releasePressedKeys();
                    this._releaseKeyboardLock();
                }
            });
            window.addEventListener('focus', () => {
                if (this._shouldKeepPointerLocked()) {
                    this._requestKeyboardLock(true);
                    this._requestPointerLock(true);
                }
            });
            window.addEventListener('beforeunload', (event) => {
                if (!this._shouldBlockCloseTabUnload()) return undefined;
                event.preventDefault();
                event.returnValue = '';
                return '';
            });
        },

        // --- pointer lock ---

        _shouldKeepPointerLocked: function () {
            return this._keyboardMouseMode && this._gameWantsPointerLock;
        },

        _requestPointerLock: function (force) {
            if (!this.canvas || this.pointerLocked || this._pointerLockPending) return;
            const now = Date.now();
            if (!force && (now - this._lastLockAttemptAt) < 250) return;
            this._lastLockAttemptAt = now;
            try {
                const req = this.canvas.requestPointerLock && this.canvas.requestPointerLock();
                if (!req) {
                    this._pointerLockPending = true;
                    setTimeout(() => {
                        this._pointerLockPending = false;
                    }, 100);
                    return;
                }
                if (req && typeof req.then === 'function') {
                    this._pointerLockPending = true;
                    req.catch(() => {
                        // Browser may reject lock outside a gesture; ignore and retry later.
                    }).finally(() => {
                        this._pointerLockPending = false;
                    });
                }
            } catch (e) { }
        },

        _releasePointerLock: function () {
            if (!this.pointerLocked && !this._pointerLockPending) return;
            this._unlockRequested = true;
            try {
                const req = document.exitPointerLock && document.exitPointerLock();
                if (req && typeof req.catch === 'function') {
                    req.catch(() => { });
                }
            } catch (e) { }
        },

        _onPointerLockChange: function () {
            const wasLocked = this.pointerLocked;
            const unlockWasRequested = this._unlockRequested;
            this.pointerLocked = (document.pointerLockElement === this.canvas ||
                document.mozPointerLockElement === this.canvas);

            if (wasLocked && !this.pointerLocked) {
                this._releasePressedKeys();
                this._releaseKeyboardLock();
                this._unlockRequested = false;

                // When KB/M gameplay loses pointer lock, let native decide whether that
                // should pause. This fixes Escape-on-web cases where the browser unlocks
                // first and the pause key event is swallowed or delayed.
                if (!unlockWasRequested && this._wasm && window.Module && Module._onNativePointerLockReleased) {
                    Module._onNativePointerLockReleased();
                }
            } else if (this.pointerLocked) {
                this._unlockRequested = false;
                this._requestKeyboardLock(true);
            }
        },

        _onFullscreenChange: function () {
            this._fullscreenPending = false;
            if (typeof window.resizeGame === 'function') {
                window.resizeGame();
                requestAnimationFrame(() => {
                    if (typeof window.resizeGame === 'function') {
                        window.resizeGame();
                    }
                });
            }
            if (this._getFullscreenElement()) {
                this._requestKeyboardLock(true);
                return;
            }
            this._releaseKeyboardLock();
        },

        _onUserGesture: function () {
            this._focusCanvas(true);
            if (this._shouldKeepPointerLocked()) {
                this._requestGameplayKeyboardCapture();
                this._requestPointerLock(true);
            }
        },

        // --- input event handlers ---

        _onCanvasMouseDown: function (e) {
            this._focusCanvas(true);
            if (this._shouldKeepPointerLocked()) {
                this._requestGameplayKeyboardCapture();
                this._requestPointerLock(true);
            }
        },

        // Called each frame from C++ to mirror Minecraft::mouseGrabbed.
        syncGamePointerLock: function (shouldLock, keyboardMouseMode) {
            const wasDesired = this._desiredLockState;
            this._keyboardMouseMode = !!keyboardMouseMode;
            this._gameWantsPointerLock = !!shouldLock;
            const shouldLockNow = this._shouldKeepPointerLocked();
            this._desiredLockState = shouldLockNow;
            if (!shouldLockNow) {
                if (wasDesired) {
                    this._releasePressedKeys();
                }
                this._releasePointerLock();
                this._releaseKeyboardLock();
                return;
            }
            if (wasDesired && this.pointerLocked) {
                this._requestKeyboardLock(false);
                return;
            }
            this._focusCanvas(false);
            // Recenter native mouse position so click/pick logic starts from crosshair.
            if (!wasDesired && this._wasm && window.Module && Module._onNativeMouse && this.canvas) {
                const dpr = MCPEBridge.getEffectiveDevicePixelRatio();
                const rect = this.canvas.getBoundingClientRect();
                const cx = ((rect.width * 0.5) * dpr) | 0;
                const cy = ((rect.height * 0.5) * dpr) | 0;
                Module._onNativeMouse(0, 0, cx, cy);
            }
            // Keep requesting during gameplay transitions; successful locks still require browser-approved gestures.
            this._requestKeyboardLock(!wasDesired);
            this._requestPointerLock(!wasDesired);
        },

        // Returns true when a key event should be handled as a game input.
        // Suppressed when the game's virtual keyboard input element has focus
        // (e.g. chat box or sign editing is open).
        _isGameFocused: function () {
            const keyboard = window.MCPEBridge && MCPEBridge.keyboard;
            const kbEl = keyboard && keyboard.element;
            if (keyboard && keyboard.visible) return false;
            if (kbEl && document.activeElement === kbEl) return false;
            return true;
        },

        // Map browser key/code → game key code (matches Keyboard.h constants)
        // Use e.code for Shift to distinguish left (sneak) vs right (utility menu)
        _getKeyCode: function (e) {
            const key = (typeof e === 'string') ? e : (e.key || '');
            const code = (typeof e === 'object' && e.code) ? e.code : '';
            if (code === 'ShiftRight') return 254;   // KEY_RSHIFT (utility menu)
            if (key === 'Shift' || code === 'ShiftLeft') return 10;   // KEY_LSHIFT (sneak)
            if (key === 'Control' || code === 'ControlLeft' || code === 'ControlRight') return 17; // KEY_LCTRL (sprint)
            if (key.length === 1) {
                const upper = key.toUpperCase();
                const charCode = upper.charCodeAt(0);
                if (charCode >= 32 && charCode <= 126) {
                    return charCode;
                }
            }
            if (code === 'Numpad0') return 48;
            if (code === 'Numpad1') return 49;
            if (code === 'Numpad2') return 50;
            if (code === 'Numpad3') return 51;
            if (code === 'Numpad4') return 52;
            if (code === 'Numpad5') return 53;
            if (code === 'Numpad6') return 54;
            if (code === 'Numpad7') return 55;
            if (code === 'Numpad8') return 56;
            if (code === 'Numpad9') return 57;
            switch (key) {
                case 'Backspace': return 8;
                case 'Tab': return 9;
                case 'Enter': return 13;
                case 'Escape': return 27;
                case ' ': return 32;
                case 'ArrowLeft': return 37;
                case 'ArrowUp': return 38;
                case 'ArrowRight': return 39;
                case 'ArrowDown': return 40;
                case 'F1': return 112;
                case 'F2': return 113;
                case 'F3': return 114;
                case 'F4': return 115;
                case 'F5': return 116;
                case 'F6': return 117;
                case 'F7': return 118;
                case 'F8': return 119;
                case 'F9': return 120;
                case 'F10': return 121;
                case 'F11': return 122;
                case 'F12': return 123;
                default: return -1;
            }
        },

        _isBrowserRefreshShortcut: function (e, keyCode) {
            if (!e) return false;
            const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
            if ((e.ctrlKey || e.metaKey) && !e.altKey && key === 'r') {
                return true;
            }
            return keyCode === 116;
        },

        _isBrowserDevToolsShortcut: function (e, keyCode) {
            if (!e) return false;
            return keyCode === 123;
        },

        _isBrowserCloseTabShortcut: function (e) {
            if (!e) return false;
            const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
            return (e.ctrlKey || e.metaKey) && !e.altKey && key === 'w';
        },

        _markBlockedCloseShortcut: function () {
            this._blockedCloseShortcutUntil = Date.now() + 1500;
        },

        _consumeBlockedCloseShortcut: function () {
            if (this._shouldBlockCloseTabUnload()) {
                return true;
            }
            if (Date.now() > this._blockedCloseShortcutUntil) {
                this._blockedCloseShortcutUntil = 0;
                return false;
            }
            this._blockedCloseShortcutUntil = 0;
            return true;
        },

        _onKeyDown: function (e) {
            const keyCode = this._getKeyCode(e);
            if (this._keyboardMouseMode && this._isGameFocused() && keyCode === 17) {
                this._ctrlSprintGuardUntil = Date.now() + 30000;
            }
            if (this._isBrowserCloseTabShortcut(e) && (this._keyboardMouseMode || this.pointerLocked) && this._isGameFocused()) {
                this._markBlockedCloseShortcut();
                e.preventDefault();
                e.stopPropagation();
                if (e.stopImmediatePropagation) {
                    e.stopImmediatePropagation();
                }
            }
            if (!this._keyboardMouseMode) return;
            if (!this._isGameFocused()) return;

            this._focusCanvas();
            if (this._isBrowserRefreshShortcut(e, keyCode)) {
                this._releasePressedKeys();
                return;
            }
            if (this._isBrowserDevToolsShortcut(e, keyCode)) {
                this._releasePressedKeys();
                return;
            }
            if (keyCode >= 0 && this._pressedKeys[keyCode]) {
                e.preventDefault();
                return;
            }
            if (keyCode === 27 && this.pointerLocked) {
                this._pressedKeys[keyCode] = 'escape-lock';
                this._unlockRequested = true;
                e.preventDefault();
                if (this._wasm && window.Module && Module._onNativeEscapeWhilePointerLocked) {
                    Module._onNativeEscapeWhilePointerLocked();
                    return;
                }
            }
            if (keyCode < 0) {
                const isPrintable = typeof e.key === 'string'
                    && e.key.length === 1
                    && !e.ctrlKey
                    && !e.metaKey
                    && !e.altKey;
                if (isPrintable && this._wasm && window.Module && Module._onNativeChar) {
                    Module._onNativeChar(e.key.charCodeAt(0));
                    e.preventDefault();
                }
                return;
            }

            if (keyCode >= 0 && this._shouldKeepPointerLocked()) {
                this._requestPointerLock();
            }

            // Prevent browser defaults (scrolling on Space, back-nav on Backspace, etc.)
            e.preventDefault();

            if (this._wasm && window.Module && Module._onNativeKey) {
                this._pressedKeys[keyCode] = true;
                Module._onNativeKey(keyCode, 1);   // key down
            }
        },

        _onKeyUp: function (e) {
            if (!this._keyboardMouseMode) return;

            const keyCode = this._getKeyCode(e);
            if (keyCode === 17) {
                this._ctrlSprintGuardUntil = 0;
            }
            if (this._isBrowserRefreshShortcut(e, keyCode)) {
                return;
            }
            if (this._isBrowserDevToolsShortcut(e, keyCode)) {
                return;
            }
            if (keyCode < 0) return;
            const pressState = this._pressedKeys[keyCode];
            delete this._pressedKeys[keyCode];

            if (!pressState) {
                e.preventDefault();
                return;
            }

            e.preventDefault();

            if (pressState === 'escape-lock') {
                return;
            }

            if (this._wasm && window.Module && Module._onNativeKey) {
                Module._onNativeKey(keyCode, 0);   // key up
            }
        }
    },

    _generateUuid: function () {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    },

    _writeUuidCookie: function (uuid) {
        document.cookie = 'ninecraft_uuid=; path=/; max-age=0; SameSite=Lax';
        if (uuid) {
            document.cookie = 'mcpe_uuid=' + uuid + '; path=/; max-age=31536000; SameSite=Lax';
        } else {
            document.cookie = 'mcpe_uuid=; path=/; max-age=0; SameSite=Lax';
        }
    },

    getAccountOrigin: function () {
        if (typeof window !== 'undefined' && typeof window.__ORYNX_ACCOUNT_ORIGIN === 'string' && window.__ORYNX_ACCOUNT_ORIGIN) {
            return window.__ORYNX_ACCOUNT_ORIGIN;
        }
        try {
            if (window.localStorage) {
                const remembered = window.localStorage.getItem('orynx_account_origin');
                if (remembered) {
                    return remembered;
                }
            }
        } catch (err) {}
        try {
            const current = new URL(window.location.origin);
            if (current.hostname.indexOf('game.') === 0) {
                current.hostname = 'account.' + current.hostname.slice(5);
                return current.origin;
            }
            if ((current.hostname === 'localhost' || current.hostname === '127.0.0.1') && current.port !== '3000') {
                current.port = '3000';
                return current.origin;
            }
        } catch (err) {}
        return window.location.origin;
    },

    getGuestUUID: function () {
        let uuid = localStorage.getItem('mcpe_guest_uuid');
        if (!uuid) {
            uuid = localStorage.getItem('mcpe_uuid') || localStorage.getItem('ninecraft_uuid');
        }
        if (!uuid) {
            uuid = this._generateUuid();
        }
        localStorage.setItem('mcpe_guest_uuid', uuid);
        localStorage.removeItem('mcpe_uuid');
        localStorage.removeItem('ninecraft_uuid');
        return uuid;
    },

    rotateGuestUUID: function () {
        const uuid = this._generateUuid();
        localStorage.setItem('mcpe_guest_uuid', uuid);
        if (!window.mcpe_uuid) {
            this._writeUuidCookie(uuid);
        }
        localStorage.setItem('mcpe_guest_alias', this._buildGuestAlias(uuid));
        return uuid;
    },

    _buildGuestAlias: function (uuid) {
        const normalized = String(uuid || '')
            .replace(/[^a-zA-Z0-9]/g, '')
            .toUpperCase();
        const suffix = (normalized.slice(-4) || '0000').padStart(4, '0');
        return `Guest-${suffix}`;
    },

    getGuestAlias: function () {
        const guestUuid = this.getGuestUUID();
        const expectedAlias = this._buildGuestAlias(guestUuid);
        const currentAlias = localStorage.getItem('mcpe_guest_alias') || '';
        if (currentAlias !== expectedAlias) {
            localStorage.setItem('mcpe_guest_alias', expectedAlias);
        }
        return expectedAlias;
    },

    setAuthenticatedSession: function (username, uuid, sessionData) {
        if (!uuid) {
            return this.clearAuthenticatedSession(username || '');
        }
        const guestUuid = this.getGuestUUID();
        if (guestUuid === uuid) {
            this.rotateGuestUUID();
        }
        window.mcpe_uuid = uuid;
        this._writeUuidCookie(uuid);
        if (this.cosmetics && typeof this.cosmetics.onAuthenticatedSession === 'function') {
            this.cosmetics.onAuthenticatedSession(username || '', uuid, sessionData || {});
        }
        if (window.Module && window.Module.ccall) {
            window.Module.ccall('mcpe_applyRuntimeAuthState', 'v', ['number', 'string', 'string'], [1, username || '', uuid]);
        }
        if (this.network) {
            this.network.refreshClientProfile();
            this.network.refreshPeerVerification('auth-session');
        }
        return uuid;
    },

    clearAuthenticatedSession: function (username) {
        window.mcpe_uuid = null;
        const guestUuid = this.getGuestUUID();
        this._writeUuidCookie(guestUuid);
        const guestAlias = this.getGuestAlias();
        if (window.Module && window.Module.ccall) {
            window.Module.ccall('mcpe_applyRuntimeAuthState', 'v', ['number', 'string', 'string'], [0, guestAlias, guestUuid]);
        }
        if (this.cosmetics && typeof this.cosmetics.clearAuthenticatedSession === 'function') {
            this.cosmetics.clearAuthenticatedSession();
        }
        if (this.network) {
            this.network.refreshClientProfile();
            this.network.refreshPeerVerification('guest-session');
        }
        return guestUuid;
    },

    // Client UUID (persistent across sessions)
    getClientUUID: function () {
        const uuid = window.mcpe_uuid || this.getGuestUUID();
        this._writeUuidCookie(uuid);
        return uuid;
    },

    fetchAbyssLeaderboard: function (limit, mcpeUuid, warningMessage) {
        const cache = this.abyssLeaderboard;
        const safeUuid = mcpeUuid || this.getClientUUID();
        const origin = (typeof window !== 'undefined' && window.location && window.location.origin)
            ? window.location.origin
            : '';
        cache.status = 'loading';
        cache.entries = [];
        cache.player = null;
        cache.error = '';
        cache.warning = warningMessage || '';
        cache.lastUuid = safeUuid;
        cache._requestId = (cache._requestId | 0) + 1;
        const requestId = cache._requestId;
        const params = new URLSearchParams();
        params.set('limit', String(limit || 10));
        if (safeUuid) {
            params.set('mcpeUuid', safeUuid);
        }
        const url = (origin ? origin : '') + '/auth/abyss-leaderboard?' + params.toString();

        return fetch(url, {
            method: 'GET',
            credentials: 'same-origin'
        }).then((res) => {
            return res.json().then((data) => ({ ok: res.ok, data: data || {} }));
        }).then(({ ok, data }) => {
            if (cache._requestId !== requestId) {
                return;
            }
            if (!ok || data.success !== true) {
                throw new Error((data && data.error) ? data.error : 'Leaderboard fetch failed');
            }

            cache.entries = Array.isArray(data.entries)
                ? data.entries.map((entry, index) => cache._normalizeEntry(entry, index + 1)).filter(Boolean)
                : [];
            cache.player = cache._normalizePlayer(data.player);
            cache.warning = warningMessage || '';
            cache.error = '';
            cache.status = 'ready';
        }).catch((err) => {
            if (cache._requestId !== requestId) {
                return;
            }
            cache.status = 'error';
            cache.error = (err && err.message) ? err.message : 'Leaderboard unavailable';
            if (!cache.warning) {
                cache.warning = '';
            }
        });
    },

    submitAbyssScore: function (score, username, mcpeUuid) {
        const cache = this.abyssLeaderboard;
        const safeScore = Math.max(0, Number(score || 0) | 0);
        const safeUsername = username || '';
        const safeUuid = mcpeUuid || this.getClientUUID();
        const origin = (typeof window !== 'undefined' && window.location && window.location.origin)
            ? window.location.origin
            : '';
        const postUrl = origin ? origin + '/auth/abyss-score' : '/auth/abyss-score';

        cache.lastScore = safeScore;
        cache.lastUsername = safeUsername;
        cache.lastUuid = safeUuid;

        return fetch(postUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ score: safeScore, username: safeUsername, mcpeUuid: safeUuid })
        }).then((res) => {
            return res.json().then((data) => ({ ok: res.ok, data: data || {} }));
        }).then(({ ok, data }) => {
            if (!ok || data.success !== true) {
                throw new Error((data && data.error) ? data.error : 'Score submit failed');
            }
            return this.fetchAbyssLeaderboard(10, safeUuid, '');
        }).catch((err) => {
            console.warn('[Abyss] Score submit failed:', err);
            return this.fetchAbyssLeaderboard(10, safeUuid, 'Score submit failed; leaderboard may be stale.');
        });
    },

    retryAbyssLeaderboard: function () {
        const cache = this.abyssLeaderboard;
        return this.fetchAbyssLeaderboard(10, cache.lastUuid || '', cache.warning || '');
    },

    // Fullscreen Toggle
    requestFullscreen: function () {
        const el = document.documentElement;
        if (el.requestFullscreen) el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    },

    reconnectLobby: function () {
        if (!this.network) return;
        this.network.closeLobby(true);
        setTimeout(() => {
            this.network.refreshTransportState();
        }, 200);
    },

    joinByIp: function (address) {
        if (!address || typeof address !== 'string') return false;
        const trimmed = address.trim();
        let host = trimmed;
        let port = 19132;
        const colonIdx = trimmed.lastIndexOf(':');
        if (colonIdx > 0) {
            const maybePart = trimmed.substring(colonIdx + 1);
            const parsed = parseInt(maybePart, 10);
            if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
                host = trimmed.substring(0, colonIdx);
                port = parsed;
            }
        }
        if (!host) return false;
        if (!this.network || !this.network.ws || this.network.ws.readyState !== WebSocket.OPEN) {
            console.error('[UDPProxy] Lobby WebSocket not connected');
            return false;
        }
        this.network._pendingUdpProxyJoin = null;
        this.network.ws.send(JSON.stringify({ type: 'udp_proxy_connect', host: host, port: port }));
        return true;
    },

    pollPendingProxyJoin: function () {
        if (!this.network || !this.network._pendingUdpProxyJoin) return '';
        var info = this.network._pendingUdpProxyJoin;
        this.network._pendingUdpProxyJoin = null;
        return JSON.stringify(info);
    }
};

window.MCPEBridge = MCPEBridge;
