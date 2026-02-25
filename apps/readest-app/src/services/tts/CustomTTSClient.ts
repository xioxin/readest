import { TTSClient, TTSMessageEvent } from './TTSClient';
import { TTSGranularity, TTSVoice, TTSVoicesGroup } from './types';
import { parseSSMLMarks } from '@/utils/ssml';
import { TTSController } from './TTSController';

const CUSTOM_TTS_URL_PLACEHOLDER = '{{speakText}}';
const MAX_FETCH_RETRIES = 2;

export class CustomTTSClient implements TTSClient {
  name = 'custom-tts';
  initialized = false;
  controller?: TTSController;

  #url: string;
  #rate = 1.0;
  #parallel = 3;
  #audioElement: HTMLAudioElement | null = null;
  #isPlaying = false;
  #pausedAt = 0;
  // Keyed by sentence text; shared across speak() calls so preloads survive sentence transitions.
  #textCache: Map<string, Promise<string | null>> = new Map();
  // Tracks resolved blob URLs that are pre-fetched but not yet played, for cleanup.
  #pendingBlobUrls: Set<string> = new Set();
  // Abort controller for in-flight HTTP fetches; replaced on clearPrefetch().
  #fetchController = new AbortController();

  constructor(controller?: TTSController, url = '') {
    this.controller = controller;
    this.#url = url;
  }

  setUrl(url: string) {
    this.#url = url;
  }

  setParallel(n: number) {
    this.#parallel = Math.max(1, n);
  }

  getParallel(): number {
    return this.#parallel;
  }

  async init() {
    this.initialized = !!this.#url;
    return this.initialized;
  }

  async shutdown() {
    this.initialized = false;
    this.clearPrefetch();
    if (this.#audioElement) {
      this.#audioElement.pause();
      this.#audioElement.src = '';
      this.#audioElement = null;
    }
  }

