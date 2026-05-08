const path = require("path");
const { app, BrowserWindow, dialog } = require("electron");

let mainWindow = null;
let controlServer = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function loadServerModule() {
  const compiledPath = path.join(__dirname, "..", "dist", "index.js");
  try {
    return require(compiledPath);
  } catch (compiledError) {
    try {
      require("ts-node/register");
      return require(path.join(__dirname, "..", "src", "index.ts"));
    } catch (sourceError) {
      sourceError.cause = compiledError;
      throw sourceError;
    }
  }
}

function createWindow(targetUrl) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1200,
    minHeight: 820,
    autoHideMenuBar: true,
    backgroundColor: "#f6efe5",
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.loadURL(targetUrl);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function focusMainWindow() {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
}

async function bootDesktopApp() {
  const { startControlServer } = loadServerModule();
  controlServer = await startControlServer(0, "127.0.0.1");
  createWindow(controlServer.url);
}

app.on("second-instance", () => {
  focusMainWindow();
});

app.whenReady().then(async () => {
  try {
    await bootDesktopApp();
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "Ticket Bot Desktop",
      message: "Desktop app failed to start",
      detail: error instanceof Error ? error.stack || error.message : String(error),
    });
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && controlServer) {
      createWindow(controlServer.url);
      return;
    }

    focusMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async (event) => {
  if (!controlServer) {
    return;
  }

  event.preventDefault();
  const serverToClose = controlServer;
  controlServer = null;
  try {
    await serverToClose.close();
  } catch (error) {
    console.error("Failed to close control server cleanly", error);
  }
  app.quit();
});
