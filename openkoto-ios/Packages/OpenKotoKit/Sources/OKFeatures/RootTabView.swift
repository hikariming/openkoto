#if os(iOS)
import SwiftUI
import OKAccount
import OKCommerce
import OKDesignSystem
import OKLocalization

/// 根导航：书库 / 生词本 / 设置 三个 tab（设计文档 §6.1）。
/// 负责把 ThemeManager 计算出的 ThemeTokens 注入 Environment。
public struct RootTabView: View {
    @Environment(\.colorScheme) private var systemScheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var themeManager = ThemeManager()
    @State private var store = ContentStore.live()
    @State private var appConfig = AppConfigStore()
    /// OpenKoto 云账号。令牌在 Keychain 里，启动即恢复登录态。
    @State private var account = AccountSession.live()
    @AppStorage("app.interfaceLanguage") private var interfaceLanguage = "system"

    // 首启引导门控。向导状态必须在这里持有（.id 边界之外）：
    // 语言步切界面语言触发子树重建时，步骤进度与已输入内容才能存活。
    @AppStorage(OnboardingGate.completedKey) private var onboardingCompleted = false
    @State private var onboarding = OnboardingState()

    /// ⚠️ 不能叫 `Tab`：那会遮蔽 SwiftUI 自己的 `Tab` builder，
    /// 下面的 `Tab(_:systemImage:value:)` 会被解析成这个枚举而编不过。
    private enum AppSection: Hashable { case library, vocabulary, statistics, settings }

    /// URL 是否落在本 App 的 `Documents/Inbox/` 里（系统为"用 XX 打开"留下的副本）。
    static func isInDocumentsInbox(_ url: URL) -> Bool {
        guard let documents = FileManager.default.urls(
            for: .documentDirectory, in: .userDomainMask).first
        else { return false }
        let inbox = documents.appendingPathComponent("Inbox").standardizedFileURL
        return url.standardizedFileURL.path.hasPrefix(inbox.path + "/")
    }

    // 截图/UI 测试用（-startTab*）：启动直接落在指定页；默认书库。
    // 配合 -app.onboarding.completed YES（NSArgumentDomain）可跳过首启引导。
    /// 截图用（-showPaywall）：启动后直接弹出付费墙，供 App Store 内购审核截屏。
    @State private var showPaywallPreview = false

    @State private var selection: AppSection = {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-startTabSettings") { return .settings }
        if args.contains("-startTabStatistics") { return .statistics }
        if args.contains("-startTabVocabulary") { return .vocabulary }
        return .library
    }()

    public init() {
        // 老用户（升级前已有模型配置）在首帧求值前直接标记完成，避免向导闪现。
        OnboardingGate.migrateIfNeeded()
    }

    private var theme: ThemeTokens {
        themeManager.tokens(for: systemScheme)
    }

    /// 点通知进来的信箱。不放 `@State`：它是全局单例，通知代理在视图存在之前就可能写它。
    private var reminderRouter: ReviewReminderRouter { .shared }

    /// 取走一次「点了复习提醒」，切到生词本。
    private func consumeReminderRoute() {
        if reminderRouter.consumeOpenRequest() { selection = .vocabulary }
    }

    /// 生效的界面 Locale（跟随系统时用当前系统 Locale）。
    private var activeLocale: Locale {
        interfaceLanguage == "system" ? .current : Locale(identifier: interfaceLanguage)
    }

