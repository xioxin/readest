mod error;
mod models;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use any_tts::{AudioSamples, ModelType, ReferenceAudio, SynthesisRequest, TtsConfig, TtsModel};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::error::{Error, Result};
use crate::models::*;

// ── Static model catalogue ──────────────────────────────────────────────────

pub struct ModelDef {
    pub id: &'static str,
    pub name: &'static str,
    pub hf_model_id: &'static str,
    pub model_type: ModelType,
    pub size_mb: u32,
    pub languages: &'static [&'static str],
    pub voices: &'static [&'static str],
    pub supports_voice_cloning: bool,
}

pub static AVAILABLE_MODELS: &[ModelDef] = &[
    ModelDef {
        id: "kokoro",
        name: "Kokoro 82M",
        hf_model_id: "hexgrad/Kokoro-82M",
        model_type: ModelType::Kokoro,
        size_mb: 326,
        languages: &["en", "ja", "zh", "es", "fr", "hi", "it", "pt"],
        voices: &[
            "af_heart",
            "af_bella",
            "af_nicole",
            "af_sky",
            "af_sarah",
            "af",
            "am_adam",
            "am_michael",
            "bf_emma",
            "bf_isabella",
            "bm_george",
            "bm_lewis",
        ],
        supports_voice_cloning: false,
    },
    ModelDef {
        id: "omnivoice",
        name: "OmniVoice",
        hf_model_id: "k2-fsa/OmniVoice",
        model_type: ModelType::OmniVoice,
        size_mb: 900,
        languages: &["auto"],
        voices: &[],
        supports_voice_cloning: true,
    },
    ModelDef {
        id: "vibevoice-realtime",
        name: "VibeVoice Realtime 0.5B",
        hf_model_id: "microsoft/VibeVoice-Realtime-0.5B",
        model_type: ModelType::VibeVoiceRealtime,
        size_mb: 1000,
        languages: &["en", "zh"],
        voices: &[
            "Abigail",
            "Adam",
            "Adriana",
            "AikoVoice1",
            "AlejandroVoice1",
            "Amala",
        ],
        supports_voice_cloning: false,
    },
];

// ── Download state ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadState {
    Idle,
    Downloading,
    Done,
    Failed(String),
}

// ── Plugin state ────────────────────────────────────────────────────────────

pub struct LocalTtsState {
    /// Root of the HF-style cache (models downloaded here).
    pub cache_dir: PathBuf,
    /// Reference audio storage dir.
    pub ref_audio_dir: PathBuf,
    /// Download state per model id.
    pub download_states: Arc<Mutex<HashMap<String, DownloadState>>>,
    /// Loaded model instances, keyed by model id.
    pub loaded_models: Arc<Mutex<HashMap<String, Arc<Box<dyn TtsModel>>>>>,
}

