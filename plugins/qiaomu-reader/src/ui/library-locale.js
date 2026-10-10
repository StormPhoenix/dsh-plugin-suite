/** Flatten nested UI messages into the locale registry's dotted string keys. */
export function flattenMessages(messages, prefix = '') {
  return Object.fromEntries(Object.entries(messages).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [[path, value]] : Object.entries(flattenMessages(value, path));
  }));
}

/** Shared client catalogue messages. */
export const LIBRARY_MESSAGES = {
  "zh": {
    "reader": { "zoom": "缩放", "zoomIn": "放大（Ctrl＋滚轮向上）", "zoomOut": "缩小（Ctrl＋滚轮向下）" },
    "catalog": {
      "tags": {
        "filter": "标签筛选", "search": "搜索已有标签", "untagged": "无标签", "match": "匹配方式", "any": "任一标签", "all": "全部标签", "clearTags": "清空标签筛选", "done": "完成", "close": "关闭", "noneFound": "没有匹配的标签", "moreTags": "另有 {count} 个标签", "edit": "编辑标签", "bulkAdd": "批量添加标签", "bulkRemove": "批量移除标签", "bookCount": "将修改 {count} 本书", "cancel": "取消", "save": "保存", "saving": "保存中…", "failed": "标签操作失败，请重试", "cacheWarning": "标签已保存到书库，但浏览器缓存更新失败；离线分类可能不是最新状态", "offline": "离线时无法编辑标签；连接书库后可添加或移除标签", "nameControls": "标签名称不能包含控制字符。", "nameRequired": "请输入标签名称。", "nameLong": "标签名称最多 40 个字符。", "activeFilters": "当前筛选", "removeFilter": "移除标签筛选 {name}", "clearAll": "清空全部筛选", "select": "选择书籍", "selected": "已选 {count} 本", "selectResults": "选择全部 {count} 本筛选结果", "selectBook": "选择《{title}》", "input": "输入标签，按 Enter 添加", "removeInput": "搜索要移除的标签", "existing": "已有标签", "createHint": "按 Enter 创建「{name}」", "enterFirst": "请按 Enter 添加输入的标签，或清空输入", "addTitle": "给 {count} 本书添加标签", "removeTitle": "从 {count} 本书移除标签", "keepExisting": "原有标签将保留", "removeHint": "仅移除所选书籍的标签，书籍与阅读数据不受影响", "confirmAdd": "确认添加", "confirmRemove": "确认移除", "clearSelection": "清空选择", "exitSelection": "退出选择", "chooseBooks": "请选择需要整理的书籍", "removeSelected": "取消选择标签 {name}"
      },
      "queue": {
        "title": "导入队列", "add": "追加文件", "running": "导入中", "stopping": "当前文件完成后停止", "paused": "已停止", "idle": "处理完成",
        "summary": "已处理 {done}/{total} · 已入库 {host} · 仅浏览器缓存 {browser} · 失败 {failed} · 等待 {waiting} · 已取消 {cancelled}",
        "progress": "导入进度", "current": "当前文件：{name}", "stop": "停止后续导入", "resume": "继续导入", "retryAll": "重试全部失败", "clear": "清除已处理记录",
        "waiting": "等待", "processing": "处理中", "host": "已入库", "browser": "仅浏览器缓存", "failed": "失败", "cancelled": "已取消", "existing": "已更新已有书籍", "attempts": "尝试 {count} 次",
        "cancel": "取消此项", "retry": "重试", "saveHost": "重试保存到书库", "show": "查看导入队列",
        "lifetime": "切换页面后继续导入；刷新或重启不恢复队列。清除记录不会删除书籍，但会释放重试所需文件。",
        "filtered": "新导入的书可能被当前筛选隐藏"
      },
      "deleteConfirm": "从书库删除《{title}》？\n只删除书库副本，不影响原始文件。",
      "finished": "已读完",
      "justStarted": "刚开始",
      "unread": "未读",
      "openBook": "打开《{title}》",
      "unknownAuthor": "未知作者",
      "opening": "打开中…",
      "highlightsCount": "{count} 条划线",
      "bookHighlights": "查看《{title}》的 {count} 条划线",
      "bookActions": "《{title}》的更多操作",
      "more": "更多操作",
      "notes": "阅读笔记",
      "highlights": "查看划线",
      "delete": "从书库删除",
      "pickerError": "当前环境无法打开文件选择器",
      "importing": "导入中…",
      "import": "导入书籍",
      "categories": "书库分类",
      "filter": "阅读状态",
      "formats": "文件格式",
      "allFormats": "全部格式",
      "bookCount": "{count} 本书",
      "searchPlaceholder": "搜索书名或作者",
      "search": "搜索书库",
      "refresh": "刷新书库",
      "fullscreen": "全屏",
      "close": "关闭阅读器",
      "error": "书库操作失败",
      "retry": "重试",
      "continue": "继续阅读",
      "collection": "我的书目",
      "sort": "排序方式",
      "recent": "最近阅读",
      "added": "加入时间",
      "title": "书名",
      "loading": "书库正在加载…",
      "noResults": "没有符合条件的书",
      "empty": "从第一本书开始",
      "noResultsHelp": "换个关键词，或清空筛选。",
      "emptyHelp": "导入 EPUB、PDF 或 TXT，开始阅读。",
      "clear": "清空筛选",
      "titleAuthor": "书名 / 作者",
      "format": "格式",
      "progress": "阅读进度",
      "annotations": "划线",
      "all": "全部书籍",
      "reading": "正在阅读",
      "highlighted": "有划线"
    }
  },
  "en": {
    "reader": { "zoom": "Zoom", "zoomIn": "Zoom in (Ctrl + wheel up)", "zoomOut": "Zoom out (Ctrl + wheel down)" },
    "catalog": {
      "tags": {
        "filter": "Tag filter", "search": "Search existing tags", "untagged": "No tags", "match": "Match", "any": "Any tag", "all": "All tags", "clearTags": "Clear tag filter", "done": "Done", "close": "Close", "noneFound": "No matching tags", "moreTags": "{count} more tags", "edit": "Edit tags", "bulkAdd": "Add tags in bulk", "bulkRemove": "Remove tags in bulk", "bookCount": "Changing {count} books", "cancel": "Cancel", "save": "Save", "saving": "Saving…", "failed": "Tag operation failed. Please retry.", "cacheWarning": "Tags were saved to the library, but the browser cache could not be updated. Offline tags may be outdated.", "offline": "Tag editing is unavailable offline. Connect to add or remove tags.", "nameControls": "Tag names cannot contain control characters.", "nameRequired": "Enter a tag name.", "nameLong": "Tag names can contain up to 40 characters.", "activeFilters": "Active filters", "removeFilter": "Remove tag filter {name}", "clearAll": "Clear all filters", "select": "Select books", "selected": "{count} selected", "selectResults": "Select all {count} matching books", "selectBook": "Select “{title}”", "input": "Enter a tag and press Enter", "removeInput": "Search tags to remove", "existing": "Existing tags", "createHint": "Press Enter to create “{name}”", "enterFirst": "Press Enter to add the typed tag, or clear the input.", "addTitle": "Add tags to {count} books", "removeTitle": "Remove tags from {count} books", "keepExisting": "Existing tags will be kept", "removeHint": "Only tags on selected books are removed. Books and reading data are kept.", "confirmAdd": "Confirm add", "confirmRemove": "Confirm remove", "clearSelection": "Clear selection", "exitSelection": "Exit selection", "chooseBooks": "Select books to organize", "removeSelected": "Deselect tag {name}"
      },
      "queue": {
        "title": "Import queue", "add": "Add files", "running": "Importing", "stopping": "Stopping after current file", "paused": "Stopped", "idle": "Finished",
        "summary": "Processed {done}/{total} · Library {host} · Browser only {browser} · Failed {failed} · Waiting {waiting} · Cancelled {cancelled}",
        "progress": "Import progress", "current": "Current file: {name}", "stop": "Stop after current", "resume": "Continue", "retryAll": "Retry all failed", "clear": "Clear processed records",
        "waiting": "Waiting", "processing": "Processing", "host": "Saved to library", "browser": "Browser cache only", "failed": "Failed", "cancelled": "Cancelled", "existing": "Updated existing book", "attempts": "{count} attempts",
        "cancel": "Cancel item", "retry": "Retry", "saveHost": "Retry saving to library", "show": "Show import queue",
        "lifetime": "Imports continue across page switches, but not reloads or restarts. Clearing records keeps books but releases files needed for retries.",
        "filtered": "Current filters may hide newly imported books"
      },
      "all": "All books",
      "reading": "Reading",
      "finished": "Finished",
      "highlighted": "Highlighted",
      "deleteConfirm": "Remove “{title}” from your library?\nOnly the library copy will be removed; the original file is kept.",
      "justStarted": "Just started",
      "unread": "Unread",
      "opening": "Opening…",
      "openBook": "Open “{title}”",
      "unknownAuthor": "Unknown author",
      "highlightsCount": "{count} highlights",
      "bookHighlights": "View {count} highlights in “{title}”",
      "bookActions": "More actions for “{title}”",
      "more": "More actions",
      "notes": "Reading notes",
      "highlights": "View highlights",
      "delete": "Remove from library",
      "pickerError": "Unable to open the file picker",
      "categories": "Library categories",
      "filter": "Reading status",
      "formats": "File format",
      "allFormats": "All formats",
      "importing": "Importing…",
      "import": "Import books",
      "bookCount": "{count} books",
      "searchPlaceholder": "Search title or author",
      "search": "Search library",
      "refresh": "Refresh library",
      "fullscreen": "Full screen",
      "close": "Close reader",
      "error": "Library operation failed",
      "retry": "Retry",
      "continue": "Continue reading",
      "collection": "My books",
      "sort": "Sort books",
      "recent": "Recently read",
      "added": "Date added",
      "title": "Title",
      "loading": "Loading your library…",
      "noResults": "No matching books",
      "empty": "Start with your first book",
      "noResultsHelp": "Try another keyword or clear the filters.",
      "emptyHelp": "Import an EPUB, PDF or TXT to start reading.",
      "clear": "Clear filters",
      "titleAuthor": "Title / Author",
      "format": "Format",
      "progress": "Reading progress",
      "annotations": "Highlights"
    }
  }
};
