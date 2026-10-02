// Servidor do MaisBela — envia mensagens e escuta CONFIRMAR/CANCELAR.
const fs = require('fs');
const path = require('path');
const express = require('express');
const qrcode = require('qrcode');
const P = require('pino');

// Ignorar exceções globais para evitar que o Node encerre o processo
process.on('uncaughtException', (err) => {
  if (err.message && err.message.includes('Bad MAC')) return;
  console.error('⚠️ Exceção capturada:', err.message || err);
});

process.on('unhandledRejection', (reason) => {
  if (reason && reason.toString().includes('Bad MAC')) return;
  console.error('⚠️ Rejeição capturada:', reason);
});

// Importação flexível do Baileys
const Baileys = require('@whiskeysockets/baileys');
const makeWASocket = Baileys.default || Baileys;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = Baileys;

const app = express();
app.use(express.json());

const CHAVE_SECRETA = process.env.CHAVE_SECRETA || 'troque-esta-chave-1234';
const PASTA_SESSAO = path.join(__dirname, 'auth_info');
const TTL_RESPOSTA_MS = 1000 * 60 * 60 * 12;
const MAX_RESPOSTAS = 500;

let socketWhatsApp = null;
let ultimoQrCodeBase64 = null;
let statusConexao = 'iniciando';
let ultimoMotivoDesconexao = '';
let conectando = false;
let respostasPendentes = [];

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

function apagarSessaoLocal() {
  try {
    if (fs.existsSync(PASTA_SESSAO)) {
      fs.rmSync(PASTA_SESSAO, { recursive: true, force: true });
      console.log('🗑️ Pasta auth_info removida com sucesso.');
    }
  } catch (err) {
    console.error('Erro ao remover pasta de sessão:', err);
  }
}

async function iniciarConexaoWhatsApp() {
  if (conectando) return;
  conectando = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);
    
    let version;
    try {
      const v = await fetchLatestBaileysVersion();
      version = v.version;
    } catch (_) {}

    socketWhatsApp = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['MaisBela', 'Chrome', '1.0.0'],
      getMessage: async () => ({ conversation: '' })
    });

    socketWhatsApp.ev.on('creds.update', saveCreds);

    socketWhatsApp.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid || '';
        if (jid.endsWith('@g.us') || jid.includes('broadcast')) continue;

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

        console.log(`💬 Resposta recebida de ${telefone}: ${acao.toUpperCase()}`);
        respostasPendentes.push({ telefone, acao, timestamp: Date.now() });
        limparRespostasAntigas();
      }
    });

    socketWhatsApp.ev.on('connection.update', async (atualizacao) => {
      const { connection, lastDisconnect, qr } = atualizacao;

      if (qr) {
        ultimoQrCodeBase64 = await qrcode.toDataURL(qr);
        statusConexao = 'aguardando_qr';
        console.log('📱 Novo QR Code disponível em /qr');
      }

      if (connection === 'open') {
        statusConexao = 'conectado';
        ultimoQrCodeBase64 = null;
        conectando = false;
        console.log('✅ Conectado ao WhatsApp com sucesso!');
      }

      if (connection === 'close') {
        statusConexao = 'desconectado';
        conectando = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const foiLogout = statusCode === DisconnectReason.loggedOut;

        console.log('🔴 Conexão encerrada. Código:', statusCode);

        if (foiLogout || statusCode === 401) {
          console.log('Sessão expirada/inválida. Limpando credenciais...');
          apagarSessaoLocal();
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
    console.error('Erro ao iniciar WhatsApp:', e);
  }
}

iniciarConexaoWhatsApp().catch((err) => console.error(err));

// ---------- Rotas ----------

app.get('/', (req, res) => {
  res.send('Servidor MaisBela a funcionar normalmente.');
});

app.get('/qr', (req, res) => {
  if (statusConexao === 'conectado') return res.send('<h2>✅ O WhatsApp já está conectado!</h2>');
  if (!ultimoQrCodeBase64) {
    return res.send(`<html><head><meta http-equiv="refresh" content="5"></head>
      <body style="text-align:center;font-family:sans-serif;padding-top:50px;">
      <h2>A gerar QR Code... A página atualiza em 5 segundos.</h2></body></html>`);
  }
  res.send(`<html><head><meta http-equiv="refresh" content="15"></head>
    <body style="text-align:center;font-family:sans-serif;padding-top:30px;">
    <h2>Escaneie com o WhatsApp do Salão</h2>
    <p>WhatsApp > Aparelhos conectados > Conectar um aparelho</p>
    <img src="${ultimoQrCodeBase64}" style="width:280px;" />
    <p style="color:#666;">Atualiza automaticamente a cada 15s.</p></body></html>`);
});

app.get('/status', (req, res) => {
  res.json({ status: statusConexao, ultimoMotivoDesconexao });
});

function autenticar(req, res) {
  const chaveHeader = req.headers['x-chave-secreta'];
  const chaveQuery = req.query.chave;
  if ((chaveHeader || chaveQuery) !== CHAVE_SECRETA) {
    res.status(401).json({ sucesso: false, erro: 'Chave secreta inválida' });
    return false;
  }
  return true;
}

app.get('/reconectar', async (req, res) => {
  if (!autenticar(req, res)) return;
  apagarSessaoLocal();
  statusConexao = 'iniciando';
  ultimoQrCodeBase64 = null;
  conectando = false;
  if (socketWhatsApp) try { socketWhatsApp.end(); } catch (_) {}
  iniciarConexaoWhatsApp().catch((err) => console.error(err));
  res.send('<h2>A reiniciar sessão... Aceda a /qr em alguns segundos.</h2>');
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
    console.error('Erro ao enviar mensagem:', e);
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
app.listen(PORTA, '0.0.0.0', () => {
  console.log(`Servidor MaisBela a rodar na porta ${PORTA}`);
});
