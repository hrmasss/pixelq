/// <reference types="vite/client" />

interface Window {
  go: {
    main: {
      DesktopApp: {
        OpenLibrary: () => Promise<void>;
        OpenInbox: () => Promise<void>;
        OpenPath: (path: string) => Promise<void>;
        GetDesktopConfig: () => Promise<Record<string, unknown>>;
      };
    };
  };
}
