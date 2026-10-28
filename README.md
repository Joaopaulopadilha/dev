# Dev — aula de programação no navegador

Editor estilo VS Code (base do [CAPS Studio](https://github.com/Joaopaulopadilha/CAPS_studio)) para aulas de programação, em **C** e **Python**, sem instalar nada.

**Abrir:** https://joaopaulopadilha.github.io/dev/

## Na aula

- **Professor:** escolhe "Sou professor", abre a sala com um código (ou deixa gerar um) e passa o código ou o link (`🔗 Copiar link`) para a turma.
  - **Transmitir código:** o arquivo aberto e o terminal do professor aparecem ao vivo para os alunos, em texto (nítido, leve, dá para copiar).
  - **Compartilhar tela:** vídeo da tela inteira. O professor envia direto para 5 alunos e cada um repassa para até 3 colegas (árvore), então uma turma de 40 não pesa no computador do professor.
  - **Turma:** cada aluno aparece com um sinal: verde (compilou e rodou), vermelho (erro de compilação), laranja (erro ao executar), ✋ (pediu ajuda). Clicar no aluno mostra o código e o terminal dele ao vivo; **✍️ Editar o código dele** trava o editor do aluno e deixa o professor corrigir junto.
- **Aluno:** escolhe "Sou aluno", digita o código da sala (ou abre o link) e programa no próprio editor. O painel da direita mostra o código e a tela do professor; **📋 Copiar para meu projeto** traz o código do professor como um arquivo novo; **✋ Pedir ajuda** avisa o professor.
- Recarregar a página volta para a mesma aula; se a conexão cair, aluno e professor religam sozinhos.

## Executar

- **F5** ou **Ctrl+Enter** compila e executa o arquivo aberto.
- **C:** compilado com o Clang de verdade (LLVM 22 em WebAssembly, pacote [@yowasp/clang](https://www.npmjs.com/package/@yowasp/clang)), com `-std=gnu17 -Wall -O0`. Todos os `.c` do projeto são compilados juntos (dá para usar `.h`). Erros aparecem sublinhados no editor e, para os mais comuns, com uma dica em português (faltou `;`, faltou `&` no `scanf`, faltou `#include`...).
  - `scanf`/`getchar` pedem a entrada no terminal; **Ctrl+D** envia "fim de arquivo".
  - O programa roda isolado: **⏹️ Parar** encerra um laço infinito sem travar a página.
  - Limitações: não há arquivos (`fopen`), rede ou processos; ponteiro nulo não dá "segmentation fault" (a memória do WebAssembly começa no endereço 0).
- **Python:** Pyodide (CPython em WebAssembly), com `input()` no terminal.

### Primeiro acesso

O compilador C tem ~27 MB (comprimido) e é baixado uma vez por computador; depois fica guardado no navegador. Numa turma grande, **abra o site em cada máquina antes da aula** para a internet da escola não ser usada por todos ao mesmo tempo. A barra de status mostra o progresso ("⬇️ Compilador C: 45%").

## Como funciona

- Site estático (GitHub Pages), sem servidor próprio. `coi-serviceworker.js` habilita o isolamento entre origens que o `scanf`/`input()` interativo precisa.
- A conexão entre professor e alunos é WebRTC via [PeerJS](https://peerjs.com/) (o servidor público do PeerJS só apresenta um ao outro; na mesma rede as conexões são diretas). Precisa de internet.
- `clang/`: o pacote `@yowasp/clang` com os arquivos grandes já comprimidos em gzip; `js/compilador-worker.js` descomprime e guarda no Cache Storage.

| Arquivo | O que faz |
|---|---|
| `js/app.js` | interface: explorador, abas, terminal, compilar/executar |
| `js/aula.js` | telas do professor e do aluno |
| `js/sala.js` | conexão professor ↔ alunos (PeerJS) |
| `js/tela.js` | compartilhamento de tela em árvore |
| `js/c-runner.js`, `js/compilador-worker.js`, `js/executor-worker.js` | compilar (Clang) e executar (WASI) programas C |
| `js/diagnosticos.js` | erros do Clang no editor + dicas em português |
| `js/python.js`, `js/python-worker.js` | Python (Pyodide) |
