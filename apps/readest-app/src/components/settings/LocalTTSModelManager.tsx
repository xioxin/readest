import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { LocalTtsModelInfo } from '@/services/tts/LocalTTSClient';

interface LocalTTSModelManagerProps {
  onModelReady?: () => void;
}

const LocalTTSModelManager: React.FC<LocalTTSModelManagerProps> = ({ onModelReady }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();

  const [models, setModels] = useState<LocalTtsModelInfo[]>([]);
  const [cloneEnabled, setCloneEnabled] = useState(settings.localTTSVoiceCloneEnabled ?? false);
  const [referenceAudioPath, setReferenceAudioPath] = useState(
    settings.localTTSReferenceAudioPath ?? '',
  );
  const [cloneUnsupportedWarning, setCloneUnsupportedWarning] = useState(false);
  const unlistenRefs = useRef<Array<() => void>>([]);

  const refreshModels = useCallback(async () => {
    try {
      const updated = await invoke<LocalTtsModelInfo[]>('plugin:local-tts|local_tts_list_models');
      setModels(updated);
    } catch (error) {
      console.error('[LocalTTS] list models error:', error);
    }
  }, []);

  useEffect(() => {
    refreshModels();
  }, [refreshModels]);

  useEffect(() => {
    let mounted = true;

    const setupListeners = async () => {
      const unlistenComplete = await listen<{ modelId: string }>(
        'local-tts:download-complete',
        async (event) => {
          if (!mounted) return;
          console.log('[LocalTTS] Download complete:', event.payload.modelId);
          await refreshModels();
          onModelReady?.();
        },
      );

      const unlistenError = await listen<{ modelId: string; error: string }>(
        'local-tts:download-error',
        async (event) => {
          if (!mounted) return;
          console.error('[LocalTTS] Download error:', event.payload.modelId, event.payload.error);
          await refreshModels();
        },
      );

      if (mounted) {
        unlistenRefs.current = [unlistenComplete, unlistenError];
      } else {
        unlistenComplete();
        unlistenError();
      }
    };

    setupListeners();
    return () => {
      mounted = false;
      unlistenRefs.current.forEach((fn) => fn());
      unlistenRefs.current = [];
    };
  }, [refreshModels, onModelReady]);

  const handleDownload = async (modelId: string) => {
    setModels((prev) => prev.map((m) => (m.id === modelId ? { ...m, status: 'downloading' } : m)));
    try {
      await invoke('plugin:local-tts|local_tts_download_model', { modelId });
    } catch (error) {
      console.error('[LocalTTS] Download start error:', error);
      await refreshModels();
    }
  };

  const handleDelete = async (modelId: string) => {
    try {
      await invoke('plugin:local-tts|local_tts_delete_model', { modelId });
      await refreshModels();
    } catch (error) {
      console.error('[LocalTTS] Delete error:', error);
    }
  };

  const handleCloneToggle = (enabled: boolean) => {
    setCloneEnabled(enabled);
    setCloneUnsupportedWarning(false);
    const updated = { ...settings, localTTSVoiceCloneEnabled: enabled };
    setSettings(updated);
    saveSettings(envConfig, updated);
  };

  const handleUploadReferenceAudio = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg'] }],
      });
      if (!selected) return;

      const sourcePath =
        typeof selected === 'string' ? selected : (selected as { path: string }).path;
      const result = await invoke<{ referenceId: string; storedPath: string }>(
        'plugin:local-tts|local_tts_upload_reference_audio',
        { sourcePath },
      );
      setReferenceAudioPath(result.storedPath);

      const updated = { ...settings, localTTSReferenceAudioPath: result.storedPath };
      setSettings(updated);
      saveSettings(envConfig, updated);
    } catch (error) {
      console.error('[LocalTTS] Upload reference audio error:', error);
    }
  };

  const handleClearReferenceAudio = () => {
    setReferenceAudioPath('');
    const updated = { ...settings, localTTSReferenceAudioPath: '' };
    setSettings(updated);
    saveSettings(envConfig, updated);
  };

  const referenceAudioFilename = referenceAudioPath
    ? referenceAudioPath.split(/[/\\]/).pop() || referenceAudioPath
    : '';

  const getStatusLabel = (model: LocalTtsModelInfo): string => {
    if (model.status === 'ready') return _('Ready');
    if (model.status === 'downloading') return _('Downloading…');
    if (model.status === 'notDownloaded') return _('Not downloaded');
    if (typeof model.status === 'object' && 'error' in model.status) return _('Error');
    return '';
  };

  return (
    <div className='w-full space-y-4' data-setting-id='settings.localTts'>
      <h2 className='font-medium'>{_('Local TTS Models')}</h2>

      <div className='card border-base-200 bg-base-100 border shadow'>
        <div className='divide-base-200 divide-y'>
          {models.length === 0 && (
            <div className='flex items-center justify-center px-4 py-6 text-sm opacity-60'>
              {_('Loading models…')}
            </div>
          )}
          {models.map((model) => (
            <div key={model.id} className='flex items-center justify-between px-4 py-3'>
              <div className='flex flex-col gap-0.5'>
                <span className='text-sm font-medium'>{model.name}</span>
                <span className='text-xs opacity-60'>
                  {model.sizeMb} MB · {model.languages.join(', ')}
                </span>
                <span
                  className={`text-xs ${
                    model.status === 'ready'
                      ? 'text-success'
                      : model.status === 'downloading'
                        ? 'text-warning'
                        : typeof model.status === 'object'
                          ? 'text-error'
                          : 'opacity-40'
                  }`}
                >
                  {getStatusLabel(model)}
                </span>
              </div>

              <div className='flex gap-2'>
                {model.status === 'notDownloaded' && (
                  <button
                    className='btn btn-sm btn-primary'
                    onClick={() => handleDownload(model.id)}
                  >
                    {_('Download')}
                  </button>
                )}
                {model.status === 'downloading' && (
                  <span className='loading loading-spinner loading-sm' />
                )}
                {model.status === 'ready' && (
                  <button
                    className='btn btn-sm btn-error btn-outline'
                    onClick={() => handleDelete(model.id)}
                  >
                    {_('Delete')}
                  </button>
                )}
                {typeof model.status === 'object' && 'error' in model.status && (
                  <button
                    className='btn btn-sm btn-warning'
                    onClick={() => handleDownload(model.id)}
                  >
                    {_('Retry')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Voice cloning section */}
      <div className='card border-base-200 bg-base-100 border shadow'>
        <div className='divide-base-200 divide-y'>
          <div className='config-item !h-16'>
            <div className='flex flex-col gap-1'>
              <span>{_('Voice Cloning')}</span>
              <span className='text-xs opacity-60'>
                {_('Use a reference audio clip to clone a voice')}
              </span>
            </div>
            <input
              type='checkbox'
              className='toggle toggle-primary'
              checked={cloneEnabled}
              onChange={(e) => handleCloneToggle(e.target.checked)}
            />
          </div>

          {cloneEnabled && (
            <div className='flex flex-col gap-2 px-4 py-3'>
              {cloneUnsupportedWarning && (
                <div className='alert alert-warning py-2 text-xs'>
                  {_(
                    'The current model does not support voice cloning. Please disable this feature or choose a compatible model.',
                  )}
                </div>
              )}

              {referenceAudioFilename ? (
                <div className='flex items-center gap-2'>
                  <span className='flex-1 truncate text-sm opacity-80'>
                    {referenceAudioFilename}
                  </span>
                  <button className='btn btn-sm btn-ghost' onClick={handleClearReferenceAudio}>
                    {_('Clear')}
                  </button>
                </div>
              ) : (
                <button className='btn btn-sm btn-outline' onClick={handleUploadReferenceAudio}>
                  {_('Upload Reference Audio')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default LocalTTSModelManager;
