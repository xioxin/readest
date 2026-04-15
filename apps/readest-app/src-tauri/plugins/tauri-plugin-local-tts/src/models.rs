use serde::{Deserialize, Serialize};

/// Status of a model's download.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModelStatus {
    NotDownloaded,
    Downloading,
    Ready,
    Error(String),
}

/// Info about a local TTS model exposed to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTtsModelInfo {
    pub id: String,
    pub name: String,
    pub hf_model_id: String,
    pub size_mb: u32,
    pub languages: Vec<String>,
    pub voices: Vec<String>,
    pub status: ModelStatus,
    pub supports_voice_cloning: bool,
}

/// Arguments for synthesize command.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeArgs {
    pub text: String,
    pub model_id: String,
    #[serde(default)]
    pub voice: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    /// Path to a local audio file to use as voice reference (for voice cloning).
    #[serde(default)]
    pub reference_audio_path: Option<String>,
}

/// Response from upload_reference_audio.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadReferenceAudioResponse {
    pub reference_id: String,
    pub stored_path: String,
}

/// Download-progress event payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressEvent {
    pub model_id: String,
}

/// Download-complete event payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCompleteEvent {
    pub model_id: String,
}

/// Download-error event payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadErrorEvent {
    pub model_id: String,
    pub error: String,
}
