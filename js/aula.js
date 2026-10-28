/*
 * aula.js — a sala de aula em cima do editor.
 *
 * Professor: abre a sala com um código, vê a turma (quem compilou, quem tem erro, quem pediu ajuda),
 * abre o código de qualquer aluno ao vivo e pode editá-lo junto; transmite o próprio código (texto, leve
 * e nítido) e, se quiser, a tela inteira (vídeo, em árvore: ver tela.js).
 * Aluno: entra com o código, programa no próprio editor, acompanha o código e a tela do professor
 * no painel da direita e pode pedir ajuda.
 */
const Aula = (() => {
  const CHAVE_ENTRADA = 'dev_aula_entrada';
  const CHAVE_SESSAO = 'dev_aula_sessao'; // sessionStorage: recarregar a página volta para a mesma aula
  const INTERVALO_PROF_MS = 250;
  const INTERVALO_ALUNO_MS = 700;
  const INTERVALO_EDICAO_MS = 150;
  const MAX_CODIGO = 200000;

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let papel = null; // 'professor' | 'aluno' | 'sozinho'
  let nome = '';
  let codigoSala = '';
  let editorAula = null; // Monaco do painel da direita
  let pronto = false;

  /* ================= Entrada (escolher papel) ================= */

  function init() {
    pronto = true;
    const sessao = lerJSON(sessionStorage, CHAVE_SESSAO);
    if (sessao && sessao.papel) { comecar(sessao.papel, sessao.nome, sessao.sala); return; }
    mostrarEntrada();
  }

  function lerJSON(armazem, chave) {
    try { return JSON.parse(armazem.getItem(chave) || 'null'); } catch { return null; }
  }

  function mostrarEntrada() {
    const salvo = lerJSON(localStorage, CHAVE_ENTRADA) || {};
    const params = new URLSearchParams(location.search);
    const salaLink = Sala.normalizarCodigo(params.get('sala') || '');
    const caixa = $('#entrada');
    const inNome = $('#ent-nome');
    const inSala = $('#ent-sala');
    const bloco = $('#ent-sala-bloco');
    const erro = $('#ent-erro');
    let escolhido = salaLink ? 'aluno' : null;

    inNome.value = salvo.nome || '';
    inSala.value = salaLink || salvo.sala || '';
    caixa.classList.remove('hidden');

    function escolher(p) {
      escolhido = p;
      erro.textContent = '';
      for (const b of caixa.querySelectorAll('[data-papel]')) b.classList.toggle('ativo', b.dataset.papel === p);
      if (p === 'sozinho') { entrar(); return; }
      bloco.classList.remove('hidden');
      $('#ent-sala-rotulo-texto').textContent = p === 'professor' ? 'Código da sala (deixe vazio para gerar um)' : 'Código da sala (o professor informa)';
      $('#ent-entrar').textContent = p === 'professor' ? 'Abrir a sala' : 'Entrar na aula';
      inSala.focus();
    }

    function entrar() {
      const n = inNome.value.trim().slice(0, 30);
      if (!n && escolhido !== 'sozinho') { erro.textContent = 'Digite seu nome.'; inNome.focus(); return; }
      let s = Sala.normalizarCodigo(inSala.value);
      if (escolhido === 'aluno' && s.length < 3) { erro.textContent = 'Digite o código da sala (pelo menos 3 letras ou números).'; inSala.focus(); return; }
      if (escolhido === 'professor' && !s) s = Sala.codigoAleatorio();
      if (escolhido === 'professor' && s.length < 3) { erro.textContent = 'O código precisa ter pelo menos 3 letras ou números.'; return; }
      localStorage.setItem(CHAVE_ENTRADA, JSON.stringify({ nome: n, sala: escolhido === 'sozinho' ? (salvo.sala || '') : s }));
      caixa.classList.add('hidden');
      comecar(escolhido, n, s);
    }

    for (const b of caixa.querySelectorAll('[data-papel]')) b.onclick = () => escolher(b.dataset.papel);
    $('#ent-entrar').onclick = entrar;
    inSala.onkeydown = (e) => { if (e.key === 'Enter') entrar(); };
    inNome.onkeydown = (e) => { if (e.key === 'Enter' && escolhido) entrar(); };
    if (escolhido) escolher(escolhido);
    else inNome.focus();
  }

  function comecar(p, n, s) {
    papel = p;
    nome = n;
    codigoSala = s;
    if (p !== 'sozinho') sessionStorage.setItem(CHAVE_SESSAO, JSON.stringify({ papel: p, nome: n, sala: s }));
    if (p === 'professor') iniciarProfessor();
    else if (p === 'aluno') iniciarAluno();
    else App.definirModo('🧪 Praticando sozinho');
    $('#btn-toggle-aula').classList.toggle('hidden', p === 'sozinho');
  }

  function sairDaAula() {
    sessionStorage.removeItem(CHAVE_SESSAO);
    location.href = location.pathname; // volta para a tela de entrada, sem ?sala=
  }

  function criarEditorAula(container) {
    editorAula = monaco.editor.create(container, {
      theme: 'estudo-dark',
      readOnly: true,
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 3,
      tabSize: 4,
    });
    return editorAula;
  }

  // troca o texto do modelo sem pular o scroll (setValue volta para o topo)
  function atualizarModelo(model, texto) {
    if (model.getValue() === texto) return;
    model.applyEdits([{ range: model.getFullModelRange(), text: texto }]);
  }

  function linguagemDe(arquivo) {
    return Editor.languageFor(arquivo || 'x.c');
  }

  // agenda "f" no máximo a cada "ms" (a última chamada sempre acontece)
  function limitar(f, ms) {
    let timer = null;
    let ultimo = 0;
    return () => {
      if (timer) return;
      const espera = Math.max(0, ms - (Date.now() - ultimo));
      timer = setTimeout(() => { timer = null; ultimo = Date.now(); f(); }, espera);
    };
  }

  /* ================= Professor ================= */

  const prof = {
    sala: null,
    tela: null,
    transmitirCodigo: true,
    alunos: new Map(), // id -> { id, nome, estado, mao, entrou }
    aberto: null,      // id do aluno aberto no detalhe
    controlando: null, // id do aluno cujo código estou editando
    modelos: new Map(), // id -> monaco model
    ultimoEnviado: '',
  };

  function iniciarProfessor() {
    App.definirModo(`👩‍🏫 Professor · sala ${codigoSala}`);
    montarPainelProfessor();
    App.abrirPainelAula(true);
    prof.sala = new Sala.Professor(codigoSala, nome, {
      aoAbrir: () => {
        $('#prof-estado').textContent = 'Sala aberta. Passe o código ou o link para a turma.';
        enviarCodigoProfessor(true);
      },
      aoErro: (tipo) => {
        if (tipo === 'codigo-em-uso') {
          App.toast(`O código "${codigoSala}" já está em uso por outra sala. Escolha outro.`, true);
          sessionStorage.removeItem(CHAVE_SESSAO);
          setTimeout(() => sairDaAula(), 2500);
        } else {
          $('#prof-estado').textContent = 'Problema de conexão (' + tipo + '), tentando de novo...';
        }
      },
      aoAlunoEntrou: (a) => {
        const antigo = [...prof.alunos.values()].find((x) => x.nome === a.nome && !prof.sala.alunos.has(x.id));
        if (antigo) prof.alunos.delete(antigo.id); // o mesmo aluno voltou (recarregou a página): não duplica
        prof.alunos.set(a.id, { id: a.id, nome: a.nome, estado: null, mao: false, entrou: Date.now() });
        prof.sala.enviar(a.id, { t: 'boas-vindas', professor: nome, tela: !!(prof.tela && prof.tela.ativa) });
        prof.ultimoEnviado = '';
        enviarCodigoProfessor(true);
        if (prof.tela) prof.tela.alunoEntrou(a.id);
        renderLista();
      },
      aoAlunoSaiu: (a) => {
        if (prof.tela) prof.tela.alunoSaiu(a.id);
        if (prof.controlando === a.id) prof.controlando = null;
        prof.alunos.delete(a.id);
        const modelo = prof.modelos.get(a.id);
        if (modelo && prof.aberto !== a.id) { modelo.dispose(); prof.modelos.delete(a.id); }
        if (prof.aberto === a.id) renderDetalhe();
        renderLista();
      },
      aoMensagem: (a, m) => tratarMensagemAluno(a, m),
    });
    prof.tela = new Tela.TransmissaoProfessor(prof.sala, () => atualizarBotaoTela());
  }

  function montarPainelProfessor() {
    $('#aula-titulo').textContent = '👥 Turma';
    const link = `${location.origin}${location.pathname}?sala=${codigoSala}`;
    $('#aula-corpo').innerHTML = `
      <div class="prof-topo">
        <div class="prof-sala">
          <span class="rotulo">Código da sala</span>
          <span class="codigo-sala">${esc(codigoSala)}</span>
        </div>
        <div class="prof-botoes">
          <button class="aula-btn" id="prof-link" title="${esc(link)}">🔗 Copiar link</button>
          <button class="aula-btn" id="prof-tela">🖥️ Compartilhar tela</button>
          <button class="aula-btn ativo" id="prof-codigo" title="Os alunos veem o seu arquivo aberto, ao vivo">📡 Transmitindo código</button>
          <button class="aula-btn" id="prof-sair">🚪 Encerrar</button>
        </div>
        <div id="prof-estado" class="aula-estado">Abrindo a sala...</div>
      </div>
      <div id="prof-resumo" class="prof-resumo"></div>
      <div id="prof-lista" class="prof-lista"></div>
      <div id="prof-detalhe" class="aula-detalhe hidden">
        <div class="detalhe-topo">
          <button class="aula-btn" id="det-voltar">⬅ Turma</button>
          <span id="det-nome" class="det-nome"></span>
          <span id="det-status" class="det-status"></span>
        </div>
        <div class="detalhe-botoes">
          <button class="aula-btn" id="det-editar">✍️ Editar o código dele</button>
          <button class="aula-btn hidden" id="det-mao">✋ Baixar a mão</button>
          <span id="det-arquivo" class="det-arquivo"></span>
        </div>
        <div id="aula-editor" class="aula-editor"></div>
        <div class="saida-titulo">Terminal do aluno</div>
        <pre id="det-saida" class="aula-saida"></pre>
      </div>`;
    $('#prof-link').onclick = () => {
      navigator.clipboard.writeText(link).then(() => App.toast('Link da aula copiado: ' + link), () => App.toast(link));
    };
    $('#prof-sair').onclick = async () => {
      if (prof.sala) prof.sala.transmitir({ t: 'aula-encerrada' });
      sairDaAula();
    };
    $('#prof-codigo').onclick = () => {
      prof.transmitirCodigo = !prof.transmitirCodigo;
      $('#prof-codigo').classList.toggle('ativo', prof.transmitirCodigo);
      $('#prof-codigo').textContent = prof.transmitirCodigo ? '📡 Transmitindo código' : '📡 Código pausado';
      if (prof.transmitirCodigo) { prof.ultimoEnviado = ''; enviarCodigoProfessor(true); }
      else prof.sala.transmitir({ t: 'prof-codigo', pausado: true });
    };
    $('#prof-tela').onclick = async () => {
      if (prof.tela.ativa) { prof.tela.parar(); return; }
      try {
        await prof.tela.iniciar();
        atualizarBotaoTela();
      } catch (e) {
        if (e && e.name !== 'NotAllowedError') App.toast('Não foi possível compartilhar a tela: ' + (e.message || e), true);
      }
    };
    $('#det-voltar').onclick = () => abrirAluno(null);
    $('#det-editar').onclick = () => alternarControle();
    $('#det-mao').onclick = () => {
      const a = prof.alunos.get(prof.aberto);
      if (!a) return;
      a.mao = false;
      prof.sala.enviar(a.id, { t: 'mao-baixada' });
      renderDetalhe();
      renderLista();
    };
    criarEditorAula($('#aula-editor'));
    editorAula.onDidChangeModelContent(() => { if (prof.controlando && prof.controlando === prof.aberto) enviarEdicao(); });
    renderLista();
  }

  function atualizarBotaoTela() {
    const b = $('#prof-tela');
    if (!b) return;
    const ativa = prof.tela && prof.tela.ativa;
    b.textContent = ativa ? '⏹️ Parar tela' : '🖥️ Compartilhar tela';
    b.classList.toggle('perigo', ativa);
  }

  function tratarMensagemAluno(a, m) {
    const aluno = prof.alunos.get(a.id);
    if (!aluno) return;
    if (m.t === 'estado') {
      aluno.estado = m;
      if (prof.aberto === a.id) renderDetalhe();
      renderListaLimitado();
    } else if (m.t === 'mao') {
      const antes = aluno.mao;
      aluno.mao = !!m.ativa;
      if (aluno.mao && !antes) App.toast(`✋ ${aluno.nome} pediu ajuda.`);
      if (prof.aberto === a.id) renderDetalhe();
      renderLista();
    }
  }

  const STATUS = {
    editando: ['cinza', 'editando'],
    compilando: ['azul', 'compilando'],
    rodando: ['azul', 'executando'],
    ok: ['verde', 'compilou e rodou'],
    erro: ['vermelho', 'erro de compilação'],
    'erro-execucao': ['laranja', 'erro ao executar'],
  };

  function descreverStatus(estado) {
    if (!estado) return ['cinza', 'conectado'];
    const [cor, texto] = STATUS[estado.status] || STATUS.editando;
    const erros = (estado.erros || []).filter((e) => e.nivel === 'erro').length;
    return [cor, estado.status === 'erro' && erros ? `${erros} erro(s) de compilação` : texto];
  }

  const renderListaLimitado = limitar(() => renderLista(), 400);

  function renderLista() {
    const lista = $('#prof-lista');
    if (!lista) return;
    const alunos = [...prof.alunos.values()].sort((x, y) => (y.mao - x.mao) || x.nome.localeCompare(y.nome, 'pt-BR'));
    const maos = alunos.filter((a) => a.mao).length;
    const comErro = alunos.filter((a) => a.estado && (a.estado.status === 'erro' || a.estado.status === 'erro-execucao')).length;
    const ok = alunos.filter((a) => a.estado && a.estado.status === 'ok').length;
    $('#prof-resumo').innerHTML = alunos.length
      ? `<b>${alunos.length}</b> aluno(s) · <span class="verde">● ${ok} ok</span> · <span class="vermelho">● ${comErro} com erro</span>${maos ? ` · ✋ <b>${maos}</b> pedindo ajuda` : ''}`
      : 'Nenhum aluno conectado ainda.';
    lista.innerHTML = alunos.map((a) => {
      const [cor, texto] = descreverStatus(a.estado);
      return `<div class="aluno-card${a.mao ? ' mao' : ''}${prof.controlando === a.id ? ' controlando' : ''}" data-id="${esc(a.id)}">
        <span class="ponto ${cor}"></span>
        <span class="aluno-nome">${a.mao ? '✋ ' : ''}${esc(a.nome)}</span>
        <span class="aluno-status">${esc(texto)}</span>
      </div>`;
    }).join('');
    for (const card of lista.querySelectorAll('.aluno-card')) card.onclick = () => abrirAluno(card.dataset.id);
  }

  function abrirAluno(id) {
    if (prof.controlando && prof.controlando !== id) soltarControle();
    prof.aberto = id;
    $('#prof-lista').classList.toggle('hidden', !!id);
    $('#prof-resumo').classList.toggle('hidden', !!id);
    $('#prof-detalhe').classList.toggle('hidden', !id);
    if (id) renderDetalhe();
    else renderLista();
  }

  function renderDetalhe() {
    const id = prof.aberto;
    const a = id && prof.alunos.get(id);
    if (!id) return;
    if (!a) {
      $('#det-nome').textContent = 'Aluno saiu da aula';
      $('#det-status').textContent = '';
      return;
    }
    const [cor, texto] = descreverStatus(a.estado);
    $('#det-nome').textContent = a.nome;
    $('#det-status').innerHTML = `<span class="ponto ${cor}"></span> ${esc(texto)}`;
    $('#det-mao').classList.toggle('hidden', !a.mao);
    const controlando = prof.controlando === id;
    $('#det-editar').textContent = controlando ? '↩️ Devolver o editor' : '✍️ Editar o código dele';
    $('#det-editar').classList.toggle('perigo', controlando);
    const e = a.estado || { arquivo: '', codigo: '', linguagem: 'c', saida: '', erros: [] };
    $('#det-arquivo').textContent = e.arquivo ? '📄 ' + e.arquivo : '';

    let modelo = prof.modelos.get(id);
    if (!modelo || modelo.getLanguageId() !== (e.linguagem || 'c')) {
      if (modelo) modelo.dispose();
      modelo = monaco.editor.createModel(e.codigo || '', e.linguagem || 'c');
      prof.modelos.set(id, modelo);
    }
    if (editorAula.getModel() !== modelo) editorAula.setModel(modelo);
    if (!controlando) atualizarModelo(modelo, e.codigo || '');
    editorAula.updateOptions({ readOnly: !controlando });
    monaco.editor.setModelMarkers(modelo, 'aluno', (e.erros || [])
      .filter((x) => x.arquivo === e.arquivo && x.nivel !== 'nota')
      .map((x) => ({
        startLineNumber: x.linha, startColumn: x.coluna, endLineNumber: x.linha, endColumn: x.coluna + 1,
        message: x.dica ? `${x.mensagem}\n💡 ${x.dica}` : x.mensagem,
        severity: x.nivel === 'erro' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      })));
    const saida = $('#det-saida');
    if (saida.textContent !== (e.saida || '')) {
      saida.textContent = e.saida || '';
      saida.scrollTop = saida.scrollHeight;
    }
  }

  function alternarControle() {
    if (prof.controlando === prof.aberto) { soltarControle(); return; }
    const a = prof.alunos.get(prof.aberto);
    if (!a || !a.estado || !a.estado.arquivo) { App.toast('Espere o código do aluno aparecer.', true); return; }
    prof.controlando = a.id;
    prof.arquivoControle = a.estado.arquivo;
    prof.sala.enviar(a.id, { t: 'controle', ativo: true, arquivo: a.estado.arquivo, professor: nome });
    renderDetalhe();
    renderLista();
    editorAula.focus();
  }

  function soltarControle() {
    const id = prof.controlando;
    if (!id) return;
    enviarEdicaoAgora();
    prof.controlando = null;
    prof.sala.enviar(id, { t: 'controle', ativo: false });
    renderDetalhe();
    renderLista();
  }

  function enviarEdicaoAgora() {
    const id = prof.controlando;
    const modelo = id && prof.modelos.get(id);
    if (!modelo) return;
    prof.sala.enviar(id, { t: 'prof-edita', arquivo: prof.arquivoControle, codigo: modelo.getValue() });
  }
  const enviarEdicao = limitar(enviarEdicaoAgora, INTERVALO_EDICAO_MS);

  // o arquivo aberto do professor (e o terminal dele) para toda a turma
  function enviarCodigoProfessor(forcar) {
    if (!prof.sala || !prof.transmitirCodigo) return;
    const e = App.estadoAtual();
    const msg = {
      t: 'prof-codigo',
      arquivo: e.arquivo,
      linguagem: e.linguagem,
      codigo: (e.codigo || '').slice(0, MAX_CODIGO),
      cursor: e.cursor,
      saida: Terminal.textoRecente(3000),
    };
    const chave = JSON.stringify(msg);
    if (!forcar && chave === prof.ultimoEnviado) return;
    prof.ultimoEnviado = chave;
    prof.sala.transmitir(msg);
  }
  const enviarCodigoProfessorLimitado = limitar(() => enviarCodigoProfessor(false), INTERVALO_PROF_MS);

  /* ================= Aluno ================= */

  const aluno = {
    sala: null,
    tela: null,
    mao: false,
    nomeProfessor: 'Professor',
    modelo: null,
    decoracoes: [],
    aba: 'codigo',
    travado: false,
  };

  function iniciarAluno() {
    App.definirModo(`🎒 ${nome} · sala ${codigoSala}`);
    montarPainelAluno();
    App.abrirPainelAula(true);
    aluno.sala = new Sala.Aluno(codigoSala, nome, {
      aoConectar: () => {
        definirConexao('conectado', 'Conectado à aula');
        enviarEstadoAluno();
        if (aluno.mao) aluno.sala.enviar({ t: 'mao', ativa: true });
      },
      aoDesconectar: () => {
        definirConexao('desconectado', 'Conexão com o professor perdida, tentando de novo...');
        if (aluno.travado) destravar();
        aluno.tela.encerrar();
      },
      aoEstado: (texto) => definirConexao('tentando', texto),
      aoMensagem: (m) => tratarMensagemProfessor(m),
      aoChamada: (call) => aluno.tela.receberChamada(call),
    });
    aluno.tela = new Tela.RecepcaoAluno(aluno.sala, (stream, aguardando) => mostrarVideo(stream, aguardando));
  }

  function montarPainelAluno() {
    $('#aula-titulo').textContent = '👩‍🏫 Professor';
    $('#aula-corpo').innerHTML = `
      <div class="aluno-topo">
        <span id="aluno-conexao" class="aula-estado"><span class="ponto cinza"></span> Conectando...</span>
        <div class="prof-botoes">
          <button class="aula-btn" id="aluno-mao">✋ Pedir ajuda</button>
          <button class="aula-btn" id="aluno-sair">🚪 Sair</button>
        </div>
      </div>
      <div class="aula-abas">
        <button class="aula-aba ativo" data-aba="codigo">📄 Código do professor</button>
        <button class="aula-aba" data-aba="tela">🖥️ Tela do professor <span id="aba-tela-ponto" class="ponto vermelho hidden"></span></button>
      </div>
      <div id="aba-codigo" class="aula-aba-corpo">
        <div class="detalhe-botoes">
          <span id="prof-arquivo" class="det-arquivo">Aguardando o professor...</span>
          <button class="aula-btn" id="aluno-copiar" title="Cria um arquivo no seu projeto com este código">📋 Copiar para meu projeto</button>
        </div>
        <div id="aula-editor" class="aula-editor"></div>
        <div class="saida-titulo">Terminal do professor</div>
        <pre id="prof-saida" class="aula-saida"></pre>
      </div>
      <div id="aba-tela" class="aula-aba-corpo hidden">
        <div class="tela-caixa">
          <video id="aula-video" autoplay playsinline muted></video>
          <div id="tela-msg" class="tela-msg">O professor não está compartilhando a tela agora.</div>
        </div>
        <div class="detalhe-botoes"><button class="aula-btn" id="tela-cheia">⛶ Ver em tela cheia</button></div>
      </div>`;
    for (const b of document.querySelectorAll('.aula-aba')) b.onclick = () => mostrarAba(b.dataset.aba);
    $('#aluno-sair').onclick = sairDaAula;
    $('#aluno-mao').onclick = () => definirMao(!aluno.mao);
    $('#aluno-copiar').onclick = () => {
      if (!aluno.modelo || !aluno.modelo.getValue()) return;
      App.copiarParaProjeto(aluno.arquivoProfessor, aluno.modelo.getValue());
    };
    $('#tela-cheia').onclick = () => {
      const v = $('#aula-video');
      if (v.requestFullscreen) v.requestFullscreen().catch(() => {});
    };
    criarEditorAula($('#aula-editor'));
    aluno.modelo = monaco.editor.createModel('', 'c');
    editorAula.setModel(aluno.modelo);
  }

  function mostrarAba(aba) {
    aluno.aba = aba;
    for (const b of document.querySelectorAll('.aula-aba')) b.classList.toggle('ativo', b.dataset.aba === aba);
    $('#aba-codigo').classList.toggle('hidden', aba !== 'codigo');
    $('#aba-tela').classList.toggle('hidden', aba !== 'tela');
    if (aba === 'tela') $('#aba-tela-ponto').classList.add('hidden');
  }

  function definirConexao(tipo, texto) {
    const cor = { conectado: 'verde', desconectado: 'vermelho', tentando: 'laranja' }[tipo] || 'cinza';
    const el = $('#aluno-conexao');
    if (el) el.innerHTML = `<span class="ponto ${cor}"></span> ${esc(texto)}`;
  }

  function definirMao(ativa) {
    aluno.mao = ativa;
    const b = $('#aluno-mao');
    b.textContent = ativa ? '✋ Ajuda pedida (cancelar)' : '✋ Pedir ajuda';
    b.classList.toggle('ativo', ativa);
    aluno.sala.enviar({ t: 'mao', ativa });
  }

  function tratarMensagemProfessor(m) {
    if (m.t === 'boas-vindas') {
      aluno.nomeProfessor = m.professor || 'Professor';
      definirConexao('conectado', `Conectado à aula de ${aluno.nomeProfessor}`);
      $('#aula-titulo').textContent = '👩‍🏫 ' + aluno.nomeProfessor;
    } else if (m.t === 'prof-codigo') {
      mostrarCodigoProfessor(m);
    } else if (m.t === 'controle') {
      if (m.ativo) {
        aluno.travado = true;
        App.travarEditor(true, m.professor || aluno.nomeProfessor);
        if (m.arquivo) App.abrirArquivo(m.arquivo);
      } else destravar();
    } else if (m.t === 'prof-edita') {
      if (aluno.travado && typeof m.codigo === 'string') App.aplicarCodigoExterno(m.arquivo, m.codigo);
    } else if (m.t === 'mao-baixada') {
      if (aluno.mao) { aluno.mao = false; definirMao(false); }
    } else if (m.t === 'aula-encerrada') {
      App.toast('O professor encerrou a aula.');
      definirConexao('desconectado', 'O professor encerrou a aula.');
    } else if (m.t && m.t.startsWith('tela-')) {
      aluno.tela.mensagem(m);
    }
  }

  function destravar() {
    aluno.travado = false;
    App.travarEditor(false);
    enviarEstadoAluno();
  }

  function mostrarCodigoProfessor(m) {
    if (m.pausado) { $('#prof-arquivo').textContent = '⏸️ O professor pausou a transmissão do código.'; return; }
    aluno.arquivoProfessor = m.arquivo;
    $('#prof-arquivo').textContent = m.arquivo ? '📄 ' + m.arquivo : 'O professor não tem arquivo aberto.';
    const lang = m.linguagem || linguagemDe(m.arquivo);
    if (aluno.modelo.getLanguageId() !== lang) monaco.editor.setModelLanguage(aluno.modelo, lang);
    atualizarModelo(aluno.modelo, m.codigo || '');
    // destaca a linha onde está o cursor do professor e a mantém à vista
    if (m.cursor && m.cursor.linha) {
      aluno.decoracoes = editorAula.deltaDecorations(aluno.decoracoes, [{
        range: new monaco.Range(m.cursor.linha, 1, m.cursor.linha, 1),
        options: { isWholeLine: true, className: 'linha-professor', glyphMarginClassName: 'margem-professor' },
      }]);
      editorAula.revealLineInCenterIfOutsideViewport(m.cursor.linha);
    }
    const saida = $('#prof-saida');
    if (saida.textContent !== (m.saida || '')) {
      saida.textContent = m.saida || '';
      saida.scrollTop = saida.scrollHeight;
    }
  }

  function mostrarVideo(stream, aguardando) {
    const v = $('#aula-video');
    const msg = $('#tela-msg');
    if (stream) {
      v.srcObject = stream;
      v.play().catch(() => {});
      msg.classList.add('hidden');
      if (aluno.aba !== 'tela') mostrarAba('tela');
    } else if (aguardando) {
      msg.textContent = 'O professor começou a compartilhar a tela. Conectando ao vídeo...';
      msg.classList.remove('hidden');
      if (aluno.aba !== 'tela') { $('#aba-tela-ponto').classList.remove('hidden'); mostrarAba('tela'); }
    } else {
      v.srcObject = null;
      msg.textContent = 'O professor não está compartilhando a tela agora.';
      msg.classList.remove('hidden');
      if (aluno.aba === 'tela') mostrarAba('codigo');
    }
  }

  function enviarEstadoAluno() {
    if (!aluno.sala) return;
    const e = App.estadoAtual();
    const x = App.execucao();
    aluno.sala.enviar({
      t: 'estado',
      arquivo: e.arquivo,
      linguagem: e.linguagem,
      codigo: (e.codigo || '').slice(0, MAX_CODIGO),
      status: x.status,
      erros: x.erros,
      saida: Terminal.textoRecente(3000),
    });
  }
  const enviarEstadoAlunoLimitado = limitar(enviarEstadoAluno, INTERVALO_ALUNO_MS);

  /* ================= Ganchos chamados pelo app.js ================= */

  function aoMudanca() {
    if (!pronto) return;
    if (papel === 'professor') enviarCodigoProfessorLimitado();
    else if (papel === 'aluno') enviarEstadoAlunoLimitado(); // durante a edição do professor ele ignora o código que volta
  }

  return {
    init,
    aoCodigoMudou: aoMudanca,
    aoCursorMudou: () => { if (pronto && papel === 'professor') enviarCodigoProfessorLimitado(); },
    aoExecucao: () => { if (pronto && papel === 'aluno') enviarEstadoAluno(); else aoMudanca(); },
    aoTerminalMudou: aoMudanca,
  };
})();
