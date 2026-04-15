const COMMANDS: &[&str] = &[
    "local_tts_list_models",
    "local_tts_download_model",
    "local_tts_cancel_download",
    "local_tts_delete_model",
    "local_tts_synthesize",
    "local_tts_get_voices",
    "local_tts_upload_reference_audio",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
