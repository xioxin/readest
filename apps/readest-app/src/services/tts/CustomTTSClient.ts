import { TTSClient, TTSMessageEvent } from './TTSClient';
import { TTSGranularity, TTSVoice, TTSVoicesGroup } from './types';
import { parseSSMLMarks } from '@/utils/ssml';
import { TTSController } from './TTSController';

const CUSTOM_TTS_URL_PLACEHOLDER = '{{speakText}}';

export class CustomTTSClient implements TTSClient {
  name = 'custom-tts';
  initialized = false;
  controller?: TTSController;

  #url: string;
  #rate = 1.0;
  #audioElement: HTMLAudioElement | null = null;
  #isPlaying = false;
  #pausedAt = 0;

  constructor(controller?: TTSController, url = '') {
    this.controller = controller;
    this.#url = url;
  }

  setUrl(url: string) {
    this.#url = url;
  }

  async init() {
    this.initialized = !!this.#url;
    return this.initialized;
  }

  async shutdown() {
    this.initialized = false;
    if (this.#audioElement) {
      this.#audioElement.pause();
      this.#audioElement.src = '';
      this.#audioElement = null;
    }
  }

  #buildAudioUrl(text: string): string {
    return this.#url.replace(CUSTOM_TTS_URL_PLACEHOLDER, encodeURIComponent(text));
  }

  async *speak(ssml: string, signal: AbortSignal, preload = false): AsyncIterable<TTSMessageEvent> {
    const { marks } = parseSSMLMarks(ssml);

    if (preload) {
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
        const audioUrl = this.#buildAudioUrl(mark.text);
        if (signal.aborted) {
          yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
          break;
        }

        yield {
          code: 'boundary',
          message: `Start chunk: ${mark.name}`,
          mark: mark.name,
        } as TTSMessageEvent;

        const result = await new Promise<TTSMessageEvent>((resolve) => {
          const cleanUp = () => {
            audio.onended = null;
            audio.onerror = null;
            audio.src = '';
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
          audio.src = audioUrl;
          audio.playbackRate = this.#rate;
          audio.play().catch((err) => {
            cleanUp();
            console.error('Custom TTS failed to play audio:', err);
            resolve({ code: 'error', message: 'Playback failed: ' + err.message });
          });
        });
        yield result;
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
