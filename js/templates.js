/*
 * Projeto inicial: um programa C com entrada (scanf) e if/else, pronto para rodar com F5.
 */
function buildDefaultProject() {
  const root = VFS.createNode('folder', 'aula');
  root.id = 'root';
  root.children.push(VFS.createNode('file', 'main.c', `#include <stdio.h>

int main(void) {
    int idade;

    printf("Qual a sua idade? ");
    scanf("%d", &idade);

    if (idade >= 18) {
        printf("Voce e maior de idade.\\n");
    } else {
        printf("Voce e menor de idade.\\n");
    }

    return 0;
}
`));
  return root;
}
