/*
 * Sala: conexão entre professor e alunos (PeerJS / WebRTC), no mesmo modelo do jogo CS Caps:
 * o professor abre a sala com um código e cada aluno liga direto nele (estrela). Na mesma rede da sala
 * as conexões são diretas, sem passar pela internet; o servidor do PeerJS só apresenta um ao outro.
 *
 * Os dois lados religam sozinhos: o aluno tenta de novo a cada poucos segundos se o professor cair
 * (ou ainda não tiver aberto a sala), e o professor religa no servidor se a aba for para o fundo.
 */
const Sala = (() => {
  const PREFIXO = 'devaula-';
  const RELIGAR_MS = 3000;
  const ESPERA_CONEXAO_MS = 10000;
  const BATIDA_MS = 5000;
  const SILENCIO_MAX_MS = 20000;

  function normalizarCodigo(texto) {
    return (texto || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  }

  function codigoAleatorio() {
    const alfabeto = 'abcdefghjkmnpqrstuvwxyz23456789';
    let c = '';
    for (let i = 0; i < 5; i++) c += alfabeto[Math.floor(Math.random() * alfabeto.length)];
    return c;
  }

  // religa no servidor do PeerJS quando a conexão com ele cai (aba no fundo, Wi-Fi oscilou):
  // sem isso ninguém novo consegue chegar, embora as conexões abertas continuem
  function manterNoServidor(peer) {
    const religar = () => {
      if (peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch { /* ignora */ } }
    };
    peer.on('disconnected', () => setTimeout(religar, RELIGAR_MS));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) religar(); });
    window.addEventListener('online', religar);
  }

  // ---------------- Professor ----------------

  class Professor {
    // ev: aoAbrir(codigo), aoErro(tipo), aoAlunoEntrou(aluno), aoAlunoSaiu(aluno), aoMensagem(aluno, m)
    constructor(codigo, nome, ev) {
      this.codigo = codigo;
      this.nome = nome;
      this.ev = ev;
      this.alunos = new Map(); // peerId -> { id, nome, conn, visto }
      this.tentativasId = 0;
      this.peer = null;
      this.abrir();
      this.vigia = setInterval(() => this.conferirSilencio(), BATIDA_MS);
    }

    abrir() {
      const peer = new Peer(PREFIXO + this.codigo, { debug: 0 });
      this.peer = peer;
      let abriu = false;
      peer.on('open', () => {
        abriu = true;
        this.tentativasId = 0;
        this.ev.aoAbrir(this.codigo);
      });
      peer.on('connection', (conn) => this.novaConexao(conn));
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id' && !abriu) {
          // quase sempre é o registro antigo desta mesma sala (o professor recarregou a página): o servidor
          // demora alguns segundos para esquecer. Insiste um pouco antes de dizer que o código está em uso
          try { peer.destroy(); } catch { /* ignora */ }
          if (++this.tentativasId <= 5) setTimeout(() => this.abrir(), RELIGAR_MS);
          else this.ev.aoErro('codigo-em-uso');
          return;
        }
        if (err.type === 'peer-unavailable') return; // um aluno que acabou de sair
        this.ev.aoErro(err.type);
      });
      manterNoServidor(peer);
    }

    novaConexao(conn) {
      const aluno = { id: conn.peer, nome: 'Aluno', conn, visto: Date.now(), pronto: false };
      conn.on('data', (m) => {
        aluno.visto = Date.now();
        if (!m || typeof m !== 'object') return;
        if (m.t === 'ola') {
          aluno.nome = String(m.nome || 'Aluno').slice(0, 30);
          const antigo = this.alunos.get(aluno.id);
          if (antigo && antigo.conn !== conn) { try { antigo.conn.close(); } catch { /* ignora */ } }
          this.alunos.set(aluno.id, aluno);
          aluno.pronto = true;
          this.ev.aoAlunoEntrou(aluno);
          return;
        }
        if (m.t === 'ping' || !aluno.pronto) return;
        this.ev.aoMensagem(aluno, m);
      });
      conn.on('close', () => this.removerAluno(aluno));
      conn.on('error', () => this.removerAluno(aluno));
    }

    removerAluno(aluno) {
      if (this.alunos.get(aluno.id) !== aluno) return;
      this.alunos.delete(aluno.id);
      this.ev.aoAlunoSaiu(aluno);
    }

    // aluno que sumiu sem a conexão avisar (notebook fechado, Wi-Fi caiu)
    conferirSilencio() {
      const agora = Date.now();
      for (const a of [...this.alunos.values()]) {
        if (agora - a.visto > SILENCIO_MAX_MS) {
          try { a.conn.close(); } catch { /* ignora */ }
          this.removerAluno(a);
        }
      }
    }

    enviar(id, m) {
      const a = this.alunos.get(id);
      if (a && a.conn.open) { try { a.conn.send(m); } catch { /* ignora */ } }
    }

    transmitir(m) {
      for (const a of this.alunos.values()) {
        if (a.conn.open) { try { a.conn.send(m); } catch { /* ignora */ } }
      }
    }

    fechar() {
      clearInterval(this.vigia);
      for (const a of this.alunos.values()) { try { a.conn.close(); } catch { /* ignora */ } }
      this.alunos.clear();
      try { this.peer.destroy(); } catch { /* ignora */ }
    }
  }

  // ---------------- Aluno ----------------

  class Aluno {
    // ev: aoConectar(), aoDesconectar(), aoMensagem(m), aoEstado(texto), aoChamada(call)
    constructor(codigo, nome, ev) {
      this.codigo = codigo;
      this.nome = nome;
      this.ev = ev;
      this.conn = null;
      this.conectado = false;
      this.fechado = false;
      this.timer = null;
      this.peer = new Peer({ debug: 0 });
      this.peer.on('open', () => { if (!this.conn) this.conectar(); });
      this.peer.on('call', (call) => this.ev.aoChamada(call));
      this.peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
          this.ev.aoEstado('Aguardando o professor abrir a sala...');
          this.agendar();
        } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') {
          this.ev.aoEstado('Sem conexão com o servidor, tentando de novo...');
        }
      });
      manterNoServidor(this.peer);
      this.batida = setInterval(() => this.enviar({ t: 'ping' }), BATIDA_MS);
    }

    get peerId() { return this.peer.id; }

    agendar() {
      if (this.fechado) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.conectar(), RELIGAR_MS);
    }

    conectar() {
      if (this.fechado || this.peer.destroyed) return;
      if (this.peer.disconnected) { this.agendar(); return; }
      clearTimeout(this.timer);
      if (this.conn) { const velha = this.conn; this.conn = null; try { velha.close(); } catch { /* ignora */ } }
      this.ev.aoEstado('Conectando...');
      const conn = this.peer.connect(PREFIXO + this.codigo, { reliable: true });
      this.conn = conn;
      const espera = setTimeout(() => {
        if (conn.open || this.conn !== conn) return;
        this.conn = null;
        try { conn.close(); } catch { /* ignora */ }
        this.ev.aoEstado('O professor não respondeu, tentando de novo...');
        this.agendar();
      }, ESPERA_CONEXAO_MS);
      conn.on('open', () => {
        clearTimeout(espera);
        conn.send({ t: 'ola', nome: this.nome });
        this.conectado = true;
        this.ev.aoConectar();
      });
      conn.on('data', (m) => { if (this.conn === conn && m && typeof m === 'object') this.ev.aoMensagem(m); });
      const perdeu = () => {
        clearTimeout(espera);
        if (this.conn !== conn) return;
        this.conn = null;
        if (this.conectado) { this.conectado = false; this.ev.aoDesconectar(); }
        this.agendar();
      };
      conn.on('close', perdeu);
      conn.on('error', perdeu);
    }

    enviar(m) {
      if (this.conn && this.conn.open) { try { this.conn.send(m); } catch { /* ignora */ } }
    }

    fechar() {
      this.fechado = true;
      clearTimeout(this.timer);
      clearInterval(this.batida);
      try { if (this.conn) this.conn.close(); } catch { /* ignora */ }
      try { this.peer.destroy(); } catch { /* ignora */ }
    }
  }

  return { Professor, Aluno, normalizarCodigo, codigoAleatorio };
})();