  #buildAudioUrl(text: string): string {
    return this.#url.replace(CUSTOM_TTS_URL_PLACEHOLDER, encodeURIComponent(text));
  }

  async #fetchAudioBlob(text: string): Promise<string | null> {
    for (let attempt = 0; attempt < MAX_FETCH_RETRIES; attempt++) {
      try {
        if (this.#fetchController.signal.aborted) return null;
        const response = await fetch(this.#buildAudioUrl(text), {
          signal: this.#fetchController.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        this.#pendingBlobUrls.add(blobUrl);
        return blobUrl;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return null;
        console.warn(`Custom TTS fetch attempt ${attempt + 1} failed:`, err);
      }
    }
    return null;
  }

  // Ensures a fetch for this text is in-flight or cached; returns the promise.
  #ensureFetch(text: string): Promise<string | null> {
    if (!this.#textCache.has(text)) {
      this.#textCache.set(text, this.#fetchAudioBlob(text));
    }
    return this.#textCache.get(text)!;
  }

  // Abort in-flight fetches, revoke pending blob URLs, clear the cache.
  // Call this when navigating backward or shutting down (not between sentences).
  clearPrefetch() {
    this.#fetchController.abort();
    this.#fetchController = new AbortController();
    this.#textCache.clear();
    for (const url of this.#pendingBlobUrls) {
      URL.revokeObjectURL(url);
    }
    this.#pendingBlobUrls.clear();
  }

  async *speak(ssml: string, signal: AbortSignal, preload = false): AsyncIterable<TTSMessageEvent> {
    const { marks } = parseSSMLMarks(ssml);

    if (preload) {
      // Pre-fetch audio for each mark in this SSML and store in the shared text cache.
      // TTSController.preloadNextSSML() calls this for upcoming sentences, so by the time
      // speak(preload=false) is called for a sentence the blob URL is already ready.
      for (const mark of marks) {
        this.#ensureFetch(mark.text);
      }
      yield { code: 'end', message: 'Preload finished' } as TTSMessageEvent;
      return;
    }

    await this.stopInternal();
    if (!this.#audioElement) {
      this.#audioElement = new Audio();
    }
    const audio = this.#audioElement;
    audio.preload = 'auto';

    for (const mark of marks) {
      this.controller?.dispatchSpeakMark(mark);
      let abortHandler: null | (() => void) = null;
      try {
        if (signal.aborted) {
          yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
          break;
        }

        yield {
          code: 'boundary',
          message: `Start chunk: ${mark.name}`,
          mark: mark.name,
        } as TTSMessageEvent;

        // Await the pre-fetched blob URL (or start a fresh fetch if not yet cached).
        let blobUrl: string | null = await Promise.race([
          this.#ensureFetch(mark.text),
          new Promise<null>((resolve) => {
            if (signal.aborted) {
              resolve(null);
            } else {
              signal.addEventListener('abort', () => resolve(null), { once: true });
            }
          }),
        ]);

        if (signal.aborted) {
          yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
          break;
        }

        // If the fetch failed (not aborted by stop signal), retry once.
        if (blobUrl === null && !signal.aborted) {
          this.#textCache.delete(mark.text);
          blobUrl = await this.#ensureFetch(mark.text);
        }

        if (blobUrl === null) {
          yield { code: 'error', message: 'Audio fetch failed' } as TTSMessageEvent;
          break;
        }

        const currentBlobUrl = blobUrl;
        const result = await new Promise<TTSMessageEvent>((resolve) => {
          const cleanUp = () => {
            audio.onended = null;
            audio.onerror = null;
            audio.src = '';
            URL.revokeObjectURL(currentBlobUrl);
            this.#pendingBlobUrls.delete(currentBlobUrl);
            this.#textCache.delete(mark.text);
          };
          let resolved = false;
          const handleEnded = () => {
            if (resolved) return;
            resolved = true;
            cleanUp();
            resolve({ code: 'end', message: `Chunk finished: ${mark.name}` });
          };

          abortHandler = () => {
            cleanUp();
            resolve({ code: 'error', message: 'Aborted' });
          };
          if (signal.aborted) {
            abortHandler();
            return;
          } else {
            signal.addEventListener('abort', abortHandler);
          }
          audio.onended = handleEnded;
          audio.onerror = (e) => {
            cleanUp();
            console.warn('Custom TTS audio playback error:', e);
            resolve({ code: 'error', message: 'Audio playback error' });
          };
          this.#isPlaying = true;
          audio.src = currentBlobUrl;
          audio.playbackRate = this.#rate;
          audio.play().catch((err) => {
            cleanUp();
            console.error('Custom TTS failed to play audio:', err);
            resolve({ code: 'error', message: 'Playback failed: ' + err.message });
          });
        });
        yield result;
        if (result.code === 'error') break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('Custom TTS error for mark:', mark.text, message);
        yield { code: 'error', message } as TTSMessageEvent;
        break;
      } finally {
        if (abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      }
    }
    await this.stopInternal();
  }

  async pause() {
    if (!this.#isPlaying || !this.#audioElement) return true;
    this.#pausedAt = this.#audioElement.currentTime;
    await this.#audioElement.pause();
    this.#isPlaying = false;
    return true;
  }

  async resume() {
    if (this.#isPlaying || !this.#audioElement) return true;
    this.#audioElement.currentTime = this.#pausedAt;
    await this.#audioElement.play();
    this.#isPlaying = true;
    return true;
  }

  async stop() {
    await this.stopInternal();
    // Note: do NOT call clearPrefetch() here — the prefetch cache must survive the stop()
    // that TTSController calls between sentences (forward navigation). clearPrefetch() is
    // called explicitly by TTSController on backward navigation and by shutdown().
  }

  private async stopInternal() {
    this.#isPlaying = false;
    this.#pausedAt = 0;
    if (this.#audioElement) {
      this.#audioElement.pause();
      this.#audioElement.currentTime = 0;
      if (this.#audioElement?.onended) {
        this.#audioElement.onended(new Event('stopped'));
      }
      this.#audioElement.src = '';
    }
  }

  async setRate(rate: number) {
    this.#rate = rate;
  }

  async setPitch(_pitch: number) {
    // Custom TTS does not support pitch control
  }

  async setVoice(_voice: string) {
    // Custom TTS does not use voices
  }

  setPrimaryLang(_lang: string) {
    // Custom TTS does not use language detection
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return [];
  }

  async getVoices(_lang: string): Promise<TTSVoicesGroup[]> {
    return [];
  }

  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }

  getVoiceId(): string {
    return '';
  }

  getSpeakingLang(): string {
    return '';
  }
}
