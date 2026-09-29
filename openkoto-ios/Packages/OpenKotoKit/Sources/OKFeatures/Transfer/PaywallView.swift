#if os(iOS)
import OKAccount
import OKCommerce
import OKDesignSystem
import OKLocalization
import StoreKit
import SwiftUI

/// 会员与积分购买页（StoreKit 2）。价格一律取自 StoreKit，不在客户端写死。
struct PaywallView: View {
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss

    let commerce: StoreManager
    let account: AccountSession

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent(L("settings.account.plan")) {
                        Text(verbatim: account.plan.rawValue.capitalized)
                    }
                } footer: {
                    Text(L("paywall.subtitle"))
                }

                if commerce.isLoading && commerce.products.isEmpty {
                    Section { ProgressView() }
                } else if let error = commerce.loadError, commerce.products.isEmpty {
                    Section {
                        Text(error).foregroundStyle(theme.destructive)
                        Button(L("paywall.retry")) { Task { await commerce.loadProducts() } }
                    }
                }

                if Self.screenshotSamples && commerce.products.isEmpty {
                    sampleSections
                } else {
                    productSection(L("paywall.plus"), [.plusMonthly, .plusYearly])
                    productSection(L("paywall.pro"), [.proMonthly, .proYearly])
                    productSection(L("paywall.credits"), [.credits3000])
                }

                Section {
                    statusRow
                    Button(L("paywall.restore")) { Task { await commerce.restore() } }
                } footer: {
                    Text(L("paywall.legal"))
                }
            }
            .navigationTitle(L("paywall.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L("common.close")) { dismiss() }
                }
            }
            .task { await commerce.loadProducts() }
        }
    }

    @ViewBuilder
    private func productSection(_ title: String, _ ids: [CommerceProduct]) -> some View {
        let items = ids.compactMap { commerce.product($0) }
        if !items.isEmpty {
            Section(title) {
                ForEach(items, id: \.id) { product in
                    productRow(product)
                }
            }
        }
    }

    private func productRow(_ product: Product) -> some View {
        row(name: product.displayName, detail: product.description,
            price: priceText(product), purchasing: commerce.state == .purchasing(product.id)) {
            Task { await commerce.purchase(product) }
        }
    }

    private func row(name: String, detail: String, price: String, purchasing: Bool,
                     action: @escaping () -> Void) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: name)
                if !detail.isEmpty {
                    Text(verbatim: detail)
                        .font(.caption)
                        .foregroundStyle(theme.mutedForeground)
                }
            }
            Spacer()
            Button(action: action) {
                if purchasing {
                    ProgressView().controlSize(.small)
                } else {
                    Text(verbatim: price)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isBusy)
        }
    }

    /// App Store 内购审核截屏用（Debug 构建 + `-paywallSamples`）：StoreKit 拿不到商品时
    /// （模拟器没挂 StoreKit 配置），按 App Store Connect 里的名称与价格画同一套行。
    private static var screenshotSamples: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("-paywallSamples")
        #else
        false
        #endif
    }

    @ViewBuilder
    private var sampleSections: some View {
        Section(L("paywall.plus")) {
            row(name: "OpenKoto Plus 月付", detail: "多端同步、网页版、命令行与 MCP，按月计费",
                price: "¥8" + L("paywall.perMonth"), purchasing: false) {}
            row(name: "OpenKoto Plus 年付", detail: "多端同步、网页版、命令行与 MCP，按年计费",
                price: "¥68" + L("paywall.perYear"), purchasing: false) {}
        }
        Section(L("paywall.pro")) {
            row(name: "OpenKoto Pro 月付", detail: "全部 Plus 功能，每月 1500 AI 积分与整本书翻译",
                price: "¥28" + L("paywall.perMonth"), purchasing: false) {}
            row(name: "OpenKoto Pro 年付", detail: "全部 Plus 功能，每年 18000 AI 积分与整本书翻译",
                price: "¥258" + L("paywall.perYear"), purchasing: false) {}
        }
        Section(L("paywall.credits")) {
            row(name: "3000 AI 积分", detail: "用于翻译、精讲与整本书翻译，12 个月内有效",
                price: "¥30", purchasing: false) {}
        }
    }

    private var isBusy: Bool {
        if case .purchasing = commerce.state { return true }
        return false
    }

    private func priceText(_ product: Product) -> String {
        guard let period = product.subscription?.subscriptionPeriod else { return product.displayPrice }
        let unit = period.unit == .year ? L("paywall.perYear") : L("paywall.perMonth")
        return "\(product.displayPrice)\(unit)"
    }

    @ViewBuilder
    private var statusRow: some View {
        switch commerce.state {
        case .idle, .purchasing:
            EmptyView()
        case .pending:
            Text(L("paywall.pending")).font(.footnote).foregroundStyle(theme.mutedForeground)
        case .succeeded:
            Text(L("paywall.success")).font(.footnote).foregroundStyle(theme.primary)
        case .failed(let message):
            Text(message).font(.footnote).foregroundStyle(theme.destructive)
        }
    }
}
#endif
