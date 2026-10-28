/*
 * Terminal: mostra a saída dos programas (C e Python) e recebe a entrada (scanf/input) na mesma linha,
 * como um console de verdade. Ctrl+D (ou Ctrl+Z) no campo de entrada envia "fim de arquivo".
 */
const Terminal = (() => {
  const MAX_TRECHOS = 3000;     // trechos de texto guardados (o mais antigo sai primeiro)
  const MAX_POR_TRECHO = 16000; // depois disso, começa um trecho novo (concatenar texto enorme fica lento)

  let el = null;
  let entradaAtual = null; // { input, resolver }
  let aoMudar = () => {};

  function init(elemento, { onChange } = {}) {
    el = elemento;
    if (onChange) aoMudar = onChange;
    el.addEventListener('click', () => { if (entradaAtual && !window.getSelection().toString()) entradaAtual.input.focus(); });
  }

  function rolar() {
    el.scrollTop = el.scrollHeight;
  }

  function podar() {
    while (el.childNodes.length > MAX_TRECHOS) el.removeChild(el.firstChild);
  }

  // tipo: stdout | stderr | sistema | aviso | dica | entrada
  function escrever(texto, tipo = 'stdout') {
    if (!texto) return;
    const ultimo = el.lastChild;
    if (ultimo && ultimo.nodeType === 1 && ultimo.dataset.tipo === tipo && ultimo.textContent.length < MAX_POR_TRECHO && !entradaAtual) {
      ultimo.textContent += texto;
    } else {
      const span = document.createElement('span');
      span.dataset.tipo = tipo;
      span.className = 't-' + tipo;
      span.textContent = texto;
      if (entradaAtual) el.insertBefore(span, entradaAtual.input);
      else el.appendChild(span);
    }
    podar();
    rolar();
    aoMudar();
  }

  function terminaComQuebra() {
    const t = el.lastChild ? el.lastChild.textContent : '';
    return t === '' || t.endsWith('\n');
  }

  // mensagem do próprio ambiente (sempre numa linha própria)
  function linha(texto, tipo = 'sistema') {
    if (!terminaComQuebra()) escrever('\n', tipo);
    escrever(texto + '\n', tipo);
  }

  // resolve com a linha digitada (com "\n") ou null no fim da entrada
  function pedirEntrada() {
    cancelarEntrada();
    return new Promise((resolver) => {
      const input = document.createElement('input');
      input.className = 't-campo';
      input.spellcheck = false;
      input.autocomplete = 'off';
      el.appendChild(input);
      entradaAtual = { input, resolver };
      rolar();
      input.focus();
      aoMudar(); // quem acompanha de longe (professor/colega) fica sabendo que o programa espera entrada
      input.addEventListener('keydown', (e) => {
        const fim = e.ctrlKey && (e.key === 'd' || e.key === 'D' || e.key === 'z' || e.key === 'Z');
        if (e.key !== 'Enter' && !fim) return;
        e.preventDefault();
        const valor = input.value;
        input.remove();
        entradaAtual = null;
        if (fim) {
          if (valor) { escrever(valor, 'entrada'); resolver(valor); } else { escrever('^D\n', 'sistema'); resolver(null); }
          return;
        }
        escrever(valor + '\n', 'entrada');
        resolver(valor + '\n');
      });
    });
  }

  // entrada digitada por quem está ajudando (professor ou colega), como se fosse aqui
  function enviarEntrada(texto) {
    if (!entradaAtual) return false;
    const { input, resolver } = entradaAtual;
    input.remove();
    entradaAtual = null;
    const linhaDigitada = String(texto).replace(/\r?\n$/, '') + '\n';
    escrever(linhaDigitada, 'entrada');
    resolver(linhaDigitada);
    return true;
  }

  function aguardandoEntrada() {
    return !!entradaAtual;
  }

  function cancelarEntrada() {
    if (!entradaAtual) return;
    const { input, resolver } = entradaAtual;
    input.remove();
    entradaAtual = null;
    resolver(null);
  }

  function limpar() {
    cancelarEntrada();
    el.innerHTML = '';
    aoMudar();
  }

  // últimos caracteres do terminal (enviados ao professor / aos alunos)
  function textoRecente(max = 4000) {
    const t = el.textContent;
    return t.length > max ? t.slice(-max) : t;
  }

  return { init, escrever, linha, pedirEntrada, enviarEntrada, aguardandoEntrada, cancelarEntrada, limpar, textoRecente };
})();
