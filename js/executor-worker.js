/*
 * Worker que executa o programa C já compilado (WebAssembly + WASI preview1).
 * Cada execução usa um worker novo: o botão "Parar" simplesmente o encerra (laço infinito não trava a página).
 *
 * scanf/getchar: quando o programa pede entrada e não há nada guardado, o worker avisa a página e fica
 * parado em Atomics.wait até o aluno digitar uma linha no terminal (precisa de "cross-origin isolation",
 * ver coi-serviceworker.js). Sem isso, a entrada vem vazia (fim de arquivo).
 */

const ERRNO = { SUCESSO: 0, BADF: 8, INVAL: 28, NOSYS: 52, SPIPE: 70 };
const LIMITE_SAIDA = 2 * 1024 * 1024; // além disso a saída é descartada (laço imprimindo sem parar)

class SaidaDoPrograma extends Error {
  constructor(codigo) { super('exit'); this.codigo = codigo; }
}

let memoria = null;
let controle = null; // Int32Array [0]=pronto, [1]=tamanho, [2]=fim de arquivo
let textoEntrada = null;
let entradaPendente = new Uint8Array(0);
let fimDaEntrada = false;

const decodificadores = { 1: new TextDecoder(), 2: new TextDecoder() };
const saidaPendente = { 1: '', 2: '' };
let ultimoEnvio = 0;
let totalSaida = 0;
let saidaCortada = false;

const dv = () => new DataView(memoria.buffer);
const bytes = () => new Uint8Array(memoria.buffer);

function enviarSaida() {
  for (const fd of [1, 2]) {
    if (saidaPendente[fd]) {
      postMessage({ tipo: 'saida', fd, texto: saidaPendente[fd] });
      saidaPendente[fd] = '';
    }
  }
  ultimoEnvio = performance.now();
}

function escrever(fd, pedaco) {
  if (totalSaida > LIMITE_SAIDA) {
    if (!saidaCortada) {
      saidaCortada = true;
      enviarSaida();
      postMessage({ tipo: 'saida', fd: 2, texto: '\n[saída muito grande: o resto foi descartado]\n' });
    }
    return;
  }
  totalSaida += pedaco.length;
  saidaPendente[fd] += decodificadores[fd].decode(pedaco, { stream: true });
  // junta pedaços pequenos (printf em laço) em poucas mensagens para a página
  if (saidaPendente[fd].length > 8192 || performance.now() - ultimoEnvio > 40) enviarSaida();
}

// espera o aluno digitar uma linha
function lerDoTerminal() {
  if (!controle) { fimDaEntrada = true; return; }
  enviarSaida();
  postMessage({ tipo: 'pedir-entrada' });
  Atomics.wait(controle, 0, 0);
  const n = Atomics.load(controle, 1);
  const eof = Atomics.load(controle, 2) === 1;
  Atomics.store(controle, 0, 0);
  Atomics.store(controle, 2, 0);
  if (eof) { fimDaEntrada = true; return; }
  const novo = new Uint8Array(n);
  novo.set(new Uint8Array(textoEntrada, 0, n));
  entradaPendente = novo;
}

function lerIovs(iovs, n) {
  const v = dv();
  const lista = [];
  for (let i = 0; i < n; i++) lista.push([v.getUint32(iovs + i * 8, true), v.getUint32(iovs + i * 8 + 4, true)]);
  return lista;
}

function dormir(ms) {
  if (ms <= 0) return;
  if (typeof SharedArrayBuffer !== 'undefined') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } else {
    const fim = performance.now() + ms;
    while (performance.now() < fim) { /* espera ativa: sem SharedArrayBuffer não há outro jeito */ }
  }
}

