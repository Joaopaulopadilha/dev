/*
 * Tela: o professor compartilha a tela com a turma.
 *
 * Com WebRTC, o navegador codifica o vídeo de novo para cada pessoa que recebe: o computador do professor
 * aguenta poucas cópias. Por isso a transmissão é uma árvore: o professor envia direto para até
 * VAGAS_PROFESSOR alunos e cada aluno repassa o vídeo que recebe para até VAGAS_ALUNO colegas
 * (5 + 15 + 45 ... cobre uma turma de 40 com dois níveis). Quem decide quem repassa para quem é o
 * professor; se um aluno sai, os que dependiam dele são religados a outro.
 */
const Tela = (() => {
  const VAGAS_PROFESSOR = 5;
  const VAGAS_ALUNO = 3;

  // ---------------- lado do professor ----------------

  class TransmissaoProfessor {
    // sala: Sala.Professor; aoParar(): chamado quando o compartilhamento termina (inclusive pelo navegador)
    constructor(sala, aoParar) {
      this.sala = sala;
      this.aoParar = aoParar;
      this.stream = null;
      this.chamadas = new Map(); // alunoId -> MediaConnection (só os que recebem direto do professor)
      this.pai = new Map();      // alunoId -> 'professor' | alunoId
      this.filhos = new Map();   // nó ('professor' ou alunoId) -> Set de alunoId
      this.vagasProfessor = VAGAS_PROFESSOR;
      this.vagasAluno = VAGAS_ALUNO;
    }

    get ativa() { return !!this.stream; }

    async iniciar() {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 12, max: 15 }, width: { max: 1920 }, height: { max: 1080 } },
        audio: false,
      });
      const trilha = stream.getVideoTracks()[0];
      if (trilha) {
        trilha.contentHint = 'text'; // prioriza nitidez do texto (código) em vez de movimento suave
        trilha.addEventListener('ended', () => this.parar());
      }
      this.stream = stream;
      this.filhos = new Map([['professor', new Set()]]);
      this.pai.clear();
      this.sala.transmitir({ t: 'tela-inicio' });
      for (const id of this.sala.alunos.keys()) this.atribuir(id);
    }

    // escolhe quem envia o vídeo para este aluno: o nó mais perto do professor que ainda tem vaga
    atribuir(alunoId) {
      if (!this.stream || this.pai.has(alunoId)) return;
      const fila = ['professor'];
      while (fila.length) {
        const no = fila.shift();
        const filhos = this.filhos.get(no) || new Set();
        const vagas = no === 'professor' ? this.vagasProfessor : this.vagasAluno;
        if (filhos.size < vagas && no !== alunoId) {
          filhos.add(alunoId);
          this.filhos.set(no, filhos);
          this.pai.set(alunoId, no);
          if (!this.filhos.has(alunoId)) this.filhos.set(alunoId, new Set());
          if (no === 'professor') this.ligarDireto(alunoId);
          else this.sala.enviar(no, { t: 'tela-repassar', alvo: alunoId });
          return;
        }
        fila.push(...filhos);
      }
    }

    ligarDireto(alunoId) {
      const call = this.sala.peer.call(alunoId, this.stream, { metadata: { tipo: 'tela' } });
      if (!call) return;
      this.chamadas.set(alunoId, call);
      call.on('close', () => { if (this.chamadas.get(alunoId) === call) this.chamadas.delete(alunoId); });
    }

    alunoEntrou(alunoId) {
      if (!this.stream) return;
      this.sala.enviar(alunoId, { t: 'tela-inicio' });
      this.atribuir(alunoId);
    }

    // aluno saiu: tira da árvore e religa quem recebia dele (os netos continuam presos aos filhos)
    alunoSaiu(alunoId) {
      if (!this.stream) return;
      const pai = this.pai.get(alunoId);
      if (pai) this.filhos.get(pai)?.delete(alunoId);
      this.pai.delete(alunoId);
      const call = this.chamadas.get(alunoId);
      if (call) { try { call.close(); } catch { /* ignora */ } this.chamadas.delete(alunoId); }
      const orfaos = [...(this.filhos.get(alunoId) || [])];
      this.filhos.delete(alunoId);
      for (const f of orfaos) { this.pai.delete(f); this.atribuir(f); }
    }

    parar() {
      if (!this.stream) return;
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
      for (const c of this.chamadas.values()) { try { c.close(); } catch { /* ignora */ } }
      this.chamadas.clear();
      this.pai.clear();
      this.filhos.clear();
      this.sala.transmitir({ t: 'tela-fim' });
      this.aoParar();
    }
  }

  // ---------------- lado do aluno ----------------

  class RecepcaoAluno {
    // sala: Sala.Aluno; aoVideo(stream|null)
    constructor(sala, aoVideo) {
      this.sala = sala;
      this.aoVideo = aoVideo;
      this.entrada = null;     // MediaConnection de quem me envia
      this.stream = null;
      this.repasses = new Map(); // alvo -> MediaConnection (eu repasso para ele)
      this.pendentes = new Set(); // alvos esperando eu receber o vídeo
    }

    // chamada recebida (sempre de quem o professor escolheu para me enviar)
    receberChamada(call) {
      if (!call.metadata || call.metadata.tipo !== 'tela') return;
      if (this.entrada && this.entrada !== call) { try { this.entrada.close(); } catch { /* ignora */ } }
      this.entrada = call;
      call.on('stream', (stream) => {
        if (this.entrada !== call) return;
        this.stream = stream;
        this.aoVideo(stream);
        const trilha = stream.getVideoTracks()[0];
        // quem eu já repassava passa a receber a imagem nova (troquei de "pai"), sem religar
        for (const rep of this.repasses.values()) {
          const envio = rep.peerConnection && rep.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (envio && trilha) envio.replaceTrack(trilha).catch(() => {});
        }
        for (const alvo of this.pendentes) this.repassar(alvo);
        this.pendentes.clear();
      });
      call.on('close', () => {
        if (this.entrada !== call) return;
        this.entrada = null;
      });
      call.answer(); // só recebe: o aluno não envia vídeo de volta
    }

    repassar(alvo) {
      if (!this.stream) { this.pendentes.add(alvo); return; }
      const velha = this.repasses.get(alvo);
      if (velha) { try { velha.close(); } catch { /* ignora */ } }
      const call = this.sala.peer.call(alvo, this.stream, { metadata: { tipo: 'tela' } });
      if (!call) return;
      this.repasses.set(alvo, call);
      call.on('close', () => { if (this.repasses.get(alvo) === call) this.repasses.delete(alvo); });
    }

    mensagem(m) {
      if (m.t === 'tela-inicio') this.aoVideo(null, true);
      else if (m.t === 'tela-repassar' && typeof m.alvo === 'string') this.repassar(m.alvo);
      else if (m.t === 'tela-fim') this.encerrar();
    }

    encerrar() {
      if (this.entrada) { try { this.entrada.close(); } catch { /* ignora */ } }
      for (const c of this.repasses.values()) { try { c.close(); } catch { /* ignora */ } }
      this.entrada = null;
      this.stream = null;
      this.repasses.clear();
      this.pendentes.clear();
      this.aoVideo(null, false);
    }
  }

  return { TransmissaoProfessor, RecepcaoAluno };
})();
