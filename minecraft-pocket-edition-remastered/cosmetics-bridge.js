(function () {
    const DEFAULT_SKIN = 'mob/char.png';
    const LOCAL_PROFILE_KEY = 'mcpe_cosmetics_local_profile';
    const REMOTE_PROFILE_KEY = 'mcpe_cosmetics_remote_profiles';
    const RUNTIME_ROOT = '/data/images';
    const PERSISTENT_ROOT = '/home/webuser/game/cache/cosmetics';
    const SKIN_MAX_BYTES = 1024 * 1024;
    const CAPE_MAX_BYTES = 512 * 1024;

    function safeJsonParse(raw, fallbackValue) {
        if (!raw) {
            return fallbackValue;
        }
        try {
            return JSON.parse(raw);
        } catch (err) {
            return fallbackValue;
        }
    }

    function readStoredJson(key, fallbackValue) {
        try {
            return safeJsonParse(window.localStorage.getItem(key), fallbackValue);
        } catch (err) {
            return fallbackValue;
        }
    }

    function writeStoredJson(key, value) {
        try {
            if (value === null || value === undefined) {
                window.localStorage.removeItem(key);
                return;
            }
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch (err) {
        }
    }

    function fileExists(path) {
        try {
            if (!window.FS) {
                return false;
            }
            window.FS.stat(path);
            return true;
        } catch (err) {
            return false;
        }
    }

    function ensureDir(path) {
        if (!window.FS || !path) {
            return;
        }
        try {
            window.FS.mkdirTree(path);
        } catch (err) {
        }
    }

    function sanitizeFileToken(value, fallbackValue) {
        const normalized = String(value || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 48);
        return normalized || fallbackValue;
    }

    function normalizeProfile(profile, username, uuid) {
        const source = profile || {};
        const normalizedUsername = String(source.username || username || '').trim();
        const normalizedUuid = String(source.mcpeUuid || source.uuid || uuid || '').trim();
        const skinValue = String(source.skinValue || '');
        const capeValue = String(source.capeValue || '');
        const skinHash = String(source.skinHash || '');
        const capeHash = String(source.capeHash || '');
        return {
            username: normalizedUsername,
            uuid: normalizedUuid,
            remoteId: String(source.remoteId || source.identityKey || '').trim(),
            skinValue: skinValue,
            capeValue: capeValue,
            skinHash: skinHash,
            capeHash: capeHash,
            hasSkin: source.hasSkin === true || !!skinValue || !!skinHash,
            hasCape: source.hasCape === true || !!capeValue || !!capeHash
        };
    }

    function sameProfileValue(a, b) {
        return !!a && !!b &&
            !!a.hasSkin === !!b.hasSkin &&
            !!a.hasCape === !!b.hasCape &&
            String(a.skinHash || '') === String(b.skinHash || '') &&
            String(a.capeHash || '') === String(b.capeHash || '');
    }

    function resolveRemoteProfileKey(remoteId, username) {
        const normalizedRemoteId = String(remoteId || '').trim();
        if (normalizedRemoteId) {
            return 'id:' + normalizedRemoteId;
        }
        const normalizedUsername = String(username || '').trim().toLowerCase();
        return normalizedUsername ? 'name:' + normalizedUsername : '';
    }

    function buildTexturePaths(kind, scopeToken, valueHash) {
        const folder = kind === 'cape' ? 'capes' : 'skins';
        const hashToken = sanitizeFileToken(valueHash, 'default');
        const fileName = sanitizeFileToken(scopeToken, 'player') + '-' + hashToken + '.png';
        return {
            relative: folder + '/' + fileName,
            runtime: RUNTIME_ROOT + '/' + folder + '/' + fileName,
            persistent: PERSISTENT_ROOT + '/' + folder + '/' + fileName
        };
    }

    function isCapePath(path) {
        return typeof path === 'string' && path.indexOf('/capes/') !== -1;
    }

    function logCapeDebug(message) {
        try {
            console.log('[Cosmetics][CapeDebug] ' + message);
        } catch (err) {
        }
    }

    async function fetchJson(url) {
        const response = await fetch(url, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'same-origin'
        });
        if (!response.ok) {
            throw new Error('Request failed: ' + response.status);
        }
        return response.json();
    }

    async function fetchBinary(url) {
        const response = await fetch(url, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'same-origin'
        });
        if (!response.ok) {
            return null;
        }
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        return bytes.length ? bytes : null;
    }

    function getPngDimensions(bytes) {
        if (!bytes || bytes.length < 24) {
            return null;
        }
        const signature = [137, 80, 78, 71, 13, 10, 26, 10];
        for (let i = 0; i < signature.length; i += 1) {
            if (bytes[i] !== signature[i]) {
                return null;
            }
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return {
            width: view.getUint32(16, false),
            height: view.getUint32(20, false)
        };
    }

    function validateTextureBytes(kind, bytes) {
        const maxBytes = kind === 'cape' ? CAPE_MAX_BYTES : SKIN_MAX_BYTES;
        if (!bytes || !bytes.length || bytes.length > maxBytes) {
            return false;
        }
        const dimensions = getPngDimensions(bytes);
        if (!dimensions) {
            return false;
        }
        if (kind === 'cape') {
            return dimensions.width === 64 && dimensions.height === 32;
        }
        return dimensions.width === 64 && (dimensions.height === 32 || dimensions.height === 64);
    }

    function createPixelCanvas(width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (context) {
            context.imageSmoothingEnabled = false;
        }
        return { canvas, context };
    }

    async function canvasToPngBytes(canvas) {
        if (!canvas) {
            return null;
        }
        if (typeof canvas.convertToBlob === 'function') {
            const blob = await canvas.convertToBlob({ type: 'image/png' });
            return new Uint8Array(await blob.arrayBuffer());
        }
        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob((value) => {
                if (value) {
                    resolve(value);
                    return;
                }
                reject(new Error('Failed to encode PNG'));
            }, 'image/png');
        });
        return new Uint8Array(await blob.arrayBuffer());
    }

    async function decodeImageBytes(bytes) {
        const blob = new Blob([bytes], { type: 'image/png' });
        if (typeof createImageBitmap === 'function') {
            try {
                return await createImageBitmap(blob);
            } catch (err) {
            }
        }
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            const image = new Image();
            image.onload = () => {
                URL.revokeObjectURL(url);
                resolve(image);
            };
            image.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to decode cape image'));
            };
            image.src = url;
        });
    }

    async function normalizeCapeTextureBytes(bytes) {
        if (!bytes || !bytes.length || typeof document === 'undefined') {
            return bytes;
        }

        let image = null;
        try {
            image = await decodeImageBytes(bytes);
        } catch (err) {
            return bytes;
        }

        const width = Number(image.width || 0) | 0;
        const height = Number(image.height || 0) | 0;
        logCapeDebug('Decoded fetched cape bytes as ' + width + 'x' + height + ' (' + bytes.length + ' bytes)');
        logCapeDebug('Preserving fetched cape bytes without normalization');
        if (typeof image.close === 'function') {
            image.close();
        }
        return bytes;
    }

    const cosmeticsBridge = {
        _initialized: false,
        _syncTimer: null,
        _localProfile: null,
        _remoteProfiles: {},
        _localRequestPromise: null,
        _remoteRequestPromises: {},

        init: function () {
            if (this._initialized) {
                return;
            }
            ensureDir(RUNTIME_ROOT + '/skins');
            ensureDir(RUNTIME_ROOT + '/capes');
            ensureDir(PERSISTENT_ROOT + '/skins');
            ensureDir(PERSISTENT_ROOT + '/capes');

            const storedLocalProfile = readStoredJson(LOCAL_PROFILE_KEY, null);
            this._localProfile = storedLocalProfile ? normalizeProfile(storedLocalProfile, '', '') : null;
            this._remoteProfiles = readStoredJson(REMOTE_PROFILE_KEY, {});
            this._initialized = true;

            if (this._localProfile && (this._localProfile.skinHash || this._localProfile.capeHash || this._localProfile.username || this._localProfile.uuid)) {
                this._applyLocalCachedProfile(this._localProfile);
            }
        },

        _schedulePersistentSync: function () {
            if (this._syncTimer) {
                clearTimeout(this._syncTimer);
            }
            this._syncTimer = setTimeout(() => {
                this._syncTimer = null;
                if (window.MCPEBridge && typeof window.MCPEBridge.syncFS === 'function') {
                    window.MCPEBridge.syncFS(false).catch(function (err) {
                        console.warn('[Cosmetics] Failed to sync cached files:', err && err.message ? err.message : err);
                    });
                }
            }, 250);
        },

        _copyPersistentToRuntime: function (paths) {
            if (!paths || !fileExists(paths.persistent) || !window.FS) {
                return false;
            }
            try {
                const bytes = window.FS.readFile(paths.persistent);
                window.FS.writeFile(paths.runtime, bytes);
                if (isCapePath(paths.runtime)) {
                    logCapeDebug('Restored cape runtime texture from persistent cache: ' + paths.relative + ' (' + bytes.length + ' bytes)');
                }
                return true;
            } catch (err) {
                console.warn('[Cosmetics] Failed to restore runtime texture:', err && err.message ? err.message : err);
                return false;
            }
        },

        _storePersistentTexture: function (paths, bytes) {
            if (!paths || !bytes || !bytes.length || !window.FS) {
                return false;
            }
            try {
                window.FS.writeFile(paths.persistent, bytes);
                window.FS.writeFile(paths.runtime, bytes);
                if (isCapePath(paths.runtime)) {
                    logCapeDebug('Cached fresh cape runtime texture: ' + paths.relative + ' (' + bytes.length + ' bytes)');
                }
                this._schedulePersistentSync();
                return true;
            } catch (err) {
                console.warn('[Cosmetics] Failed to cache texture:', err && err.message ? err.message : err);
                return false;
            }
        },

        _resolveCachedTexture: function (kind, scopeToken, valueHash) {
            if (!valueHash) {
                return '';
            }
            const paths = buildTexturePaths(kind, scopeToken, valueHash);
            if (fileExists(paths.runtime)) {
                if (kind === 'cape') {
                    logCapeDebug('Using existing runtime cape cache entry: ' + paths.relative);
                }
                return paths.relative;
            }
            if (!this._copyPersistentToRuntime(paths)) {
                return '';
            }
            return paths.relative;
        },

        _loadTextureIntoCache: async function (kind, scopeToken, valueHash, url) {
            if (!valueHash || !url) {
                return '';
            }
            const paths = buildTexturePaths(kind, scopeToken, valueHash);
            if (fileExists(paths.runtime) || this._copyPersistentToRuntime(paths)) {
                if (kind === 'cape') {
                    logCapeDebug('Skipping cape refetch because cache entry already exists: ' + paths.relative);
                }
                return paths.relative;
            }
            const bytes = await fetchBinary(url);
            if (!bytes) {
                return '';
            }
            if (!validateTextureBytes(kind, bytes)) {
                console.warn('[Cosmetics] Rejected invalid ' + kind + ' texture from ' + url);
                return '';
            }
            if (kind === 'cape') {
                logCapeDebug('Fetched fresh cape bytes from ' + url + ' (' + bytes.length + ' bytes)');
            }
            const finalBytes = kind === 'cape'
                ? await normalizeCapeTextureBytes(bytes)
                : bytes;
            if (!this._storePersistentTexture(paths, finalBytes)) {
                return '';
            }
            return paths.relative;
        },

        _applyNativeLocal: function (skinTexture, capeTexture) {
            if (!window.Module || !Module.ccall) {
                return;
            }
            Module.ccall(
                'mcpe_applyLocalPlayerCosmetics',
                'v',
                ['string', 'string'],
                [skinTexture || DEFAULT_SKIN, capeTexture || '']);
        },

        _applyNativeRemote: function (remoteId, username, skinTexture, capeTexture) {
            if ((!remoteId && !username) || !window.Module || !Module.ccall) {
                return;
            }
            Module.ccall(
                'mcpe_applyRemotePlayerCosmetics',
                'v',
                ['string', 'string', 'string', 'string'],
                [remoteId || '', username || '', skinTexture || DEFAULT_SKIN, capeTexture || '']);
        },

        _persistLocalProfile: function (profile) {
            this._localProfile = normalizeProfile(profile, '', '');
            writeStoredJson(LOCAL_PROFILE_KEY, this._localProfile);
        },

        _persistRemoteProfile: function (remoteId, username, profile) {
            const key = resolveRemoteProfileKey(remoteId, username);
            if (!key) {
                return;
            }
            this._remoteProfiles[key] = normalizeProfile({
                ...profile,
                remoteId: String(remoteId || '').trim()
            }, username, '');
            writeStoredJson(REMOTE_PROFILE_KEY, this._remoteProfiles);
        },

        _clearLocalProfile: function () {
            this._localProfile = null;
            writeStoredJson(LOCAL_PROFILE_KEY, null);
        },

        _removeTextureFiles: function (paths) {
            if (!paths || !window.FS) {
                return;
            }
            try {
                if (fileExists(paths.runtime)) {
                    window.FS.unlink(paths.runtime);
                }
            } catch (err) {
            }
            try {
                if (fileExists(paths.persistent)) {
                    window.FS.unlink(paths.persistent);
                }
            } catch (err) {
            }
        },

        _clearProfileTextures: function (scopeToken, profile) {
            if (!profile) {
                return;
            }
            if (profile.skinHash) {
                this._removeTextureFiles(buildTexturePaths('skin', scopeToken, profile.skinHash));
            }
            if (profile.capeHash) {
                this._removeTextureFiles(buildTexturePaths('cape', scopeToken, profile.capeHash));
            }
        },

        _applyLocalCachedProfile: function (profile) {
            const scopeToken = 'self';
            const skinTexture = profile.skinHash
                ? (this._resolveCachedTexture('skin', scopeToken, profile.skinHash) || DEFAULT_SKIN)
                : DEFAULT_SKIN;
            const capeTexture = profile.capeHash
                ? this._resolveCachedTexture('cape', scopeToken, profile.capeHash)
                : '';
            this._applyNativeLocal(skinTexture, capeTexture);
        },

        _applyRemoteCachedProfile: function (remoteId, username, profile) {
            const scopeToken = 'remote-' + sanitizeFileToken(remoteId || username, 'player');
            const skinTexture = profile.skinHash
                ? (this._resolveCachedTexture('skin', scopeToken, profile.skinHash) || DEFAULT_SKIN)
                : DEFAULT_SKIN;
            const capeTexture = profile.capeHash
                ? this._resolveCachedTexture('cape', scopeToken, profile.capeHash)
                : '';
            this._applyNativeRemote(remoteId, username, skinTexture, capeTexture);
        },

        _hasCachedProfileAssets: function (profile, scopeToken) {
            if (!profile) {
                return false;
            }
            const hasSkin = !profile.hasSkin || !!this._resolveCachedTexture('skin', scopeToken, profile.skinHash);
            const hasCape = !profile.hasCape || !!this._resolveCachedTexture('cape', scopeToken, profile.capeHash);
            return hasSkin && hasCape;
        },

        _applyResolvedLocalProfile: async function (profile) {
            const scopeToken = 'self';
            const skinTexture = profile.hasSkin
                ? (await this._loadTextureIntoCache('skin', scopeToken, profile.skinHash, '/auth/my-skin-texture')) || DEFAULT_SKIN
                : DEFAULT_SKIN;
            const capeTexture = profile.hasCape
                ? await this._loadTextureIntoCache('cape', scopeToken, profile.capeHash, '/auth/my-cape-texture')
                : '';
            this._persistLocalProfile(profile);
            this._applyNativeLocal(skinTexture, capeTexture);
        },

        _applyResolvedRemoteProfile: async function (remoteId, username, profile) {
            const scopeToken = 'remote-' + sanitizeFileToken(remoteId || username, 'player');
            const encodedUsername = encodeURIComponent(username);
            const skinTexture = profile.hasSkin
                ? (await this._loadTextureIntoCache('skin', scopeToken, profile.skinHash, '/auth/public-skin-texture?username=' + encodedUsername)) || DEFAULT_SKIN
                : DEFAULT_SKIN;
            const capeTexture = profile.hasCape
                ? await this._loadTextureIntoCache('cape', scopeToken, profile.capeHash, '/auth/public-cape-texture?username=' + encodedUsername)
                : '';
            this._persistRemoteProfile(remoteId, username, profile);
            this._applyNativeRemote(remoteId, username, skinTexture, capeTexture);
        },

        onAuthenticatedSession: function (username, uuid, sessionData) {
            this.init();
            const profile = normalizeProfile(sessionData, username, uuid);
            let promise;
            if (profile.username || profile.uuid || profile.skinHash || profile.capeHash) {
                this._persistLocalProfile(profile);
                if (this._hasCachedProfileAssets(profile, 'self')) {
                    this._applyLocalCachedProfile(profile);
                    promise = Promise.resolve(profile);
                } else {
                    promise = this._applyResolvedLocalProfile(profile).then(() => profile);
                }
            } else {
                promise = this.requestLocalProfile(false);
            }
            const trackedPromise = Promise.resolve(promise).finally(() => {
                if (this._localRequestPromise === trackedPromise) {
                    this._localRequestPromise = null;
                }
            });
            this._localRequestPromise = trackedPromise;
            return trackedPromise;
        },

        clearAuthenticatedSession: function () {
            this.init();
            if (this._localProfile) {
                const localRemoteNameKey = resolveRemoteProfileKey('', this._localProfile.username || '');
                if (localRemoteNameKey && this._remoteProfiles[localRemoteNameKey]) {
                    delete this._remoteProfiles[localRemoteNameKey];
                    writeStoredJson(REMOTE_PROFILE_KEY, this._remoteProfiles);
                }
                this._clearProfileTextures('self', this._localProfile);
            }
            this._clearLocalProfile();
            this._applyNativeLocal(DEFAULT_SKIN, '');
            this._schedulePersistentSync();
        },

        requestLocalProfile: function (forceRefresh) {
            this.init();
            if (this._localRequestPromise && !forceRefresh) {
                return this._localRequestPromise;
            }

            const currentProfile = this._localProfile;
            if (!forceRefresh && currentProfile &&
                this._hasCachedProfileAssets(currentProfile, 'self') &&
                (currentProfile.skinHash || currentProfile.capeHash || currentProfile.username || currentProfile.uuid)) {
                this._applyLocalCachedProfile(currentProfile);
                this._localRequestPromise = Promise.resolve(currentProfile);
                return this._localRequestPromise;
            }

            this._localRequestPromise = fetchJson('/auth/validate').then((data) => {
                if (!data || data.authenticated !== true) {
                    this._clearLocalProfile();
                    this._applyNativeLocal(DEFAULT_SKIN, '');
                    return null;
                }

                const profile = normalizeProfile(data, data.username || '', data.mcpeUuid || '');
                if (!forceRefresh && currentProfile &&
                    sameProfileValue(currentProfile, profile) &&
                    this._hasCachedProfileAssets(currentProfile, 'self')) {
                    this._persistLocalProfile(profile);
                    this._applyLocalCachedProfile(profile);
                    return profile;
                }

                return this._applyResolvedLocalProfile(profile).then(() => profile);
            }).catch((err) => {
                if (currentProfile) {
                    this._applyLocalCachedProfile(currentProfile);
                    return currentProfile;
                }
                this._applyNativeLocal(DEFAULT_SKIN, '');
                return null;
            }).finally(() => {
                this._localRequestPromise = null;
            });

            return this._localRequestPromise;
        },

        requestRemoteProfile: function (remoteId, username) {
            this.init();
            const normalizedRemoteId = String(remoteId || '').trim();
            const normalizedUsername = String(username || '').trim();
            const profileKey = resolveRemoteProfileKey(normalizedRemoteId, normalizedUsername);
            if (!profileKey || !normalizedUsername) {
                return Promise.resolve(null);
            }
            if (this._remoteRequestPromises[profileKey]) {
                return this._remoteRequestPromises[profileKey];
            }

            const cachedProfile = this._remoteProfiles[profileKey]
                ? normalizeProfile(this._remoteProfiles[profileKey], normalizedUsername, '')
                : null;

            this._remoteRequestPromises[profileKey] = fetchJson('/auth/public-cosmetics?username=' + encodeURIComponent(normalizedUsername)).then((data) => {
                const profile = normalizeProfile({
                    ...(data || {}),
                    username: normalizedUsername,
                    remoteId: normalizedRemoteId
                }, normalizedUsername, '');
                if (!profile.hasSkin && !profile.hasCape) {
                    this._persistRemoteProfile(normalizedRemoteId, normalizedUsername, {
                        username: normalizedUsername,
                        remoteId: normalizedRemoteId,
                        skinValue: '',
                        capeValue: '',
                        skinHash: '',
                        capeHash: '',
                        hasSkin: false,
                        hasCape: false
                    });
                    this._applyNativeRemote(normalizedRemoteId, normalizedUsername, DEFAULT_SKIN, '');
                    return null;
                }

                if (cachedProfile &&
                    sameProfileValue(cachedProfile, profile) &&
                    this._hasCachedProfileAssets(cachedProfile, 'remote-' + sanitizeFileToken(normalizedRemoteId || normalizedUsername, 'player'))) {
                    this._persistRemoteProfile(normalizedRemoteId, normalizedUsername, profile);
                    this._applyRemoteCachedProfile(normalizedRemoteId, normalizedUsername, profile);
                    return profile;
                }

                return this._applyResolvedRemoteProfile(normalizedRemoteId, normalizedUsername, profile).then(() => profile);
            }).catch((err) => {
                if (cachedProfile) {
                    this._applyRemoteCachedProfile(normalizedRemoteId, normalizedUsername, cachedProfile);
                    return cachedProfile;
                }
                this._applyNativeRemote(normalizedRemoteId, normalizedUsername, DEFAULT_SKIN, '');
                return null;
            }).finally(() => {
                delete this._remoteRequestPromises[profileKey];
            });

            return this._remoteRequestPromises[profileKey];
        }
    };

    window.MCPEBridge = window.MCPEBridge || {};
    window.MCPEBridge.cosmetics = cosmeticsBridge;
})();
