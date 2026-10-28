/*
 * PyRunner: fala com o Web Worker do Python (python-worker.js) e expõe
 * uma API simples de "rodar código e receber a saída" pro app.js.
 */
const PyRunner = (() => {
  const TEXT_BUFFER_BYTES = 65536; // 64KB — bem mais que qualquer input() precisaria

  let worker = null;
  let readyPromise = null;
  let pending = new Map(); // id -> { resolve, reject }
  let runCounter = 0;
  let onOutputCallback = null;
  let onInputRequest = null;

  // SharedArrayBuffer só existe em contexto "cross-origin isolated" (ver
  // coi-serviceworker.js em index.html). Sem isso, input() simplesmente
  // não tem como pausar o worker e volta vazio — degrada, não quebra.
  let controlBuffer = null;
  let textBuffer = null;
  let controlView = null;

  function handleMessage(e) {
    const msg = e.data;
    if (msg.type === 'stdout' || msg.type === 'stderr') {
      if (onOutputCallback) onOutputCallback(msg.type, msg.text);
    } else if (msg.type === 'input-request') {
      handleInputRequest(msg.prompt || '');
    } else if (msg.type === 'done' || msg.type === 'error') {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.type === 'done') entry.resolve();
      else entry.reject(new Error(msg.error));
    }
  }

  async function handleInputRequest(promptText) {
    if (!controlView) return; // sem suporte no navegador; o worker já volta vazio sozinho
    const text = onInputRequest ? await onInputRequest(promptText) : '';
    const bytes = new TextEncoder().encode(text ?? '');
    const len = Math.min(bytes.length, textBuffer.byteLength);
    new Uint8Array(textBuffer, 0, len).set(bytes.subarray(0, len));
    Atomics.store(controlView, 1, len);
    Atomics.store(controlView, 0, 1); // 1 = resposta pronta
    Atomics.notify(controlView, 0);
  }

  function ensureWorker() {
    if (worker) return;
    worker = new Worker('js/python-worker.js');
    worker.addEventListener('message', handleMessage);

    if (typeof SharedArrayBuffer !== 'undefined') {
      controlBuffer = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT); // [0]=flag, [1]=tamanho
      textBuffer = new SharedArrayBuffer(TEXT_BUFFER_BYTES);
      controlView = new Int32Array(controlBuffer);
      worker.postMessage({ type: 'buffers', controlBuffer, textBuffer });
    }
  }

  function setOutputHandler(onOutput) {
    onOutputCallback = onOutput;
  }

  // onInput deve ser uma função (promptText) => Promise<string> — chamada
  // toda vez que o código Python roda um input() e precisa de uma resposta
  // do usuário. promptText é o texto passado pra input("..."), já pronto
  // pra mostrar (não depende do buffer de linha do stdout).
  function setInputHandler(onInput) {
    onInputRequest = onInput;
  }

  function init() {
    ensureWorker();
    if (!readyPromise) {
      readyPromise = new Promise((resolve, reject) => {
        function onReady(e) {
          if (e.data.type === 'ready') {
            worker.removeEventListener('message', onReady);
            resolve();
          } else if (e.data.type === 'init-error') {
            worker.removeEventListener('message', onReady);
            reject(new Error(e.data.error));
          }
        }
        worker.addEventListener('message', onReady);
        worker.postMessage({ type: 'init' });
      });
    }
    return readyPromise;
  }

  async function run(code) {
    await init();
    const id = ++runCounter;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'run', id, code });
    });
  }

  function isReady() {
    return !!readyPromise;
  }

  function supportsInput() {
    return !!controlView;
  }

  function stop() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    readyPromise = null;
    controlBuffer = null;
    textBuffer = null;
    controlView = null;
    for (const { reject } of pending.values()) reject(new Error('Execução interrompida.'));
    pending.clear();
  }

  return { setOutputHandler, setInputHandler, run, isReady, supportsInput, stop };
})();
