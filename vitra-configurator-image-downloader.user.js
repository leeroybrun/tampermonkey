// ==UserScript==
// @name         Vitra Configurator Image Downloader
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Download product images from Vitra's configurator. Extract high-res images from 3D viewer, batch download ALL configurations with progress tracking.
// @author       You
// @match        https://www.vitra.com/*/product/details/*
// @match        https://www.vitra.com/*/product/*
// @match        https://*.vitra.com/*/product/*
// @icon         https://www.vitra.com/favicons/favicon-32x32.png
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // In Tampermonkey with @grant, the script runs in a sandboxed world.
    // Access page-defined JS objects (like Emersya's `stage`) via `unsafeWindow`.
    const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════
    const CONFIG = {
        // 3D Viewer capture settings
        // Note: Actual size depends on native canvas resolution (won't upscale)
        viewerCapture: {
            defaultWidth: 2048,  // Max width (won't exceed native)
            defaultHeight: 1536, // Max height - 1.333 ratio (4:3 landscape)
            format: 'png',
            defaultUseWhiteBackground: true,
            defaultUseFullscreenBoost: true
        },
        
        batchDownload: {
            concurrency: 1,           // For 3D captures, do one at a time
            delayBetweenCaptures: 1500, // Time to wait for 3D render
            retryAttempts: 3,
            retryDelay: 2000,
            clickDelay: 400
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════════
    const state = {
        // Product info
        productName: '',
        
        // Viewer capture preferences
        viewerCapture: {
            useWhiteBackground: GM_getValue('viewerCaptureUseWhiteBackground', CONFIG.viewerCapture.defaultUseWhiteBackground),
            useFullscreenBoost: GM_getValue('viewerCaptureUseFullscreenBoost', CONFIG.viewerCapture.defaultUseFullscreenBoost)
        },

        // Emersya internals (discovered at runtime)
        emersya: {
            hookedApiCore: false,
            api: null,
            baselineBackgroundCall: null,
            lastBackgroundCall: null
        },
        
        // Option enumeration
        optionGroups: [],
        
        // Batch state
        batch: {
            isRunning: false,
            isPaused: false,
            shouldStop: false,
            currentIndex: 0,
            totalImages: 0,
            startTime: null,
            selectedGroups: new Set(),
            valueSelections: new Map(), // groupIdx -> Set(valueIdx)
            downloadedBytes: 0,
            completedCount: 0,
            failedCount: 0,
            failedItems: [],
            captureWidth: null,
            captureHeight: null,
            lastApplied: null, // Map(groupName -> valueLabel) for diff-apply optimization
            plan: null // computed at start/resume
        },
        
        // UI
        modal: null,
        panel: null
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════════════════
    const log = (...args) => console.log('[Vitra DL]', ...args);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const getElementText = (el) => {
        if (!el) return '';
        const parts = [
            el.getAttribute?.('aria-label'),
            el.getAttribute?.('title'),
            el.innerText,
            el.textContent
        ].filter(Boolean);
        return (parts.find(s => String(s).trim().length) || '')
            .toString()
            .replace(/\s+/g, ' ')
            .trim();
    };

    const findConfiguratorRoot = () => {
        // Prefer the active configurator panel (where options/buttons live)
        const addToCart = [...document.querySelectorAll('button,[role="button"]')]
            .find(el => /ajouter au panier|add to cart/i.test(getElementText(el)));
        if (addToCart) {
            const root = addToCart.closest('[data-type*="configure"], [class*="configure"], [class*="configurator"], main, body');
            if (root) return root;
        }
        const byDataType = document.querySelector('[data-type="vitra--configure"], [data-type*="configure"]');
        if (byDataType) return byDataType;
        return document.body;
    };

    const queryClickables = (root) => {
        const r = root || document;
        return [...r.querySelectorAll('button,[role="button"]')];
    };
    
    const sanitizeFilename = (name) => {
        return name
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 80);
    };

    const formatTime = (seconds) => {
        if (!seconds || seconds === Infinity) return '--';
        if (seconds < 60) return `${Math.round(seconds)}s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
        return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    };

    const formatNumber = (n) => n.toLocaleString();

    const getBatchStorageKey = () => {
        const href = (location.href || '').split('#')[0];
        return `vitra-dl:batch:${href}`;
    };

    const batchPersistSave = (extra = {}) => {
        try {
            const b = state.batch;
            if (!b.plan) return;
            const payload = {
                v: 1,
                url: (location.href || '').split('#')[0],
                productName: state.productName || '',
                savedAt: Date.now(),
                plan: b.plan,
                currentIndex: b.currentIndex,
                totalImages: b.totalImages,
                downloadedBytes: b.downloadedBytes,
                completedCount: b.completedCount,
                failedCount: b.failedCount,
                failedItems: b.failedItems?.slice?.(-200) || [],
                captureWidth: b.captureWidth,
                captureHeight: b.captureHeight,
                ...extra
            };
            GM_setValue(getBatchStorageKey(), payload);
        } catch (e) {
            log('Persist save failed:', e?.message);
        }
    };

    const batchPersistLoad = () => {
        try {
            return GM_getValue(getBatchStorageKey(), null);
        } catch {
            return null;
        }
    };

    const batchPersistClear = () => {
        try {
            GM_setValue(getBatchStorageKey(), null);
        } catch (e) {
            log('Persist clear failed:', e?.message);
        }
    };
    
    const formatSize = (bytes) => {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    };

    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

    const isCanvasLikelyBlank = (canvas) => {
        // Fast heuristic: downscale to small canvas and check min/max variance.
        // Returns true if nearly uniform (often the case for blank/cleared frames).
        const w = canvas.width || 0;
        const h = canvas.height || 0;
        if (w < 16 || h < 16) return true;
        const s = document.createElement('canvas');
        s.width = 64;
        s.height = 64;
        const ctx = s.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(canvas, 0, 0, 64, 64);
        const data = ctx.getImageData(0, 0, 64, 64).data;
        let min = 255, max = 0;
        for (let i = 0; i < data.length; i += 16) {
            // sample a subset of pixels for speed
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];
            const v = (r + g + b + a) >> 2;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        return (max - min) < 6;
    };

    const waitForCanvasToRender = async (canvas, { timeoutMs = 2500, minW = 200, minH = 200 } = {}) => {
        const start = Date.now();
        let lastReason = '';
        while (Date.now() - start < timeoutMs) {
            if (!canvas?.isConnected) {
                lastReason = 'canvas not connected';
            } else if ((canvas.width || 0) < minW || (canvas.height || 0) < minH) {
                lastReason = `small buffer ${canvas.width}x${canvas.height}`;
            } else if (isCanvasLikelyBlank(canvas)) {
                lastReason = 'blank/uniform frame';
            } else {
                return true;
            }
            await nextFrame();
            await sleep(60);
        }
        log('Canvas did not look ready in time:', lastReason, `(buffer ${canvas?.width}x${canvas?.height})`);
        return false;
    };

    // (Legacy viewer blocking + placeholder capture removed in v4.0 — 3D capture only)

    // ═══════════════════════════════════════════════════════════════════════════
    // 3D VIEWER CANVAS CAPTURE (NEW FEATURE!)
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Find the 3D viewer canvas element
     */
    const findViewerCanvas = () => {
        // Emersya viewer typically uses a canvas
        const canvases = document.querySelectorAll('canvas');
        
        for (const canvas of canvases) {
            // Look for WebGL canvas (the 3D viewer)
            try {
                // Try to get existing context without creating a new one
                const ctx = canvas.getContext('webgl', { preserveDrawingBuffer: true }) || 
                           canvas.getContext('webgl2', { preserveDrawingBuffer: true });
                if (ctx || canvas.width > 400) {
                    // Check if it's in the configurator section
                    const parent = canvas.closest('[class*="configurator"], [class*="viewer"], [class*="product"], [class*="emersya"]');
                    if (parent || canvas.width >= 500) {
                        log('Found viewer canvas:', canvas.width, 'x', canvas.height);
                        return canvas;
                    }
                }
            } catch (e) {
                // Context might already exist
                if (canvas.width >= 500) {
                    log('Found large canvas:', canvas.width, 'x', canvas.height);
                    return canvas;
                }
            }
        }
        
        // Fallback: largest canvas
        let largest = null;
        let maxArea = 0;
        canvases.forEach(c => {
            const area = c.width * c.height;
            if (area > maxArea) {
                maxArea = area;
                largest = c;
            }
        });
        
        if (largest) {
            log('Using largest canvas as fallback:', largest.width, 'x', largest.height);
        }
        
        return largest;
    };

    /**
     * Force preserve drawing buffer on WebGL context
     * Note: This only works if called BEFORE the context is created
     */
    const patchWebGLForCapture = () => {
        // Monkey-patch getContext to always include preserveDrawingBuffer
        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, attributes = {}) {
            if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
                attributes.preserveDrawingBuffer = true;
            }
            return originalGetContext.call(this, type, attributes);
        };
        log('WebGL patched for capture support');
    };

    /**
     * Emersya API access (Vitra loads Emersya directly, not in an iframe)
     *
     * We hook Emersya's API core once the viewer library loads, then:
     * - Set background via API (preserves shadows; no pixel replacement)
     * - Toggle fullscreen via API (helps increase native canvas resolution before capture)
     */
    const tryHookEmersyaApiCore = () => {
        try {
            const core = PAGE.stage?.emersya?.viewer?.modules?.API?.core;
            if (!core || state.emersya.hookedApiCore) return !!state.emersya.hookedApiCore;

            const origExec = core.prototype.exec;
            if (typeof origExec !== 'function') return false;

            core.prototype.exec = function(...args) {
                // Capture the live API instance used by the viewer
                state.emersya.api = this;

                // Track baseline + last background calls so we can restore after capture
                try {
                    const method = args?.[1];
                    if (method === 'setBackground' || method === 'rdr.setBackgroundColor') {
                        const call = { method, args: args.slice(2) };
                        state.emersya.lastBackgroundCall = call;
                        if (!state.emersya.baselineBackgroundCall) state.emersya.baselineBackgroundCall = call;
                    }
                } catch (_) {}

                return origExec.apply(this, args);
            };

            state.emersya.hookedApiCore = true;
            log('Hooked Emersya API core');
            return true;
        } catch (e) {
            return false;
        }
    };

    const startEmersyaHookWatcher = () => {
        // Viewer library loads only after user opens configurator; keep a light watcher.
        const tick = () => {
            if (state.emersya.hookedApiCore) return true;
            return tryHookEmersyaApiCore();
        };
        if (tick()) return;
        const id = setInterval(() => {
            if (tick()) clearInterval(id);
        }, 500);
    };

    const emersyaExec = (method, ...methodArgs) => {
        const api = state.emersya.api;
        if (!api || typeof api.exec !== 'function') return { ok: false, error: 'No Emersya API instance yet' };
        try {
            const res = api.exec('VitraDL', method, ...methodArgs);
            return { ok: true, result: res };
        } catch (e) {
            return { ok: false, error: e?.message || String(e) };
        }
    };

    const emersyaTrySetWhiteBackground = () => {
        // Best-effort: remove background image, then set solid white.
        let ok = false;
        const calls = [
            ['removeBackgroundImage'],
            ['rdr.removeBackgroundImage'],
            ['setBackground', '#FFFFFF', 1],
            ['rdr.setBackgroundColor', '#FFFFFF', 1]
        ];
        for (const [method, ...args] of calls) {
            const r = emersyaExec(method, ...args);
            if (r.ok) ok = true;
            else log(`Emersya call failed: ${method}(${args.map(String).join(', ')}) -> ${r.error}`);
        }
        if (ok) {
            log('Applied white background via Emersya API');
        } else {
            log('Could not apply white background yet (viewer not ready / API unavailable)');
        }
        return ok;
    };

    const emersyaRestoreBackground = () => {
        const call = state.emersya.baselineBackgroundCall || state.emersya.lastBackgroundCall;
        if (!call) return false;
        const r = emersyaExec(call.method, ...call.args);
        if (r.ok) log('Restored Emersya background');
        return r.ok;
    };

    /**
     * Canvas-only "fullscreen boost" (FACT: Emersya "Plein écran" includes UI).
     * We temporarily move the WebGL canvas into a fixed overlay, sized to the requested aspect ratio.
     * Optionally requests native browser fullscreen on that overlay (user gesture required).
     */
    const withCanvasFullscreenBoost = async ({ targetAspect, requestNativeFullscreen = true } = {}, fn) => {
        const canvas = findViewerCanvas();
        if (!canvas) return await fn();

        // Move the canvas *wrapper* (not the canvas) so the viewer keeps controlling sizing.
        // This avoids CSS-stretching the canvas (which can visually deform the render).
        const wrapper = canvas.parentElement || canvas;
        const original = {
            wrapper,
            parent: wrapper.parentNode,
            nextSibling: wrapper.nextSibling,
            wrapperStyle: wrapper.getAttribute('style') || '',
            canvasStyle: canvas.getAttribute('style') || ''
        };

        const overlay = document.createElement('div');
        overlay.id = 'vdl-canvas-overlay';
        overlay.style.cssText = [
            'position:fixed',
            'inset:0',
            'z-index:2147483647',
            'background:#ffffff',
            'display:flex',
            'align-items:center',
            'justify-content:center'
        ].join(';');

        const stage = document.createElement('div');
        stage.style.cssText = 'position:relative;display:block;';
        overlay.appendChild(stage);
        document.body.appendChild(overlay);

        // Move wrapper into overlay
        stage.appendChild(wrapper);

        const applySizing = () => {
            const vw = window.innerWidth || 1;
            const vh = window.innerHeight || 1;
            const aspect = targetAspect || (CONFIG.viewerCapture.defaultWidth / CONFIG.viewerCapture.defaultHeight);
            let w = vw;
            let h = Math.round(w / aspect);
            if (h > vh) {
                h = vh;
                w = Math.round(h * aspect);
            }
            stage.style.width = `${w}px`;
            stage.style.height = `${h}px`;
            // Let Emersya resize internally; do NOT force canvas CSS width/height.
            wrapper.style.width = `${w}px`;
            wrapper.style.height = `${h}px`;
            wrapper.style.position = 'relative';
            canvas.style.display = 'block';
            canvas.style.maxWidth = '100%';
            canvas.style.maxHeight = '100%';
            return { w, h };
        };

        const before = { w: canvas.width, h: canvas.height };
        const { w: cssW, h: cssH } = applySizing();
        window.dispatchEvent(new Event('resize'));

        // Try native fullscreen for max resolution (optional)
        if (requestNativeFullscreen && document.fullscreenEnabled && overlay.requestFullscreen) {
            try {
                await overlay.requestFullscreen();
                await sleep(150);
                applySizing();
                window.dispatchEvent(new Event('resize'));
            } catch (e) {
                log('Native fullscreen request was blocked:', e?.message || String(e));
            }
        }

        // Wait a bit for viewer to react to resize (if it does)
        const start = Date.now();
        while (Date.now() - start < 1200) {
            // If the drawing buffer has grown, great; if not, we still benefit from cropping to aspect.
            if (canvas.width >= before.w && canvas.height >= before.h) break;
            await sleep(60);
        }
        log(`Canvas boost: buffer ${before.w}x${before.h} -> ${canvas.width}x${canvas.height} (css ${cssW}x${cssH})`);

        try {
            return await fn(canvas);
        } finally {
            // Exit native fullscreen if we entered it
            try {
                if (document.fullscreenElement) await document.exitFullscreen();
            } catch (_) {}

            // Restore canvas back
            try {
                wrapper.setAttribute('style', original.wrapperStyle);
                canvas.setAttribute('style', original.canvasStyle);
                if (original.nextSibling && original.parent) original.parent.insertBefore(wrapper, original.nextSibling);
                else if (original.parent) original.parent.appendChild(wrapper);
            } catch (_) {}
            overlay.remove();
            window.dispatchEvent(new Event('resize'));
        }
    };

    /**
     * Resize and crop canvas to target dimensions (maintain aspect ratio, crop to fit)
     * Only downscales - but ALWAYS crops to the requested aspect ratio.
     */
    const resizeAndCropCanvas = (sourceCanvas, targetWidth, targetHeight) => {
        const srcW = sourceCanvas.width;
        const srcH = sourceCanvas.height;

        // Calculate aspect ratios
        const srcAspect = srcW / srcH;
        const targetAspect = (targetWidth || srcW) / (targetHeight || srcH);
        
        let cropX = 0, cropY = 0, cropW = srcW, cropH = srcH;
        
        if (srcAspect > targetAspect) {
            // Source is wider - crop horizontally
            cropW = srcH * targetAspect;
            cropX = (srcW - cropW) / 2;
        } else if (srcAspect < targetAspect) {
            // Source is taller - crop vertically
            cropH = srcW / targetAspect;
            cropY = (srcH - cropH) / 2;
        }

        // Decide final output size (no upscaling)
        const canDownscaleToTarget = cropW >= targetWidth && cropH >= targetHeight;
        const finalWidth = canDownscaleToTarget ? targetWidth : Math.round(cropW);
        const finalHeight = canDownscaleToTarget ? targetHeight : Math.round(cropH);

        log(`Crop ${srcW}x${srcH} -> ${finalWidth}x${finalHeight} (crop: ${Math.round(cropX)},${Math.round(cropY)} ${Math.round(cropW)}x${Math.round(cropH)}; downscale:${canDownscaleToTarget})`);

        const outputCanvas = document.createElement('canvas');
        outputCanvas.width = finalWidth;
        outputCanvas.height = finalHeight;
        const ctx = outputCanvas.getContext('2d');
        
        // Use high-quality image smoothing
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        
        // Draw cropped and scaled image
        ctx.drawImage(
            sourceCanvas,
            cropX, cropY, cropW, cropH,  // Source rectangle
            0, 0, finalWidth, finalHeight // Destination rectangle
        );
        
        return outputCanvas;
    };

    /**
     * Capture and process the 3D viewer at specified resolution
     * - Captures at native size, then crops/resizes (no stretching, no upscaling)
     * - If native canvas is smaller than target, returns at native size
     */
    const captureViewerImage = async (targetWidth, targetHeight, canvasOverride = null) => {
        const canvas = canvasOverride || findViewerCanvas();
        
        if (!canvas) {
            throw new Error('3D viewer canvas not found. Make sure the configurator is open and loaded.');
        }

        log(`Capturing canvas (native: ${canvas.width}x${canvas.height}, max target: ${targetWidth}x${targetHeight})`);

        // Wait for viewer to actually draw (especially after fullscreen/resize)
        await waitForCanvasToRender(canvas);
        await nextFrame();

        // Capture at native size
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(canvas, 0, 0);
        
        // Resize and crop to target dimensions (no stretching, no upscaling)
        const finalCanvas = resizeAndCropCanvas(tempCanvas, targetWidth, targetHeight);
        
        // Export as blob
        const blob = await new Promise((resolve) => finalCanvas.toBlob(resolve, 'image/png', 1.0));
        if (!blob) throw new Error('Canvas toBlob returned null');

        log(`Captured: ${finalCanvas.width}x${finalCanvas.height}, Size: ${formatSize(blob.size)}`);
        return { blob, width: finalCanvas.width, height: finalCanvas.height };
    };

    /**
     * Capture at native size (no resize/crop)
     */
    const captureViewerCurrentSize = async (canvasOverride = null) => {
        const canvas = canvasOverride || findViewerCanvas();
        
        if (!canvas) {
            throw new Error('3D viewer canvas not found');
        }
        
        await waitForCanvasToRender(canvas);
        await nextFrame();

        // Capture at native size
        const outputCanvas = document.createElement('canvas');
        outputCanvas.width = canvas.width;
        outputCanvas.height = canvas.height;
        const ctx = outputCanvas.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        
        const blob = await new Promise((resolve) => outputCanvas.toBlob(resolve, 'image/png', 1.0));
        if (!blob) throw new Error('Canvas toBlob returned null');

        log(`Captured at native: ${canvas.width}x${canvas.height}, Size: ${formatSize(blob.size)}`);
        return { blob, width: canvas.width, height: canvas.height };
    };

    /**
     * Capture 3D viewer using current settings (optional background + fullscreen boost),
     * returning the captured blob and final dimensions. Does NOT auto-download.
     */
    const captureViewerWithSettings = async (width, height, opts = {}) => {
        // Get max dimensions (won't upscale beyond native)
        const targetWidth = width || CONFIG.viewerCapture.defaultWidth;
        const targetHeight = height || CONFIG.viewerCapture.defaultHeight;

        const useWhiteBackground = (opts.useWhiteBackground ?? state.viewerCapture.useWhiteBackground) === true;
        const useFullscreenBoost = (opts.useFullscreenBoost ?? state.viewerCapture.useFullscreenBoost) === true;

        // Best effort: if Emersya is available, apply requested background settings
        // IMPORTANT: use `unsafeWindow` via PAGE to access the real Emersya API.
        tryHookEmersyaApiCore();
        if (useWhiteBackground && state.emersya.hookedApiCore) emersyaTrySetWhiteBackground();

        const doCapture = async (canvasOverride = null) => {
            if (width && height) {
                // Custom size: capture native then crop/downscale (no upscaling)
                return await captureViewerImage(targetWidth, targetHeight, canvasOverride);
            }
            return await captureViewerCurrentSize(canvasOverride);
        };

        let result;
        if (useFullscreenBoost) {
            const aspect = targetWidth / targetHeight;
            result = await withCanvasFullscreenBoost({ targetAspect: aspect, requestNativeFullscreen: true }, async (canvasOverride) => {
                // Try twice inside boost; if still tiny/blank, fall back
                let r = await doCapture(canvasOverride);
                if (r?.blob?.size && r.blob.size < 8000) {
                    log('Capture looks blank/tiny; retrying after short wait...');
                    await sleep(250);
                    r = await doCapture(canvasOverride);
                }
                return r;
            });
        } else {
            result = await doCapture();
        }

        if (useFullscreenBoost && result?.blob?.size && result.blob.size < 8000) {
            log('Boosted capture still looks blank/tiny; falling back to non-boost capture...');
            result = await doCapture();
        }

        return result;
    };

    /**
     * Capture and download current 3D viewer state
     * Note: Image size depends on native canvas resolution - will not upscale
     */
    const downloadViewerCapture = async (width, height, opts = {}) => {
        try {
            updatePanelStatus('📸 Capturing...');
            
            const result = await captureViewerWithSettings(width, height, opts);
            
            const base = sanitizeFilename(state.productName || 'capture');
            const filename = `vitra_3d_${base}_${result.width}x${result.height}_${Date.now()}.png`;
            downloadBlob(result.blob, filename);
            
            updatePanelStatus(`✓ ${result.width}x${result.height}`);

            // Cleanup handled by withCanvasFullscreenBoost

            return result.blob;
            
        } catch (e) {
            log('Capture error:', e);
            updatePanelStatus('❌ ' + e.message);
            alert('Failed to capture 3D viewer:\n' + e.message);
            throw e;
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // OPTION ENUMERATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    const findOptionButtons = () => {
        const root = findConfiguratorRoot();
        const buttons = queryClickables(root);
        const optionButtons = [];
        
        for (const btn of buttons) {
            const text = getElementText(btn);
            // Matches e.g. "Placage6 options Palissandre Santos" (including newlines/nbsp)
            const match = text.match(/^(.+?)\s*(\d+)\s*options?\s+([\s\S]+)$/i);
            if (match) {
                optionButtons.push({
                    button: btn,
                    name: match[1].trim(),
                    count: parseInt(match[2]),
                    currentValue: match[3].trim()
                });
            }
        }
        
        return optionButtons;
    };

    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect?.();
        if (!rect) return false;
        return rect.width > 0 && rect.height > 0;
    };

    const isNonValueControlText = (text) => {
        const t = (text || '').trim();
        if (!t) return true;
        return (
            /^filtre$/i.test(t) || /^filter$/i.test(t) ||
            /^comparer$/i.test(t) || /^compare$/i.test(t) ||
            /^reveler$/i.test(t) || /^révéler$/i.test(t) || /^reveal$/i.test(t) ||
            /^fermer$/i.test(t) || /^close$/i.test(t)
        );
    };

    const findCloseButtonIn = (root) => {
        const r = root || document;
        const btns = [...r.querySelectorAll('button,[role="button"]')].filter(isVisible);
        // Prefer explicit "Fermer/Close"
        for (const b of btns) {
            // Never close our own UI
            if (b.closest?.('#vitra-dl-modal, #vitra-dl-panel')) continue;
            const aria = (b.getAttribute?.('aria-label') || b.getAttribute?.('title') || '').trim();
            const t = getElementText(b);
            if (/^fermer$/i.test(t) || /^close$/i.test(t) || /fermer|close/i.test(aria)) return b;
        }
        // Common "X" icon close
        for (const b of btns) {
            if (b.closest?.('#vitra-dl-modal, #vitra-dl-panel')) continue;
            const t = getElementText(b);
            if (t === '×' || t === '✕' || t.toLowerCase() === 'x') return b;
        }
        return null;
    };

    const closeBlockingOverlays = async () => {
        // Never treat our own modal as an overlay to close.
        const ourModal = document.getElementById('vitra-dl-modal');
        const ourPanel = document.getElementById('vitra-dl-panel');

        // Try dialog-like elements first
        const candidates = [
            ...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog')
        ].filter((el) => isVisible(el) && !(ourModal && ourModal.contains(el)) && !(ourPanel && ourPanel.contains(el)));
        for (const c of candidates) {
            const close = findCloseButtonIn(c);
            if (close) {
                close.click();
                await sleep(250);
                return true;
            }
        }

        // Heuristic: if a big "Sélectionner ..." panel is open, close its top-left button
        const headings = [...document.querySelectorAll('h1,h2,h3')].filter(isVisible);
        const selectHeading = headings.find((h) => /sélectionner|select/i.test(getElementText(h)));
        if (selectHeading) {
            const container = selectHeading.closest('section,div') || document;
            const close = findCloseButtonIn(container) || findCloseButtonIn(document);
            if (close) {
                close.click();
                await sleep(250);
                return true;
            }
        }

        // Last resort: global close button
        const globalClose = findCloseButtonIn(document);
        if (globalClose) {
            globalClose.click();
            await sleep(250);
            return true;
        }
        return false;
    };

    const findBackButtonInConfigurator = () => {
        const root = findConfiguratorRoot();
        const buttons = queryClickables(root);
        // Prefer explicit "Retour" button when in option detail view
        for (const b of buttons) {
            if (!isVisible(b)) continue;
            const t = getElementText(b);
            if (/^retour$/i.test(t) || /^back$/i.test(t)) return b;
            const aria = (b.getAttribute?.('aria-label') || '').trim();
            if (/retour|back/i.test(aria)) return b;
        }
        return null;
    };

    const ensureAtGroupList = async () => {
        // If we're inside a detail view, a "Retour" button exists.
        for (let i = 0; i < 3; i++) {
            await closeBlockingOverlays();
            const groups = findOptionButtons();
            if (groups.length) return true;
            const back = findBackButtonInConfigurator();
            if (!back) return findOptionButtons().length > 0;
            back.click();
            await sleep(CONFIG.batchDownload.clickDelay);
        }
        return findOptionButtons().length > 0;
    };

    const normalizeKey = (s) => (s || '')
        .toString()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

    const findScrollableAncestor = (el, stopAt) => {
        let cur = el;
        while (cur && cur !== stopAt && cur !== document.body) {
            const cs = getComputedStyle(cur);
            const scrollable = /(auto|scroll)/.test(cs.overflowY || '') && cur.scrollHeight > cur.clientHeight + 20;
            if (scrollable) return cur;
            cur = cur.parentElement;
        }
        return null;
    };

    const findGroupListScrollContainer = () => {
        const root = findConfiguratorRoot();
        const seed = findOptionButtons()[0]?.button;
        if (seed) {
            const sc = findScrollableAncestor(seed, root);
            if (sc) return sc;
        }
        // Fallback: pick the largest scrollable element inside configurator
        const candidates = [...root.querySelectorAll('*')]
            .filter((n) => n.scrollHeight > n.clientHeight + 40)
            .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
        return candidates[0] || null;
    };

    const ensureConfiguratorTab = async (preferred = 'Configurer') => {
        const root = findConfiguratorRoot();
        const tabs = [...root.querySelectorAll('[role="tab"]')];
        if (!tabs.length) return false;

        const prefKey = normalizeKey(preferred);
        const target = tabs.find((t) => normalizeKey(getElementText(t)) === prefKey) ||
            tabs.find((t) => normalizeKey(getElementText(t)).includes(prefKey));

        if (!target) return false;
        const selected = (target.getAttribute?.('aria-selected') || '') === 'true';
        if (!selected) {
            target.click();
            await sleep(350);
        }
        return true;
    };

    const ensureNoFilterDrawer = async () => {
        const root = findConfiguratorRoot();
        const btns = queryClickables(root).filter(isVisible);
        const close = btns.find((b) => /^fermer$/i.test(getElementText(b)) || /^close$/i.test(getElementText(b)));
        if (close) {
            close.click();
            await sleep(250);
            return true;
        }
        return false;
    };

    const prepareConfiguratorForAutomation = async () => {
        // Best-effort stabilize UI before scanning/clicking
        await closeBlockingOverlays();
        await ensureNoFilterDrawer();
        // Prefer "Configurer" tab, but fall back to "Recommandé" if not present on some pages
        const ok = await ensureConfiguratorTab('Configurer');
        if (!ok) await ensureConfiguratorTab('Recommandé');
        await ensureNoFilterDrawer();
        await closeBlockingOverlays();
    };

    const collectAllGroupNames = async () => {
        await prepareConfiguratorForAutomation();
        await ensureAtGroupList();
        const root = findConfiguratorRoot();
        const scrollEl = findGroupListScrollContainer();

        const names = [];
        const seen = new Set();

        if (scrollEl) scrollEl.scrollTop = 0;
        await sleep(120);

        for (let i = 0; i < 40; i++) {
            const groups = findOptionButtons();
            for (const g of groups) {
                const k = normalizeKey(g.name);
                if (k && !seen.has(k)) {
                    seen.add(k);
                    names.push(g.name);
                }
            }

            if (!scrollEl) break;
            const max = scrollEl.scrollHeight - scrollEl.clientHeight;
            if (max <= 0) break;
            if (scrollEl.scrollTop >= max - 2) break;

            const step = Math.max(160, Math.floor(scrollEl.clientHeight * 0.75));
            scrollEl.scrollTop = Math.min(max, scrollEl.scrollTop + step);
            await sleep(160);
        }

        return { names, scrollEl };
    };

    const scrollToGroupByName = async (groupName, scrollEl) => {
        const target = normalizeKey(groupName);
        if (!target) return null;

        const tryFind = () => {
            const groups = findOptionButtons();
            return groups.find(g => normalizeKey(g.name) === target) || null;
        };

        if (!scrollEl) return null;

        // Deterministic: always start from top (virtualized lists can be anywhere)
        scrollEl.scrollTop = 0;
        await sleep(160);
        let found = tryFind();
        if (found) return found;

        // Scroll down until found or end
        const max = scrollEl.scrollHeight - scrollEl.clientHeight;
        const step = Math.max(160, Math.floor(scrollEl.clientHeight * 0.75));
        for (let i = 0; i < 60; i++) {
            found = tryFind();
            if (found) return found;
            if (scrollEl.scrollTop >= max - 2) break;
            scrollEl.scrollTop = Math.min(max, scrollEl.scrollTop + step);
            await sleep(140);
        }

        return null;
    };

    const findDetailViewContainer = (backBtn) => {
        if (!backBtn) return findConfiguratorRoot();
        let cur = backBtn.parentElement;
        for (let depth = 0; cur && depth < 8; depth++) {
            const buttons = queryClickables(cur).filter(isVisible);
            const valueButtons = buttons.filter((b) => {
                const t = getElementText(b);
                if (!t) return false;
                if (/^retour$/i.test(t) || /^back$/i.test(t)) return false;
                if (isNonValueControlText(t)) return false;
                if (/ajouter au panier|add to cart|panier/i.test(t)) return false;
                if (/\boptions?\b/i.test(t)) return false;
                // Don't treat group buttons as values
                if (/^(.+?)\s*(\d+)\s*options?\s+([\s\S]+)$/i.test(t)) return false;
                return t.length >= 2 && t.length <= 100;
            });
            if (valueButtons.length >= 2) return cur;
            cur = cur.parentElement;
        }
        return findConfiguratorRoot();
    };

    const collectAllValueLabelsInDetail = async (detailRoot) => {
        const root = detailRoot || findConfiguratorRoot();
        const scrollEl = findScrollableAncestor(queryClickables(root).find(isVisible), root) ||
            [...root.querySelectorAll('*')].find((n) => n.scrollHeight > n.clientHeight + 40) ||
            null;

        const labels = [];
        const seen = new Set();

        const collectVisible = () => {
            const buttons = queryClickables(root).filter(isVisible);
            for (const btn of buttons) {
                const text = getElementText(btn);
                if (!text) continue;
                if (/^retour$/i.test(text) || /^back$/i.test(text)) continue;
                if (isNonValueControlText(text)) continue;
                if (/ajouter au panier|add to cart|panier/i.test(text)) continue;
                if (/\boptions?\b/i.test(text)) continue;
                if (/^(.+?)\s*(\d+)\s*options?\s+([\s\S]+)$/i.test(text)) continue; // group button
                if (text.length < 2 || text.length > 100) continue;
                const k = normalizeKey(text);
                if (!k || seen.has(k)) continue;
                seen.add(k);
                labels.push(text);
            }
        };

        if (scrollEl) scrollEl.scrollTop = 0;
        await sleep(120);
        for (let i = 0; i < 50; i++) {
            collectVisible();
            if (!scrollEl) break;
            const max = scrollEl.scrollHeight - scrollEl.clientHeight;
            if (max <= 0) break;
            if (scrollEl.scrollTop >= max - 2) break;
            const step = Math.max(160, Math.floor(scrollEl.clientHeight * 0.75));
            scrollEl.scrollTop = Math.min(max, scrollEl.scrollTop + step);
            await sleep(140);
        }

        return labels;
    };

    /**
     * Enumeration: collect option group names + option labels.
     * Important: Vitra's group list is often virtualized (only visible rows exist in DOM),
     * so we scroll to discover all groups.
     */
    const enumerateAllOptions = async (progressCallback) => {
        log('Starting option enumeration...');
        state.optionGroups = [];
        await prepareConfiguratorForAutomation();
        
        const productHeading = document.querySelector('h1, h2');
        if (productHeading) {
            state.productName = productHeading.textContent.trim().split('\n')[0];
        }
        
        await ensureAtGroupList();
        const { names: groupNames, scrollEl } = await collectAllGroupNames();
        log(`Found ${groupNames.length} option groups`);

        if (groupNames.length === 0) {
            const root = findConfiguratorRoot();
            const sample = queryClickables(root).slice(0, 15).map(getElementText).filter(Boolean);
            log('Debug: sample clickable texts in configurator root:', sample);
            throw new Error('No option buttons found. Make sure the configurator tab is open (Configurer/Recommandé).');
        }

        for (let gi = 0; gi < groupNames.length; gi++) {
            const groupName = groupNames[gi];
            progressCallback?.(`Scanning: ${groupName} (${gi + 1}/${groupNames.length})`);
            
            await ensureAtGroupList();

            // Re-find group button fresh (may require scrolling due to virtualization)
            const optBtn = await scrollToGroupByName(groupName, scrollEl);
            if (!optBtn?.button) {
                log('Could not re-find group button for:', groupName);
                continue;
            }

            // Click group to open its option list
            try { optBtn.button.scrollIntoView({ block: 'center' }); } catch (_) {}
            optBtn.button.click();
            await sleep(CONFIG.batchDownload.clickDelay);
            
            // Wait until we see a back button (means we are in the detail list)
            const start = Date.now();
            while (!findBackButtonInConfigurator() && Date.now() - start < 2000) {
                await sleep(80);
            }

            const root = findConfiguratorRoot();
            const backBtn = findBackButtonInConfigurator();

            // Collect visible option values in the detail view
            const options = [];
            const detailRoot = findDetailViewContainer(backBtn);
            const labels = await collectAllValueLabelsInDetail(detailRoot);
            labels.forEach((label) => options.push({ label }));

            state.optionGroups.push({
                name: optBtn.name,
                count: optBtn.count,
                currentValue: optBtn.currentValue,
                options
            });
            log(`  Group: ${optBtn.name} -> ${options.length} option labels`);
            
            // Go back to groups list
            if (backBtn) {
                backBtn.click();
                await sleep(CONFIG.batchDownload.clickDelay);
                await ensureAtGroupList();
            } else {
                log('No back button found after scanning group:', groupName);
            }
        }
        
        log('Enumeration complete:', state.optionGroups.length, 'groups');
        return state.optionGroups;
    };

    const applyOptionSelection = async (groupName, valueLabel) => {
        await prepareConfiguratorForAutomation();
        await ensureAtGroupList();

        const scrollEl = findGroupListScrollContainer();
        const group = await scrollToGroupByName(groupName, scrollEl);
        if (!group?.button) throw new Error(`Group not found: ${groupName}`);

        try { group.button.scrollIntoView({ block: 'center' }); } catch (_) {}
        group.button.click();
        await sleep(CONFIG.batchDownload.clickDelay);

        // Wait for detail view
        const start = Date.now();
        while (!findBackButtonInConfigurator() && Date.now() - start < 2500) {
            await sleep(80);
        }
        const backBtn = findBackButtonInConfigurator();
        let detailRoot = findDetailViewContainer(backBtn);
        // Close filter drawer if opened (batch must click values, not filter UI)
        await ensureNoFilterDrawer();
        await closeBlockingOverlays();

        const target = normalizeKey(valueLabel);
        const findMatchIn = (root) => {
            const buttons = queryClickables(root).filter(isVisible);
            // Exact match first
            let match = buttons.find((b) => normalizeKey(getElementText(b)) === target);
            if (match) return match;
            // Fuzzy: accept partial/token-ish matches
            match = buttons.find((b) => {
                const k = normalizeKey(getElementText(b));
                return k && !isNonValueControlText(getElementText(b)) && (k.includes(target) || target.includes(k));
            });
            return match || null;
        };

        let match = findMatchIn(detailRoot);
        if (!match) {
            // Fallback: sometimes the container detection can lock onto the header (Filtre/Comparer).
            // Expand search to the configurator root when needed.
            detailRoot = findConfiguratorRoot();
            match = findMatchIn(detailRoot);
        }
        if (!match) {
            // Last fallback: broaden to the entire document (rare layouts)
            match = findMatchIn(document);
        }
        if (!match) throw new Error(`Value not found: ${valueLabel} (group: ${groupName})`);

        try { match.scrollIntoView({ block: 'center' }); } catch (_) {}
        match.click();
        await sleep(CONFIG.batchDownload.clickDelay);

        // Back to group list (best effort)
        await closeBlockingOverlays();
        const backAfter = findBackButtonInConfigurator();
        if (backAfter) {
            backAfter.click();
            await sleep(CONFIG.batchDownload.clickDelay);
        }
        await ensureAtGroupList();
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // DOWNLOAD FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    const downloadBlob = (blob, filename) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    // (Legacy static image download removed in v4.0 — 3D capture only)

    // ═══════════════════════════════════════════════════════════════════════════
    // BATCH DOWNLOAD CONTROLLER
    // ═══════════════════════════════════════════════════════════════════════════
    
    const batchController = {
        async start() {
            const batch = state.batch;
            if (!batch.plan || !batch.totalImages) return;
            
            batch.isRunning = true;
            batch.isPaused = false;
            batch.shouldStop = false;
            batch.startTime = Date.now();
            
            addLogEntry(`Starting: ${batch.totalImages} images (3D Viewer)`, 'info');
            updateBatchUI();
            batchPersistSave({ status: 'running' });
            
            while (batch.currentIndex < batch.totalImages && !batch.shouldStop) {
                while (batch.isPaused && !batch.shouldStop) {
                    await sleep(100);
                }
                if (batch.shouldStop) break;
                
                const idx = batch.currentIndex;
                const combo = comboForIndex(batch.plan, idx);

                const labels = combo.map(c => sanitizeFilename(c.valueLabel)).join('_');
                const base = sanitizeFilename(state.productName || 'product');
                const filename = `vitra_3d_${base}_${labels}_${idx}.png`;

                const actions = diffActions(combo, batch.lastApplied);
                
                try {
                    // Apply option selections (diff-only when possible)
                    if (!batch.lastApplied) {
                        // First iteration (or after resume): apply all to ensure correctness
                        for (const action of combo) {
                            await applyOptionSelection(action.groupName, action.valueLabel);
                        }
                    } else {
                        for (const action of actions) {
                            await applyOptionSelection(action.groupName, action.valueLabel);
                        }
                    }

                    // Wait for 3D render after selections
                    await sleep(CONFIG.batchDownload.delayBetweenCaptures);

                    // Capture
                    let lastErr = null;
                    for (let attempt = 1; attempt <= CONFIG.batchDownload.retryAttempts; attempt++) {
                        try {
                            const cap = await captureViewerWithSettings(batch.captureWidth, batch.captureHeight, {
                                useWhiteBackground: state.viewerCapture.useWhiteBackground,
                                useFullscreenBoost: state.viewerCapture.useFullscreenBoost
                            });
                            downloadBlob(cap.blob, filename);
                            batch.downloadedBytes += cap.blob.size;
                            batch.completedCount++;
                            addLogEntry(`✓ ${filename}`, 'success');
                            lastErr = null;
                            break;
                        } catch (e) {
                            lastErr = e;
                            addLogEntry(`Retry ${attempt}/${CONFIG.batchDownload.retryAttempts} failed: ${e.message}`, 'warning');
                            await sleep(600);
                        }
                    }
                    if (lastErr) throw lastErr;

                    // Mark as last applied (for diff-only next iteration)
                    if (!batch.lastApplied) batch.lastApplied = new Map();
                    combo.forEach((c) => batch.lastApplied.set(c.groupName, c.valueLabel));
                    
                } catch (e) {
                    batch.failedCount++;
                    batch.failedItems.push({ index: idx, error: e.message, labels: combo.map(c => `${c.groupName}=${c.valueLabel}`) });
                    batch.failedItems = batch.failedItems.slice(-200);
                    addLogEntry(`✗ ${filename}: ${e.message}`, 'error');
                }
                
                batch.currentIndex++;
                updateBatchUI();
                batchPersistSave();
                
                await sleep(500);
            }
            
            batch.isRunning = false;
            updateBatchUI();
            addLogEntry(`Complete: ${batch.completedCount} done, ${batch.failedCount} failed`, 'info');
            batchPersistSave({ status: batch.shouldStop ? 'stopped' : 'complete' });
        },
        
        pause() {
            state.batch.isPaused = true;
            addLogEntry('Paused', 'warning');
            updateBatchUI();
            batchPersistSave({ status: 'paused' });
        },
        
        resume() {
            state.batch.isPaused = false;
            addLogEntry('Resumed', 'info');
            updateBatchUI();
            batchPersistSave({ status: 'running' });
        },
        
        stop() {
            state.batch.shouldStop = true;
            state.batch.isPaused = false;
            updateBatchUI();
            batchPersistSave({ status: 'stopping' });
        },
        
        restart() {
            const batch = state.batch;
            batch.currentIndex = 0;
            batch.downloadedBytes = 0;
            batch.completedCount = 0;
            batch.failedCount = 0;
            batch.failedItems = [];
            batch.shouldStop = false;
            batch.lastApplied = null;
            batchPersistSave({ status: 'restarted' });
            this.start();
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // UI - STYLES
    // ═══════════════════════════════════════════════════════════════════════════
    
    const STYLES = `
        #vitra-dl-panel {
            position: fixed;
            bottom: 20px;
            left: 20px;
            z-index: 999999;
            background: linear-gradient(135deg, #1e2128 0%, #14171c 100%);
            color: #e4e4e7;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 13px;
            width: 320px;
            overflow: hidden;
        }
        
        #vitra-dl-panel * { box-sizing: border-box; }
        
        .vdl-header {
            background: rgba(0,0,0,0.3);
            padding: 12px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        
        .vdl-title {
            font-weight: 600;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .vdl-minimize {
            background: transparent;
            border: none;
            color: #888;
            cursor: pointer;
            font-size: 18px;
            padding: 4px;
            line-height: 1;
        }
        
        .vdl-minimize:hover { color: #fff; }
        
        .vdl-body {
            padding: 16px;
            max-height: calc(100vh - 56px);
            overflow-y: auto;
        }
        
        .vdl-section {
            margin-bottom: 16px;
        }
        
        .vdl-section:last-child { margin-bottom: 0; }
        
        .vdl-section-title {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: #6b7280;
            margin-bottom: 8px;
        }
        
        .vdl-btn {
            width: 100%;
            padding: 10px 14px;
            border: none;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: all 0.15s;
        }
        
        .vdl-btn:last-child { margin-bottom: 0; }
        
        .vdl-btn-primary {
            background: linear-gradient(135deg, #3b82f6, #2563eb);
            color: white;
        }
        
        .vdl-btn-primary:hover { background: linear-gradient(135deg, #2563eb, #1d4ed8); }
        
        .vdl-btn-success {
            background: linear-gradient(135deg, #22c55e, #16a34a);
            color: white;
        }
        
        .vdl-btn-success:hover { background: linear-gradient(135deg, #16a34a, #15803d); }
        
        .vdl-btn-secondary {
            background: rgba(255,255,255,0.08);
            color: #e4e4e7;
        }
        
        .vdl-btn-secondary:hover { background: rgba(255,255,255,0.12); }
        
        .vdl-btn-warning {
            background: rgba(245, 158, 11, 0.15);
            color: #fbbf24;
        }
        
        .vdl-btn-small {
            padding: 8px 12px;
            font-size: 11px;
        }
        
        .vdl-checkbox-row {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 12px;
            background: rgba(255,255,255,0.04);
            border-radius: 6px;
            cursor: pointer;
            margin-bottom: 6px;
        }
        
        .vdl-checkbox-row:hover { background: rgba(255,255,255,0.08); }
        
        .vdl-checkbox-row input[type="checkbox"] {
            width: 16px;
            height: 16px;
            accent-color: #3b82f6;
        }
        
        .vdl-checkbox-row label {
            flex: 1;
            cursor: pointer;
            font-size: 12px;
        }
        
        .vdl-status {
            font-size: 11px;
            color: #6b7280;
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid rgba(255,255,255,0.08);
        }
        
        .vdl-status.success { color: #22c55e; }
        .vdl-status.error { color: #ef4444; }
        .vdl-status.warning { color: #f59e0b; }
        
        .vdl-input-row {
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
        }
        
        .vdl-input {
            flex: 1;
            padding: 8px 10px;
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 6px;
            background: rgba(0,0,0,0.3);
            color: #e4e4e7;
            font-size: 12px;
            text-align: center;
        }
        
        .vdl-input:focus {
            outline: none;
            border-color: #3b82f6;
        }
        
        .vdl-input-label {
            font-size: 10px;
            color: #6b7280;
            text-align: center;
            margin-top: 2px;
        }
        
        /* Modal styles */
        #vitra-dl-modal {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.85);
            z-index: 9999999;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        
        #vitra-dl-modal * { box-sizing: border-box; }
        
        .vdl-modal-content {
            background: #1e2128;
            border-radius: 12px;
            width: 90%;
            max-width: 900px;
            max-height: 85vh;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        }
        
        .vdl-modal-header {
            padding: 16px 20px;
            background: rgba(0,0,0,0.3);
            border-bottom: 1px solid rgba(255,255,255,0.08);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .vdl-modal-header h2 {
            margin: 0;
            font-size: 16px;
            color: #fff;
        }
        
        .vdl-modal-close {
            background: transparent;
            border: none;
            color: #888;
            font-size: 24px;
            cursor: pointer;
            padding: 0;
        }
        
        .vdl-modal-close:hover { color: #fff; }
        
        .vdl-modal-body {
            padding: 20px;
            overflow-y: auto;
            flex: 1;
            color: #e4e4e7;
        }
        
        .vdl-stats-grid {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 12px;
            margin-bottom: 20px;
        }
        
        .vdl-stat {
            background: rgba(0,0,0,0.3);
            padding: 12px;
            border-radius: 8px;
            text-align: center;
        }
        
        .vdl-stat-value {
            font-size: 24px;
            font-weight: 700;
            color: #3b82f6;
        }
        
        .vdl-stat-value.success { color: #22c55e; }
        .vdl-stat-value.error { color: #ef4444; }
        
        .vdl-stat-label {
            font-size: 10px;
            color: #6b7280;
            text-transform: uppercase;
            margin-top: 4px;
        }
        
        .vdl-progress-bar {
            height: 6px;
            background: rgba(255,255,255,0.1);
            border-radius: 3px;
            margin-bottom: 8px;
            overflow: hidden;
        }
        
        .vdl-progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #3b82f6, #22c55e);
            width: 0%;
            transition: width 0.3s;
        }
        
        .vdl-progress-text {
            display: flex;
            justify-content: space-between;
            font-size: 12px;
            color: #6b7280;
            margin-bottom: 20px;
        }
        
        .vdl-options-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 10px;
            margin-bottom: 20px;
        }
        
        .vdl-option-card {
            background: rgba(255,255,255,0.04);
            border: 2px solid transparent;
            border-radius: 8px;
            padding: 12px;
            cursor: pointer;
            transition: all 0.15s;
        }
        
        .vdl-option-card:hover {
            background: rgba(255,255,255,0.08);
            border-color: rgba(255,255,255,0.1);
        }
        
        .vdl-option-card.selected {
            border-color: #3b82f6;
            background: rgba(59, 130, 246, 0.1);
        }
        
        .vdl-controls {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            margin-bottom: 20px;
        }
        
        .vdl-controls .vdl-btn {
            width: auto;
            margin: 0;
        }
        
        .vdl-log {
            background: rgba(0,0,0,0.4);
            border-radius: 8px;
            padding: 12px;
            max-height: 150px;
            overflow-y: auto;
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 11px;
        }
        
        .vdl-log-entry {
            padding: 3px 0;
            color: #6b7280;
        }
        
        .vdl-log-entry.success { color: #22c55e; }
        .vdl-log-entry.error { color: #ef4444; }
        .vdl-log-entry.warning { color: #f59e0b; }
        .vdl-log-entry.info { color: #3b82f6; }

        .vdl-values {
            margin-top: 14px;
            padding-top: 14px;
            border-top: 1px solid rgba(255,255,255,0.08);
        }

        .vdl-values details {
            background: rgba(255,255,255,0.04);
            border-radius: 8px;
            padding: 10px 12px;
            margin-bottom: 10px;
        }

        .vdl-values summary {
            cursor: pointer;
            font-weight: 600;
            font-size: 12px;
            color: #e4e4e7;
            outline: none;
        }

        .vdl-values-tools {
            display: flex;
            gap: 8px;
            margin: 10px 0;
            flex-wrap: wrap;
        }

        .vdl-btn-mini {
            width: auto;
            padding: 6px 10px;
            margin: 0;
            font-size: 11px;
            border-radius: 6px;
        }

        .vdl-values-search {
            width: 100%;
            padding: 8px 10px;
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 6px;
            background: rgba(0,0,0,0.3);
            color: #e4e4e7;
            font-size: 12px;
        }

        .vdl-values-list {
            max-height: 180px;
            overflow: auto;
            padding-right: 4px;
        }

        .vdl-values-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 6px 4px;
            border-radius: 6px;
        }

        .vdl-values-item:hover {
            background: rgba(255,255,255,0.06);
        }
        
        .vdl-info-box {
            background: rgba(59, 130, 246, 0.1);
            border: 1px solid rgba(59, 130, 246, 0.3);
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 16px;
            font-size: 12px;
            color: #93c5fd;
        }
        
        .vdl-warning-box {
            background: rgba(245, 158, 11, 0.1);
            border: 1px solid rgba(245, 158, 11, 0.3);
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 16px;
            font-size: 12px;
            color: #fcd34d;
        }

    `;

    // ═══════════════════════════════════════════════════════════════════════════
    // UI - PANEL
    // ═══════════════════════════════════════════════════════════════════════════
    
    const createPanel = () => {
        // Inject styles
        const style = document.createElement('style');
        style.textContent = STYLES;
        document.head.appendChild(style);
        
        const panel = document.createElement('div');
        panel.id = 'vitra-dl-panel';
        
        panel.innerHTML = `
            <div class="vdl-header">
                <div class="vdl-title">📷 Vitra Downloader v4</div>
                <button class="vdl-minimize" id="vdl-minimize">−</button>
            </div>
            <div class="vdl-body" id="vdl-panel-body">
                <!-- 3D Viewer Capture Section -->
                <div class="vdl-section">
                    <div class="vdl-section-title">📸 3D Viewer Capture</div>
                    <div class="vdl-input-row">
                        <div style="flex:1">
                            <input type="number" class="vdl-input" id="vdl-width" value="${CONFIG.viewerCapture.defaultWidth}" min="512" max="4096">
                            <div class="vdl-input-label">Max Width</div>
                        </div>
                        <div style="flex:1">
                            <input type="number" class="vdl-input" id="vdl-height" value="${CONFIG.viewerCapture.defaultHeight}" min="512" max="4096">
                            <div class="vdl-input-label">Max Height</div>
                        </div>
                    </div>
                    <div class="vdl-checkbox-row" style="margin-bottom:8px;">
                        <input type="checkbox" id="vdl-white-bg" ${state.viewerCapture.useWhiteBackground ? 'checked' : ''}>
                        <label for="vdl-white-bg">White background (Emersya API)</label>
                    </div>
                    <div class="vdl-checkbox-row" style="margin-bottom:8px;">
                        <input type="checkbox" id="vdl-fullscreen-boost" ${state.viewerCapture.useFullscreenBoost ? 'checked' : ''}>
                        <label for="vdl-fullscreen-boost">Boost resolution (canvas-only fullscreen during capture)</label>
                    </div>
                    <div style="font-size:11px;color:#9ca3af;margin-bottom:8px;">
                        ⚠️ Won't upscale beyond viewer's native size.<br>
                        Tip: fullscreen often increases the canvas resolution.
                    </div>
                    <button class="vdl-btn vdl-btn-success" id="vdl-capture-viewer">
                        📸 Capture 3D View
                    </button>
                </div>
                
                <!-- Batch Section -->
                <div class="vdl-section">
                    <div class="vdl-section-title">📦 Batch Download</div>
                    <button class="vdl-btn vdl-btn-secondary" id="vdl-scan-options">
                        🔍 Scan All Options
                    </button>
                    <button class="vdl-btn vdl-btn-primary" id="vdl-open-batch">
                        📦 Open Batch Assistant…
                    </button>
                </div>
                
                <div class="vdl-status" id="vdl-status">Ready</div>
            </div>
        `;
        
        document.body.appendChild(panel);
        state.panel = panel;
        
        // Event listeners
        setupPanelEvents();
        
        return panel;
    };

    const setupPanelEvents = () => {
        // Minimize
        let minimized = false;
        document.getElementById('vdl-minimize')?.addEventListener('click', () => {
            minimized = !minimized;
            document.getElementById('vdl-panel-body').style.display = minimized ? 'none' : 'block';
            document.getElementById('vdl-minimize').textContent = minimized ? '+' : '−';
        });
        
        // Capture preferences
        document.getElementById('vdl-white-bg')?.addEventListener('change', (e) => {
            state.viewerCapture.useWhiteBackground = !!e.target.checked;
            GM_setValue('viewerCaptureUseWhiteBackground', state.viewerCapture.useWhiteBackground);
            // Apply immediately for visible feedback
            tryHookEmersyaApiCore();
            if (state.viewerCapture.useWhiteBackground) emersyaTrySetWhiteBackground();
            else emersyaRestoreBackground();
        });
        document.getElementById('vdl-fullscreen-boost')?.addEventListener('change', (e) => {
            state.viewerCapture.useFullscreenBoost = !!e.target.checked;
            GM_setValue('viewerCaptureUseFullscreenBoost', state.viewerCapture.useFullscreenBoost);
        });

        // 3D Capture
        document.getElementById('vdl-capture-viewer')?.addEventListener('click', () => {
            const w = parseInt(document.getElementById('vdl-width').value) || CONFIG.viewerCapture.defaultWidth;
            const h = parseInt(document.getElementById('vdl-height').value) || CONFIG.viewerCapture.defaultHeight;
            downloadViewerCapture(w, h, {
                useWhiteBackground: state.viewerCapture.useWhiteBackground,
                useFullscreenBoost: state.viewerCapture.useFullscreenBoost
            });
        });
        
        // Batch
        document.getElementById('vdl-scan-options')?.addEventListener('click', scanOptions);
        document.getElementById('vdl-open-batch')?.addEventListener('click', openBatchModal);
    };

    const updatePanelStatus = (msg, type = '') => {
        const el = document.getElementById('vdl-status');
        if (el) {
            el.textContent = msg;
            el.className = 'vdl-status ' + type;
        }
    };

    const scanOptions = async () => {
        const btn = document.getElementById('vdl-scan-options');
        btn.disabled = true;
        btn.textContent = '🔍 Scanning...';
        
        try {
            await enumerateAllOptions((status) => {
                updatePanelStatus(status, 'warning');
            });
            
            let total = 1;
            state.optionGroups.forEach(g => total *= g.options.length || 1);
            
            updatePanelStatus(`✓ ${state.optionGroups.length} groups, ~${formatNumber(total)} combos`, 'success');
        } catch (e) {
            updatePanelStatus('❌ ' + e.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = '🔍 Scan All Options';
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // UI - BATCH MODAL
    // ═══════════════════════════════════════════════════════════════════════════
    
    const openBatchModal = () => {
        document.getElementById('vitra-dl-modal')?.remove();
        
        const modal = document.createElement('div');
        modal.id = 'vitra-dl-modal';
        
        modal.innerHTML = `
            <div class="vdl-modal-content">
                <div class="vdl-modal-header">
                    <h2>📦 Batch Download All Configurations</h2>
                    <button class="vdl-modal-close" id="vdl-modal-close">&times;</button>
                </div>
                <div class="vdl-modal-body">
                    <div id="vdl-resume-banner"></div>
                    <div class="vdl-info-box">
                        <strong>3D Viewer Batch:</strong> This will iterate option combinations and capture the 3D view for each.
                        Captures are <strong>cropped/downscaled</strong> to your requested size (no upscaling).
                    </div>
                    
                    <!-- Capture size -->
                    <div id="vdl-size-controls" style="margin-bottom:16px;">
                        <div class="vdl-section-title">Capture Size</div>
                        <div class="vdl-input-row">
                            <div style="flex:1">
                                <input type="number" class="vdl-input" id="vdl-batch-width" value="${CONFIG.viewerCapture.defaultWidth}">
                                <div class="vdl-input-label">Width</div>
                            </div>
                            <div style="flex:1">
                                <input type="number" class="vdl-input" id="vdl-batch-height" value="${CONFIG.viewerCapture.defaultHeight}">
                                <div class="vdl-input-label">Height</div>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Stats -->
                    <div class="vdl-stats-grid">
                        <div class="vdl-stat">
                            <div class="vdl-stat-value" id="vdl-total">0</div>
                            <div class="vdl-stat-label">Total</div>
                        </div>
                        <div class="vdl-stat">
                            <div class="vdl-stat-value success" id="vdl-completed">0</div>
                            <div class="vdl-stat-label">Done</div>
                        </div>
                        <div class="vdl-stat">
                            <div class="vdl-stat-value error" id="vdl-failed">0</div>
                            <div class="vdl-stat-label">Failed</div>
                        </div>
                        <div class="vdl-stat">
                            <div class="vdl-stat-value" id="vdl-size">0 B</div>
                            <div class="vdl-stat-label">Size</div>
                        </div>
                        <div class="vdl-stat">
                            <div class="vdl-stat-value" id="vdl-eta">--</div>
                            <div class="vdl-stat-label">ETA</div>
                        </div>
                    </div>
                    
                    <!-- Progress -->
                    <div style="display:none;" id="vdl-progress-section">
                        <div class="vdl-progress-bar">
                            <div class="vdl-progress-fill" id="vdl-progress-fill"></div>
                        </div>
                        <div class="vdl-progress-text">
                            <span id="vdl-progress-pct">0%</span>
                            <span id="vdl-progress-cnt">0 / 0</span>
                        </div>
                    </div>
                    
                    <!-- Options -->
                    <div class="vdl-section-title">Select Options to Include</div>
                    <div class="vdl-options-grid" id="vdl-options-grid">
                        ${state.optionGroups.length === 0 
                            ? '<p style="color:#6b7280;grid-column:1/-1;">⚠️ No options found. Click "Scan All Options" first.</p>'
                            : state.optionGroups.map((g, i) => `
                                <div class="vdl-option-card" data-idx="${i}">
                                    <input type="checkbox" style="display:none" data-idx="${i}">
                                    <div style="font-weight:500;margin-bottom:4px;">${g.name}</div>
                                    <div style="font-size:11px;color:#6b7280;">${g.options.length} options</div>
                                </div>
                            `).join('')
                        }
                    </div>

                    <!-- Value filters (per selected group) -->
                    <div class="vdl-values" id="vdl-values">
                        <div class="vdl-section-title">Filter Option Values (optional)</div>
                        <div style="font-size:11px;color:#9ca3af;margin-bottom:10px;">
                            By default, all values are included for each selected group. You can uncheck specific values below.
                        </div>
                        <div id="vdl-values-filters"></div>
                    </div>
                    
                    <!-- Controls -->
                    <div class="vdl-controls">
                        <button class="vdl-btn vdl-btn-success" id="vdl-start" disabled>▶️ Start</button>
                        <button class="vdl-btn vdl-btn-warning" id="vdl-pause" disabled>⏸️ Pause</button>
                        <button class="vdl-btn vdl-btn-secondary" id="vdl-resume" disabled>▶️ Resume</button>
                        <button class="vdl-btn vdl-btn-secondary" id="vdl-stop" disabled>⏹️ Stop</button>
                    </div>
                    
                    <!-- Log -->
                    <div class="vdl-section-title" style="margin-top:16px;">Activity Log</div>
                    <div class="vdl-log" id="vdl-log">
                        <div class="vdl-log-entry info">[${new Date().toLocaleTimeString()}] Ready</div>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        state.modal = modal;
        
        setupBatchModalEvents();
        renderResumeBanner();
        syncValueSelectionsFromSelectedGroups();
        renderValueFilters();
        updateTotalEstimate();
    };

    const renderResumeBanner = () => {
        const el = document.getElementById('vdl-resume-banner');
        if (!el) return;
        const saved = batchPersistLoad();
        if (!saved?.plan || typeof saved.currentIndex !== 'number') {
            el.innerHTML = '';
            return;
        }

        const pct = saved.totalImages > 0 ? Math.round((saved.currentIndex / saved.totalImages) * 100) : 0;
        const when = new Date(saved.savedAt || Date.now()).toLocaleString();
        el.innerHTML = `
            <div class="vdl-warning-box" style="margin-bottom:16px;">
                <strong>Saved progress found</strong> (${pct}% — ${saved.currentIndex} / ${saved.totalImages})<br>
                <span style="font-size:11px;opacity:.9">Saved at: ${when}</span>
                <div class="vdl-controls" style="margin-top:10px;margin-bottom:0;">
                    <button class="vdl-btn vdl-btn-success vdl-btn-mini" id="vdl-resume-saved">▶️ Resume saved</button>
                    <button class="vdl-btn vdl-btn-secondary vdl-btn-mini" id="vdl-clear-saved">🗑️ Clear</button>
                </div>
            </div>
        `;

        document.getElementById('vdl-resume-saved')?.addEventListener('click', async () => {
            try {
                await resumeSavedBatch();
            } catch (e) {
                addLogEntry(`Resume failed: ${e.message}`, 'error');
            }
        });
        document.getElementById('vdl-clear-saved')?.addEventListener('click', () => {
            batchPersistClear();
            renderResumeBanner();
            addLogEntry('Cleared saved progress for this product URL', 'info');
        });
    };

    const syncValueSelectionsFromSelectedGroups = () => {
        const batch = state.batch;
        const selected = Array.from(batch.selectedGroups);
        // Init default selections to "all values"
        for (const idx of selected) {
            if (!batch.valueSelections.has(idx)) {
                const set = new Set();
                const opts = state.optionGroups[idx]?.options || [];
                for (let vi = 0; vi < opts.length; vi++) set.add(vi);
                batch.valueSelections.set(idx, set);
            }
        }
        // Remove selections for unselected groups
        for (const k of Array.from(batch.valueSelections.keys())) {
            if (!batch.selectedGroups.has(k)) batch.valueSelections.delete(k);
        }
    };

    const renderValueFilters = () => {
        const container = document.getElementById('vdl-values-filters');
        if (!container) return;

        const indices = Array.from(state.batch.selectedGroups);
        if (indices.length === 0) {
            container.innerHTML = `<div style="color:#6b7280;font-size:12px;">Select one or more option groups above to filter values.</div>`;
            return;
        }

        container.innerHTML = indices.map((groupIdx) => {
            const group = state.optionGroups[groupIdx];
            const sel = state.batch.valueSelections.get(groupIdx) || new Set();
            const count = sel.size;
            const total = group?.options?.length || 0;
            const safeName = String(group?.name || `Group ${groupIdx}`);

            const items = (group?.options || []).map((opt, vi) => {
                const id = `vdl-val-${groupIdx}-${vi}`;
                const checked = sel.has(vi) ? 'checked' : '';
                const label = opt?.label || '';
                return `
                    <label class="vdl-values-item" data-label="${sanitizeFilename(label).toLowerCase()}">
                        <input type="checkbox" id="${id}" data-group="${groupIdx}" data-val="${vi}" ${checked} />
                        <span>${label}</span>
                    </label>
                `;
            }).join('');

            return `
                <details data-group="${groupIdx}">
                    <summary>${safeName} — ${count}/${total}</summary>
                    <div class="vdl-values-tools">
                        <button class="vdl-btn vdl-btn-secondary vdl-btn-mini" data-action="all" data-group="${groupIdx}">All</button>
                        <button class="vdl-btn vdl-btn-secondary vdl-btn-mini" data-action="none" data-group="${groupIdx}">None</button>
                    </div>
                    <input class="vdl-values-search" placeholder="Search values…" data-group="${groupIdx}" />
                    <div class="vdl-values-list">${items}</div>
                </details>
            `;
        }).join('');

        // Wire up events
        container.querySelectorAll('input[type="checkbox"][data-group][data-val]').forEach((cb) => {
            cb.addEventListener('change', () => {
                const g = parseInt(cb.dataset.group);
                const v = parseInt(cb.dataset.val);
                const set = state.batch.valueSelections.get(g) || new Set();
                if (cb.checked) set.add(v);
                else set.delete(v);
                state.batch.valueSelections.set(g, set);
                updateTotalEstimate();
                // Update summary counts
                renderValueFilters(); // simple re-render to keep counts accurate
            });
        });

        container.querySelectorAll('button[data-action][data-group]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const g = parseInt(btn.dataset.group);
                const action = btn.dataset.action;
                const opts = state.optionGroups[g]?.options || [];
                const set = new Set();
                if (action === 'all') {
                    for (let i = 0; i < opts.length; i++) set.add(i);
                }
                state.batch.valueSelections.set(g, set);
                updateTotalEstimate();
                renderValueFilters();
            });
        });

        container.querySelectorAll('input.vdl-values-search[data-group]').forEach((inp) => {
            inp.addEventListener('input', () => {
                const q = sanitizeFilename(inp.value || '').toLowerCase();
                const details = container.querySelector(`details[data-group="${inp.dataset.group}"]`);
                if (!details) return;
                details.querySelectorAll('.vdl-values-item').forEach((row) => {
                    const key = row.getAttribute('data-label') || '';
                    row.style.display = !q || key.includes(q) ? '' : 'none';
                });
            });
        });
    };

    const setupBatchModalEvents = () => {
        // Close
        document.getElementById('vdl-modal-close')?.addEventListener('click', () => {
            document.getElementById('vitra-dl-modal')?.remove();
        });
        
        document.getElementById('vitra-dl-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'vitra-dl-modal') {
                document.getElementById('vitra-dl-modal')?.remove();
            }
        });
        
        // Option cards
        document.querySelectorAll('.vdl-option-card').forEach(card => {
            card.addEventListener('click', () => {
                card.classList.toggle('selected');
                card.querySelector('input').checked = card.classList.contains('selected');
                updateTotalEstimate();
                syncValueSelectionsFromSelectedGroups();
                renderValueFilters();
            });
        });
        
        // Controls
        document.getElementById('vdl-start')?.addEventListener('click', startBatchDownload);
        document.getElementById('vdl-pause')?.addEventListener('click', () => batchController.pause());
        document.getElementById('vdl-resume')?.addEventListener('click', () => batchController.resume());
        document.getElementById('vdl-stop')?.addEventListener('click', () => batchController.stop());
    };

    const updateTotalEstimate = () => {
        const selected = document.querySelectorAll('.vdl-option-card.selected');
        const indices = Array.from(selected).map(c => parseInt(c.dataset.idx));
        
        state.batch.selectedGroups = new Set(indices);
        syncValueSelectionsFromSelectedGroups();
        
        let total = indices.length > 0 ? 1 : 0;
        indices.forEach(i => {
            const sel = state.batch.valueSelections.get(i);
            const count = sel ? sel.size : (state.optionGroups[i]?.options.length || 0);
            total *= count || 0;
        });
        
        document.getElementById('vdl-total').textContent = formatNumber(total);
        document.getElementById('vdl-start').disabled = total === 0;
    };

    const startBatchDownload = () => {
        const batch = state.batch;
        const indices = Array.from(batch.selectedGroups);
        
        if (indices.length === 0) {
            addLogEntry('Select at least one option group', 'error');
            return;
        }
        
        // Capture size (max; will not upscale beyond native)
        batch.captureWidth = parseInt(document.getElementById('vdl-batch-width')?.value) || CONFIG.viewerCapture.defaultWidth;
        batch.captureHeight = parseInt(document.getElementById('vdl-batch-height')?.value) || CONFIG.viewerCapture.defaultHeight;

        // Build batch plan (lazy combos, no giant queue)
        batch.plan = buildBatchPlan();
        batch.totalImages = batch.plan.totalImages;
        batch.currentIndex = 0;
        batch.completedCount = 0;
        batch.failedCount = 0;
        batch.failedItems = [];
        batch.downloadedBytes = 0;
        batch.lastApplied = null;
        
        document.getElementById('vdl-progress-section').style.display = 'block';
        batchPersistSave({ status: 'starting' });
        batchController.start();
    };

    const updateBatchUI = () => {
        const batch = state.batch;
        if (!state.modal) return;
        
        document.getElementById('vdl-completed').textContent = formatNumber(batch.completedCount || 0);
        document.getElementById('vdl-failed').textContent = formatNumber(batch.failedCount || 0);
        document.getElementById('vdl-size').textContent = formatSize(batch.downloadedBytes);
        
        // ETA
        if (batch.isRunning && batch.startTime && batch.currentIndex > 0) {
            const elapsed = (Date.now() - batch.startTime) / 1000;
            const rate = batch.currentIndex / elapsed;
            const remaining = batch.totalImages - batch.currentIndex;
            const eta = rate > 0 ? remaining / rate : 0;
            document.getElementById('vdl-eta').textContent = formatTime(eta);
        }
        
        // Progress
        const pct = batch.totalImages > 0 ? (batch.currentIndex / batch.totalImages) * 100 : 0;
        document.getElementById('vdl-progress-fill').style.width = pct + '%';
        document.getElementById('vdl-progress-pct').textContent = Math.round(pct) + '%';
        document.getElementById('vdl-progress-cnt').textContent = `${batch.currentIndex} / ${batch.totalImages}`;
        
        // Buttons
        document.getElementById('vdl-start').disabled = batch.isRunning;
        document.getElementById('vdl-pause').disabled = !batch.isRunning || batch.isPaused;
        document.getElementById('vdl-resume').disabled = !batch.isPaused;
        document.getElementById('vdl-stop').disabled = !batch.isRunning;
    };

    const addLogEntry = (msg, type = '') => {
        const log = document.getElementById('vdl-log');
        if (!log) return;
        
        const entry = document.createElement('div');
        entry.className = 'vdl-log-entry ' + type;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;
        
        while (log.children.length > 200) {
            log.removeChild(log.firstChild);
        }
    };

    const buildBatchPlan = () => {
        const batch = state.batch;
        const groupIndices = Array.from(batch.selectedGroups);
        if (groupIndices.length === 0) throw new Error('No option groups selected');

        const allowedValueIdxByGroup = {};
        const groups = [];

        for (const gi of groupIndices) {
            const group = state.optionGroups[gi];
            if (!group) continue;
            const sel = batch.valueSelections.get(gi);
            const allowed = sel ? Array.from(sel) : [...Array(group.options.length).keys()];
            const normalized = allowed
                .filter((i) => Number.isFinite(i))
                .map((i) => parseInt(i))
                .filter((i) => i >= 0 && i < (group.options?.length || 0));
            if (normalized.length === 0) throw new Error(`No values selected for group: ${group.name}`);
            allowedValueIdxByGroup[gi] = normalized;
            groups.push({ groupIdx: gi, name: group.name, options: group.options });
        }

        // Total combos
        let total = 1;
        for (const g of groups) {
            total *= (allowedValueIdxByGroup[g.groupIdx]?.length || 0);
        }
        if (!Number.isFinite(total) || total <= 0) throw new Error('Total combinations is 0');

        return {
            v: 1,
            createdAt: Date.now(),
            url: (location.href || '').split('#')[0],
            productName: state.productName || '',
            captureWidth: batch.captureWidth,
            captureHeight: batch.captureHeight,
            groupIndices,
            allowedValueIdxByGroup,
            totalImages: total
        };
    };

    const comboForIndex = (plan, index) => {
        const groups = plan.groupIndices.map((gi) => state.optionGroups[gi]).filter(Boolean);
        const selections = [];
        let n = index;
        for (let gi = groups.length - 1; gi >= 0; gi--) {
            const groupIdx = plan.groupIndices[gi];
            const group = state.optionGroups[groupIdx];
            const allowed = plan.allowedValueIdxByGroup[groupIdx] || [];
            const base = allowed.length;
            const digit = base ? (n % base) : 0;
            n = base ? Math.floor(n / base) : 0;
            const valueIdx = allowed[digit];
            const label = group?.options?.[valueIdx]?.label || '';
            selections.unshift({
                groupIdx,
                groupName: group?.name || '',
                valueIdx,
                valueLabel: label
            });
        }
        return selections;
    };

    const diffActions = (combo, lastApplied) => {
        if (!lastApplied) return combo;
        return combo.filter((c) => lastApplied.get(c.groupName) !== c.valueLabel);
    };

    const resumeSavedBatch = async () => {
        const saved = batchPersistLoad();
        if (!saved?.plan) throw new Error('No saved progress found for this URL');

        const batch = state.batch;
        batch.plan = saved.plan;
        batch.totalImages = saved.totalImages || saved.plan.totalImages || 0;
        batch.currentIndex = saved.currentIndex || 0;
        batch.downloadedBytes = saved.downloadedBytes || 0;
        batch.completedCount = saved.completedCount || 0;
        batch.failedCount = saved.failedCount || 0;
        batch.failedItems = saved.failedItems || [];
        batch.captureWidth = saved.captureWidth || saved.plan.captureWidth || CONFIG.viewerCapture.defaultWidth;
        batch.captureHeight = saved.captureHeight || saved.plan.captureHeight || CONFIG.viewerCapture.defaultHeight;
        batch.lastApplied = null;
        batch.shouldStop = false;
        batch.isPaused = false;

        // Sync UI selections from plan
        batch.selectedGroups = new Set(saved.plan.groupIndices || []);
        batch.valueSelections = new Map();
        for (const gi of (saved.plan.groupIndices || [])) {
            const allowed = saved.plan.allowedValueIdxByGroup?.[gi] || [];
            batch.valueSelections.set(gi, new Set(allowed));
        }

        // Update modal UI
        document.querySelectorAll('.vdl-option-card').forEach((card) => {
            const idx = parseInt(card.dataset.idx);
            const on = batch.selectedGroups.has(idx);
            card.classList.toggle('selected', on);
            const inp = card.querySelector('input');
            if (inp) inp.checked = on;
        });
        renderValueFilters();
        updateTotalEstimate();
        // Restore capture size inputs
        const w = document.getElementById('vdl-batch-width');
        const h = document.getElementById('vdl-batch-height');
        if (w) w.value = String(batch.captureWidth);
        if (h) h.value = String(batch.captureHeight);

        document.getElementById('vdl-progress-section').style.display = 'block';
        // Immediately reflect restored progress in UI before starting
        updateBatchUI();
        addLogEntry(`Resuming saved batch at ${batch.currentIndex}/${batch.totalImages}…`, 'info');
        batchController.start();
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    const init = () => {
        log('Vitra Downloader v4.0 initializing (early start for WebGL patch + Emersya hook)...');
        
        // Patch WebGL to enable canvas capture - MUST happen before viewer loads
        try {
            patchWebGLForCapture();
        } catch (e) {
            log('WebGL patch failed (may already be patched):', e.message);
        }

        // Start watching for Emersya so we can control background/fullscreen when it appears
        startEmersyaHookWatcher();
        
        // Wait for DOM to be ready before setting up UI
        const setupUI = () => {
            // Create panel
            setTimeout(createPanel, 500);
            
            // Product name (best effort)
            setTimeout(() => {
                const h = document.querySelector('h1, h2');
                if (h) state.productName = h.textContent.trim().split('\n')[0];
            }, 1500);
        };
        
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            setupUI();
        } else {
            document.addEventListener('DOMContentLoaded', setupUI);
        }
        
        log('Early initialization complete');
    };

    init();
})();
