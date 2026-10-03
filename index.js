// Servidor do MaisBela: mantém uma conexão com o WhatsApp, envia mensagens
// automaticamente, e "escuta" as respostas das clientes para confirmar ou
// cancelar agendamentos sozinho.

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

let socketWhatsApp = null;
let ultimoQrCodeBase64 = null;
let statusConexao = 'iniciando'; // iniciando | aguardando_qr | conectado | desconectado | substituido
let ultimoMotivoDesconexao = '';
let tentandoReconectar = false;

let respostasPendentes = [];

function normalizarTexto(texto) {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

async function iniciarConexaoWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);

  const { version } = await fetchLatestBaileysVersion();
  console.log('Usando versão do WhatsApp Web:', version);

  socketWhatsApp = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['MaisBela', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false
  });

  socketWhatsApp.ev.on('creds.update', saveCreds);

  socketWhatsApp.ev.on('messages.upsert', (evento) => {
    for (const msg of evento.messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;

      const textoRecebido =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!textoRecebido) continue;

      const textoNormalizado = normalizarTexto(textoRecebido);
      const telefone = msg.key.remoteJid.replace('@s.whatsapp.net', '');

      let acao = null;
      if (textoNormalizado.includes('CONFIRMAR')) acao = 'confirmar';
      else if (textoNormalizado.includes('CANCELAR')) acao = 'cancelar';

      if (acao) {
        console.log(`💬 Resposta recebida de ${telefone}: ${acao.toUpperCase()}`);
        respostasPendentes.push({ telefone, acao, timestamp: Date.now() });
      }
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
      tentandoReconectar = false;
      console.log('✅ Conectado ao WhatsApp com sucesso!');
    }

    if (connection === 'close') {
      const motivo = lastDisconnect?.error?.output?.statusCode;
      ultimoMotivoDesconexao = String(motivo || 'desconhecido');
      console.log('🔴 Conexão encerrada. Código:', motivo);

      if (motivo === DisconnectReason.loggedOut) {
        console.log('Logout detectado — limpando sessão antiga e gerando novo QR code...');
        try {
          fs.rmSync(PASTA_SESSAO, { recursive: true, force: true });
        } catch (e) {
          console.error('Erro ao limpar pasta de sessão:', e);
        }
        statusConexao = 'iniciando';
        ultimoQrCodeBase64 = null;
        iniciarConexaoWhatsApp();
        return;
      }

      if (motivo === DisconnectReason.connectionReplaced) {
        // Outro aparelho/sessão assumiu essa mesma conexão — reconectar
        // na hora só pioraria (loop infinito). Para aqui e espera uma
        // ação manual: limpar os aparelhos vinculados no WhatsApp e
        // acessar /reconectar.
        console.log('⚠️ Conexão substituída por outro aparelho. Parando de tentar automaticamente.');
        console.log('👉 Remova TODOS os aparelhos em WhatsApp > Aparelhos conectados, depois acesse /reconectar');
        statusConexao = 'substituido';
        return;
      }

      // Qualquer outro motivo: espera 5 segundos antes de tentar de novo,
      // para nunca entrar num loop de reconexão instantânea.
      if (tentandoReconectar) return;
      tentandoReconectar = true;
      statusConexao = 'desconectado';
      setTimeout(() => {
        tentandoReconectar = false;
        iniciarConexaoWhatsApp();
      }, 5000);
    }
  });
}

iniciarConexaoWhatsApp();

app.get('/qr', (req, res) => {
  if (statusConexao === 'conectado') {
    return res.send('<h2>✅ Já está conectado ao WhatsApp!</h2>');
  }
  if (statusConexao === 'substituido') {
    return res.send(`
      <h2>⚠️ Conexão foi substituída por outro aparelho.</h2>
      <p>1. Abra o WhatsApp do salão → Configurações → Aparelhos conectados</p>
      <p>2. Remova TODOS os aparelhos listados</p>
      <p>3. Acesse <a href="/reconectar">/reconectar</a></p>
    `);
  }
  if (!ultimoQrCodeBase64) {
    return res.send(`
      <html>
        <head><meta http-equiv="refresh" content="5"></head>
        <body style="text-align:center; font-family: sans-serif;">
          <h2>Gerando QR code... esta página atualiza sozinha em 5 segundos.</h2>
        </body>
      </html>
    `);
  }
  res.send(`
    <html>
      <head><meta http-equiv="refresh" content="15"></head>
      <body style="text-align:center; font-family: sans-serif;">
        <h2>Escaneie este código com o WhatsApp do salão</h2>
        <p>WhatsApp > Aparelhos conectados > Conectar um aparelho</p>
        <img src="${ultimoQrCodeBase64}" style="width:300px;" />
        <p style="color:#888;">Esta página atualiza sozinha a cada 15 segundos com um QR novo, se precisar.</p>
      </body>
    </html>
  `);
});

app.get('/reconectar', async (req, res) => {
  try {
    fs.rmSync(PASTA_SESSAO, { recursive: true, force: true });
  } catch (e) {}
  statusConexao = 'iniciando';
  ultimoQrCodeBase64 = null;
  tentandoReconectar = false;
  await iniciarConexaoWhatsApp();
  res.send('<h2>🗑️ Pasta auth_info removida com sucesso.<br>Reiniciando conexão... acesse /qr em alguns segundos.</h2>');
});

app.post('/enviar', async (req, res) => {
  const chaveRecebida = req.headers['x-chave-secreta'];
  if (chaveRecebida !== CHAVE_SECRETA) {
    return res.status(401).json({ sucesso: false, erro: 'Chave secreta inválida' });
  }

  if (statusConexao !== 'conectado') {
    return res.status(503).json({ sucesso: false, erro: 'WhatsApp não está conectado no momento' });
  }

  const { telefone, mensagem } = req.body;
  if (!telefone || !mensagem) {
    return res.status(400).json({ sucesso: false, erro: 'Envie telefone e mensagem' });
  }

  try {
    const numeroFormatado = telefone.replace(/\D/g, '') + '@s.whatsapp.net';
    await socketWhatsApp.sendMessage(numeroFormatado, { text: mensagem });
    res.json({ sucesso: true });
  } catch (erro) {
    console.error('Erro ao enviar mensagem:', erro);
    res.status(500).json({ sucesso: false, erro: 'Falha ao enviar mensagem' });
  }
});

app.get('/respostas', (req, res) => {
  const chaveRecebida = req.headers['x-chave-secreta'];
  if (chaveRecebida !== CHAVE_SECRETA) {
    return res.status(401).json({ sucesso: false, erro: 'Chave secreta inválida' });
  }

  const respostasParaEnviar = respostasPendentes;
  respostasPendentes = [];
  res.json({ respostas: respostasParaEnviar });
});

app.get('/status', (req, res) => {
  res.json({ status: statusConexao, ultimoMotivoDesconexao });
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`Servidor do MaisBela rodando na porta ${PORTA}`);
});
