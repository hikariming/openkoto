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

    await userEvent.click(await screen.findByRole("button", { name: "Chat Features" }));

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

    await userEvent.click(await screen.findByRole("button", { name: "Chat Features" }));

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

    await userEvent.click(await screen.findByRole("button", { name: "General" }));

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
});
