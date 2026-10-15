'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Store } = require('./core/database.cjs');
const { PortalService } = require('./core/service.cjs');
const { ParserRunner } = require('./core/parser.cjs');

let window;
let service;
let closing = false;
const uiPath = path.join(__dirname, 'renderer', 'index.html');
const uiUrl = pathToFileURL(uiPath).href;
const explicitData = process.argv.find(arg => arg.startsWith('--data-dir='))?.slice('--data-dir='.length);
if (explicitData) app.setPath('userData', path.resolve(explicitData, 'runtime'));
app.setAppUserModelId('local.liteparse.portal');

async function dataDirectory() {
  if (explicitData) return path.resolve(explicitData);
  if (!app.isPackaged) return path.join(app.getAppPath(), '.portal-data');
  const appImageDirectory = process.platform === 'linux' && process.env.APPIMAGE
    ? path.dirname(path.resolve(process.env.APPIMAGE)) : null;
  const base = appImageDirectory || process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
  const portable = path.join(base, 'LiteParse Portal Data');
  try {
    await fs.mkdir(portable, { recursive: true });
    const probe = path.join(portable, `.write-check-${process.pid}`);
    await fs.writeFile(probe, '', { flag: 'wx' }); await fs.rm(probe);
    return portable;
  } catch {
    // Never silently switch away from existing portable data.
    try { await fs.access(path.join(portable, 'portal.sqlite')); }
    catch (error) {
      if (error.code === 'ENOENT') return path.join(app.getPath('userData'), 'data');
      throw new Error(`Cannot access the portable data folder: ${portable}. ${error.message}`);
    }
    throw new Error(`The existing data folder is not writable: ${portable}. Move the application to a user-writable folder.`);
  }
}

function handle(name, callback) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame?.url !== uiUrl) throw new Error('Untrusted request.');
    return callback(...args);
  });
}

function registerHandlers() {
  handle('portal:state', (id, options) => service.snapshot(id, options));
  handle('portal:create', config => service.createCollection({ ...config, watchPath: '' }));
  handle('portal:import', async (id, folder) => {
    service.collection(id);
    const picked = await dialog.showOpenDialog(window, {
      title: folder ? 'Import a folder of documents' : 'Import documents',
      properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
      filters: [{ name: 'PDFs and images', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp'] }]
    });
    return picked.canceled ? null : service.importPaths(id, picked.filePaths);
  });
  handle('portal:watch', async (id, enabled) => {
    if (!enabled) { await service.setWatch(id, ''); return true; }
    const picked = await dialog.showOpenDialog(window, { title: 'Watch a folder (includes subfolders)', properties: ['openDirectory'] });
    if (picked.canceled) return false;
    await service.setWatch(id, picked.filePaths[0]); return true;
  });
  handle('portal:export', async id => {
    const collection = service.collection(id);
    const picked = await dialog.showSaveDialog(window, {
      title: 'Choose the CSV that this conversion will keep updated',
      defaultPath: `${collection.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.csv`,
      filters: [{ name: 'CSV spreadsheet', extensions: ['csv'] }]
    });
    if (picked.canceled) return null;
    await service.updateExport(id, picked.filePath);
    return picked.filePath;
  });
  handle('portal:reveal', id => { shell.showItemInFolder(service.collection(id).output_path); });
  handle('portal:reveal-data', () => { shell.showItemInFolder(path.join(service.directory, 'portal.sqlite')); });
  handle('portal:document', id => service.document(id));
  handle('portal:review', (id, values, additional) => service.review(id, values, additional));
  handle('portal:retention', (id, retain) => service.setRetention(id, retain));
  handle('portal:retry', id => service.retry(id));
  handle('portal:analysis-mode', (id, mode) => service.setAnalysisMode(id, mode));
  handle('portal:reanalyze', async id => {
    const doc = service.document(id);
    if (doc.reviewed) {
      const result = await dialog.showMessageBox(window, { type: 'question', buttons: ['Cancel', 'Reanalyze'], defaultId: 0, cancelId: 0,
        message: 'Replace this reviewed result?', detail: 'Successful reanalysis replaces saved values and corrections, and marks the document for review again. The previous result stays in the CSV if reanalysis fails.' });
      if (result.response !== 1) return false;
    }
    await service.reanalyze(id); return true;
  });
  handle('portal:pause', () => service.togglePause());
}

async function boot() {
  const directory = await dataDirectory();
  const store = await Store.open(directory);
  const tessdataPath = app.isPackaged ? path.join(process.resourcesPath, 'tessdata') : path.join(app.getAppPath(), 'assets', 'tessdata');
  service = new PortalService(store, directory, new ParserRunner(() => utilityProcess.fork(path.join(__dirname, 'parser-worker.cjs'), [], { stdio: 'pipe', serviceName: 'Document parser' }), null, tessdataPath));
  // The application and parser have no online features.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  registerHandlers();
  window = new BrowserWindow({
    width: 1360, height: 900, minWidth: 1000, minHeight: 700, show: false,
    title: 'LiteParse Portal', backgroundColor: '#f6f7fb', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, spellcheck: false }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (closing) return;
    event.preventDefault(); closing = true;
    window.hide();
    service.stop().then(() => app.quit()).catch(error => { dialog.showErrorBox('Could not finish saving', error.message); app.exit(1); });
  });
  let refreshTimer;
  service.on('change', () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (!window?.isDestroyed()) window.webContents.send('portal:changed'); }, 100);
  });
  await window.loadFile(uiPath);
  window.show();
  await service.start();
  if (process.argv.includes('--smoke-test')) {
    await require('./smoke.cjs').run({ service, window });
    closing = true; await service.stop(); app.exit(0);
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(boot).catch(error => { console.error(error); dialog.showErrorBox('LiteParse Portal could not start', error.message); app.exit(1); });
  app.on('window-all-closed', () => { if (closing) app.quit(); });
}
