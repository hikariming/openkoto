// Modules
pub mod agent_worker;
mod ai_service;
pub mod commands;
pub mod ffmpeg;
pub mod ktv_export;
pub mod logging;
pub mod moonshot;
pub mod pdf_sidecar;
pub mod storage;
mod subtitle_extraction;
pub mod subtitle_import;
pub mod types;
mod video_server;
mod youtube;

// Re-exports
use agent_worker::{mark_running_tasks_interrupted_in_dir, AgentWorkerManager};
use ai_service::AIServiceCache;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AIServiceCache::default())
        .manage(AgentWorkerManager::default())
        .invoke_handler(tauri::generate_handler![
            // App initialization
            commands::init_app,
            // Configuration
            commands::get_config,
            commands::save_config_cmd,
            commands::set_api_key,
            commands::save_model_config,
            commands::delete_model_config,
            commands::set_active_model_config,
            commands::get_active_model_config,
            // Articles
            commands::create_article,
            commands::resegment_article,
            commands::get_article,
            commands::list_articles_cmd,
            commands::update_article,
            commands::update_article_segment,
            commands::delete_article_cmd,
            commands::fetch_url_content,
            commands::import_web_material_cmd,
            commands::article_get_overview_cmd,
            commands::article_read_window_cmd,
            commands::article_search_cmd,
            commands::article_get_evidence_cmd,
            commands::task_report_progress_cmd,
            commands::artifact_save_cmd,
            commands::create_mind_map_task_cmd,
            commands::run_agent_turn_cmd,
            commands::get_agent_task_cmd,
            commands::get_artifact_cmd,
            commands::get_agent_worker_status_cmd,
            commands::stop_agent_worker_cmd,
            // AI operations
            commands::translate_text,
            commands::analyze_text,
            commands::chat_completion,
            commands::stream_chat_completion,
            commands::translate_article,
            commands::analyze_article,
            commands::segment_translate_explain_cmd,
            // 收藏夹命令
            commands::create_word_pack_cmd,
            commands::update_word_pack_cmd,
            commands::list_word_packs_cmd,
            commands::delete_word_pack_cmd,
            commands::add_favorite_vocabulary_cmd,
            commands::list_favorite_vocabularies_cmd,
            commands::list_favorite_vocabularies_by_pack_cmd,
            commands::set_vocabulary_pack_ids_cmd,
            commands::get_due_vocabulary_queue_cmd,
            commands::review_vocabulary_cmd,
            commands::export_word_pack_cmd,
            commands::import_word_pack_cmd,
            commands::delete_favorite_vocabulary_cmd,
            commands::add_favorite_grammar_cmd,
            commands::list_favorite_grammars_cmd,
            commands::delete_favorite_grammar_cmd,
            // External
            commands::import_youtube_video_cmd,
            commands::import_local_video_cmd,
            commands::import_article_subtitles_cmd,
            commands::import_srt_file_cmd,
            commands::prepare_ktv_segments_cmd,
            commands::export_ktv_video_cmd,
            // 书籍导入
            commands::import_book_cmd,
            // 字幕提取
            commands::extract_subtitles_cmd,
            // 文件操作
            commands::write_text_file,
            commands::write_binary_file,
            // 删除操作
            commands::delete_article_subtitles_cmd,
            commands::delete_article_analysis_cmd,
            // PDF翻译
            commands::translate_pdf_document,
            commands::check_pdf_translation_files,
            commands::export_file_cmd,
            // 全局日志
            logging::get_logs_cmd,
            logging::clear_logs_cmd,
            logging::append_log_cmd,
            logging::get_log_file_path_cmd,
            // 书签管理
            commands::add_bookmark_cmd,
            commands::list_bookmarks_cmd,
            commands::list_bookmarks_for_book_cmd,
            commands::update_bookmark_cmd,
            commands::delete_bookmark_cmd,
        ])
        .setup(|app| {
            // Initialize app on startup
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Ensure app directories exist
                let _ = commands::init_app(app_handle.clone()).await;
                if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
                    // Start the persistent log file as early as possible so the
                    // very first PDF translation of a session is captured.
                    logging::LogStore::global().init_file(&app_data_dir);
                    let _ = mark_running_tasks_interrupted_in_dir(&app_data_dir);
                }

                // 启动资源服务器 (视频 + 书籍)
                let app_data_dir = app_handle.path().app_data_dir().unwrap();
                if let Err(e) = video_server::start_resource_server(app_data_dir).await {
                    eprintln!("[ResourceServer] Failed to start: {}", e);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