    public var body: some View {
        // 在任何子视图的 L() 求值之前同步应用界面语言覆盖，保证实时切换当帧生效、无残留旧语言。
        // 放在 body 顶部（而非 .onChange）可消除“子树先按旧 bundle 渲染、onChange 才改全局”的求值顺序竞态。
        let _ = L10n.setOverrideLanguage(interfaceLanguage == "system" ? nil : interfaceLanguage)
        Group {
            if onboardingCompleted {
                TabView(selection: $selection) {
                    Tab(L("tab.library"), systemImage: "books.vertical", value: AppSection.library) {
                        LibraryView()
                    }
                    Tab(
                        L("tab.vocabulary"), systemImage: "star.square.on.square",
                        value: AppSection.vocabulary
                    ) {
                        VocabularyView()
                    }
                    Tab(
                        L("tab.statistics"), systemImage: "chart.bar.xaxis",
                        value: AppSection.statistics
                    ) {
                        StatisticsView()
                    }
                    Tab(L("tab.settings"), systemImage: "gearshape", value: AppSection.settings) {
                        SettingsView()
                    }
                }
                // 宽屏自动变侧边栏、窄屏保持底部 tab 栏。
                // 不加 TabViewCustomization：四个 tab 都是必需功能，让用户隐藏是净损失。
                .tabViewStyle(.sidebarAdaptable)
                // 生词卡「回到原句」发起的跳转：先把 tab 切过去，
                // 落到哪一句由 LibraryView 消费同一个请求决定。
                .onChange(of: store.pendingJump) {
                    if store.pendingJump != nil { selection = .library }
                }
            } else {
                OnboardingView(state: onboarding) {
                    withAnimation { onboardingCompleted = true }
                }
            }
        }
        // 语言切换时改变身份，强制整棵子树（含各 Feature 视图内部的 L()）按新语言重建。
        .id(interfaceLanguage)
        // 全 App 的宽窄判定只在这里测一次。挂在 .id 之外，切语言重建子树时
        // 已测到的尺寸不会丢，否则会看到一帧按兜底窄值渲染的闪烁。
        .publishingCanvasMetrics()
        // 从设置页重看引导：向导状态是长驻的，不重置会直接落在上次的"完成"页。
        .onChange(of: onboardingCompleted) {
            if !onboardingCompleted { onboarding.reset() }
        }
        .environment(\.locale, activeLocale)
        .sheet(isPresented: $showPaywallPreview) {
            if let commerce = store.commerce {
                PaywallView(commerce: commerce, account: account)
            }
        }
        .environment(store)
        .environment(appConfig)
        .environment(themeManager)
        .environment(\.theme, theme)
        .tint(theme.primary)
        .preferredColorScheme(themeManager.appearance.colorScheme)
        .task {
            // 先注入真实精讲/翻译入口（未配置模型时抛 .notConfigured），再加载持久化数据。
            store.explanationProvider = { [appConfig] text in
                try await appConfig.explain(text: text)
            }
            store.translationProvider = { [appConfig] text in
                try await appConfig.translate(text: text)
            }
            store.glossProvider = { [appConfig] word, sentence in
                try await appConfig.gloss(word: word, sentence: sentence)
            }
            store.glossCacheContext = { [appConfig] in appConfig.glossCacheContext }
            store.accountSession = account
            // 交易监听越早越好：上次没入账的、续订、家长批准的购买都从这里来。
            let commerce = StoreManager(session: account)
            commerce.startObservingTransactions()
            store.commerce = commerce
            if ProcessInfo.processInfo.arguments.contains("-showPaywall") { showPaywallPreview = true }
            account.onSignedIn = { [store] in await store.accountDidSignIn() }
            account.onSignedOut = { [store] in await store.accountDidSignOut() }
            await store.load()
            // OpenKoto 云没有 CKSyncEngine 那样的系统调度，启动时主动同步一轮。
            // 不 await：同步失败 / 慢网都不能挡住首屏。
            if store.syncProvider == .openkoto {
                Task { await store.syncNow() }
            }
            // 写入后 3 秒同步 + 前台每 5 分钟同步（只对 OpenKoto 云生效，内部自己判断）。
            store.startAutoSync()
            store.startPeriodicSync()
            // 必须在 load 之后：favorites 还空着时排期会算出「没有任何到期卡」，
            // 把已经排好的提醒全撤掉。
            await ReviewReminder.reschedule(favorites: store.favorites)
            // 冷启动点通知：代理在视图建起来之前就写了信箱，下面的 onChange 收不到那一次。
            consumeReminderRoute()
            await store.importFromInbox()
        }
        // 从后台返回时也排空收件箱（用户可能刚从别处分享内容进来）
        .onChange(of: scenePhase) {
            if scenePhase == .active {
                Task { await store.importFromInbox() }
                // 回到前台拉一轮（协议 §8 的触发时机之一）。
                if store.syncProvider == .openkoto {
                    Task { await store.syncNow() }
                }
                store.startPeriodicSync()
            } else if scenePhase == .background {
                store.stopPeriodicSync()
            }
            // 进出前台各重排一次：退到后台那次收的是这一程的复习成果
            //（做完的卡到期日已经推后，明天不该再被催）；回到前台那次管的是
            // 跨天——App 在后台待了三天，7 天窗口得往前滚。
            if scenePhase == .active || scenePhase == .background {
                Task { await ReviewReminder.reschedule(favorites: store.favorites) }
            }
        }
        // 通知文案是排期那一刻定型的，换了界面语言就得重排，否则弹出来还是旧语言。
        .onChange(of: interfaceLanguage) {
            Task { await ReviewReminder.reschedule(favorites: store.favorites) }
        }
        // App 活着时点通知（从后台唤回）走这条。
        .onChange(of: reminderRouter.openRequests) {
            consumeReminderRoute()
        }
        // "用 OpenKoto 打开"：LSSupportsOpeningDocumentsInPlace = NO，
        // 所以系统把文件拷进 Documents/Inbox 再交给我们。
        // 必须走 security-scoped 访问，导入完把系统留下的副本删掉。
        .onOpenURL { url in
            // `openkoto://` 是登录回调的 scheme，由 ASWebAuthenticationSession 自己接走；
            // 偶尔从外部唤起时也不是文件，别当成导入。
            guard url.scheme != AccountConfiguration.callbackScheme else { return }
            Task {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                await store.importFile(at: url)
                // 只删自己 Inbox 里的副本。万一哪天 plist 那个键被改成 YES，
                // 这里拿到的就是用户在"文件"App 里的原件——删了就是数据丢失。
                if Self.isInDocumentsInbox(url) {
                    try? FileManager.default.removeItem(at: url)
                }
            }
        }
    }
}

#Preview {
    RootTabView()
}
#endif
