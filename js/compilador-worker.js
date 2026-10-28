/*
 * Worker (módulo) que compila C com o Clang de verdade (LLVM em WebAssembly, pacote @yowasp/clang).
 *
 * O compilador pesa ~105 MB. Para não depender de o servidor comprimir .wasm, os arquivos ficam no
 * site já comprimidos (.gz, ~27 MB no total) e são descomprimidos aqui. Depois do primeiro download
 * eles ficam guardados no Cache Storage do navegador: nas próximas aulas o compilador abre na hora.
 */
const VERSAO_CLANG = '22.0.0-git20542-10';
const CACHE = 'dev-clang-' + VERSAO_CLANG;
// tamanho somado dos .gz (para a barra de progresso)
const TOTAL_GZ = 26919951;

const fetchOriginal = self.fetch.bind(self);
let baixados = 0;

function avisarProgresso() {
  postMessage({ tipo: 'progresso', feito: baixados, total: TOTAL_GZ });
}

// conta os bytes comprimidos que chegam (rede ou cache) para a barra de progresso
function contar(stream) {
  return stream.pipeThrough(new TransformStream({
    transform(pedaco, ctrl) {
      baixados += pedaco.length;
      avisarProgresso();
      ctrl.enqueue(pedaco);
    },
  }));
}

// o pacote busca clang/*.wasm e clang/*.tar: entrega a versão .gz já descomprimida
self.fetch = async (entrada, init) => {
  const url = new URL(typeof entrada === 'string' || entrada instanceof URL ? entrada : entrada.url, self.location.href);
  if (!/\/clang\/[^/]+\.(wasm|tar)$/.test(url.pathname)) return fetchOriginal(entrada, init);
  const urlGz = url.href + '.gz';
  const cache = await caches.open(CACHE).catch(() => null);
  let resp = cache ? await cache.match(urlGz) : undefined;
  if (!resp) {
    resp = await fetchOriginal(urlGz);
    if (!resp.ok) throw new Error(`Não consegui baixar o compilador (${url.pathname.split('/').pop()}: HTTP ${resp.status}).`);
    if (cache) {
      try { await cache.put(urlGz, resp.clone()); } catch { /* sem espaço: segue sem guardar */ }
    }
  }
  const corpo = contar(resp.body).pipeThrough(new DecompressionStream('gzip'));
  const tipo = url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/x-tar';
  return new Response(corpo, { headers: { 'Content-Type': tipo } });
};

let clang = null; // { runClang, Exit }
let preparando = null;

function preparar() {
  if (!preparando) {
    preparando = (async () => {
      clang = await import('../clang/bundle.js');
      // roda uma vez sem argumentos de compilação: baixa e compila o LLVM agora, não na primeira compilação do aluno
      await clang.runClang(['clang', '--version'], {}, { stdout: null, stderr: null, fetchProgress: () => {} });
      postMessage({ tipo: 'pronto' });
    })().catch((e) => {
      preparando = null;
      postMessage({ tipo: 'falha-preparo', erro: String((e && e.message) || e) });
      throw e;
    });
  }
  return preparando;
}

// liga o stdout dos programas (sem buffer) antes do main(): sem isto, printf("Digite: ") sem "\n"
// só apareceria depois do scanf
const PRELUDIO = `#include <stdio.h>
__attribute__((constructor)) static void __dev_sem_buffer(void) { setvbuf(stdout, 0, _IONBF, 0); }
`;

const decodificador = new TextDecoder();

async function compilar({ id, arvore, fontes }) {
  try {
    await preparar();
  } catch (e) {
    postMessage({ tipo: 'resultado', id, ok: false, saida: '', erroInterno: String((e && e.message) || e) });
    return;
  }
  let saida = '';
  const juntar = (bytes) => { if (bytes) saida += decodificador.decode(bytes, { stream: true }); };
  const arquivos = { ...arvore, '__dev_preludio.c': PRELUDIO };
  const args = ['clang', '-std=gnu17', '-Wall', '-O0', '-fdiagnostics-color=never',
    ...fontes, '__dev_preludio.c', '-o', '__dev_programa.wasm', '-lm'];
  const inicio = performance.now();
  try {
    const resultado = await clang.runClang(args, arquivos, { stdout: juntar, stderr: juntar, decodeASCII: false });
    const wasm = resultado['__dev_programa.wasm'];
    postMessage({ tipo: 'resultado', id, ok: true, saida, wasm, ms: performance.now() - inicio }, [wasm.buffer]);
  } catch (e) {
    if (e instanceof clang.Exit) {
      postMessage({ tipo: 'resultado', id, ok: false, saida, ms: performance.now() - inicio });
    } else {
      postMessage({ tipo: 'resultado', id, ok: false, saida, erroInterno: String((e && e.message) || e) });
    }
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.tipo === 'preparar') preparar().catch(() => {});
  else if (m.tipo === 'compilar') compilar(m);
};
