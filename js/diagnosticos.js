/*
 * Diagnosticos: lê a saída do Clang ("main.c:7:5: error: ...") para sublinhar a linha no editor
 * e acrescenta uma dica em português para os erros mais comuns de quem está começando em C.
 */
const Diagnosticos = (() => {
  const RE = /^(.+?):(\d+):(\d+): (fatal error|error|warning|note): (.*)$/;

  const CABECALHO = {
    printf: 'stdio.h', scanf: 'stdio.h', puts: 'stdio.h', gets: 'stdio.h', fgets: 'stdio.h', getchar: 'stdio.h', putchar: 'stdio.h',
    malloc: 'stdlib.h', calloc: 'stdlib.h', free: 'stdlib.h', rand: 'stdlib.h', srand: 'stdlib.h', exit: 'stdlib.h', atoi: 'stdlib.h', system: 'stdlib.h',
    strlen: 'string.h', strcpy: 'string.h', strcmp: 'string.h', strcat: 'string.h', memset: 'string.h', memcpy: 'string.h',
    sqrt: 'math.h', pow: 'math.h', fabs: 'math.h', floor: 'math.h', ceil: 'math.h', sin: 'math.h', cos: 'math.h',
    time: 'time.h', toupper: 'ctype.h', tolower: 'ctype.h', isdigit: 'ctype.h', isalpha: 'ctype.h',
    bool: 'stdbool.h', true: 'stdbool.h', false: 'stdbool.h',
  };

  // [padrão, dica] — a primeira que casar vale
  const DICAS = [
    [/call to undeclared (?:library )?function '(\w+)'/, (m) => CABECALHO[m[1]]
      ? `Faltou #include <${CABECALHO[m[1]]}> no início do arquivo para usar ${m[1]}().`
      : `A função '${m[1]}' não foi declarada: escreva-a antes do main ou declare o protótipo no início.`],
    [/use of undeclared identifier '(\w+)'/, (m) => CABECALHO[m[1]]
      ? `Faltou #include <${CABECALHO[m[1]]}> para usar '${m[1]}'.`
      : `'${m[1]}' não foi declarado: confira o nome (maiúsculas e minúsculas contam) ou declare a variável antes de usar.`],
    [/format specifies type '[^']*\*' but the argument has type '(int|float|double|char|long)'/, () => 'No scanf, falta o & antes da variável (ex.: scanf("%d", &idade)).'],
    [/format specifies type '([^']+)' but the argument has type '([^']+)'/, (m) => `O % do printf/scanf não combina com o tipo da variável (espera ${m[1]}, recebeu ${m[2]}). Use %d para int, %f para float, %lf no scanf de double, %c para char, %s para texto.`],
    [/more '%' conversions than data arguments|data argument not used by format string/, () => 'A quantidade de % no texto não bate com a quantidade de variáveis depois da vírgula.'],
    [/expected ';'/, () => 'Faltou um ponto e vírgula (;) no fim de um comando (geralmente na linha anterior).'],
    [/expected '\}'|extraneous closing brace|expected '\{'/, () => 'As chaves { } não estão balanceadas: toda { precisa de uma }.'],
    [/expected '\)'/, () => 'Faltou fechar um parêntese ).'],
    [/missing terminating '"' character|missing terminating ' character/, () => 'Faltou fechar as aspas do texto.'],
    [/using the result of an assignment as a condition/, () => 'Dentro do if/while você usou = (atribuição). Para comparar, use ==.'],
    [/variable '(\w+)' is uninitialized when used/, (m) => `A variável '${m[1]}' é usada antes de receber um valor.`],
    [/non-void function does not return a value/, () => 'A função deveria devolver um valor com return.'],
    [/'main' must return 'int'/, () => 'O main deve ser declarado como int main(void) e terminar com return 0;'],
    [/redefinition of '(\w+)'/, (m) => `'${m[1]}' foi declarado duas vezes.`],
    [/expected expression/, () => 'O código está incompleto aqui (por exemplo, faltou o valor depois do = ou um operador sobrando).'],
    [/unknown type name '(\w+)'/, (m) => m[1] === 'bool' ? 'Para usar bool, inclua #include <stdbool.h>.' : `O tipo '${m[1]}' não existe: confira a grafia (int, float, double, char...).`],
    [/file not found/, () => 'Esse arquivo do #include não existe: confira o nome (ex.: <stdio.h>).'],
  ];

  // devolve { itens: [{arquivo, linha, coluna, nivel, mensagem, dica}], erros, avisos }
  function analisar(saida) {
    const itens = [];
    for (const l of saida.split('\n')) {
      const m = RE.exec(l);
      if (!m) continue;
      const [, arquivo, linha, coluna, nivelBruto, mensagem] = m;
      if (arquivo.startsWith('__dev_')) continue;
      const nivel = nivelBruto === 'warning' ? 'aviso' : nivelBruto === 'note' ? 'nota' : 'erro';
      let dica = null;
      for (const [re, f] of DICAS) {
        const d = re.exec(mensagem);
        if (d) { dica = f(d); break; }
      }
      itens.push({ arquivo, linha: Number(linha), coluna: Number(coluna), nivel, mensagem, dica });
    }
    return { itens, erros: itens.filter((i) => i.nivel === 'erro').length, avisos: itens.filter((i) => i.nivel === 'aviso').length };
  }

  // marcadores do Monaco (sublinhado) para um arquivo
  function marcadores(itens, arquivo) {
    return itens
      .filter((i) => i.arquivo === arquivo && i.nivel !== 'nota')
      .map((i) => ({
        startLineNumber: i.linha,
        startColumn: i.coluna,
        endLineNumber: i.linha,
        endColumn: i.coluna + 1,
        message: i.dica ? `${i.mensagem}\n💡 ${i.dica}` : i.mensagem,
        severity: i.nivel === 'erro' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      }));
  }

  return { analisar, marcadores };
})();