const wasi = {
  args_sizes_get(pArgc, pTamanho) {
    const v = dv();
    v.setUint32(pArgc, 1, true);
    v.setUint32(pTamanho, 9, true); // "programa\0"
    return ERRNO.SUCESSO;
  },
  args_get(pArgv, pBuf) {
    dv().setUint32(pArgv, pBuf, true);
    bytes().set(new TextEncoder().encode('programa\0'), pBuf);
    return ERRNO.SUCESSO;
  },
  environ_sizes_get(pN, pTamanho) {
    const v = dv();
    v.setUint32(pN, 0, true);
    v.setUint32(pTamanho, 0, true);
    return ERRNO.SUCESSO;
  },
  environ_get() { return ERRNO.SUCESSO; },
  clock_res_get(_id, pRes) {
    dv().setBigUint64(pRes, 1000n, true);
    return ERRNO.SUCESSO;
  },
  clock_time_get(id, _precisao, pTempo) {
    const ns = id === 0
      ? BigInt(Date.now()) * 1000000n
      : BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
    dv().setBigUint64(pTempo, ns, true);
    return ERRNO.SUCESSO;
  },
  random_get(pBuf, n) {
    const b = bytes();
    for (let i = 0; i < n; i += 65536) {
      const pedaco = new Uint8Array(Math.min(65536, n - i));
      crypto.getRandomValues(pedaco);
      b.set(pedaco, pBuf + i);
    }
    return ERRNO.SUCESSO;
  },
  fd_write(fd, iovs, nIovs, pEscritos) {
    if (fd !== 1 && fd !== 2) return ERRNO.BADF;
    let total = 0;
    for (const [ptr, tam] of lerIovs(iovs, nIovs)) {
      escrever(fd, bytes().slice(ptr, ptr + tam));
      total += tam;
    }
    dv().setUint32(pEscritos, total, true);
    return ERRNO.SUCESSO;
  },
  fd_read(fd, iovs, nIovs, pLidos) {
    if (fd !== 0) return ERRNO.BADF;
    if (entradaPendente.length === 0 && !fimDaEntrada) lerDoTerminal();
    let total = 0;
    for (const [ptr, tam] of lerIovs(iovs, nIovs)) {
      if (entradaPendente.length === 0) break;
      const n = Math.min(tam, entradaPendente.length);
      bytes().set(entradaPendente.subarray(0, n), ptr);
      entradaPendente = entradaPendente.subarray(n);
      total += n;
      if (n < tam) break;
    }
    dv().setUint32(pLidos, total, true);
    return ERRNO.SUCESSO;
  },
  fd_fdstat_get(fd, p) {
    if (fd > 2) return ERRNO.BADF;
    const v = dv();
    v.setUint8(p, 2); // dispositivo de caracteres (terminal): stdin/stdout se comportam como num console
    v.setUint16(p + 2, 0, true);
    v.setBigUint64(p + 8, 0xffffffffffffffffn, true);
    v.setBigUint64(p + 16, 0xffffffffffffffffn, true);
    return ERRNO.SUCESSO;
  },
  fd_seek(fd) { return fd <= 2 ? ERRNO.SPIPE : ERRNO.BADF; },
  fd_close() { return ERRNO.SUCESSO; },
  fd_sync() { return ERRNO.SUCESSO; },
  fd_prestat_get() { return ERRNO.BADF; }, // nenhuma pasta disponível para o programa
  fd_prestat_dir_name() { return ERRNO.BADF; },
  sched_yield() { return ERRNO.SUCESSO; },
  proc_exit(codigo) { throw new SaidaDoPrograma(codigo); },
  // sleep()/usleep(): só os temporizadores (o resto não existe aqui)
  poll_oneoff(pEntrada, pSaida, n, pN) {
    const v = dv();
    let espera = Infinity;
    for (let i = 0; i < n; i++) {
      const s = pEntrada + i * 48;
      if (v.getUint8(s + 8) !== 0) continue;
      const timeout = Number(v.getBigUint64(s + 24, true)) / 1e6;
      const absoluto = (v.getUint16(s + 40, true) & 1) === 1;
      espera = Math.min(espera, absoluto ? timeout - Date.now() : timeout);
    }
    if (espera !== Infinity) dormir(Math.min(espera, 60000));
    let eventos = 0;
    for (let i = 0; i < n; i++) {
      const s = pEntrada + i * 48;
      if (v.getUint8(s + 8) !== 0) continue;
      const e = pSaida + eventos * 32;
      v.setBigUint64(e, v.getBigUint64(s, true), true);
      v.setUint16(e + 8, 0, true);
      v.setUint8(e + 10, 0);
      eventos++;
    }
    v.setUint32(pN, eventos, true);
    return ERRNO.SUCESSO;
  },
};

// qualquer outra chamada do sistema (abrir arquivo, rede...) responde "não suportado"
const importacoes = {
  wasi_snapshot_preview1: new Proxy(wasi, {
    get: (alvo, nome) => (nome in alvo ? alvo[nome] : () => ERRNO.NOSYS),
  }),
};

// erros do WebAssembly em português, do jeito que um aluno de C entende
function explicarErro(e) {
  const msg = String((e && e.message) || e);
  if (/unreachable/i.test(msg)) return 'O programa foi abortado (abort, assert falhou ou erro em tempo de execução).';
  if (/divide by zero/i.test(msg)) return 'Divisão inteira por zero.';
  if (/remainder by zero/i.test(msg)) return 'Resto (%) de divisão por zero.';
  if (/out of bounds/i.test(msg)) return 'Acesso à memória fora dos limites (ponteiro inválido ou vetor acessado além do tamanho).';
  if (/call stack|stack size|too much recursion/i.test(msg)) return 'A pilha estourou: provavelmente uma recursão sem fim.';
  if (/integer overflow/i.test(msg)) return 'Estouro de inteiro numa conversão.';
  if (/out of memory|Cannot allocate/i.test(msg)) return 'Acabou a memória.';
  return 'Erro em tempo de execução: ' + msg;
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.tipo !== 'executar') return;
  if (m.controle) {
    controle = new Int32Array(m.controle);
    textoEntrada = m.texto;
  }
  let codigo = 0;
  let erro = null;
  try {
    const { instance } = await WebAssembly.instantiate(m.wasm, importacoes);
    memoria = instance.exports.memory;
    instance.exports._start();
  } catch (ex) {
    if (ex instanceof SaidaDoPrograma) codigo = ex.codigo;
    else { codigo = -1; erro = explicarErro(ex); }
  }
  for (const fd of [1, 2]) saidaPendente[fd] += decodificadores[fd].decode();
  enviarSaida();
  postMessage({ tipo: 'fim', codigo, erro });
};
