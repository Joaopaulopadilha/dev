/*
 * app.js — orquestra a UI: explorador de arquivos, abas, toolbar, terminal, compilar/executar
 * (C com Clang, Python com Pyodide), redimensionamento de painéis, modais e barra de status.
 * A parte de aula (professor/alunos) fica em aula.js e conversa com este arquivo pelo objeto App.
 */
(function () {
  // O Monaco cancela pedidos internos obsoletos e isso aparece como "Uncaught (in promise) Canceled".
  function isCanceledNoise(err) {
    return !!err && err.message === 'Canceled';
  }
  window.addEventListener('unhandledrejection', (e) => { if (isCanceledNoise(e.reason)) e.preventDefault(); });
  window.addEventListener('error', (e) => { if (isCanceledNoise(e.error)) e.preventDefault(); });

  const state = {
    expanded: new Set(['root']),
    selectedId: null,
    creating: null, // { parentId, type }
    renamingId: null,
    projectName: 'aula',
    terminalOpen: true,
    sidebarOpen: true,
    aulaOpen: false,
    travado: false,       // o professor está editando o código deste aluno
    rodando: false,
    executor: null,       // 'c' | 'python': quem está rodando agora (o Parar só encerra esse)
  };

  // última execução (vai para o professor no painel da turma)
  const execucao = { status: 'editando', erros: [] };

  const saveTimers = new Map();
  const $ = (sel) => document.querySelector(sel);
  const el = {};

  function cacheEls() {
    el.appBody = $('#app-body');
    el.sidebar = $('#sidebar');
    el.resizer1 = $('#resizer-1');
    el.btnToggleSidebar = $('#btn-toggle-sidebar');
    el.btnFullscreen = $('#btn-fullscreen');
    el.tree = $('#file-tree');
    el.tabs = $('#tabs');
    el.monacoContainer = $('#monaco-container');
    el.statusMode = $('#status-mode');
    el.statusLang = $('#status-lang');
    el.statusMsg = $('#status-msg');
    el.statusCompilador = $('#status-compilador');
    el.projectNameLabel = $('#project-name');
    el.importInput = $('#import-input');
    el.modalOverlay = $('#modal-overlay');
    el.modalTitle = $('#modal-title');
    el.modalInput = $('#modal-input');
    el.modalError = $('#modal-error');
    el.modalOk = $('#modal-ok');
    el.modalCancel = $('#modal-cancel');
    el.contextMenu = $('#context-menu');
    el.toast = $('#toast');
    el.aulaPane = $('#aula-pane');
    el.resizer2 = $('#resizer-2');
    el.resizer3 = $('#resizer-3');
    el.terminalPanel = $('#terminal-panel');
    el.terminal = $('#terminal');
    el.btnRun = $('#btn-run');
    el.btnStop = $('#btn-stop');
    el.btnRunTerminal = $('#btn-run-terminal');
    el.btnStopTerminal = $('#btn-stop-terminal');
    el.bannerTravado = $('#banner-travado');
  }

  /* ---------------- Utilidades de UI ---------------- */

  function showToast(message, isError) {
    el.toast.textContent = message;
    el.toast.classList.toggle('error', !!isError);
    el.toast.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.toast.classList.add('hidden'), 4000);
  }

  function setStatusMsg(msg) {
    el.statusMsg.textContent = msg;
    clearTimeout(setStatusMsg._t);
    setStatusMsg._t = setTimeout(() => { el.statusMsg.textContent = ''; }, 2500);
  }

  function openModal({ title, value = '', placeholder = '', mode = 'prompt', okLabel }) {
    return new Promise((resolve) => {
      el.modalTitle.textContent = title;
      el.modalError.textContent = '';
      el.modalInput.style.display = mode === 'confirm' ? 'none' : 'block';
      el.modalInput.value = value;
      el.modalInput.placeholder = placeholder;
      el.modalOverlay.classList.remove('hidden');
      if (mode !== 'confirm') setTimeout(() => { el.modalInput.focus(); el.modalInput.select(); }, 0);

      function cleanup(result) {
        el.modalOverlay.classList.add('hidden');
        el.modalOk.removeEventListener('click', onOk);
        el.modalCancel.removeEventListener('click', onCancel);
        el.modalInput.removeEventListener('keydown', onKeydown);
        resolve(result);
      }
      function onOk() {
        if (mode === 'confirm') return cleanup(true);
        const val = el.modalInput.value.trim();
        if (!val) { el.modalError.textContent = 'Digite um nome.'; return; }
        cleanup(val);
      }
      function onCancel() { cleanup(mode === 'confirm' ? false : null); }
      function onKeydown(e) {
        if (e.key === 'Enter') onOk();
        if (e.key === 'Escape') onCancel();
      }
      el.modalOk.textContent = okLabel || (mode === 'confirm' ? 'Excluir' : 'OK');
      el.modalOk.addEventListener('click', onOk);
      el.modalCancel.addEventListener('click', onCancel);
      el.modalInput.addEventListener('keydown', onKeydown);
    });
  }

  function confirmAction(title, okLabel) {
    return openModal({ title, mode: 'confirm', okLabel });
  }

  function hideContextMenu() {
    el.contextMenu.classList.add('hidden');
    el.contextMenu.innerHTML = '';
  }

  function showContextMenu(x, y, items) {
    el.contextMenu.innerHTML = '';
    for (const item of items) {
      if (item === '-') {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        el.contextMenu.appendChild(sep);
        continue;
      }
      const div = document.createElement('div');
      div.className = 'ctx-item' + (item.danger ? ' danger' : '');
      div.textContent = item.label;
      div.addEventListener('click', () => { hideContextMenu(); item.action(); });
      el.contextMenu.appendChild(div);
    }
    el.contextMenu.style.left = x + 'px';
    el.contextMenu.style.top = y + 'px';
    el.contextMenu.classList.remove('hidden');
  }

  document.addEventListener('click', hideContextMenu);
  window.addEventListener('blur', hideContextMenu);

  // menu do navegador só dentro dos editores (copiar/colar); no resto usamos menus próprios
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest && (e.target.closest('.monaco-editor') || e.target.closest('#terminal') || e.target.closest('input'))) return;
    e.preventDefault();
  });

  function isNarrowScreen() {
    return window.matchMedia('(max-width: 800px)').matches;
  }

  function setSidebarOpen(open) {
    state.sidebarOpen = open;
    el.sidebar.classList.toggle('hidden', !open);
    el.resizer1.classList.toggle('hidden', !open);
    el.appBody.classList.toggle('sidebar-open', open);
  }

  function toggleSidebar() {
    setSidebarOpen(!state.sidebarOpen);
  }

  function closeMobileSidebar() {
    if (isNarrowScreen()) setSidebarOpen(false);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  document.addEventListener('fullscreenchange', () => {
    el.btnFullscreen.textContent = document.fullscreenElement ? '⛶ Sair' : '⛶';
  });

  function setupTreeContextMenu() {
    el.tree.addEventListener('contextmenu', (e) => {
      if (e.target !== el.tree) return;
      e.preventDefault();
      state.selectedId = null;
      renderTree();
      showContextMenu(e.clientX, e.clientY, [
        { label: '📄 Novo arquivo', action: () => beginCreate('root', 'file') },
        { label: '📁 Nova pasta', action: () => beginCreate('root', 'folder') },
      ]);
    });
  }

  // Delete no item selecionado do explorador, como no VS Code
  document.addEventListener('keydown', async (e) => {
    if (e.key !== 'Delete') return;
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    if (target.closest && target.closest('.monaco-editor')) return;
    if (!el.modalOverlay.classList.contains('hidden')) return;
    if (state.creating || state.renamingId) return;
    if (!state.selectedId || !VFS.get(state.selectedId)) return;
    e.preventDefault();
    await doDelete(state.selectedId);
  });

  document.addEventListener('keydown', (e) => {
    // Ctrl+S: salva na hora (e impede o "Salvar página" do navegador)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveActiveFile(); }
    // Ctrl+`: mostra/esconde o terminal
    if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleTerminal(); }
    // F5 / Ctrl+Enter fora do editor também executam
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) {
      if (e.target.closest && e.target.closest('.monaco-editor')) return; // o editor já trata
      e.preventDefault();
      runActive();
    }
  });

  /* ---------------- Explorador de arquivos ---------------- */

  function iconFor(node) {
    if (node.type === 'folder') return state.expanded.has(node.id) ? '📂' : '📁';
    const ext = node.name.includes('.') ? node.name.split('.').pop().toLowerCase() : '';
    const map = { c: '🇨', h: '📘', py: '🐍', pyw: '🐍', txt: '📝', md: '📝', json: '🧩', csv: '📊' };
    return map[ext] || '📄';
  }

  function renderTree() {
    el.tree.innerHTML = '';
    renderChildren(VFS.getRoot(), el.tree, 0);
    if (state.creating && state.creating.parentId === 'root') el.tree.appendChild(buildCreateRow(0));
  }

  function renderChildren(folderNode, container, depth) {
    for (const child of folderNode.children) {
      container.appendChild(buildRow(child, depth));
      if (child.type === 'folder' && state.expanded.has(child.id)) {
        renderChildren(child, container, depth + 1);
        if (state.creating && state.creating.parentId === child.id) container.appendChild(buildCreateRow(depth + 1));
      }
    }
  }

  function buildRow(node, depth) {
    const row = document.createElement('div');
    row.className = 'tree-row' + (state.selectedId === node.id ? ' selected' : '');
    row.style.paddingLeft = (depth * 14 + (node.type === 'folder' ? 2 : 20)) + 'px';
    row.dataset.id = node.id;

    if (node.type === 'folder') {
      const twisty = document.createElement('span');
      twisty.className = 'twisty';
      twisty.textContent = state.expanded.has(node.id) ? '▾' : '▸';
      row.appendChild(twisty);
    }

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = iconFor(node);
    row.appendChild(icon);

    if (state.renamingId === node.id) {
      const input = document.createElement('input');
      input.className = 'inline-edit';
      input.value = node.name;
      row.appendChild(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      let finished = false;
      const finish = (commit) => {
        if (finished) return;
        finished = true;
        state.renamingId = null;
        const newName = input.value.trim();
        if (commit && newName && newName !== node.name) doRename(node.id, newName);
        else renderTree();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('click', (e) => e.stopPropagation());
    } else {
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = node.name;
      row.appendChild(name);
    }

    row.addEventListener('click', () => {
      state.selectedId = node.id;
      if (node.type === 'folder') {
        toggleFolder(node.id);
      } else {
        Editor.open(node);
        renderTabs();
        closeMobileSidebar();
      }
      renderTree();
    });

    row.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (state.travado) return;
      state.renamingId = node.id;
      renderTree();
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.selectedId = node.id;
      renderTree();
      const items = [];
      if (node.type === 'folder') {
        items.push({ label: '📄 Novo arquivo', action: () => beginCreate(node.id, 'file') });
        items.push({ label: '📁 Nova pasta', action: () => beginCreate(node.id, 'folder') });
        items.push('-');
      } else if (['c', 'python'].includes(Editor.languageFor(node.name))) {
        items.push({ label: '▶️ Executar', action: () => runFile(node.id) });
        items.push('-');
      }
      items.push({ label: '✏️ Renomear', action: () => { state.renamingId = node.id; renderTree(); } });
      items.push({ label: '🗑️ Excluir', danger: true, action: () => doDelete(node.id) });
      showContextMenu(e.clientX, e.clientY, items);
    });

    return row;
  }

  function buildCreateRow(depth) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.style.paddingLeft = (depth * 14 + 20) + 'px';
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = state.creating.type === 'folder' ? '📁' : '📄';
    row.appendChild(icon);
    const input = document.createElement('input');
    input.className = 'inline-edit';
    input.placeholder = state.creating.type === 'folder' ? 'nome-da-pasta' : 'programa.c';
    row.appendChild(input);
    setTimeout(() => input.focus(), 0);

    let finished = false;
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      const creating = state.creating;
      state.creating = null;
      const name = input.value.trim();
      if (commit && name) doCreate(creating.parentId, creating.type, name);
      else renderTree();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    return row;
  }

  function toggleFolder(id) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
  }

  function beginCreate(parentId, type) {
    if (state.travado) return;
    state.expanded.add(parentId);
    state.creating = { parentId, type };
    setSidebarOpen(true);
    renderTree();
  }

  // arquivo novo sem extensão vira .c (é o que a aula usa)
  function comExtensao(name) {
    return name.includes('.') ? name : name + '.c';
  }

  function doCreate(parentId, type, name) {
    try {
      const node = type === 'file' ? VFS.createFile(parentId, comExtensao(name), novoConteudo(comExtensao(name))) : VFS.createFolder(parentId, name);
      renderTree();
      if (type === 'file') {
        Editor.open(node);
        renderTabs();
      }
    } catch (e) {
      showToast(e.message, true);
    }
  }

  function novoConteudo(name) {
    if (/\.c$/i.test(name)) return '#include <stdio.h>\n\nint main(void) {\n    \n    return 0;\n}\n';
    return '';
  }

  function doRename(id, newName) {
    try {
      VFS.rename(id, newName);
      Editor.renameOpen(id, newName);
      renderTree();
      renderTabs();
    } catch (e) {
      showToast(e.message, true);
      renderTree();
    }
  }

  async function doDelete(id) {
    if (state.travado) return;
    const node = VFS.get(id);
    const ok = await confirmAction(`Excluir "${node.name}"? Essa ação não pode ser desfeita.`);
    if (!ok) return;
    collectFileIds(node).forEach((fid) => Editor.closeAllFor(fid));
    VFS.remove(id);
    if (state.selectedId === id) state.selectedId = null;
    renderTree();
    renderTabs();
    Aula.aoCodigoMudou();
  }

  function collectFileIds(node, out = []) {
    if (node.type === 'file') out.push(node.id);
    else node.children.forEach((c) => collectFileIds(c, out));
    return out;
  }

  /* ---------------- Abas ---------------- */

  function renderTabs() {
    el.tabs.innerHTML = '';
    const activeId = Editor.getActiveId();
    for (const id of Editor.getOpenTabs()) {
      const node = VFS.get(id);
      if (!node) continue;
      const tab = document.createElement('div');
      tab.className = 'tab' + (id === activeId ? ' active' : '');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'tab-name';
      nameSpan.textContent = node.name;
      const dirty = document.createElement('span');
      dirty.className = 'tab-dirty';
      dirty.textContent = Editor.isDirty(id) ? '●' : '';
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '✕';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        commitSave(id);
        Editor.close(id);
        renderTabs();
        renderTree();
      });
      tab.append(nameSpan, dirty, close);
      tab.addEventListener('click', () => {
        Editor.activate(id);
        state.selectedId = id;
        renderTabs();
        renderTree();
      });
      tab.addEventListener('auxclick', (e) => {
        if (e.button === 1) { commitSave(id); Editor.close(id); renderTabs(); renderTree(); }
      });
      el.tabs.appendChild(tab);
    }
    updateStatusBar();
  }

  function updateStatusBar() {
    const activeId = Editor.getActiveId();
    const node = activeId ? VFS.get(activeId) : null;
    const lang = node ? Editor.languageFor(node.name) : '';
    el.statusLang.textContent = { c: 'C', python: 'Python', cpp: 'C++' }[lang] || lang;
  }

  /* ---------------- Salvamento ---------------- */

  function commitSave(fileId) {
    clearTimeout(saveTimers.get(fileId));
    saveTimers.delete(fileId);
    const content = Editor.getValue(fileId);
    if (content === null) return;
    VFS.updateContent(fileId, content);
    Editor.markClean(fileId);
  }

  function saveAll() {
    for (const id of Editor.getOpenTabs()) commitSave(id);
    renderTabs();
  }

  function onEditorChange(fileId) {
    if (execucao.status !== 'editando' && !state.rodando) { execucao.status = 'editando'; }
    clearTimeout(saveTimers.get(fileId));
    saveTimers.set(fileId, setTimeout(() => { commitSave(fileId); renderTabs(); }, 600));
    renderTabs();
    Aula.aoCodigoMudou();
  }

  function onEditorActiveChange() {
    updateStatusBar();
    Aula.aoCodigoMudou();
  }

  function saveActiveFile() {
    saveAll();
    setStatusMsg('💾 Salvo');
  }

  /* ---------------- Terminal ---------------- */

  function openTerminal() {
    state.terminalOpen = true;
    el.terminalPanel.classList.remove('hidden');
    el.resizer3.classList.remove('hidden');
  }

  function closeTerminal() {
    state.terminalOpen = false;
    el.terminalPanel.classList.add('hidden');
    el.resizer3.classList.add('hidden');
  }

  function toggleTerminal() {
    if (state.terminalOpen) closeTerminal();
    else openTerminal();
  }

  /* ---------------- Executar (C e Python) ---------------- */

  function setRodando(rodando, executor = null) {
    state.rodando = rodando;
    state.executor = rodando ? executor : null;
    for (const b of [el.btnRun, el.btnRunTerminal]) { b.disabled = rodando; b.classList.toggle('hidden', rodando); }
    for (const b of [el.btnStop, el.btnStopTerminal]) b.classList.toggle('hidden', !rodando);
  }

  function definirExecucao(status, erros = []) {
    execucao.status = status;
    execucao.erros = erros;
    Aula.aoExecucao();
  }

  // projeto inteiro como árvore { nome: conteúdo | {subpasta} } + caminhos dos .c + caminho -> id
  function coletarProjeto() {
    const fontes = [];
    const ids = new Map();
    function visitar(no, prefixo) {
      const obj = {};
      for (const filho of no.children) {
        const caminho = prefixo + filho.name;
        if (filho.type === 'folder') obj[filho.name] = visitar(filho, caminho + '/');
        else {
          const atual = Editor.getValue(filho.id);
          obj[filho.name] = atual !== null ? atual : filho.content;
          ids.set(caminho, filho.id);
          if (/\.c$/i.test(filho.name)) fontes.push(caminho);
        }
      }
      return obj;
    }
    return { arvore: visitar(VFS.getRoot(), ''), fontes, ids };
  }

  function runActive() {
    runFile(Editor.getActiveId());
  }

  function runFile(fileId) {
    if (state.rodando) return;
    const node = fileId && VFS.get(fileId);
    if (!node || node.type !== 'file') { showToast('Abra um arquivo .c ou .py para executar.', true); return; }
    const lang = Editor.languageFor(node.name);
    if (lang === 'python') return runPython(node);
    if (lang === 'c') return runC();
    showToast('Só dá para executar arquivos .c e .py.', true);
  }

  async function runC() {
    saveAll();
    const { arvore, fontes, ids } = coletarProjeto();
    if (fontes.length === 0) { showToast('O projeto não tem nenhum arquivo .c.', true); return; }
    openTerminal();
    Terminal.limpar();
    setRodando(true, 'c');
    Editor.clearAllMarkers();
    definirExecucao('compilando');
    if (!CRunner.estaPronto()) Terminal.linha('⏳ Preparando o compilador C (só demora na primeira vez neste computador)...');
    Terminal.linha(`🔨 Compilando ${fontes.join(' ')}...`);

    const r = await CRunner.compilar(arvore, fontes);
    if (r.erroInterno) {
      Terminal.linha('✗ ' + r.erroInterno, 'stderr');
      definirExecucao('erro', []);
      setRodando(false);
      return;
    }
    const diag = Diagnosticos.analisar(r.saida || '');
    for (const [caminho, id] of ids) Editor.setMarkers(id, Diagnosticos.marcadores(diag.itens, caminho));
    if (r.saida) Terminal.escrever(r.saida, diag.erros ? 'stderr' : 'aviso');
    const dicas = new Set();
    for (const item of diag.itens) {
      if (!item.dica || dicas.has(item.dica)) continue;
      dicas.add(item.dica);
      Terminal.linha(`💡 ${item.arquivo}, linha ${item.linha}: ${item.dica}`, 'dica');
    }

    if (!r.ok) {
      Terminal.linha(`✗ Não compilou: ${diag.erros || 'há'} erro(s). Corrija e rode de novo (F5).`, 'stderr');
      definirExecucao('erro', diag.itens);
      setRodando(false);
      const primeiro = diag.itens.find((i) => i.nivel === 'erro');
      const idErro = primeiro && ids.get(primeiro.arquivo);
      if (idErro) {
        Editor.open(VFS.get(idErro));
        renderTabs();
        Editor.revealLine(primeiro.linha);
      }
      return;
    }

    Terminal.linha(`✓ Compilado em ${(r.ms / 1000).toFixed(1).replace('.', ',')} s.${diag.avisos ? ` ${diag.avisos} aviso(s).` : ''} Executando:`);
    definirExecucao('rodando', diag.itens);
    const fim = await CRunner.executar(r.wasm);
    Terminal.cancelarEntrada();
    if (fim.parado) {
      Terminal.linha('⏹️ Interrompido.');
      definirExecucao('ok', diag.itens);
    } else if (fim.erro) {
      Terminal.linha('✗ ' + fim.erro, 'stderr');
      definirExecucao('erro-execucao', diag.itens);
    } else {
      Terminal.linha(`✓ Programa terminou${fim.codigo ? ` com código ${fim.codigo}` : ''}.`, fim.codigo ? 'aviso' : 'sistema');
      definirExecucao('ok', diag.itens);
    }
    setRodando(false);
  }

  async function runPython(node) {
    saveAll();
    openTerminal();
    Terminal.limpar();
    setRodando(true, 'python');
    definirExecucao('rodando');
    if (!PyRunner.isReady()) Terminal.linha('⏳ Carregando o Python (Pyodide)... pode levar alguns segundos na primeira vez.');
    try {
      await PyRunner.run(Editor.getValue(node.id) ?? node.content);
      Terminal.linha('✓ Concluído.');
      definirExecucao('ok');
    } catch (e) {
      Terminal.linha((e && e.message) || String(e), 'stderr');
      Terminal.linha('✗ Encerrado com erro.', 'stderr');
      definirExecucao('erro-execucao');
    } finally {
      setRodando(false);
    }
  }

  function stopRun() {
    if (state.executor === 'python') PyRunner.stop();
    else CRunner.parar();
    Terminal.cancelarEntrada();
    setRodando(false);
  }

  function setupRunners() {
    Terminal.init(el.terminal, { onChange: () => Aula.aoTerminalMudou() });
    CRunner.definirSaida((tipo, texto) => Terminal.escrever(texto, tipo));
    CRunner.definirEntrada(() => Terminal.pedirEntrada());
    PyRunner.setOutputHandler((kind, text) => Terminal.escrever(text + '\n', kind === 'stderr' ? 'stderr' : 'stdout'));
    PyRunner.setInputHandler(async (prompt) => {
      if (prompt) Terminal.escrever(prompt);
      const v = await Terminal.pedirEntrada();
      return v === null ? '' : v.replace(/\n$/, '');
    });

    // o compilador começa a baixar já: quando o aluno apertar F5 ele provavelmente já está pronto
    CRunner.aoProgresso((feito, total) => {
      el.statusCompilador.textContent = `⬇️ Compilador C: ${Math.floor((100 * feito) / total)}%`;
    });
    CRunner.aoFicarPronto((erro) => {
      el.statusCompilador.textContent = erro ? '⚠️ Compilador C indisponível' : '✓ Compilador C pronto';
      el.statusCompilador.title = erro || '';
    });
    CRunner.iniciarCompilador();

    for (const b of [el.btnRun, el.btnRunTerminal]) b.addEventListener('click', runActive);
    for (const b of [el.btnStop, el.btnStopTerminal]) b.addEventListener('click', stopRun);
    $('#btn-clear-console').addEventListener('click', () => Terminal.limpar());
    $('#btn-close-terminal').addEventListener('click', closeTerminal);
    $('#btn-toggle-terminal').addEventListener('click', toggleTerminal);
  }

  /* ---------------- Painel da aula ---------------- */

  function setAulaOpen(open) {
    state.aulaOpen = open;
    el.aulaPane.classList.toggle('hidden', !open);
    el.resizer2.classList.toggle('hidden', !open);
  }

  /* ---------------- Toolbar ---------------- */

  function setupToolbar() {
    el.btnToggleSidebar.addEventListener('click', toggleSidebar);
    el.btnFullscreen.addEventListener('click', toggleFullscreen);
    $('#btn-new-file').addEventListener('click', () => beginCreate(rootOrSelectedFolder(), 'file'));
    $('#side-new-file').addEventListener('click', () => beginCreate(rootOrSelectedFolder(), 'file'));
    $('#side-new-folder').addEventListener('click', () => beginCreate(rootOrSelectedFolder(), 'folder'));
    $('#btn-toggle-aula').addEventListener('click', () => setAulaOpen(!state.aulaOpen));

    $('#btn-import').addEventListener('click', () => el.importInput.click());
    el.importInput.addEventListener('change', async () => {
      try {
        const root = await Zip.importFromFileList(el.importInput.files);
        VFS.resetTo(root);
        resetEditorState();
        renderTree();
        openDefaultFile();
        showToast(`Pasta "${root.name}" importada (use "Baixar .zip" para salvar uma cópia).`);
      } catch (e) {
        showToast(e.message, true);
      } finally {
        el.importInput.value = '';
      }
    });

    $('#btn-export-zip').addEventListener('click', async () => {
      saveAll();
      await Zip.exportProject(state.projectName);
      setStatusMsg('Projeto baixado como .zip');
    });

    $('#btn-reset').addEventListener('click', async () => {
      if (state.travado) return;
      const ok = await confirmAction('Começar um projeto novo? O projeto atual salvo neste navegador será apagado.', 'Apagar e começar');
      if (!ok) return;
      VFS.resetTo(buildDefaultProject());
      resetEditorState();
      renderTree();
      openDefaultFile();
    });
  }

  function rootOrSelectedFolder() {
    if (!state.selectedId) return 'root';
    return VFS.folderOf(state.selectedId);
  }

  function resetEditorState() {
    for (const id of Editor.getOpenTabs()) Editor.close(id);
    state.selectedId = null;
    state.expanded = new Set(['root']);
    renderTabs();
  }

  function openDefaultFile() {
    const root = VFS.getRoot();
    const main = root.children.find((c) => c.type === 'file' && c.name.toLowerCase() === 'main.c');
    const first = main || root.children.find((c) => c.type === 'file');
    if (first) {
      Editor.open(first);
      state.selectedId = first.id;
    }
    renderTabs();
    renderTree();
  }

  /* ---------------- Redimensionamento ---------------- */

  function setupResizers() {
    setupResizer($('#resizer-1'), (dx) => {
      const sidebar = $('#sidebar');
      sidebar.style.width = Math.max(160, Math.min(500, sidebar.offsetWidth + dx)) + 'px';
    });
    setupResizer($('#resizer-2'), (dx) => {
      const pane = el.aulaPane;
      pane.style.width = Math.max(260, Math.min(window.innerWidth * 0.75, pane.offsetWidth - dx)) + 'px';
    });
    setupResizer($('#resizer-3'), (dx, dy) => {
      const terminal = el.terminalPanel;
      terminal.style.height = Math.max(100, Math.min(window.innerHeight * 0.75, terminal.offsetHeight - dy)) + 'px';
    });
  }

  function setupResizer(handle, onDrag) {
    let lastX = 0;
    let lastY = 0;
    handle.addEventListener('pointerdown', (e) => {
      handle.setPointerCapture(e.pointerId);
      lastX = e.clientX;
      lastY = e.clientY;
      handle.classList.add('dragging');
      document.body.style.cursor = getComputedStyle(handle).cursor;
      document.body.classList.add('arrastando'); // o vídeo da tela não "rouba" o ponteiro
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      onDrag(dx, dy);
    });
    function endDrag(e) {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      handle.releasePointerCapture(e.pointerId);
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.classList.remove('arrastando');
    }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }

  /* ---------------- API para aula.js ---------------- */

  function caminhoDe(id) {
    return id ? VFS.getPath(id) : '';
  }

  window.App = {
    toast: showToast,
    abrirPainelAula: setAulaOpen,
    definirModo(texto) { el.statusMode.textContent = texto; },

    // arquivo ativo agora (vai para o professor/alunos)
    estadoAtual() {
      const id = Editor.getActiveId();
      const node = id && VFS.get(id);
      if (!node) return { arquivo: '', linguagem: '', codigo: '', cursor: null };
      const codigo = Editor.getValue(id);
      return { arquivo: caminhoDe(id), linguagem: Editor.languageFor(node.name), codigo: codigo !== null ? codigo : node.content, cursor: Editor.getCursor() };
    },

    execucao() {
      return { status: execucao.status, erros: execucao.erros.slice(0, 30).map(({ arquivo, linha, coluna, nivel, mensagem, dica }) => ({ arquivo, linha, coluna, nivel, mensagem, dica })) };
    },

    // o professor editando o código do aluno: trava o editor do aluno e aplica o texto que chega
    travarEditor(travar, nomeProfessor) {
      state.travado = travar;
      Editor.setReadOnly(travar);
      el.bannerTravado.classList.toggle('hidden', !travar);
      el.bannerTravado.textContent = `✍️ ${nomeProfessor || 'O professor'} está editando o seu código. Acompanhe as mudanças; o editor volta para você quando ele terminar.`;
    },

    // professor/colega pediu para rodar o código deste aluno (o resultado aparece no terminal daqui e volta para ele)
    executarArquivo(caminho) {
      const node = caminho && VFS.resolveRelative('root', caminho);
      const id = node && node.type === 'file' ? node.id : Editor.getActiveId();
      if (state.rodando) stopRun();
      openTerminal();
      runFile(id);
    },

    abrirArquivo(caminho) {
      const node = VFS.resolveRelative('root', caminho);
      if (!node || node.type !== 'file') return;
      if (Editor.getActiveId() !== node.id) { Editor.open(node); renderTabs(); renderTree(); }
    },

    aplicarCodigoExterno(caminho, codigo) {
      const node = VFS.resolveRelative('root', caminho);
      if (!node || node.type !== 'file') return;
      if (Editor.getActiveId() !== node.id) { Editor.open(node); renderTabs(); renderTree(); }
      Editor.setValueExterno(node.id, codigo);
    },

    // cria um arquivo com o código do professor (nome único) e abre
    copiarParaProjeto(nome, codigo) {
      const base = (nome || 'professor.c').split('/').pop();
      const ponto = base.lastIndexOf('.');
      const raiz = ponto > 0 ? base.slice(0, ponto) : base;
      const ext = ponto > 0 ? base.slice(ponto) : '.c';
      let candidato = `${raiz}_professor${ext}`;
      for (let i = 2; VFS.nameExists('root', candidato); i++) candidato = `${raiz}_professor${i}${ext}`;
      const node = VFS.createFile('root', candidato, codigo);
      renderTree();
      Editor.open(node);
      renderTabs();
      showToast(`Código copiado para "${candidato}".`);
    },
  };

  /* ---------------- Boot ---------------- */

  function boot() {
    cacheEls();
    VFS.init(buildDefaultProject);
    setupToolbar();
    setupResizers();
    setupTreeContextMenu();
    setupRunners();
    setSidebarOpen(!isNarrowScreen());
    setRodando(false);

    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
    require(['vs/editor/editor.main'], () => {
      Editor.init(el.monacoContainer, {
        onChange: onEditorChange,
        onActiveChange: onEditorActiveChange,
        onSave: saveActiveFile,
        onRun: runActive,
        onCursor: () => Aula.aoCursorMudou(),
      });
      renderTree();
      openDefaultFile();
      Aula.init();
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
