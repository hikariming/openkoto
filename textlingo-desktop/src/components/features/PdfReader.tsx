/**
 * PDF 阅读器组件
 * 使用 react-pdf 库渲染 PDF 文件
 * 支持清晰显示、文本选择联动、翻页、进度跳转、缩放
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { Document, Page } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
// 使用统一的 PDF.js worker 配置
import "../../lib/pdfConfig";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../ui/button";
import {
    ChevronLeft,
    ChevronRight,
    Loader2,
    AlertCircle,
    Maximize2,
    Minimize2,
    RotateCcw,
    Minus,
    Plus,
    Bookmark as BookmarkIcon,
    BookmarkPlus,
} from "lucide-react";
import { BookmarkSidebar } from "./BookmarkSidebar";
import { Bookmark } from "../../types";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Label } from "../ui/label";



interface PdfReaderProps {
    /** PDF 文件的 URL */
    bookPath: string;
    /** 书籍标题 */
    title?: string;
    /** 选中文本时的回调 */
    onTextSelect?: (text: string) => void;
    /** 返回按钮回调 */
    onBack?: () => void;
}

export function PdfReader({
    bookPath,
    title,
    onTextSelect,
    onBack,
}: PdfReaderProps) {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const lastWheelNavigationAtRef = useRef(0);
    const lastWheelDirectionRef = useRef<-1 | 0 | 1>(0);

    // PDF 状态
    const [numPages, setNumPages] = useState<number>(0);
    const [pageNumber, setPageNumber] = useState<number>(1);

    // 加载状态
    const [isLoading, setIsLoading] = useState(true);
    // 错误信息
    const [error, setError] = useState<string | null>(null);
    // 全屏模式
    const [isFullscreen, setIsFullscreen] = useState(false);
    // 缩放比例 (百分比)
    const [scale, setScale] = useState(100);

    // 书签相关状态
    const [isBookmarkSidebarOpen, setIsBookmarkSidebarOpen] = useState(false);
    const [isAddBookmarkDialogOpen, setIsAddBookmarkDialogOpen] = useState(false);
    const [bookmarkTitle, setBookmarkTitle] = useState("");
    const [bookmarkNote, setBookmarkNote] = useState("");
    const [bookmarkSelectedText, setBookmarkSelectedText] = useState("");

    // PDF 加载成功回调
    const onDocumentLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
        setNumPages(numPages);
        setIsLoading(false);
        setError(null);

        // 恢复上次阅读进度
        if (bookPath) {
            const savedPage = localStorage.getItem(`pdf-page-${bookPath}`);
            if (savedPage) {
                const parsed = parseInt(savedPage);
                if (parsed > 0 && parsed <= numPages) {
                    setPageNumber(parsed);
                }
            }
        }
    }, [bookPath]);

    // PDF 加载失败回调
    const onDocumentLoadError = useCallback((err: Error) => {
        console.error("PDF load error:", err);
        setIsLoading(false);
        setError(t("pdfReader.loadError", "PDF加载失败"));
    }, [t]);

    // 处理文本选择
    const handleTextSelection = useCallback(() => {
        const selection = window.getSelection();
        if (selection) {
            const text = selection.toString().trim();
            if (text.length > 0) {
                onTextSelect?.(text);
            }
        }
    }, [onTextSelect]);

    // 翻页
    const goToPrevPage = useCallback(() => {
        setPageNumber((prev) => Math.max(prev - 1, 1));
    }, []);

    const goToNextPage = useCallback(() => {
        setPageNumber((prev) => Math.min(prev + 1, numPages));
    }, [numPages]);

    const handleWheelNavigation = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
        if (numPages <= 1 || Math.abs(e.deltaY) < 8) {
            return;
        }

        const scrollContainer = e.currentTarget;
        const edgeTolerance = 2;
        const canScrollVertically = scrollContainer.scrollHeight > scrollContainer.clientHeight + edgeTolerance;
        const isAtTop = scrollContainer.scrollTop <= edgeTolerance;
        const isAtBottom = scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - edgeTolerance;
        const isScrollingWithinPage =
            canScrollVertically &&
            ((e.deltaY > 0 && !isAtBottom) || (e.deltaY < 0 && !isAtTop));

        if (isScrollingWithinPage) {
            return;
        }

        const direction = e.deltaY > 0 ? 1 : -1;
        const now = Date.now();
        if (now - lastWheelNavigationAtRef.current < 250 && lastWheelDirectionRef.current === direction) {
            e.preventDefault();
            return;
        }

        if (e.deltaY > 0 && pageNumber < numPages) {
            e.preventDefault();
            lastWheelNavigationAtRef.current = now;
            lastWheelDirectionRef.current = direction;
            goToNextPage();
            return;
        }

        if (e.deltaY < 0 && pageNumber > 1) {
            e.preventDefault();
            lastWheelNavigationAtRef.current = now;
            lastWheelDirectionRef.current = direction;
            goToPrevPage();
        }
    }, [goToNextPage, goToPrevPage, numPages, pageNumber]);

    useEffect(() => {
        if (!contentRef.current) {
            return;
        }

        contentRef.current.scrollTop = 0;
    }, [pageNumber]);

    // 进度条变化
    const handleProgressChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const newPage = parseInt(e.target.value);
        setPageNumber(newPage);
    }, []);

    // 缩放控制
    const zoomIn = useCallback(() => {
        setScale((prev) => Math.min(prev + 20, 300));
    }, []);

    const zoomOut = useCallback(() => {
        setScale((prev) => Math.max(prev - 20, 50));
    }, []);

    // 全屏切换
    const toggleFullscreen = useCallback(() => {
        if (!document.fullscreenElement) {
            containerRef.current?.requestFullscreen();
            setIsFullscreen(true);
        } else {
            document.exitFullscreen();
            setIsFullscreen(false);
        }
    }, []);

    // 刷新 PDF
    const handleRefresh = useCallback(() => {
        setIsLoading(true);
        setError(null);
        // 强制重新加载 - 通过临时清空再恢复来触发
        setPageNumber(1);
    }, []);

    // 监听全屏状态变化
    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };

        document.addEventListener("fullscreenchange", handleFullscreenChange);
        return () => {
            document.removeEventListener("fullscreenchange", handleFullscreenChange);
        };
    }, []);

    // 保存阅读进度
    useEffect(() => {
        if (bookPath && pageNumber > 0) {
            localStorage.setItem(`pdf-page-${bookPath}`, pageNumber.toString());
        }
    }, [bookPath, pageNumber]);

    // 键盘快捷键
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement) return;

            switch (e.key) {
                case "ArrowLeft":
                case "ArrowUp":
                    goToPrevPage();
                    break;
                case "ArrowRight":
                case "ArrowDown":
                case " ":
                    goToNextPage();
                    break;
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [goToPrevPage, goToNextPage]);

    // 计算页面宽度
    const getPageWidth = useCallback(() => {
        if (contentRef.current) {
            const containerWidth = contentRef.current.clientWidth - 48; // 减去 padding
            return Math.min(containerWidth, 800) * (scale / 100);
        }
        return 600 * (scale / 100);
    }, [scale]);

    // 打开添加书签对话框
    const handleOpenAddBookmark = () => {
        // 获取当前选中的文本
        const selection = window.getSelection();
        const currentSelected = selection ? selection.toString().trim() : "";

        setBookmarkTitle(currentSelected || `第 ${pageNumber} 页`);
        setBookmarkNote("");
        setBookmarkSelectedText(currentSelected);
        setIsAddBookmarkDialogOpen(true);
    };

    // 添加书签
    const handleAddBookmark = async () => {
        try {
            await invoke("add_bookmark_cmd", {
                bookPath,
                bookType: "pdf",
                title: bookmarkTitle,
                note: bookmarkNote || null,
                selectedText: bookmarkSelectedText || null,
                pageNumber: pageNumber, // PDF页码从1开始
                epubCfi: null,
                color: null,
            });
            setIsAddBookmarkDialogOpen(false);
            setBookmarkSelectedText("");
        } catch (error) {
            console.error("Failed to add bookmark:", error);
        }
    };

    // 跳转到书签位置
    const handleJumpToBookmark = (bookmark: Bookmark) => {
        if (bookmark.page_number) {
            setPageNumber(bookmark.page_number);
        }
        setIsBookmarkSidebarOpen(false);
    };

    return (
        <div
            ref={containerRef}
            className="h-full flex flex-col bg-background"
        >
            {/* 工具栏 */}
            <div className="flex items-center justify-between p-3 border-b border-border bg-card/50 backdrop-blur-sm gap-4 shrink-0">
                <div className="flex items-center gap-2 shrink-0">
                    {onBack && (
                        <Button variant="ghost" size="sm" onClick={onBack}>
                            <ChevronLeft size={18} />
                        </Button>
                    )}
                    <h2 className="text-sm font-medium truncate max-w-[150px]">
                        {title || t("pdfReader.untitled", "未命名PDF")}
                    </h2>
                </div>

                {/* 进度条滑块 */}
                {numPages > 0 && (
                    <div className="flex-1 max-w-md flex items-center gap-2 mx-2">
                        <span className="text-xs text-muted-foreground w-12 text-right">
                            {pageNumber}/{numPages}
                        </span>
                        <input
                            type="range"
                            min="1"
                            max={numPages}
                            value={pageNumber}
                            onChange={handleProgressChange}
                            className="flex-1 h-1.5 bg-muted rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
                            style={{
                                backgroundSize: `${((pageNumber - 1) / (numPages - 1)) * 100}% 100%`,
                                backgroundImage: `linear-gradient(var(--primary), var(--primary))`,
                                backgroundRepeat: 'no-repeat'
                            }}
                        />
                    </div>
                )}

                <div className="flex items-center gap-2 shrink-0">
                    {/* 书签按钮 */}
                    {bookPath && (
                        <div className="flex items-center gap-1">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={handleOpenAddBookmark}
                                className="h-8 px-2"
                                title="添加书签"
                            >
                                <BookmarkPlus size={16} />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setIsBookmarkSidebarOpen(true)}
                                className="h-8 px-2"
                                title="书签列表"
                            >
                                <BookmarkIcon size={16} />
                            </Button>
                        </div>
                    )}

                    {/* 缩放控制 */}
                    <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-1 border border-border">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={zoomOut}
                            className="h-7 w-7 p-0"
                            title={t("pdfReader.zoomOut", "缩小")}
                        >
                            <Minus size={14} />
                        </Button>
                        <span className="text-xs text-muted-foreground w-10 text-center">
                            {scale}%
                        </span>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={zoomIn}
                            className="h-7 w-7 p-0"
                            title={t("pdfReader.zoomIn", "放大")}
                        >
                            <Plus size={14} />
                        </Button>
                    </div>

                    {/* 刷新按钮 */}
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleRefresh}
                        disabled={isLoading}
                        className="h-8 w-8 p-0"
                        title={t("pdfReader.refresh", "刷新")}
                    >
                        <RotateCcw size={16} />
                    </Button>

                    {/* 全屏按钮 */}
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={toggleFullscreen}
                        className="h-8 w-8 p-0"
                        title={isFullscreen
                            ? t("pdfReader.exitFullscreen", "退出全屏")
                            : t("pdfReader.fullscreen", "全屏")
                        }
                    >
                        {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                    </Button>
                </div>
            </div>

            {/* PDF 内容区域 */}
            <div
                ref={contentRef}
                className="flex-1 relative overflow-auto overscroll-y-contain flex flex-col items-center [-webkit-overflow-scrolling:touch]"
                onMouseUp={handleTextSelection}
                onWheel={handleWheelNavigation}
            >
                {/* 翻页按钮 - 左 */}
                <button
                    onClick={goToPrevPage}
                    disabled={pageNumber <= 1}
                    className="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-background/80 border border-border shadow-sm hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    title={t("pdfReader.prevPage", "上一页")}
                >
                    <ChevronLeft size={20} />
                </button>

                {/* 加载状态 */}
                {isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
                        <div className="flex flex-col items-center gap-3 text-muted-foreground">
                            <Loader2 size={32} className="animate-spin" />
                            <span>{t("pdfReader.loading", "加载中...")}</span>
                        </div>
                    </div>
                )}

                {/* 错误状态 */}
                {error && (
                    <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
                        <div className="flex flex-col items-center gap-3 text-destructive">
                            <AlertCircle size={32} />
                            <span>{error}</span>
                            <Button variant="outline" size="sm" onClick={handleRefresh}>
                                {t("pdfReader.retry", "重试")}
                            </Button>
                        </div>
                    </div>
                )}

                {/* PDF 渲染 */}
                <div className="py-6">
                    <Document
                        file={bookPath}
                        onLoadSuccess={onDocumentLoadSuccess}
                        onLoadError={onDocumentLoadError}
                        loading={null}
                        className="flex flex-col items-center"
                    >
                        <Page
                            pageNumber={pageNumber}
                            width={getPageWidth()}
                            renderTextLayer={true}
                            renderAnnotationLayer={true}
                            className="shadow-lg"
                        />
                    </Document>
                </div>

                {/* 翻页按钮 - 右 */}
                <button
                    onClick={goToNextPage}
                    disabled={pageNumber >= numPages}
                    className="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-background/80 border border-border shadow-sm hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    title={t("pdfReader.nextPage", "下一页")}
                >
                    <ChevronRight size={20} />
                </button>
            </div>

            {/* 书签侧边栏 */}
            {bookPath && (
                <BookmarkSidebar
                    bookPath={bookPath}
                    onJumpToBookmark={handleJumpToBookmark}
                    isOpen={isBookmarkSidebarOpen}
                    onClose={() => setIsBookmarkSidebarOpen(false)}
                />
            )}

            {/* 添加书签对话框 */}
            <Dialog open={isAddBookmarkDialogOpen} onOpenChange={setIsAddBookmarkDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>添加书签</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        {bookmarkSelectedText && (
                            <div className="space-y-2">
                                <Label>选中的文字</Label>
                                <div className="p-3 bg-muted/50 rounded-lg text-sm max-h-24 overflow-y-auto border border-border">
                                    "{bookmarkSelectedText}"
                                </div>
                            </div>
                        )}
                        <div className="space-y-2">
                            <Label htmlFor="bookmark-title">标题</Label>
                            <Input
                                id="bookmark-title"
                                value={bookmarkTitle}
                                onChange={(e) => setBookmarkTitle(e.target.value)}
                                placeholder="书签标题"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="bookmark-note">笔记（可选）</Label>
                            <Textarea
                                id="bookmark-note"
                                value={bookmarkNote}
                                onChange={(e) => setBookmarkNote(e.target.value)}
                                placeholder="添加笔记..."
                                rows={3}
                            />
                        </div>
                        <div className="text-sm text-muted-foreground">
                            将在第 {pageNumber} 页添加书签
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsAddBookmarkDialogOpen(false)}>
                            取消
                        </Button>
                        <Button onClick={handleAddBookmark}>添加</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
