/*
 * Zip: exporta o projeto inteiro como .zip (usa JSZip, carregado via CDN)
 * e importa uma pasta escolhida pelo usuário (input[webkitdirectory]) como fallback
 * para navegadores sem File System Access API.
 */
const Zip = (() => {
  function addNodeToZip(zip, node) {
    if (node.type === 'file') {
      zip.file(node.name, node.content);
    } else {
      const sub = node.id === 'root' ? zip : zip.folder(node.name);
      for (const child of node.children) addNodeToZip(sub, child);
    }
  }

  async function exportProject(projectName) {
    const zip = new JSZip();
    const root = VFS.getRoot();
    for (const child of root.children) addNodeToZip(zip, child);
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName || 'meu-projeto'}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function importFromFileList(fileList) {
    // fileList vem de <input webkitdirectory>: cada file.webkitRelativePath
    // é tipo "pasta-raiz/sub/arquivo.ext"
    const files = Array.from(fileList).filter((f) => !f.webkitRelativePath.split('/').some((p) => p.startsWith('.')));
    if (files.length === 0) throw new Error('Nenhum arquivo encontrado.');

    const rootName = files[0].webkitRelativePath.split('/')[0];
    const root = { id: 'root', type: 'folder', name: rootName, children: [] };

    for (const file of files) {
      const parts = file.webkitRelativePath.split('/').slice(1); // remove nome da pasta raiz
      const fileName = parts.pop();
      let node = root;
      for (const part of parts) {
        let next = node.children.find((c) => c.type === 'folder' && c.name === part);
        if (!next) {
          next = { id: 'tmp_' + Math.random(), type: 'folder', name: part, children: [] };
          node.children.push(next);
        }
        node = next;
      }
      const isTextLike = /\.(c|h|cpp|hpp|py|html|htm|css|js|mjs|json|md|txt|svg|xml|csv)$/i.test(fileName);
      const content = isTextLike ? await file.text() : `/* Arquivo binário "${fileName}" não é editável aqui. */`;
      node.children.push({ id: 'tmp_' + Math.random(), type: 'file', name: fileName, content });
    }

    return root;
  }

  return { exportProject, importFromFileList };
})();
