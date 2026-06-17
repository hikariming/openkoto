/**
 * 书籍阅读器包装组件
 * 左侧是 EPUB/TXT 阅读器，右侧是 AI 助手面板
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "../ui/button";
import { ChevronLeft, BookOpen, PanelRightClose, PanelRightOpen, Languages, Loader2, Download, FileText, Split, File, Columns } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Article } from "../../types";
import { EpubReader } from "./EpubReader";
import { TxtReader } from "./TxtReader";
import { PdfReader } from "./PdfReader";
import { ArticleChatAssistant } from "./ArticleChatAssistant";
import { ArticleMindMapPanel } from "./ArticleMindMapPanel";
import { AssistantSidebarShell, type AssistantPanelMode } from "./AssistantSidebarShell";
import { useConfig } from "../../lib/hooks";
import { logger } from "../../lib/logger";

interface BookReaderProps {
    article: Article;
    onBack?: () => void;
    onUpdate?: () => void;
}

export function BookReader({ article, onBack }: BookReaderProps) {
    const { t } = useTranslation();
    const assistantModeStorageKey = "book-reader-assistant-mode";
    const backToMaterialsLabel = t("bookReader.backToMaterials", "返回素材列表");

    // 选中的文本（用于 AI 分析）
    const [selectedText, setSelectedText] = useState("");

    // 显示 AI 助手面板
    const [showAssistant, setShowAssistant] = useState(true);

    // 当前活动的助手标签
    const [activeTab, setActiveTab] = useState<"mind_map" | "chat">("mind_map");

    // Config hook
    const { config } = useConfig();
    const targetLanguage = config?.target_language || "zh-CN";

    // PDF版本控制
    const [pdfVersion, setPdfVersion] = useState<"original" | "mono" | "dual" | "split">("original");
    const [availableVersions, setAvailableVersions] = useState<{
        mono?: string;
        dual?: string;
    }>({});

    // PDF翻译状态
    const [isTranslating, setIsTranslating] = useState(false);
    // 翻译进度百分比（null 表示尚未收到进度）
    const [translateProgress, setTranslateProgress] = useState<number | null>(null);

    // 判断书籍类型
    const isEpub = article.book_type === "epub";
    const isTxt = article.book_type === "txt";
    const isPdf = article.book_type === "pdf";

    // 检查已存在的翻译文件
    useEffect(() => {
        if (isPdf && article.book_path) {
            checkTranslationFiles();
        }
    }, [isPdf, article.book_path]);

    const checkTranslationFiles = async () => {
        try {
            const files = await invoke<{ mono_path?: string; dual_path?: string }>("check_pdf_translation_files", {
                pdfPath: article.book_path
            });

            // Map keys from backend snake_case to what we want
            // Actually Tauri might map return values to camelCase automatically? 
            // Let's assume snake_case for now based on previous experience or inspect config.
            // Wait, previous issue was sending args. Returning structs usually respects serde serialization.
            // If backend fields are pub, they are serialized as is unless #[serde(rename_all="camelCase")]
            // The TranslationFiles struct has no rename attribute, so it sends snake_case.

            setAvailableVersions({
                mono: files.mono_path,
                dual: files.dual_path
            });
        } catch (e) {
            console.error("Failed to check translation files:", e);
        }
    };

    // 获取当前显示的 PDF 路径
    const getCurrentPdfPath = () => {
        if (!isPdf) return getBookUrl();

        switch (pdfVersion) {
            case "mono":
                if (availableVersions.mono) {
                    const filename = availableVersions.mono.split(/[/\\]/).pop();
                    return `http://127.0.0.1:19420/book/${encodeURIComponent(filename || "")}`;
                }
                break;
            case "dual":
                if (availableVersions.dual) {
                    const filename = availableVersions.dual.split(/[/\\]/).pop();
                    return `http://127.0.0.1:19420/book/${encodeURIComponent(filename || "")}`;
                }
                break;
        }
        return getBookUrl();
    };

    // 导出文件
    const handleDownload = async (version: "original" | "mono" | "dual") => {
        try {
            let srcPath = article.book_path;
            let defaultName = article.title;

            if (version === "mono" && availableVersions.mono) {
                srcPath = availableVersions.mono;
                defaultName = `${article.title}_译文`;
            } else if (version === "dual" && availableVersions.dual) {
                srcPath = availableVersions.dual;
                defaultName = `${article.title}_双语`;
            } else if (version !== "original") {
                return; // 文件不存在
            }

            if (!srcPath) return;

            // 使用 save 对话框选择保存位置
            const destPath = await save({
                defaultPath: `${defaultName}.pdf`,
                filters: [{
                    name: 'PDF Document',
                    extensions: ['pdf']
                }]
            });

            if (destPath) {
                await invoke("export_file_cmd", {
                    srcPath: srcPath,
                    destPath: destPath
                });
                alert(t("common.exportSuccess", "导出成功！"));
            }

        } catch (e) {
            console.error(e);
        }
    };

    // Simpler download implementation using HTML anchor for now if it's served via localhost,
    // OR use the tauri dialog if I can specific imports.
    // Let's stick to the Implementation Plan: "Add a View Selector... Add a Download Menu"

    // ... (rest of the file)


    // 处理文本选择
    const handleTextSelect = (text: string) => {
        setSelectedText(text);
        setShowAssistant(true);
    };

    // 获取书籍文件 URL
    const getBookUrl = () => {
        if (!article.book_path) return "";

        // 如果已经是 HTTP URL，直接返回
        if (article.book_path.startsWith("http")) return article.book_path;

        // 对于本地文件，使用本地资源服务器提供
        const filename = article.book_path.split(/[/\\]/).pop();
        if (filename) {
            return `http://127.0.0.1:19420/book/${encodeURIComponent(filename)}`;
        }

        return article.book_path;
    };

    // PDF全文翻译处理
    const handlePdfTranslate = async () => {
        if (!article.book_path || isTranslating) return;

        logger.info("pdf", `[UI] translate requested for ${article.book_path}`);

        // 监听 Rust 转发的逐页翻译进度
        let lastProgressAt = Date.now();
        const unlistenProgress = await listen<{ current?: number; total?: number; percent?: number }>(
            "pdf-translation-progress",
            (event) => {
                const { current, total, percent } = event.payload ?? {};
                const gap = Date.now() - lastProgressAt;
                lastProgressAt = Date.now();
                logger.info(
                    "pdf",
                    `[UI] progress event: ${current ?? "?"}/${total ?? "?"} (${percent ?? "?"}%), +${(gap / 1000).toFixed(1)}s since last`,
                );
                if (typeof percent === "number") {
                    setTranslateProgress(Math.max(0, Math.min(100, percent)));
                }
            }
        );

        try {
            setTranslateProgress(0);
            setIsTranslating(true);

            // 获取配置
            const config = await invoke<{
                target_language?: string;
                active_model_id?: string;
                model_configs?: Array<{ id: string; api_provider: string; api_key: string; model: string; base_url?: string }>;
            }>("get_config");

            console.log("[PDF Translate] Config loaded:", config);

            const activeModel = config.model_configs?.find(m => m.id === config.active_model_id);
            if (!activeModel) {
                console.error("[PDF Translate] No active model found. Active ID:", config.active_model_id);
                logger.error("pdf", `[UI] no active model (active_model_id=${config.active_model_id})`);
                throw new Error(t("pdfTranslate.noActiveModel", "请先在设置中配置并激活一个AI模型"));
            }

            const targetLang = config.target_language || "zh";
            const sourceLang = "auto";

            console.log("[PDF Translate] Starting with:", {
                provider: activeModel.api_provider,
                model: activeModel.model,
                targetLang,
            });
            logger.info(
                "pdf",
                `[UI] invoking translate_pdf_document: provider=${activeModel.api_provider}, model=${activeModel.model}, ${sourceLang} -> ${targetLang}`,
            );
            const startedAt = Date.now();

            const result = await invoke<{
                success: boolean;
                mono_pdf: string;
                dual_pdf: string;
                original_pdf: string;
            }>("translate_pdf_document", {
                pdfPath: article.book_path,
                langIn: sourceLang,
                langOut: targetLang,
                provider: activeModel.api_provider,
                apiKey: activeModel.api_key,
                model: activeModel.model,
                baseUrl: activeModel.base_url,
            });

            logger.info(
                "pdf",
                `[UI] translate_pdf_document returned success=${result.success} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
            );

            if (result.success) {
                // 更新可用版本
                setAvailableVersions({
                    mono: result.mono_pdf,
                    dual: result.dual_pdf,
                });

                // 提示并询问是否切换查看
                if (confirm(t("pdfTranslate.successSwitch", "翻译完成！是否切换到双语对照模式？"))) {
                    setPdfVersion("dual");
                }
            }
        } catch (error) {
            console.error("[PDF Translate] Error:", error);
            logger.error("pdf", `[UI] translation failed: ${String(error)}`);
            alert(t("pdfTranslate.error", "翻译失败: {{error}}", { error: String(error) }));
        } finally {
            unlistenProgress();
            setIsTranslating(false);
            setTranslateProgress(null);
        }
    };

    const mainContent = (
        <div className="flex-1 flex flex-col min-w-0">
                {/* 顶部工具栏 */}
                <div className="flex items-center justify-between p-3 border-b border-border bg-card/50 backdrop-blur-sm">
                    <div className="flex items-center gap-3">
                        {onBack && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={onBack}
                                aria-label={backToMaterialsLabel}
                                title={backToMaterialsLabel}
                            >
                                <ChevronLeft size={18} />
                            </Button>
                        )}
                        <div className="flex items-center gap-2">
                            <BookOpen size={18} className="text-purple-500" />
                            <h1 className="text-lg font-semibold truncate max-w-[300px]">
                                {article.title || t("articleReader.untitled")}
                            </h1>
                            <span className="text-xs px-2 py-0.5 bg-purple-500/10 text-purple-500 rounded-full uppercase">
                                {article.book_type}
                            </span>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        {isPdf && (
                            <>
                                {/* 版本切换器 */}
                                <div className="flex bg-muted/50 rounded-lg p-0.5 mr-2">
                                    <button
                                        onClick={() => setPdfVersion("original")}
                                        className={`px-3 py-1 text-xs rounded-md transition-all flex items-center gap-1.5 ${pdfVersion === "original"
                                            ? "bg-background text-foreground shadow-sm font-medium"
                                            : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                                            }`}
                                    >
                                        <File size={14} /> 原文
                                    </button>

                                    {availableVersions.mono && (
                                        <button
                                            onClick={() => setPdfVersion("mono")}
                                            className={`px-3 py-1 text-xs rounded-md transition-all flex items-center gap-1.5 ${pdfVersion === "mono"
                                                ? "bg-background text-foreground shadow-sm font-medium"
                                                : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                                                }`}
                                        >
                                            <FileText size={14} /> 译文
                                        </button>
                                    )}

                                    {availableVersions.mono && (
                                        <button
                                            onClick={() => setPdfVersion("split")}
                                            className={`px-3 py-1 text-xs rounded-md transition-all flex items-center gap-1.5 ${pdfVersion === "split"
                                                ? "bg-background text-foreground shadow-sm font-medium"
                                                : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                                                }`}
                                        >
                                            <Columns size={14} /> 对照
                                        </button>
                                    )}

                                    {availableVersions.dual && (
                                        <button
                                            onClick={() => setPdfVersion("dual")}
                                            className={`px-3 py-1 text-xs rounded-md transition-all flex items-center gap-1.5 ${pdfVersion === "dual"
                                                ? "bg-background text-foreground shadow-sm font-medium"
                                                : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                                                }`}
                                        >
                                            <Split size={14} /> 双语文件
                                        </button>
                                    )}
                                </div>

                                {/* PDF 全文翻译按钮 */}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handlePdfTranslate}
                                    disabled={isTranslating}
                                    title={t("pdfTranslate.button", "翻译全文")}
                                    className="flex items-center gap-1.5"
                                >
                                    {isTranslating ? (
                                        <Loader2 size={16} className="animate-spin" />
                                    ) : (
                                        <Languages size={16} />
                                    )}
                                    <span className="hidden sm:inline">
                                        {isTranslating
                                            ? (translateProgress !== null
                                                ? t("pdfTranslate.translatingPercent", "翻译中 {{percent}}%", { percent: translateProgress })
                                                : t("pdfTranslate.translating", "翻译中..."))
                                            : t("pdfTranslate.button", "翻译全文")}
                                    </span>
                                </Button>

                                {/* 下载按钮 */}
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant="ghost" size="sm" title="下载">
                                            <Download size={18} />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        <DropdownMenuItem onClick={() => handleDownload("original")}>
                                            <File className="mr-2 h-4 w-4" />
                                            下载原文 PDF
                                        </DropdownMenuItem>
                                        {availableVersions.mono && (
                                            <DropdownMenuItem onClick={() => handleDownload("mono")}>
                                                <FileText className="mr-2 h-4 w-4" />
                                                下载纯译文 PDF
                                            </DropdownMenuItem>
                                        )}
                                        {availableVersions.dual && (
                                            <DropdownMenuItem onClick={() => handleDownload("dual")}>
                                                <Split className="mr-2 h-4 w-4" />
                                                下载双语对照 PDF
                                            </DropdownMenuItem>
                                        )}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </>
                        )}

                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowAssistant(!showAssistant)}
                            title={showAssistant ? "隐藏助手" : "显示助手"}
                            className="h-8 w-8 p-0"
                        >
                            {showAssistant ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
                        </Button>
                    </div>
                </div>

                <div className="flex-1 overflow-hidden">
                    {isEpub && (
                        <EpubReader
                            bookPath={getBookUrl()}
                            title={article.title}
                            onTextSelect={handleTextSelect}
                        />
                    )}
                    {isTxt && (
                        <TxtReader
                            content={article.content}
                            title={article.title}
                            onTextSelect={handleTextSelect}
                        />
                    )}
                    {isPdf && (
                        <>
                            {pdfVersion === "split" ? (
                                <div className="flex h-full w-full">
                                    <div className="flex-1 border-r border-border min-w-0">
                                        <PdfReader
                                            bookPath={getBookUrl()}
                                            title="原文"
                                            onTextSelect={handleTextSelect}
                                        />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <PdfReader
                                            bookPath={availableVersions.mono ? `http://127.0.0.1:19420/book/${encodeURIComponent(availableVersions.mono.split(/[/\\]/).pop() || "")}` : ""}
                                            title="译文"
                                            onTextSelect={handleTextSelect}
                                        />
                                    </div>
                                </div>
                            ) : (
                                <PdfReader
                                    bookPath={getCurrentPdfPath()}
                                    title={article.title}
                                    onTextSelect={handleTextSelect}
                                />
                            )}
                        </>
                    )}
                </div>
        </div>
    );

    return (
        <AssistantSidebarShell
            storageKey={assistantModeStorageKey}
            showAssistant={showAssistant}
            activeTab={activeTab}
            onTabChange={(value) => setActiveTab(value as "mind_map" | "chat")}
            shellTestId="book-reader-shell"
            mainPaneTestId="book-reader-main-pane"
            assistantPaneTestId="book-reader-assistant-pane"
            defaultTab="mind_map"
            tabs={[
                {
                    value: "mind_map",
                    label: t("articleReader.mindMap", "思维导图"),
                    content: ({ panelMode }: { panelMode: AssistantPanelMode }) => (
                        <ArticleMindMapPanel
                            article={article}
                            targetLanguage={targetLanguage}
                            panelMode={panelMode}
                        />
                    ),
                },
                {
                    value: "chat",
                    label: t("articleReader.chat", "对话"),
                    content: (
                        <ArticleChatAssistant
                            articleId={article.id}
                            articleTitle={article.title}
                            targetLanguage={targetLanguage}
                            selectedText={selectedText}
                        />
                    ),
                },
            ]}
            headerContent={({ panelMode }) =>
                panelMode === "full" && onBack ? (
                    <div className="flex items-center gap-3 px-4 py-3 min-w-0">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={onBack}
                            aria-label={backToMaterialsLabel}
                            title={backToMaterialsLabel}
                            className="shrink-0 gap-1.5"
                        >
                            <ChevronLeft size={16} />
                            <span>{t("common.back", "返回")}</span>
                        </Button>
                        <div className="min-w-0">
                            <div className="text-sm font-medium truncate">
                                {article.title || t("articleReader.untitled")}
                            </div>
                            <div className="text-xs text-muted-foreground uppercase">
                                {article.book_type}
                            </div>
                        </div>
                    </div>
                ) : null
            }
            mainContent={mainContent}
        />
    );
}
