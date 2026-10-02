// Servidor do MaisBela — envia mensagens e escuta CONFIRMAR/CANCELAR.
const fs = require('fs');
const express = require('express');
const qrcode = require('qrcode');
const P = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

const CHAVE_SECRETA = process.env.CHAVE_SECRETA || 'troque-esta-chave-1234';
const PASTA_SESSAO = 'auth_info';
const TTL_RESPOSTA_MS = 1000 * 60 * 60 * 12;
const MAX_RESPOSTAS = 500;

let socketWhatsApp = null;
let ultimoQrCodeBase64 = null;
let statusConexao = 'iniciando';
let ultimoMotivoDesconexao = '';
let conectando = false;
let respostasPendentes = [];

let badMacSeguidos = 0;
let limpandoSessao = false;
let timerZerarBadMac = null;

function contarBadMac() {
  badMacSeguidos++;
  clearTimeout(timerZerarBadMac);
  timerZerarBadMac = setTimeout(() => { badMacSeguidos = 0; }, 60 * 1000);

  if (badMacSeguidos >= 20) {
    tratarBadMac();
  }
}

async function tratarBadMac() {
  if (limpandoSessao) return;
  limpandoSessao = true;
  badMacSeguidos = 0;
  console.log('⚠️ Sessão corrompida (Bad MAC repetido). Limpando e gerando QR novo...');

  try { fs.rmSync(PASTA_SESSAO, { recursive: true, force: true }); } catch (_) {}
  statusConexao = 'iniciando';
  ultimoQrCodeBase64 = null;

  try { socketWhatsApp?.ws?.close(); } catch (_) {}
  try { socketWhatsApp?.end?.(new Error('bad-mac-recovery')); } catch (_) {}

  conectando = false;
  setTimeout(() => { limpandoSessao = false; iniciarConexaoWhatsApp(); }, 2000);
}

/** Verifica se o texto recebido é um erro de sessão (Bad MAC, no matching sessions). */
function ehErroDeSessao(...partes) {
  const texto = partes.map((p) => {
    if (p == null) return '';
    if (typeof p === 'string') return p;
    if (typeof p === 'object') {
      return String(p.message || '') + ' ' + String(p.err?.message || '') + ' ' + String(p.stack || '');
    }
    return String(p);
  }).join(' ');
  return texto.includes('Bad MAC') || texto.includes('No matching sessions');
}

// Intercepta o console.error diretamente, porque o Baileys usa essa via
// para logar os Bad MAC em alguns casos (não passa pelo logger pino).
const consoleErrorOriginal = console.error.bind(console);
console.error = (...args) => {
  if (ehErroDeSessao(...args)) {
    contarBadMac();
  }
  consoleErrorOriginal(...args);
};

function criarLoggerComContadorBadMac() {
  const loggerBase = P({ level: 'error' });
  return {
    level: 'error',
    fatal: (...args) => {
      if (ehErroDeSessao(...args)) contarBadMac();
      loggerBase.fatal(...args);
    },
    error: (...args) => {
      if (ehErroDeSessao(...args)) contarBadMac();
      loggerBase.error(...args);
    },
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    child: () => criarLoggerComContadorBadMac()
  };
}

