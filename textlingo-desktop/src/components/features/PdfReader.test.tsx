import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";

import { PdfReader } from "./PdfReader";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("react-pdf", () => ({
  pdfjs: {
    GlobalWorkerOptions: {
      workerSrc: "",
    },
  },
  Document: ({
    children,
    onLoadSuccess,
  }: {
    children: React.ReactNode;
    onLoadSuccess?: ({ numPages }: { numPages: number }) => void;
  }) => {
    useEffect(() => {
      onLoadSuccess?.({ numPages: 5 });
    }, [onLoadSuccess]);

    return <div data-testid="pdf-document">{children}</div>;
  },
  Page: ({ pageNumber }: { pageNumber: number }) => <div data-testid="pdf-page">Page {pageNumber}</div>,
}));

vi.mock("./BookmarkSidebar", () => ({
  BookmarkSidebar: () => null,
}));

function setScrollMetrics(
  element: HTMLElement,
  { clientHeight, scrollHeight, scrollTop }: { clientHeight: number; scrollHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
  Object.defineProperty(element, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  element.scrollTop = scrollTop;
}

describe("PdfReader", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("anchors the next-page button to the reader container instead of the window edge", async () => {
    render(<PdfReader bookPath="http://127.0.0.1/test.pdf" title="Test PDF" />);

    const nextButton = await screen.findByTitle("下一页");

    expect(nextButton.className).not.toContain("fixed");
    expect(nextButton.className).toContain("absolute");
  });

  it("scrolls within an oversized PDF page instead of changing pages immediately", async () => {
    render(<PdfReader bookPath="http://127.0.0.1/test.pdf" title="Test PDF" />);

    await waitFor(() => {
      expect(screen.getByText("1/5")).toBeInTheDocument();
    });

    const contentArea = screen.getByTitle("下一页").parentElement as HTMLElement | null;
    expect(contentArea).not.toBeNull();
    setScrollMetrics(contentArea as HTMLElement, {
      clientHeight: 600,
      scrollHeight: 1400,
      scrollTop: 300,
    });

    const wheelEvent = createEvent.wheel(contentArea as HTMLElement, { deltaY: 100 });
    fireEvent(contentArea as HTMLElement, wheelEvent);

    expect(wheelEvent.defaultPrevented).toBe(false);
    expect(screen.getByText("1/5")).toBeInTheDocument();
  });

  it("changes pages with the mouse wheel only after reaching the vertical scroll edge", async () => {
    render(<PdfReader bookPath="http://127.0.0.1/test.pdf" title="Test PDF" />);

    await waitFor(() => {
      expect(screen.getByText("1/5")).toBeInTheDocument();
    });

    const contentArea = screen.getByTitle("下一页").parentElement as HTMLElement | null;
    expect(contentArea).not.toBeNull();

    setScrollMetrics(contentArea as HTMLElement, {
      clientHeight: 600,
      scrollHeight: 1400,
      scrollTop: 800,
    });

    fireEvent.wheel(contentArea as HTMLElement, { deltaY: 100 });
    expect(screen.getByText("2/5")).toBeInTheDocument();

    setScrollMetrics(contentArea as HTMLElement, {
      clientHeight: 600,
      scrollHeight: 1400,
      scrollTop: 0,
    });

    fireEvent.wheel(contentArea as HTMLElement, { deltaY: -100 });
    expect(screen.getByText("1/5")).toBeInTheDocument();
  });
});