impl LocalTtsState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let cache_dir = app_data_dir.join("local-tts-cache");
        let ref_audio_dir = app_data_dir.join("local-tts-ref-audio");
        Self {
            cache_dir,
            ref_audio_dir,
            download_states: Arc::new(Mutex::new(HashMap::new())),
            loaded_models: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Compute the model directory inside our HF-style cache.
    pub fn model_dir(&self, hf_model_id: &str) -> PathBuf {
        self.cache_dir
            .join(format!("models--{}", hf_model_id.replace('/', "--")))
            .join("snapshots")
            .join("main")
    }

    /// Return true if the model's directory exists and contains a weight file.
    pub fn is_model_downloaded(&self, model_def: &ModelDef) -> bool {
        let dir = self.model_dir(model_def.hf_model_id);
        if !dir.exists() {
            return false;
        }
        // Check for at least one .safetensors or .pth file as proxy for "downloaded".
        std::fs::read_dir(&dir).ok().map_or(false, |mut entries| {
            entries.any(|e| {
                e.ok()
                    .and_then(|e| {
                        let name = e.file_name();
                        let name = name.to_string_lossy();
                        if name.ends_with(".safetensors") || name.ends_with(".pth") {
                            Some(())
                        } else {
                            None
                        }
                    })
                    .is_some()
            })
        })
    }

    /// Get current download status for a model.
    pub fn model_status(&self, model_def: &ModelDef) -> ModelStatus {
        let states = self.download_states.lock().unwrap();
        match states.get(model_def.id) {
            Some(DownloadState::Downloading) => ModelStatus::Downloading,
            Some(DownloadState::Failed(e)) => ModelStatus::Error(e.clone()),
            _ => {
                if self.is_model_downloaded(model_def) {
                    ModelStatus::Ready
                } else {
                    ModelStatus::NotDownloaded
                }
            }
        }
    }

    /// Build the LocalTtsModelInfo list.
    pub fn list_models(&self) -> Vec<LocalTtsModelInfo> {
        AVAILABLE_MODELS
            .iter()
            .map(|def| LocalTtsModelInfo {
                id: def.id.to_string(),
                name: def.name.to_string(),
                hf_model_id: def.hf_model_id.to_string(),
                size_mb: def.size_mb,
                languages: def.languages.iter().map(|s| s.to_string()).collect(),
                voices: def.voices.iter().map(|s| s.to_string()).collect(),
                status: self.model_status(def),
                supports_voice_cloning: def.supports_voice_cloning,
            })
            .collect()
    }

    /// Get or load a model instance. Returns Arc so the lock is released quickly.
    pub fn get_or_load_model(&self, model_id: &str) -> Result<Arc<Box<dyn TtsModel>>> {
        {
            let loaded = self.loaded_models.lock().unwrap();
            if let Some(m) = loaded.get(model_id) {
                return Ok(m.clone());
            }
        }

        let def = AVAILABLE_MODELS
            .iter()
            .find(|d| d.id == model_id)
            .ok_or_else(|| Error::ModelNotFound(model_id.to_string()))?;

        if !self.is_model_downloaded(def) {
            return Err(Error::ModelNotDownloaded(model_id.to_string()));
        }

        let model_dir = self.model_dir(def.hf_model_id);
        let model_type = def.model_type;
        let model = any_tts::load_model(
            TtsConfig::new(model_type)
                .with_model_path(model_dir.to_string_lossy().as_ref()),
        )
        .map_err(Error::from)?;

        let arc_model = Arc::new(model);
        self.loaded_models
            .lock()
            .unwrap()
            .insert(model_id.to_string(), arc_model.clone());

        Ok(arc_model)
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn local_tts_list_models<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<LocalTtsModelInfo>> {
    let state = app.state::<LocalTtsState>();
    Ok(state.list_models())
}

#[tauri::command]
pub async fn local_tts_download_model<R: Runtime>(
    app: AppHandle<R>,
    model_id: String,
) -> Result<()> {
    let state = app.state::<LocalTtsState>();

    let def = AVAILABLE_MODELS
        .iter()
        .find(|d| d.id == model_id)
        .ok_or_else(|| Error::ModelNotFound(model_id.clone()))?;

    // Check if already downloading.
    {
        let states = state.download_states.lock().unwrap();
        if states.get(model_id.as_str()) == Some(&DownloadState::Downloading) {
            return Err(Error::DownloadInProgress(model_id.clone()));
        }
    }

    // Mark as downloading.
    state
        .download_states
        .lock()
        .unwrap()
        .insert(model_id.clone(), DownloadState::Downloading);

    let hf_model_id = def.hf_model_id.to_string();
    let model_type = def.model_type;
    let cache_dir = state.cache_dir.clone();
    let download_states = state.download_states.clone();
    let loaded_models = state.loaded_models.clone();

    // Spawn a blocking task for the download (any-tts uses reqwest::blocking).
    tokio::task::spawn(async move {
        let mid = model_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            // Point any-tts at our cache dir via env variable.
            // This is safe: we set it once per download and any-tts reads it
            // when computing the cache path.
            std::env::set_var("HUGGINGFACE_HUB_CACHE", &cache_dir);

            // Load (which triggers download for missing files).
            any_tts::load_model(
                TtsConfig::new(model_type).with_hf_model_id(hf_model_id),
            )
        })
        .await;

        match result {
            Ok(Ok(model)) => {
                // Cache the loaded model.
                loaded_models
                    .lock()
                    .unwrap()
                    .insert(mid.clone(), Arc::new(model));
                download_states
                    .lock()
                    .unwrap()
                    .insert(mid.clone(), DownloadState::Done);
                let _ = app.emit(
                    "local-tts:download-complete",
                    DownloadCompleteEvent { model_id: mid },
                );
            }
            Ok(Err(e)) => {
                let err = e.to_string();
                download_states
                    .lock()
                    .unwrap()
                    .insert(mid.clone(), DownloadState::Failed(err.clone()));
                let _ = app.emit(
                    "local-tts:download-error",
                    DownloadErrorEvent {
                        model_id: mid,
                        error: err,
                    },
                );
            }
            Err(e) => {
                let err = e.to_string();
                download_states
                    .lock()
                    .unwrap()
                    .insert(mid.clone(), DownloadState::Failed(err.clone()));
                let _ = app.emit(
                    "local-tts:download-error",
                    DownloadErrorEvent {
                        model_id: mid,
                        error: err,
                    },
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn local_tts_cancel_download<R: Runtime>(
    app: AppHandle<R>,
    model_id: String,
) -> Result<()> {
    let state = app.state::<LocalTtsState>();
    // We can't truly cancel the blocking download, but we mark it as cancelled
    // so the UI doesn't wait. The background thread may still finish but we
    // ignore its result.
    state
        .download_states
        .lock()
        .unwrap()
        .remove(&model_id);
    Ok(())
}

#[tauri::command]
pub async fn local_tts_delete_model<R: Runtime>(
    app: AppHandle<R>,
    model_id: String,
) -> Result<()> {
    let state = app.state::<LocalTtsState>();

    let def = AVAILABLE_MODELS
        .iter()
        .find(|d| d.id == model_id)
        .ok_or_else(|| Error::ModelNotFound(model_id.clone()))?;

    // Remove from loaded cache.
    state.loaded_models.lock().unwrap().remove(&model_id);

    // Remove download state.
    state.download_states.lock().unwrap().remove(&model_id);

    // Delete model directory.
    let model_dir = state.model_dir(def.hf_model_id);
    if model_dir.exists() {
        std::fs::remove_dir_all(&model_dir)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn local_tts_synthesize<R: Runtime>(
    app: AppHandle<R>,
    payload: SynthesizeArgs,
) -> Result<Vec<u8>> {
    let state = app.state::<LocalTtsState>();

    // Load or retrieve cached model.
    let model = state.get_or_load_model(&payload.model_id)?;

    // Build synthesis request.
    let mut request = SynthesisRequest::new(payload.text.clone());

    if let Some(lang) = &payload.language {
        request = request.with_language(lang);
    }
    if let Some(voice) = &payload.voice {
        request = request.with_voice(voice);
    }

    // Handle reference audio for voice cloning.
    let reference_audio_path = payload.reference_audio_path.clone();
    if let Some(ref_path) = reference_audio_path {
        let path = PathBuf::from(&ref_path);
        if path.exists() {
            let audio_bytes = std::fs::read(&path)
                .map_err(|e| Error::LocalTtsError(format!("Failed to read reference audio: {e}")))?;
            let samples = AudioSamples::from_audio_bytes(&audio_bytes)
                .map_err(|e| Error::AnyTts(e.to_string()))?;
            let ref_audio = ReferenceAudio::new(samples.samples, samples.sample_rate);
            request = request.with_reference_audio(ref_audio);
        }
    }

    // Run synthesis in a blocking thread.
    let audio = tokio::task::spawn_blocking(move || model.synthesize(&request))
        .await
        .map_err(|e| Error::LocalTtsError(e.to_string()))?
        .map_err(Error::from)?;

    Ok(audio.get_wav())
}

#[tauri::command]
pub async fn local_tts_get_voices<R: Runtime>(
    _app: AppHandle<R>,
    model_id: String,
) -> Result<Vec<String>> {
    let def = AVAILABLE_MODELS
        .iter()
        .find(|d| d.id == model_id)
        .ok_or_else(|| Error::ModelNotFound(model_id.clone()))?;
    Ok(def.voices.iter().map(|s| s.to_string()).collect())
}

#[tauri::command]
pub async fn local_tts_upload_reference_audio<R: Runtime>(
    app: AppHandle<R>,
    source_path: String,
) -> Result<UploadReferenceAudioResponse> {
    let state = app.state::<LocalTtsState>();

    // Ensure reference audio directory exists.
    std::fs::create_dir_all(&state.ref_audio_dir)?;

    let src_path = PathBuf::from(&source_path);
    let ext = src_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("wav");

    // Generate a unique ID for this reference audio.
    let reference_id = format!(
        "ref_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let filename = format!("{reference_id}.{ext}");
    let dest_path = state.ref_audio_dir.join(&filename);

    std::fs::copy(&src_path, &dest_path)?;

    Ok(UploadReferenceAudioResponse {
        reference_id,
        stored_path: dest_path.to_string_lossy().to_string(),
    })
}

// ── Plugin registration ──────────────────────────────────────────────────────

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("local-tts")
        .invoke_handler(tauri::generate_handler![
            local_tts_list_models,
            local_tts_download_model,
            local_tts_cancel_download,
            local_tts_delete_model,
            local_tts_synthesize,
            local_tts_get_voices,
            local_tts_upload_reference_audio,
        ])
        .setup(|app, _api| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| Box::new(Error::LocalTtsError(e.to_string()))
                    as Box<dyn std::error::Error + Send + Sync>)?;

            // Create cache and ref-audio directories eagerly.
            let state = LocalTtsState::new(app_data_dir.clone());
            let _ = std::fs::create_dir_all(&state.cache_dir);
            let _ = std::fs::create_dir_all(&state.ref_audio_dir);

            // Point any-tts at our cache dir (read at download time).
            std::env::set_var("HUGGINGFACE_HUB_CACHE", &state.cache_dir);

            app.manage(state);
            Ok(())
        })
        .build()
}
