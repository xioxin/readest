import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getUserLocale } from '@/utils/misc';
import { parseSSMLMarks } from '@/utils/ssml';
import { TTSClient, TTSMessageEvent } from './TTSClient';
import { TTSGranularity, TTSVoice, TTSVoicesGroup } from './types';
import { TTSController } from './TTSController';
import { TTSUtils } from './TTSUtils';

export interface LocalTtsModelInfo {
  id: string;
  name: string;
  hfModelId: string;
  sizeMb: number;
  languages: string[];
  voices: string[];
  status: 'notDownloaded' | 'downloading' | 'ready' | { error: string };
  supportsVoiceCloning: boolean;
}

export class LocalTTSClient implements TTSClient {
  name = 'local-tts';
  initialized = false;
  controller?: TTSController;

  #primaryLang = 'en';
  #speakingLang = '';
  #currentVoiceId = '';
  #currentModelId = '';
  #rate = 1.0;
  #referenceAudioPath = '';
  #voiceCloneEnabled = false;

  #models: LocalTtsModelInfo[] = [];
  #audioContext: AudioContext | null = null;
  #currentSource: AudioBufferSourceNode | null = null;
  #isPlaying = false;
  #pausedAt = 0;
  #startedAt = 0;

  constructor(controller?: TTSController) {
    this.controller = controller;
  }

  async init(): Promise<boolean> {
    try {
      const models = await invoke<LocalTtsModelInfo[]>('plugin:local-tts|local_tts_list_models');
      this.#models = models;
      const hasReady = models.some((m) => m.status === 'ready');
      this.initialized = hasReady;
      if (hasReady) {
        // Select the first ready model as default
        const firstReady = models.find((m) => m.status === 'ready');
        if (firstReady) {
          this.#currentModelId = firstReady.id;
        }
      }
      return this.initialized;
    } catch (error) {
      console.error('[LocalTTS] init error:', error);
      return false;
    }
  }

  setReferenceAudioPath(path: string) {
    this.#referenceAudioPath = path;
  }

  setVoiceCloneEnabled(enabled: boolean) {
    this.#voiceCloneEnabled = enabled;
  }

  setModelId(modelId: string) {
    this.#currentModelId = modelId;
  }

  getModels(): LocalTtsModelInfo[] {
    return this.#models;
  }

  async refreshModels(): Promise<LocalTtsModelInfo[]> {
    try {
      this.#models = await invoke<LocalTtsModelInfo[]>('plugin:local-tts|local_tts_list_models');
      const hasReady = this.#models.some((m) => m.status === 'ready');
      this.initialized = hasReady;
    } catch (error) {
      console.error('[LocalTTS] refreshModels error:', error);
    }
    return this.#models;
  }

  async downloadModel(modelId: string): Promise<void> {
    await invoke('plugin:local-tts|local_tts_download_model', { modelId });
  }

  async cancelDownload(modelId: string): Promise<void> {
    await invoke('plugin:local-tts|local_tts_cancel_download', { modelId });
  }

  async deleteModel(modelId: string): Promise<void> {
    await invoke('plugin:local-tts|local_tts_delete_model', { modelId });
    if (this.#currentModelId === modelId) {
      this.#currentModelId = '';
      this.initialized = false;
    }
  }

  async uploadReferenceAudio(
    sourcePath: string,
  ): Promise<{ referenceId: string; storedPath: string }> {
    return invoke('plugin:local-tts|local_tts_upload_reference_audio', { sourcePath });
  }

