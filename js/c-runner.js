/*
 * CRunner: compila (compilador-worker.js, Clang) e executa (executor-worker.js) programas em C.
 * O compilador começa a baixar assim que a página abre, para estar pronto quando o aluno for rodar.
 */
const CRunner = (() => {
  const TAMANHO_ENTRADA = 65536;

  let compilador = null;
  let pronto = false;
  let falhaPreparo = null;
  let ouvintesProgresso = [];
  let ouvintesPronto = [];
  let proximoId = 0;
  const pendentes = new Map(); // id -> resolve

  let executor = null;
  let aoTerminar = null;
  let controle = null;
  let texto = null;
  let aoSaida = null;
  let aoPedirEntrada = null;

  function iniciarCompilador() {
    if (compilador) return;
    compilador = new Worker('js/compilador-worker.js', { type: 'module' });
    compilador.addEventListener('message', (e) => {
      const m = e.data;
      if (m.tipo === 'progresso') ouvintesProgresso.forEach((f) => f(m.feito, m.total));
      else if (m.tipo === 'pronto') { pronto = true; ouvintesPronto.forEach((f) => f(null)); }
      else if (m.tipo === 'falha-preparo') { falhaPreparo = m.erro; ouvintesPronto.forEach((f) => f(m.erro)); }
      else if (m.tipo === 'resultado') {
        const resolver = pendentes.get(m.id);
        pendentes.delete(m.id);
        if (resolver) resolver(m);
      }
    });
    // falha ao carregar o próprio worker (ex.: navegador sem workers de módulo)
    compilador.addEventListener('error', (e) => {
      falhaPreparo = 'O compilador não abriu neste navegador: ' + (e.message || 'erro desconhecido');
      ouvintesPronto.forEach((f) => f(falhaPreparo));
      for (const resolver of pendentes.values()) resolver({ ok: false, saida: '', erroInterno: falhaPreparo });
      pendentes.clear();
    });
    compilador.postMessage({ tipo: 'preparar' });
  }

  function aoProgresso(f) { ouvintesProgresso.push(f); }
  function aoFicarPronto(f) {
    if (pronto) f(null);
    else if (falhaPreparo) f(falhaPreparo);
    else ouvintesPronto.push(f);
  }
  function estaPronto() { return pronto; }

  // arvore: { 'main.c': '...', 'pasta': { 'x.h': '...' } }; fontes: caminhos dos .c
  function compilar(arvore, fontes) {
    iniciarCompilador();
    if (falhaPreparo) { // tenta de novo (ex.: a internet voltou)
      falhaPreparo = null;
      compilador.postMessage({ tipo: 'preparar' });
    }
    const id = ++proximoId;
    return new Promise((resolve) => {
      pendentes.set(id, resolve);
      compilador.postMessage({ tipo: 'compilar', id, arvore, fontes });
    });
  }

  function definirSaida(f) { aoSaida = f; }
  // f() => Promise<string|null> (null = fim da entrada, Ctrl+D)
  function definirEntrada(f) { aoPedirEntrada = f; }

  async function responderEntrada() {
    const linha = aoPedirEntrada ? await aoPedirEntrada() : null;
    if (!executor || !controle) return;
    if (linha === null) {
      Atomics.store(controle, 1, 0);
      Atomics.store(controle, 2, 1);
    } else {
      const b = new TextEncoder().encode(linha);
      const n = Math.min(b.length, TAMANHO_ENTRADA);
      new Uint8Array(texto, 0, n).set(b.subarray(0, n));
      Atomics.store(controle, 1, n);
    }
    Atomics.store(controle, 0, 1);
    Atomics.notify(controle, 0);
  }

  // executa e resolve com { codigo, erro } quando o programa termina (ou é parado)
  function executar(wasm) {
    parar();
    executor = new Worker('js/executor-worker.js');
    const msg = { tipo: 'executar', wasm };
    if (typeof SharedArrayBuffer !== 'undefined') {
      const bufControle = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
      texto = new SharedArrayBuffer(TAMANHO_ENTRADA);
      controle = new Int32Array(bufControle);
      msg.controle = bufControle;
      msg.texto = texto;
    }
    return new Promise((resolve) => {
      aoTerminar = resolve;
      executor.addEventListener('message', (e) => {
        const m = e.data;
        if (m.tipo === 'saida') { if (aoSaida) aoSaida(m.fd === 2 ? 'stderr' : 'stdout', m.texto); }
        else if (m.tipo === 'pedir-entrada') responderEntrada();
        else if (m.tipo === 'fim') { finalizar(); resolve({ codigo: m.codigo, erro: m.erro }); }
      });
      executor.addEventListener('error', (e) => {
        finalizar();
        resolve({ codigo: -1, erro: 'Falha ao executar: ' + (e.message || 'erro desconhecido') });
      });
      executor.postMessage(msg);
    });
  }

  function finalizar() {
    if (executor) executor.terminate();
    executor = null;
    controle = null;
    texto = null;
    aoTerminar = null;
  }

  function parar() {
    const resolver = aoTerminar;
    finalizar();
    if (resolver) resolver({ codigo: null, erro: null, parado: true });
  }

  function rodando() { return !!executor; }
  function suportaEntrada() { return typeof SharedArrayBuffer !== 'undefined'; }

  return { iniciarCompilador, aoProgresso, aoFicarPronto, estaPronto, compilar, executar, parar, rodando, definirSaida, definirEntrada, suportaEntrada };
})();
