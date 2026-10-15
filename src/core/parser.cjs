'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');

class ParserRunner {
  constructor(spawnWorker, timeoutMs = 120000, tessdataPath = path.join(__dirname, '..', '..', 'assets', 'tessdata')) {
    this.spawnWorker = spawnWorker || (() => fork(path.join(__dirname, '..', 'parser-worker.cjs'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    this.timeoutMs = timeoutMs;
    this.tessdataPath = tessdataPath;
    this.active = null;
  }
  parse(file, fields) {
    return new Promise((resolve, reject) => {
      const worker = this.spawnWorker();
      this.active = worker;
      let done = false;
      let diagnostic = '';
      worker.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.active = null;
        worker.kill();
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(() => finish(new Error('Parsing exceeded two minutes. Split the document or retry.')), this.timeoutMs);
      worker.once('message', result => finish(result.ok ? null : new Error(result.error), result));
      worker.once('error', error => finish(error));
      worker.once('exit', code => finish(new Error(`Parser exited unexpectedly (${code}). ${diagnostic}`)));
      const message = { path: file, fields, tessdataPath: this.tessdataPath };
      try { if (worker.postMessage) worker.postMessage(message); else worker.send(message); }
      catch (error) { finish(error); }
    });
  }
  stop() { this.active?.kill(); }
}

module.exports = { ParserRunner };