  onDownloadComplete(callback: (modelId: string) => void): () => void {
    let unlisten: (() => void) | null = null;
    listen<{ modelId: string }>('local-tts:download-complete', (event) => {
      callback(event.payload.modelId);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }

  onDownloadError(callback: (modelId: string, error: string) => void): () => void {
    let unlisten: (() => void) | null = null;
    listen<{ modelId: string; error: string }>('local-tts:download-error', (event) => {
      callback(event.payload.modelId, event.payload.error);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }

  private getAudioContext(): AudioContext {
    if (!this.#audioContext) {
      this.#audioContext = new AudioContext();
    }
    return this.#audioContext;
  }

  private async playWavBytes(wavBytes: number[]): Promise<void> {
    const ctx = this.getAudioContext();
    const arrayBuffer = new Uint8Array(wavBytes).buffer;
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = this.#rate;
    source.connect(ctx.destination);

    this.#currentSource = source;
    this.#isPlaying = true;
    this.#startedAt = ctx.currentTime - this.#pausedAt;
    this.#pausedAt = 0;
    source.start(0, 0);

    return new Promise<void>((resolve) => {
      source.onended = () => {
        this.#isPlaying = false;
        this.#currentSource = null;
        resolve();
      };
    });
  }

  async *speak(ssml: string, signal: AbortSignal, preload = false) {
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);

    if (preload) {
      yield { code: 'end', message: 'Preload finished' } as TTSMessageEvent;
      return;
    }

    for (const mark of marks) {
      if (signal.aborted) {
        yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
        return;
      }

      this.controller?.dispatchSpeakMark(mark);
      this.#speakingLang = mark.language;

      const compoundVoiceId = await this.getVoiceIdFromLang(mark.language);
      // Strip model prefix from compound voice ID (format: "model_id:voice_name").
      const colonIdx = compoundVoiceId.indexOf(':');
      const voiceId = colonIdx !== -1 ? compoundVoiceId.slice(colonIdx + 1) : compoundVoiceId;
      this.#currentVoiceId = voiceId;

      try {
        const wavBytes = await invoke<number[]>('plugin:local-tts|local_tts_synthesize', {
          payload: {
            text: mark.text,
            modelId: this.#currentModelId,
            voice: voiceId || undefined,
            language: mark.language || undefined,
            referenceAudioPath:
              this.#voiceCloneEnabled && this.#referenceAudioPath
                ? this.#referenceAudioPath
                : undefined,
          },
        });

        if (signal.aborted) {
          yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
          return;
        }

        yield {
          code: 'boundary',
          message: `Start chunk: ${mark.name}`,
          mark: mark.name,
        } as TTSMessageEvent;

        // Play audio and wait for it to finish, unless aborted.
        let aborted = false;
        const playPromise = this.playWavBytes(wavBytes);
        const abortPromise = new Promise<void>((resolve) => {
          const handler = () => {
            aborted = true;
            this.stopInternal();
            resolve();
          };
          if (signal.aborted) {
            handler();
          } else {
            signal.addEventListener('abort', handler, { once: true });
          }
        });

        await Promise.race([playPromise, abortPromise]);

        if (aborted || signal.aborted) {
          yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
          return;
        }

        yield {
          code: 'end',
          message: `Chunk finished: ${mark.name}`,
          mark: mark.name,
        } as TTSMessageEvent;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // Voice cloning not supported - notify controller and continue without it.
        if (message.includes('Voice cloning not supported')) {
          this.controller?.dispatchEvent(
            new CustomEvent('local-tts-clone-unsupported', {
              detail: { modelId: this.#currentModelId },
            }),
          );
          // Retry without reference audio
          try {
            const wavBytes = await invoke<number[]>('plugin:local-tts|local_tts_synthesize', {
              payload: {
                text: mark.text,
                modelId: this.#currentModelId,
                voice: voiceId || undefined,
                language: mark.language || undefined,
              },
            });
            await this.playWavBytes(wavBytes);
            yield { code: 'end', message: `Chunk finished: ${mark.name}` } as TTSMessageEvent;
            continue;
          } catch (retryError) {
            const retryMessage =
              retryError instanceof Error ? retryError.message : String(retryError);
            yield { code: 'error', message: retryMessage } as TTSMessageEvent;
            break;
          }
        }

        console.warn('[LocalTTS] synthesis error for mark:', mark.text, message);
        yield { code: 'error', message } as TTSMessageEvent;
        break;
      }
    }
  }

  async getVoiceIdFromLang(lang: string): Promise<string> {
    const preferredVoiceId = TTSUtils.getPreferredVoice(this.name, lang);
    if (preferredVoiceId) return preferredVoiceId;

    const voices = await this.getVoices(lang);
    return voices[0]?.voices[0]?.id || this.#currentVoiceId || '';
  }

  async pause(): Promise<boolean> {
    if (!this.#isPlaying || !this.#currentSource) return true;
    const ctx = this.getAudioContext();
    this.#pausedAt = ctx.currentTime - this.#startedAt;
    this.stopInternal();
    return true;
  }

  async resume(): Promise<boolean> {
    // Resume is handled by replaying from paused position in the next speak call.
    return true;
  }

  async stop(): Promise<void> {
    this.stopInternal();
    this.#pausedAt = 0;
    this.#startedAt = 0;
  }

  private stopInternal() {
    if (this.#currentSource) {
      try {
        this.#currentSource.stop();
      } catch {
        // already stopped
      }
      this.#currentSource = null;
    }
    this.#isPlaying = false;
  }

  async setRate(rate: number): Promise<void> {
    this.#rate = rate;
    if (this.#currentSource) {
      this.#currentSource.playbackRate.value = rate;
    }
  }

  async setPitch(_pitch: number): Promise<void> {
    // Pitch adjustment not supported via basic AudioContext.
  }

  async setVoice(voice: string): Promise<void> {
    this.#currentVoiceId = voice;
    // Voice ID format is "model_id:voice_name". Parse and set the model.
    const colonIdx = voice.indexOf(':');
    if (colonIdx !== -1) {
      const modelId = voice.slice(0, colonIdx);
      const voiceName = voice.slice(colonIdx + 1);
      const model = this.#models.find((m) => m.id === modelId && m.status === 'ready');
      if (model) {
        this.#currentModelId = modelId;
        // Store only the actual voice name (without model prefix) for synthesis.
        this.#currentVoiceId = voiceName;
      }
    } else {
      // Legacy / bare voice name fallback.
      for (const model of this.#models) {
        if (model.status === 'ready' && model.voices.includes(voice)) {
          this.#currentModelId = model.id;
          break;
        }
      }
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    const voices: TTSVoice[] = [];
    for (const model of this.#models) {
      if (model.status !== 'ready') continue;
      for (const voice of model.voices) {
        // Use model-prefixed id so voices are unique across models.
        const id = `${model.id}:${voice}`;
        // Infer language from voice name prefix (e.g. af_ → en, bm_ → en-GB).
        const lang = inferVoiceLang(voice, model.languages);
        voices.push({ id, name: voice, lang, disabled: !this.initialized });
      }
      // If model has no preset voices (e.g. OmniVoice), add one generic entry.
      if (model.voices.length === 0) {
        const lang = model.languages[0] || 'en';
        voices.push({
          id: `${model.id}:default`,
          name: model.name,
          lang,
          disabled: !this.initialized,
        });
      }
    }
    return voices;
  }

  async getVoices(lang: string): Promise<TTSVoicesGroup[]> {
    const locale = lang === 'en' ? getUserLocale(lang) || lang : lang;
    const allVoices = await this.getAllVoices();
    const filteredVoices = allVoices.filter(
      (v) => v.lang.startsWith(locale) || (lang === 'en' && ['en-US', 'en-GB'].includes(v.lang)),
    );

    if (filteredVoices.length === 0) {
      return [];
    }

    return [
      {
        id: 'local-tts',
        name: 'Local TTS',
        voices: filteredVoices.sort(TTSUtils.sortVoicesFunc),
        disabled: !this.initialized || filteredVoices.length === 0,
      },
    ];
  }

  setPrimaryLang(lang: string): void {
    this.#primaryLang = lang;
  }

  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }

  getVoiceId(): string {
    return this.#currentVoiceId;
  }

  getSpeakingLang(): string {
    return this.#speakingLang;
  }

  async shutdown(): Promise<void> {
    this.stopInternal();
    if (this.#audioContext) {
      await this.#audioContext.close().catch(() => {});
      this.#audioContext = null;
    }
    this.initialized = false;
  }
}

/** Heuristic: infer voice language from Kokoro voice name prefixes. */
function inferVoiceLang(voice: string, modelLanguages: string[]): string {
  // Kokoro-style prefixes: af_ = American female, am_ = American male, bf_ = British female, bm_ = British male
  if (voice.startsWith('af_') || voice.startsWith('am_')) return 'en-US';
  if (voice.startsWith('bf_') || voice.startsWith('bm_')) return 'en-GB';
  if (voice.startsWith('jf_') || voice.startsWith('jm_')) return 'ja';
  if (voice.startsWith('zf_') || voice.startsWith('zm_')) return 'zh';
  // Fallback to first language in model's language list
  const lang = modelLanguages[0] || 'en';
  return lang.length === 2 ? lang : lang.split('-')[0] || lang;
}