function normalizarTexto(texto) {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

function detectarAcao(textoOriginal) {
  const t = normalizarTexto(textoOriginal);
  const primeira = (t.match(/[A-Z]+/) || [''])[0];
  const negativos = ['NAO', 'NUNCA', 'JAMAIS', 'DEPOIS', 'AMANHA', 'TALVEZ'];

  if (primeira.startsWith('CONFIRMAR') || primeira === 'CONFIRMO' || primeira === 'SIM') {
    const idx = t.indexOf(primeira);
    const antes = t.slice(Math.max(0, idx - 10), idx);
    if (negativos.some((n) => antes.includes(n))) return null;
    return 'confirmar';
  }
  if (primeira.startsWith('CANCELAR') || primeira === 'CANCELO' || primeira === 'NAO') {
    if (primeira === 'NAO' && !t.startsWith('NAO')) return null;
    return 'cancelar';
  }
  return null;
}

function limparRespostasAntigas() {
  const agora = Date.now();
  respostasPendentes = respostasPendentes
    .filter((r) => agora - r.timestamp < TTL_RESPOSTA_MS)
    .slice(-MAX_RESPOSTAS);
}

async function iniciarConexaoWhatsApp() {
  if (conectando) {
    console.log('Já existe uma conexão em andamento — ignorando chamada duplicada.');
    return;
  }
  conectando = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);
    const { version } = await fetchLatestBaileysVersion();
    console.log('Usando versão do WhatsApp Web:', version);

    socketWhatsApp = makeWASocket({
      version,
      auth: state,
      logger: criarLoggerComContadorBadMac(),
      printQRInTerminal: false,
      browser: ['MaisBela', 'Chrome', '1.0.0'],
      getMessage: async () => undefined,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false
    });

    socketWhatsApp.ev.on('creds.update', saveCreds);

    socketWhatsApp.ev.on('messages.upsert', ({ messages, type }) => {
      badMacSeguidos = 0;

      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;
        const jid = msg.key.remoteJid || '';
        if (jid.endsWith('@g.us')) continue;
        if (jid === 'status@broadcast') continue;
        if (jid.endsWith('@broadcast')) continue;

        const textoRecebido =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.buttonsResponseMessage?.selectedButtonId ||
          msg.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
          '';

        if (!textoRecebido) continue;

        const acao = detectarAcao(textoRecebido);
        if (!acao) continue;

        const telefone = jid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
        if (!telefone) continue;

        console.log(`Resposta de ${telefone}: ${acao.toUpperCase()}`);
        respostasPendentes.push({ telefone, acao, timestamp: Date.now() });
        limparRespostasAntigas();
      }
    });

    socketWhatsApp.ev.on('connection.update', async (atualizacao) => {
      const { connection, lastDisconnect, qr } = atualizacao;

      if (qr) {
        ultimoQrCodeBase64 = await qrcode.toDataURL(qr);
        statusConexao = 'aguardando_qr';
        console.log('Novo QR gerado — acesse /qr (expira em ~60s).');
      }

      if (connection === 'open') {
        statusConexao = 'conectado';
        ultimoQrCodeBase64 = null;
        conectando = false;
        badMacSeguidos = 0;
        console.log('✅ Conectado ao WhatsApp!');
      }

      if (connection === 'close') {
        statusConexao = 'desconectado';
        const motivo = lastDisconnect?.error?.output?.statusCode;
        ultimoMotivoDesconexao = String(motivo || 'desconhecido');
        const foiLogout = motivo === DisconnectReason.loggedOut;
        console.log('Conexão fechada. Motivo:', motivo, '| Logout:', foiLogout);

        conectando = false;

        if (foiLogout) {
          console.log('Logout detectado — limpando sessão e gerando novo QR...');
          try { fs.rmSync(PASTA_SESSAO, { recursive: true, force: true }); } catch (_) {}
          statusConexao = 'iniciando';
          ultimoQrCodeBase64 = null;
          setTimeout(iniciarConexaoWhatsApp, 1000);
        } else {
          setTimeout(iniciarConexaoWhatsApp, 3000);
        }
      }
    });
  } catch (e) {
    conectando = false;
    console.error('Erro ao iniciar conexão:', e);
  }
}

iniciarConexaoWhatsApp();

// ---------- Rotas públicas ----------

app.get('/qr', (req, res) => {
  if (statusConexao === 'conectado') return res.send('<h2>✅ Já está conectado ao WhatsApp!</h2>');
  if (!ultimoQrCodeBase64) {
    return res.send(`<html><head><meta http-equiv="refresh" content="5"></head>
      <body style="text-align:center;font-family:sans-serif;">
      <h2>Gerando QR code... atualiza em 5s.</h2></body></html>`);
  }
  res.send(`<html><head><meta http-equiv="refresh" content="15"></head>
    <body style="text-align:center;font-family:sans-serif;">
    <h2>Escaneie com o WhatsApp do salão</h2>
    <p>WhatsApp > Aparelhos conectados > Conectar um aparelho</p>
    <img src="${ultimoQrCodeBase64}" style="width:300px;" />
    <p style="color:#888;">Atualiza sozinho a cada 15s.</p></body></html>`);
});

app.get('/status', (req, res) => {
  res.json({ status: statusConexao, ultimoMotivoDesconexao, badMacSeguidos });
});

// ---------- Rotas autenticadas ----------

function autenticar(req, res) {
  const chaveHeader = req.headers['x-chave-secreta'];
  const chaveQuery = req.query.chave;
  const chaveRecebida = chaveHeader || chaveQuery;
  if (chaveRecebida !== CHAVE_SECRETA) {
    res.status(401).json({ sucesso: false, erro: 'Chave secreta inválida' });
    return false;
  }
  return true;
}

app.get('/reconectar', async (req, res) => {
  if (!autenticar(req, res)) return;
  try { fs.rmSync(PASTA_SESSAO, { recursive: true, force: true }); } catch (_) {}
  statusConexao = 'iniciando';
  ultimoQrCodeBase64 = null;
  conectando = false;
  badMacSeguidos = 0;
  await iniciarConexaoWhatsApp();
  res.send('<h2>Reiniciando conexão... acesse /qr em alguns segundos.</h2>');
});

app.post('/enviar', async (req, res) => {
  if (!autenticar(req, res)) return;
  if (statusConexao !== 'conectado') {
    return res.status(503).json({ sucesso: false, erro: 'WhatsApp não conectado' });
  }
  const { telefone, mensagem } = req.body;
  if (!telefone || !mensagem) {
    return res.status(400).json({ sucesso: false, erro: 'Envie telefone e mensagem' });
  }
  try {
    const numero = telefone.replace(/\D/g, '') + '@s.whatsapp.net';
    await socketWhatsApp.sendMessage(numero, { text: mensagem });
    res.json({ sucesso: true });
  } catch (e) {
    console.error('Erro ao enviar:', e);
    res.status(500).json({ sucesso: false, erro: 'Falha ao enviar mensagem' });
  }
});

app.get('/respostas', (req, res) => {
  if (!autenticar(req, res)) return;
  limparRespostasAntigas();
  const paraEnviar = respostasPendentes;
  respostasPendentes = [];
  res.json({ respostas: paraEnviar });
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`Servidor MaisBela na porta ${PORTA}`));
