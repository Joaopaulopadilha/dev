/*
 * VFS (Virtual File System)
 * Modelo em memória de pastas/arquivos, persistido no localStorage.
 * Também sabe espelhar leituras/escritas para uma pasta real do disco
 * quando o usuário usa "Abrir Pasta" (File System Access API).
 */
const VFS = (() => {
  // chaves próprias: o CAPS Studio fica no mesmo domínio (joaopaulopadilha.github.io) e usa as dele
  const STORAGE_KEY = 'dev_aula_vfs_v1';
  const META_KEY = 'dev_aula_meta_v1';

  let root = null; // nó raiz (type: 'folder')
  let nodesById = new Map();
  let handlesById = new Map(); // id -> FileSystemFileHandle | FileSystemDirectoryHandle (não persistido)
  let localRootName = null; // nome da pasta local aberta, se houver

  function uid() {
    return 'n_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function indexTree(node) {
    nodesById.set(node.id, node);
    if (node.type === 'folder') {
      for (const child of node.children) indexTree(child);
    }
  }

  function createNode(type, name, content) {
    const node = { id: uid(), type, name };
    if (type === 'file') node.content = content ?? '';
    else node.children = [];
    nodesById.set(node.id, node);
    return node;
  }

  function get(id) {
    return nodesById.get(id) || null;
  }

  function getRoot() {
    return root;
  }

  function findParent(id, node = root) {
    if (node.type !== 'folder') return null;
    for (const child of node.children) {
      if (child.id === id) return node;
      if (child.type === 'folder') {
        const found = findParent(id, child);
        if (found) return found;
      }
    }
    return null;
  }

  function getPathParts(id) {
    // retorna array de nomes da raiz até o nó (exclusive da raiz)
    const parts = [];
    let current = get(id);
    if (!current) return parts;
    parts.unshift(current.name);
    let parent = findParent(id);
    while (parent && parent !== root) {
      parts.unshift(parent.name);
      parent = findParent(parent.id);
    }
    return parts;
  }

  function getPath(id) {
    return getPathParts(id).join('/');
  }

  function findByPath(pathParts, node = root) {
    if (pathParts.length === 0) return node;
    if (node.type !== 'folder') return null;
    const [head, ...rest] = pathParts;
    const child = node.children.find((c) => c.name === head);
    if (!child) return null;
    if (rest.length === 0) return child;
    return findByPath(rest, child);
  }

  function resolveRelative(baseFolderId, relHref) {
    // resolve um caminho relativo (tipo "./style.css" ou "../js/app.js") a partir da pasta base
    if (/^([a-z]+:)?\/\//i.test(relHref) || relHref.startsWith('data:')) return null; // URL externa
    const baseParts = baseFolderId === 'root' ? [] : getPathParts(baseFolderId);
    const hrefParts = relHref.split('/').filter((p) => p !== '' && p !== '.');
    const stack = [...baseParts];
    for (const part of hrefParts) {
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    return findByPath(stack);
  }

  function folderOf(id) {
    const node = get(id);
    if (!node) return 'root';
    if (node.type === 'folder') return node.id;
    const parent = findParent(node.id);
    return parent ? parent.id : 'root';
  }

  function sortChildren(folder) {
    folder.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
    });
  }

  function nameExists(folderId, name) {
    const folder = get(folderId) || root;
    return folder.children.some((c) => c.name.toLowerCase() === name.toLowerCase());
  }

  function addNode(folderId, node) {
    const folder = get(folderId) || root;
    folder.children.push(node);
    sortChildren(folder);
    save();
    return node;
  }

  function createFile(folderId, name, content = '') {
    if (nameExists(folderId, name)) throw new Error('Já existe um item com esse nome nesta pasta.');
    const node = createNode('file', name, content);
    addNode(folderId, node);
    return node;
  }

  function createFolder(folderId, name) {
    if (nameExists(folderId, name)) throw new Error('Já existe um item com esse nome nesta pasta.');
    const node = createNode('folder', name);
    addNode(folderId, node);
    return node;
  }

  function rename(id, newName) {
    const node = get(id);
    if (!node) return;
    const parent = findParent(id) || root;
    if (nameExists(parent.id, newName) && node.name.toLowerCase() !== newName.toLowerCase()) {
      throw new Error('Já existe um item com esse nome nesta pasta.');
    }
    node.name = newName;
    sortChildren(parent);
    save();
  }

  function removeFromTree(node, parent) {
    nodesById.delete(node.id);
    handlesById.delete(node.id);
    if (node.type === 'folder') {
      for (const child of [...node.children]) removeFromTree(child, node);
    }
  }

  function remove(id) {
    const node = get(id);
    if (!node) return;
    const parent = findParent(id);
    if (!parent) return;
    parent.children = parent.children.filter((c) => c.id !== id);
    removeFromTree(node, parent);
    save();
  }

  function updateContent(id, content) {
    const node = get(id);
    if (!node || node.type !== 'file') return;
    node.content = content;
    save();
  }

  function serialize() {
    return JSON.stringify(root);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, serialize());
    } catch (e) {
      console.warn('Não foi possível salvar no localStorage:', e);
    }
  }

  function saveMeta(meta) {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  }

  function loadMeta() {
    try {
      return JSON.parse(localStorage.getItem(META_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function resetTo(templateRoot) {
    root = templateRoot;
    root.id = 'root';
    nodesById = new Map();
    handlesById = new Map();
    localRootName = null;
    indexTree(root);
    save();
  }

  function loadFromStorage() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      root = parsed;
      root.id = 'root';
      nodesById = new Map();
      indexTree(root);
      return true;
    } catch (e) {
      console.warn('Falha ao carregar projeto salvo:', e);
      return false;
    }
  }

  function init(templateFactory) {
    if (!loadFromStorage()) {
      resetTo(templateFactory());
    }
  }

  function setHandle(id, handle) {
    handlesById.set(id, handle);
  }

  function getHandle(id) {
    return handlesById.get(id);
  }

  function setLocalRootName(name) {
    localRootName = name;
  }

  function getLocalRootName() {
    return localRootName;
  }

  return {
    init,
    resetTo,
    get,
    getRoot,
    findParent,
    getPath,
    getPathParts,
    resolveRelative,
    folderOf,
    createFile,
    createFolder,
    rename,
    remove,
    updateContent,
    nameExists,
    save,
    saveMeta,
    loadMeta,
    createNode,
    addNode,
    setHandle,
    getHandle,
    setLocalRootName,
    getLocalRootName,
    sortChildren,
  };
})();
