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
  #prefetchMap: Map<number, Promise<string | null>> = new Map();
  #blobUrls: Set<string> = new Set();

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

  async init() {
    this.initialized = !!this.#url;
    return this.initialized;
  }

  async shutdown() {
    this.initialized = false;
    this.#clearPrefetch();
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
        const url = this.#buildAudioUrl(text);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        this.#blobUrls.add(blobUrl);
        return blobUrl;
      } catch (err) {
        console.warn(`Custom TTS fetch attempt ${attempt + 1} failed:`, err);
      }
    }
    return null;
  }

  #ensurePrefetch(index: number, text: string): Promise<string | null> {
    if (!this.#prefetchMap.has(index)) {
      this.#prefetchMap.set(index, this.#fetchAudioBlob(text));
    }
    return this.#prefetchMap.get(index)!;
  }

  #clearPrefetch() {
    for (const blobUrl of this.#blobUrls) {
      URL.revokeObjectURL(blobUrl);
    }
    this.#blobUrls.clear();
    this.#prefetchMap.clear();
  }

  async *speak(ssml: string, signal: AbortSignal, preload = false): AsyncIterable<TTSMessageEvent> {
    const { marks } = parseSSMLMarks(ssml);

    if (preload) {
      yield { code: 'end', message: 'Preload finished' } as TTSMessageEvent;
      return;
    }

    await this.stopInternal();
    this.#clearPrefetch();
    if (!this.#audioElement) {
      this.#audioElement = new Audio();
    }
    const audio = this.#audioElement;
    audio.preload = 'auto';

    // Pre-fetch the first `parallel` marks
    for (let i = 0; i < Math.min(this.#parallel, marks.length); i++) {
      this.#ensurePrefetch(i, marks[i]!.text);
    }

    for (let markIndex = 0; markIndex < marks.length; markIndex++) {
      const mark = marks[markIndex]!;
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

        // Wait for the prefetch for this mark (or abort)
        let blobUrl: string | null = await Promise.race([
          this.#ensurePrefetch(markIndex, mark.text),
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

        // If prefetch failed, retry once
        if (blobUrl === null) {
          this.#prefetchMap.delete(markIndex);
          blobUrl = await this.#ensurePrefetch(markIndex, mark.text);
        }

        if (blobUrl === null) {
          yield { code: 'error', message: 'Audio fetch failed' } as TTSMessageEvent;
          break;
        }

        // Kick off the next fetch in the sliding window
        const nextPrefetchIndex = markIndex + this.#parallel;
        if (nextPrefetchIndex < marks.length) {
          this.#ensurePrefetch(nextPrefetchIndex, marks[nextPrefetchIndex]!.text);
        }

        const currentBlobUrl = blobUrl;
        const result = await new Promise<TTSMessageEvent>((resolve) => {
          const cleanUp = () => {
            audio.onended = null;
            audio.onerror = null;
            audio.src = '';
            URL.revokeObjectURL(currentBlobUrl);
            this.#blobUrls.delete(currentBlobUrl);
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
    this.#clearPrefetch();
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
