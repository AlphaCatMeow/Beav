import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const desktopRoot = fileURLToPath(new URL('../../../', import.meta.url));

function installDomGlobals(dom) {
  const values = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    CustomEvent: dom.window.CustomEvent,
    FileReader: dom.window.FileReader,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }

  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  };
}

test('mounts with HTML5 drag handlers without requiring Tauri window metadata', async () => {
  const server = await createServer({
    root: desktopRoot,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const restoreGlobals = installDomGlobals(dom);
  let root;
  let attachments;

  try {
    const { useChatAttachments } = await server.ssrLoadModule('/src/pages/chat/useChatAttachments.ts');

    function AttachmentsProbe() {
      attachments = useChatAttachments({
        allowFileUpload: true,
        attachmentDraftScopeId: '__test__',
        composerRef: { current: null },
        currentSessionId: null,
        isActive: true,
        isProcessing: false,
        setErrorNotice: () => {},
      });
      return null;
    }

    root = createRoot(document.getElementById('root'));
    await act(async () => {
      root.render(React.createElement(AttachmentsProbe));
      await Promise.resolve();
    });

    assert.equal(typeof attachments.dragHandlers.onDrop, 'function');
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    restoreGlobals();
    dom.window.close();
    await server.close();
  }
});
