use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Local TTS error: {0}")]
    LocalTtsError(String),
    #[error("Model not found: {0}")]
    ModelNotFound(String),
    #[error("Model not downloaded: {0}")]
    ModelNotDownloaded(String),
    #[error("Download in progress: {0}")]
    DownloadInProgress(String),
    #[error("Voice cloning not supported by this model")]
    VoiceCloningNotSupported,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("TTS error: {0}")]
    AnyTts(String),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

impl From<any_tts::TtsError> for Error {
    fn from(e: any_tts::TtsError) -> Self {
        let msg = e.to_string();
        if msg.contains("not supported") || msg.contains("reference_audio") {
            Error::VoiceCloningNotSupported
        } else {
            Error::AnyTts(msg)
        }
    }
}
