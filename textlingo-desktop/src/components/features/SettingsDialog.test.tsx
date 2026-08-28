import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsDialog } from "./SettingsDialog";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    i18n: { language: "en", changeLanguage: vi.fn() },
  }),
}));

vi.mock("../theme-provider", () => ({
  useTheme: () => ({
    themeName: "seoul",
    themeMode: "light",
    setThemeName: vi.fn(),
    setThemeMode: vi.fn(),
  }),
}));

describe("SettingsDialog", () => {
  afterEach(() => {
    cleanup();
    invokeMock.mockReset();
  });

  it("prefills new custom prompt templates with {text} and exposes template help", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_config") {
        return Promise.resolve({
          model_configs: [],
          target_language: "zh-CN",
          interface_language: "en",
          prompt_features: [],
        });
      }

      return Promise.resolve("ok");
    });

    render(<SettingsDialog isOpen onClose={vi.fn()} onSave={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "settings.nav.chat" }));
    expect(await screen.findByText("AI Chat Features")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add feature" }));

    expect(screen.getByLabelText("Prompt template")).toHaveValue("{text}");

    await userEvent.click(screen.getByRole("button", { name: "What is {text}?" }));

    expect(
      await screen.findByText("{text} will be replaced with the selected text when this feature runs."),
    ).toBeInTheDocument();
  });

  it("saves edited prompt features with the config payload", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_config") {
        return Promise.resolve({
          model_configs: [],
          target_language: "zh-CN",
          interface_language: "en",
          prompt_features: [
            {
              id: "chat.default",
              kind: "chat_default",
              name: "Chat",
              description: "Default chat",
              prompt_template: "You are a tutor",
              requires_selection: false,
              show_in_quick_actions: false,
              icon: "sparkles",
              sort_order: 0,
              enabled: true,
              is_builtin: true,
            },
          ],
        });
      }

      return Promise.resolve("ok");
    });

    render(<SettingsDialog isOpen onClose={vi.fn()} onSave={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "settings.nav.chat" }));
    expect(await screen.findByText("AI Chat Features")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add feature" }));
    await userEvent.type(screen.getByLabelText("Feature name"), "Summary");
    fireEvent.change(screen.getByLabelText("Prompt template"), {
      target: { value: "Summarize {text}" },
    });
    await userEvent.click(screen.getByText("Close"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "save_config_cmd",
        expect.objectContaining({
          config: expect.objectContaining({
            prompt_features: expect.arrayContaining([
              expect.objectContaining({ id: "chat.default" }),
              expect.objectContaining({ name: "Summary", prompt_template: "Summarize {text}" }),
            ]),
          }),
        }),
      );
    });
  });

  it("does not render the plugin settings section", async () => {
    invokeMock.mockResolvedValue({
      model_configs: [],
      target_language: "zh-CN",
      interface_language: "en",
      prompt_features: [],
    });

    render(<SettingsDialog isOpen onClose={vi.fn()} onSave={vi.fn()} />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_config");
    });

    expect(screen.queryByText("settings.plugins.title")).not.toBeInTheDocument();
  });

  it("saves the batch explanation concurrency setting", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_config") {
        return Promise.resolve({
          model_configs: [],
          target_language: "zh-CN",
          interface_language: "en",
          batch_translation_concurrency: 3,
          prompt_features: [],
        });
      }

      return Promise.resolve("ok");
    });

    render(<SettingsDialog isOpen onClose={vi.fn()} onSave={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "settings.nav.advanced" }));
    const concurrencyInput = await screen.findByLabelText("Batch explanation concurrency");
    fireEvent.change(concurrencyInput, { target: { value: "6" } });
    await userEvent.click(screen.getByText("Close"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "save_config_cmd",
        expect.objectContaining({
          config: expect.objectContaining({
            batch_translation_concurrency: 6,
          }),
        }),
      );
    });
  });

  it("syncs Meta and saves first synced model without manual dropdown change", async () => {
    const syncedMeta = { data: [{ id: "rl-muse-spark-1-2-playground" }, { id: "muse-spark-1.1" }] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => syncedMeta } as any);
    vi.stubGlobal("fetch", fetchMock);

    invokeMock.mockImplementation((command: string, args?: any) => {
      if (command === "get_config") {
        return Promise.resolve({
          model_configs: [
            { id: "c1", name: "Meta", api_key: "k", api_provider: "meta", model: "muse-spark-1.2", is_default: true },
          ],
          target_language: "zh-CN",
          interface_language: "en",
          prompt_features: [],
        });
      }
      if (command === "save_model_config") return Promise.resolve(args.config);
      return Promise.resolve("ok");
    });

    render(<SettingsDialog isOpen onClose={vi.fn()} onSave={vi.fn()} />);

    // open edit form for the existing config
    const editBtn = await screen.findByTitle("settings.editConfig");
    await userEvent.click(editBtn);

    // provider is meta, sync button should be visible now
    const syncBtn = await screen.findByTitle("settings.syncModelsTooltip");
    await userEvent.click(syncBtn);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // after sync, the model select should have been auto-updated to first synced
    // because muse-spark-1.2 is not in synced list
    await waitFor(() => expect((screen.getByDisplayValue("rl-muse-spark-1-2-playground") as HTMLSelectElement).value).toBe("rl-muse-spark-1-2-playground"));

    await userEvent.click(screen.getByText("settings.saveConfig"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_model_config",
        expect.objectContaining({ config: expect.objectContaining({ model: "rl-muse-spark-1-2-playground", api_provider: "meta" }) }),
      ),
    );

    vi.unstubAllGlobals();
  });

  it("does not apply late Meta sync after switching provider", async () => {
    let resolveFetch: (v: any) => void = () => {};
    const fetchPromise = new Promise<any>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(fetchPromise);
    vi.stubGlobal("fetch", fetchMock);

    invokeMock.mockImplementation((command: string, args?: any) => {
      if (command === "get_config") {
        return Promise.resolve({
          model_configs: [
            { id: "c1", name: "Meta", api_key: "k", api_provider: "meta", model: "muse-spark-1.2", is_default: true },
          ],
          target_language: "zh-CN",
          interface_language: "en",
          prompt_features: [],
        });
      }
      if (command === "save_model_config") return Promise.resolve(args.config);
      return Promise.resolve("ok");
    });

    render(<SettingsDialog isOpen onClose={vi.fn()} onSave={vi.fn()} />);

    const editBtn = await screen.findByTitle("settings.editConfig");
    await userEvent.click(editBtn);

    const syncBtn = await screen.findByTitle("settings.syncModelsTooltip");
    await userEvent.click(syncBtn);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("api.meta.ai");

    // switch provider to openai before fetch resolves - find provider select by value
    const allSelects = document.querySelectorAll("select");
    const providerSelect = Array.from(allSelects).find(s => (s as HTMLSelectElement).value === "meta") as HTMLSelectElement;
    expect(providerSelect).toBeTruthy();
    fireEvent.change(providerSelect, { target: { value: "openai" } });

    // now resolve the Meta fetch late
    resolveFetch({ ok: true, json: async () => ({ data: [{ id: "rl-muse-spark-1-2-playground" }] }) } as any);

    // give React a tick to process the late sync - provider should stay openai
    await waitFor(() => {
      const updatedProviderSelect = Array.from(document.querySelectorAll("select")).find(s => (s as HTMLSelectElement).value === "openai") as HTMLSelectElement;
      expect(updatedProviderSelect).toBeTruthy();
    });
    // model should still be openai default (gpt-4o), not overwritten to meta's rl-...
    await waitFor(() => {
      const modelSelect = Array.from(document.querySelectorAll("select")).find(s => (s as HTMLSelectElement).value === "gpt-4o") as HTMLSelectElement;
      expect(modelSelect).toBeTruthy();
    });
    // ensure late meta result did not inject rl-... into openai's model list
    expect(document.body.textContent).not.toContain("rl-muse-spark-1-2-playground");

    vi.unstubAllGlobals();
  });

  it("entering API key and immediately saving Meta without sync uses playground default", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as any);
    vi.stubGlobal("fetch", fetchMock);

    invokeMock.mockImplementation((command: string, args?: any) => {
      if (command === "get_config") {
        return Promise.resolve({
          model_configs: [],
          target_language: "zh-CN",
          interface_language: "en",
          prompt_features: [],
        });
      }
      if (command === "save_model_config") return Promise.resolve(args.config);
      return Promise.resolve("ok");
    });

    render(<SettingsDialog isOpen onClose={vi.fn()} onSave={vi.fn()} />);

    // start new config
    const addBtn = await screen.findByText("settings.addConfig");
    await userEvent.click(addBtn);

    // switch provider to meta - find provider select by its initial openai value
    let providerSelect = document.querySelectorAll("select")[0] as HTMLSelectElement;
    // Initially provider is openai after startNewConfig, switch to meta
    fireEvent.change(providerSelect, { target: { value: "meta" } });

    // after switch, model should be playground default without needing sync
    await waitFor(() => {
      const modelSelect = document.querySelectorAll("select")[1] as HTMLSelectElement;
      expect(modelSelect.value).toBe("rl-muse-spark-1-2-playground");
    });

    // fill required fields: config name and API key
    const nameInput = screen.getByPlaceholderText("settings.configNamePlaceholder") as HTMLInputElement;
    await userEvent.type(nameInput, "My Meta");

    const apiKeyInput = screen.getByPlaceholderText("settings.apiKeyPlaceholder") as HTMLInputElement;
    await userEvent.type(apiKeyInput, "test-key-123");

    // blur triggers auto-sync (isAuto=true) - fetch may be called, but manual sync not required
    // Do not assert fetch not called; verify save works without manual sync click
    const syncBtn = screen.getByTitle("settings.syncModelsTooltip");
    expect(syncBtn).toBeInTheDocument();
    // ensure we did NOT manually click sync
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("api.meta.ai/v1/models"), expect.anything());

    await userEvent.click(screen.getByText("settings.saveConfig"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_model_config",
        expect.objectContaining({
          config: expect.objectContaining({
            api_provider: "meta",
            model: "rl-muse-spark-1-2-playground",
            api_key: "test-key-123",
          }),
        }),
      ),
    );

    vi.unstubAllGlobals();
  });
});
