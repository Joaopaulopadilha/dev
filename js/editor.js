/*
 * Editor: encapsula o Monaco Editor e a gestão de abas (tabs).
 */
const Editor = (() => {
  let monacoEditor = null;
  let models = new Map(); // fileId -> monaco.editor.ITextModel
  let openTabs = []; // array de fileId, em ordem
  let activeId = null;
  let onChangeCallback = null;
  let onActiveChangeCallback = null;
  let dirtySet = new Set(); // ids com alteração ainda não persistida no disco (só relevante p/ File System Access)
  let autoCloseGuard = false; // evita reentrância ao inserir a tag de fechamento programaticamente

  const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);

  // Insere (na posição indicada) a tag de fechamento — ou só o ">" se for um
  // elemento void — e deixa o cursor logo depois do ">".
  //
  // deferCursor: ao aceitar uma sugestão do dropdown (ex.: escolher "script"
  // na lista), o próprio Monaco reposiciona o cursor pro fim do texto que ELE
  // inseriu (logo após "script") como parte da própria rotina de aceitar —
  // isso acontece DEPOIS do nosso onDidChangeContent, então sobrescreve
  // nosso setPosition se ele rodar na hora. Adiar pro próximo tick resolve.
  function insertCloseSequence(lineNumber, column, tagName, deferCursor) {
    const closeTag = VOID_ELEMENTS.has(tagName.toLowerCase()) ? '' : `</${tagName}>`;
    autoCloseGuard = true;
    monacoEditor.executeEdits('auto-close-tag', [{
      range: { startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column },
      text: `>${closeTag}`,
    }]);
    autoCloseGuard = false;
    const placeCursor = () => monacoEditor.setPosition({ lineNumber, column: column + 1 });
    if (deferCursor) setTimeout(placeCursor, 0);
    else placeCursor();
  }

  // Fecha a tag automaticamente ao digitar ">", igual ao VS Code:
  // <title> vira <title>|</title> com o cursor entre as duas.
  function handleTypedCloseBracket(model, change) {
    const lineNumber = change.range.startLineNumber;
    const column = change.range.startColumn + 1; // posição logo após o ">" recém digitado
    const before = model.getLineContent(lineNumber).slice(0, column - 1);
    const match = before.match(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)>$/);
    if (!match) return;

    const tagName = match[1];
    const attrs = match[2] || '';
    if (attrs.trim().endsWith('/')) return; // self-closing, tipo <img ... />
    if (VOID_ELEMENTS.has(tagName.toLowerCase())) return;

    const closeTag = `</${tagName}>`;
    const afterCursor = model.getValueInRange({
      startLineNumber: lineNumber, startColumn: column,
      endLineNumber: lineNumber, endColumn: column + closeTag.length,
    });
    if (afterCursor.toLowerCase() === closeTag.toLowerCase()) return; // já está fechado ali na frente

    autoCloseGuard = true;
    monacoEditor.executeEdits('auto-close-tag', [{
      range: { startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column },
      text: closeTag,
    }]);
    monacoEditor.setPosition({ lineNumber, column });
    autoCloseGuard = false;
  }

  // Aceitar uma sugestão de tag (ex.: escolher "button" na lista) insere só
  // o nome, de uma vez, sem ">" — diferente de digitar letra por letra, dá
  // pra reconhecer pelo texto vindo inteiro (mais de 1 caractere) no lugar
  // de um "<" solto. Completa a tag inteira: <button>|</button>.
  function handleAcceptedTagSuggestion(model, change) {
    const tagName = change.text;
    if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(tagName)) return;

    const lineNumber = change.range.startLineNumber;
    const insertEndColumn = change.range.startColumn + tagName.length;
    const lineText = model.getLineContent(lineNumber);
    const before = lineText.slice(0, change.range.startColumn - 1);
    if (!before.endsWith('<')) return; // só nos importa completar uma tag de abertura

    const after = lineText.slice(insertEndColumn - 1);
    if (after.startsWith('>') || after.startsWith('/')) return; // já tá fechada ali na frente

    insertCloseSequence(lineNumber, insertEndColumn, tagName, true);
  }

  function maybeAutoCloseTag(model, event) {
    if (autoCloseGuard) return;
    if (model.getLanguageId() !== 'html') return;
    const change = event.changes[event.changes.length - 1];
    if (!change) return;

    if (change.text === '>') handleTypedCloseBracket(model, change);
    else if (change.text.length > 1) handleAcceptedTagSuggestion(model, change);
  }

  function languageFor(name) {
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    const map = {
      html: 'html', htm: 'html',
      css: 'css',
      js: 'javascript', mjs: 'javascript',
      py: 'python', pyw: 'python',
      c: 'c', h: 'c',
      cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
      json: 'json',
      md: 'markdown',
      ts: 'typescript',
      svg: 'xml', xml: 'xml',
      txt: 'plaintext',
    };
    return map[ext] || 'plaintext';
  }

  function init(container, { onChange, onActiveChange, onSave, onRun, onCursor }) {
    onChangeCallback = onChange;
    onActiveChangeCallback = onActiveChange;

    monaco.editor.defineTheme('estudo-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#1e1e1e',
      },
    });
    monaco.editor.defineTheme('estudo-light', { base: 'vs', inherit: true, rules: [], colors: {} });

    monacoEditor = monaco.editor.create(container, {
      theme: temaMonaco(),
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      tabSize: 4,
      wordWrap: 'off',
    });
    if (onCursor) monacoEditor.onDidChangeCursorSelection(() => onCursor());

    if (onSave) {
      // Ctrl+S com o foco no editor: intercepta antes de virar o "Salvar página" do navegador.
      monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
    }
    if (onRun) {
      // Ctrl+Enter (ou F5) roda o arquivo ativo (C ou Python).
      monacoEditor.addCommand(monaco.KeyCode.F5, onRun);
      monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, onRun);
    }
  }

  function attachModelListeners(model, fileId) {
    model.onDidChangeContent((event) => {
      maybeAutoCloseTag(model, event);
      const content = model.getValue();
      dirtySet.add(fileId);
      if (onChangeCallback) onChangeCallback(fileId, content);
    });
  }

  function getOrCreateModel(node) {
    if (models.has(node.id)) return models.get(node.id);
    const model = monaco.editor.createModel(node.content, languageFor(node.name));
    attachModelListeners(model, node.id);
    models.set(node.id, model);
    return model;
  }

  function open(node) {
    if (!openTabs.includes(node.id)) {
      openTabs.push(node.id);
    }
    activate(node.id);
  }

  function activate(fileId) {
    const node = VFS.get(fileId);
    if (!node || node.type !== 'file') return;
    activeId = fileId;
    const model = getOrCreateModel(node);
    monacoEditor.setModel(model);
    if (onActiveChangeCallback) onActiveChangeCallback(fileId);
  }

  function close(fileId) {
    const idx = openTabs.indexOf(fileId);
    if (idx === -1) return;
    openTabs.splice(idx, 1);
    const model = models.get(fileId);
    if (model) {
      model.dispose();
      models.delete(fileId);
    }
    dirtySet.delete(fileId);
    if (activeId === fileId) {
      activeId = null;
      if (openTabs.length > 0) {
        activate(openTabs[Math.min(idx, openTabs.length - 1)]);
      } else {
        monacoEditor.setModel(null);
        if (onActiveChangeCallback) onActiveChangeCallback(null);
      }
    }
  }

  function closeAllFor(fileId) {
    // usado quando um arquivo é removido do VFS (delete)
    close(fileId);
  }

  function renameOpen(fileId, newName) {
    const model = models.get(fileId);
    if (!model) return;
    const node = VFS.get(fileId);
    const newModel = monaco.editor.createModel(model.getValue(), languageFor(newName));
    attachModelListeners(newModel, fileId);
    model.dispose();
    models.set(fileId, newModel);
    if (activeId === fileId) monacoEditor.setModel(newModel);
  }

  function getOpenTabs() {
    return [...openTabs];
  }

  function getActiveId() {
    return activeId;
  }

  function getValue(fileId) {
    const model = models.get(fileId);
    return model ? model.getValue() : null;
  }

  function markClean(fileId) {
    dirtySet.delete(fileId);
  }

  function isDirty(fileId) {
    return dirtySet.has(fileId);
  }

  function focus() {
    if (monacoEditor) monacoEditor.focus();
  }

  function getModel(fileId) {
    return models.get(fileId) || null;
  }

  // troca o conteúdo vindo de fora (ex.: o professor editando o código do aluno) sem perder o desfazer
  function setValueExterno(fileId, content) {
    const node = VFS.get(fileId);
    if (!node) return;
    const model = getOrCreateModel(node);
    if (model.getValue() === content) return;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
  }

  function setReadOnly(readOnly) {
    if (monacoEditor) monacoEditor.updateOptions({ readOnly });
  }

  // marcadores de erro (sublinhado vermelho) vindos do compilador
  function setMarkers(fileId, markers) {
    const node = VFS.get(fileId);
    if (!node) return;
    monaco.editor.setModelMarkers(getOrCreateModel(node), 'compilador', markers);
  }

  function clearAllMarkers() {
    for (const model of models.values()) monaco.editor.setModelMarkers(model, 'compilador', []);
  }

  function getCursor() {
    const p = monacoEditor && monacoEditor.getPosition();
    return p ? { linha: p.lineNumber, coluna: p.column } : null;
  }

  function revealLine(linha) {
    if (!monacoEditor) return;
    monacoEditor.revealLineInCenter(linha);
    monacoEditor.setPosition({ lineNumber: linha, column: 1 });
    monacoEditor.focus();
  }

  // o tema do Monaco é global: todos os editores (o meu, o do professor, o do colega) mudam juntos
  function temaMonaco() {
    return document.documentElement.classList.contains('tema-claro') ? 'estudo-light' : 'estudo-dark';
  }

  return {
    init,
    temaMonaco,
    open,
    activate,
    close,
    closeAllFor,
    renameOpen,
    getOpenTabs,
    getActiveId,
    getValue,
    languageFor,
    markClean,
    isDirty,
    focus,
    getModel,
    setValueExterno,
    setReadOnly,
    setMarkers,
    clearAllMarkers,
    getCursor,
    revealLine,
  };
})();
